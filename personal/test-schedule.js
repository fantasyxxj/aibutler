// test-schedule.js — 无头验证 W4 调度器 (schedule.js: cron 解析/命中/注册表装载/到点去重/prompt 组装)
// 跑法: node test-schedule.js   只用 tmp scratch 目录, 不碰任何活体人格。

const fs = require('fs');
const path = require('path');
const os = require('os');
const S = require('../core/schedule.js');

const HOME = path.join(os.tmpdir(), 'butler-sched-test-' + Date.now());
fs.mkdirSync(HOME, { recursive: true });

let pass = 0, fail = 0;
const assert = (actual, expected, label) => {
  const ok = actual === expected;
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); fail++; }
};
// 本地时区构造: 2026-07-20 是周一
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi);

console.log('\n[1] parseCron 合法/非法');
assert(!!S.parseCron('0 10 * * 1'), true, '标准5段');
assert(!!S.parseCron('*/5 * * * *'), true, '步进 */5');
assert(!!S.parseCron('0 9-18 * * 1-5', ), true, '范围');
assert(!!S.parseCron('0,30 10 1,15 * *'), true, '逗号列表');
assert(S.parseCron('0 10 * *'), null, '4段拒绝');
assert(S.parseCron('61 10 * * *'), null, '分越界拒绝');
assert(S.parseCron('0 10 * * 8'), null, '周8越界拒绝');
assert(S.parseCron('a 10 * * *'), null, '非法字符拒绝');

console.log('\n[2] cronMatches 命中语义');
const weekly = S.parseCron('0 10 * * 1');
assert(S.cronMatches(weekly, at(2026, 7, 20, 10, 0)), true, '周一10:00 命中');
assert(S.cronMatches(weekly, at(2026, 7, 20, 10, 1)), false, '10:01 不中');
assert(S.cronMatches(weekly, at(2026, 7, 21, 10, 0)), false, '周二不中');
const sun7 = S.parseCron('0 10 * * 7');
assert(S.cronMatches(sun7, at(2026, 7, 19, 10, 0)), true, '周7=周日归一命中');
const monthly = S.parseCron('0 10 28 * *');
assert(S.cronMatches(monthly, at(2026, 7, 28, 10, 0)), true, '每月28日命中');
assert(S.cronMatches(monthly, at(2026, 7, 27, 10, 0)), false, '27日不中');
const both = S.parseCron('0 10 15 * 1'); // dom+dow 都受限 → OR 语义(cron 传统)
assert(S.cronMatches(both, at(2026, 7, 15, 10, 0)), true, 'dom 命中(周三)即触发');
assert(S.cronMatches(both, at(2026, 7, 20, 10, 0)), true, 'dow 命中(20非15日)即触发');
assert(S.cronMatches(both, at(2026, 7, 21, 10, 0)), false, 'dom/dow 都不中');
const seasonal = S.parseCron('0 10 15 3 *');
assert(S.cronMatches(seasonal, at(2026, 3, 15, 10, 0)), true, '3月15日命中');
assert(S.cronMatches(seasonal, at(2026, 4, 15, 10, 0)), false, '4月不中');

console.log('\n[3] loadRegistry 默认关 + 坏条目跳过不拒载');
assert(S.loadRegistry(HOME), null, '无 schedule.json → null(默认关)');
fs.writeFileSync(path.join(HOME, 'schedule.json'), JSON.stringify({ enabled: false, entries: [{ id: 'a', cron: '0 10 * * 1', prompt: 'x' }] }));
assert(S.loadRegistry(HOME), null, 'enabled=false → null');
fs.writeFileSync(path.join(HOME, 'schedule.json'), '{broken json');
assert(S.loadRegistry(HOME), null, '坏 JSON → null 不炸');
fs.writeFileSync(path.join(HOME, 'schedule.json'), JSON.stringify({
  entries: [
    { id: 'good_inline', cron: '0 10 * * 1', prompt: '这周有什么新菜?' },
    { id: 'bad_cron', cron: 'not a cron', prompt: 'x' },
    { cron: '0 10 * * 1', prompt: '缺id' },
    { id: 'no_prompt', cron: '0 10 * * 1' },
    { id: 'good_ref', cron: '30 17 * * 4', prompt_ref: 'prompts/weekend.md' },
  ],
}));
const warns = [];
const reg = S.loadRegistry(HOME, (m) => warns.push(m));
assert(reg.entries.length, 2, '5条装2条(3坏跳过)');
assert(reg.entries.map((e) => e.id).join(','), 'good_inline,good_ref', '存活条目正确');
assert(warns.length, 3, '3条 warn 日志');

console.log('\n[4] dueEntries 到点 + 去重 + 忙时补扫');
const lastFired = {};
const mon10 = at(2026, 7, 20, 10, 0);
let due = S.dueEntries(reg, mon10, mon10.getTime() - 60000, lastFired);
assert(due.length, 1, '周一10:00 触发1条');
assert(due[0].entry.id, 'good_inline', '触发的是 good_inline');
lastFired[due[0].entry.id] = due[0].key;
due = S.dueEntries(reg, mon10, mon10.getTime() - 60000, lastFired);
assert(due.length, 0, '同分钟已触发 → 去重不重放');
// 忙时补扫: since=09:58, now=10:02 → 10:00 落在窗口内仍触发
due = S.dueEntries(reg, at(2026, 7, 20, 10, 2), at(2026, 7, 20, 9, 58).getTime(), {});
assert(due.length, 1, '处理忙了几分钟, 10:00 补扫命中');
assert(due[0].key, '2026-07-20T10:00', '触发键=错过的那一分钟');
// 重启语义: 调用方把 since 设为现在 → 不补历史
due = S.dueEntries(reg, at(2026, 7, 20, 10, 5), at(2026, 7, 20, 10, 5).getTime(), {});
assert(due.length, 0, 'since=now(重启) → 不吃历史');
// 封顶60分钟回看
due = S.dueEntries(reg, at(2026, 7, 20, 12, 0), at(2026, 7, 20, 8, 0).getTime(), {});
assert(due.length, 0, '超60分钟窗口的错过不补(10:00 距 12:00 =120min)');

console.log('\n[5] buildPrompt 内联 / prompt_ref / 缺文件');
const p1 = S.buildPrompt(reg.entries[0], HOME);
assert(p1.includes('这周有什么新菜?'), true, '内联 prompt 进正文');
assert(p1.startsWith('(System · scheduled wake · good_inline · cron 0 10 * * 1 · not a user message)'), true, '带调度头, 且自报家门');
assert(S.buildPrompt(reg.entries[1], HOME), null, 'prompt_ref 文件不存在 → null');
fs.mkdirSync(path.join(HOME, 'prompts'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'prompts/weekend.md'), '週末のご予約で準備が必要なものは?');
const p2 = S.buildPrompt(reg.entries[1], HOME);
assert(p2.includes('週末のご予約で準備が必要なものは?'), true, 'prompt_ref 相对路径整文注入');

console.log(`\n结果: ${pass} 过 / ${fail} 挂`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
