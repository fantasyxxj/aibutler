#!/usr/bin/env node
// mem-v2-family-sat-test.js — 同族饱和抑制的行为测试。
//
// 用法: node scripts/mem-v2-family-sat-test.js
// 每次跑都在 /tmp 建全新空库, 不碰任何真实记忆库。
//
// 测的是设计承诺, 不是"方法能调通":
//   · 一族里的总论天然含话题通用词, 会在**任何**该话题的提问里霸榜, 把细分条目挤出名额
//     —— 2026-09-05 与 2026-09-13 两次实证, 加关键词、加边、加 hops 都救不回来
//   · 让位的判据是【这条命中的词全被前面占过】, 不是"看起来像一族" —— 命中了别的词就留在原位
//   · 治的是名次不是分数: 这一步的列表可能是 RRF 融合过的, 两把尺不同量纲
//   · family_sat_count = 0 要能把这套完全关掉(标定值的逃生阀)
const fs = require('fs');
const { MemoryGraphV2, reloadTuning } = require('../core/memory-v2');

const DIR = '/tmp/mem-v2-family-sat-test';
fs.rmSync(DIR, { recursive: true, force: true });

const results = [];
const t = (name, fn) => {
  try { const d = fn(); results.push({ ok: true, name, detail: d || '' }); }
  catch (e) { results.push({ ok: false, name, detail: e.message }); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

const g = new MemoryGraphV2(DIR);
g.actor = '码上飞';

// 背景语料。少了它这个测试就是假的: 五条节点的库里 IDF 极端, 任何"只有一条有"的词都拿满分,
// 于是细分条目天然就赢, 根本复现不出"总论靠通用词领先"的真实分布(真库 1300+ 条, IDF 平缓)。
for (let i = 1; i <= 12; i++) {
  g.upsert({
    slug: `reference_background_noise_${i}`, title: `背景噪声 ${i}`,
    claim: `命题: 这条是背景语料第 ${i} 条, 讲配色讲屏幕讲写法, 只为把这几个词的稀有度压下来`,
    keywords: '配色 屏幕 写法 背景 语料', type: 'reference',
  });
}
// 一族总论: 只讲"插件"这个通用词, 谁问插件都能撞上
const general = [];
for (let i = 1; i <= 4; i++) {
  general.push(g.upsert({
    slug: `reference_plugin_overview_${i}`, title: `插件总论 ${i}`,
    claim: `命题: 插件就是一块能点的屏幕, 插件的插件写法总论第 ${i} 篇`,
    keywords: '插件 屏幕 写法 写插件', importance: 'high', type: 'reference',
  }).id);
}
// 细分条目: 同样讲插件, 但多命中一个别人没有的概念(配色)
const detail = g.upsert({
  slug: 'reference_plugin_colors_pick_the_background',
  title: '插件界面配色先定背景',
  claim: '命题: 插件界面配色要先定背景色再抄表格, 否则白底白字看不见',
  keywords: '插件 配色 背景色 白底白字', importance: 'med', type: 'reference',
}).id;
// 总论天天用, 细分条目没人用 —— 热度差正是它平时挤不进来的原因之一
for (let i = 0; i < 20; i++) g.touch(general);

// minTier='low': 这里要测的是【名额怎么分】, 不是闭嘴线。不放开的话总论会先被闭嘴线滤掉,
// 候选数掉到 k 以下, 抑制根本没登场 —— 那种"绿"测的是另一条机制。
const slugsOf = (q, k) => g.query(q, { k, semantic: false, minTier: 'low' }).map((h) => h.slug);

t('🔴 同族总论霸满名额时, 命中了别的词的细分条目要进得来', () => {
  const top = slugsOf('插件 配色', 3);
  assert(top.includes('reference_plugin_colors_pick_the_background'),
    `细分条目没进 top-3: ${top.join(' / ')}`);
  return top.join(' / ');
});

t('关掉(family_sat_count=0)时退回老行为 —— 逃生阀是真的', () => {
  const before = slugsOf('插件 配色', 3);
  const dir = '/tmp/mem-v2-family-sat-tuning';
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/memory-tuning.json`, JSON.stringify({ family_sat_count: 0 }));
  const { setDataDir } = require('../core/memory-v2/tuning');
  setDataDir(dir);
  const off = slugsOf('插件 配色', 3);
  setDataDir(null);
  reloadTuning();
  const back = slugsOf('插件 配色', 3);
  assert(off.join() !== before.join(), '关掉之后顺序应该变回去(说明这套确实在起作用)');
  assert(back.join() === before.join(), '恢复标定值后顺序要回到抑制生效的样子');
  return `关: ${off[0]} / 开: ${before[0]}`;
});

t('候选本来就不够 k 条时一律不动 —— 没有名额之争就没有抑制的必要', () => {
  const all = slugsOf('插件', 50);
  const few = slugsOf('插件', 50);
  assert(all.join() === few.join(), '同一次查询两次结果不一致');
  // k 大于候选数 → 全都出得来, 顺序应当仍是按分数下来的
  const scores = g.query('插件', { k: 50, semantic: false }).map((h) => h.score);
  const sorted = [...scores].sort((a, b) => b - a);
  assert(scores.join() === sorted.join(), `名额够时不该重排: ${scores.join(' ')}`);
  return `${all.length} 条, 分数单调`;
});

t('只讲同一件事的一族, 内部谁在前谁在后不该被抑制搞乱(留一条在原位)', () => {
  const top = slugsOf('插件', 3);
  assert(top.some((s) => s.startsWith('reference_plugin_overview_')),
    `总论被整族赶走了, 抑制过头: ${top.join(' / ')}`);
  return top.join(' / ');
});

let pass = 0, fail = 0;
for (const r of results) {
  if (r.ok) { pass++; console.log(`✅ ${r.name}${r.detail ? '  — ' + r.detail : ''}`); }
  else { fail++; console.log(`❌ ${r.name} — ${r.detail}`); }
}
console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
