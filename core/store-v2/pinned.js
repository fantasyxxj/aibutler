// v2 存储层: 快查集 · 红线 · 违规计数
// 由 memory-store-v2.js 拆出(内核抽包第 2 步)。方法体逐字搬运, 经 mixin 挂回 MemoryStoreV2.prototype。
const { todayLocal, nowLocalISO } = require('../memory');

class PinnedMixin {
  // —— pinned (最常用 · 与重要性正交 · 配额 30) ————————————————
  pinnedIds() { return this.db.all('SELECT node_id FROM pinned').map((r) => r.node_id); }
  // 入表理由存了就得读得出来 —— 退休判断("现在还算常用吗")靠的就是当初为什么进来。
  pinnedMeta() {
    const out = new Map();
    for (const r of this.db.all('SELECT node_id,added_at,reason FROM pinned')) {
      out.set(r.node_id, { added_at: r.added_at, reason: r.reason || '' });
    }
    return out;
  }
  pinnedCount() { return this.db.get('SELECT COUNT(*) AS c FROM pinned').c; }
  isPinned(id) { return !!this.db.get('SELECT 1 AS x FROM pinned WHERE node_id = ?', [id]); }
  setPinned(id, reason = '') {
    this.db.run(
      `INSERT INTO pinned(node_id,added_at,reason) VALUES(?,?,?)
       ON CONFLICT(node_id) DO UPDATE SET reason=excluded.reason`,
      [id, todayLocal(), reason]);
  }
  unpin(id) { this.db.run('DELETE FROM pinned WHERE node_id = ?', [id]); }

  // —— redlines (一旦用到必须遵守 · 与 pinned 平级可重叠) ——————————
  allRedlines() {
    return this.db.all(
      // 带上 title: 打回话术给模型看的第一行就是它, 只给 slug 等于甩一个机器名过去。
      `SELECT r.node_id, r.trigger_pattern, r.correct_action, r.level, r.violations, n.slug, n.title, n.claim
         FROM redlines r JOIN nodes n ON n.id = r.node_id`);
  }
  redline(id) { return this.db.get('SELECT * FROM redlines WHERE node_id = ?', [id]) || null; }
  setRedline(id, { trigger_pattern = '', correct_action = '', level = 'block' } = {}) {
    this.db.run(
      `INSERT INTO redlines(node_id,trigger_pattern,correct_action,level) VALUES(?,?,?,?)
       ON CONFLICT(node_id) DO UPDATE SET trigger_pattern=excluded.trigger_pattern,
         correct_action=excluded.correct_action, level=excluded.level`,
      [id, trigger_pattern, correct_action, level]);
  }
  unsetRedline(id) { this.db.run('DELETE FROM redlines WHERE node_id = ?', [id]); }
  bumpViolation(id) {
    this.db.run('UPDATE redlines SET violations = violations + 1, last_violated = ? WHERE node_id = ?',
      [nowLocalISO(), id]);
  }

}

module.exports = PinnedMixin;
