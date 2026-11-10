// test-tool-dates.js — 工具结果里的日期由程序附一行星期(core/agent/tool-dates.js), 原文不动。
// 起因: 11-08 行业版助手查预约只拿到「2026-11-11」, 星期自己算, 好几次写成「（火）」; 作者定「四道关」, 这是第 ① 道。
'use strict';
require('./host-wiring');
const { weekdayLine, annotate } = require('../core/agent/tool-dates');
const { guardEmptyArgs } = require('../core/agent/util');
const H = 'Day of the week for each date below, computed by the system — copy it, do not work it out: ';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};

console.log('\n[1] 认出日期, 配上星期, 去重');
ok('横杠与时刻', weekdayLine('id=7 at=2026-11-11T19:00 · 2026-11-14 18:30') === H + '2026-11-11 = Wed 水 周三 · 2026-11-14 = Sat 土 周六',
  weekdayLine('id=7 at=2026-11-11T19:00 · 2026-11-14 18:30'));
ok('斜杠, 补零', weekdayLine('2026/1/5') === H + '2026-01-05 = Mon 月 周一');
ok('重复只列一次', weekdayLine('2026-11-11 2026-11-11') === H + '2026-11-11 = Wed 水 周三');
ok('不存在的日期不碰', weekdayLine('2026-02-30') === '');
ok('长数字里不误认', weekdayLine('order 120261111 · tel 0312-345-6789') === '');
ok('没有日期 → 空', weekdayLine('no dates here') === '');

console.log('\n[2] 只在最前另加一段, 原文一个字不改 (11-08 dev: 附在末尾时 haiku 照样写错)');
const r = { content: [{ type: 'text', text: '[{"id":7,"at":"2026-11-11 19:00"}]' }] };
const a = annotate('biz_do', r);
ok('原段原样', a.content[1].text === r.content[0].text);
ok('最前多一段星期', a.content.length === 2 && a.content[0].text === H + '2026-11-11 = Wed 水 周三');
ok('不改入参对象', r.content.length === 1);
ok('sys 自己就报星期 → 跳过', annotate('sys', r) === r);
ok('memory_* → 跳过', annotate('memory_query', r) === r);
ok('形状不对原样返回', annotate('x', null) === null && annotate('x', { foo: 1 }).foo === 1);

console.log('\n[3] 接线: 真走 tools/call 统一出口');
(async () => {
  const handlers = new Map([['tools/call', async () => ({ content: [{ type: 'text', text: 'next booking 2026-11-14' }] })]]);
  const mcp = { instance: { server: { _requestHandlers: handlers } } };
  guardEmptyArgs(mcp, []);
  const out = await handlers.get('tools/call')({ params: { name: 'bus_exec', arguments: { q: 1 } } }, {});
  ok('出口附上星期', out.content.length === 2 && out.content[0].text === H + '2026-11-14 = Sat 土 周六', JSON.stringify(out));
  const sys = await handlers.get('tools/call')({ params: { name: 'sys', arguments: { op: 'date' } } }, {});
  ok('sys 不附', sys.content.length === 1);
  console.log(`\n${fail === 0 ? '✅' : '❌'} test-tool-dates: ${pass} pass / ${fail} fail\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
