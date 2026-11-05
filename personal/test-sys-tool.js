// test-sys-tool.js — 系统工具 sys(core/sys-tool.js), 并且工具真注册进了两版。
// 起因: 10-13 行业版把「来週の木曜」答成 10-15(应 10-22); 作者 10-14 定做成系统工具, 按 op 分。
'use strict';
const fs = require('fs');
const path = require('path');
const { sysOp } = require('../core/sys-tool');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const now = new Date(2026, 9, 14, 7, 30);   // 2026-10-14 Wed
const has = (name, op, args, want) => { const r = sysOp(op, args, now); ok(name, r.includes(want), r); };

console.log('\n[1] date: 星期 → 日期, 周一起算');
has('来週の木曜', 'date', { weekday: '木', week: 'next' }, '2026-10-22 Thu');
has('this Thu = 明天', 'date', { weekday: 'Thu', week: 'this' }, '2026-10-15 Thu');
has('再来週の日曜', 'date', { weekday: '日曜日', week: 'after' }, '2026-11-01 Sun');
has('没给 week → 下一个, 并给再下一个', 'date', { weekday: '周三' }, '2026-10-21 Wed');
has('今天是周三, 不给 week 的周三也带出 10-28', 'date', { weekday: '周三' }, '2026-10-28 Wed');

console.log('\n[2] date: 日期 → 星期 / 偏移 / 间隔');
has('日期配星期', 'date', { date: '2026-10-18' }, '2026-10-18 Sun');
has('10 天后', 'date', { days: 10 }, '2026-10-24 Sat');
has('上周同一天', 'date', { weeks: -1 }, '2026-10-07 Wed');
has('从指定日起算', 'date', { from: '2026-12-30', days: 3 }, '2027-01-02 Sat');
has('到某天还有几天', 'date', { to: '2026-12-24' }, '71 days');
has('不存在的日期拒收', 'date', { date: '2026-02-30' }, '⚠️');

console.log('\n[3] math');
has('浮点尾巴去掉', 'math', { expr: '1000*1.1' }, '= 1100');
has('千分位与 ×', 'math', { expr: '3×1,200 + 2*800' }, '= 5200');
has('全角', 'math', { expr: '１２００÷３' }, '= 400');
has('向下取整', 'math', { expr: '4980*1.08', round: 'floor' }, 'floor 5378');
has('括号优先级', 'math', { expr: '(2+3)*4-6/2' }, '= 17');
has('不是算式就拒', 'math', { expr: 'process.exit()' }, '⚠️');
has('除以零', 'math', { expr: '5/0' }, '⚠️');

console.log('\n[4] 参数校验');
has('未知 op', 'nope', {}, 'Available: date / math');
has('未知参数', 'date', { foo: 1 }, 'Unknown args: foo');
has('缺 expr 给参数表', 'math', {}, 'Missing: expr');

console.log('\n[4b] MCP 壳: 参数平放(10-21 dev: 外层写 query= 被丢, 三次空调用后自己数错)');
(() => {
  const { mcpTool } = require('../core/sys-tool');
  const anyOpt = { optional: () => 'opt' };
  const z = { enum: (v) => ({ enum: v }), any: () => anyOpt };
  let shape, handler;
  mcpTool((name, desc, sh, fn) => { shape = sh; handler = fn; }, z, '');
  ok('date / math 的参数都在第一层', ['weekday', 'week', 'date', 'days', 'to', 'expr', 'round'].every((k) => k in shape));
  ok('不再收 args', !('args' in shape));
  return Promise.all([
    handler({ op: 'date', weekday: 'Tue', week: 'next' }).then((r) => ok('平放调用算出日期', /\d{4}-\d{2}-\d{2} Tue/.test(r.content[0].text), r.content[0].text)),
    handler({ op: 'math', expr: '2+3' }).then((r) => ok('math 平放', r.content[0].text.includes('= 5'), r.content[0].text)),
  ]);
})();
has('空调用回整张用法, 不是只回今天', 'date', {}, "weekday (+ week");

console.log('\n[5] 两版都注册 + 放行 + 说明');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
ok('mcp-tools 注册', /require\('\.\.\/sys-tool'\)\.mcpTool\(/.test(read('core/agent/mcp-tools.js')));
ok('白名单放行', read('core/agent/stream.js').includes("'mcp__butler__sys'"));
for (const f of ['core/config/tools/descriptions.json', 'industry/config/tools/descriptions.json'])
  ok(`${f} 有 sys 说明`, typeof JSON.parse(read(f)).sys === 'string');
ok('行业版没把它丢掉', !/'sys'/.test(read('industry/app/industry-agent.js')));

setImmediate(() => {   // [4b] の壳は async —— 結果が出てから数える
  console.log(`\n${fail === 0 ? '✅' : '❌'} test-sys-tool: ${pass} pass / ${fail} fail\n`);
  process.exit(fail === 0 ? 0 : 1);
});
