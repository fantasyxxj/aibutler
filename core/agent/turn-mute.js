// turn-mute.js — 自言自语那几轮(保活心跳 · 清空前沉淀)不上屏: 哪一轮该静音, 只在这一个文件里判。
//
// 🔴 判法: 按 CLI 的回放对账, 不推断。
//    子进程开着 `--replay-user-messages`(stream.js 的 extraArgs): CLI **开始处理**某条用户消息时,
//    把它带着原 uuid 回发一次(msg.type === 'user' && msg.isReplay)。实测(2026-10-09 dev)这条回放
//    与轮次对齐 —— 上一轮跑着时排进来的消息, 它的回放在上一轮的 result **之后**才到; 连发几句被合成
//    一轮时也各自回放。所以"哪几条提交进了这一轮"是 CLI 亲口说的, 不是我们猜的。
//    一轮里只要回放出一条出声的提交, 这一轮就出声; 回放的全是静音提交, 才静音;
//    一条回放都没有的轮(CLI 自己起的轮, 如后台任务通知)默认出声 —— 默认出声是安全侧。
//
// 病史(每一次都是在"猜哪条提交归哪一轮"上打补丁, 这里换掉的是判法本身):
//    · 实例级开关 → 被上一轮的 result 提前复位, 沉淀轮口令照样上屏;
//    · Infinity 全局待认领 → 真人在闸口按的回车把静音抢走, 整轮被掐死(2026-09-27);
//    · 拿 _turnSeq(数提交) 追 _resultSeq(数结果) → 合成一轮后两数错位, 静音闩死(2026-09-27);
//      补了"最多罩 2 个结果"的上界 → 紧跟心跳那一轮整轮被吞, 它登记的压缩一起丢(2026-10-09);
//    · "一轮开始时认领此前入队的全部提交" → SDK 读走消息到我们看见 init 之间有窗口, 窗口里入队的
//      心跳被上一轮多认领走, 自己那一轮反而出声(2026-10-09 dev 实撞, 屏幕上冒出一个 "ok")。
//
// 🔴 静音只掐给界面看的事件(core/agent.js 的 UI_EVENTS)。压缩等收尾必做的事走 onTurnEnd,
//    静音碰不到 —— 这里将来再判错, 最坏是多显示或少显示一句话, 不会再丢状态。

/* 入队那一刻登记(uuid 与 buildUserMessage 给这条消息的一致)。
   补提轮(空回合补提 · 补沉 · 红线重说 · 漏调重调)沿用被扣住那一轮的静音与否 —— 调用方把
   `muted` 传成 b._turnMuted; 被扣住那一轮还没收尾, 这个值就是它的。 */
// meta = 宿主随这条提交带的事实(如行业版「这条 LINE 是哪位客人发的」), 跟着回放进轮, 收尾清掉 ——
// 同一套对账顺带回答「这一轮里是谁的消息」, 不另猜一次(猜法的病史见上)。
function noteSubmit(b, uuid, muted, meta) {
  if (!b._pendingSubs) b._pendingSubs = [];
  b._pendingSubs.push({ uuid, muted: !!muted, meta: meta || null });
}

/* CLI 回放了一条用户消息 = 它进了当前这一轮。按 FIFO 出队到这条为止(排在它前面还没回放的,
   说明被合进了同一轮); 认不出 uuid 就保守地把它当作出声。 */
function onReplay(b, uuid) {
  const q = b._pendingSubs || [];
  const i = q.findIndex((s) => s.uuid === uuid);
  const taken = i >= 0 ? q.splice(0, i + 1) : [];
  const loud = !taken.length || taken.some((s) => !s.muted);
  if (!b._turnClaimed) b._turnMetas = [];
  for (const s of taken) if (s.meta) b._turnMetas.push(s.meta);
  if (!b._turnClaimed) { b._turnClaimed = true; b._turnMuted = !loud; }
  else if (loud) b._turnMuted = false;   // 轮中途读进来一句出声的(比如真人插话) → 从这里放开
}

// 一轮收尾: 返回这一轮是否静音(给 onTurnEnd 带出去), 并为下一轮复位。
function endTurn(b) {
  const was = !!b._turnMuted;
  b._turnMuted = false;
  b._turnClaimed = false;
  b._turnMetas = [];
  return was;
}

// 流被拆掉: 队列里还没回放的提交再也不会有回复, 一并丢掉。
function dropTurn(b) {
  b._pendingSubs = [];
  return endTurn(b);
}

module.exports = { noteSubmit, onReplay, endTurn, dropTurn };
