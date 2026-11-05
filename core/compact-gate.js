// compact-gate.js — 上下文胖度分档的判定(纯函数, 不依赖 electron)。
// 单独成文件是为了 main.js 和 test-idle-watcher.js 共用同一份: 老代码是测试里逐字抄一遍主程序的决策链,
// 改一次就得同步改两处, 迟早漂移。
//
// 🔴 2026-09-11 作者定案 —— 这三档【只发提醒, 不压缩】。
//   强制压缩只剩 `ctx_pct >= 80` 那一条救命红线(判定在 idle-watcher, 不在这里), 且它也是先存现场再清。
//   病根: 老版三档命中即 doCompact, 判据是一段猜"AI 上一句是不是问句"的正则词表 —— 猜漏一次就把整个
//   会话清了。判据的分量和后果的分量根本不对等: 一段正则不配决定清不清空会话。
//   现在三档产出的是 SAVE_NUDGE(提醒人格存记忆 + 写交接清单), 压不压由人格自己拍板 ——
//   只有它知道这一程是不是密集来回、手上那件事收没收尾。悬挂问句门连同那段正则一起从本链路撤除:
//   提醒不销毁任何东西, 不需要保护。
//   档位仍是老的三档 15%/30%/45% + 80% 红线, 只是前三档的动作从"压"换成"催"。
//   提醒分两层递进: 正文按档位各写一份(save_nudge_{soft,tight,urgent}.md, 措辞紧急度递增),
//   催的密度再叠一层(见 NUDGE_INTERVAL_MS): 15% 半小时一次, 30% 一刻钟一次, 45% 五分钟一次。

/* 🔴 分档按 window 比例, 不按绝对 tok —— 绝对值写死在 1M 假设上, 200k 窗口跑起来高档永远够不着。
   三档: soft=15% · tight=30% · urgent=45%, 另加 80% 红线。1M 上是 150k/300k/450k, 200k 上是 30k/60k/90k。 */
const COMPACT_HARDCAP_SOFT_PCT   = 0.15;         // 起提醒地板(占 window 的百分比)
const COMPACT_TIER_TIGHT_PCT     = 0.30;         // 中间一档
const COMPACT_TIER_URGENT_PCT    = 0.45;         // 催得最密的一档

/* 🔴 起压地板还要跟"起床成本"挂钩, 光按 window 比例会在小窗口上陷入死循环。
   省钱型压缩的收支是: 成本 = 一次全文 + 重新起床(≈wakeCtxBase), 收益 = 省下的 cache read。
   ctx 没比起床成本高出足够倍数, 压了就是白烧一次起床 —— 这跟窗口多大根本无关。
   实测(2026-09-04): 200k 窗口 × 15% = 30k 起压, 而该人格 wakeCtxBase 实测 17k~66k,
   于是清空完立刻又够条件, 半小时自动压了 6 次。
   取两者的大值: 比例项守住"1M 上 150k 才压"的老经验, 倍数项守住"别低于起床成本"。
   小窗口下算出来的地板可能高过红线(window×80%), 那时这条轨道自然失效只剩红线兜底 ——
   那是算出来该如此(小窗口本就没有省钱空间), 不是特例。 */
const COMPACT_WAKE_BASE_MULT     = 3;            // 起压地板 ≥ wakeCtxBase × 此倍数

// 老的绝对值作 fallback: 不传 windowTok 时使用(测试与老调用姿势保持不变)。
const COMPACT_HARDCAP_SOFT_TOK   = 150_000;
const COMPACT_TIER_TIGHT_TOK     = 300_000;
const COMPACT_TIER_URGENT_TOK    = 450_000;

const COMPACT_HARDCAP_IDLE_MIN         = 1;      // 地板档: 停手 1min 才提醒
const COMPACT_TIER_TIGHT_IDLE_MIN      = 0.25;   // 15s
const COMPACT_HARDCAP_MIN_INTERVAL_MS  = 5 * 60_000;   // persona_tune 可覆盖的提醒最小间隔

// 同一档两次提醒的最小间隔: 越胖催得越密。提醒正文只有一份, 分级只体现在这个间隔上。
const NUDGE_INTERVAL_MS = { soft: 30 * 60_000, tight: 15 * 60_000, urgent: 5 * 60_000 };

/** 返回 null = 还没到该提醒的胖度; 否则给出这一档的门槛(idleMin=停手多久才开口, nudgeIntervalMs=多久催一次)。
 *  windowTok 传了就按比例算三档(推荐 · 200k/1M 通用); 不传落回绝对档 150/300/450 (向后兼容)。
 *  softFloor 走 persona_tune 覆盖 —— 传了就顶替 soft 档地板(高于比例算出的地板也行, 低也行)。
 *  wakeBaseTok 是该人格实测的苏醒基数; 传了就把地板抬到不低于它的 COMPACT_WAKE_BASE_MULT 倍。
 *    首次苏醒还没测出来时传 0/null, 退回纯比例(与老行为一致)。
 *  baseIdleMin 走 persona_tune 覆盖; 高档用 Math.min, 免得"调紧了的人格反被梯度放松"。 */
function compactGate(ctxTok, softFloor, baseIdleMin = COMPACT_HARDCAP_IDLE_MIN, windowTok = null, wakeBaseTok = null) {
  const byPct    = windowTok ? Math.round(windowTok * COMPACT_HARDCAP_SOFT_PCT) : COMPACT_HARDCAP_SOFT_TOK;
  const byWake   = wakeBaseTok ? Math.round(wakeBaseTok * COMPACT_WAKE_BASE_MULT) : 0;
  const softTok  = softFloor != null ? softFloor : Math.max(byPct, byWake);
  const tightTok  = windowTok ? Math.round(windowTok * COMPACT_TIER_TIGHT_PCT)  : COMPACT_TIER_TIGHT_TOK;
  const urgentTok = windowTok ? Math.round(windowTok * COMPACT_TIER_URGENT_PCT) : COMPACT_TIER_URGENT_TOK;
  if (!(ctxTok >= softTok)) return null;
  if (ctxTok >= urgentTok) return { tier: 'urgent', idleMin: 0, nudgeIntervalMs: NUDGE_INTERVAL_MS.urgent };
  if (ctxTok >= tightTok) {
    return { tier: 'tight', idleMin: Math.min(baseIdleMin, COMPACT_TIER_TIGHT_IDLE_MIN), nudgeIntervalMs: NUDGE_INTERVAL_MS.tight };
  }
  return { tier: 'soft', idleMin: baseIdleMin, nudgeIntervalMs: NUDGE_INTERVAL_MS.soft };
}

module.exports = {
  compactGate,
  COMPACT_HARDCAP_SOFT_PCT,
  COMPACT_TIER_TIGHT_PCT,
  COMPACT_TIER_URGENT_PCT,
  COMPACT_WAKE_BASE_MULT,
  COMPACT_HARDCAP_SOFT_TOK,
  COMPACT_HARDCAP_IDLE_MIN,
  COMPACT_HARDCAP_MIN_INTERVAL_MS,
  COMPACT_TIER_TIGHT_TOK,
  COMPACT_TIER_TIGHT_IDLE_MIN,
  COMPACT_TIER_URGENT_TOK,
  NUDGE_INTERVAL_MS,
};
