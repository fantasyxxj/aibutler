// test-auto-nudge-labeled.js — 系统自动注入的文案必须自报家门。
//
// 病根 (2026-09-26): 体检提示走 `agent.submit(..., {sourceKind:'auto'})` 注入, 而 submit
// 把它包成 `role:'user'`(core/agent/stream.js:52) —— 在模型眼里, 它和店主亲手打的字**完全
// 一样**。实地后果: 店主问「今天我跟你说了什么」, 助手把整份体检提示当成店主的原话贴了出来。
//
// 🔴 注意分清两件事, 别修错地方:
//   · app 的对话记录(convo/getHistory)是**干净的** —— `pushUser` 只在界面那条 IPC 里调,
//     自动注入根本不经过它。
//   · 混淆只发生在**模型自己的上下文**里。所以解法不在存储层, 在文案第一行。
//
// 约定早就存在(task_continue / empty_turn_retry / clear_sediment / force_sediment /
// redline_output / lost_toolcall_retry 六份都有), 只是 checkup_nudge 与 save_nudge 三档
// 漏了。漏了不报错, 只是某天助手把系统内务当成人话复述出来。
'use strict';
const fs = require('fs');
const path = require('path');

const MAIN = path.join(__dirname, '..', 'core', 'config', 'main');
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };

// 判据: 剥掉空行后的第一行是一对括号, 且里面点明"不是用户/人说的话"或标了 System/butler。
// 不锁死具体措辞 —— 六份既有文案的写法本来就不统一(System · / butler auto-continue ·),
// 锁死等于逼后来的人抄字符串, 而真正要的只是"读第一行就知道这不是人说的"。
const SELF_LABEL = /^\s*[(（][^)）]*(?:System|システム|系统|系統|butler|not a user|not a human|不是用户|不是使用者|発言ではありません)[^)）]*[)）]/i;

function firstLine(file) {
  const s = fs.readFileSync(file, 'utf8');
  return (s.split('\n').find((l) => l.trim()) || '');
}

// .md 文案
const MD = [
  'checkup_nudge.md', 'checkup_nudge.zh-CN.md', 'checkup_nudge.zh-TW.md', 'checkup_nudge.ja.md',
  'save_nudge_soft.md', 'save_nudge_tight.md', 'save_nudge_urgent.md',
  'task_continue.md', 'empty_turn_retry.md', 'clear_sediment.md',
];
console.log('[自动注入的 .md 文案要自报家门]');
for (const f of MD) {
  const p = path.join(MAIN, f);
  if (!fs.existsSync(p)) { ok(false, `${f} 不存在`); continue; }
  const l = firstLine(p);
  ok(SELF_LABEL.test(l), `${f} —— ${l.slice(0, 48)}`);
}

// json 里带 template 的那几条走同一条注入通道
console.log('\n[json 模板同样要自报家门]');
for (const k of ['force_sediment', 'redline_output', 'lost_toolcall_retry']) {
  const p = path.join(MAIN, k + '.json');
  if (!fs.existsSync(p)) { ok(false, `${k}.json 不存在`); continue; }
  const t = String(JSON.parse(fs.readFileSync(p, 'utf8')).template || '');
  ok(SELF_LABEL.test(t), `${k} —— ${t.slice(0, 48)}`);
}

// 代码里硬编码的那几条走同一条 submit 通道, config 目录扫不到它们 —— 而"扫不到"正是
// 它们当初漏掉的原因, 所以这里按实际产出验, 不按源码字符串验。
console.log('\n[代码里硬编码的注入文本]');
{
  const sched = require('../core/schedule');
  const body = sched.buildPrompt({ id: 'x', cron: '0 10 * * 1', prompt: 'do the thing' }, '/tmp');
  ok(SELF_LABEL.test((body || '').split('\n')[0]), `定时唤醒 —— ${(body || '').split('\n')[0].slice(0, 52)}`);

  const iw = fs.readFileSync(path.join(__dirname, '..', 'core', 'idle-watcher.js'), 'utf8');
  const hb = (iw.match(/'\[\[HEARTBEAT\]\][^']*'/) || [''])[0];
  // 🔴 [[HEARTBEAT]] 这个前缀被 stream.js 与 industry-agent.js 的 startsWith 当判据,
  //    自报家门只能跟在它后面, 不能插到前面 —— 插了保活就认不出来, 会被当成真交互计费。
  ok(hb.startsWith("'[[HEARTBEAT]]"), '保活前缀仍在最前(被 startsWith 当判据)');
  ok(SELF_LABEL.test(hb.replace('[[HEARTBEAT]] ', '').slice(1)), `保活 —— ${hb.slice(1, 60)}`);

  const ag = fs.readFileSync(path.join(__dirname, '..', 'core', 'agent.js'), 'utf8');
  ok(/\(System · model switched · not a user message\)/.test(ag), '模型切换通知自报家门且是英文');
}

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
