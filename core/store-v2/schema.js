// v2 存储层: 建库 · 迁移 · 导入导出 · meta · 关库
// 由 memory-store-v2.js 拆出(内核抽包第 2 步)。方法体逐字搬运, 经 mixin 挂回 MemoryStoreV2.prototype。
const fs = require('fs');
const { todayLocal, nowLocalISO } = require('../memory');
const { SCHEMA_VERSION, SCHEMA_FILE, GRAPH_COLS } = require('./consts');
const { cleanParams } = require('../lone-surrogate');

// 图索引(nodes/edges/pinned)是否可能变了 —— 引擎层 _fresh() 的缓存靠它作废。
// 🔴 安全方向是【默认失效】: 认不出的写语句一律当作图变了, 代价只是多重建一次;
// 反过来漏判一条就是静默读脏缓存, 那种错在结果里看不出来, 也没有测试抓得住。
const WRITE_STMT = /^\s*(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE)\b/i;
const GRAPH_IRRELEVANT = new RegExp(
  '^\\s*(?:INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+'
  + '(?:recall_log|history|utterances|vectors|error_log|chores|meta)\\b', 'i');
// 向量表自己的写入另记一本账(图版本号刻意不数它), 给语义层的向量缓存用。
const VECTOR_WRITE = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+vectors\b/i;

