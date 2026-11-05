#!/usr/bin/env node
// mem-v2-forced-recall-test.js — 每轮检索审计(_auditRecall)的行为测试。
//
// 用法: node scripts/mem-v2-forced-recall-test.js
//
// 不起真流、不调模型: 把 _auditRecall 从 Agent 原型上摘下来, 绑到一个最小假宿主上跑。
// 测的是设计承诺:
//   · 一个字都不许回到上下文里 —— 这是这次改造的全部意义
//   · 但查必须真的发生, 流水必须真的落下 —— 停注入不能连尺子一起停, 否则拿一种静默换另一种
//   · 只在真人回合查(心跳/唤醒/沉淀那些 auto 轮不查)
//   · 检索坏了不许挡住对话
//   · 注入那套话术必须已经从配置里拆干净, 不留半截

require('../personal/host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const path = require('path');
const { MemoryGraphV2 } = require('../core/memory-v2');

const DIR = '/tmp/mem-v2-forced-recall-test';
fs.rmSync(DIR, { recursive: true, force: true });

const results = [];
const t = (name, fn) => {
  try { const d = fn(); results.push({ ok: true, name, detail: d || '' }); }
  catch (e) { results.push({ ok: false, name, detail: e.message }); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => assert(a === b, `${m} — 期望 ${JSON.stringify(b)}, 实得 ${JSON.stringify(a)}`);

const g = new MemoryGraphV2(DIR);
g.actor = '测试';
g.upsert({
  slug: 'feedback_never_kill_user_processes', title: '不许杀作者的进程',
  claim: '命题: 永远不 kill/pkill 作者后台跑的任何进程, 需要重启让他自己来',
  keywords: '进程 kill 杀 重启 后台', importance: 'high', type: 'feedback',
});
g.upsert({
  slug: 'feedback_bump_version_before_repackage', title: '打包前先升版本号',
  claim: '命题: 打包前必须先 bump 版本号, 产物放项目根 dist/',
  keywords: '打包 版本号 dist 产物', importance: 'high', type: 'feedback',
});

// —— 最小假宿主: 只提供 _auditRecall 真正用到的东西 ——
const { Butler } = require('../core/agent');
const auditRecall = Butler.prototype._auditRecall;
assert(typeof auditRecall === 'function', 'agent.js 的 Butler 应有 _auditRecall');

const host = (memory) => ({ name: '测试人格', memory });
const call = (h, text, kind = 'user', hb = false) => auditRecall.call(h, text, kind, hb);
const logLen = () => g.store.recallLog(200).length;

// ── 这次改造的全部意义: 什么都不许回来 ──────────────────────
t('🔴 命中了也一个字都不回上下文 —— 停注入就是这次改造的全部意义', () => {
  const h = host(g);
  const out = call(h, '我后台跑着的那些进程你别乱动啊');
  assert(!out, `不许有任何返回值当注入用, 实得: ${JSON.stringify(out)}`);
  return '返回 undefined';
});

t('🔴 用户明确否定某个东西时, 那个东西不会被端到他面前', () => {
  const h = host(g);
  // 这句会把"打包/版本号"那条以高分捞出来 —— 越是明确的拒绝, 字面匹配得越准。
  // 所以它恰恰是最不能进上下文的一类命中。
  const out = call(h, '这次不打包了, 版本号也别动');
  assert(!out, `否定句更不该有注入, 实得: ${JSON.stringify(out)}`);
  return '否定句零注入';
});

// ── 但尺子必须还在 ────────────────────────────────────────
t('🔴 查必须真的发生 · 流水必须真的落下 —— 否则是拿一种静默换另一种', () => {
  const h = host(g);
  const before = logLen();
  call(h, '我后台跑着的那些进程你别乱动啊');
  const rows = g.store.recallLog(1);
  assert(logLen() === before + 1, '应新增恰好一条流水');
  eq(rows[0].kind, 'auto', '这条流水应记成 auto(不算进主动查的成绩单)');
  assert(rows[0].hits > 0, '这一句应该真的命中了东西');
  return `hits=${rows[0].hits} top=${rows[0].top_score}`;
});

t('流水记的是原话 —— 事后要能比对「库里有而这轮没查」', () => {
  const h = host(g);
  call(h, '打包之前要不要先把版本号升上去');
  const row = g.store.recallLog(1)[0];
  eq(row.q, '打包之前要不要先把版本号升上去', '流水里应存原话');
  assert(row.top_ids && row.top_ids.length, '应记下命中了哪几条, 否则没法比对漏查');
  return `top_ids=${row.top_ids}`;
});

// ── 只在真人回合 ───────────────────────────────────────────
t('🔴 auto 回合(唤醒/沉淀/心跳)不查 —— 捞回来的是噪音, 且它们本来就不缺上下文', () => {
  const h = host(g);
  const before = logLen();
  call(h, '我后台跑着的那些进程你别乱动啊', 'auto');
  call(h, '我后台跑着的那些进程你别乱动啊', 'user', true);
  eq(logLen(), before, 'auto / 心跳 都不该留下流水');
  return 'auto / 心跳 都不查';
});

t('🔴 inbox 回合(bus/TG/LINE/人格间/Local API)照查 —— 通路不决定他动不动脑子', () => {
  const h = host(g);
  const before = logLen();
  call(h, '我后台跑着的那些进程你别乱动啊', 'inbox');
  eq(logLen(), before + 1, 'inbox 回合应照样留流水');
  return 'inbox 照查';
});

t('太短的输入不查(「好」「继续」检索出来必然是噪音)', () => {
  const h = host(g);
  const before = logLen();
  call(h, '好');
  call(h, '继续');
  eq(logLen(), before, '短输入不该触发检索, 流水上也不必留必然落空的记录');
  return '短输入直接跳过';
});

// ── 坏了不许挡路 ──────────────────────────────────────────
t('🔴 检索抛错不许挡住对话', () => {
  const broken = { query() { throw new Error('模拟引擎炸了'); } };
  const h = host(broken);
  assert(!call(h, '我后台跑着的那些进程你别乱动啊'), '引擎炸了应静默返回, 不抛');
  return '吞掉异常, 只留日志';
});

t('v1 引擎(没有这套接口)软判断跳过, 不炸', () => {
  const h = host({});
  assert(!call(h, '我后台跑着的那些进程你别乱动啊'), '没有 query 方法应直接跳过');
  return '软判断跳过';
});

t('配置里 enabled=false 能整个关掉', () => {
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'core/config/main/forced_recall.json'), 'utf8'));
  assert('enabled' in c, '必须有总开关 —— 每轮都跑的东西, 出问题要能一键停');
  return `enabled=${c.enabled}`;
});

