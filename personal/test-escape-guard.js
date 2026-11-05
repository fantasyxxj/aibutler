'use strict';
// 门禁: 工具入参原文里中日文写成 \uXXXX → PreToolUse 打回(core/escape-guard.js)。
// 10-20 r13: haiku 把 LINE 回信里的日文写成转义码且写错码, 客人收到「䮤事完了」。
const { hasCjkEscape, hook } = require('../core/escape-guard');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

ok(hasCjkEscape('{"text":"\\u3054\\u4e88\\u7d04"}'), '平假名/汉字的转义认得');
ok(hasCjkEscape('{"name":"\\u5c71\\u7530"}'), '「山田」两个字的转义认得');
ok(hasCjkEscape('{"t":"\\uff08"}'), '全角括号的转义认得');
ok(!hasCjkEscape('{"text":"ご予約ありがとうございます"}'), '直接写字的放行');
ok(!hasCjkEscape('{"text":"line1\\nline2 \\u00e9 \\u2014"}'), '拉丁字母/破折号的转义不算');
ok(!hasCjkEscape('{"sql":"SELECT \'\\\\u3042\'"}'), '字面的反斜杠 u(前面还有一个反斜杠)不算');

(async () => {
  const agent = { _escVerdict: new Map(), _argFrags: new Map() };
  const h = hook(agent);
  agent._escVerdict.set('t1', true);
  const r1 = await h({ tool_name: 'mcp__butler__biz_do' }, 't1');
  ok(r1.hookSpecificOutput && r1.hookSpecificOutput.permissionDecision === 'deny', '判过有转义 → 打回');
  ok(!agent._escVerdict.has('t1'), '用过就删, 不攒');
  agent._escVerdict.set('t2', false);
  const r2 = await h({ tool_name: 'x' }, 't2');
  ok(!r2.hookSpecificOutput, '判过没有 → 放行');
  // 钩子先到、分片还在收: 等 stop 那边判完
  agent._argFrags.set('t3', { raw: '' });
  setTimeout(() => agent._escVerdict.set('t3', true), 120);
  const r3 = await h({ tool_name: 'x' }, 't3');
  ok(r3.hookSpecificOutput && r3.hookSpecificOutput.permissionDecision === 'deny', '钩子先到时等判定, 不漏放');
  const t0 = Date.now();
  const r4 = await h({ tool_name: 'x' }, 'never-seen');
  ok(!r4.hookSpecificOutput && Date.now() - t0 < 600, '没见过原文的调用(子代理等)稍等即放行, 不白等 1.5 秒');

  console.log(`\n${fail ? '❌' : '✅'} test-escape-guard: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
