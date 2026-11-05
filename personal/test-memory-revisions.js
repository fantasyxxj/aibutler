// test-memory-revisions.js — 统一修订日志门禁 (memory-revisions.js)
// 跑法: node test-memory-revisions.js
// 覆盖: 分片路径与文件名安全(不能穿越目录) · op 五种取值 · 50 条滚动归档(留最近50+第一条)
//       · 2KB 截断 · revisionCounts 不返正文 · .jsonl 确实不进图 · 只挂 upsert/append 两个写入点

const fs = require('fs');
const path = require('path');
const os = require('os');
const { MemoryGraph } = require('../core/memory.js');
const R = require('../core/memory-revisions.js');

const TEST_DIR = path.join(os.tmpdir(), 'butler-mem-rev-' + Date.now());
fs.mkdirSync(TEST_DIR, { recursive: true });

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}`); fail++; }
};
const eq = (a, b, label) => ok(a === b, `${label} (got ${a}, want ${b})`);

const g = new MemoryGraph(TEST_DIR);

console.log('\n[1] upsert/append 记日志, link/touch 不记');
g.upsert({ id: 'feedback_x', type: 'feedback', description: 'd1', body: '原文一' });
g.upsert({ id: 'feedback_x', type: 'feedback', description: 'd2', body: '原文二', revReason: '作者纠正' });
let L = g.revisions('feedback_x');
eq(L.count, 2, '两次 upsert = 2 条');
eq(L.entries[0].op, 'create', '首次是 create');
eq(L.entries[1].op, 'update', '二次是 update');
ok(L.entries[1].old_body.includes('原文一'), 'update 存住旧正文(误改可捞回)');
eq(L.entries[1].reason, '作者纠正', 'reason 落盘');

g.append({ parent_id: 'feedback_x', section: '补充', body: '追加块', actor: 'test', reason: '补例' });
g.upsert({ id: 'feedback_y', type: 'feedback', description: 'dy', body: 'y' });
g.linkBidirectional({ from_id: 'feedback_x', to_id: 'feedback_y' });
g.touch(['feedback_x']);
L = g.revisions('feedback_x');
eq(L.count, 3, 'append 记一条; link/touch 一条都不记(只连边/只动 index 不算内容变更)');
eq(L.entries[2].new_body, '追加块', 'append 记的是增量不是全文');

console.log('\n[2] 文件名安全: node_id 不能穿越目录');
R.logRevision(TEST_DIR, { op: 'evict', node_id: '../../etc/passwd', reason: '攻击' });
const revFiles = fs.readdirSync(path.join(TEST_DIR, '_revisions'));
ok(revFiles.includes('etcpasswd.jsonl'), '非法字符被剔除, 落在 _revisions/ 内');
ok(!revFiles.some((f) => f.includes('..') || f.includes('/')), '文件名里没有 .. 或 /');
eq(R.safeName('../../x'), 'x', 'safeName 剥掉路径片段');
eq(R.safeName(''), 'unknown', '空 id 兜底成 unknown');

console.log('\n[3] op 五种取值, 非法 op 抛错');
for (const op of ['create', 'update', 'supersede', 'evict', 'merge']) {
  let threw = false;
  try { R.logRevision(TEST_DIR, { op, node_id: 'feedback_ops' }); } catch (_) { threw = true; }
  ok(!threw, `合法 op: ${op}`);
}
let threwBad = false;
try { R.logRevision(TEST_DIR, { op: 'delete_everything', node_id: 'feedback_ops' }); } catch (_) { threwBad = true; }
ok(threwBad, '非法 op 抛错');

console.log('\n[4] 硬闸①: 超 50 条滚动归档, 留【第一条 + 最近 50】');
for (let i = 0; i < 60; i++) R.logRevision(TEST_DIR, { op: 'update', node_id: 'feedback_roll', reason: 'r' + i });
L = g.revisions('feedback_roll');
eq(L.count, 51, '总数封在 51');
eq(L.entries[0].reason, 'r0', '第一条(出生记录)永远保留');
eq(L.entries[50].reason, 'r59', '尾部是最新的');
ok(!L.entries.some((e) => e.reason === 'r5'), '中间的老记录被归档掉了');

console.log('\n[5] 硬闸②: old_body/new_body 超 2KB 截断存摘要+原长');
R.logRevision(TEST_DIR, { op: 'update', node_id: 'feedback_big', new_body: 'x'.repeat(5000) });
L = g.revisions('feedback_big');
ok(L.entries[0].new_body.length < 2200, `截断到 ${L.entries[0].new_body.length} 字符`);
ok(/原长 5000 字符/.test(L.entries[0].new_body), '标注了原始长度');

console.log('\n[6] .jsonl 天然不进图(_mdFiles 只扫 .md)');
const st = g.build();
const idxNodes = Object.keys(g._fresh().nodes);   // 0.0.56: 索引在 SQLite
ok(!idxNodes.some((k) => k.includes('roll') || k.includes('passwd') || k.includes('big')), '日志文件没混成图节点');
eq(st.nodes, 2, '图里仍只有 feedback_x / feedback_y 两个真节点');

console.log('\n[7] revisionCounts: 机械筛只回条数, 不返正文');
const C = g.revisionCounts();
eq(C[0].node_id, 'feedback_roll', '改动最频繁的排第一');
eq(C[0].revisions, 51, '条数正确');
ok(!JSON.stringify(C).includes('追加块'), '结果里不含任何正文(省的是进 context 的 token)');

console.log('\n[8] markOverturned: 判决可被事后推翻(自校正闭环的真值来源)');
const mk = g.markOverturned('feedback_x', { note: '作者说判错了' });
ok(mk.ok, '标记成功');
L = g.revisions('feedback_x');
ok(L.entries[L.count - 1].overturned && L.entries[L.count - 1].overturned.note === '作者说判错了', '最后一条被标 overturned');
const mkMiss = g.markOverturned('feedback_x', { ts: '1999-01-01 00:00' });
ok(!mkMiss.ok, '指定不存在的 ts → 明确失败, 不静默乱标');

console.log('\n[9] revisionStats: 样本不足就不给结论(不做假精确)');
const S = g.revisionStats({ minSample: 20 });
const ev = S.byOp.find((o) => o.op === 'evict');
ok(ev.sample_short === true && ev.rate === null, `evict 仅 ${ev.total} 条 → rate=null 沉默`);
const up = S.byOp.find((o) => o.op === 'update');
ok(!up.sample_short && up.rate !== null, `update 有 ${up.total} 条 → 给出 rate=${up.rate}`);

console.log(`\n结果: ${pass} pass, ${fail} fail`);
try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
