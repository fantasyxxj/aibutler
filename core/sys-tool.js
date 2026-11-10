// sys-tool.js — 系统工具 sys: 模型自己做容易错的事交给程序, 按 op 分。现有 date / time / math。
//
// 🔴 为什么要有: 模型算日期、配星期、做加减, 都是顺手采样而不是真算 —— 10-13 行业版把「来週の木曜」
//    答成 10-15(应 10-22), 10-11 把 10/12 周一说成周日, 简单加减也会错。而且它算错时自己觉得是对的。
//    出口改星期(旧 weekday-fix)只改显示不改记录, 还会把露馅的那个线索抹平, 所以要在写进记录之前就算对。
//    作者 10-14 定: 做成一个系统工具, 按 op 分 —— 以后同类操作一律往 OPS 加一项, 不另加工具。
// 🔴 不认任何业务: 不懂预约、营业日、税率 —— 那些是调用方带进来的数。
// 本地时区算, 与 nowStamp 同一个时钟。回执是喂模型的 → 英文。
'use strict';

const WEEK_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_MS = 86400000;

// 加 op = 往这里加一项 { req, opt, hint, run }, 壳和白名单都不用动
const OPS = {
  date: { req: [], opt: ['date', 'from', 'days', 'weeks', 'months', 'weekday', 'week', 'to'], run: (a, now) => dateOp(a, now),
    hint: 'All dates are YYYY-MM-DD, local time; from defaults to today.\n'
      + '· date → its weekday and how far from today.\n'
      + '· weekday (+ week = this / next / after, weeks start Monday) → that date. Without week → the next one after from.\n'
      + '· days / weeks / months (may be negative) → from shifted by that much; months past a short month\'s end land on its last day.\n'
      + '· to → days from from (or date) to to.' },
  // 作者 11-08: 一切计算交给工具 —— 时刻、时长(几点做完 · 离打烊还多久)以前只能心算
  time: { req: [], opt: ['at', 'minutes', 'hours', 'until'], run: (a, now) => timeOp(a, now),
    hint: 'Times are HH:MM (24h), local; at defaults to now.\n'
      + '· minutes / hours (may be negative) → at shifted by that much, says if it crosses midnight.\n'
      + '· until → how long from at to until (an earlier until counts as the next day).' },
  math: { req: ['expr'], opt: ['round'], run: (a) => mathOp(a),
    hint: 'expr = arithmetic with + - * / % ( ) and decimals, e.g. "3*1200 + 2*800". '
      + 'round = floor / ceil / round to a whole number (leave it out to get the exact result).' },
};

const p2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const dayOnly = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayDiff = (a, b) => Math.round((dayOnly(b) - dayOnly(a)) / DAY_MS);   // 夏令时那天差一小时, round 吃掉

function parseDate(v) {
  const m = /^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*$/.exec(String(v));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d : null;   // 2-30 这种不存在的日期不认
}

// 星期写法: Mon / Monday / 月 / 月曜(日) / 周一 / 星期一 / 週一 / 礼拜一。返回 0(日)..6, 认不得 → -1
const JA = '日月火水木金土';
const ZH = '日一二三四五六';
function parseWeekday(v) {
  const s = String(v).trim().toLowerCase();
  const en = WEEK_EN.findIndex((w) => s.startsWith(w.toLowerCase()));
  if (en >= 0) return en;
  const ja = /^([日月火水木金土])(曜日?)?$/.exec(s);
  if (ja) return JA.indexOf(ja[1]);
  const zh = /^(?:周|週|星期|礼拜|禮拜)([一二三四五六日天])$/.exec(s);
  if (zh) return zh[1] === '天' ? 0 : ZH.indexOf(zh[1]);
  return -1;
}

const WEEK_WORDS = { this: 0, next: 1, after: 2, '0': 0, '1': 1, '2': 2 };
const WEEK_LABEL = ['this week', 'next week', 'the week after next'];

// 一个日期相对今天的位置, 按周一起算的周界(本周 / 下周 / 下下周)
function describe(d, today) {
  const n = dayDiff(today, d);
  const rel = n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n > 0 ? `in ${n} days` : `${-n} days ago`;
  const w = Math.floor((dayDiff(today, d) + (today.getDay() + 6) % 7) / 7);
  const wk = w >= 0 && w <= 2 ? ` · ${WEEK_LABEL[w]}` : '';
  return `${ymd(d)} ${WEEK_EN[d.getDay()]} (${rel}${wk})`;
}

