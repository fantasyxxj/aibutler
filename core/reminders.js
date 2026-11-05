// reminders.js — 提醒登记簿: AI 只管登记, 到点由宿主的巡检把它叫醒去提醒人。
//
// 🔴 为什么不是 task: task 回答「手上还欠几件事」, 没有时间轴, 没人会在 11 月 15 号想起翻它。
//    靠 AI 自觉记着到点去说, 做不到 —— 子进程会被回收, 上下文会被压缩, 会话可能根本没开。
//    所以拆成两半: 登记(这里, reminder 工具) + 到点戳(core/idle-watcher.js 的 runDueSchedules)。
// 🔴 为什么不并进 schedule.json: 那份是人/能力包手写的配置, 让 AI 往里写就会把手写内容一起覆盖掉。
//    AI 对它只有 pause/resume 和 cancel(删整条, 过期的定时没用了, 作者 10-10 定: 助手可自行决定删), 不许 add/update。
//    这份是 AI 的账本, 住在记忆目录里, 跟 tasks.json 并排、跟着人格一起搬。
//
// 两种条目:
//   at   一次性(本地时间 "YYYY-MM-DD HH:MM")。到点发出后移出登记簿。**关机/忙着错过的, 下次巡检照样补发**,
//        并在提示里写明晚了多久 —— 提醒错过就等于没做, 这点与 schedule.json「错过不补」故意不同。
//   cron 周期性(标准 5 段, 本地时区)。错过的不补(补一串过期的"每天 9 点"只会刷屏), 去重游标与
//        schedule.json 共用 idle-watcher 的 schedule_last_fired。
// 回执与提示都是喂模型的 → 英文单份(见 personal/test-model-facing-english.js)。
'use strict';
const fs = require('fs');
const path = require('path');
const sched = require('./schedule');

const FILE = 'reminders.json';
const MAX_TEXT = 2000;
const fileOf = (memoryDir) => path.join(memoryDir, FILE);

function load(memoryDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(memoryDir), 'utf8'));
    return {
      seq: Number(raw.seq) || 0,
      items: Array.isArray(raw.items) ? raw.items : [],
      pausedSchedules: Array.isArray(raw.pausedSchedules) ? raw.pausedSchedules.map(String) : [],
    };
  } catch (_) { return { seq: 0, items: [], pausedSchedules: [] }; }
}

// 先写临时文件再改名: 巡检和工具可能前后脚写, 半截文件会让整本账读成空的。
function save(memoryDir, book) {
  fs.mkdirSync(memoryDir, { recursive: true });
  const f = fileOf(memoryDir), tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(book, null, 2), 'utf8');
  fs.renameSync(tmp, f);
}

const pad = (n) => String(n).padStart(2, '0');
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (${DOW[d.getDay()]})`;

// 只收本地时间的「年-月-日 时:分」。带时区/秒/自然语言一律拒 —— 宁可让模型重填一次,
// 也不要 Date 宽松解析出一个差了 8 小时的时点, 那种错没人会发现。
function parseAt(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const dt = new Date(y, mo - 1, d, h, mi);
  // 回读校验挡掉 2026-02-30 这种会被 Date 悄悄滚到下个月的日期
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d || dt.getHours() !== h || dt.getMinutes() !== mi) return null;
  return dt;
}

// cron 的下一个命中点, 往后扫一年; 扫不到返回 null(如 2 月 30 号)。
function nextCron(parsed, from) {
  let t = Math.floor(from.getTime() / 60000) * 60000 + 60000;
  for (let i = 0; i < 366 * 24 * 60; i++, t += 60000) {
    const d = new Date(t);
    if (sched.cronMatches(parsed, d)) return d;
  }
  return null;
}

const line = (r) => `#${r.id}${r.paused ? ' · ⏸ paused' : ''} · ${r.at ? `once at ${r.at}` : `repeats cron "${r.cron}"`} · ${r.text}`;

