#!/usr/bin/env node
// redline-guard-test.js — 红线动作侧守卫的行为测试 + 接线检查。
//
// 用法: node scripts/redline-guard-test.js
// 每次跑都在 /tmp 建全新空库, 不碰任何真实记忆库。
//
// 测的重点:
//   · decide() 能脱开 SDK 判对(挂上 SDK 才能测的东西等于测不了)
//   · 打回的同时记账真的落进了库(否则就是"报告成功其实没写")
//   · 打回到顶放行, 且放行那次进错误日志
//   · 守卫坏了不挡工具(记忆坏了是我们的问题, 不该让用户干不了活)
//   · hook 真挂进了 agent.js 的 options —— 闸装了但没接线等于没装

const fs = require('fs');
const { MemoryGraphV2 } = require('../core/memory-v2');
const { RedlineGuard, parseTrigger, matchRedlines } = require('../core/redline-guard');

const DIR = '/tmp/redline-guard-test';
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
const quiet = () => {};

g.upsert({
  slug: 'feedback_never_kill_user_processes', type: 'feedback', importance: 'high',
  title: '不许杀用户进程',
  claim: '命题: 不许 kill 用户的进程 —— 2026-07-27 杀掉作者开着的进程后被红脸',
  keywords: 'kill 进程 pkill', body: '现场原话: 你把进程都杀了。你是白痴吗？',
});
g.setRedline('feedback_never_kill_user_processes', {
  trigger_pattern: 'Bash:\\b(kill|pkill|killall)\\b',
  correct_action: '先问用户。要看进程用 ps/lsof, 别动它。',
  level: 'block',
});

// ── 触发模式解析 ───────────────────────────────────────────
t('trigger 只在第一个冒号处切(正则里可以有冒号)', () => {
  const p = parseTrigger('Bash:https?://');
  assert(p.tools.has('Bash'), '工具名解析错');
  assert(p.re.test('curl https://x'), '正则被冒号截断了');
});
t('* 表示任意工具', () => assert(parseTrigger('*:secret').tools === null, '* 应解析成不限工具'));
t('正则写坏返回 null 而不是抛 —— 一条坏正则不该让整张表失效', () => {
  eq(parseTrigger('Bash:[unclosed'), null, '坏正则应返回 null');
  eq(matchRedlines([{ trigger_pattern: 'Bash:[unclosed' }], 'Bash', { command: 'x' }).length, 0, '坏正则应被跳过');
});
t('没写 trigger_pattern 的红线不进动作侧(它走输出侧)', () => {
  eq(matchRedlines([{ trigger_pattern: '' }], 'Bash', { command: 'kill 1' }).length, 0, '空模式不该匹配');
});

// ── 判定 ───────────────────────────────────────────────────
const guard = new RedlineGuard(g, { log: quiet });
t('v2 引擎上守卫是开的', () => assert(guard.enabled, 'enabled 应为 true'));
t('v1 引擎(没有铁律表)上守卫自动关掉, 且一律放行', () => {
  const g1 = new RedlineGuard({}, { log: quiet });
  assert(!g1.enabled, 'v1 上 enabled 应为 false');
  eq(g1.decide('Bash', { command: 'kill -9 1' }), null, 'v1 上应放行');
});

t('撞红线 → 打回, 理由里带上正确做法', () => {
  const v = guard.decide('Bash', { command: 'kill -9 42317' });
  assert(v, '应该被拦下');
  assert(/不许杀用户进程/.test(v.reason), '理由里应有红线标题');
  assert(/先问用户/.test(v.reason), '🔴 理由里必须有正确做法 —— 只说"不许"等于让它瞎试');
});
t('工具名不匹配就不拦(同一条正则不该误伤 Write)', () =>
  eq(guard.decide('Write', { file_path: '/tmp/kill.md' }), null, 'Write 不该被 Bash 红线拦'));