function dateOp(a, now) {
  // date 配上挪动类参数 = 拿它当起点。11-08 个人版 dev: 传了 date + months, 只拿回 date 那天, 重调才对
  if (a.date !== undefined && a.from === undefined && a.to === undefined
    && [a.days, a.weeks, a.months, a.weekday].some((v) => v !== undefined)) {
    const { date, ...rest } = a;
    a = { ...rest, from: date };
  }
  const today = dayOnly(now);
  const from = a.from !== undefined ? parseDate(a.from) : today;
  if (!from) return `⚠️ from="${a.from}" is not a date YYYY-MM-DD.`;
  if (a.date !== undefined) {
    const d = parseDate(a.date);
    if (!d) return `⚠️ date="${a.date}" is not a real date YYYY-MM-DD.`;
    if (a.to === undefined) return describe(d, today);
    const t = parseDate(a.to);
    if (!t) return `⚠️ to="${a.to}" is not a real date YYYY-MM-DD.`;
    return `${dayDiff(d, t)} days from ${describe(d, today)} to ${describe(t, today)}`;
  }
  if (a.to !== undefined) {
    const t = parseDate(a.to);
    if (!t) return `⚠️ to="${a.to}" is not a real date YYYY-MM-DD.`;
    return `${dayDiff(from, t)} days from ${ymd(from)} to ${describe(t, today)}`;
  }
  if (a.weekday !== undefined) {
    const wd = parseWeekday(a.weekday);
    if (wd < 0) return `⚠️ weekday="${a.weekday}" not recognised — use Mon..Sun.`;
    if (a.week !== undefined && a.week !== '') {
      const w = WEEK_WORDS[String(a.week).trim().toLowerCase()];
      if (w === undefined) return `⚠️ week="${a.week}" — use this / next / after.`;
      const mon = new Date(from.getFullYear(), from.getMonth(), from.getDate() - (from.getDay() + 6) % 7 + 7 * w);
      const d = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + (wd + 6) % 7);
      return describe(d, today);
    }
    const ahead = ((wd - from.getDay() + 7) % 7) || 7;
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + ahead);
    const after = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7);
    return `${describe(d, today)} — the one after that is ${describe(after, today)}`;
  }
  if (a.days !== undefined || a.weeks !== undefined || a.months !== undefined) {
    const n = Number(a.days || 0) + 7 * Number(a.weeks || 0), mo = Number(a.months || 0);
    if (!Number.isInteger(n) || !Number.isInteger(mo)) return '⚠️ days / weeks / months must be whole numbers.';
    // 先挪月再挪天; 1-31 加一个月落在 2 月末, 不溢出到 3 月
    const last = new Date(from.getFullYear(), from.getMonth() + mo + 1, 0).getDate();
    const base = new Date(from.getFullYear(), from.getMonth() + mo, Math.min(from.getDate(), last));
    const clamped = mo && from.getDate() > last ? ` (that month has no day ${from.getDate()}, so its last day)` : '';
    return describe(new Date(base.getFullYear(), base.getMonth(), base.getDate() + n), today) + clamped;
  }
  // 何も効く引数が無い = 使い方が分かっていない。今日だけ返すと「答えをもらった」と思って自分で数え出す
  // (10-21 dev: query= を三回渡して三回とも今日しか返らず、10-28 を自分で出した)。表ごと返す。
  return `Today is ${describe(today, today)}. That is all you passed — to get a date, call again with:\n${OPS.date.hint}`
    + `\ne.g. sys(op='date', weekday='Tue', week='next')`;
}

