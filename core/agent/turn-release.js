// turn-release.js — 回合「不放行」之后的兜底出口。
//
// 🔴 为什么要有: consume 循环里有四条路会把这一轮扣住不放行(空回合补提 / 拿到新知识没沉 /
//    输出撞红线 / 工具调用漏成正文), 手法都是 `continue` —— 跳过 onResult **和** onTurnEnd,
//    靠"随后追加的那一轮会把收尾补上"来放开界面。
//    而 submit 有三处压根不会让消息入队, 其中两处还不是抛异常:
//      ① 真抛(ensureStream 起子进程失败之类)      → `.catch` 收得到
//      ② 挂起期间拒绝自动轮 (stream.js 的 `if (!_replayable) { …; return; }`) → **裸 return, 不抛**
//      ③ 限流闸被 interrupt 取消 (`if (gate.cancelled) { …; return; }`)        → **裸 return, 不抛**
//    四条重试全在 `_replayable` 的排除名单里, 所以②对它们是常态而不是极端情况; 撞上就等于
//    onResult 与 onTurnEnd 双双不发 → 界面永久转圈、正文一个字不出、**没有自愈**, 只能重启。
//    这与静音闩锁、心跳标记是同一个病: **把收尾信号挂在"下一轮一定会来"这个假设上**。
//
// 🔴 判据为什么用 `_turnSeq`: 它只在消息**真进队列那一刻**才 ++(见 stream.js 的 `_queue.push` 之后),
//    上面三种失败一个都不会让它涨。所以"没涨"正好等价于"这一轮没发出去", 一个判据盖住三个入口,
//    不用给每个入口各打一个补丁。

/* 追一轮; 追不出去就把被扣住的那一轮原样放回去。
   withheld = { finalText, interrupted } —— 本来要 emit 给界面的那份。 */
const { endTurn } = require('./turn-mute');

function retryOrReleaseTurn(b, label, run, withheld) {
  const seqBefore = b._turnSeq;
  // 脱出消费循环再跑: submit 里有等压缩/等清空的 await, 同步调用会与本循环互等。
  setTimeout(() => {
    Promise.resolve().then(run)
      .catch((e) => console.error(`[${label}] ${b.name} 追加那一轮失败: ${(e && e.message) || e}`))
      .then(() => {
        if (b._turnSeq !== seqBefore) return;   // 真入队了 → 收尾归那一轮, 这里什么都不做
        console.error(`[${label}] ${b.name} 追加那一轮没能入队 → 放回被扣住的这一轮(免界面永久转圈)`);
        const finalText = (withheld && withheld.finalText) || '';
        const interrupted = !!(withheld && withheld.interrupted);
        b._emit('onResult', { finalText, interrupted });
        // askOnce 靠先进先出对齐 result: 这一轮既然就此收尾, 挂起的那个必须在这里兑现, 否则它永远等不到。
        if (b._askPending.length) {
          const resolve = b._askPending.shift();
          try { resolve(finalText); } catch (_) {}
        }
        // 这一轮就此收尾: 静音一起结束(否则下一轮沿用它的认领)。
        const wasMuted = endTurn(b);
        b._emit('onTurnEnd', { interrupted, muted: wasMuted, compactReason: null });
      });
  }, 0);
}

module.exports = { retryOrReleaseTurn };