// ── warn 与 block 是两档, 不是一档 ─────────────────────────
// 2026-08-28: level 一直没人读, 命中就硬拒 —— warn 这档事实上不存在。三个人格共撞了 34 次,
// 每次都只能绕路, 没人报过。所以这里守的不是"少拦一次", 是"轻的那档必须真的轻"。
g.upsert({
  slug: 'feedback_soft_rule', type: 'feedback', importance: 'med',
  title: '软规矩', claim: '命题: 这条只提醒不拦', keywords: 'soft',
});
g.setRedline('feedback_soft_rule', {
  trigger_pattern: 'Write:\\.tmp"', correct_action: '换个正经后缀', level: 'warn',
});
t('🔴 warn 只提醒不拦 —— 拦是 block 的语义', () => {
  const v = new RedlineGuard(g, { log: quiet }).decide('Write', { file_path: '/tmp/a.tmp' });
  assert(v, 'warn 也该有返回(要把话带到)');
  eq(v.level, 'warn', 'level 应原样带出');
  assert(!/撞到红线/.test(v.reason), 'warn 没拦人却说"撞到红线", 读的人会以为动作没发出去');
  assert(/换个正经后缀/.test(v.reason), '提醒里必须有正确做法');
});
t('block 的返回也标了 level(两档要能分辨)', () =>
  eq(new RedlineGuard(g, { log: quiet }).decide('Bash', { command: 'kill -9 1' }).level, 'block', 'block 应标 level'));
t('同一条 warn 一轮内只提醒一次(每次都刷等于噪音)', () => {
  const gw = new RedlineGuard(g, { log: quiet });
  assert(gw.decide('Write', { file_path: '/tmp/a.tmp' }), '第一次该提醒');
  eq(gw.decide('Write', { file_path: '/tmp/b.tmp' }), null, '同轮第二次不该再提醒');
  gw.resetTurn();
  assert(gw.decide('Write', { file_path: '/tmp/c.tmp' }), 'resetTurn 后该能再提醒');
});
t('warn 命中也要记账 —— 不落库就等于没发生过', () => {
  const before = g.redlines().find((x) => x.slug === 'feedback_soft_rule').violations;
  new RedlineGuard(g, { log: quiet }).decide('Write', { file_path: '/tmp/d.tmp' });
  const after = g.redlines().find((x) => x.slug === 'feedback_soft_rule').violations;
  assert(after > before, `warn 也该计数, ${before} → ${after}`);
});
t('没撞红线的普通命令放行', () =>
  eq(guard.decide('Bash', { command: 'ls -la' }), null, '普通命令应放行'));

// ── 记账真的落库(守卫是软判断调的, 不落库就静默丢账) ───────
t('打回同时 violations 计数进了库', () => {
  const r = g.redlines().find((x) => x.slug === 'feedback_never_kill_user_processes');
  assert(r.violations >= 1, `violations 应 ≥1, 实得 ${r.violations}`);
});
t('打回同时错误日志进了库, 且原话可回溯', () => {
  const logs = g.errorLog(10);
  assert(logs.length >= 1, '错误日志应有记录');
  assert(/kill -9 42317/.test(logs[0].raw), `日志里应留有现场原话, 实得: ${logs[0].raw}`);
});

// ── 打回上限 ───────────────────────────────────────────────
t('同一动作打回到顶后放行, 且放行那次也进错误日志', () => {
  const gd = new RedlineGuard(g, { maxBlocks: 2, log: quiet });
  const input = { command: 'pkill -f butler' };
  assert(gd.decide('Bash', input), '第 1 次应打回');
  assert(gd.decide('Bash', input), '第 2 次应打回');
  eq(gd.decide('Bash', input), null, '第 3 次应放行(防无限打回烧 token)');
  const logs = g.errorLog(20);
  assert(logs.some((l) => /仍未纠正, 已放行/.test(l.raw)), '🔴 放行那次必须留痕, 它比被拦下的两次更该被看见');
});
t('resetTurn 后重新计数(上限是"这一轮", 不是"一辈子")', () => {
  const gd = new RedlineGuard(g, { maxBlocks: 1, log: quiet });
  const input = { command: 'killall node' };
  assert(gd.decide('Bash', input), '第 1 次应打回');
  eq(gd.decide('Bash', input), null, '同轮第 2 次到顶放行');
  gd.resetTurn();
  assert(gd.decide('Bash', input), '新一轮应重新打回');
});

