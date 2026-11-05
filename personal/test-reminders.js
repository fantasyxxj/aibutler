// test-reminders.js — 提醒登记簿(core/reminders.js) + 巡检接线(idle-watcher.runDueSchedules) + task 拒收 due。
// 跑法: node personal/test-reminders.js   只用 tmp 目录, 不碰活体人格。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const R = require('../core/reminders');
const { createIdleWatcher } = require('../core/idle-watcher');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label + (extra ? `\n      ${extra}` : '')); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'butler-rem-'));
const NOW = new Date(2026, 9, 10, 16, 30);   // 2026-10-10 16:30 本地
const book = (dir) => JSON.parse(fs.readFileSync(path.join(dir, R.FILE), 'utf8'));

console.log('\n[1] add 校验');
{
  const d = tmp();
  let r = R.reminderOp(d, 'create', { text: 'x', due: '2026-11-15' }, NOW);
  ok(/Unknown args: due/.test(r) && !fs.existsSync(path.join(d, R.FILE)), '不认识的参数直接拒, 不落盘');
  ok(/exactly one/.test(R.reminderOp(d, 'create', { text: 'x' }, NOW)), 'at/cron 都不给 → 拒');
  ok(/exactly one/.test(R.reminderOp(d, 'create', { text: 'x', at: '2026-11-15 09:00', cron: '0 9 * * *' }, NOW)), 'at/cron 都给 → 拒');
  ok(/not a valid local time/.test(R.reminderOp(d, 'create', { text: 'x', at: '11月15日' }, NOW)), '自然语言日期 → 拒');
  ok(/not a valid local time/.test(R.reminderOp(d, 'create', { text: 'x', at: '2026-02-30 09:00' }, NOW)), '不存在的日期 → 拒');
  ok(/not a valid local time/.test(R.reminderOp(d, 'create', { text: 'x', at: '2026-11-15T09:00:00Z' }, NOW)), '带时区/秒 → 拒');
  ok(/not in the future/.test(R.reminderOp(d, 'create', { text: 'x', at: '2026-10-10 16:00' }, NOW)), '过去的时点 → 拒');
  ok(/not a valid 5-field cron/.test(R.reminderOp(d, 'create', { text: 'x', cron: 'every monday' }, NOW)), '坏 cron → 拒');
  ok(/never fires/.test(R.reminderOp(d, 'create', { text: 'x', cron: '0 9 30 2 *' }, NOW)), '永不命中的 cron → 拒');
}

