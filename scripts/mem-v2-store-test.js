#!/usr/bin/env node
// mem-v2-store-test.js — memory-store-v2.js 的行为测试。
//
// 用法: node scripts/mem-v2-store-test.js
// 每次跑都在 /tmp 建全新空库, 不碰任何真实记忆库。
//
// 测的重点不是"方法能调通", 而是**几个设计承诺是否真的成立**:
//   · 改 slug 不断边(数字主键的全部意义所在)
//   · 修订历史内建在写路径上, 且只记真变了的字段
//   · pinned 与 redline 正交, 配额各算各的
//   · 向量指纹不含 body(改正文不该让全库向量作废)

const fs = require('fs');
const path = require('path');
const { MemoryStoreV2, contentHash } = require('../core/memory-store-v2');

const DIR = '/tmp/mem-v2-store-test';
fs.rmSync(DIR, { recursive: true, force: true });

const results = [];
const t = (name, fn) => {
  try { const d = fn(); results.push({ ok: true, name, detail: d || '' }); }
  catch (e) { results.push({ ok: false, name, detail: e.message }); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => assert(a === b, `${m} — 期望 ${JSON.stringify(b)}, 实得 ${JSON.stringify(a)}`);

const s = new MemoryStoreV2(DIR);

// ── 节点 ───────────────────────────────────────────────────
let idA, idB;
t('新建节点返回数字 id, 从 1 开始', () => {
  idA = s.upsertNode({
    slug: 'feedback_dev_test_before_package', title: 'dev 测试先于打包',
    claim: '命题: 改完代码必须先在 dev 环境跑通, 再打包 —— 直接打包替换会把未验证的代码送到生产',
    keywords: 'dev 测试 打包 上线 铁律', body: '2026-07-22 越权事故的产物。', type: 'feedback',
    importance: 'high', created: '2026-07-22', last_used: '2026-08-16', use_count: 9,
  }, { actor: '码上飞' });
  idB = s.upsertNode({
    slug: 'reference_pinned_is_most_used', title: 'pinned 是最常用不是最重要',
    claim: '命题: pinned 的判据是「最常查」而非「最重要」, 所以它与 importance 正交, 必须分表存',
    keywords: 'pinned 常用 重要性 正交 配额', type: 'reference',
  });
  eq(idA, 1, 'idA'); eq(idB, 2, 'idB');
  return `${idA}, ${idB}`;
});

t('claim 为空直接抛错(记忆的核心是命题)', () => {
  let threw = false;
  try { s.upsertNode({ slug: 'x_empty', title: '无命题' }); } catch (_) { threw = true; }
  assert(threw, '没有 claim 的节点被放进去了');
  return '挡住了';
});

t('按 slug 二次 upsert 走更新而非新建', () => {
  const again = s.upsertNode({
    slug: 'feedback_dev_test_before_package', title: 'dev 测试先于打包',
    claim: '命题: 改完代码必须先在 dev 环境跑通再打包, 且 dev 有独立 userData 不会污染生产',
    keywords: 'dev 测试 打包 上线 铁律', type: 'feedback', importance: 'high',
  }, { actor: '码上飞' });
  eq(again, idA, '应复用同一 id');
  eq(s.db.get('SELECT COUNT(*) AS c FROM nodes').c, 2, '节点总数不该变');
  return `复用 id=${again}`;
});

t('🔴 partial 语义: 没传的字段保持原值, 不会被静默清空', () => {
  // 2026-08-02 就是被整体覆盖语义冲掉过一个节点的正文。底层默认行为必须在安全的那一侧。
  eq(s.node(idA).title, 'dev 测试先于打包', '前置');
  s.upsertNode({ id: idA, importance: 'high' });                 // 只改一个字段
  assert(s.bodiesOf([idA]).get(idA).includes('越权事故'), 'body 被没传的更新冲掉了');
  eq(s.node(idA).keywords.includes('铁律'), true, 'keywords 被冲掉了');
  return 'body/keywords 都还在';
});

t('传空串才是真清空(留得下显式清空的口子)', () => {
  const probe = s.upsertNode({ slug: 'probe_clear', title: 'P', claim: '命题: 探针', body: '有正文' });
  s.upsertNode({ id: probe, body: '' });
  eq(s.bodiesOf([probe]).get(probe), '', '显式空串应能清空');
  s.deleteNodes([probe]);
  return '空串清空生效';
});

t('allNodes 不带 body(内存正比于节点数不是正文量)', () => {
  const n = s.allNodes();
  assert(!('body' in n[idA]), 'allNodes 把 body 带出来了 —— 这是 v1 就定死的尺度约束');
  eq(s.bodiesOf([idA]).get(idA).includes('越权事故'), true, 'bodiesOf 应能按需取到正文');
  return 'body 只在 bodiesOf 里';
});

// ── 修订历史 ────────────────────────────────────────────────
t('history 内建于写路径, 且只记真变了的字段', () => {
  const h = s.historyOf(idA);
  const fields = h.map((r) => `${r.op}:${r.field}`);
  assert(fields.includes('create:claim'), `缺建档记录: ${fields}`);
  assert(fields.includes('upsert:claim'), `claim 改了却没记: ${fields}`);
  assert(!fields.includes('upsert:importance'), `importance 没变却记了一笔: ${fields}`);
  const latest = h.find((r) => r.op === 'upsert' && r.field === 'claim');
  assert(latest.before !== latest.after && latest.before.includes('直接打包替换'), 'before 没存住旧命题');
  return fields.join(' ');
});

// ── 边 ─────────────────────────────────────────────────────
t('加边 + 同一对节点并存多种 rel', () => {
  s.addEdge(idA, idB, 'relates');
  s.addEdge(idB, idA, 'supersedes');
  eq(s.allEdges().length, 2, '边数');
  return '2 条';
});

t('🔴 改 slug 之后边一条不断(数字主键的全部意义)', () => {
  s.upsertNode({ id: idA, slug: 'feedback_ship_order_dev_first', title: 'dev 测试先于打包',
    claim: '命题: 改完代码必须先在 dev 环境跑通再打包, 且 dev 有独立 userData 不会污染生产',
    keywords: 'dev 测试 打包 上线 铁律', type: 'feedback', importance: 'high' });
  eq(s.slugOf(idA), 'feedback_ship_order_dev_first', 'slug 应已改名');
  eq(s.allEdges().length, 2, '改名后边数');
  eq(s.idOf('feedback_ship_order_dev_first'), idA, '新 slug 应能解析回同一个 id');
  eq(s.idOf('feedback_dev_test_before_package'), null, '旧 slug 不该还能解析');
  return '改名不断边';
});

t('supersedes 边可查出「谁推翻了我」(召回时的硬动作来源)', () => {
  const sup = s.supersededBy(idA);
  eq(sup.length, 1, '应有 1 个推翻者');
  assert(sup[0].claim.includes('pinned'), '推翻者的命题应能直接拿到, 不必再查一次');
  return `被 ${sup[0].slug} 推翻`;
});

t('replaceEdges 只清同来源同类型的边, 不误伤自动边', () => {
  const idC = s.upsertNode({ slug: 'ref_c', title: 'C', claim: '命题: 这是第三条测试记忆' });
  s.addEdge(idA, idC, 'relates', 'engine');          // 引擎共现自动长出来的
  s.replaceEdges(idA, [idB], 'relates', 'human');     // 手写边整体替换
  const rel = s.allEdges().filter((e) => e.src === idA && e.rel === 'relates');
  eq(rel.length, 2, '手写边与自动边应并存');
  eq(rel.filter((e) => e.made_by === 'engine').length, 1, '自动边被手写替换抹掉了');
  return '人写/自动互不覆盖';
});

// ── 扩展表 ──────────────────────────────────────────────────
t('pinned 与 redline 正交, 同一节点可兼任', () => {
  s.setPinned(idA, '最常查');
  s.setRedline(idA, { trigger_pattern: 'package|build|打包', correct_action: '先在 dev 跑通再打包', level: 'block' });
  assert(s.isPinned(idA), '应在 pinned');
  assert(s.redline(idA), '应在 redlines');
  eq(s.pinnedCount(), 1, 'pinned 配额计数');
  eq(s.allRedlines()[0].claim.includes('dev'), true, '红线应能直接带出命题');
  return 'pinned=1 redline=1 互不占额';
});

t('红线违反次数可累加', () => {
  s.bumpViolation(idA); s.bumpViolation(idA);
  eq(s.redline(idA).violations, 2, '违反次数');
  return '2 次';
});

t('同一条错误重复出现只累加 count 不刷屏', () => {
  s.logError({ node_id: idA, raw: '说多少次了，必须dev测试' });
  s.logError({ node_id: idA, raw: '说多少次了，必须dev测试' });
  s.logError({ node_id: idA, raw: '另一句' });
  const log = s.errorLog();
  eq(log.length, 2, '应合并成 2 条');
  eq(log.find((r) => r.raw.includes('多少次')).count, 2, '重复次数');
  return '2 条 / 首条 count=2';
});

// ── 向量指纹 ────────────────────────────────────────────────
t('🔴 向量指纹不含 body: 改正文不该让全库向量作废', () => {
  const before = contentHash('标题', '命题', '关键词');
  s.putVector(idA, { dim: 2, vec: [0.1, 0.2], model: 'demo', srcHash: contentHash(
    s.node(idA).title, s.node(idA).claim, s.node(idA).keywords) });
  eq(s.pendingEmbed('demo').some((r) => r.id === idA), false, '刚算完不该待补');
  // 只改正文
  const cur = s.node(idA);
  s.upsertNode({ id: idA, slug: cur.slug, title: cur.title, claim: cur.claim,
    keywords: cur.keywords, body: '正文整个换掉了'.repeat(50), type: cur.type });
  eq(s.pendingEmbed('demo').some((r) => r.id === idA), false, '改 body 触发了重算 —— 指纹里混进了正文');
  // 改命题
  s.upsertNode({ id: idA, slug: cur.slug, title: cur.title, claim: '命题: 换了个说法', keywords: cur.keywords });
  eq(s.pendingEmbed('demo').some((r) => r.id === idA), true, '改 claim 却没触发重算');
  eq(before, contentHash('标题', '命题', '关键词'), '指纹函数应稳定');
  return '改 body 不重算 · 改 claim 重算';
});

// ── 级联删除 ────────────────────────────────────────────────
t('删节点级联清干净, 但错误日志留下', () => {
  s.deleteNodes([idA]);
  eq(s.db.get('SELECT COUNT(*) AS c FROM edges WHERE src=? OR dst=?', [idA, idA]).c, 0, '残留边');
  eq(s.db.get('SELECT COUNT(*) AS c FROM pinned WHERE node_id=?', [idA]).c, 0, '残留 pinned');
  eq(s.db.get('SELECT COUNT(*) AS c FROM redlines WHERE node_id=?', [idA]).c, 0, '残留红线');
  eq(s.db.get('SELECT COUNT(*) AS c FROM vectors WHERE node_id=?', [idA]).c, 0, '残留向量');
  eq(s.errorLog().length, 2, '错误日志应保留(犯过的错不随记忆删除而消失)');
  eq(s.errorLog().every((r) => r.node_id === null), true, '应置空而非删除');
  return 'CASCADE 干净 · error_log 保留';
});

t('stats 覆盖全部 7 张业务表', () => {
  const st = s.stats();
  for (const k of ['nodes', 'edges', 'vectors', 'pinned', 'redlines', 'history', 'errors']) {
    assert(k in st, `stats 缺 ${k}`);
  }
  return Object.entries(st).filter(([k]) => k !== 'bytes').map(([k, v]) => `${k}=${v}`).join(' ');
});

// 🔴 时间字段必须是本地时区。toISOString() 是 UTC —— 本机在东京(UTC+9), 凌晨 00:00~09:00
// 之间它给出的是【昨天】, 会把 created/last_used 直接写错一天, 热度和时间线跟着错。
// 这个 bug 一天只有 9 小时窗口能被肉眼撞见, 不测等于没修。
t('时间字段用本地时区, 不是 UTC', () => {
  const { todayLocal, nowLocalISO } = require('../core/memory');
  const d = new Date();
  const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  eq(todayLocal(), localDate, 'todayLocal 应等于本机日历上的今天');

  // 造一个"UTC 与本地不同天"的时刻: 本地 00:30 时, 东半球的 UTC 还停在昨天。
  const early = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 30, 0);
  if (early.getTimezoneOffset() < 0) {
    assert(todayLocal(early) !== early.toISOString().slice(0, 10),
      'todayLocal 必须与 UTC 切法给出不同日期, 否则说明它骨子里还是 UTC');
    eq(todayLocal(early), localDate, '本地 00:30 仍该算今天');
  }
  // 完整时刻要带偏移, 不能带 Z: 带 Z 就是在声明"这是 UTC", 正是要治的病。
  const stamp = nowLocalISO(d);
  assert(/[+-]\d{2}:\d{2}$/.test(stamp), `完整时刻要带时区偏移, 实得 ${stamp}`);
  assert(!/Z$/.test(stamp), '完整时刻不许以 Z 结尾');
  eq(new Date(stamp).getTime(), Math.floor(d.getTime() / 1000) * 1000, '带偏移的串要能还原回同一个绝对时刻');

  // 真写一条, 看落库的到底是什么
  const dir2 = DIR + '-tz';
  fs.rmSync(dir2, { recursive: true, force: true });
  const s2 = new MemoryStoreV2(dir2);
  const nid = s2.upsertNode({ slug: 'tz_probe', title: '时区探针', claim: '时间字段应当是本地时区的今天。' });
  eq(s2.node(nid).created, localDate, 'created 落库应是本地日期');
  s2.setPinned(nid, '探针');
  eq(s2.pinnedMeta().get(nid).added_at, localDate, 'pinned.added_at 落库应是本地日期');
  s2.logError({ node_id: nid, raw: 'x' });
  assert(/[+-]\d{2}:\d{2}$/.test(s2.errorLog()[0].at), 'error_log.at 应带时区偏移');
  s2.close();
  return `本地 ${localDate} · ${stamp}`;
});

s.close();

const pass = results.filter((r) => r.ok).length;
console.log('');
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
