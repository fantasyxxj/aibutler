// weekday-check.js — 找出文中「日期（星期）」配错的地方, 交给调用方打回, 不替它改。
//
// 🔴 以前这里叫 weekday-fix, 在出口悄悄把星期改对。作者 10-14 指出那是在掩盖错误: 模型把「土曜」
//    算成 10-18 存进预约时, 回复写「10月18日（土）」, 日期和星期对不上是唯一露馅的地方; 改成
//    「（日）」后看着一致了, 库里的日期照样错。哪一半是对的这里判断不了, 所以只报不改,
//    由助手拿 sys(op='date') 重算、连同记录一起改对 —— 日期的计算见 core/sys-tool.js。
//
// 认的写法(括号全角半角都认): `10月13日（水）` `2026年10月13日(水曜日)` `10/13（火）`
//   `10月13日（周三）` `10月13日(星期三)` `10月13日（週三）` `2026-10-13（水）`。
//   星期不在括号里也认: `10月13日は水曜日` `10月13日 水曜` `10月13日是星期三` `10月13日周三` —— 括号外的日文要带「曜」,
//   单个「水」字太容易是别的意思。(作者 11-08 批补横杠与括号外两种; 仍是兜底, 写法不在名单上照样漏)
//   英文: `Friday, October 25th` `Fri 25 Oct` `October 25 (Fri)` —— 10-21 dev 实测助手给客人写了
//   「Friday, October 25th」(25 日是周日), 只认中日写法时这道闸看不见它。
// 没写年份时取离今天最近的那一年(跨年的「1月5日」在 12 月说就是明年)。
'use strict';

const WEEK_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const JA = '日月火水木金土';
const ZH = '日一二三四五六';

const RE = new RegExp(
  '(?:(\\d{4})\\s*年\\s*)?(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*日'      // 2026年10月13日 / 10月13日
  + '|(?:(\\d{4})\\/)?(\\d{1,2})\\/(\\d{1,2})'                      // 2026/10/13 / 10/13
  + '|(?<!\\d)(\\d{4})-(\\d{1,2})-(\\d{1,2})(?!\\d)',                     // 2026-10-13
  'g');
// 日期后紧跟的星期: 括号里的「（水）」, 或括号外的「は水曜日」「 星期三」。只吃一个。
const WD = new RegExp('^\\s*(?:'
  + '[（(]\\s*(?:([日月火水木金土])(?:曜日?)?|(?:周|週|星期)([一二三四五六日天]))\\s*[）)]'
  + '|(?:は|、|，|,|是|为|為)?\\s*(?:([日月火水木金土])曜日?|(?:星期|周|週|礼拜|禮拜)([一二三四五六日天])))');

const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WDN = '(sun|mon|tue|wed|thu|fri|sat)[a-z]*\\.?';
const MN = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
const DN = '(\\d{1,2})(?:st|nd|rd|th)?';
// 星期在前(Friday, October 25th · Fri 25 Oct)或月日后括号里(October 25 (Fri))。
const RE_EN = new RegExp(
  `\\b${WDN},?\\s+(?:${MN}\\s+${DN}|${DN}\\s+(?:of\\s+)?${MN})\\b`
  + `|\\b${MN}\\s+${DN}\\s*\\(\\s*${WDN}\\s*\\)`, 'gi');

function checkEn(text, today, out) {
  let m;
  RE_EN.lastIndex = 0;
  while ((m = RE_EN.exec(text))) {
    const wd = (m[1] || m[8]).toLowerCase(), mon = (m[2] || m[5] || m[6]).toLowerCase();
    const month = MON.indexOf(mon) + 1, day = Number(m[3] || m[4] || m[7]);
    if (!month || day < 1 || day > 31) continue;
    const y = pickYear(month, day, today);
    const d = new Date(y, month - 1, day);
    if (d.getMonth() !== month - 1) continue;
    if (WEEK_EN[d.getDay()].toLowerCase() === wd) continue;
    const p2 = (n) => String(n).padStart(2, '0');
    out.push({ written: m[0], date: `${y}-${p2(month)}-${p2(day)}`, actual: WEEK_EN[d.getDay()] });
  }
}

function pickYear(month, day, now) {
  const y = now.getFullYear();
  let best = y, bestGap = Infinity;
  for (const cand of [y - 1, y, y + 1]) {
    const gap = Math.abs(new Date(cand, month - 1, day) - now);
    if (gap < bestGap) { best = cand; bestGap = gap; }
  }
  return best;
}

// → [{ written: '10月18日（土）', date: '2026-10-18', actual: 'Sun' }]; 全对返回 []
function check(text, now) {
  if (typeof text !== 'string' || !text) return [];
  const today = now instanceof Date ? now : new Date();
  const out = [];
  let m;
  RE.lastIndex = 0;
  while ((m = RE.exec(text))) {
    const year = m[1] || m[4] || m[7], month = Number(m[2] || m[5] || m[8]), day = Number(m[3] || m[6] || m[9]);
    const end = m.index + m[0].length;
    const w = WD.exec(text.slice(end));
    if (!w || month < 1 || month > 12 || day < 1 || day > 31) continue;
    const y = year ? Number(year) : pickYear(month, day, today);
    const d = new Date(y, month - 1, day);
    if (d.getMonth() !== month - 1) continue;   // 2月30日 这类不存在的日期不碰
    const ja = w[1] || w[3], zh = w[2] || w[4];
    const said = ja ? JA.indexOf(ja) : (zh === '天' ? 0 : ZH.indexOf(zh));
    if (said === d.getDay()) continue;
    const p2 = (n) => String(n).padStart(2, '0');
    out.push({ written: m[0] + w[0], date: `${y}-${p2(month)}-${p2(day)}`, actual: WEEK_EN[d.getDay()] });
  }
  checkEn(text, today, out);
  return out;
}

module.exports = { check };