class SchemaMixin {
  get db() {
    if (this._db) return this._db;
    const { Database } = require('node-sqlite3-wasm');
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (_) {}
    this._healWalHeader();
    this._db = this._trackWrites(new Database(this.dbPath));
    // 🔴 必须显式开, 每条连接都要。foreign_keys 是连接级开关且标准 SQLite 默认 OFF ——
    // node-sqlite3-wasm 恰好默认 ON, 但依赖驱动默认 = 换驱动那天外键静默失效, 悬空边重新长。
    // (现行 v1 库 95 条悬空边就是没有约束的产物)
    this._db.run('PRAGMA foreign_keys = ON');
    this._db.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));
    this._addMissingColumns();
    const cur = parseInt(this.getMeta('schema_version') || '0', 10);
    if (cur !== SCHEMA_VERSION) this.setMeta('schema_version', String(SCHEMA_VERSION));
    this._healLoneOnce();   // 写入口挡住之前存进去的半个 emoji, 每个库清一次(store-v2/lone-heal.js)
    return this._db;
  }

  // 写入打点收在这一个口子上, 不散到各 mutator 里: 将来加一个新的写方法时忘了打点,
  // 后果是静默读脏缓存 —— 让人记得调是不现实的, 该让默认行为落在安全那侧(同 upsertNode 的理由)。
  // 先记账后执行: 语句炸了也算脏, 大不了白重建一次。
  _trackWrites(raw) {
    return new Proxy(raw, {
      get: (t, prop) => {
        const v = t[prop];
        if (typeof v !== 'function') return v;
        if (prop !== 'run' && prop !== 'exec') return v.bind(t);
        return (sql, ...rest) => {
          const s = String(sql);
          if (WRITE_STMT.test(s) && !GRAPH_IRRELEVANT.test(s)) this._graphRev = (this._graphRev || 0) + 1;
          if (VECTOR_WRITE.test(s)) this._vecRev = (this._vecRev || 0) + 1;
          // 写进库的文字一律删掉半个 emoji(见 lone-surrogate.js): 同样收在这一个口子上
          if (prop === 'run' && rest.length) rest[0] = cleanParams(rest[0]);
          return v.call(t, sql, ...rest);
        };
      },
    });
  }

  // 图索引的版本号。两截缺一不可:
  //   · _graphRev  —— 本连接自己的写入(上面 Proxy 记的)
  //   · data_version —— SQLite 内建, **别的连接**提交过就会变(自身写入不动它, 已实测)
  // 有了后半截, 缓存就不必假设"全世界只有主进程一个写入方": 手工跑 scripts/mem-v2-*.js
  // 或导入人格另开一条连接, 这里都能发现。一次 PRAGMA 读是微秒级, 相对 22ms 重建可以忽略。
  graphRev() {
    let foreign = 0;
    try { const r = this.db.get('PRAGMA data_version'); foreign = (r && r.data_version) || 0; } catch (_) {}
    return `${this._graphRev || 0}:${foreign}`;
  }

  // 向量快照的版本号: 本连接写过向量 · 图变了(删节点会级联删向量) · 别的连接提交过, 任一变了就作废。
  vectorRev() { return `${this._vecRev || 0}:${this.graphRev()}`; }

  // —— 搬家: 导出/导入记忆本身, 不搬数据库文件 ————————————————————
  // 🔴 作者 2026-08-19 定的口径:「导出人格又不是备份数据库, 是把记忆弄出来写个文件;
  //    导入也是往现有数据库里写东西, 其他人写完他就可以写」。
  // 搬【内容】而不搬【容器】, 一次性消掉整串麻烦:
  //   · 导出是纯 SELECT —— WAL 下读不阻塞写, 人格开着照导, 不需要守卫也不需要一致快照
  //   · 导入是普通 INSERT —— 写锁瞬时排队, 不会再出 database is locked
  //   · 目标库由导入端按【本机当前 schema】新建 —— 迁移这一步根本不存在, 跨版本天然兼容
  // 详见 [[feedback_transfer_content_not_container_logical_export_over_file_copy]]。

  // 哪些表跟着人格走: 只有【它是谁 + 它知道什么】。
  // 不带的三类, 理由各不相同 ——
  //   · utterances: 逐字原话流水 = 隐私。与 .session.json 同性质(那份已因隐私排除), 实测里面有
  //     用户粘过的 token/key。🔴 老的"拷 .db 文件"方案把这张表整个带走了, 等于前门关了后门开着。
  //   · recall_log / error_log / history / chores: 本机的过程记录, 换机器无意义。
  //   · vectors / meta: 可重建或绑本机(embed_model、last_checkup_ts、migrated_from 这些是"它在
  //     这台机器上的处境", 不是"它是谁")。导入端第一次检索自己会重算。
  exportGraph() {
    return {
      nodes: this.db.all(`SELECT id,${GRAPH_COLS} FROM nodes`),
      edges: this.db.all('SELECT src,dst,rel,made_by,weight,created FROM edges'),
      pinned: this.db.all('SELECT node_id,added_at,reason FROM pinned'),
      redlines: this.db.all(`SELECT node_id,trigger_pattern,correct_action,level,violations,last_violated
                             FROM redlines`),
    };
  }

  // 灌进【本机新建的空库】。返回 {nodes, edges, dropped} —— dropped 是被丢掉的悬空边条数。
  //
  // 数字主键不跨机器: 导入端的 id 由本机自增重新发, 所以边不能照抄两个数字。包里的 id 只当
  // 【引用号】用, 这里建 引用号→新id 的映射再落边。指不到的边直接丢 —— 悬空边在 v1 库里
  // 攒了 95 条, 搬家正是把它们挡在门外的时机。
  // 整个过程一个事务: 中途炸掉不留半个人格。
  importGraph(data) {
    const d = data || {};
    const idMap = new Map();
    let dropped = 0;
    this.transaction(() => {
      const cols = GRAPH_COLS.split(',').map((s) => s.trim());
      const ph = cols.map(() => '?').join(',');
      for (const n of d.nodes || []) {
        // slug UNIQUE 撞车就让它炸: 目标库该是新建的空库, 撞了说明调用方用错了地方。
        // 这里 INSERT OR IGNORE 会静默少灌节点, 那种"看着成功实则缺记忆"最难查。
        this.db.run(`INSERT INTO nodes(${cols.join(',')}) VALUES(${ph})`,
          cols.map((c) => (n[c] === undefined ? null : n[c])));
        idMap.set(n.id, this.db.get('SELECT last_insert_rowid() AS id').id);
      }
      for (const e of d.edges || []) {
        const src = idMap.get(e.src); const dst = idMap.get(e.dst);
        if (!src || !dst || src === dst) { dropped += 1; continue; }
        this.db.run(`INSERT INTO edges(src,dst,rel,made_by,weight,created) VALUES(?,?,?,?,?,?)
                     ON CONFLICT(src,dst,rel) DO NOTHING`,
          [src, dst, e.rel || 'relates', e.made_by || 'human', e.weight == null ? 1.0 : e.weight,
           e.created || todayLocal()]);
      }
      for (const p of d.pinned || []) {
        const id = idMap.get(p.node_id);
        if (!id) continue;
        this.db.run('INSERT INTO pinned(node_id,added_at,reason) VALUES(?,?,?)',
          [id, p.added_at || nowLocalISO(), p.reason || '']);
      }
      for (const r of d.redlines || []) {
        const id = idMap.get(r.node_id);
        if (!id) continue;
        this.db.run(`INSERT INTO redlines(node_id,trigger_pattern,correct_action,level,violations,last_violated)
                     VALUES(?,?,?,?,?,?)`,
          [id, r.trigger_pattern || '', r.correct_action || '', r.level || 'block',
           r.violations || 0, r.last_violated || null]);
      }
    });
    return { nodes: idMap.size, edges: (d.edges || []).length - dropped, dropped };
  }

  // 被别的 SQLite 客户端(sqlite3 CLI / python / better-sqlite3)打开过的库可能被切成 WAL,
  // 而本驱动 node-sqlite3-wasm 的 wasm VFS 没有 shm 原语, 建不出 -wal/-shm sidecar ——
  // 于是这个库【怎么都用不了】: 所有 memory_* 一律抛 `unable to open database file`。
  //
  // 🔴 必须在 new Database() **之前**扳回来, 而且只能改文件头, 不能靠 PRAGMA:
  //    构造函数是惰性的**不报错**, 但其后每一次读/写/PRAGMA 全抛 —— 连 `PRAGMA journal_mode=DELETE`
  //    它自己都抛。实测三种修法: 只删 sidecar ❌ · 删 sidecar + 改头 ✅ · sqlite3 CLI ✅(但用户机器
  //    未必有 sqlite3)。所以走第二种, 纯 fs 操作。
  // journal_mode 是持久属性, 写在文件头第 18/19 字节(1=rollback 2=WAL), 所以重启进程/重启 server
  // 一律无效 —— 2026-09-08 一台客户机器上的人格为此整整一天存不进也查不出。
  _healWalHeader() {
    try {
      if (!fs.existsSync(this.dbPath)) return;
      const fd = fs.openSync(this.dbPath, 'r+');
      const head = Buffer.alloc(2);
      fs.readSync(fd, head, 0, 2, 18);
      if (head[0] !== 2 && head[1] !== 2) { fs.closeSync(fd); return; }
      // 🔴 -wal 里还有没并回主库的事务时绝不硬扳: 那等于丢掉最后那批写入。
      // 这种情况只能靠有完整 WAL 支持的客户端(sqlite3 CLI)去 checkpoint, 所以只报不改。
      const wal = `${this.dbPath}-wal`;
      if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
        fs.closeSync(fd);
        console.error(`[store] 库是 WAL 模式且 -wal 中尚有未回放数据, 不敢硬改(会丢那批写入)。`
          + ` 请先跑: sqlite3 "${this.dbPath}" "PRAGMA journal_mode=DELETE"`);
        return;
      }
      fs.writeSync(fd, Buffer.from([1, 1]), 0, 2, 18);
      fs.closeSync(fd);
      for (const s of ['-wal', '-shm']) { try { fs.unlinkSync(this.dbPath + s); } catch (_) {} }
      console.error(`[store] 库被别的客户端切成过 WAL, 已扳回 rollback: ${this.dbPath}`);
    } catch (e) {
      console.error(`[store] WAL 自愈没做成(库可能仍打不开): ${e && e.message}`);
    }
  }

  // 🔴 CREATE TABLE IF NOT EXISTS 对【已存在的表】什么都不做 —— 往 schema 里加一列, 老库不会长出来。
  // 后果不是报错而是更坏的静默半废: 写那一列的语句被外层 try/catch 吞掉(logRecall 就包着
  // "记账失败不影响检索"), 于是功能看着在跑, 数据一直是空的。加列必须在这里显式补。
  _addMissingColumns() {
    const WANT = [['recall_log', 'filtered', 'INTEGER DEFAULT 0'],
                  ['nodes', 'claim_provisional', 'INTEGER DEFAULT 0'],
                  ['nodes', 'anchors', "TEXT DEFAULT ''"],
                  ['nodes', 'projects', "TEXT DEFAULT ''"],
                  ['nodes', 'translations', "TEXT DEFAULT ''"],
                  ['nodes', 'body_i18n', "TEXT DEFAULT ''"]];
    for (const [table, col, decl] of WANT) {
      let cols;
      try { cols = this._db.all(`PRAGMA table_info(${table})`); } catch (_) { continue; }
      if (!cols || !cols.length) continue;
      if (cols.some((c) => c.name === col)) continue;
      try { this._db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`); }
      catch (e) { console.error(`[schema] 补列失败 ${table}.${col}:`, e && e.message); }
    }
    this._dropReviewQueue();
  }

  // review_queue 退役 (2026-08-17)。老库里那张表可能还存着几百条欠账, 直接 DROP 会把
  // 「这条命题是兜底的」这个【判不出来的事实】一起丢掉 —— 肥大/孤儿/缺 type 体检都能重算,
  // 唯独兜底命题不能(它非空且看着正常)。所以先把它转成 nodes.claim_provisional 再删表。
  _dropReviewQueue() {
    let cols;
    try { cols = this._db.all('PRAGMA table_info(review_queue)'); } catch (_) { return; }
    if (!cols || !cols.length) return;
    try {
      this._db.run(`UPDATE nodes SET claim_provisional = 1 WHERE id IN (
                      SELECT node_id FROM review_queue
                       WHERE status = 'pending' AND reasons LIKE '%claim%')`);
      this._db.run('DROP TABLE review_queue');
      console.log('[schema] review_queue 已退役, 兜底命题转入 nodes.claim_provisional');
    } catch (e) { console.error('[schema] review_queue 退役失败:', e && e.message); }
  }

  close() { if (this._db) { try { this._db.close(); } catch (_) {} this._db = null; } }

  getMeta(k) { const r = this.db.get('SELECT v FROM meta WHERE k = ?', [k]); return r ? r.v : null; }
  setMeta(k, v) {
    this.db.run('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', [k, String(v)]);
  }

}

module.exports = SchemaMixin;
