// v2 存储层: 命题暂挂 · 家务队列 · 事务 · 向量 · 库统计
// 由 memory-store-v2.js 拆出(内核抽包第 2 步)。方法体逐字搬运, 经 mixin 挂回 MemoryStoreV2.prototype。
const fs = require('fs');
const { nowLocalISO } = require('../memory');
const { contentHash, floatsToBlob, blobToFloats } = require('./consts');

class OpsMixin {
  // —— 兜底命题标记 ————————————————————————————————————————
  // 机械迁只搬得动形式, 命题得拿旧摘要先兜着。兜底的命题非空且看着正常, 光读内容判不出来,
  // 所以必须记一个位 —— 这是迁移欠账里唯一【重算不出来】的部分(肥大/孤儿/缺 type 体检都能扫)。
  // 🔴 不是队列: 没有 pending/done/skips。改写命题时 upsertNode 自动清零, 体检每次重新数。
  markClaimProvisional(ids) {
    for (const id of ids || []) this.db.run('UPDATE nodes SET claim_provisional = 1 WHERE id = ?', [id]);
  }

  // —— 升级自检任务 ————————————————————————————————————————
  // 幂等: 同一个 key 重开机不重复派。已经 done 的**不复活** —— 干完的活不该因为再开一次机
  // 又跳回眼前, 那会让"做完就消失"这条承诺失效, 人格第二次就不信这个队列了。
  enqueueChore({ key, version = '', title, detail = '' }) {
    if (!key || !title) return false;
    const exist = this.db.get('SELECT status FROM chores WHERE key = ?', [key]);
    if (exist) return false;
    this.db.run(`INSERT INTO chores(key,version,title,detail,status,queued_at)
                 VALUES(?,?,?,?,'pending',?)`, [key, version, title, detail, nowLocalISO()]);
    return true;
  }
  choresPending() {
    return this.db.all("SELECT key,version,title,detail,queued_at FROM chores WHERE status='pending' ORDER BY queued_at ASC");
  }
  choreDone(key) {
    this.db.run("UPDATE chores SET status='done', done_at=? WHERE key = ?", [nowLocalISO(), key]);
    return { key, done: true };
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch (_) {} throw e; }
  }

  // —— 向量 ——————————————————————————————————————————————
  putVector(id, { dim, vec, model, srcHash, at }) {
    this.db.run(
      `INSERT INTO vectors (node_id,dim,vec,model,src_hash,embedded_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(node_id) DO UPDATE SET dim=excluded.dim, vec=excluded.vec, model=excluded.model,
         src_hash=excluded.src_hash, embedded_at=excluded.embedded_at`,
      [id, dim, floatsToBlob(vec), model, srcHash, at || nowLocalISO()]);
  }
  allVectors(model) {
    const rows = model
      ? this.db.all('SELECT node_id, dim, vec FROM vectors WHERE model = ?', [model])
      : this.db.all('SELECT node_id, dim, vec FROM vectors');
    return rows.map((r) => ({ id: r.node_id, dim: r.dim, vec: blobToFloats(r.vec) }));
  }
  vectorCount(model) {
    const r = model
      ? this.db.get('SELECT COUNT(*) AS c FROM vectors WHERE model = ?', [model])
      : this.db.get('SELECT COUNT(*) AS c FROM vectors');
    return r ? r.c : 0;
  }
  // 待补向量: 从没算过, 或算过但 title/claim/keywords 改了, 或换了模型。
  // 换模型必须整体重算 —— 不同模型的向量空间不可比。
  //
  // `textOf` 由引擎层注入, 用来决定【拿哪一语的文本去编码】: 日本の店なら日本語の訳文で
  // 埋め込む, という判断は言語モジュールの仕事で、ここ(存储层)は言語を知らないままでいい。
  // 🔴 指纹与编码文本必须同源 —— だから hash も textOf の結果から取る。ずれると
  // 「指纹说没变」なのに実際は別の言語を食わせていた, という静かな取り違えになる。
  // 表示言語が変われば hash も変わる → 自動で全件再計算, 追加の仕掛けは要らない。
  pendingEmbed(model, limit = 0, textOf = null) {
    const known = new Map();
    for (const r of this.db.all('SELECT node_id, src_hash FROM vectors WHERE model = ?', [model])) {
      known.set(r.node_id, r.src_hash);
    }
    const rows = this.db.all('SELECT id,title,claim,keywords,translations FROM nodes ORDER BY last_used DESC');
    const out = [];
    for (const r of rows) {
      const t = textOf ? textOf(r) : r;
      const h = contentHash(t.title, t.claim, t.keywords);
      if (known.get(r.id) === h) continue;
      out.push({ id: r.id, title: t.title, claim: t.claim, keywords: t.keywords, srcHash: h });
      if (limit && out.length >= limit) break;
    }
    return out;
  }
  dropVectors(model) {
    if (model) this.db.run('DELETE FROM vectors WHERE model != ?', [model]);
    else this.db.run('DELETE FROM vectors');
  }

  // 命题卫生的**廉价**计数: 只走 SQL, 不读正文。升级自检每次冷启动都要跑, 拿 doctor 当触发条件
  // 等于"为了判断要不要派活, 先把全库正文读一遍"。正文编年史不在这里数(SQL 判不出"含 3 个日期"),
  // 那个交给 doctor 报, 本计数只管命题行。GLOB 而不是 LIKE: LIKE 没有字符类, 判不出日期形状。
  claimHygiene() {
    const q = (sql) => { const r = this.db.get(sql); return r ? r.c : 0; };
    const DATED = "claim GLOB '*20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'";
    return {
      dated: q(`SELECT COUNT(*) AS c FROM nodes WHERE status='active' AND ${DATED}`),
      // 🔴 派活只按热的那批算: 冷门节点的烂命题不影响任何检索, 催人去还只是制造噪音,
      // 而且分母一大(实测 684/738 是用过 1~4 次的长尾)会让人一看就放弃, 整条轨道空转。
      datedHot: q(`SELECT COUNT(*) AS c FROM nodes WHERE status='active' AND use_count >= 5 AND ${DATED}`),
      provisional: q("SELECT COUNT(*) AS c FROM nodes WHERE status='active' AND claim_provisional = 1"),
    };
  }

  stats() {
    const c = (t) => { const r = this.db.get(`SELECT COUNT(*) AS c FROM ${t}`); return r ? r.c : 0; };
    let bytes = 0;
    try { bytes = fs.statSync(this.dbPath).size; } catch (_) {}
    return {
      nodes: c('nodes'), edges: c('edges'), vectors: c('vectors'),
      pinned: c('pinned'), redlines: c('redlines'), history: c('history'), errors: c('error_log'),
      bytes,
    };
  }
}

module.exports = OpsMixin;
