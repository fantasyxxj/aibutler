#!/usr/bin/env node
// mem-v2-ledger-test.js — 原话流水(底片) + 召回日志(尺子) 的行为测试。
//
// 用法: node scripts/mem-v2-ledger-test.js
// 每次跑都在 /tmp 建全新空库, 不碰任何真实记忆库。
//
// 测的重点不是"方法能调通", 而是这两张表的**设计承诺**:
//   · 底片一字不改、说两遍就是两条(与 error_log 的"同话累加"刻意相反)
//   · 检索自动留流水, 不用调用方记得调
//   · touch 会回填"这次召回有没有帮上忙" —— 没有回填, 尺子就是空的
//   · 记账坏掉不能影响检索本身

const fs = require('fs');
const { MemoryGraphV2 } = require('../core/memory-v2');

const DIR = '/tmp/mem-v2-ledger-test';
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

// ── 原话流水 ───────────────────────────────────────────────
t('老库自动补出新表(schema 每次开库 exec, 全是 IF NOT EXISTS)', () => {
  eq(g.utteranceCount(), 0, '空库应为 0 条');
});

t('原话一字不改落库', () => {
  const raw = '你把进程都杀了。你是白痴吗？以后不允许你做这个事情';
  g.addUtterance({ role: 'user', text: raw, source: 'ui' });
  eq(g.utterances({ limit: 1 })[0].text, raw, '原话应逐字保留');
});

t('🔴 说两遍就是两条 —— 与 error_log 的"同话累加 count"刻意相反', () => {
  const before = g.utteranceCount();
  g.addUtterance({ role: 'user', text: '一样的话', source: 'ui' });
  g.addUtterance({ role: 'user', text: '一样的话', source: 'ui' });
  eq(g.utteranceCount(), before + 2, '说第二遍本身就是信息(第一遍没被听进去), 不该被去重');
});

t('空话不落库(心跳/空回合别把流水淹掉)', () => {
  const before = g.utteranceCount();
  g.addUtterance({ role: 'user', text: '', source: 'ui' });
  eq(g.utteranceCount(), before, '空文本不该产生记录');
});

t('role 与 source 都留住 —— 不标 source 就看不出这轮为什么冒出来', () => {
  g.addUtterance({ role: 'assistant', text: '好的', source: 'reply' });
  const u = g.utterances({ limit: 1 })[0];
  eq(u.role, 'assistant', 'role'); eq(u.source, 'reply', 'source');
});

// ── 召回日志 ───────────────────────────────────────────────
const ids = [];
for (const [slug, claim, kw] of [
  ['feedback_never_kill', '命题: 不许 kill 用户开着的进程', 'kill 进程 杀'],
  ['reference_deploy_via_git', '命题: 行业版部署走 git push + 服务器脚本, 不手动 rsync', '部署 git 脚本'],
]) ids.push(g.upsert({ slug, type: slug.split('_')[0], importance: 'high', title: slug, claim, keywords: kw, body: '' }).id);

t('检索自动留流水 —— 不用调用方记得调', () => {
  const before = g.recallLog(200).length;
  g.query('kill 进程');
  assert(g.recallLog(200).length === before + 1, 'query 之后应多一条召回流水');
  const last = g.recallLog(1)[0];
  assert(last.hits > 0, `应记下命中数, 实得 ${last.hits}`);
  assert(last.top_ids.length > 0, '应记下当时给了哪几条(否则没法判有没有被 touch)');
});

t('零命中也留流水 —— "库里压根没有"是另一种失败, 要分开看', () => {
  g.query('完全不存在的主题咖啡拉花');
  const last = g.recallLog(1)[0];
  eq(last.hits, 0, '零命中');
  eq(last.used, 0, '未使用');
});

t('🔴 touch 回填"这次召回帮上忙了" —— 不回填尺子就是空的', () => {
  g.query('部署 git');
  const before = g.recallLog(1)[0];
  eq(before.used, 0, 'touch 之前 used 应为 0');
  g.touch(ids[1]);
  const after = g.recallLog(1)[0];
  eq(after.used, 1, 'touch 之后 used 应为 1');
});