const parseTime = (v) => {
  const m = /^\s*(\d{1,2})[:：時时](\d{2})?\s*分?\s*$/.exec(String(v));
  const min = m ? Number(m[1]) * 60 + Number(m[2] || 0) : NaN;
  if (!m || Number(m[2] || 0) > 59 || min > 1440) return null;   // 24:00 认作打烊时刻
  return min;
};
const hm = (min) => `${p2(Math.floor(min / 60))}:${p2(min % 60)}`;
const dur = (min) => (min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''} (${min} min)` : `${min} min`);

function timeOp(a, now) {
  const at = a.at !== undefined ? parseTime(a.at) : now.getHours() * 60 + now.getMinutes();
  if (at === null) return `⚠️ at="${a.at}" is not a time HH:MM.`;
  if (a.until !== undefined) {
    const u = parseTime(a.until);
    if (u === null) return `⚠️ until="${a.until}" is not a time HH:MM.`;
    const d = (u - at + 1440) % 1440;
    return `${hm(at)} → ${hm(u)}${u < at ? ' (next day)' : ''} = ${dur(d)}`;
  }
  if (a.minutes !== undefined || a.hours !== undefined) {
    const n = Number(a.minutes || 0) + 60 * Number(a.hours || 0);
    if (!Number.isFinite(n)) return '⚠️ minutes / hours must be numbers.';
    const t = at + Math.round(n);
    const day = Math.floor(t / 1440);
    const when = day === 0 ? '' : day === 1 ? ' (next day)' : day === -1 ? ' (previous day)' : ` (${day > 0 ? '+' : ''}${day} days)`;
    return `${hm(at)} ${n < 0 ? '−' : '+'} ${dur(Math.abs(Math.round(n)))} = ${hm(((t % 1440) + 1440) % 1440)}${when}`;
  }
  return `Now is ${hm(now.getHours() * 60 + now.getMinutes())}. That is all you passed — call again with:\n${OPS.time.hint}`
    + `\ne.g. sys(op='time', at='18:30', minutes=90)`;
}

// 四则运算的递归下降 —— 不用 eval: 参数是模型写的, 照样可能夹带别的东西
function evaluate(src) {
  const orig = String(src);
  const s = orig
    .replace(/[０-９．（）＋－＊／％]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[×xX]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-')
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1');   // 1,200 的千分位逗号
  let i = 0;
  const peek = () => { while (s[i] === ' ') i++; return s[i]; };
  const fail = (why) => { throw new Error(`${why} at position ${i + 1} of "${orig}"`); };
  function num() {
    const c = peek();
    if (c === '(') { i++; const v = sum(); if (peek() !== ')') fail('missing )'); i++; return v; }
    if (c === '-') { i++; return -num(); }
    if (c === '+') { i++; return num(); }
    const m = /^\d+(?:\.\d+)?|^\.\d+/.exec(s.slice(i));
    if (!m) fail(c === undefined ? 'unexpected end' : `unexpected "${c}"`);
    i += m[0].length;
    return Number(m[0]);
  }
  function prod() {
    let v = num();
    for (let c = peek(); c === '*' || c === '/' || c === '%'; c = peek()) {
      i++;
      const r = num();
      if ((c === '/' || c === '%') && r === 0) fail('division by zero');
      v = c === '*' ? v * r : c === '/' ? v / r : v % r;
    }
    return v;
  }
  function sum() {
    let v = prod();
    for (let c = peek(); c === '+' || c === '-'; c = peek()) { i++; v = c === '+' ? v + prod() : v - prod(); }
    return v;
  }
  const v = sum();
  if (peek() !== undefined) fail(`unexpected "${s[i]}"`);
  return v;
}

function mathOp(a) {
  let v;
  try { v = evaluate(a.expr); } catch (e) { return `⚠️ ${e.message}`; }
  const clean = Number(v.toPrecision(12));   // 1100.0000000000002 这种浮点尾巴
  if (a.round === undefined || a.round === '') return `${a.expr} = ${clean}`;
  const f = { floor: Math.floor, ceil: Math.ceil, round: Math.round }[String(a.round).toLowerCase()];
  if (!f) return '⚠️ round must be floor / ceil / round.';
  return `${a.expr} = ${clean} → ${a.round} ${f(clean)}`;
}

function sysOp(op, args, now = new Date()) {
  const a = args || {};
  const spec = OPS[op];
  if (!spec) return `⚠️ No op '${op}'. Available: ${Object.keys(OPS).join(' / ')}`;
  const usage = `sys(op='${op}', …) params: ${[...spec.req.map((k) => `${k}*`), ...spec.opt].join(', ')}\n${spec.hint}`;
  const unknown = Object.keys(a).filter((k) => !spec.req.includes(k) && !spec.opt.includes(k));
  if (unknown.length) return `⚠️ Unknown args: ${unknown.join(', ')}\n${usage}`;
  const missing = spec.req.filter((k) => a[k] === undefined || a[k] === null || a[k] === '');
  if (missing.length) return `Missing: ${missing.join(', ')}\n${usage}`;
  return spec.run(a, now);
}

// MCP 壳: 同 task / reminder 只有壳, 放这里是为了不再撑大 mcp-tools.js
// 🔴 参数は一段目に平らに置く(biz_do と同じ, biz-do/index.js makeBizDo の註)。`args={…}` に包む形だと、
// 外に書かれた鍵(10-21 dev: query=)を zod が黙って落とし、助手は空の呼び出しを三回して自分で数えた。
// 宣言してない鍵は SDK 側で落ちるので、全 op の参数名を全部宣言しておく。
function mcpTool(tool, z, desc) {
  const shape = { op: z.enum(Object.keys(OPS)) };
  for (const spec of Object.values(OPS)) for (const k of [...spec.req, ...spec.opt]) shape[k] = z.any().optional();
  return tool('sys', desc, shape, async ({ op, ...rest }) => {
    const given = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) given[k] = v;
    // 他の op の参数は sysOp が Unknown args で表ごと返す
    return { content: [{ type: 'text', text: String(sysOp(op, given)) }] };
  });
}

module.exports = { OPS, sysOp, mcpTool, parseWeekday, WEEK_EN };
