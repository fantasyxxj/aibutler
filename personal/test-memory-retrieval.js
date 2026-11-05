// test-memory-retrieval.js — 检索改进门禁 (§6.3 body 纳入 + 别名表)
// 跑法: node test-memory-retrieval.js
// 覆盖: body 命中权重不压过 title · 别名表归一 · 同义词不虚高 · 兜底不当扩散种子
//       · 🔴 排序不倒退(精确命中者的分数与改动前逐分相同)

require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const path = require('path');
const os = require('os');
const { MemoryGraph } = require('../core/memory.js');

const TEST_DIR = path.join(os.tmpdir(), 'butler-mem-ret-' + Date.now());
fs.mkdirSync(TEST_DIR, { recursive: true });

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}`); fail++; }
};
const eq = (a, b, label) => ok(a === b, `${label} (got ${a}, want ${b})`);

const g = new MemoryGraph(TEST_DIR);

console.log('\n[1] body 纳入检索(改动前正文内容根本搜不到)');
g.upsert({ id: 'reference_title_hit', type: 'reference', title: '打包流程', description: '无关描述', body: '无关正文' });
g.upsert({ id: 'reference_desc_hit', type: 'reference', title: '甲乙丙', description: '讲打包的描述', body: '无关正文' });
g.upsert({ id: 'reference_body_hit', type: 'reference', title: '丁戊己', description: '无关描述', body: '正文里提到打包这件事' });
let r = g.query('打包', { flat: true });
eq(r.length, 3, '三条都召回');
eq(r[0].id, 'reference_title_hit', 'title 命中排第一');
eq(r[r.length - 1].id, 'reference_body_hit', 'body 命中排最后 —— 权重不压过 title/description');

console.log('\n[2] 别名表归一: 换个说法也搜得到');
r = g.query('构建', { flat: true });
ok(r.length >= 1, `查「构建」能召回写「打包」的节点 (${r.length} 条)`);
r = g.query('electron-builder', { flat: true });
ok(r.length >= 1, '查工具名也能召回');

console.log('\n[3] 堆同义词拿不到额外分(一组只计一次)');
g.upsert({ id: 'reference_many_syn', type: 'reference', title: '打包 构建 出货 发布 上线', description: 'x', body: 'y' });
g.upsert({ id: 'reference_one_word', type: 'reference', title: '打包', description: 'x', body: 'y' });
r = g.query('打包', { flat: true });
const many = r.find((x) => x.id === 'reference_many_syn');
const one = r.find((x) => x.id === 'reference_one_word');
ok(Math.abs(many.score - one.score) < 0.1, `堆 5 个同义词 vs 1 个词 得分相同 (${many.score} vs ${one.score})`);

console.log('\n[4] 🔴 排序不倒退: 精确命中者的分数不受兜底层影响');
// 造一个"title 精确命中 + 正文也含关键词"的节点。若兜底分错误地加给它, 分数就会比纯 title 命中的高。
g.upsert({ id: 'reference_exact_only', type: 'reference', title: '部署手册', description: 'q', body: '无关' });
g.upsert({ id: 'reference_exact_and_body', type: 'reference', title: '部署指南', description: 'q', body: '正文里也写了部署两个字' });
r = g.query('部署', { flat: true });
const a = r.find((x) => x.id === 'reference_exact_only');
const b = r.find((x) => x.id === 'reference_exact_and_body');
ok(Math.abs(a.score - b.score) < 0.1,
  `精确命中者不因"正文恰好也提了一嘴"而多拿分 (${a.score} vs ${b.score}) —— 这条挂掉就会搅乱既有排序`);

console.log('\n[5] 兜底命中不当扩散种子(弱信号不能当传播源)');
// body-only 命中的节点若当种子, 会把能量灌给它所有邻居, 把真正相关的冲掉。
g.upsert({ id: 'reference_hub_a', type: 'reference', title: '中枢A', description: 'z', body: '[[reference_hub_b]] [[reference_hub_c]] 顺带提一句部署' });
g.upsert({ id: 'reference_hub_b', type: 'reference', title: '邻居B', description: 'z', body: 'z' });
g.upsert({ id: 'reference_hub_c', type: 'reference', title: '邻居C', description: 'z', body: 'z' });
const spread = g.query('部署', { k: 20 });
ok(!spread.some((x) => x.id === 'reference_hub_b' || x.id === 'reference_hub_c'),
  '纯正文命中的节点没把能量扩散给邻居(邻居 B/C 未被捞进来)');

console.log('\n[6] 兜底只在精确命中不足 k 条时补位');
const few = g.query('部署', { k: 20, flat: true });
const fb = few.filter((x) => x.via && x.via.includes('兜底'));
ok(few.length >= 2, `精确命中 ${few.length - fb.length} 条 + 兜底补 ${fb.length} 条`);
const exactCount = few.filter((x) => !x.via.includes('兜底')).length;
ok(few.slice(0, exactCount).every((x) => !x.via.includes('兜底')), '兜底补位的一律排在精确命中之后');

console.log('\n[7] 别名表格式合法(坏了只退化不炸)');
const aliasPath = path.join(__dirname, '..', 'core', 'config', 'main', 'memory_aliases.json');
ok(fs.existsSync(aliasPath), '别名表文件存在');
const raw = JSON.parse(fs.readFileSync(aliasPath, 'utf8'));
ok(Array.isArray(raw.groups) && raw.groups.length > 0, `别名表有 ${raw.groups.length} 组`);
ok(raw.groups.every((gr) => Array.isArray(gr) && gr.length >= 2), '每组至少 2 个词');
const flatWords = raw.groups.flat();
ok(flatWords.length === new Set(flatWords).size, '同一个词没有出现在多个组里(否则归一结果不确定)');

console.log(`\n结果: ${pass} pass, ${fail} fail`);
try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
