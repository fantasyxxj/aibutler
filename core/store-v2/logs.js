// v2 存储层: 错误 / 发言 / 召回 / 修订历史
// 由 memory-store-v2.js 拆出(内核抽包第 2 步)。方法体逐字搬运, 经 mixin 挂回 MemoryStoreV2.prototype。
const { nowLocalISO } = require('../memory');

class LogsMixin {
  // —— 错误日志 (囤败方) ——————————————————————————————————
  // 同一条原话重复出现只累加 count: 犯同一个错 10 次的信号, 比 10 条一模一样的记录有用。
  logError({ node_id = null, raw = '', at = null }) {
    const when = at || nowLocalISO();
    const dup = node_id != null
      ? this.db.get('SELECT id FROM error_log WHERE node_id = ? AND raw = ?', [node_id, raw])
      : this.db.get('SELECT id FROM error_log WHERE node_id IS NULL AND raw = ?', [raw]);
    if (dup) { this.db.run('UPDATE error_log SET count = count + 1, at = ? WHERE id = ?', [when, dup.id]); return dup.id; }
    this.db.run('INSERT INTO error_log(node_id,at,raw,count) VALUES(?,?,?,1)', [node_id, when, raw]);
    return this.db.get('SELECT last_insert_rowid() AS id').id;
  }
  errorLog(limit = 50) {
    return this.db.all('SELECT id,node_id,at,raw,count FROM error_log ORDER BY at DESC LIMIT ?', [limit]);
  }

  // —— 原话流水 (一切的底片) ————————————————————————————
  // 🔴 一字不改、不去重、不截断。与 error_log 刻意不同: 那张表同话累加 count(要的是"犯了几次"),
  // 这张表是底片, 说了两遍就是两条 —— 说第二遍本身就是信息(那说明第一遍没被听进去)。
  addUtterance({ role, text, source = '', at = null }) {
    if (!text) return null;
    this.db.run('INSERT INTO utterances(at,role,source,text) VALUES(?,?,?,?)',
      [at || nowLocalISO(), role, source, text]);
    return this.db.get('SELECT last_insert_rowid() AS id').id;
  }
  utterances({ limit = 50, since = null } = {}) {
    return since
      ? this.db.all('SELECT id,at,role,source,text FROM utterances WHERE at >= ? ORDER BY at DESC LIMIT ?', [since, limit])
      : this.db.all('SELECT id,at,role,source,text FROM utterances ORDER BY at DESC LIMIT ?', [limit]);
  }
  utteranceCount() { return this.db.get('SELECT COUNT(*) AS c FROM utterances').c; }

  // —— 召回日志 (唯一的尺子) ————————————————————————————
  logRecall({ q, kind = 'query', hits = 0, top_score = 0, top_ids = [], filtered = 0, at = null }) {
    this.db.run('INSERT INTO recall_log(at,q,kind,hits,top_score,top_ids,filtered) VALUES(?,?,?,?,?,?,?)',
      [at || nowLocalISO(), String(q || ''), kind, hits, top_score, (top_ids || []).join(','), filtered]);
    return this.db.get('SELECT last_insert_rowid() AS id').id;
  }
  // touch 时回填: 把这个节点算进"最近给过它、且真被用上了"的那几条召回里。
  // 只回填最近 N 条而不是全表: 隔了半天才 touch 说明不是这次召回的功劳。
  // 🔴 窗口只认 kind='query' —— 成绩单的分母就只有 query, 别的 kind 占窗口纯粹是噪音。
  // 原来写的是 kind != 'dedupe', 漏掉了 auto/index_hook: auto 是每轮对话自动查一次(wake.js:42),
  // 实测占 recall_log 的 53%, 一条 query 后面能夹上百条 auto, 20 条窗口早被冲光 —— 隔几轮再
  // touch 就永远记不上功, 失败率因此虚高到 73%。
  markRecallUsed(nodeId, { lookback = 20 } = {}) {
    const rows = this.db.all(
      "SELECT id, top_ids FROM recall_log WHERE kind = 'query' ORDER BY id DESC LIMIT ?", [lookback]);
    const target = String(nodeId);
    let n = 0;
    for (const r of rows) {
      if (!String(r.top_ids || '').split(',').includes(target)) continue;
      this.db.run('UPDATE recall_log SET used = used + 1 WHERE id = ?', [r.id]);
      n++;
      break;   // 一次 touch 只算一次功劳, 别把同一个节点在多条召回里重复计数
    }
    return n;
  }
  // 召回失败 = 查了但一条都没被 touch。分母是"有结果的检索"——
  // 零命中那种是另一种失败(压根没东西), 分开看才知道该补内容还是该修检索。
  // 🔴 只统计 kind='query'。另两类来源天然不会被 touch, 进了分母就是噪音:
  // 'auto' 是每轮对话前系统主动塞的(它自己都写着"不相干就当没看见"),
  // 'dedupe' 是沉淀前查重, 目的恰恰是希望查不到 —— 被 touch 才是异常。
  recallStats({ limit = 200 } = {}) {
    const rows = this.db.all(
      "SELECT hits, top_score, used, filtered FROM recall_log WHERE kind = 'query' ORDER BY id DESC LIMIT ?", [limit]);
    const total = rows.length;
    const emptyRows = rows.filter((r) => !r.hits);
    const empty = emptyRows.length;
    // 零命中拆两半才有行动指向: 什么都没捞到 = 库里缺内容; 捞到了但全被分档挡掉 = 阈值偏严。
    // 合成一个数的话, 一次阈值调错会伪装成"知识不够", 而我会跑去写更多记忆。
    const emptyFiltered = emptyRows.filter((r) => r.filtered > 0).length;
    const withHits = rows.filter((r) => r.hits > 0);
    const unused = withHits.filter((r) => !r.used).length;
    return {
      total,
      empty,                                              // 零命中(合计)
      emptyBare: empty - emptyFiltered,                   // 真的什么都没捞到 → 补内容
      emptyFiltered,                                      // 捞到了但全不够格 → 看阈值是不是太严
      unused,                                             // 有结果却一条没用上 → 修检索/修命题
      used: withHits.length - unused,
      failRate: total ? Math.round(((empty + unused) / total) * 1000) / 1000 : 0,
    };
  }
  recallLog(limit = 50) {
    return this.db.all('SELECT id,at,q,kind,hits,top_score,top_ids,used,filtered FROM recall_log ORDER BY id DESC LIMIT ?', [limit]);
  }

  // —— 修订历史 (取代 _revisions/*.jsonl 351 个分片) ———————————
  addHistory({ node_id, op, field = '', before = '', after = '', actor = '', at = null }) {
    this.db.run('INSERT INTO history(node_id,at,op,field,before,after,actor) VALUES(?,?,?,?,?,?,?)',
      [node_id, at || nowLocalISO(), op, field, before, after, actor]);
  }
  historyOf(id, limit = 20) {
    return this.db.all('SELECT at,op,field,before,after,actor FROM history WHERE node_id = ? ORDER BY at DESC LIMIT ?',
      [id, limit]);
  }

  historyCount() { return this.db.get('SELECT COUNT(*) AS n FROM history').n; }
  nodeCount() { return this.db.get('SELECT COUNT(*) AS n FROM nodes').n; }

}

module.exports = LogsMixin;
