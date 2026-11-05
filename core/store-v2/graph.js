// v2 存储层: 节点与边
// 由 memory-store-v2.js 拆出(内核抽包第 2 步)。方法体逐字搬运, 经 mixin 挂回 MemoryStoreV2.prototype。
const { todayLocal } = require('../memory');
const { NODE_COLS } = require('./consts');

class GraphMixin {
  // —— 节点 ——————————————————————————————————————————————
  // 不取 body。检索的精确层只看 title/claim/keywords, body 由 bodiesOf 按需拿。
  allNodes() {
    const rows = this.db.all(`SELECT ${NODE_COLS} FROM nodes`);
    const out = {};
    for (const r of rows) out[r.id] = r;
    return out;
  }
  node(id) { return this.db.get(`SELECT ${NODE_COLS} FROM nodes WHERE id = ?`, [id]) || null; }
  nodeBySlug(slug) { return this.db.get(`SELECT ${NODE_COLS} FROM nodes WHERE slug = ?`, [slug]) || null; }

  // slug ↔ id 解析。迁移期与人机交互都要用: 我说得出的是 slug, 库里连的是数字。
  idOf(slug) { const r = this.db.get('SELECT id FROM nodes WHERE slug = ?', [slug]); return r ? r.id : null; }
  slugOf(id) { const r = this.db.get('SELECT slug FROM nodes WHERE id = ?', [id]); return r ? r.slug : null; }
  slugMap() {
    const m = new Map();
    for (const r of this.db.all('SELECT id, slug FROM nodes')) m.set(r.slug, r.id);
    return m;
  }

  bodiesOf(ids) {
    const out = new Map();
    if (!ids || !ids.length) return out;
    for (const id of ids) {
      const r = this.db.get('SELECT body FROM nodes WHERE id = ?', [id]);
      if (r) out.set(id, r.body || '');
    }
    return out;
  }
  // 正文 + 正文译文。body_i18n 是冷列(NODE_COLS 里没有), 只有"真要展开这一条正文"
  // 才值得多取一列 —— 检索面里没有正文, 也就轮不到它。
  bodyWithI18n(id) {
    return this.db.get('SELECT body, body_i18n FROM nodes WHERE id = ?', [id])
           || { body: '', body_i18n: '' };
  }

  // 兜底命中: 只在精确命中不足时走, 所以全表扫 body 不在热路径上。
  bodyMatches(term) {
    if (!term) return [];
    const like = '%' + String(term).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    return this.db.all("SELECT id FROM nodes WHERE lower(body) LIKE ? ESCAPE '\\'", [like]).map((r) => r.id);
  }