// ── 拆干净了没 ────────────────────────────────────────────
t('🔴 注入那套话术已从配置里拆干净 —— 留着半截, 下一个人会以为还在注入', () => {
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'core/config/main/forced_recall.json'), 'utf8'));
  for (const k of ['header', 'footer', 'tier_label', 'seen_note']) {
    assert(!(k in c), `注入话术 ${k} 应该已经删掉, 现在不注入了`);
  }
  return 'header / footer / tier_label / seen_note 都已拆除';
});

t('🔴 agent.js 里不再有把召回拼进消息的路径', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'agent.js'), 'utf8');
  assert(!src.includes('_takeForcedRecall'), '旧的注入方法应已改名为 _auditRecall');
  assert(!src.includes('_recallSeen'), '"这条给过没"的去重账只有注入才需要, 应已删除');
  assert(!/\$\{_recall\}/.test(src), '拼接注入的那一步应已删除');
  return '注入路径已拆除';
});

t('尺子读数的形状不该随手改 —— k 与预算仍受约束', () => {
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'core/config/main/forced_recall.json'), 'utf8'));
  assert(c.k > 0 && c.k <= 10, `条数上限应是个小数, 实得 ${c.k}`);
  assert(c.budget_tokens > 0 && c.budget_tokens <= 2000, `预算应是个小数, 实得 ${c.budget_tokens}`);
  return `${c.k} 条 / ${c.budget_tokens} tok`;
});

const pass = results.filter((r) => r.ok).length;
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
console.log(`\n${pass}/${results.length} 通过`);
g.close();
process.exit(pass === results.length ? 0 : 1);
