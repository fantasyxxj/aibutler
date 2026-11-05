// test-turn-release.js — 回合被扣住之后, 追加那一轮没发出去也必须放开界面。
//
// 复现的病(2026-09-27, 与静音闩锁、心跳标记同族): consume 里四条路把这一轮扣住不放行,
// 靠随后追加的一轮补收尾。而 submit 有三处不会入队, 其中两处是**裸 return 不抛异常** ——
// 挂起期间拒绝自动轮 / 限流闸被 interrupt 取消。撞上就是 onResult 与 onTurnEnd 双双不发:
// 界面永久转圈、正文一个字不出、没有自愈。判据统一用 `_turnSeq` 有没有涨。
require('./host-wiring');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-turn-release-'));
fs.mkdirSync(path.join(tmp, 'memory'), { recursive: true });

const { Butler } = require('../core/agent');
const { retryOrReleaseTurn } = require('../core/agent/turn-release');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const tick = () => new Promise((r) => setTimeout(r, 20));

function fresh(name) {
  const b = new Butler(tmp, { name });
  const shown = [], ended = [];
  b.setCallbacks({
    onText: () => {}, onActivity: () => {}, onTool: () => {}, onToolDone: () => {},
    onUsage: () => {}, onResult: (r) => shown.push(r.finalText), onTurnEnd: (d) => ended.push(d),
  });
  return { b, shown, ended };
}

(async () => {
  console.log('[追加那一轮没入队 → 必须放回被扣住的这一轮]');

  // ①a 挂起期间的形态(真人那一轮): submit 什么都不做就返回(不抛), _turnSeq 不涨
  {
    const { b, shown, ended } = fresh('静默拒绝体');
    let asked = null;
    b._askPending.push((v) => { asked = v; });
    retryOrReleaseTurn(b, 'force-sediment', async () => { /* 挂起中, 裸 return, 不抛 */ },
      { finalText: '被扣住的正文', interrupted: false });
    await tick();
    ok(shown[0] === '被扣住的正文', '🔴 正文放回去了(老代码这里一个字都不出)');
    ok(ended.length === 1, '🔴 onTurnEnd 也发了(渲染层的 busy 靠它复位, 不发就永久转圈)');
    ok(asked === '被扣住的正文', '挂起的 askOnce 被兑现(先进先出对齐, 不兑现它永远等不到)');
  }

  // ①b 扣住的那一轮本身正被静音罩着(内务轮撞了红线之类): 正文**不该**上屏 —— 那是自言自语。
  //     但 busy 必须放开, 靠 onTurnEnd; 静音本身也要清掉, 留着就又是一个闩锁。
  {
    const { b, shown, ended } = fresh('静音轮体');
    b._turnMuted = true; b._turnClaimed = true;
    retryOrReleaseTurn(b, 'redline-out', async () => { /* 没入队 */ },
      { finalText: '这是它的自言自语', interrupted: false });
    await tick();
    ok(shown.length === 0, '静音轮的正文不推上屏(独白不该冒出来)');
    ok(ended.length === 1 && ended[0].muted === true, '🔴 但 onTurnEnd 照发且标 muted → 宿主补一条空 turn-result 放开 busy');
    ok(b._turnMuted === false && b._turnClaimed === false, '这一轮就此收尾, 静音与认领一起清掉(否则下一轮沿用它)');
  }

  // ② 真抛异常的形态
  {
    const { b, shown, ended } = fresh('抛异常体');
    retryOrReleaseTurn(b, 'redline-out', async () => { throw new Error('起子进程失败'); },
      { finalText: '红线那段', interrupted: false });
    await tick();
    ok(shown[0] === '红线那段' && ended.length === 1, 'submit 抛异常同样放回这一轮');
  }

  // ③ 真入队了 → 收尾归那一轮, 这里一个字都不许补
  {
    const { b, shown, ended } = fresh('正常体');
    retryOrReleaseTurn(b, 'empty-turn', async () => { b._turnSeq += 1; },
      { finalText: '不该出现', interrupted: false });
    await tick();
    ok(shown.length === 0 && ended.length === 0,
       '🔴 追加那一轮真发出去了就不补收尾(补了会多一条重复气泡 + 假未读)');
  }

  console.log('\n[源码门禁 · 四条不放行的路都得走这个出口]');
  const csrc = fs.readFileSync(path.join(__dirname, '..', 'core', 'agent', 'consume.js'), 'utf8');
  for (const label of ['empty-turn', 'force-sediment', 'redline-out', 'lost-toolcall']) {
    ok(new RegExp(`retryOrReleaseTurn\\(this, '${label}'`).test(csrc), `${label} 走 retryOrReleaseTurn`);
  }
  ok(!/setTimeout\(\(\) => \{\s*\n\s*this\.submit\([\s\S]{0,260}?\.catch\(/.test(csrc),
     '🔴 裸 setTimeout+submit().catch() 的老写法已绝迹(它收不到那两个裸 return)');
  ok(/_turnSeq !== seqBefore/.test(fs.readFileSync(path.join(__dirname, '..', 'core', 'agent', 'turn-release.js'), 'utf8')),
     '判据是 _turnSeq 有没有涨(一个判据盖住抛异常/挂起拒绝/限流取消三个入口)');

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();