// ── 输出侧 ─────────────────────────────────────────────────
g.upsert({
  slug: 'feedback_deliver_file_must_show_clickable_path', type: 'feedback', importance: 'high',
  title: '给文件必须贴可点的绝对路径',
  claim: '命题: 产出/修改文件后必须贴裸绝对路径, 只报文件名用户没法点开',
  keywords: '文件 路径', body: '2026-08-01 作者提。',
});
g.setRedline('feedback_deliver_file_must_show_clickable_path', {
  trigger_pattern: 'output:我是 Claude',
  correct_action: '自称码上飞。', level: 'block',
});

const og = new RedlineGuard(g, { maxBlocks: 2, log: quiet });
t('输出侧命中 → 打回, 话术是"重说"不是"动作被拦"', () => {
  const v = og.decideOutput('你好, 我是 Claude, 有什么可以帮你的');
  assert(v, '应该被打回');
  assert(/重说一遍/.test(v.reason), '输出侧话术应是重说');
  assert(/自称码上飞/.test(v.reason), '理由里应有正确做法');
});
t('输出侧干净文本放行', () => eq(og.decideOutput('你好, 我是码上飞'), null, '干净文本应放行'));
t('空文本放行(空回合归 empty-turn 管, 不该在这儿报红线)', () =>
  eq(og.decideOutput('   '), null, '空文本应放行'));
t('🔴 动作侧红线不会被输出侧吃掉(反之亦然)', () => {
  eq(og.decideOutput('我要 kill 掉那个进程'), null, 'Bash: 开头的红线不该过输出侧');
  eq(og.decide('Bash', { command: 'echo 我是 Claude' }), null, 'output: 开头的红线不该过动作侧');
});
t('输出侧计数按红线记而不按文本记 —— 否则换个说法就永远打不满', () => {
  const gd = new RedlineGuard(g, { maxBlocks: 2, log: quiet });
  assert(gd.decideOutput('我是 Claude 啊'), '第 1 次应打回');
  assert(gd.decideOutput('其实我是 Claude, 换个说法'), '第 2 次应打回(不同文本)');
  eq(gd.decideOutput('好吧我是 Claude'), null, '第 3 次应放行 —— 按红线记数才会到顶');
});
t('输出侧打回也留痕(违规计数 + 错误日志)', () => {
  const r = g.redlines().find((x) => x.slug === 'feedback_deliver_file_must_show_clickable_path');
  assert(r.violations >= 1, `violations 应 ≥1, 实得 ${r.violations}`);
  assert(g.errorLog(30).some((l) => /我是 Claude/.test(l.raw)), '错误日志里应留有原话');
});

// ── 失败方式 ───────────────────────────────────────────────
t('读铁律表炸了 → 放行, 不挡工具', () => {
  const broken = { redlines() { throw new Error('库坏了'); } };
  eq(new RedlineGuard(broken, { log: quiet }).decide('Bash', { command: 'kill 1' }), null, '守卫坏了应放行');
});