// schedule.json 的条目在工具里叫 sched:<id>。可 pause/resume/cancel, 不可 update —— 改内容归人(见文件头)。
// 暂停状态记在本登记簿的 pausedSchedules 里, 不碰 schedule.json; 只有 cancel 才真删文件里那一条。
const SCHED = 'sched:';
const schedEntries = (home) => {
  if (!home) return [];
  try { const reg = sched.loadRegistry(home); return reg ? reg.entries : []; } catch (_) { return []; }
};
const schedLine = (e, paused, now) => {
  const next = nextCron(e.parsed, now);
  const what = e.prompt ? String(e.prompt).replace(/\s+/g, ' ').slice(0, 80) : `(prompt file ${e.prompt_ref})`;
  return `${SCHED}${e.id}${paused ? ' · ⏸ paused' : ''} · repeats cron "${e.cron}"${next ? `, next ${fmt(next)}` : ''} · ${what}`;
};

/* 到点怎么送: 'session' = 叫醒人格让它说(行业版), 'banner' = 宿主挂横幅给人看、人点「处理」才叫人格(个人版)。
   宿主开机时设一次; 回执与用法说明跟着它写, 免得告诉模型一件这台机器上不会发生的事。 */
let DELIVERY = 'session';
function setDelivery(mode) { DELIVERY = mode === 'banner' ? 'banner' : 'session'; }
const TEXT_HINT = () => (DELIVERY === 'banner'
  ? 'text = the line the person reads on the reminder banner, written to them in their language (it is shown as-is).\n'
  : 'text = what to tell the person when it fires (write it so it still makes sense months later).\n');

const ID_HINT = `id = the #number from list, or ${SCHED}<id> for a schedule.json entry, or "all".`;
const OPS = {
  list:   { req: [], opt: [], hint: 'No params. Lists every reminder in your book, plus the hand-written schedule.json entries (shown as sched:<id>).' },
  create: { req: ['text'], opt: ['at', 'cron'],   // 与 task 同一个动词(原叫 add, 两个工具串用, 10-14)
    get hint() { return TEXT_HINT() + 'Give exactly one of: at = one-off local time "YYYY-MM-DD HH:MM" (must be in the future) · '
      + 'cron = repeating, standard 5 fields in local time, e.g. "0 9 * * 1" = every Monday 09:00.'; } },
  update: { req: ['id'], opt: ['text', 'at', 'cron'],
    hint: 'id = the #number. Pass text to reword it, and/or exactly one of at / cron to move it (switching one-off ↔ repeating is fine). '
      + 'Keeps the same id and paused state. schedule.json entries cannot be edited here — that file is hand-written.' },
  pause:  { req: ['id'], opt: [], hint: `Stops it firing but keeps it registered; resume brings it back. ${ID_HINT}` },
  resume: { req: ['id'], opt: [], hint: `Undo pause. A paused one-off whose time already passed fires on the next check, marked late. ${ID_HINT}` },
  cancel: { req: ['id'], opt: [], hint: `Deletes it for good. id = the #number, or ${SCHED}<id> to remove that entry from schedule.json, `
      + 'or "all" to empty your book (all does not touch schedule.json — cancel those one by one).' },
};

