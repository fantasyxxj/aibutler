// test-quit-no-dialog-on-signal.js — 走信号退出时, 退出链上一个同步弹框都不许有。
//
// 为什么有这条闸(2026-08-27 实撞, 同一个坑踩了两次):
//   `dialog.showMessageBoxSync` 是**同步阻塞**的。点窗口 ✕ 那条路有人在现场, 弹框是有意设计
//   (防手滑关掉整个 butler); 但走 SIGTERM/SIGINT 进来时**发信号那方不在场**, 没人点得动 ——
//   于是进程不退、CPU 还在转、CDP 还通, 与真卡死无法区分, 只能 kill -9。
//
//   第一次踩: 入口那个确认框堵死, 修了。
//   第二次踩: 同一个函数里**沉淀失败后还有第二个框**, 上次整个漏掉 —— 实测卡了 40 分钟。
//
// 所以判据必须是「把 runQuitFlow 里所有 showMessageBoxSync 数一遍, 每一个都在 interactive 闸后面」,
// 而不是「我改的那处不弹了」。新增第三个框而忘了加闸, 这条会红。
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

const SRC = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

// 取函数体: 从形参列表的右括号之后那个 { 开始配对 —— 不能从函数名后第一个 { 起,
// 那是参数解构的花括号(`function f({a} = {})`), 会在函数体开始前就配平, 抠出个空壳还全绿。
function fnBody(src, name) {
  const at = src.indexOf(`function ${name}(`);
  if (at === -1) return null;
  let i = src.indexOf('(', at), d = 0, argEnd = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '(') d++;
    else if (src[j] === ')' && --d === 0) { argEnd = j; break; }
  }
  if (argEnd === -1) return null;
  const open = src.indexOf('{', argEnd);
  if (open === -1) return null;
  d = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(at, j + 1);
  }
  return null;
}

console.log('\n== 被测代码取得到 ==');
const body = fnBody(SRC, 'runQuitFlow');
ok(!!body, 'main.js 里有 runQuitFlow');
ok(!!body && body.length > 500, `抠出来的是真函数体而不是空壳(${body ? body.length : 0} 字符)`);
if (!body) { console.log(`\n结果: ${pass} pass, ${fail + 1} fail`); process.exit(1); }

console.log('\n== 🔴 每一个同步弹框都要在 interactive 闸后面 ==');
{
  const boxes = [...body.matchAll(/showMessageBoxSync/g)];
  ok(boxes.length > 0, `退出链里确实有同步弹框(${boxes.length} 个) —— 一个都没有的话这条闸没意义了, 该重写`);
  for (const m of boxes) {
    const before = body.slice(0, m.index);
    ok(/if \(!interactive\)/.test(before),
       `🔴 第 ${boxes.indexOf(m) + 1} 个弹框前面有 interactive 闸(没有 → 信号退出会永久堵死)`);
  }
  ok(/function runQuitFlow\(\{ interactive = true \} = \{\}\)/.test(body),
     'runQuitFlow 收 interactive 参数, 默认 true(点击路径行为不变)');
}

console.log('\n== 🔴 信号进来时必须传 interactive:false ==');
{
  ok(/for \(const sig of \['SIGTERM', 'SIGINT'\]\)/.test(SRC), '接了 SIGTERM/SIGINT');
  const sigPart = SRC.slice(SRC.indexOf("for (const sig of ['SIGTERM'"));
  ok(/runQuitFlow\(\{ interactive: false \}\)/.test(sigPart.slice(0, 600)),
     '🔴 信号处理器调 runQuitFlow({interactive:false})');
  // 点击那条路要保持原样: 有人在现场, 弹框是防手滑的有意设计
  const clickPart = SRC.slice(0, SRC.indexOf("for (const sig of ['SIGTERM'"));
  ok(/if \(choice === 0\) void runQuitFlow\(\);/.test(clickPart),
     '点 ✕ 那条路仍走默认(interactive=true), 确认框照弹 —— 那是防误关的有意设计');
}

