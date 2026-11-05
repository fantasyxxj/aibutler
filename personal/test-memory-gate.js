// test-memory-gate.js — 无头验证 §2.2 pre-query 挡门 (memory.js hasNode + query flat + 挡门决策)
// 跑法: node test-memory-gate.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { MemoryGraph } = require('../core/memory.js');

const TEST_DIR = path.join(os.tmpdir(), 'butler-mem-gate-' + Date.now());
fs.mkdirSync(TEST_DIR, { recursive: true });

let pass = 0, fail = 0;
const assert = (actual, expected, label) => {
  const ok = actual === expected;
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}: got ${actual}, want ${expected}`); fail++; }
};

const g = new MemoryGraph(TEST_DIR);

console.log('\n[1] hasNode: 空图返 false');
assert(g.hasNode('foo'), false, 'hasNode 前无节点');

console.log('\n[2] hasNode: 沉了返 true');
g.upsert({ id: 'reference_topic_a', title: 'Topic A', type: 'reference', description: 'about a', body: 'body a' });
assert(g.hasNode('reference_topic_a'), true, 'hasNode 后可查到');

console.log('\n[3] hasNode: canon 后一致 (大小写/-)');
assert(g.hasNode('Reference-Topic-A'), true, 'hasNode canon 匹配');

console.log('\n[4] hasNode: 不存在的 id 仍 false');
assert(g.hasNode('reference_nonexistent'), false, '非存在 id false');

console.log('\n[5] query flat=true 返回 score 字段, 且不含图扩散 hop 结果');
// 沉一个 pinned 节点 + 一个 med 节点, 都跟 "quantum" 相关
g.upsert({ id: 'reference_quantum_pinned', title: 'quantum entanglement principle',
  type: 'reference', importance: 'pinned',
  description: 'quantum principle explained', body: 'quantum ...' });
g.upsert({ id: 'project_quantum_experiment', title: 'quantum experiment run',
  type: 'project', exit_criteria: '实验跑完出报告',
  description: 'run a quantum experiment', body: '[[reference_quantum_pinned]]' });
const flatHits = g.query('quantum principle', { k: 5, flat: true });
console.log(`  flatHits: ${flatHits.map(h => `${h.id}=${h.score}`).join(', ')}`);
assert(flatHits.length > 0, true, 'flat 有直接命中');
assert(typeof flatHits[0].score, 'number', 'score 是数字');
// flat 时不应有 "图跳" via
assert(flatHits.every(h => h.via === '直接'), true, 'flat 全部直接命中(无图跳)');

console.log('\n[6] 挡门决策逻辑 (从 agent.js memUpsert handler 复制)');
const THRESHOLD = 200;
function shouldBlock(hits, threshold) {
  if (!hits || hits.length === 0) return false;
  return hits[0].score > threshold;
}
assert(shouldBlock([{ score: 250 }], THRESHOLD), true, '250 > 200 → block');
assert(shouldBlock([{ score: 200 }], THRESHOLD), false, '200 不 > 200 → 通过 (>=严格 >)');
assert(shouldBlock([{ score: 150 }], THRESHOLD), false, '150 < 200 → 通过');
assert(shouldBlock([], THRESHOLD), false, '空 hits → 通过');

console.log('\n[7] 端到端: pinned 节点 + 极高 rel query 场景');
// 构造 title 长且多 term 全命中的场景 (rel > 47 才让 combined > ~200)
const longTitle = 'aa bb cc dd ee ff gg hh ii jj kk ll mm nn oo pp qq rr ss tt uu vv';
g.upsert({ id: 'reference_massive_pinned', title: longTitle,
  type: 'reference', importance: 'pinned',
  description: longTitle, body: 'body' });
const massiveHits = g.query(longTitle, { k: 3, flat: true });
console.log(`  massiveHits top-1: ${massiveHits[0]?.id}=${massiveHits[0]?.score}`);
// 22 term title 命中 rel = 22*3 + 22*1 (description) = 88, combined = 88*2 + hotness_pinned(100+) = ~276
assert(shouldBlock(massiveHits, THRESHOLD), true, '极高重合场景应被挡门');

console.log('\n[8] 场景: 主题相关但不重合应通过');
// 查询非常不同的话题
const unrelatedHits = g.query('completely unrelated random text', { k: 3, flat: true });
assert(shouldBlock(unrelatedHits, THRESHOLD), false, '不相关查询不挡门');

console.log('\n[9] 场景: confirm_new=true 逻辑 (agent 层)');
// 模拟 agent.js handler 短路: confirm_new=true → 不走挡门
const runGateCheck = (confirm_new, isNewNode, hits, threshold) => {
  if (confirm_new) return { blocked: false, reason: 'confirm_new' };
  if (!isNewNode) return { blocked: false, reason: 'update' };
  if (shouldBlock(hits, threshold)) return { blocked: true, reason: 'threshold' };
  return { blocked: false, reason: 'pass' };
};
assert(runGateCheck(true, true, [{ score: 300 }], 200).blocked, false, 'confirm_new=true 绕过');
assert(runGateCheck(false, false, [{ score: 300 }], 200).blocked, false, 'update (老 id) 直通');
assert(runGateCheck(false, true, [{ score: 300 }], 200).blocked, true, '新建高分挡门');
assert(runGateCheck(false, true, [{ score: 150 }], 200).blocked, false, '新建低分通过');

console.log('\n[10] 清理');
fs.rmSync(TEST_DIR, { recursive: true, force: true });
assert(fs.existsSync(TEST_DIR), false, '临时目录已清理');

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
