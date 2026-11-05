'use strict';
// 退出 / 关标签 / 切接入方式之前的「沉淀」: 让人格把手头没落盘的活写进图记忆再走。
// 从 main.js 拆出来, 是因为这套"最坏等多久"由四个互相咬合的常量决定, 散在 2600 行的主进程里读不出全貌。

// 沉淀的上限。作者 2026-08-25 定 3 分钟: 60s 太短 —— 实测光首字就可能吃掉 33 秒,
// 剩下的不够跑完「沉图记忆 + 改便条」两件事, 于是好好的一次沉淀被判超时、活白丢。
// 🔴 这是【卡死的上限】, 不是「等这么久就放弃」: 只要人格还在干活就一直等(见 core/agent/compact.js 的 _waitIdle),
//    这个数只用来兜住「它真的死在那儿了」。所以宁可给大, 不必抠。
const SEDIMENT_DEADLINE_MS = 180000;
// 关窗口这条路上的**硬上限**。不传的话吃 _askUntilDoneOrDead 的默认值 max(deadline×3, 10分钟) = 10 分钟:
// deadlineMs 只在人格已经停止活动时才判超时(还在干活就一直等, 那是对的, 不能把正在写记忆的掐死),
// 所以真正决定"最坏等多久"的是这个 hardCap。2026-08-27 实撞: 沉淀那轮模型 497 秒才回第一个字,
// 全程 isRunning()=true, 于是 3 分钟的 deadline 一次都没触发, 用户眼里就是"关不掉"。
// 掐断不丢东西: keepContextOnSedimentFail 保证沉不成就不清空, 活还在上下文里, 下次开还能再沉一次。
// 2026-09-13 起它只管【首字之前】那段。
const QUIT_SEDIMENT_HARD_CAP_MS = 180000;
// 开口之后改看【停手多久】: 只要还在产出就一秒都不砍, 连着这么久没有任何产出才判它死了。
// 分成两段是因为病根是【首字延迟】而不是人格磨蹭: 实测三人格并发沉淀时码上飞等了 159s 才吐出
// 第一个字, 一段式的 180s 只剩 21s 留给真正干活的部分。
// 🔴 2026-09-24 改过语义: 原先量的是"离首字多久", 等于给整段写记忆的工作设了总时长上限 ——
// 老师那次写了 4 分多钟, 一次完全成功的沉淀被判卡死。判死只认"停手", 不认"干得久"。
const QUIT_SEDIMENT_IDLE_KILL_MS = 120000;
// 退出链一整条的时间预算。沉淀改成串行之后最坏耗时按人格数叠加 —— 没有总预算的话三个人格各打满
// 就是十几分钟, 用户眼里和"关不掉"没区别。每个人格实际拿到的硬上限 = min(自己的上限, 剩下的预算)。
const QUIT_SEDIMENT_TOTAL_BUDGET_MS = 420000;

// 退出链同时只许有一条在跑。不挡的话第二个信号会开出第二条链, 两条并发跑 = 上面那套串行白做。
// 2026-09-13 真机实撞: SIGTERM 被发了两次, 日志里出现两遍「收到 SIGTERM → 直接走退出链」,
// 第二个人格是在第二条链上被沉淀的 —— 看着像串行, 其实是两条链各自串行、彼此并发。
let _quitRunning = false;
const beginQuit = () => (_quitRunning ? false : (_quitRunning = true));
const endQuit = () => { _quitRunning = false; };   // 只给"取消退出·一会再关"那条路用: 进程没死, 下次还要能退

// 🔴 用户选了「先别关」→ 把退出流程给人格加的标记全摘干净, 否则它只退回一半, 继续跑但行为已经变了。
// shuttingDown 从前只有人写 true 没有人写 false: 取消退出之后它永久为真, 此后每次清空都不再打
// 唤醒 submit(compact.js 那道门), 人格清空完就哑在那儿。取消退出的语义是"当没发生过", 就得当没发生过。
const cancelQuit = (items) => {
  for (const x of (Array.isArray(items) ? items : [items])) {
    const b = x && (x.butler || (x.s && x.s.butler));
    if (b) b.shuttingDown = false;
  }
};

