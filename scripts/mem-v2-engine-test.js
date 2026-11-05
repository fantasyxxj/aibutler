#!/usr/bin/env node
// mem-v2-engine-test.js — memory-v2.js 引擎行为测试。
// 用法: node scripts/mem-v2-engine-test.js   (每次跑都在 /tmp 建全新空库)
//
// 验的是几条设计承诺, 不是"方法能调通":
//   · hotness 改公式后【存量 pinned 分数一分不动】—— 否则 #17 的 after 对比会被公式改动污染
//   · keywords 真的补上了数字主键抹掉的检索信号(与 slug 同档 3 分)
//   · supersedes 边在召回时有执行力(强制带出推翻者的命题), 不再是没人看的字段
//   · 检索结果带 claim —— 不带命题的返回值等于一串数字编号

const fs = require('fs');
const { MemoryGraphV2, hotnessV2, PIN_BONUS, bodyHardChars } = require('../core/memory-v2');
const { hotness } = require('../core/memory');

const DIR = '/tmp/mem-v2-engine-test';
fs.rmSync(DIR, { recursive: true, force: true });

const results = [];
const t = (name, fn) => {
  try { const d = fn(); results.push({ ok: true, name, detail: d || '' }); }
  catch (e) { results.push({ ok: false, name, detail: e.message }); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => assert(a === b, `${m} — 期望 ${JSON.stringify(b)}, 实得 ${JSON.stringify(a)}`);

const g = new MemoryGraphV2(DIR);

// ── hotness 等价性 ───────────────────────────────────────────
t('🔴 pinned+high 的分数与旧 pinned 逐分相同(after 对比不被公式污染)', () => {
  for (const [lu, uc] of [['2026-08-16', 1], ['2026-07-16', 9], ['2026-05-01', 40]]) {
    const before = hotness('pinned', lu, uc);
    const after = hotnessV2('high', lu, uc, true);
    eq(after, before, `last_used=${lu} use_count=${uc}`);
  }
  eq(PIN_BONUS, 6.0, 'PIN_BONUS');
  return '三组时间点全部逐分相同';
});

t('pinned 与重要性正交: pinned+low 高过未 pin 的 high', () => {
  const pinnedLow = hotnessV2('low', '2026-08-16', 1, true);
  const plainHigh = hotnessV2('high', '2026-08-16', 1, false);
  assert(pinnedLow > plainHigh, `pinned+low(${pinnedLow}) 应高过 high(${plainHigh})`);
  return `${pinnedLow} > ${plainHigh}`;
});

t('setImportance 挡住 pinned(它已不是重要性的一档)', () => {
  const id = g.upsert({ slug: 'ref_imp_probe', title: '探针', type: 'reference',
    claim: '命题: importance 只剩 high/med/low' }).id;
  let msg = '';
  try { g.setImportance(id, 'pinned'); } catch (e) { msg = e.message; }
  assert(msg.includes('setPinned'), `应提示改用 setPinned, 实得: ${msg}`);
  return '挡住并给了正确指引';
});

// ── 写入 ─────────────────────────────────────────────────────
let idDev, idPin;
t('upsert 新建返回数字 id, auto-touch 计数从 1 起', () => {
  const r = g.upsert({
    slug: 'feedback_dev_test_before_package', title: 'dev 测试先于打包', type: 'feedback',
    claim: '命题: 改完代码必须先在 dev 环境跑通再打包, 直接打包替换等于把未验证的代码送进生产',
    keywords: '打包 上线 出货 部署 验证', body: '2026-07-22 越权事故的产物。', importance: 'high',
  });
  idDev = r.id;
  eq(r.is_new, true, '应是新建');
  eq(r.use_count, 1, '首沉 use_count');
  return `id=${idDev}`;
});

t('新建 project 不填 exit_criteria 被挡(治僵尸项目的源头闸)', () => {
  let threw = false;
  try { g.upsert({ slug: 'project_zombie', title: '僵尸', type: 'project', claim: '命题: 这个项目没有退出条件' }); }
  catch (_) { threw = true; }
  assert(threw, '没有退出条件的 project 被放进去了');
  return '挡住了';
});

t('二次 upsert 只改命题, 正文与关键词不被静默清空', () => {
  const r = g.upsert({ slug: 'feedback_dev_test_before_package',
    claim: '命题: 改完代码必须先在 dev 环境跑通再打包, 且 dev 有独立 userData 不污染生产' });
  eq(r.id, idDev, '应复用同一 id');
  eq(r.use_count, 2, 'auto-touch 应累加');
  assert(g.store.bodiesOf([idDev]).get(idDev).includes('越权事故'), 'body 被冲掉了');
  assert(g.store.node(idDev).keywords.includes('打包'), 'keywords 被冲掉了');
  return `use_count=2, body/keywords 都在`;
});

t('二次 upsert 不传 type 不会把类型改回 project', () => {
  eq(g.store.node(idDev).type, 'feedback', '前置: 应是 feedback');
  g.upsert({ slug: 'feedback_dev_test_before_package', claim: '命题: 又改了一次命题, 但没传 type' });
  eq(g.store.node(idDev).type, 'feedback', 'type 被默认值冲回 project 了');
  return 'type 保持 feedback';
});

// ── 检索 ─────────────────────────────────────────────────────
t('🔴 keywords 补回了数字主键抹掉的信号(命中 keywords 即精确命中)', () => {
  idPin = g.upsert({ slug: 'reference_pinned_is_most_used', title: 'pinned 是最常用不是最重要',
    type: 'reference', claim: '命题: pinned 的判据是最常查而非最重要, 所以它与 importance 正交必须分表',
    keywords: '置顶 配额 正交 快查' }).id;
  // "出货" 只在 keywords 里, 标题和命题里一个字都没有
  const hits = g.query('出货', { k: 5, semantic: false });
  assert(hits.length > 0, '只写在 keywords 里的词完全召回不到 —— 补偿失败');
  eq(hits[0].id, idDev, '应命中 dev 测试那条');
  eq(hits[0].via, '直接', '应是精确命中而非兜底');
  return `top1=${hits[0].slug} via=${hits[0].via}`;
});

t('🔴 检索结果带 claim(不带命题的返回值等于一串编号)', () => {
  const hits = g.query('打包', { k: 3, semantic: false });
  assert(hits[0].claim && hits[0].claim.includes('命题'), '返回值没有 claim');
  assert('slug' in hits[0], '返回值没有 slug(人读不了数字)');
  return hits[0].claim.slice(0, 24) + '…';
});

t('slug 命中与标题命中同档(都在 3 分层)', () => {
  const hits = g.query('most_used', { k: 5, semantic: false });
  assert(hits.some((h) => h.id === idPin), 'slug 里的词召回不到');
  return '召回到了';
});

// ── supersedes 的执行力 ──────────────────────────────────────
t('🔴 召回被推翻的记忆时, 强制带出推翻者的命题', () => {
  const idOld = g.upsert({ slug: 'feedback_relay_via_butler', title: '跨人格要走管家中转',
    type: 'feedback', claim: '命题: 找别的人格要先经过管家中转, 不直接联系', keywords: '中转 人格' }).id;
  const idNew = g.upsert({ slug: 'feedback_contact_direct', title: '跨人格一律直连',
    type: 'feedback', claim: '命题: 找任何人格一律直接联系本人, 没有中转站', keywords: '直连 人格' }).id;
  g.supersede({ winner: idNew, loser: idOld, actor: '码上飞' });

  const hits = g.query('中转', { k: 5, semantic: false });
  const old = hits.find((h) => h.id === idOld);
  assert(old, '被推翻的记忆应仍能召回(追问当时为什么那么定时要用)');
  eq(old.status, 'superseded', '状态');
  assert(old.overturned_by.length === 1, '没带出推翻者');
  assert(old.overturned_by[0].claim.includes('直接联系'), `推翻者的命题应直接可读, 实得: ${JSON.stringify(old.overturned_by[0])}`);
  return `召回时附带: ${old.overturned_by[0].slug}`;
});

t('被推翻的记忆被降权但不被过滤(仍可召回)', () => {
  const hits = g.query('人格', { k: 5, semantic: false });
  const oldIdx = hits.findIndex((h) => h.status === 'superseded');
  const newIdx = hits.findIndex((h) => h.slug === 'feedback_contact_direct');
  assert(oldIdx > newIdx, `新结论应排在老结论前面 (老=${oldIdx} 新=${newIdx})`);
  return `新 #${newIdx + 1} 老 #${oldIdx + 1}`;
});

// ── pinned 配额 ──────────────────────────────────────────────
t('pinned 配额闸: 满 30 条必须让位', () => {
  g.setPinned(idDev, '最常查');
  for (let i = 0; i < 29; i++) {
    const id = g.upsert({ slug: `ref_filler_${i}`, title: `填充${i}`, type: 'reference',
      claim: `命题: 这是第 ${i} 条填充记忆` }).id;
    g.setPinned(id, '填充');
  }
  eq(g.store.pinnedCount(), 30, '应满额');
  let threw = false;
  try { g.setPinned(idPin, '想插队'); } catch (_) { threw = true; }
  assert(threw, '超配额没被挡');
  g.setPinned(idPin, '换人', { demote: idDev });
  eq(g.store.pinnedCount(), 30, '换人后仍是 30');
  assert(!g.store.isPinned(idDev), '让位那条应已降级');
  return '满额挡住 + demote 一步换人';
});

// ── append ───────────────────────────────────────────────────
t('append 建新段并带签名头', () => {
  const r = g.append({ parent_id: 'feedback_dev_test_before_package', section: '血泪案例',
    body: '2026-08-16 又差点直接打包。', actor: '码上飞', reason: '补案例' });
  eq(r.section_created, true, '应新建段');
  const b = g.store.bodiesOf([idDev]).get(idDev);
  assert(b.includes('## 血泪案例'), '段没建出来');
  assert(b.includes('· 码上飞 · 补案例'), '签名头没写上');
  assert(b.includes('越权事故'), '原正文被冲掉了');
  return '段已建 + 签名头在 + 原文保留';
});

t('append 到已有段落是插入而非覆盖', () => {
  g.append({ parent_id: 'feedback_dev_test_before_package', section: '血泪案例',
    body: '第二条案例。', actor: '码上飞', reason: '再补' });
  const b = g.store.bodiesOf([idDev]).get(idDev);
  assert(b.includes('2026-08-16 又差点直接打包。'), '第一条案例丢了');
  assert(b.includes('第二条案例。'), '第二条没写进去');
  eq((b.match(/## 血泪案例/g) || []).length, 1, '不该重复建段');
  return '两条案例并存于同一段';
});

// ── 图 ───────────────────────────────────────────────────────
t('双向连边 + neighbors 带出命题', () => {
  g.linkBidirectional({ from_id: idDev, to_id: idPin });
  const nb = g.neighbors(idDev, { hops: 1 });
  assert(nb.some((n) => n.id === idPin && n.claim.includes('pinned')), 'neighbors 没带出命题');
  return `${nb.length} 个邻居`;
});

t('改 slug 之后边和检索都不断', () => {
  g.upsert({ id: idDev, slug: 'feedback_ship_order_dev_first' });
  eq(g.store.slugOf(idDev), 'feedback_ship_order_dev_first', '改名失败');
  const nb = g.neighbors(idDev, { hops: 1 });
  assert(nb.some((n) => n.id === idPin), '改名把边弄丢了');
  const hits = g.query('出货', { k: 5, semantic: false });
  eq(hits[0].id, idDev, '改名后 keywords 检索仍应命中');
  return '边在 · 检索在';
});

// ── 矛盾 / 僵尸 ───────────────────────────────────────────────
t('撤销推翻: 删边并复原状态', () => {
  const idOld = g.store.idOf('feedback_relay_via_butler');
  const idNew = g.store.idOf('feedback_contact_direct');
  g.unsupersede({ winner: idNew, loser: idOld });
  eq(g.store.node(idOld).status, 'active', '状态应复原');
  eq(g.store.supersededBy(idOld).length, 0, '推翻边应已删');
  g.supersede({ winner: idNew, loser: idOld });          // 复位, 后面的用例还要用
  return '边已删 · 状态复原';
});

t('疑似矛盾候选带 slug 和命题(数字 id 我读不懂)', () => {
  const c = g.conflictCandidates({ max: 5 });
  assert(Array.isArray(c), '应返回数组');
  if (c.length) {
    assert(c[0].a && c[0].a.slug !== undefined, `候选没带 slug: ${JSON.stringify(c[0])}`);
    assert(c[0].a.claim !== undefined, '候选没带命题');
  }
  return `${c.length} 对候选`;
});

t('僵尸项目判定可用(复用老算法, 字段已适配)', () => {
  g.upsert({ slug: 'project_stale_one', title: '过期项目', type: 'project',
    claim: '命题: 这个项目的复核日已经过了', exit_criteria: '永远做不完', review_due: '2020-01-01' });
  const z = g.zombies();
  assert(z.some((x) => x.slug === 'project_stale_one'), `没检出过期项目: ${JSON.stringify(z)}`);
  return `${z.length} 个僵尸`;
});

// ── doctor ───────────────────────────────────────────────────
t('doctor 不再因 title≠id 而全库报错', () => {
  const d = g.doctor();
  assert(d.nodes > 30, `节点数 ${d.nodes}`);
  const mismatch = (d.problems || []).find((p) => /mismatch|title/i.test(p.kind || ''));
  assert(!mismatch, `不该再有 title/id 一致性告警: ${JSON.stringify(mismatch)}`);
  const dangling = (d.problems || []).find((p) => p.kind === '悬空边');
  assert(!dangling, '不该有悬空边(外键从源头挡住)');
  return `节点${d.nodes} 边${d.edges} pinned${d.pinned}/${d.quota}`;
});

// ── 体积闸 ────────────────────────────────────────────────────
// 阈值是扫 905 条真库量出来的(p50 27 行 / p90 57 / 最大 562)。
// 🔴 硬闸绝不能定在"理想值"25 行上 —— 那会拒掉一半的正常写入(存量 54% 超 25 行)。
t('体积闸: 常规大小照写不误(硬闸不是拿来管日常的)', () => {
  const r = g.upsert({ slug: 'size_normal', claim: '命题: 常规体量的节点', body: 'x\n'.repeat(50), type: 'reference' });
  assert(r.id, '50 行应正常写入');
  return '50 行通过';
});

t('🔴 体积闸: 超硬闸拒写, 且报错给出路(只说不行的挡门, 只会让人去想怎么绕过)', () => {
  let msg = '';
  // 用字符数造越界内容 —— 行数闸已废, 拿行数造的"巨型"正文在字符闸下可能根本不超线(假绿)。
  try { g.upsert({ slug: 'size_huge', claim: '命题: 巨型节点', body: 'x'.repeat(bodyHardChars() + 100), type: 'reference' }); }
  catch (e) { msg = e.message; }
  assert(msg, `超 ${bodyHardChars()} 字符应被拒`);
  assert(msg.includes('拆'), '报错必须给出拆分这条出路');
  assert(msg.includes('force'), '报错必须说明整批搬运怎么绕过');
  return msg.split('\n')[0];
});

t('体积闸: force=true 给迁移器和出厂包留门(整批搬运不该被治理闸拦)', () => {
  const r = g.upsert({ slug: 'size_migrated', claim: '命题: 迁移搬运进来的',
                       body: 'x'.repeat(bodyHardChars() + 100), type: 'reference', force: true });
  assert(r.id, 'force 应放行');
  return 'force 放行';
});

t('🔴 体积闸判的是写入【之后】的总量 —— 判增量等于没闸', () => {
  const limit = bodyHardChars();
  const near = 'x'.repeat(Math.floor(limit * 0.9));
  g.upsert({ slug: 'size_grow', claim: '命题: 接近上限的节点', body: near, type: 'reference' });
  const h = g.wholeBody('size_grow').hash;
  let blocked = false;
  // 增量只有上限的两成, 但写入之后的总量越界 —— 判增量的闸永远拦不住"每次只多一点点"。
  try { g.upsert({ slug: 'size_grow', body: near + 'y'.repeat(Math.ceil(limit * 0.2)), base_hash: h }); }
  catch (e) { blocked = /正文超硬闸/.test(e.message); }
  assert(blocked, '九成上限再补两成应越过硬闸被拦');
  return '写入后总量越界 → 拦下';
});

t('体检报出正文超闸的存量(写入闸只管新写的, 老肥肉靠体检发现)', () => {
  // force 灌一条超闸的进去, 模拟闸落地之前就存在的存量欠账
  g.upsert({ slug: 'size_legacy', claim: '命题: 闸落地前就有的肥节点', type: 'reference',
             body: 'x'.repeat(bodyHardChars() + 200), force: true });
  const fat = (g.doctor().problems || []).find((p) => p.kind.includes('超闸'));
  assert(fat && fat.count > 0, '应报出超闸的节点');
  // 体检要点名首要删除目标。泛泛说"太大了"的话, 人删掉的多半是操作细节而不是论证。
  assert(fat.hint && fat.hint.includes('推理链'), '体检要点名删什么, 不是笼统说太大');
  return `${fat.count} 条欠账, 最大 ${fat.sample[0]}`;
});

g.close();

const pass = results.filter((r) => r.ok).length;
console.log('');
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