  // 有 id 按 id 更新, 有 slug 且已存在按 slug 更新, 都没有则新建并返回新 id。
  // claim 是 NOT NULL 的: 一条没有命题的记忆没有存在意义 —— 那正是 v1 满库摘要的病。
  //
  // 🔴 更新走 **partial 语义**: 没传的字段保持原值, 传了空串才是真清空。
  // 这不是图省事。v1 是整体覆盖, 2026-08-02 就是这么把一个节点的正文整段冲掉的
  // (当时以为"只写增量段"就是追加)。底层 API 让每个调用方都记得"先读后写"不现实,
  // 该让默认行为是安全的那一侧; 需要整体覆盖语义的是 MCP 工具层, 由它显式传全字段。
  upsertNode(n, opts = {}) {
    // id 是数字主键。老代码到处假设它是 'feedback_xxx' 这种语义字符串, 传进来会被当作主键去
    // UPDATE ... WHERE id='feedback_xxx' —— 匹配 0 行, 不抛错, 调用方收到"成功"。
    // 2026-08-16 birth.js 就是这样"灌了 22 条"而库里 0 条。宁可炸, 不要静默不写。
    if (n.id !== undefined && n.id !== null && !Number.isInteger(Number(n.id))) {
      throw new Error(`id 必须是数字主键, 收到 "${n.id}" —— 语义 id 请走 slug 参数`);
    }
    const id = n.id || (n.slug ? this.idOf(n.slug) : null);
    if (!id && !n.claim) throw new Error('claim 不能为空: 记忆的核心是命题, 不是文章');
    if (n.claim === '') throw new Error('claim 不能清空');
    const now = todayLocal();
    const FIELDS = ['slug', 'title', 'claim', 'keywords', 'anchors', 'projects', 'translations', 'body', 'body_i18n',
      'type', 'importance', 'status',
      'scope', 'provenance', 'is_factory', 'exit_criteria', 'review_due', 'created', 'last_used', 'use_count',
      'claim_provisional'];

    if (id) {
      const given = FIELDS.filter((f) => n[f] !== undefined);
      if (given.length) {
        const prev = this.db.get('SELECT claim, body, importance, status FROM nodes WHERE id = ?', [id]);
        const vals = given.map((f) => (f === 'is_factory' ? (n[f] ? 1 : 0) : n[f]));
        this.db.run(`UPDATE nodes SET ${given.map((f) => `${f}=?`).join(',')} WHERE id=?`, [...vals, id]);
        // 修订历史内建在写路径上, 不靠调用方记得调 —— v1 那套 _revisions/*.jsonl 旁路
        // 就是因为"另外一个模块负责"而与图脱节的。只记真变了的字段。
        if (prev) {
          for (const f of ['claim', 'body', 'importance', 'status']) {
            if (n[f] !== undefined && prev[f] !== n[f]) {
              this.addHistory({ node_id: id, op: opts.op || 'upsert', field: f,
                before: prev[f], after: n[f], actor: opts.actor || '' });
            }
          }
          // 命题被真正改写 = 兜底那条已经被人判过了, 标记自动落下。体检下次就不再数它,
          // 所以"还完了"这件事不需要谁去标 done —— 干活本身就是标记。
          //
          // 🔴 显式传了 claim_provisional 就不自动清: 上面那条 UPDATE 已经把显式值写进去了,
          // 这里再无条件抹成 0 会让「边改命题边标成临时(=2)」永远落不下来 —— 而那正是
          // 讨论中临时命题的典型写法(想法一变就重写命题, 但它仍然没判过真假)。
          if (n.claim !== undefined && prev.claim !== n.claim && n.claim_provisional === undefined) {
            this.db.run('UPDATE nodes SET claim_provisional = 0 WHERE id = ?', [id]);
          }
        }
      }
      return id;
    }
    const vals = {
      slug: n.slug || null, title: n.title || '', claim: n.claim, keywords: n.keywords || '',
      anchors: n.anchors || '', projects: n.projects || '', translations: n.translations || '',
      body: n.body || '', body_i18n: n.body_i18n || '',
      type: n.type || '', importance: n.importance || 'med',
      status: n.status || 'active', scope: n.scope || '',
      provenance: n.provenance || 'local', is_factory: n.is_factory ? 1 : 0,
      exit_criteria: n.exit_criteria || '', review_due: n.review_due || '',
      created: n.created || now, last_used: n.last_used || now,
      use_count: n.use_count != null ? n.use_count : 1,
      claim_provisional: n.claim_provisional != null ? n.claim_provisional : 0,
    };
    this.db.run(
      `INSERT INTO nodes(slug,title,claim,keywords,anchors,projects,translations,body,body_i18n,
                         type,importance,status,scope,
                         provenance,is_factory,exit_criteria,review_due,created,last_used,use_count,
                         claim_provisional)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [vals.slug, vals.title, vals.claim, vals.keywords, vals.anchors, vals.projects, vals.translations,
       vals.body, vals.body_i18n, vals.type, vals.importance,
       vals.status, vals.scope, vals.provenance, vals.is_factory, vals.exit_criteria,
       vals.review_due, vals.created, vals.last_used, vals.use_count, vals.claim_provisional]);
    const nid = this.db.get('SELECT last_insert_rowid() AS id').id;
    this.addHistory({ node_id: nid, op: 'create', field: 'claim', before: '', after: vals.claim, actor: opts.actor || '' });
    return nid;
  }

  // 边/pinned/redlines/history/vectors 全靠外键 ON DELETE CASCADE 跟着走, 不用手工挨个删。
  // error_log 是刻意的例外(SET NULL): 犯过的错要留着, 哪怕那条记忆本身已经删了。
  deleteNodes(ids) {
    for (const id of ids || []) this.db.run('DELETE FROM nodes WHERE id = ?', [id]);
  }

  // 出厂知识同步用: 库里现存的出厂节点。升级时拿它跟新版知识包比清单, 差集就是这版删掉的。
  // 带上内容字段是为了让同步器能比对"真变了没" —— 没变就不写, 否则每次升级全量 upsert
  // 会把 use_count 集体 +1(auto-touch), 热度排序被出厂知识淹掉, 修订史也堆满无变化记录。
  factoryNodes() {
    // 🔴 译文两列必须在这里一起取: contentChanged 拿的就是这一份去跟新包比。少取一列 =
    // "库里恒为空 vs 包里有值" → 每次开机都判"变了" → 全量 upsert, 正是上面要防的那件事。
    return this.db.all(`SELECT id, slug, title, claim, keywords, translations,
                               body, body_i18n, type, importance, scope, status
                        FROM nodes WHERE is_factory = 1`);
  }

  setUsage(id, lastUsed, useCount) {
    this.db.run('UPDATE nodes SET last_used = ?, use_count = ? WHERE id = ?', [lastUsed, useCount, id]);
  }

  // —— 边 ————————————————————————————————————————————————
  allEdges() { return this.db.all('SELECT src,dst,rel,made_by,weight FROM edges'); }
  edgesOf(id) {
    return this.db.all('SELECT src,dst,rel,made_by,weight FROM edges WHERE src = ? OR dst = ?', [id, id]);
  }
  addEdge(src, dst, rel = 'relates', madeBy = 'human', weight = 1.0) {
    if (src === dst) return false;
    this.db.run(
      `INSERT INTO edges(src,dst,rel,made_by,weight,created) VALUES(?,?,?,?,?,?)
       ON CONFLICT(src,dst,rel) DO UPDATE SET made_by=excluded.made_by, weight=excluded.weight`,
      [src, dst, rel, madeBy, weight, todayLocal()]);
    return true;
  }
  // 5.2 共现边: weight 是【累计共用次数】, 所以只能加不能覆盖 —— addEdge 那条是整体写,
  // 拿来记次数会每次都被打回 1。made_by 固定 engine, rel 固定 co_used: 两个维度都跟人写的边分开,
  // 手写一条 relates 永远不会被自动边顶掉, 反过来也一样。
  bumpCoEdge(src, dst, by = 1) {
    if (src === dst) return false;
    const [a, b] = src < dst ? [src, dst] : [dst, src];   // 共现无方向, 存一行就够, 否则同一对要数两遍
    this.db.run(
      `INSERT INTO edges(src,dst,rel,made_by,weight,created) VALUES(?,?,'co_used','engine',?,?)
       ON CONFLICT(src,dst,rel) DO UPDATE SET weight = weight + ?`,
      [a, b, by, todayLocal(), by]);
    return true;
  }
  removeEdge(src, dst, rel) {
    if (rel) this.db.run('DELETE FROM edges WHERE src=? AND dst=? AND rel=?', [src, dst, rel]);
    else this.db.run('DELETE FROM edges WHERE src=? AND dst=?', [src, dst]);
  }
  // 只整体替换【人写的】某一类出边。自动长出来的(made_by='engine')不能被一次手写覆盖抹掉 ——
  // 这正是 v1 replaceLinks 做不到的事: 那时所有边都来自正文正则, 没有来源之分。
  replaceEdges(src, dsts, rel = 'relates', madeBy = 'human') {
    this.db.run('DELETE FROM edges WHERE src=? AND rel=? AND made_by=?', [src, rel, madeBy]);
    for (const d of dsts || []) this.addEdge(src, d, rel, madeBy);
  }
  // 召回时的硬动作来源: 谁推翻了它。v1 的 superseded_by 只是 nodes 上一个没人执行的字段。
  supersededBy(id) {
    return this.db.all(
      `SELECT n.id, n.slug, n.claim FROM edges e JOIN nodes n ON n.id = e.src
        WHERE e.dst = ? AND e.rel = 'supersedes'`, [id]);
  }

}

module.exports = GraphMixin;