// ── SDK 形状 + 接线 ────────────────────────────────────────
(async () => {
  const hook = new RedlineGuard(g, { log: quiet }).hook();
  const deny = await hook({ tool_name: 'Bash', tool_input: { command: 'kill 1' } });
  t('hook 命中 → permissionDecision=deny + hookEventName=PreToolUse', () => {
    eq(deny.hookSpecificOutput.permissionDecision, 'deny', 'permissionDecision');
    eq(deny.hookSpecificOutput.hookEventName, 'PreToolUse', 'hookEventName');
  });
  const pass = await hook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
  t('hook 放行 → 返回 {} 交回正常权限流程', () => eq(Object.keys(pass).length, 0, '放行应返回空对象'));

  const warned = await new RedlineGuard(g, { log: quiet }).hook()(
    { tool_name: 'Write', tool_input: { file_path: '/tmp/x.tmp' } });
  t('🔴 warn 走 additionalContext 放行, 不给 permissionDecision', () => {
    const o = warned.hookSpecificOutput || {};
    assert(!o.permissionDecision, 'warn 给了 permissionDecision 就是在拦, 那 warn 和 block 又没区别了');
    assert(o.additionalContext, 'warn 该把正确做法顺路带上(放行不等于不吭声)');
    eq(o.hookEventName, 'PreToolUse', 'hookEventName');
  });

  t('hook 真挂进了大脑的 options —— 装了没接线等于没装', () => {
    // core 抽取之后接线散在三处: 组装在 agent/stream.js, 输出侧在 agent/consume.js,
    // 壳还在 agent.js。所以拼起来查, 别锁死在某一个文件上(锁死正是这条断言恒红的原因)。
    const P = require('path');
    const src = ['agent.js', 'agent/stream.js', 'agent/consume.js']
      .map((f) => fs.readFileSync(P.join(__dirname, '..', 'core', f), 'utf8')).join('\n');
    // 4.2 之后 PreToolUse 上挂着两个守卫, 接线从字面量变成拼数组。断言跟着改成
    // "有 PreToolUse 这个口子 + 红线的 hook() 被推进去了", 别再锁死一种写法。
    assert(/hooks:\s*\{\s*PreToolUse:/.test(src), 'options 里没找到 hooks.PreToolUse');
    assert(/pre\.push\(this\.redlineGuard\.hook\(\)\)|\[this\.redlineGuard\.hook\(\)\]/.test(src),
      'PreToolUse 上没挂 redlineGuard.hook()');
    assert(/pre\.push\(this\.indexGuard\.hook\(\)\)|this\.indexGuard\.hook\(\)/.test(src),
      'PreToolUse 上没挂 indexGuard.hook() —— 4.2 装了没接线等于没装');
    assert(/this\.redlineGuard\.resetTurn\(\)/.test(src), 'submit 里没调 resetTurn → 打回上限会跨轮累积');
    assert(/this\.indexGuard\.resetTurn\(\)/.test(src), 'submit 里没清 indexGuard → 索引提示一辈子只提一次');
    assert(/this\.redlineGuard\.decideOutput\(finalText\)/.test(src), 'result 分支没接输出侧');
    assert(/if \(!opts\._redlineRetry\) this\._redlineRetried = false;/.test(src),
      'submit 里没清 _redlineRetried → 第二轮起输出侧就永远不打回了');
  });

  t('输出侧打回话术走配置文件, 没硬编码在 js 里', () => {
    const p = require('path').join(__dirname, '..', 'core', 'config', 'main', 'redline_output.json');
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert(c.template.includes('{reason}'), 'template 里要有 {reason} 占位');
    assert(typeof c.enabled === 'boolean', '要有 enabled 一键关 —— 行为类改动判错一次就硬卡对话');
  });

  t('引擎转出了守卫要的三个方法(软判断调的, 少一个就静默丢账)', () => {
    for (const m of ['redlines', 'noteViolation', 'logError']) {
      assert(typeof g[m] === 'function', `MemoryGraphV2 缺 ${m}()`);
    }
  });

  // ── 汇总 ─────────────────────────────────────────────────
  const bad = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\n${results.length - bad.length}/${results.length} 通过`);
  g.close();
  process.exit(bad.length ? 1 : 0);
})();