// v0.0.22 (2026-07-20): 关闭前让人格沉淀手头活+clear (skipWake, 进程要死不需唤醒).
// dirty 三条 AND: dirtySinceLastClear + sessionId + _q. 非 dirty 直接跳过.
async function sedimentOne(s, reason, deadlineMs = SEDIMENT_DEADLINE_MS, opts = {}) {
  const b = s && s.butler;
  if (!b) return { ok: true, skipped: 'no_butler' };
  if (!(b.dirtySinceLastClear && b.sessionId && b._q)) return { ok: true, skipped: 'not_dirty' };
  // 接入故障挂起中(key 错 / 没选模型 / 额度满): 它开不了口, 沉淀只会干等到硬上限再判失败 ——
  // 换凭据/选模型的那次重启因此被拦下, 用户正要修的东西反而修不了(2026-11-05 实测白等 180s)。
  if (b._authBlocked) return { ok: true, skipped: 'access_blocked' };
  b.shuttingDown = true;   // 兜底: 复用了别人已在跑的 _clearing 时, agent.js 用这个标志跳过唤醒 submit(opts.skipWake 那时读不到).
  try {
    // keepContextOnSedimentFail: 沉不成就别清 —— 活还在上下文里, 用户点"取消退出"才救得回来。
    const r = await b.doClearWithSediment(reason, deadlineMs, {
      skipWake: true, keepContextOnSedimentFail: true,
      hardCapMs: opts.hardCapMs || QUIT_SEDIMENT_HARD_CAP_MS,
      idleKillMs: opts.idleKillMs || QUIT_SEDIMENT_IDLE_KILL_MS,
      onAlive: opts.onAlive,
    });
    // 🔴 沉淀没沉成也要如实往上报。doClearWithSediment 自己不抛(清空照常做完),
    // 所以只看有没有 throw 会永远判成功 —— 那正是 2026-08-25 的病:
    // 人格回了"已沉淀"、图和便条一个字没动, 而用户看到遮罩转完就关, 手头的活悄悄没了。
    const sed = r && r.sediment;
    if (sed && sed.ran && !sed.ok) return { ok: false, error: sed.error || '沉淀没有真正发生' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// 🔴 **一个一个来, 不许 Promise.all**。并发沉淀是首字延迟的放大器: 同一时刻把 N 轮请求压过去,
// 每个人格都在排队等自己的第一个 token, 谁都等不到, 然后一起撞上限一起失败。实测 2026-09-13
// 三人格并发: 码上飞首字 159s、富小宝 180s 内零输出, 两个都被砍。串行下每个人格独占带宽,
// 代价是总时长叠加 —— 所以配一个总预算, 后面排不上队的如实报"没轮上"(上下文留着, 下次还能沉)。
async function sedimentSerially(items, { reason = '退出 butler', onProgress, onAlive } = {}) {
  const t0 = Date.now();
  const out = [];
  let at = -1;
  for (const x of items) {
    at++;
    const left = QUIT_SEDIMENT_TOTAL_BUDGET_MS - (Date.now() - t0);
    const r = left <= 0
      ? { ok: false, error: '前面的人格把退出沉淀的总时间用完了, 没轮上 —— 上下文原样留着, 下次开起来还能再沉一次' }
      : await sedimentOne(x.s, reason, SEDIMENT_DEADLINE_MS,
        { hardCapMs: Math.min(QUIT_SEDIMENT_HARD_CAP_MS, left),
          // 串行的代价是后面的人在排队, 而排队的人在遮罩上和"卡住了"长得一样 —— 把还剩几个一起报出去。
          onAlive: onAlive ? (info) => onAlive(x, { ...info, queued: items.length - 1 - at }) : undefined });
    if (onProgress) { try { onProgress(x, r); } catch (_) {} }
    out.push({ x, r });
  }
  return out;
}

// 判死之后**接着看**: 看门狗放弃的只是"等它这一轮的回话", 人格本身还在跑, 而它多半正在把记忆写完
// (2026-09-24 实测: 被判死之后 CLI 照样写完了)。所以别急着宣布失败, 挂着等它真停手 —— 停手了
// 说明活已经干完, 遮罩上那条通知可以自己收掉, 不用用户点任何东西。
// 🔴 没有超时: "等多久算死"正是判错过的那件事。出口只有两个 —— 它自己停手, 或者用户按下强制关闭
// (shouldStop 返回 true)。两个都不来就一直等着, 界面上是一条会动的通知, 不是一个卡住的框。
async function waitUntilSettled(items, { onTick, shouldStop } = {}) {
  for (;;) {
    const busy = items.filter((x) => {
      const b = x && (x.butler || (x.s && x.s.butler));
      return b && b.isRunning();
    });
    if (busy.length === 0) return { done: true };
    if (shouldStop && shouldStop()) return { done: false, forced: true };
    if (onTick) {
      try {
        onTick(busy.map((x) => {
          const b = x.butler || (x.s && x.s.butler);
          return { sid: x.sid, name: x.name, tool: b._lastToolName || '', memWrites: b._turnMemoryWrites || 0 };
        }));
      } catch (_) {}
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// 退出遮罩上那条通知。**它替代的是原先那个 showMessageBoxSync 拦路框**, 两者的差别不是好看不好看:
//   · 拦路框说的往往是假话 —— "没存下来"只代表看门狗不等了, 人格多半正在把记忆写完;
//   · 拦路框同步阻塞, 后台就算写完了也没人能替用户把它关掉, 只能让用户自己猜要不要按。
// 所以这里三个出口是平等的: 后台自己干完(settled) · 用户等不及了(force) · 用户决定先别关(cancel)。
let _noticeResolve = null;
const answerQuitNotice = (action) => { const r = _noticeResolve; _noticeResolve = null; if (r) r(action); };
try { require('electron').ipcMain.on('quit-notice', (_e, action) => answerQuitNotice(action)); } catch (_) {}

async function noticeAndWait(failed, send) {
  const items = failed.map(f => f.x);
  const clicked = new Promise((resolve) => { _noticeResolve = resolve; });
  let stopped = false;
  void clicked.then(() => { stopped = true; });
  send({
    phase: 'notice',
    failed: failed.map(f => ({ sid: f.x.sid, name: f.x.name, error: f.r.error || '' })),
    busy: items.filter(x => x.s && x.s.butler && x.s.butler.isRunning()).map(x => ({ sid: x.sid, name: x.name })),
  });
  const settled = waitUntilSettled(items, {
    onTick: (busy) => send({ phase: 'notice-alive', busy }),
    shouldStop: () => stopped,
  }).then((r) => (r.done ? 'settled' : 'force'));
  const action = await Promise.race([clicked, settled]);
  _noticeResolve = null;
  return action;
}

module.exports = {
  SEDIMENT_DEADLINE_MS,
  QUIT_SEDIMENT_HARD_CAP_MS,
  QUIT_SEDIMENT_IDLE_KILL_MS,
  QUIT_SEDIMENT_TOTAL_BUDGET_MS,
  sedimentOne,
  sedimentSerially,
  waitUntilSettled,
  noticeAndWait,
  answerQuitNotice,   // 按钮的入口。导出是为了让门禁点得到 —— 测试里没有 electron, 上面那条 ipcMain 注册是空的
  beginQuit,
  endQuit,
  cancelQuit,
};