console.log('\n== 🔴 退出沉淀要有自己的硬上限 ==');
{
  // 2026-09-13: 这套上限从 main.js 搬进了 quit-sediment.js(main.js 已过 500 行上限), 守卫跟着搬
  const QS = fs.readFileSync(path.join(__dirname, 'quit-sediment.js'), 'utf8');
  ok(/QUIT_SEDIMENT_HARD_CAP_MS = (\d+)/.test(QS), '有 QUIT_SEDIMENT_HARD_CAP_MS');
  const cap = Number((QS.match(/QUIT_SEDIMENT_HARD_CAP_MS = (\d+)/) || [])[1]);
  ok(cap > 0 && cap <= 300000, `硬上限 ${cap / 1000}s, 在 5 分钟以内 —— 不传的话吃默认 10 分钟, 用户眼里就是关不掉`);
  ok(/hardCapMs: opts\.hardCapMs \|\| QUIT_SEDIMENT_HARD_CAP_MS/.test(QS),
     '🔴 真的传给了 doClearWithSediment(deadlineMs 只在人格停止活动时才判超时, 还在跑就一直等 —— 决定"最坏等多久"的是 hardCap)');
  ok(/keepContextOnSedimentFail: true/.test(QS),
     '掐断不丢活: 沉不成就不清空, 上下文原样留着下次再沉');
  // 🔴 病根是首字延迟不是人格磨蹭: 一段式上限会被"排队等首字"吃光, 留给干活的时间不够
  const after = Number((QS.match(/QUIT_SEDIMENT_IDLE_KILL_MS = (\d+)/) || [])[1]);
  ok(after > 0, `开口后改看"停手多久", 连着 ${after / 1000}s 没产出才判死 —— 首字前后是两笔账, 不共用一个预算`);
  ok(/idleKillMs: opts\.idleKillMs \|\| QUIT_SEDIMENT_IDLE_KILL_MS/.test(QS),
     '🔴 idleKillMs 真的传下去了, 不是只定义了个常量');
  const budget = Number((QS.match(/QUIT_SEDIMENT_TOTAL_BUDGET_MS = (\d+)/) || [])[1]);
  ok(budget >= cap + after,
     `整条退出链有总预算 ${budget / 1000}s, 且不小于单人格最坏耗时 —— 串行之后没有它就会按人格数叠加成十几分钟`);
}

console.log('\n== 🔴 退出沉淀必须串行, 不许 Promise.all ==');
{
  const QS = fs.readFileSync(path.join(__dirname, 'quit-sediment.js'), 'utf8');
  ok(/for \(const x of items\)/.test(QS) && !/await Promise\.all/.test(QS),
     '🔴 一个一个来 —— 并发是首字延迟的放大器, 全员排队等第一个 token, 然后一起撞上限一起失败');
  ok(/Math\.min\(QUIT_SEDIMENT_HARD_CAP_MS, left\)/.test(QS),
     '每个人格拿到的硬上限 = min(自己的上限, 剩下的总预算)');
  const quitPart = SRC.slice(SRC.indexOf('async function runQuitFlow'));
  ok(/sedimentSerially\(dirtyItems/.test(quitPart.slice(0, 1500)) && !/Promise\.allSettled/.test(quitPart.slice(0, 1500)),
     '🔴 runQuitFlow 走串行那条路, 老的 Promise.allSettled 已经删干净');
  // 🔴 不防重入的话串行只是纸面上的: 2026-09-13 真机实撞两个 SIGTERM 开出两条退出链, 各自串行、彼此并发
  ok(/if \(!beginQuit\(\)\) return;/.test(quitPart.slice(0, 900)),
     '🔴 退出链进门先 beginQuit() —— 第二个信号不许开第二条链');
  const { beginQuit, endQuit } = require('./quit-sediment');
  ok(beginQuit() === true && beginQuit() === false, 'beginQuit 第一次放行、第二次挡住');
  endQuit();
  ok(beginQuit() === true, 'endQuit 之后能再退一次 —— "取消退出·一会再关"那条路不能把自己锁死');
  endQuit();
}

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
