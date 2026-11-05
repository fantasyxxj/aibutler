#!/usr/bin/env node
// mem-v2-tier-test.js — 三分档 + 分数不够就闭嘴 + 注入预算 的行为测试。
//
// 用法: node scripts/mem-v2-tier-test.js
// 每次跑都在 /tmp 建全新空库, 不碰任何真实记忆库。
//
// 测的是设计承诺, 不是"方法能调通":
//   · 把握度不含热度 —— 一条天天查的记忆, 在不相干的查询下不许显得有把握
//   · 把握度按【词段】算不按 gram 算 —— 碰巧撞上一个稀有 2-gram 不算"讲了这个话题"
//   · 低档不给(闭嘴), 但闭嘴线保守: 该给没给的代价远高于给了标不确定
//   · 空结果要能和"库里没有"区分开(filtered 记账)
//   · 预算再紧也至少给一条 —— 否则调用方会把空读成"库里没有"
//   · 查重挡门那一路不许被分档二次过滤

const fs = require('fs');
const { MemoryGraphV2, TIER_HI, TIER_MID, tierOf, estTokens,
        currentTuning, reloadTuning, TUNING_DEFAULTS } = require('../core/memory-v2');

const DIR = '/tmp/mem-v2-tier-test';
fs.rmSync(DIR, { recursive: true, force: true });