const normId = (v) => String(v).trim().replace(/^#/, '');

// 校验一组 at/cron, 返回 { set, when } 或 { err }。create 和 update 共用。
function timing(a, now) {
  if (a.at) {
    const dt = parseAt(a.at);
    if (!dt) return { err: `⚠️ at="${a.at}" is not a valid local time "YYYY-MM-DD HH:MM" — nothing was saved.` };
    if (dt <= now) return { err: `⚠️ at=${fmt(dt)} is not in the future (now ${fmt(now)}) — nothing was saved.` };
    return { set: { at: `${a.at}`.trim().replace('T', ' ') }, when: `fires once at ${fmt(dt)}` };
  }
  const parsed = sched.parseCron(a.cron);
  if (!parsed) return { err: `⚠️ cron="${a.cron}" is not a valid 5-field cron — nothing was saved.` };
  const next = nextCron(parsed, now);
  if (!next) return { err: `⚠️ cron="${a.cron}" never fires within a year — nothing was saved.` };
  return { set: { cron: String(a.cron).trim() }, when: `repeats on cron "${String(a.cron).trim()}", next ${fmt(next)}` };
}

// pause / resume 共用: 本簿条目改 paused 标记, sched:<id> 进出 pausedSchedules。
function setPaused(book, id, on, home, now) {
  const verb = on ? 'Paused' : 'Resumed';
  const ps = new Set(book.pausedSchedules);
  const flip = (r) => { if (on) r.paused = true; else delete r.paused; };
  if (id === 'all') {
    book.items.forEach(flip);
    const se = schedEntries(home);
    se.forEach((e) => (on ? ps.add(e.id) : ps.delete(e.id)));
    if (!on) ps.clear();
    book.pausedSchedules = [...ps];
    return `✅ ${verb} all: ${book.items.length} reminder(s)${se.length ? ` + ${se.length} schedule.json entr${se.length > 1 ? 'ies' : 'y'}` : ''}.`;
  }
  if (id.startsWith(SCHED)) {
    const sid = id.slice(SCHED.length);
    const e = schedEntries(home).find((x) => x.id === sid);
    if (!e && on) return `⚠️ No schedule.json entry "${sid}". Run op='list' to see them.`;
    on ? ps.add(sid) : ps.delete(sid);
    book.pausedSchedules = [...ps];
    return `✅ ${verb} ${SCHED}${sid}${e ? ` (cron "${e.cron}")` : ''}.`;
  }
  const hit = book.items.find((r) => r.id === id);
  if (!hit) return null;
  flip(hit);
  const overdue = !on && hit.at && parseAt(hit.at) <= now;
  return `✅ ${verb} #${id}: ${hit.text}${overdue ? ' — its time already passed, so it fires on the next check (marked late).' : ''}`;
}

// 工具的唯一入口。返回给模型看的回执字符串。now 可注入(测试用); home = 人格目录, 用来找 schedule.json。
function reminderOp(memoryDir, op, args, now = new Date(), home = null) {
  const a = args || {};
  const spec = OPS[op];
  if (!spec) return `⚠️ No op '${op}'. Available: ${Object.keys(OPS).join(' / ')}`;
  const usage = `op='${op}' takes ${spec.req.map((k) => `${k}=…`).join(', ') || 'no params'}${spec.opt.length ? ` · optional ${spec.opt.join(', ')}` : ''}\n${spec.hint}`;
  // 认不得的参数名直接拒 —— task 那边就是静默丢掉 due, 模型以为登记了时间, 实际什么都没有。
  const unknown = Object.keys(a).filter((k) => !spec.req.includes(k) && !spec.opt.includes(k));
  if (unknown.length) return `⚠️ Unknown args: ${unknown.join(', ')} — nothing was saved.\n${usage}`;
  const missing = spec.req.filter((k) => a[k] === undefined || a[k] === null || a[k] === '');
  if (missing.length) return `Missing: ${missing.join(', ')}\n${usage}`;

  const book = load(memoryDir);
  const notFound = (id) => `⚠️ No reminder #${id}. ${book.items.length ? `Registered: ${book.items.map((r) => '#' + r.id).join(' ')}` : 'The book is empty.'}`;

  if (op === 'list') {
    const ps = new Set(book.pausedSchedules);
    const se = schedEntries(home);
    if (!book.items.length && !se.length) return '(No reminders registered.)';
    let out = `${book.items.length} registered (now ${fmt(now)})${book.items.length ? ':\n' + book.items.map(line).join('\n') : '.'}`;
    if (se.length) out += `\n\nschedule.json (hand-written · pause/resume/cancel, no edits):\n` + se.map((e) => schedLine(e, ps.has(e.id), now)).join('\n');
    return out;
  }

  const id = normId(a.id);

  if (op === 'pause' || op === 'resume') {
    const r = setPaused(book, id, op === 'pause', home, now);
    if (r === null) return notFound(id);
    if (!r.startsWith('⚠️')) save(memoryDir, book);
    return r;
  }

  if (op === 'cancel') {
    if (id.startsWith(SCHED)) {
      const sid = id.slice(SCHED.length);
      const gone = sched.removeEntry(home, sid);
      if (!gone) return `⚠️ No schedule.json entry "${sid}". Run op='list' to see them.`;
      book.pausedSchedules = book.pausedSchedules.filter((x) => x !== sid);
      save(memoryDir, book);
      return `✅ Cancelled ${id} (cron "${gone.cron}") — removed from schedule.json.`;
    }
    if (id === 'all') {
      const n = book.items.length;
      book.items = [];
      save(memoryDir, book);
      return `✅ Cancelled all ${n} reminder(s). The book is empty.`;
    }
    const hit = book.items.find((r) => r.id === id);
    if (!hit) return notFound(id);
    book.items = book.items.filter((r) => r !== hit);
    save(memoryDir, book);
    return `✅ Cancelled #${id}: ${hit.text}`;
  }

  if (op === 'update') {
    if (id.startsWith(SCHED)) return `⚠️ ${id} is a hand-written schedule.json entry — it cannot be edited from here.`;
    const hit = book.items.find((r) => r.id === id);
    if (!hit) return notFound(id);
    if (a.at && a.cron) return `⚠️ Give at or cron, not both — nothing was saved.\n${usage}`;
    if (!a.text && !a.at && !a.cron) return `⚠️ Nothing to change — pass text and/or at / cron.\n${usage}`;
    let when = '';
    if (a.at || a.cron) {
      const t = timing(a, now);
      if (t.err) return t.err;
      delete hit.at; delete hit.cron;
      Object.assign(hit, t.set);
      when = ` — now ${t.when}`;
    }
    if (a.text) hit.text = String(a.text).trim().slice(0, MAX_TEXT);
    save(memoryDir, book);
    return `✅ Updated #${id}${when}${hit.paused ? ' (still paused)' : ''}: ${hit.text}`;
  }

  // op === 'create'
  const text = String(a.text).trim().slice(0, MAX_TEXT);
  if ((a.at ? 1 : 0) + (a.cron ? 1 : 0) !== 1) return `⚠️ Give exactly one of at / cron — nothing was saved.\n${usage}`;
  const t = timing(a, now);
  if (t.err) return t.err;
  book.seq += 1;
  const item = { id: String(book.seq), text, created: fmt(now), ...t.set };
  book.items.push(item);
  save(memoryDir, book);
  const how = DELIVERY === 'banner'
    ? 'At that moment the app shows this text on a banner to the person (even if you are closed); they choose ignore / later / handle, and handle brings you back with it. '
    : 'At that moment the host wakes you with this text and you tell the person. If the app is closed then, it fires on next launch (one-offs only). ';
  return `✅ Registered reminder #${item.id} — ${t.when} (local time).\n` + how
    + "Change it with op='update' / 'pause' / 'cancel' id=" + item.id + '.';
}

// —— 巡检侧 ——

// 取出一条已到点的一次性提醒并移出登记簿(先记再发, 同 schedule 的取舍: 重复提醒比漏一次更烦,
// 但这里漏发的代价是没提醒到 —— 所以只在真要投递时才调, 调用方保证随后就 submit)。
function popDueOnce(memoryDir, now = new Date()) {
  const book = load(memoryDir);
  const due = book.items
    .filter((r) => r.at && !r.paused && parseAt(r.at) && parseAt(r.at) <= now)
    .sort((x, y) => parseAt(x.at) - parseAt(y.at))[0];
  if (!due) return null;
  book.items = book.items.filter((r) => r !== due);
  save(memoryDir, book);
  return due;
}

// 周期性条目转成 schedule 注册表的条目形状, 让 idle-watcher 用同一套 dueEntries + 去重游标。
// id 加前缀免得撞上 schedule.json 里手写的 id。
function cronEntries(memoryDir) {
  return load(memoryDir).items
    .filter((r) => r.cron && !r.paused)
    .map((r) => ({ id: `reminder_${r.id}`, cron: r.cron, parsed: sched.parseCron(r.cron), reminder: r }))
    .filter((e) => e.parsed);
}

// schedule.json 里被 pause 掉的 id(巡检据此跳过)。
const pausedSchedules = (memoryDir) => new Set(load(memoryDir).pausedSchedules);

function buildPrompt(r, now = new Date()) {
  let late = '';
  if (r.at) {
    const mins = Math.round((now - parseAt(r.at)) / 60000);
    if (mins >= 10) late = ` · ⚠️ ${mins >= 120 ? `${Math.round(mins / 60)}h` : `${mins}min`} late (app was closed or busy)`;
  }
  return `(System · reminder #${r.id} due · registered ${r.created}${r.at ? ` for ${r.at}` : ` · repeats "${r.cron}"`}${late} · not a user message)\n`
    + `${r.text}\n\n`
    + '(You registered this earlier with the reminder tool. Tell the person now — your reply to this turn is shown on their screen. '
    + (r.at ? 'It has been removed from the book; register a new one if it needs another nudge.)' : "It stays registered; op='pause' or 'cancel' to stop it.)");
}

// —— 宿主接管侧(个人版横幅) ——
// 到点不再送进人格会话, 而是挂成横幅等人点: 忽略 / 稍后 / 处理。所以一次性提醒到点**不删**,
// 人点了才删; 周期性提醒记 pendingAt(这一次该响的时刻) 与 lastFired(人处置过的最后一次), 去重不靠人格的记忆库
// —— 人格关着也要能判。错过多次的周期提醒只挂一条。
const stamp = (s) => parseAt(String(s || '').slice(0, 16));

/* 此刻该挂横幅的条目(会顺手给周期提醒补上 pendingAt 并落盘)。返回 [{id, text, when}] */
function scanDue(memoryDir, now = new Date()) {
  const book = load(memoryDir);
  let dirty = false;
  const out = [];
  for (const r of book.items) {
    if (r.paused) continue;
    if (r.cron && !r.pendingAt) {
      const parsed = sched.parseCron(r.cron);
      const from = stamp(r.lastFired) || stamp(r.created);
      let next = parsed && from ? nextCron(parsed, from) : null;
      if (next && next <= now) {
        // 错过多次: 只挂最近该响的那一次
        for (let i = 0, n = nextCron(parsed, next); i < 1000 && n && n <= now; i++, n = nextCron(parsed, n)) next = n;
        r.pendingAt = fmt(next); dirty = true;
      }
    }
    const when = r.at ? parseAt(r.at) : stamp(r.pendingAt);
    if (!when || when > now) continue;
    if (r.snoozeUntil && stamp(r.snoozeUntil) > now) continue;
    out.push({ id: r.id, text: r.text, when: fmt(when) });
  }
  if (dirty) save(memoryDir, book);
  return out;
}

/* 人在横幅上点了什么。dismiss(忽略/处理) = 一次性删掉、周期性记下这一次已处置; snooze = 推迟 minutes 分钟。 */
function act(memoryDir, id, action, { minutes = 10, until = null } = {}, now = new Date()) {
  const book = load(memoryDir);
  const r = book.items.find((x) => x.id === String(id));
  if (!r) return { ok: false, message: `no reminder #${id}` };
  if (action === 'snooze') {
    const t = until instanceof Date ? until : new Date(now.getTime() + Math.max(1, Number(minutes) || 10) * 60000);
    r.snoozeUntil = fmt(t);
  } else if (r.cron) {
    r.lastFired = fmt(now); delete r.pendingAt; delete r.snoozeUntil;
  } else {
    book.items = book.items.filter((x) => x !== r);
  }
  save(memoryDir, book);
  return { ok: true, item: r };
}

module.exports = { OPS, reminderOp, popDueOnce, cronEntries, pausedSchedules, buildPrompt, parseAt, nextCron, FILE, scanDue, act,
                   setDelivery, delivery: () => DELIVERY };
