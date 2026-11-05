// reminder-center.js — 个人版的提醒由主进程统一盯, 到点挂横幅给人看。
//
// 提醒是给人的, 不是给人格的: 到点不叫醒人格、不切标签、不弹系统通知, 只在窗口顶上挂一行,
// 人点「忽略 / 稍后 / 处理」。只有「处理」才打开那个人格并把这条交给它 —— 那一步在 main.js 里接。
// 人格开没开都扫: 登记簿在各人格的记忆目录, 关着的人格照样能从登记册找到那个目录。
'use strict';
const reminders = require('../core/reminders');

const SCAN_MS = 30_000;

function create({ registry, persona, sendUI, log = () => {} }) {
  let last = '[]';
  let timer = null;
  reminders.setDelivery('banner');   // 建起来那一刻就定: 人格的 reminder 工具回执要按横幅来写
  const dirOf = (homeDir) => persona.resolveMemoryDir(homeDir);

  /* 所有人格此刻该挂的提醒。一行一条, 按到点时间排。 */
  function list(now = new Date()) {
    const out = [];
    for (const p of registry.list()) {
      let due = [];
      try { due = reminders.scanDue(dirOf(p.homeDir), now); } catch (e) { log(`[reminder] ${p.name} 读登记簿失败: ${e.message}`); }
      for (const r of due) out.push({ homeDir: p.homeDir, persona: p.name, avatar: p.avatar || '', id: r.id, text: r.text, when: r.when });
    }
    return out.sort((a, b) => (a.when < b.when ? -1 : a.when > b.when ? 1 : 0));
  }

  /* 有变化才推给界面; force = 界面刚起来要一份全量。 */
  function push(force = false) {
    const items = list();
    const now = JSON.stringify(items);
    if (!force && now === last) return items;
    if (now !== last) log(`[reminder] 横幅 ${items.length} 条`);
    last = now;
    sendUI('reminders', { items });
    return items;
  }

  /* action: ignore | handle(都算这一次处置完) · snooze(minutes 或 until=Date) */
  function act({ homeDir, id, action, minutes, until }) {
    const kind = action === 'snooze' ? 'snooze' : 'dismiss';
    const r = reminders.act(dirOf(homeDir), id, kind, { minutes, until: until ? new Date(until) : null });
    push();
    return r;
  }

  function start() {
    if (timer) return;
    push(true);
    timer = setInterval(() => { try { push(); } catch (e) { log(`[reminder] 巡检出错: ${e.message}`); } }, SCAN_MS);
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { start, stop, list, push, act };
}

module.exports = { create, SCAN_MS };
