#!/usr/bin/env node
// mem-v2-write-test.js — 正文整体替换 + 乐观锁 + 只许改不许加 的引擎层行为测试。
//
// 用法: node scripts/mem-v2-write-test.js
//
// 🔴 段的概念已整个撤掉 —— 原先这里测的 sections()/section()/supersedeSection() 都不存在了。
// 撤的理由不是"段没用": 段正是让一条记忆装得下多个命题的那个凭借, 只要 ## 还在,
// 正文就能合法地长出第 2、第 3 个子命题, 而记忆的单位本来就该是一个命题。
//
// 保留下来的设计承诺:
//   · 覆盖已有正文必须先读(拿 hash), 无凭据一律拒 —— 2026-08-02 的事故形状
//   · 凭据过期(读到之后被改过)也拒, 且报错要说清该怎么办
//   · write 只许改不许加: 新内容长于旧内容 → 拒, 并指向 upsert
//   · force 解乐观锁, 但【不解】体积闸, 也【不解】不许变长 —— 一个开关不能管三件事
//   · 清空要显式传空串, 不能靠不传 content 蒙混

const fs = require('fs');
const { MemoryGraphV2, bodyHardChars } = require('../core/memory-v2');

const DIR = '/tmp/mem-v2-write-test';
fs.rmSync(DIR, { recursive: true, force: true });

