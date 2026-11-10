// tool-dates.js — 工具结果里出现的日期, 由程序在末尾附一行星期, 助手照抄不脑算。
//
// 起因: 11-08 行业版助手查预约走 biz_do sql, 结果里只有「2026-11-11」, 星期它自己算, 好几次写成「（火）」(实为周三)。
// 10-16 离线 A/B 早有结论: 只在提示语里提醒仍约 8/10 错, 把事实直接写进工具回执 20/20 对。
// 作者 11-08 定「四道关」: ① 这里(拿数据时附上) ② 提示语要求所有计算调 sys ③ 写库前 weekdayGuard ④ 说出口后 weekday-check 打回。
//
// 🔴 原文一个字不改, 只在前面另加一段 text: 把「2026-11-11 (Wed)」塞进原值, 助手会原样抄进改预约的参数里。
// 跳过: sys 自己就报星期; memory_* 的命题里日期是记录时间, 附上只是每轮白花 token。
'use strict';

const WEEK_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEK_JA = '日月火水木金土';
const WEEK_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const HEAD = 'Day of the week for each date below, computed by the system — copy it, do not work it out: ';
const SKIP = (name) => name === 'sys' || /^memory_/.test(name || '');
const MAX = 40;   // 整张表导出时不至于附出一大段
// 2026-11-11 / 2026/11/11, 后面可以紧跟 T10:00 或空格时刻; 前后不能再是数字
const RE = /(?<!\d)(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?!\d)/g;

// 文本里出现的不重复日期 → 'Day of the week for each date below, computed by the system — copy it, do not work it out:
//   2026-11-11 = Wed 水 周三 · …'; 没有就 ''
// 🔴 11-08 dev: 早先只附一行 `Weekdays: 2026-11-11 Wed` 在末尾, haiku 全新会话里照样写「（火）」。
//    改成放最前、写明照抄、直接给出它要写的那个字(水 / 周三), 它不用再从 Wed 换算。
function weekdayLine(text) {
  if (typeof text !== 'string' || !text) return '';
  const seen = new Map();
  let m;
  RE.lastIndex = 0;
  while ((m = RE.exec(text)) && seen.size < MAX) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const dt = new Date(y, mo - 1, d);
    if (dt.getMonth() !== mo - 1 || dt.getDate() !== d) continue;   // 2026-02-30 这种不存在的日期不碰
    const key = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const w = dt.getDay();
    if (!seen.has(key)) seen.set(key, `${WEEK_EN[w]} ${WEEK_JA[w]} ${WEEK_ZH[w]}`);
  }
  if (!seen.size) return '';
  return HEAD + [...seen].map(([k, w]) => `${k} = ${w}`).join(' · ');
}

// MCP 工具结果 { content: [{type:'text', text}, …] } → 最前面另加一段星期行; 形状不对原样返回
function annotate(name, result) {
  if (SKIP(name) || !result || !Array.isArray(result.content)) return result;
  const text = result.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
  const line = weekdayLine(text);
  if (!line) return result;
  return { ...result, content: [{ type: 'text', text: line }, ...result.content] };
}

module.exports = { weekdayLine, annotate };
