// test-query-first-guard.js — 先查后办闸: 真人回合没查过记忆就动手, 打回一次。
// 跑法: node personal/test-query-first-guard.js
require('./host-wiring');
const { QueryFirstGuard } = require('../core/query-first-guard');
const { cfg } = require('../core/host');

let pass = 0; let fail = 0;
const ok = (c, l) => { if (c) { console.log(`  ✓ ${l}`); pass++; } else { console.log(`  ✗ ${l}`); fail++; } };

let kind = 'user';
const g = new QueryFirstGuard(cfg, () => kind);
const BIZ = 'mcp__butler__biz_do';

console.log('\n[1] 真人回合: 没查就动手 → 打回一次');
ok(typeof g.decide(BIZ) === 'string', '🔴 第一个办事工具被打回');
ok(g.decide(BIZ) === null, '同一回合第二次放行(只提醒一次, 不是不让干活)');

console.log('\n[2] 查过再动手 → 不拦');
g.resetTurn();
ok(g.decide('mcp__butler__memory_query') === null, 'memory_query 本身放行');
ok(g.decide(BIZ) === null, '查过之后办事工具直接放行');
g.resetTurn();
g.decide('mcp__butler__memory_section');
ok(g.decide('mcp__butler__plugin_open') === null, 'memory_section 也算查过(照点名展开的那条路)');

console.log('\n[3] 不该拦的');
g.resetTurn();
ok(g.decide('mcp__butler__memory_upsert') === null, '存记忆不拦');
ok(g.decide('Bash') === null, '不在 tool_pattern 里的工具不拦(个人版那批不受影响)');
kind = 'auto';
ok(g.decide(BIZ) === null, '🔴 auto 轮(心跳/唤醒/沉淀)不拦');
kind = 'inbox';
ok(typeof g.decide(BIZ) === 'string', 'inbox(LINE/TG 等外部来话)照样拦');

console.log('\n[4] 打回理由带出路');
g.resetTurn(); kind = 'user';
const r = g.decide(BIZ) || '';
ok(/memory_query/.test(r) && /same call again/.test(r), '理由里写了先干什么、干完怎么继续');
ok(/not from the person/.test(r), '自报家门: 不是对方说的话');
ok(r.includes(BIZ) && !r.includes('{tool}'), '理由点名被打回的那个工具');
ok(/not over/.test(r) && /same turn/.test(r), '🔴 理由写明回合没完、查完在同一回合接着做(11-08 haiku 被打回就收工)');

console.log('\n[5] hook 形状');
(async () => {
  g.resetTurn();
  const out = await g.hook()({ tool_name: BIZ, tool_input: {} });
  ok(out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision === 'deny', '打回走 permissionDecision=deny');
  const pass2 = await g.hook()({ tool_name: BIZ, tool_input: {} });
  ok(JSON.stringify(pass2) === '{}', '放行返回 {}');
  console.log(`\n${fail ? '❌' : '✅'} test-query-first-guard: ${pass} 过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
