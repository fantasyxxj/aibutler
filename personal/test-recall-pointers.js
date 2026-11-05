#!/usr/bin/env node
// test-recall-pointers.js — 常驻教材里每句 memory_query "..." 都是一条承诺: 照它查就能查到东西。
//
// 用法: node test-recall-pointers.js
// 每次跑都在 /tmp 建全新空库, 灌进出厂知识包, 不碰任何真实记忆库。
//
// 为什么要有这一层(2026-08-20 实撞):
//   presentation.md 教「memory_query "画图 svg 可点 动画"」, 但真按这句查, 讲动画怎么写的那条
//   进不了 top-K —— 被几条同族的开发史(消毒器 bug 修复记录)挤掉了。于是 AI 查了一遍发现没有,
//   转头去翻源码。整个过程**完全静默**: 没有报错, 库里也确实有那条知识, 只是拿不到。
//
//   指路词是写的时候看着合理, 然后随着库长大慢慢失效的。这正是门禁该守的形状。

const fs = require('fs');
const path = require('path');
const { MemoryGraphV2 } = require('../core/memory-v2');

const DIR = '/tmp/test-recall-pointers';
fs.rmSync(DIR, { recursive: true, force: true });

let pass = 0; const fails = [];
const ok = (c, m, detail = '') => {
  if (c) { pass++; console.log(`  ✓ ${m}`); }
  else { fails.push(m); console.log(`  ✗ ${m}${detail ? `\n      ${detail}` : ''}`); }
};

// —— 灌出厂知识包(AI 装完机手里就是这批) ——
const pack = JSON.parse(fs.readFileSync(path.join(__dirname, '../core/config/onboarding/knowledge/leaf_core.json'), 'utf8'));
const g = new MemoryGraphV2(DIR);
g.actor = 'gate';
for (const it of pack.items) {
  // force: 与 factory-sync 的真实灌入路径口径一致 —— 出厂包整批搬运不吃体积闸。
  // 不给的话这里会因为包里几条超闸的存量欠账整个崩掉, 而这个门禁要验的是【指路词捞不捞得到】,
  // 不是包的体积(那个由 test-onboarding 的存量豁免名单守着)。
  g.upsert({ slug: it.slug, title: it.title || it.slug, type: it.type || 'reference',
    importance: it.importance || 'med', claim: it.claim || it.slug,
    keywords: it.keywords || '', body: it.body || '', force: true });
}
console.log(`[灌入] 出厂条目 ${pack.items.length} 条 (pack v${pack.version})\n`);

// —— 每句指路词, 期望它能捞到哪一族 ——
// slug 正则 = 这一族的核心知识。指路词至少要在 top-K 里带出 min 条来, 否则等于指了个空地方。
const K = 8;
const POINTERS = [
  { q: 'chart table flowchart comparison file path', fam: /table|chart|formula|math|mermaid|path|absolute/i, min: 2 },
  { q: 'form widget input dropdown slider button', fam: /widget|button|form|slider|input/i, min: 3 },
  { q: 'svg color fill stroke animate clickable', fam: /svg/i, min: 3 },
];

// 常驻教材里写的指路词必须和这张表对得上 —— 改了教材忘了改门禁, 等于门禁在守一句已经不存在的话。
console.log('[1] 教材里的指路词与本门禁同步');
const resident = fs.readFileSync(path.join(__dirname, '../core/config/prompts/presentation.md'), 'utf8');
const inDoc = [...resident.matchAll(/memory_query\s+"([^"]+)"/g)].map((m) => m[1]);
ok(inDoc.length === POINTERS.length,
  `presentation.md 里有 ${POINTERS.length} 句指路词`, `实得 ${inDoc.length} 句: ${inDoc.join(' / ')}`);
for (const p of POINTERS) {
  ok(inDoc.includes(p.q), `"${p.q}" 确实写在教材里`,
    inDoc.length ? `教材现有: ${inDoc.join(' / ')}` : '教材里一句都没找到');
}

console.log('\n[2] 照着指路词查, 真能查到那一族');
for (const p of POINTERS) {
  const hits = g.query(p.q, { k: K, semantic: false, minTier: 'low' }) || [];
  const fam = hits.filter((h) => p.fam.test(h.slug));
  ok(fam.length >= p.min,
    `"${p.q}" → top-${K} 里有 ${p.min}+ 条同族 (实得 ${fam.length})`,
    `捞到的是: ${hits.map((h) => h.slug).join(', ') || '(空)'}`);
}

// 指路词的意义在于"不用想也能查到该查的东西"。第一条就跑偏, 说明这句词的信号是散的。
console.log('\n[3] 第一条就得是同族 —— 排在后面等于要 AI 自己挑');
for (const p of POINTERS) {
  const hits = g.query(p.q, { k: K, semantic: false, minTier: 'low' }) || [];
  ok(hits.length > 0 && p.fam.test(hits[0].slug),
    `"${p.q}" 的 top-1 是同族`, `top-1 实为: ${hits[0] ? hits[0].slug : '(空)'}`);
}

g.close();
fs.rmSync(DIR, { recursive: true, force: true });

console.log(`\n${fails.length ? '💥' : '✅'} test-recall-pointers: ${pass} 过 / ${fails.length} 败`);
if (fails.length) fails.forEach((f) => console.log(`   - ${f}`));
// 必须显式退出: sqlite-wasm 一直吊着事件循环, 全绿时不退 = 批量跑门禁时这条永远卡到超时被杀,
// 而它自己明明是 10 过 0 败 —— 表现成"红", 排查方向全错。
process.exit(fails.length ? 1 : 0);