t('touch 一个没被召回过的节点不会乱记功劳', () => {
  const g2 = new MemoryGraphV2('/tmp/mem-v2-ledger-test-2');
  const nid = g2.upsert({ slug: 'x_solo', type: 'reference', importance: 'low', title: 'x', claim: '命题: 孤立节点', keywords: 'x', body: '' }).id;
  g2.query('毫不相干的查询');
  g2.touch(nid);
  eq(g2.recallLog(1)[0].used, 0, '没在 top_ids 里就不该被算成"用上了"');
  g2.close();
});

t('🔴 只有主动检索进成绩单 —— auto/dedupe 混进分母会把失败率从 71% 虚报成 88%', () => {
  const before = g.recallStats();
  for (let i = 0; i < 5; i++) {
    g.query('kill 进程', { kind: 'auto' });
    g.query('部署 git', { kind: 'dedupe' });
  }
  const after = g.recallStats();
  eq(after.total, before.total, '10 次非主动检索一次都不该进分母');
  assert(g.recallLog(12).some((r) => r.kind === 'auto'), '但流水本身要留着 —— 不进成绩单不等于不记录');
  return `分母纹丝不动 total=${after.total}, 流水照留`;
});

t('dedupe 流水不占 touch 的回填窗口 —— 连沉几条记忆不该让 touch 白记', () => {
  g.query('kill 进程');
  for (let i = 0; i < 15; i++) g.query('部署 git', { kind: 'dedupe' });
  g.touch(ids[0]);
  const hit = g.recallLog(30).find((r) => r.kind === 'query' && String(r.top_ids || '').includes(String(ids[0])));
  assert(hit && hit.used > 0, '隔着 15 条查重流水, 那次主动召回仍要记上功劳');
});

t('recallStats 把两种失败分开: 零命中(补内容) vs 有结果没用上(修检索)', () => {
  const s = g.recallStats();
  assert(s.total >= 3, `应统计到至少 3 次检索, 实得 ${s.total}`);
  assert(s.empty >= 1, '应有零命中的那次');
  assert(s.unused >= 1, '应有"给了结果却没 touch"的那次');
  assert(s.used >= 1, '应有真被用上的那次');
  assert(s.failRate > 0 && s.failRate < 1, `失败率应在 0~1 之间, 实得 ${s.failRate}`);
  return `total=${s.total} 空=${s.empty} 没用上=${s.unused} 用上=${s.used} 失败率=${s.failRate}`;
});

t('🔴 记账坏掉不影响检索 —— 尺子坏了是尺子的事', () => {
  const orig = g.store.logRecall;
  g.store.logRecall = () => { throw new Error('尺子坏了'); };
  let out;
  try { out = g.query('kill 进程'); } finally { g.store.logRecall = orig; }
  assert(Array.isArray(out) && out.length > 0, '记账抛异常时检索仍要正常返回结果');
});

t('尺子进体检 —— 只写不读的度量等于没度量', () => {
  const d = g.doctor();
  assert(d.recall && typeof d.recall.failRate === 'number', 'doctor 应带召回统计');
  assert(typeof d.utterances === 'number', 'doctor 应带底片条数');
  return `失败率 ${d.recall.failRate} · 底片 ${d.utterances} 条`;
});

// ── 接线 ───────────────────────────────────────────────────
t('agent.js 真的在两侧记流水 —— 表建了没人写等于没建', () => {
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'core', 'agent.js'), 'utf8');
  assert(/this\._logUtterance\('user', text, _srcKind\)/.test(src), 'submit 侧没记用户原话');
  assert(/this\._logUtterance\('assistant', finalText, 'reply'\)/.test(src), 'result 侧没记回复');
  assert(/if \(!isHeartbeatPing\) this\._logUtterance/.test(src), '心跳应被排除在流水外');
  // 底片必须是拼时间戳之前的裸原话
  const iUtter = src.indexOf("this._logUtterance('user', text, _srcKind)");
  const iStamp = src.indexOf('const _stamped = typeof text');
  assert(iUtter > 0 && iStamp > iUtter, '🔴 记流水必须在拼时间戳/nudge 之前, 否则存进去的是加工品不是底片');
});

// ── 汇总 ───────────────────────────────────────────────────
const bad = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
console.log(`\n${results.length - bad.length}/${results.length} 通过`);
g.close();
process.exit(bad.length ? 1 : 0);
