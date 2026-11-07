// test-now-stamp.js — 每条消息头上的本机时刻戳 (作者 2026-08-13: "注入只有日期没有时间")
// 运行: node test-now-stamp.js
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const path = require('path');
const { nowStamp } = require('../core/agent');

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { if (ok) { pass++; console.log(`  ✅ ${name}${extra ? ' · ' + extra : ''}`); } else { fail++; console.error(`  ❌ ${name}${extra ? ' · ' + extra : ''}`); } };

console.log('\n[1] 格式: 年-月-日 时:分 + 星期');
// 🔴 英文: 这一行只有模型读得到、用户在窗口里看不见 —— 内部文本一律英文, 不跟界面语言变。
// (它是全仓出现频率最高的引擎文本, 每轮盖一次。)
const s = nowStamp(new Date(2026, 7, 13, 9, 5));   // 2026-08-13 周四
t('整体形状', s.split('\n')[0] === '(Now 2026-08-13 09:05 Thu)', JSON.stringify(s));
t('时分补零', /09:05/.test(s));
t('自带换行(不粘住正文)', s.endsWith('\n'));

console.log('\n[2] 本机时区, 不是 UTC');
const d = new Date(2026, 0, 1, 0, 30);
t('跨时区不漂', nowStamp(d).includes('2026-01-01 00:30'), nowStamp(d).trim());

console.log('\n[3] 星期七天都对');
const wk = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let wkOk = true;
for (let i = 0; i < 7; i++) {
  const day = new Date(2026, 7, 9 + i);           // 2026-08-09 是周日
  if (!nowStamp(day).split('\n')[0].endsWith(wk[i] + ')')) wkOk = false;
}
t('周日→周六逐个对上', wkOk);

console.log('\n[3b] 第二行要求调 sys 算日期, 不列日历表');
{
  const lines = s.split('\n');
  t('只有两行', lines.length === 3 && lines[2] === '', JSON.stringify(s));
  t('要求用 sys 算', lines[1].includes("sys(op='date')"));
  t('不列日历', !/\d\d-\d\d \w{3}/.test(lines[1]));
}

console.log('\n[4] 接线: submit 真把戳拼进消息正文');
const src = require('./kernel-src').kernelSource();
t('submit 里调了 nowStamp', /const _stamped = typeof text === 'string' \? nowStamp\(/.test(src));
t('非字符串 text 不被隐式转字符串', /typeof text === 'string' \? nowStamp\(\) \+ text : text/.test(src));
// 注入顺序: 自动召回 → 能力细则 → 插件提示 → 记忆提醒 → 带戳的用户原话。
// 前四段彼此先后不敏感; 敏感的是它们整体在用户原话之前 —— 排到原话后面就会看起来像用户刚说的话。
t('前置块仍在时刻戳之前', /_pre \? _pre \+ _stamped : _stamped/.test(src));
// 这条原来写的是「检索结果不许混进来」, 守的是"每轮查一次但一个字都不给"那个旧口径。
// 该口径已被推翻: 够得上高档(tier_hi)的现在**要**注入, 只是只给主键 + 命题行不给正文。
// 断言跟着改成守新口径的两条: 各段齐全 · 召回排在最前(它是"你以前记过什么", 读的时候
// 该先于"你该动用什么能力"; 而且它离用户原话最远, 最不容易被误读成用户刚说的话)。
// 常驻插件提示那段已于 3900b0a 撤掉(能力改由工具名自己承载)。
t('🔴 前置块四段齐全, 顺序是 召回 → 细则 → 提醒 → 当天开场(一天一次)',
  /const _pre = `\$\{_recall\}\$\{_shard\}\$\{_nudge\}\$\{_opener\}`/.test(src));
// 唤醒不许再垫进原话前面: 新会话第一轮原话前垫着唤醒/机器文字, 模型把整条当开机信号, 回句寒暄、
// 店主交代的规矩不存(2026-10-13 行业版 0/3)。改成单独一轮, submit 入口先等它跑完(compact.js startWake)。
t('🔴 唤醒不进前置块', !/\$\{_wake\}/.test(src));
t('🔴 submit 入口先等唤醒跑完', /await this\._awaitWake\(\)/.test(src));
// 只提示不冒名: 注入块必须自带可辨识抬头。没抬头的话那几行会像是用户自己贴上来的资料,
// 于是"未必用得上"这层保留就没了 —— 而它恰恰是低地板能成立的前提。
t('🔴 召回注入带抬头(不冒充用户说的话)', /c\.inject_heading/.test(src));
// 判"该沉没沉"用的是用户原话, 不能被戳污染, 否则关键词匹配会错位
const idxStamp = src.indexOf('const _stamped =');
const idxTurnText = src.indexOf('this._turnUserText =');
t('_turnUserText 取的是原话(赋值在盖戳之前)', idxTurnText > 0 && idxTurnText < idxStamp);

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
