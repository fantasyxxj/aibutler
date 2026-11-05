// test-memory-append-link.js — 无头验证 §2.3 memory_append + memory_link_bidirectional
// 跑法: node test-memory-append-link.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { MemoryGraph } = require('../core/memory.js');

const TEST_DIR = path.join(os.tmpdir(), 'butler-mem-append-link-' + Date.now());
fs.mkdirSync(TEST_DIR, { recursive: true });

let pass = 0, fail = 0;
const assert = (cond, label) => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}`); fail++; }
};

const g = new MemoryGraph(TEST_DIR);
function useCountOf(id) {
  // 0.0.56 起索引住在 SQLite 里, 不再有 memory_index.json。读引擎快照等价于读旧文件。
  return (g._fresh().nodes[id] || {}).use_count;
}
function bodyOf(id) {
  return fs.readFileSync(path.join(TEST_DIR, id + '.md'), 'utf8');
}

// 铺垫: 沉两个节点
g.upsert({ id: 'reference_topic_a', title: 'Topic A', type: 'reference', importance: 'high',
  description: 'about a', body: '# 主体\n初始内容 A' });
g.upsert({ id: 'reference_topic_b', title: 'Topic B', type: 'reference',
  description: 'about b', body: '# 主体\n初始内容 B' });
const ucAfterSeed = useCountOf('reference_topic_a');

console.log('\n[1] append: section 不存在 → 自动建');
const r1 = g.append({ parent_id: 'reference_topic_a', section: '血泪案例',
  body: 'case 1', actor: '飞飞', reason: '首次血泪' });
assert(r1.sectionCreated === true, 'sectionCreated=true');
const bodyA = bodyOf('reference_topic_a');
assert(/## 血泪案例/.test(bodyA), '## 血泪案例 section 已建');
assert(/case 1/.test(bodyA), 'body 已写入');
assert(/### \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 飞飞 · 首次血泪/.test(bodyA), '签名头格式正确 (时间·人格·理由)');
assert(useCountOf('reference_topic_a') === ucAfterSeed + 1, 'auto-touch use_count +1');

console.log('\n[2] append: section 存在 → 追加到 section 尾');
const r2 = g.append({ parent_id: 'reference_topic_a', section: '血泪案例',
  body: 'case 2', actor: '飞飞', reason: '第二例' });
assert(r2.sectionCreated === false, 'sectionCreated=false (已存在)');
const bodyA2 = bodyOf('reference_topic_a');
assert(/case 1[\s\S]*?case 2/.test(bodyA2), 'case 2 在 case 1 之后');
assert(useCountOf('reference_topic_a') === ucAfterSeed + 2, '再次 +1');

console.log('\n[3] append: 时间戳本地时区 (不带 Z)');
assert(!/Z ·/.test(bodyA2), '签名头不含 UTC Z 标记');

console.log('\n[4] append: 多个同名 section → 追加到最后一个');
// 手动加一个假的老 section 头
const bodyA3 = bodyA2 + '\n\n## 血泪案例\n(老 section 假标记)\n';
fs.writeFileSync(path.join(TEST_DIR, 'reference_topic_a.md'), bodyA3, 'utf8');
g.append({ parent_id: 'reference_topic_a', section: '血泪案例',
  body: 'case 3 (goes to last)', actor: '飞飞', reason: '第三' });
const bodyA4 = bodyOf('reference_topic_a');
// case 3 应在"老 section 假标记"之后 (最后一个 section)
const idxCase3 = bodyA4.indexOf('case 3 (goes to last)');
const idxOldMark = bodyA4.indexOf('(老 section 假标记)');
assert(idxCase3 > idxOldMark, 'case 3 追到最后一个 section');

console.log('\n[5] append: 目标节点不存在 → 抛错');
let threw = false;
try { g.append({ parent_id: 'reference_nonexistent', section: '任意', body: 'x' }); }
catch (e) { threw = true; }
assert(threw, '不存在节点抛错');

console.log('\n[6] linkBidirectional: 首次建立双向 link');
const ucB_before = useCountOf('reference_topic_b');
const r6 = g.linkBidirectional({ from_id: 'reference_topic_a', to_id: 'reference_topic_b' });
assert(r6.added.from === true, 'from→to 加了');
assert(r6.added.to === true, 'to→from 加了');
assert(/\[\[reference_topic_b\]\]/.test(bodyOf('reference_topic_a')), 'A body 里含 [[B]]');
assert(/\[\[reference_topic_a\]\]/.test(bodyOf('reference_topic_b')), 'B body 里含 [[A]]');
assert(useCountOf('reference_topic_b') === ucB_before + 1, 'B use_count +1 (双 touch)');

console.log('\n[7] linkBidirectional: 幂等 (再链一次 added 全 false)');
const r7 = g.linkBidirectional({ from_id: 'reference_topic_a', to_id: 'reference_topic_b' });
assert(r7.added.from === false && r7.added.to === false, '已存在 link 幂等 false');

console.log('\n[8] linkBidirectional: 自链抛错');
let selfThrew = false;
try { g.linkBidirectional({ from_id: 'reference_topic_a', to_id: 'reference_topic_a' }); }
catch (e) { selfThrew = true; }
assert(selfThrew, '自链抛错');

console.log('\n[9] linkBidirectional: canon (大小写/减号) 匹配');
const r9 = g.linkBidirectional({ from_id: 'Reference-Topic-A', to_id: 'Reference-Topic-B' });
assert(r9.added.from === false && r9.added.to === false, 'canon 后视为已存在, 幂等');

console.log('\n[10] linkBidirectional: 目标节点不存在 → 抛错');
let missThrew = false;
try { g.linkBidirectional({ from_id: 'reference_topic_a', to_id: 'reference_missing' }); }
catch (e) { missThrew = true; }
assert(missThrew, '目标不存在抛错');

console.log('\n[11] 清理');
fs.rmSync(TEST_DIR, { recursive: true, force: true });
assert(!fs.existsSync(TEST_DIR), '临时目录清理');

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