console.log('\n[2] add / list / cancel');
{
  const d = tmp();
  const r1 = R.reminderOp(d, 'create', { text: '提醒老板续签保险', at: '2026-11-15 09:00' }, NOW);
  ok(/#1/.test(r1) && /2026-11-15 09:00 \(Sun\)/.test(r1), '一次性: 回执带 #id 和带星期的时点', r1);
  const r2 = R.reminderOp(d, 'create', { text: '周报', cron: '0 9 * * 1' }, NOW);
  ok(/#2/.test(r2) && /next 2026-10-12 09:00 \(Mon\)/.test(r2), '周期: 回执写下一次命中', r2);
  const l = R.reminderOp(d, 'list', {}, NOW);
  ok(/2 registered/.test(l) && /#1/.test(l) && /#2/.test(l), 'list 两条都在');
  ok(/Cancelled #2/.test(R.reminderOp(d, 'cancel', { id: '#2' }, NOW)), 'cancel 收 "#2" 写法');
  ok(book(d).items.length === 1, '盘上只剩一条');
  ok(/No reminder #9/.test(R.reminderOp(d, 'cancel', { id: 9 }, NOW)), 'cancel 不存在的 id 报出现有编号');
  R.reminderOp(d, 'create', { text: 'y', at: '2026-12-01 10:00' }, NOW);
  ok(book(d).items.some((x) => x.id === '3'), 'id 单调递增, 删过的号不复用');
}

console.log('\n[3] popDueOnce: 到点取出并移除, 错过的照样补');
{
  const d = tmp();
  R.reminderOp(d, 'create', { text: 'B', at: '2026-10-11 09:00' }, NOW);
  R.reminderOp(d, 'create', { text: 'A', at: '2026-10-10 17:00' }, NOW);
  ok(R.popDueOnce(d, new Date(2026, 9, 10, 16, 59)) === null, '没到点不取');
  const late = new Date(2026, 9, 11, 12, 0);   // 两条都过了点(关机一夜)
  const first = R.popDueOnce(d, late);
  ok(first && first.text === 'A', '多条过期按时点先后取, 一次一条');
  ok(/late/.test(R.buildPrompt(first, late)), '晚发的在提示里写明晚了多久');
  ok(R.popDueOnce(d, late).text === 'B' && book(d).items.length === 0, '第二条随后取出, 登记簿清空');
}

console.log('\n[3b] update / pause / resume / cancel all / schedule.json 条目');
{
  const home = tmp(), d = path.join(home, '.claude/memory');
  fs.writeFileSync(path.join(home, 'schedule.json'), JSON.stringify({ entries: [{ id: 'weekly', cron: '0 10 * * 1', prompt: '出周测' }] }));
  R.reminderOp(d, 'create', { text: '续保', at: '2026-11-15 09:00' }, NOW);
  R.reminderOp(d, 'create', { text: '周报', cron: '0 9 * * 1' }, NOW);
  let r = R.reminderOp(d, 'update', { id: '1', at: '2026-11-16 10:00', text: '续车险' }, NOW);
  ok(/Updated #1/.test(r) && book(d).items[0].at === '2026-11-16 10:00' && book(d).items[0].text === '续车险', 'update 改时间和文案, id 不变', r);
  R.reminderOp(d, 'update', { id: '1', cron: '0 8 * * *' }, NOW);
  ok(book(d).items[0].cron === '0 8 * * *' && !book(d).items[0].at, 'update 一次性 → 周期, 旧 at 清掉');
  ok(/not both/.test(R.reminderOp(d, 'update', { id: '1', at: '2026-11-16 10:00', cron: '0 8 * * *' }, NOW)), 'update at/cron 同给 → 拒');
  ok(/Nothing to change/.test(R.reminderOp(d, 'update', { id: '1' }, NOW)), 'update 什么都不给 → 拒');
  ok(/not in the future/.test(R.reminderOp(d, 'update', { id: '1', at: '2026-01-01 00:00' }, NOW)) && book(d).items[0].cron, 'update 时间非法 → 原条目不动');
  ok(/No reminder #7/.test(R.reminderOp(d, 'update', { id: 7, text: 'x' }, NOW)), 'update 不存在的 id');

  const l = R.reminderOp(d, 'list', {}, NOW, home);
  ok(/sched:weekly/.test(l) && /出周测/.test(l), 'list 带出 schedule.json 条目(sched:<id>)', l);
  ok(/hand-written/.test(R.reminderOp(d, 'update', { id: 'sched:weekly', text: 'x' }, NOW, home)), 'sched 条目不许 update');
  ok(/Paused sched:weekly/.test(R.reminderOp(d, 'pause', { id: 'sched:weekly' }, NOW, home)) && R.pausedSchedules(d).has('weekly'), 'pause sched 条目记进 pausedSchedules');
  ok(JSON.parse(fs.readFileSync(path.join(home, 'schedule.json'), 'utf8')).entries.length === 1, 'schedule.json 本身没被改');
  ok(/No schedule.json entry/.test(R.reminderOp(d, 'pause', { id: 'sched:nope' }, NOW, home)), 'pause 不存在的 sched 条目');

  R.reminderOp(d, 'pause', { id: '2' }, NOW);
  ok(R.cronEntries(d).every((e) => e.id !== 'reminder_2') && /#2 · ⏸ paused/.test(R.reminderOp(d, 'list', {}, NOW)), '暂停的周期提醒不进巡检, list 标 paused');
  R.reminderOp(d, 'resume', { id: '#2' }, NOW);
  ok(R.cronEntries(d).some((e) => e.id === 'reminder_2'), 'resume 后回到巡检');

  R.reminderOp(d, 'create', { text: '一次性', at: '2026-10-10 17:00' }, NOW);
  R.reminderOp(d, 'pause', { id: '3' }, NOW);
  ok(R.popDueOnce(d, new Date(2026, 9, 10, 18, 0)) === null, '暂停的一次性到点不发');
  ok(/already passed/.test(R.reminderOp(d, 'resume', { id: '3' }, new Date(2026, 9, 10, 18, 0))), 'resume 过点的一次性 → 回执说会补发');
  ok(R.popDueOnce(d, new Date(2026, 9, 10, 18, 0)).id === '3', 'resume 后补发');

  r = R.reminderOp(d, 'pause', { id: 'all' }, NOW, home);
  ok(/Paused all/.test(r) && book(d).items.every((x) => x.paused) && R.pausedSchedules(d).has('weekly'), 'pause all 连 sched 一起停', r);
  R.reminderOp(d, 'resume', { id: 'all' }, NOW, home);
  ok(book(d).items.every((x) => !x.paused) && R.pausedSchedules(d).size === 0, 'resume all 全部恢复');
  ok(/Cancelled all 2/.test(R.reminderOp(d, 'cancel', { id: 'all' }, NOW, home)) && book(d).items.length === 0, 'cancel all 清空本簿');
  ok(JSON.parse(fs.readFileSync(path.join(home, 'schedule.json'), 'utf8')).entries.length === 1, 'cancel all 不碰 schedule.json');
  fs.writeFileSync(path.join(home, 'schedule.json'), JSON.stringify({ enabled: true, note: 'keep', entries: [{ id: 'weekly', cron: '0 10 * * 1', prompt: '出周测' }, { id: 'daily', cron: '0 9 * * *', prompt: '早报' }] }));
  R.reminderOp(d, 'pause', { id: 'sched:weekly' }, NOW, home);
  const c = R.reminderOp(d, 'cancel', { id: 'sched:weekly' }, NOW, home);
  const sj = JSON.parse(fs.readFileSync(path.join(home, 'schedule.json'), 'utf8'));
  ok(/Cancelled sched:weekly/.test(c) && sj.entries.length === 1 && sj.entries[0].id === 'daily', 'cancel sched 条目从 schedule.json 删掉那一条', c);
  ok(sj.note === 'keep' && sj.enabled === true, 'cancel sched 其余字段原样保留');
  ok(!R.pausedSchedules(d).has('weekly'), 'cancel sched 顺手清掉 pausedSchedules');
  ok(/No schedule.json entry/.test(R.reminderOp(d, 'cancel', { id: 'sched:weekly' }, NOW, home)), 'cancel 不存在的 sched 条目');
}

console.log('\n[4] 巡检接线: 一次性 + 周期性都会 submit, 和 schedule.json 共存');
(async () => {
  const home = tmp(), mem = path.join(home, '.claude/memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(home, 'schedule.json'), JSON.stringify({ entries: [] }));
  const realNow = new Date();
  const past = new Date(realNow.getTime() - 5 * 60000);
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  // 直接写盘造一条"已过点"的一次性(add 会拒过去时点)
  fs.writeFileSync(path.join(mem, R.FILE), JSON.stringify({ seq: 1, items: [{ id: '1', text: '续签保险', at: stamp(past), created: 'x' }] }));
  const sent = [];
  const meta = {};
  const s = { sid: 's1', butler: {
    name: 't', homeDir: home, memoryDir: mem, isRunning: () => false,
    submit: async (body) => { sent.push(body); },
    memory: { store: { getMeta: (k) => meta[k], setMeta: (k, v) => { meta[k] = v; } } },
  } };
  const w = createIdleWatcher({ sessions: () => [s], scheduleHome: (b) => b.homeDir, log: () => {} });
  await w.runDueSchedules(s);
  ok(sent.length === 1 && /reminder #1 due/.test(sent[0]) && /续签保险/.test(sent[0]), '过点的一次性被投递', sent[0]);
  ok(book(mem).items.length === 0, '投递后移出登记簿');
  await w.runDueSchedules(s);
  ok(sent.length === 1, '不会重发');

  // 周期性: 每分钟一条, since 拨回 2 分钟前 → 本拍应命中
  R.reminderOp(mem, 'create', { text: '喝水', cron: '* * * * *' }, realNow);
  meta.schedule_last_fired = JSON.stringify({ _since: Date.now() - 2 * 60000 });
  await w.runDueSchedules(s);
  ok(sent.length === 2 && /reminder #2 due/.test(sent[1]) && /stays registered/.test(sent[1]), '周期性经 schedule 同一套游标投递', sent[1]);
  ok(book(mem).items.length === 1, '周期性投递后仍留在登记簿');

  // pause 掉的 schedule.json 条目不发
  fs.writeFileSync(path.join(home, 'schedule.json'), JSON.stringify({ entries: [{ id: 'tick', cron: '* * * * *', prompt: 'TICK' }] }));
  R.reminderOp(mem, 'cancel', { id: 'all' }, realNow);
  R.reminderOp(mem, 'pause', { id: 'sched:tick' }, realNow, home);
  meta.schedule_last_fired = JSON.stringify({ _since: Date.now() - 2 * 60000 });
  await w.runDueSchedules(s);
  ok(sent.length === 2, '暂停的 sched 条目巡检跳过');
  R.reminderOp(mem, 'resume', { id: 'sched:tick' }, realNow, home);
  meta.schedule_last_fired = JSON.stringify({ _since: Date.now() - 2 * 60000 });
  await w.runDueSchedules(s);
  ok(sent.length === 3 && /TICK/.test(sent[2]), 'resume 后照常投递', sent[2]);
  sent.pop();
  fs.writeFileSync(path.join(home, 'schedule.json'), JSON.stringify({ entries: [] }));

  // 回合进行中不打断
  const s2 = { ...s, butler: { ...s.butler, isRunning: () => true } };
  fs.writeFileSync(path.join(mem, R.FILE), JSON.stringify({ seq: 9, items: [{ id: '9', text: 'z', at: stamp(past), created: 'x' }] }));
  await w.runDueSchedules(s2);
  ok(sent.length === 2 && book(mem).items.length === 1, '人格正在回合中 → 不取不发, 留给下一拍');

  // 宿主不给 scheduleHome → 整条不跑
  const w0 = createIdleWatcher({ sessions: () => [s], log: () => {} });
  await w0.runDueSchedules(s);
  ok(sent.length === 2, '不给 scheduleHome 不跑');

  console.log('\n[5] task 拒收 due, 指去 reminder');
  const fake = { _tasks: [], _flushTasks() {}, taskOp: require('../core/agent/tasks').prototype.taskOp };
  {
    const r = fake.taskOp('create', { subject: '续签保险', due: '2026-11-15' });
    ok(/Unknown args: due/.test(r) && /reminder/.test(r) && fake._tasks.length === 0, 'task 带 due → 拒且不建', r);
    ok(/✅/.test(fake.taskOp('create', { subject: 'ok', description: 'd' })), '合法参数照常建');
  }

  console.log('\n[6] 注册三处一处不漏(漏一处就是看得见调不动 / description 是 undefined)');
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  ok(/'reminder',\s*\n\s*D\.reminder/.test(src('core/agent/mcp-tools.js')), 'mcp-tools 注册了 reminder');
  ok(src('core/agent/stream.js').includes("'mcp__butler__reminder'"), 'stream.js 白名单有 reminder');
  for (const f of ['core/config/tools/descriptions.json', 'industry/config/tools/descriptions.json']) {
    ok(typeof JSON.parse(src(f)).reminder === 'string', `${f} 有 reminder 说明`);
  }
  ok(!/'reminder'/.test(src('industry/app/industry-agent.js').match(/_droppedCoreTools\(\)\s*\{[\s\S]*?\n  \}/)[0]), '行业版没把 reminder 摘掉');
  ok(/scheduleHome:/.test(src('personal/main.js')), '个人版给了 scheduleHome(否则个人版永远不到点)');
  ok(!/require\('..\/core\/schedule'\)/.test(src('personal/wakeloop.js')), 'wakeloop 不再另跑一份调度(会双发)');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