const results = [];
const t = (name, fn) => {
  try { const d = fn(); results.push({ ok: true, name, detail: d || '' }); }
  catch (e) { results.push({ ok: false, name, detail: e.message }); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => assert(a === b, `${m} — 期望 ${JSON.stringify(b)}, 实得 ${JSON.stringify(a)}`);

const g = new MemoryGraphV2(DIR);
g.actor = '码上飞';

// 造一个小库: 一条关于打包版本号的(下面反复查它), 一条毫不相干但【热度拉满】的。
const pack = g.upsert({
  slug: 'feedback_bump_version_before_repackage', title: '打包前先升版本号',
  claim: '命题: 打包前必须先 bump 版本号, 产物放项目根 dist/, 文件名必须带版本号',
  keywords: '打包 版本号 dist 产物 命名', importance: 'high', type: 'feedback',
}).id;
const hotIrrelevant = g.upsert({
  slug: 'reference_line_console_registration', title: 'LINE 控制台注册口径',
  claim: '命题: LINE 注册走账号加二维码, 不走邮箱, 因为多数人没给 LINE 设过邮箱密码',
  keywords: 'line 注册 二维码 provider', importance: 'high', type: 'reference',
}).id;
// 把不相干那条捧成全库最热: 天天用 + pinned
for (let i = 0; i < 30; i++) g.touch([hotIrrelevant]);
g.setPinned(hotIrrelevant, '测试用: 最热');
g.upsert({ slug: 'project_side_note', title: '边角料', claim: '命题: 这是一条用来占位的边角记忆',
           keywords: '边角 占位', type: 'project', exit_criteria: '测试结束' });

// ── 把握度的构成 ───────────────────────────────────────────
t('🔴 把握度不含热度 —— 最热的那条在不相干查询下不许显得有把握', () => {
  const res = g.query('打包 版本号 产物放哪', { k: 8, minTier: 'low', semantic: false });
  const packHit = res.find((r) => r.id === pack);
  const hotHit = res.find((r) => r.id === hotIrrelevant);
  assert(packHit, '该命中的没命中');
  assert(!hotHit || hotHit.confidence < packHit.confidence,
    `最热但不相干的那条把握度(${hotHit && hotHit.confidence})不该高过真正相关的(${packHit.confidence})`);
  return `相关 ${packHit.confidence} vs 最热不相关 ${hotHit ? hotHit.confidence : '未召回'}`;
});

t('🔴 热度仍然影响排序, 只是不影响把握度(两件事不能混为一谈)', () => {
  const res = g.query('打包 版本号 产物放哪', { k: 8, minTier: 'low', semantic: false });
  const packHit = res.find((r) => r.id === pack);
  assert(packHit.score > 0, 'score 仍应是含热度的综合分');
  assert(packHit.score !== packHit.confidence, 'score 与 confidence 必须是两个数, 不能是同一个');
  return `score=${packHit.score} confidence=${packHit.confidence}`;
});

t('把握度按词段算: 只撞上一个词的, 不该和讲全了的一样有把握', () => {
  const full = g.query('打包 版本号 dist 产物 命名', { k: 8, minTier: 'low', semantic: false })
    .find((r) => r.id === pack);
  const one = g.query('打包 柴犬 疫苗 房贷 睡莲', { k: 8, minTier: 'low', semantic: false })
    .find((r) => r.id === pack);
  assert(full && one, '两次都应召回到目标');
  assert(full.confidence > one.confidence * 1.5,
    `讲全了(${full.confidence})应明显高过只撞上一个词(${one.confidence})`);
  return `全覆盖 ${full.confidence} vs 单点撞上 ${one.confidence}`;
});

// ── 三分档 ────────────────────────────────────────────────
t('三档齐全且切点单调', () => {
  assert(TIER_HI > TIER_MID, '高档线必须高于闭嘴线');
  eq(tierOf(TIER_HI), 'high', '恰好等于高档线应算高档');
  eq(tierOf(TIER_MID), 'med', '恰好等于闭嘴线应算中档');
  eq(tierOf(TIER_MID - 0.001), 'low', '低于闭嘴线应算低档');
  return `高档线 ${TIER_HI} · 闭嘴线 ${TIER_MID}`;
});

t('🔴 每条结果都带 tier —— 只算不给, 分档等于白做', () => {
  const res = g.query('打包 版本号', { k: 8, minTier: 'low', semantic: false });
  assert(res.length, '应有结果');
  for (const r of res) assert(['high', 'med', 'low'].includes(r.tier), `tier 缺失或非法: ${r.tier}`);
  return `${res.length} 条全部带档: ${res.map((r) => r.tier).join(',')}`;
});

t('高档要靠证据挣, 不是靠热度挣', () => {
  const res = g.query('打包 版本号 dist 产物 命名', { k: 8, minTier: 'low', semantic: false });
  const packHit = res.find((r) => r.id === pack);
  eq(packHit.tier, 'high', '逐词命中的应进高档');
  return `把握度 ${packHit.confidence}`;
});

// ── 闭嘴 ──────────────────────────────────────────────────
t('🔴 低档不给(闭嘴), 且默认就是这个行为', () => {
  const withLow = g.query('柴犬 疫苗 打第几针', { k: 8, minTier: 'low', semantic: false });
  const dflt = g.query('柴犬 疫苗 打第几针', { k: 8, semantic: false });
  assert(dflt.length <= withLow.length, '默认档给的不该比不过滤时还多');
  for (const r of dflt) assert(r.tier !== 'low', `默认档不该放出低档条目: ${r.slug}`);
  return `不过滤 ${withLow.length} 条 → 默认档 ${dflt.length} 条`;
});

t('🔴 查不到不阻塞: 返回空数组而不是抛错', () => {
  const res = g.query('量子纠缠 贝尔不等式 实验验证 冷原子', { k: 8, semantic: false });
  assert(Array.isArray(res), '必须返回数组');
  return `${res.length} 条`;
});

t('🔴 空结果要分得出是"库里没有"还是"筛掉了" —— 否则会跑去补内容而不是松阈值', () => {
  const before = g.store.recallLog(1)[0];
  g.query('打包 版本号', { k: 8, minTier: 'high', semantic: false });
  const row = g.store.recallLog(1)[0];
  assert(row && row.id !== (before && before.id), '应新增一条召回流水');
  assert(row.filtered >= 0, 'filtered 字段必须落库');
  const st = g.recallStats();
  assert('emptyBare' in st && 'emptyFiltered' in st, '统计必须把零命中拆成两半');
  return `filtered=${row.filtered} · 零命中拆分: 真没有 ${st.emptyBare} / 筛掉了 ${st.emptyFiltered}`;
});

t('尺子记的是把握度(0~1)不是绝对分 —— 绝对分横向不可比', () => {
  g.query('打包 版本号 dist', { k: 8, semantic: false });
  const row = g.store.recallLog(1)[0];
  assert(row.top_score >= 0 && row.top_score <= 1, `top_score 应落在 0~1, 实得 ${row.top_score}`);
  return `top_score=${row.top_score}`;
});

t('minTier=low 是逃生门: 有自己判据的调用方(查重挡门)不该被二次过滤', () => {
  const strict = g.query('边角 占位', { k: 8, semantic: false });
  const loose = g.query('边角 占位', { k: 8, minTier: 'low', semantic: false });
  assert(loose.length >= strict.length, 'low 档应给得不比默认少');
  return `默认 ${strict.length} 条 / low 档 ${loose.length} 条`;
});

// ── 注入预算 ──────────────────────────────────────────────
t('token 粗估: 中文按字数算, 不按字符数除以四', () => {
  const zh = estTokens('打包前必须先升版本号');
  const en = estTokens('bump the version before packaging');
  assert(zh > 5, `中文 10 字不该估成 ${zh} 个 token`);
  assert(en > 0, '英文也要有估值');
  return `中文 10 字 → ${zh} tok · 英文 33 字符 → ${en} tok`;
});

t('🔴 预算能压住条数', () => {
  const full = g.query('打包 版本号 line 注册 边角', { k: 8, minTier: 'low', semantic: false });
  const tight = g.query('打包 版本号 line 注册 边角', { k: 8, minTier: 'low', semantic: false, budget: 30 });
  assert(tight.length < full.length, `预算 30 tok 应给得比不限时少(不限 ${full.length} → 限 ${tight.length})`);
  return `不限预算 ${full.length} 条 → 30 tok 预算 ${tight.length} 条`;
});

t('🔴 预算再紧也至少给一条 —— 空结果会被读成"库里没有"', () => {
  const res = g.query('打包 版本号 dist', { k: 8, minTier: 'low', semantic: false, budget: 1 });
  eq(res.length, 1, '预算 1 token 也该保住最有把握的那条');
  return `${res[0].slug} (把握度 ${res[0].confidence})`;
});

t('预算优先喂给最有把握的 —— 靠排序天然成立, 不需要重排', () => {
  const res = g.query('打包 版本号 dist 产物 命名', { k: 8, minTier: 'low', semantic: false, budget: 40 });
  eq(res[0].id, pack, '预算内留下的第一条应是最相关的');
  return `留下 ${res.length} 条, 首条 ${res[0].slug}`;
});

t('不传 budget 就不截断(默认行为不变)', () => {
  const a = g.query('打包 版本号 line 注册 边角', { k: 8, minTier: 'low', semantic: false });
  const b = g.query('打包 版本号 line 注册 边角', { k: 8, minTier: 'low', semantic: false, budget: 0 });
  eq(a.length, b.length, 'budget=0 应等同于不传');
  return `${a.length} 条`;
});

// ── 标定值外置(memory-tuning.json) ─────────────────────────
// 测的是"配置真的是唯一口径", 不是"文件存在"。散在代码里的魔数和配置文件并存时,
// 改了配置却没生效是不会报错的 —— 只会表现为"我明明调了啊"。
const CFG = () => JSON.parse(fs.readFileSync(`${__dirname}/../memory-tuning.json`, 'utf8'));

t('配置文件里的每个值都真的生效了 —— 不是摆设', () => {
  const cfg = CFG(), cur = currentTuning();
  const keys = Object.keys(cfg).filter((k) => !k.startsWith('_'));
  assert(keys.length, '配置文件里一个标定值都没有');
  for (const k of keys) eq(cur[k], cfg[k], `配置项 ${k} 没生效`);
  return `${keys.length} 项`;
});

t('缺文件/缺项一律回落内置默认 —— 删掉一行不该让检索炸掉', () => {
  for (const k of Object.keys(CFG())) {
    if (k.startsWith('_')) continue;
    assert(k in TUNING_DEFAULTS, `配置项 ${k} 没有内置默认, 删掉它就会变成 undefined`);
  }
  for (const [k, v] of Object.entries(TUNING_DEFAULTS)) eq(typeof v, 'number', `默认值 ${k} 必须是数字`);
  return `${Object.keys(TUNING_DEFAULTS).length} 项默认`;
});

t('🔴 结构判据不许进配置 —— 它编码的是原则, 不是松紧', () => {
  // 孤证不立(need=2)和 IDF 地板决定的是"什么算证据", 不是"给多给少"。
  // 做成可配 = 允许下游把原则关掉, 而检索会以一种没人看得出的方式退化。
  const cfg = CFG();
  for (const bad of ['idf_floor', 'need', 'lone_evidence', 'seg_need', 'min_gram_hits']) {
    assert(!(bad in cfg), `🔴 ${bad} 是结构判据, 不该出现在标定配置里`);
    assert(!(bad in TUNING_DEFAULTS), `🔴 ${bad} 是结构判据, 不该有可配默认`);
  }
  return '结构判据仍硬编码';
});

t('reloadTuning 就地生效 —— 否则每调一个数都要重启进程', () => {
  eq(typeof reloadTuning, 'function', 'reloadTuning 必须导出给标定器用');
  eq(reloadTuning().tier_mid, currentTuning().tier_mid, '重新读盘不该改变结果(配置没动)');
  return `tier_mid=${currentTuning().tier_mid}`;
});

// ── 收尾 ──────────────────────────────────────────────────
const pass = results.filter((r) => r.ok).length;
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
console.log(`\n${pass}/${results.length} 通过`);
g.close();
process.exit(pass === results.length ? 0 : 1);
