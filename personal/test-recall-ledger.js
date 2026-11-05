// test-recall-ledger.js — 召回成绩单门禁 (2026-08-25)
// 跑法: node personal/test-recall-ledger.js
// 守两个真出过的 bug:
//   ① doctor 在库里有超闸节点时崩 —— doctor.js 漏引体积常量, 报告在下一行,
//      于是"召回失败率"那条永远输不出来, 连带把 ② 藏了几个月。
//   ② markRecallUsed 回填窗口写成 kind != 'dedupe', auto(每轮对话一条, 占日志 53%)
//      把 query 冲出 20 条窗口 → 隔几轮再 touch 全部白记 → 失败率虚高到 73%。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { MemoryGraphV2, bodyHardTokens } = require('../core/memory-v2.js');

const TEST_DIR = path.join(os.tmpdir(), 'butler-recall-ledger-' + Date.now());
fs.mkdirSync(TEST_DIR, { recursive: true });

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}`); fail++; }
};
const eq = (a, b, label) => ok(a === b, `${label} (got ${a}, want ${b})`);

const g = new MemoryGraphV2(TEST_DIR);

console.log('\n[1] 回填窗口: auto 刷屏之后 touch 还算不算数');
{
  const r = g.upsert({ slug: 'reference_probe_a', claim: '命题: 探针 A', type: 'reference' });
  g.store.logRecall({ q: '探针查询', kind: 'query', hits: 3, top_score: 0.97, top_ids: [r.id, 9901, 9902] });
  // 每轮对话都会自动查一次(wake.js), 只写日志不进上下文 —— 正是它把窗口冲光的
  for (let i = 0; i < 30; i++) {
    g.store.logRecall({ q: `第${i}轮`, kind: 'auto', hits: 5, top_score: 0.8, top_ids: [9903, 9904] });
  }
  const n = g.store.markRecallUsed(r.id);
  const row = g.store.db.all("SELECT used FROM recall_log WHERE kind='query' ORDER BY id DESC LIMIT 1")[0];
  eq(n, 1, '隔 30 条 auto 之后 touch 仍回填到那条 query');
  ok(row.used > 0, '🔴 那条 query 记上功了(窗口不被 auto 冲光)');
}

console.log('\n[2] 回填窗口口径要和成绩单分母一致');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'store-v2', 'logs.js'), 'utf8');
  const mark = src.slice(src.indexOf('markRecallUsed'), src.indexOf('recallStats'));
  ok(/WHERE kind = 'query'/.test(mark),
    "🔴 markRecallUsed 用白名单 kind = 'query'(不是 != 'dedupe' 那种排除法, 会漏 auto/index_hook)");
  const stats = src.slice(src.indexOf('recallStats'));
  ok(/kind = 'query'/.test(stats), 'recallStats 分母也只认 query — 两边同一口径');
}

console.log('\n[3] auto / dedupe 不进成绩单分母');
{
  const before = g.recallStats().total;
  g.store.logRecall({ q: '自动查', kind: 'auto', hits: 4, top_score: 0.9, top_ids: [9905] });
  g.store.logRecall({ q: '查重', kind: 'dedupe', hits: 2, top_score: 0.9, top_ids: [9906] });
  eq(g.recallStats().total, before, 'auto 和 dedupe 都没把分母顶高');
}

console.log('\n[4] doctor 遇到超闸的胖节点不许崩');
{
  // force 灌进去 —— 模拟闸落地之前就存在的存量欠账, 那正是 doctor 要发现的东西
  g.upsert({ slug: 'reference_probe_fat', claim: '命题: 探针胖节点', type: 'reference',
    body: 'x'.repeat((bodyHardTokens() + 300) * 4), force: true });
  let r = null, err = null;
  try { r = g.doctor(); } catch (e) { err = e; }
  ok(!err, `🔴 doctor 跑通不抛异常${err ? ' — ' + err.message : ''}`);
  const fatProblem = (r && r.problems || []).find((p) => /body over gate/.test(p.kind));
  ok(!!fatProblem, 'doctor 报出了「正文超闸」这条(即走到了原先崩掉的那一行)');
  ok(fatProblem && /Limit is \d+ tokens/.test(fatProblem.hint || ''),
    '🔴 hint 里上限渲染出了真数字(体积常量有引进来)');
}

console.log('\n[4.5] 编年史检测: 圈得出流水账, 且不误伤只提一次日期的');
{
  // 三个日期是判据下限, 所以两个日期的必须放过 —— 事故复盘天然会带一两个日期, 误伤它
  // 等于逼人把"怎么验的"从正文里删掉, 那恰恰是正文该装的东西。
  g.upsert({ slug: 'reference_probe_chronicle', claim: '命题: 探针流水账', type: 'reference',
    body: '2026-08-01 改了 A\n2026-08-11 又改回 B\n2026-08-20 最终定成 C' });
  g.upsert({ slug: 'reference_probe_one_date', claim: '命题: 探针单日期', type: 'reference',
    body: '2026-08-01 实测: 端口 8788 打不通是因为 dev 没起, 不是配置错' });
  g.upsert({ slug: 'reference_probe_dated_claim', type: 'reference',
    claim: '命题: 2026-08-26 这条命题行带了日期' });

  const r = g.doctor();
  const chron = (r.problems || []).find((p) => /chronicle/.test(p.kind));
  ok(!!chron, 'doctor 报出「正文疑似编年史」这一类');
  ok(chron && chron.sample.some((s) => s.startsWith('reference_probe_chronicle')),
    '三个日期的流水账被圈出来');
  ok(chron && !chron.sample.some((s) => s.startsWith('reference_probe_one_date')),
    '🔴 只提一次日期的没被误伤(证据类正文本来就该带"哪天验的")');
  ok(chron && /how to use this claim|proven true/.test(chron.hint || ''),
    '🔴 hint 给的是判据不只是数量 (光说"你有 N 条脏的"没人知道该删哪句)');

  const dirtyClaim = (r.problems || []).find((p) => /claim line contains a date/.test(p.kind));
  ok(!!dirtyClaim, 'doctor 单独报出「命题行带日期」(命题脏比正文脏更要紧)');
  ok(dirtyClaim && dirtyClaim.sample.includes('reference_probe_dated_claim'), '带日期的命题被圈出来');
  ok(dirtyClaim && /do NOT pass body/.test(dirtyClaim.hint || ''),
    '🔴 hint 提醒只改 claim 别传 body (否则照着改会顺手把正文冲了)');
}

console.log('\n[5] 召回失败率那条报告排在胖节点之后 — 前面崩了它就永远看不见');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'memory-v2', 'doctor.js'), 'utf8');
  const fatAt = src.indexOf('body over gate');
  const recallAt = src.indexOf('recall failure rate');
  ok(fatAt !== -1 && recallAt !== -1 && fatAt < recallAt,
    '两条报告的先后关系仍是「胖节点 → 召回失败率」(所以 [4] 必须绿, 否则失败率静默消失)');
  const head = src.slice(0, src.indexOf('class '));
  ok(/bodyHardTokens/.test(head), '🔴 doctor.js 头部 require 里有 bodyHardTokens');
}

console.log('\n[6] 清理');
try { g.store.db.close && g.store.db.close(); } catch (_) {}
fs.rmSync(TEST_DIR, { recursive: true, force: true });
ok(!fs.existsSync(TEST_DIR), '临时目录已清理');

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
