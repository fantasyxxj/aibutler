// test-reminder-banner.js — 个人版提醒走横幅: 主进程按登记簿挂出, 人点忽略 / 稍后 / 处理。运行: node test-reminder-banner.js
//
// 守: ① 一次性提醒到点挂出、不从簿里删, 人点了才删 ② 稍后到点再出 ③ 周期提醒错过多次只挂一条, 处置后等下一次
// ④ 人格关着也扫得到(主进程按登记册找记忆目录) ⑤ 横幅模式下 idle-watcher 不再把提醒送进人格会话
// ⑥ 工具回执与用法按横幅写, 不说「叫醒你」。
require('./host-wiring');
const fs = require('fs');
const path = require('path');
const os = require('os');
const reminders = require('../core/reminders');

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { if (ok) { pass++; console.log(`  ✅ ${name}${extra ? ' · ' + extra : ''}`); } else { fail++; console.error(`  ❌ ${name}${extra ? ' · ' + extra : ''}`); } };
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi);
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rem-banner-'));

(async () => {
  console.log('\n[1] 一次性: 到点挂出, 不删; 忽略才删');
  {
    const dir = mk();
    reminders.reminderOp(dir, 'create', { text: '给房东回电话', at: '2026-10-23 15:00' }, at(2026, 10, 22, 22, 0));
    t('没到点不挂', reminders.scanDue(dir, at(2026, 10, 23, 14, 59)).length === 0);
    const due = reminders.scanDue(dir, at(2026, 10, 23, 15, 1));
    t('到点挂出', due.length === 1 && due[0].text === '给房东回电话');
    t('挂出不删', reminders.scanDue(dir, at(2026, 10, 23, 16, 0)).length === 1);
    reminders.act(dir, due[0].id, 'dismiss', {}, at(2026, 10, 23, 16, 0));
    t('忽略之后从簿里删掉', reminders.scanDue(dir, at(2026, 10, 24, 9, 0)).length === 0);
  }

  console.log('\n[2] 稍后: 推迟期间不挂, 到点再出');
  {
    const dir = mk();
    reminders.reminderOp(dir, 'create', { text: '交水费', at: '2026-10-23 09:00' }, at(2026, 10, 22, 22, 0));
    const [r] = reminders.scanDue(dir, at(2026, 10, 23, 9, 5));
    reminders.act(dir, r.id, 'snooze', { minutes: 60 }, at(2026, 10, 23, 9, 5));
    t('推迟期间不挂', reminders.scanDue(dir, at(2026, 10, 23, 10, 0)).length === 0);
    t('推迟到点再出', reminders.scanDue(dir, at(2026, 10, 23, 10, 6)).length === 1);
    reminders.act(dir, r.id, 'snooze', { until: at(2026, 10, 24, 9, 0) }, at(2026, 10, 23, 10, 6));
    t('推到明早 9 点: 当晚不出', reminders.scanDue(dir, at(2026, 10, 23, 23, 0)).length === 0);
    t('推到明早 9 点: 9 点出', reminders.scanDue(dir, at(2026, 10, 24, 9, 0)).length === 1);
  }

  console.log('\n[3] 周期: 错过多次只挂一条; 处置后等下一次');
  {
    const dir = mk();
    reminders.reminderOp(dir, 'create', { text: '周报', cron: '0 9 * * *' }, at(2026, 10, 20, 8, 0));
    const due = reminders.scanDue(dir, at(2026, 10, 23, 12, 0));
    t('错过三天只挂一条', due.length === 1, JSON.stringify(due.map((x) => x.when)));
    t('挂的是最近该响的那次', due[0] && due[0].when.startsWith('2026-10-23 09:00'));
    reminders.act(dir, due[0].id, 'dismiss', {}, at(2026, 10, 23, 12, 0));
    t('处置后当天不再出', reminders.scanDue(dir, at(2026, 10, 23, 20, 0)).length === 0);
    t('第二天 9 点再出', reminders.scanDue(dir, at(2026, 10, 24, 9, 1)).length === 1);
    t('周期提醒处置后仍在簿里', reminders.reminderOp(dir, 'list', {}, at(2026, 10, 24, 9, 1)).includes('周报'));
  }

  console.log('\n[4] 主进程按登记册扫, 人格开没开都扫');
  {
    const homes = [mk(), mk()];
    const persona = require('../core/persona');
    homes.forEach((h, i) => reminders.reminderOp(persona.resolveMemoryDir(h), 'create',
      { text: `提醒${i}`, at: '2020-01-01 09:00' }, at(2019, 12, 31, 0, 0)));
    const sent = [];
    const center = require('./reminder-center').create({
      registry: { list: () => homes.map((h, i) => ({ homeDir: h, name: `人格${i}` })) },
      persona, sendUI: (ch, d) => sent.push({ ch, d }),
    });
    const items = center.push(true);
    t('两个人格的提醒都挂出', items.length === 2 && items.every((x) => x.persona && x.homeDir));
    t('推给界面的是 reminders 通道', sent[0] && sent[0].ch === 'reminders' && sent[0].d.items.length === 2);
    center.push();
    t('没变化不重推', sent.length === 1);
    center.act({ homeDir: homes[0], id: items.find((x) => x.homeDir === homes[0]).id, action: 'handle' });
    t('处理之后那条不再挂, 并推一次新列表', sent.length === 2 && sent[1].d.items.length === 1);
  }

  console.log('\n[5] 横幅模式: idle-watcher 不送进会话; 回执按横幅写');
  {
    t('建了 reminder-center 后就是横幅模式', reminders.delivery() === 'banner');
    const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'idle-watcher.js'), 'utf8');
    t('idle-watcher 在横幅模式下不取提醒', /reminders\.delivery\(\) === 'banner' \? null/.test(src));
    const r = reminders.reminderOp(mk(), 'create', { text: 'x', at: '2030-01-01 09:00' }, at(2026, 10, 22, 22, 0));
    t('回执说的是横幅', /banner/.test(r) && !/wakes you/.test(r), r.split('\n')[1]);
    t('用法说 text 是给人看的原句', /banner/.test(reminders.OPS.create.hint));
    reminders.setDelivery('session');
    t('行业版(session)回执仍是叫醒人格', /wakes you/.test(reminders.reminderOp(mk(), 'create', { text: 'x', at: '2030-01-01 09:00' }, at(2026, 10, 22, 22, 0))));
  }

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
