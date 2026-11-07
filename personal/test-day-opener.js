// test-day-opener.js — 当天第一条真人消息前垫「查一件该提的事」, 一天一次
require('./host-wiring');
const fs = require('fs');
const path = require('path');
const { takeDayOpener, takeDayGreet, markOpenedToday } = require('../core/agent/day-opener');
const { todayLocal } = require('../core/memory');
const reminders = require('../core/reminders');
const os = require('os');
const { cfg } = require('../core/host');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ' + l); } else { fail++; console.log('  FAIL ' + l); } };
const mk = (meta = {}) => ({ name: 't', memory: { store: { getMeta: (k) => meta[k], setMeta: (k, v) => { meta[k] = v; } } } });

console.log('\n== 一天一次 ==');
const a = mk();
ok(/First message from them today/.test(takeDayOpener(a, 'user', false)), '当天第一条真人消息垫上');
ok(takeDayOpener(a, 'user', false) === '', '同一天第二条不再垫');
ok(takeDayOpener(mk({ day_opener_last: '2000-01-01' }), 'inbox', false) !== '', '换了一天、外部通道来的也垫');
ok(takeDayOpener(mk(), 'auto', false) === '', '系统自动发的不垫(也不占掉当天名额)');
ok(takeDayOpener(mk(), 'user', true) === '', '心跳不垫');
ok(takeDayOpener({ name: 't', memory: {} }, 'user', false) === '', '没有 meta 的库不垫不炸');

console.log('\n== 每天主动开口(与上面共用一天一次) ==');
const today = todayLocal();
const at = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d; };
const g = mk();
ok(/daily check-in/.test(takeDayGreet(g, today, at(7))), '当天第一次启动: 9 点前也开口');
ok(takeDayGreet(g, today, at(10)) === '', '开过口当天不再开口');
ok(takeDayOpener(g, 'user', false) === '', '开过口当天, 对方第一句不再垫');
ok(takeDayGreet(mk(), '2000-01-01', at(8)) === '', '开着过夜: 9 点前不开口(也不占名额)');
ok(takeDayGreet(mk(), '2000-01-01', at(9)) !== '', '开着过夜: 到 9 点开口');
const u = mk(); takeDayOpener(u, 'user', false);
ok(takeDayGreet(u, today, at(10)) === '', '对方今天先说过话, 就不再开口');
const nb = mk(); markOpenedToday(nb);
ok(takeDayGreet(nb, today, at(10)) === '', '出生当天招呼已打过: 不再主动开口');
ok((fs.readFileSync(path.join(__dirname, 'first-persona.js'), 'utf8').match(/_birthRunning = true;[^\n]*\n\s*setTimeout/g) || []).length === 2, '出生排队那段就立「正在出生」, 不让开口抢先');
ok(/markOpenedToday\(s\.butler\)/.test(fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')), '出生完成时记今天已开口');
ok(/sched:day_greet/.test(cfg.text('main/day_greet_text')), '开口文案告诉人格怎么关掉');

console.log('\n== 叫停: reminder pause sched:day_greet ==');
const md = fs.mkdtempSync(path.join(os.tmpdir(), 'greet-'));
ok(/Paused sched:day_greet/.test(reminders.reminderOp(md, 'pause', { id: 'sched:day_greet' }, new Date(), md)), '没有 schedule.json 也能暂停内置开口');
ok(reminders.pausedSchedules(md).has('day_greet'), '暂停记进登记簿');
ok(/sched:day_greet · ⏸ paused/.test(reminders.reminderOp(md, 'list', {}, new Date(), md)), 'list 里看得到被暂停的开口');
reminders.reminderOp(md, 'resume', { id: 'sched:day_greet' }, new Date(), md);
ok(!reminders.pausedSchedules(md).has('day_greet'), 'resume 恢复');
ok(/No schedule.json entry/.test(reminders.reminderOp(md, 'pause', { id: 'sched:nope' }, new Date(), md)), '别的不存在的 sched 照旧拒');
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
ok(/dayGreet: \(s\) =>/.test(main) && /entry\.isButler/.test(main) && /has\('day_greet'\)/.test(main), '个人版宿主: 只管家、看暂停');
ok(/host\.dayGreet/.test(fs.readFileSync(path.join(__dirname, '..', 'core/idle-watcher.js'), 'utf8')), '巡检器接上了');

console.log('\n== 配置 ==');
ok(cfg.json('main/day_opener').enabled === true, '个人版默认开');
const ind = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'industry/config/main/day_opener.json'), 'utf8'));
ok(ind.enabled === false, '行业版覆盖成关');
ok(!fs.existsSync(path.join(__dirname, '..', 'core/config/main/day_opener.md')),
   '🔴 文案不与开关同名(json()/text() 共用缓存, 同名会互相顶)');
const src = fs.readFileSync(path.join(__dirname, '..', 'core/agent/stream.js'), 'utf8');
ok(/takeDayOpener\(this, _srcKind, isHeartbeatPing\)/.test(src) && /\$\{_opener\}`/.test(src), 'stream.js 提交时接上了');

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
