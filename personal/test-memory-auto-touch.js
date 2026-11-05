// test-memory-auto-touch.js — 无头验证 §2.1 auto-touch (memory.js upsert use_count 递增)
// 跑法: node test-memory-auto-touch.js
// 场景: 新建首沉 = 1 · update = existing+1 · touch = 原逻辑不受影响 · fallback ||1 保留

const fs = require('fs');
const path = require('path');
const os = require('os');
const m = require('../core/memory.js');
const MemoryGraph = m.MemoryGraph || m;

const TEST_DIR = path.join(os.tmpdir(), 'butler-mem-autotouch-' + Date.now());
fs.mkdirSync(TEST_DIR, { recursive: true });

let pass = 0, fail = 0;
const assert = (actual, expected, label) => {
  if (actual === expected) { console.log(`  ✓ ${label} (=${actual})`); pass++; }
  else { console.log(`  ✗ ${label}: got ${actual}, want ${expected}`); fail++; }
};

const g = new MemoryGraph(TEST_DIR);

// 读节点 use_count 的辅助
function ucOf(id) {
  // 0.0.56 起索引住在 SQLite 里, 不再有 memory_index.json。读引擎快照等价于读旧文件。
  return (g._fresh().nodes[id] || {}).use_count;
}

console.log('\n[1] 新建节点 · 首沉 use_count = 1');
g.upsert({ id: 'test_node_a', title: '测试节点A', type: 'reference', description: '首沉', body: 'hello world' });
assert(ucOf('test_node_a'), 1, '新建后 use_count');

console.log('\n[2] update 同 id · use_count 递增');
g.upsert({ id: 'test_node_a', title: '测试节点A', type: 'reference', description: '第2次', body: 'v2 body' });
assert(ucOf('test_node_a'), 2, 'update #1 后');

g.upsert({ id: 'test_node_a', title: '测试节点A', type: 'reference', description: '第3次', body: 'v3 body' });
assert(ucOf('test_node_a'), 3, 'update #2 后');

console.log('\n[3] memory_touch 仍 +1 不变');
g.touch(['test_node_a']);
assert(ucOf('test_node_a'), 4, 'touch 后');

console.log('\n[4] 另一节点新建也 = 1 (不受第一个节点计数影响)');
g.upsert({ id: 'test_node_b', title: '节点B', type: 'project', body: 'b body' });
assert(ucOf('test_node_b'), 1, 'B 新建后');

console.log('\n[5] canon id (大小写/减号)');
g.upsert({ id: 'Test-Node-C', title: '节点C', type: 'reference', body: 'c body' });
assert(ucOf('test_node_c'), 1, 'canon 后 use_count');
// 同 canon 后 id 视为 update
g.upsert({ id: 'test_node_c', title: '节点C', type: 'reference', body: 'c v2' });
assert(ucOf('test_node_c'), 2, 'canon 后 update');

console.log('\n[6] fallback ||1 仍在 (未写 use_count 的老节点走 update 路径应视为 1 → +1 = 2)');
// 手动写一个没有 use_count 字段的 .md 模拟老节点
const legacyPath = path.join(TEST_DIR, 'test_legacy.md');
fs.writeFileSync(legacyPath, `---\nname: legacy\ndescription: "老节点"\nmetadata:\n  node_type: memory\n  type: reference\n  importance: med\n  created: 2026-01-01\n  last_used: 2026-01-01\n---\n\n老 body`, 'utf8');
g.build();   // rebuild 让 legacy 进 index
const legacyBefore = ucOf('test_legacy');
console.log(`  legacy build 后 use_count = ${legacyBefore} (期待 1 · fallback ||1)`);
assert(legacyBefore, 1, 'legacy fallback');
g.upsert({ id: 'test_legacy', title: 'legacy', type: 'reference', body: '重灌' });
assert(ucOf('test_legacy'), 2, 'legacy update = fallback 1 + 1');

console.log('\n[7] 清理');
fs.rmSync(TEST_DIR, { recursive: true, force: true });
assert(fs.existsSync(TEST_DIR), false, '临时目录已清理');

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