const results = [];
const t = (name, fn) => {
  try { const d = fn(); results.push({ ok: true, name, detail: d || '' }); }
  catch (e) { results.push({ ok: false, name, detail: e.message }); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => assert(a === b, `${m} — 期望 ${JSON.stringify(b)}, 实得 ${JSON.stringify(a)}`);
// 每个写入用例一个独立节点: write 不许变长, 共用节点会让用例之间隔着长度互相牵制。
const mk = (slug, body) => { g.upsert({ slug, claim: `命题: ${slug} 的测试节点`, type: 'reference', body }); return slug; };

const g = new MemoryGraphV2(DIR);
g.actor = '码上飞';

const LONG = '原来的做法写在这里, 这一段刻意写得长一点, 好让后面的改写都能在不变长的前提下缩短。';

// ── 先读 ─────────────────────────────────────────────────
t('wholeBody() 读得到正文并给出凭据 —— 改正文之前的"先读"就是它', () => {
  const s = g.wholeBody(mk('n_read', LONG));
  eq(s.content, LONG, '应读到原内容');
  assert(s.hash && s.hash.length >= 8, '必须给出可用的 hash');
  return `${s.content.length} 字符 hash=${s.hash}`;
});

t('正文为空的节点读出来是空, 不炸', () => {
  g.upsert({ slug: 'n_empty', claim: '命题: 空正文节点', type: 'reference' });
  eq(g.wholeBody('n_empty').content.trim(), '', '空就是空');
  return 'content=""';
});

// ── 乐观锁 ────────────────────────────────────────────────
t('🔴 覆盖已有正文必须先读 —— 无凭据直接拒(2026-08-02 事故形状)', () => {
  let msg = '';
  try { g.write({ node: mk('n_nohash', LONG), content: '新做法' }); }
  catch (e) { msg = e.message; }
  assert(msg, '无 base_hash 覆盖应被拒');
  assert(msg.includes('memory_section'), '报错要说清去哪读');
  assert(msg.includes('force'), '报错要给出无条件覆盖的出路');
  return msg.split('\n')[0];
});

t('🔴 凭据过期(读到之后被改过)也拒, 且要说清该怎么办', () => {
  let msg = '';
  try { g.write({ node: mk('n_badhash', LONG), content: '新做法', base_hash: 'deadbeef' }); }
  catch (e) { msg = e.message; }
  assert(msg, '过期凭据应被拒');
  assert(msg.includes('合并'), '报错要指出该重读并合并, 而不是简单说失败');
  // 🔴 单人库里"有第三方写入"这个前提永远为假, 报错把人推去查并发就是把人推进死路。
  assert(!/并发|别的人格/.test(msg), '报错不该预设有第三方写入');
  return msg.split('\n')[0];
});

t('带对凭据 → 整体替换(不是追加)', () => {
  const n = mk('n_replace', LONG);
  const s = g.wholeBody(n);
  g.write({ node: n, content: '新做法', base_hash: s.hash });
  const after = g.wholeBody(n);
  eq(after.content, '新做法', '应整体替换');
  assert(!after.content.includes('原来的做法'), '🔴 旧内容不该还留着 —— 那就退回成 append 了');
  return `${s.content.length} → ${after.content.length} 字符`;
});

// ── 只许改不许加 ──────────────────────────────────────────
t('🔴 write 只许改不许加: 新内容长于旧内容 → 拒, 并指向 upsert', () => {
  const n = mk('n_grow', '短正文');
  let msg = '';
  try { g.write({ node: n, content: '这是一段明显更长的内容', base_hash: g.wholeBody(n).hash }); }
  catch (e) { msg = e.message; }
  assert(msg, '变长应被拒');
  assert(msg.includes('memory_upsert'), '报错要指向 upsert —— 只说不行的挡门, 下一步只会有人想怎么绕');
  return msg.split('\n')[0];
});

t('等长放行 —— 闸判的是"变长", 不是"必须变短"', () => {
  const n = mk('n_same', 'abcdef');
  g.write({ node: n, content: 'ABCDEF', base_hash: g.wholeBody(n).hash });
  eq(g.wholeBody(n).content, 'ABCDEF', '等长应写进去');
  return '6 → 6 字符';
});

t('正文本来是空的 → write 拒绝, 首次写正文归 upsert', () => {
  let msg = '';
  try { g.write({ node: 'n_empty', content: '想用 write 开张' }); }
  catch (e) { msg = e.message; }
  assert(/首次写正文走 memory_upsert/.test(msg), `应指向 upsert, 实得: ${msg.split('\n')[0]}`);
  return msg.split('\n')[0];
});

// ── force 的边界 ──────────────────────────────────────────
t('force=true 是逃生门: 解乐观锁(整批搬运/确知要盖)', () => {
  const n = mk('n_force', LONG);
  g.write({ node: n, content: '强行盖掉', force: true });
  eq(g.wholeBody(n).content, '强行盖掉', 'force 应放行无凭据覆盖');
  return 'force 解乐观锁';
});

t('🔴 force 不解「不许变长」—— 一个开关管两件事, 迟早有人为绕前者顺手关掉后者', () => {
  let threw = false;
  try { g.write({ node: mk('n_force2', '短'), content: '用 force 也不该能把正文写长', force: true }); }
  catch (_) { threw = true; }
  assert(threw, '带 force 的变长写入仍应被拦');
  return 'force 只解乐观锁';
});

t('🔴 force 也不解体积闸', () => {
  let threw = false;
  // 先做一条超长的(走 upsert 的 force 绕体积闸), 再试着用 write 原样写回去
  g.upsert({ slug: 'n_big', claim: '命题: 超闸节点', type: 'reference',
             body: 'x'.repeat(bodyHardChars() + 500), force: true });
  try { g.write({ node: 'n_big', content: 'y'.repeat(bodyHardChars() + 400), force: true }); }
  catch (_) { threw = true; }
  assert(threw, '带 force 的超闸内容仍应被体积闸拦下');
  return `上限 ${bodyHardChars()} 字符`;
});

// ── 其余承诺 ──────────────────────────────────────────────
t('写完给回新指纹 —— 连着改两次不用重读', () => {
  const n = mk('n_chain', LONG);
  const r1 = g.write({ node: n, content: '第一版的内容', base_hash: g.wholeBody(n).hash });
  const r2 = g.write({ node: n, content: '第二版', base_hash: r1.hash });
  assert(r2.hash && r2.hash !== r1.hash, '两次的指纹应不同');
  eq(g.wholeBody(n).content, '第二版', '第二次应写进去');
  return `${r1.hash} → ${r2.hash}`;
});

t('清空要显式传空串, 不能靠不传 content 蒙混', () => {
  const n = mk('n_clear', LONG);
  let threw = false;
  try { g.write({ node: n }); } catch (_) { threw = true; }
  assert(threw, '不传 content 应报错而不是当成清空');
  g.write({ node: n, content: '', base_hash: g.wholeBody(n).hash });
  eq(g.wholeBody(n).content, '', '传空串才是真清空');
  return '不传=报错 · 空串=清空';
});

t('改正文的回执必带当前命题行 —— 正文被改了命题行不会自己跟着变', () => {
  const n = mk('n_note', LONG);
  const r = g.write({ node: n, content: '改短了', base_hash: g.wholeBody(n).hash });
  assert((r.notes || []).some((x) => /当前命题/.test(x)), '回执里应恒印当前命题');
  assert((r.notes || []).some((x) => /这句还准吗/.test(x)), '并且要追问它还准不准');
  return `${r.notes.length} 条回执`;
});

t('顺手改命题: write 传 claim 能一次调用改完', () => {
  const n = mk('n_claim', LONG);
  g.write({ node: n, content: '改短了', base_hash: g.wholeBody(n).hash, claim: '命题: 顺手改掉的新命题' });
  eq(g.store.node(g.resolve(n)).claim, '命题: 顺手改掉的新命题', '命题行应跟着改');
  return '一次调用改完';
});

t('修订历史记下了 write 这个动作(不是混进 upsert), 且记名', () => {
  const hist = g.revisions('n_replace', { limit: 30 });
  assert(hist.some((h) => h.op === 'write'), `历史里应有 write: ${JSON.stringify(hist.map((h) => h.op))}`);
  assert(hist.some((h) => h.actor === '码上飞'), '应记名');
  return `${hist.length} 条历史`;
});

const pass = results.filter((r) => r.ok).length;
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
console.log(`\n${pass}/${results.length} 通过`);
g.close();
process.exit(pass === results.length ? 0 : 1);
