// test-idle-watcher.js — 无头验证 idle_watcher decideActions 决策矩阵.
// 跑法: node test-idle-watcher.js
// v6 (2026-07-22 · design/keepalive_v6_count_based.md): 删 soft_threshold / tier1_hard_cutoff, 加 keepalive_maxed.
// v7 (2026-07-22): KEEPALIVE 门 = wakeCtxBase*ratio 动态基数 (每人格苏醒稳态自适应, 死值 20k 弃为兜底).
// 复制 main.js 里的纯函数, 不依赖 electron; registry.getByDir 用 stub 注入.

// —— 纯判定全部来自 core/idle-watcher.js, 这里不再复制 ——
const { classifyTier, detectAssistantQuestion } = require('../core/idle-watcher');

// 压缩门槛/梯度不再抄一份 —— 直接 require 主程序用的那个模块 (2026-08-13)。
// 老做法是把 main.js 的常量和判定逐字复制到这里, 改一次要同步两处, 梯度这种多档逻辑抄必漂。
const {
  compactGate,
  COMPACT_HARDCAP_SOFT_TOK,
  COMPACT_HARDCAP_IDLE_MIN,
  COMPACT_HARDCAP_MIN_INTERVAL_MS,
  COMPACT_TIER_TIGHT_TOK,
  COMPACT_TIER_URGENT_TOK,
} = require('../core/compact-gate');
const KEEPALIVE_MIN_TOK = 20_000;
const KEEPALIVE_MAX_TIMES = 10;
const BG_HOLD_MIN = 30;
const PARK_IDLE_MIN = 30;

// registry stub: 每条 mock 可以传 personaCfg 模拟 per-persona 覆盖 (persona_tune 场景)
// 决策矩阵不再抄一份 —— 直接 require 主程序用的那个模块 (2026-09-04, core 化)。
// 老做法是把 main.js 的 decideActions 逐字复制到这里, 改一次要同步两处, 必漂。
const _core = require('../core/idle-watcher');
let _registryStub = null;
const decideActions = (s) => _core.decideActions(s, { personaCfg: _registryStub || {} });

// —— test harness ——
const now = Date.now();
const MIN = 60_000;
const HOUR = 3_600_000;

function mock({ idle_min, ctx_tok, ctx_pct, running = false, dirty = true, kaCount = 0, lastCompactAgoMin = null, lastSaveNudgeAgoMin = null, homeDir = '/tmp/persona-x', wakeCtxBase = null, bgLaunchAgoMin = null, hasStream = true, authBlocked = false }) {
  return {
    last_activity_ts: now - idle_min * MIN,
    lastCompactTs: lastCompactAgoMin == null ? 0 : now - lastCompactAgoMin * MIN,
    lastSaveNudgeTs: lastSaveNudgeAgoMin == null ? 0 : now - lastSaveNudgeAgoMin * MIN,
    butler: {
      homeDir,
      dirtySinceLastClear: dirty,
      keepalive_count: kaCount,
      lastBgLaunchTs: bgLaunchAgoMin == null ? 0 : now - bgLaunchAgoMin * MIN,
      wakeCtxBase,   // v7: null = 首次苏醒未写入 (走 keepaliveMinTok 兜底门)
      _authBlocked: authBlocked,
      usage: () => ({ inTok: ctx_tok, pct: ctx_pct != null ? ctx_pct : (ctx_tok / 1_000_000) * 100, window: 1_000_000 }),
      isRunning: () => running,
      hasStream: () => hasStream,
    },
  };
}

let pass = 0, fail = 0;
function assert(actions, expected, label) {
  const ok = actions.length === expected.length && expected.every((e, i) =>
    actions[i].type === e.type && (e.reason === undefined || actions[i].reason === e.reason));
  if (ok) { console.log('  ✓', label); pass++; }
  else { console.log('  ✗', label, '\n     got:', JSON.stringify(actions.map(a => ({ type: a.type, reason: a.reason }))), '\n     want:', JSON.stringify(expected)); fail++; }
}
function setCfg(cfg) { _registryStub = cfg; }
function resetCfg() { _registryStub = null; }

console.log('\n[classifyTier 边界]');
assert([{ type: classifyTier(now - 1 * HOUR) }], [{ type: 'T1' }], 'idle 1h → T1');
assert([{ type: classifyTier(now - 25 * HOUR) }], [{ type: 'T2' }], 'idle 25h → T2');
assert([{ type: classifyTier(now - 8 * 24 * HOUR) }], [{ type: 'T3' }], 'idle 8d → T3');

console.log('\n[硬红线 · 无视一切]');
assert(decideActions(mock({ idle_min: 1, ctx_tok: 850_000, ctx_pct: 85 })),
       [{ type: 'COMPACT', reason: 'red_line' }], 'pct 85% 无视 idle 立压');
assert(decideActions(mock({ idle_min: 1, ctx_tok: 850_000, ctx_pct: 85, running: true })),
       [{ type: 'COMPACT', reason: 'red_line' }], 'red_line 回合进行中也压(救命例外)');
assert(decideActions(mock({ idle_min: 1, ctx_tok: 850_000, ctx_pct: 85, dirty: false })),
       [{ type: 'COMPACT', reason: 'red_line' }], 'red_line 无视 dirty 门(容量事故不管空闲期)');

console.log('\n[dirty 门 · 空闲期零花费]');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 8_000, dirty: false })),
       [], '清空后 ctx 8k dirty=false → 无动作 (v6 空闲期设计核心: 零心跳零压缩)');
// 🔴 这条原来断言"零动作"。PARK 轨道(2026-08-27)加进来之后它变成唯一一条动作 —— 但**没有破坏
// 「空闲期不自烧」这条原则**: PARK 只是把子进程还回去, 一个 token 都不花, 也不跑回合。
// 真正要守住的是下面那句: 空闲期依然不许出现 KEEPALIVE / COMPACT 这类要花钱的动作。
assert(decideActions(mock({ idle_min: 30, ctx_tok: 50_000, dirty: false })),
       [{ type: 'PARK', reason: 'idle_reclaim' }], '清空后 idle 30min dirty=false → 只回收子进程');
{
  const a = decideActions(mock({ idle_min: 30, ctx_tok: 50_000, dirty: false }));
  const costly = a.filter((x) => x.type === 'KEEPALIVE' || x.type === 'COMPACT');
  assert(costly, [], '空闲期依然零花费 (PARK 不烧 token, 但不许混进 KEEPALIVE/COMPACT)');
}

console.log('\n[PARK 轨道 · 闲置人格把子进程还回去 (2026-08-27)]');
// 只在 !dirty 时回收: dirty=true 意味着手头有没沉淀的活, 拆了就丢
assert(decideActions(mock({ idle_min: 60, ctx_tok: 40_000, dirty: true, kaCount: 0 })).filter((a) => a.type === 'PARK'),
       [], '🔴 dirty=true 一律不回收 (有没沉淀的活, 拆流就丢了)');
assert(decideActions(mock({ idle_min: 29, ctx_tok: 40_000, dirty: false })),
       [], 'idle 29min < 门槛 30min → 还不回收');
assert(decideActions(mock({ idle_min: 31, ctx_tok: 40_000, dirty: false })),
       [{ type: 'PARK', reason: 'idle_reclaim' }], 'idle 31min + 干净 → 回收');
// 流已经不在了就别再报 PARK, 否则每 30s 扫一次日志刷屏
assert(decideActions(mock({ idle_min: 60, ctx_tok: 40_000, dirty: false, hasStream: false })),
       [], '流已经拆过了 → 不重复回收');
// 回合在跑 / 后台任务在跑, 与压缩同理必须让路 —— 拆流一样会把正在跑的活断掉
assert(decideActions(mock({ idle_min: 60, ctx_tok: 40_000, dirty: false, running: true })),
       [], '🔴 回合进行中不回收 (拆流会把这一轮断掉)');
assert(decideActions(mock({ idle_min: 60, ctx_tok: 40_000, dirty: false, bgLaunchAgoMin: 2 })),
       [], '🔴 后台任务在跑不回收 (它正等着那个活, 拆了就断)');
// 这一轮还有别的活要干就让路, 下一轮再回收
setCfg({ checkupIdleMin: 999999 });
assert(decideActions(mock({ idle_min: 60, ctx_tok: 850_000, ctx_pct: 85, dirty: false })),
       [{ type: 'COMPACT', reason: 'red_line' }], '救命红线在场时不插队回收 (下一轮再说)');
resetCfg();
setCfg({ parkIdleMin: 0 });
assert(decideActions(mock({ idle_min: 60, ctx_tok: 40_000, dirty: false })),
       [], 'parkIdleMin=0 → 整条轨道关掉 (persona_tune 回滚保险)');
resetCfg();
setCfg({ parkIdleMin: 5 });
assert(decideActions(mock({ idle_min: 6, ctx_tok: 40_000, dirty: false })),
       [{ type: 'PARK', reason: 'idle_reclaim' }], 'parkIdleMin=5 → 6min 就回收 (每人格可调)');
resetCfg();

console.log('\n[后台任务门 · 有活在跑就挂着别压 (2026-08-21 事故)]');
assert(decideActions(mock({ idle_min: 2, ctx_tok: 200_000, bgLaunchAgoMin: 2 })),
       [], '后台构建 2min 前开跑 + ctx 200k + idle 2min → 不提醒 (那一轮会跟它抢流)');
assert(decideActions(mock({ idle_min: 2, ctx_tok: 200_000, bgLaunchAgoMin: null })),
       [{ type: 'SAVE_NUDGE', reason: 'ctx_tier' }], '同场景但没有后台任务 → 照常提醒 (证明上一条是 bg 门挡的)');
assert(decideActions(mock({ idle_min: 2, ctx_tok: 200_000, bgLaunchAgoMin: 31 })),
       [{ type: 'SAVE_NUDGE', reason: 'ctx_tier' }], '后台任务 31min 前开跑 → 超过 30min 兜底期自动放行 (漏记回执不能永久锁死)');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 50_000, kaCount: 10, bgLaunchAgoMin: 2 })),
       [], 'keepalive_maxed 也要让路');
assert(decideActions(mock({ idle_min: 1, ctx_tok: 850_000, ctx_pct: 85, bgLaunchAgoMin: 2 })),
       [{ type: 'COMPACT', reason: 'red_line' }], 'red_line 不受后台任务门约束 (容量事故优先于构建)');
setCfg({ bgHoldMin: 0 });
assert(decideActions(mock({ idle_min: 2, ctx_tok: 200_000, bgLaunchAgoMin: 2 })),
       [{ type: 'SAVE_NUDGE', reason: 'ctx_tier' }], 'persona_tune bgHoldMin=0 → 关掉这道门');
resetCfg();

console.log('\n[v6 KEEPALIVE minTok 门抬到 20k]');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 8_000 })),
       [], 'ctx 8k < 20k minTok → 不心跳 (设计场景 A)');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 25_000 })),
       [{ type: 'KEEPALIVE' }], 'ctx 25k ≥ 20k minTok → 心跳');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 25_000, dirty: false })),
       [], 'dirty=false → 就算 ctx 够也不心跳');
assert(decideActions(mock({ idle_min: 3, ctx_tok: 50_000 })),
       [], 'idle 3min < 4min → 心跳窗口未开');
assert(decideActions(mock({ idle_min: 15, ctx_tok: 50_000, running: true })),
       [], '回合进行中 → 不保活 (工具调用自续 cache)');

console.log('\n[v6 keepalive_count 计数触发]');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 50_000, kaCount: 5 })),
       [{ type: 'KEEPALIVE' }], 'kaCount=5 < 10 maxTimes → 继续心跳');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 50_000, kaCount: 9 })),
       [{ type: 'KEEPALIVE' }], 'kaCount=9 < 10 → 最后一跳');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 50_000, kaCount: 10 })),
       [{ type: 'COMPACT', reason: 'keepalive_maxed' }], 'kaCount=10 达 maxTimes → 直接压 (保满都没人回 = 人确实走了, 设计场景 B/D)');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 50_000, kaCount: 15 })),
       [{ type: 'COMPACT', reason: 'keepalive_maxed' }], 'kaCount 超上限 → 依然 keepalive_maxed');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 50_000, kaCount: 10, dirty: false })),
       [], 'kaCount=10 但 dirty=false → 不动 (空闲期 kaCount 本应=0, 此为防御性 case)');

console.log('\n[胖度提醒轨道]');
assert(decideActions(mock({ idle_min: 2, ctx_tok: 200_000 })),
       [{ type: 'SAVE_NUDGE', reason: 'ctx_tier' }], 'ctx 200k idle 2min → 提醒单独 (KEEPALIVE 门 idle≥4min 未开)');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 200_000 })),
       [{ type: 'SAVE_NUDGE', reason: 'ctx_tier' }, { type: 'KEEPALIVE' }], 'ctx 200k idle 5min → 提醒 + 保活并发');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 200_000, lastSaveNudgeAgoMin: 3 })),
       [{ type: 'KEEPALIVE' }], '3min 前刚催过 → soft 档 30min 间隔内不重复催, 只保活');
assert(decideActions(mock({ idle_min: 30, ctx_tok: 500_000, kaCount: 5 })),
       [{ type: 'SAVE_NUDGE', reason: 'ctx_tier' }, { type: 'KEEPALIVE' }], '长文档 ctx 500k idle 30min → 提醒 (kaCount 未到 10 时胖度档先命中)');

console.log('\n[persona_tune 动态生效 · registry 覆盖]');
setCfg({ keepaliveMaxTimes: 3 });
assert(decideActions(mock({ idle_min: 5, ctx_tok: 50_000, kaCount: 2 })),
       [{ type: 'KEEPALIVE' }], '狂人调 maxTimes=3, kaCount=2 → 心跳');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 50_000, kaCount: 3 })),
       [{ type: 'COMPACT', reason: 'keepalive_maxed' }], '狂人调 maxTimes=3, kaCount=3 → 提前压 (设计场景 H)');
resetCfg();

setCfg({ keepaliveMinTok: 50_000 });
assert(decideActions(mock({ idle_min: 5, ctx_tok: 30_000 })),
       [], '飞飞调 minTok=50k, ctx 30k → 不心跳 (per-persona 覆盖生效)');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 60_000 })),
       [{ type: 'KEEPALIVE' }], '飞飞调 minTok=50k, ctx 60k → 心跳');
resetCfg();

setCfg({ keepaliveMaxTimes: 20, keepaliveMinTok: 15_000 });
assert(decideActions(mock({ idle_min: 5, ctx_tok: 18_000, kaCount: 15 })),
       [{ type: 'KEEPALIVE' }], '多字段覆盖组合 · maxTimes=20 minTok=15k, kaCount 15 → 心跳');
resetCfg();

console.log('\n[v7 动态门 · wakeCtxBase * ratio]');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 65_000, wakeCtxBase: 60_000 })),
       [], '基数 60k, ctx 65k (< 72k=60k*1.2) → 净涨不够, 不心跳 (设计场景: 有对话但没实质涨)');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 80_000, wakeCtxBase: 60_000 })),
       [{ type: 'KEEPALIVE' }], '基数 60k, ctx 80k (> 72k=60k*1.2) → 净涨超 20%, 心跳');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 60_000, wakeCtxBase: 60_000 })),
       [], '基数 60k, ctx=基数 → 门 72k 未过, 不心跳 (刚苏醒状态)');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 15_000, wakeCtxBase: null })),
       [], '首次苏醒 wakeCtxBase=null, ctx 15k < 20k 兜底门 → 不心跳');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 25_000, wakeCtxBase: null })),
       [{ type: 'KEEPALIVE' }], '首次苏醒 wakeCtxBase=null, ctx 25k > 20k 兜底门 → 心跳 (兜底路径)');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 65_000, wakeCtxBase: 60_000, dirty: false })),
       [], '基数 60k, ctx 80k, dirty=false → dirty 门优先拦, 不心跳');

setCfg({ keepaliveRatio: 1.5 });
assert(decideActions(mock({ idle_min: 5, ctx_tok: 80_000, wakeCtxBase: 60_000 })),
       [], 'tune ratio=1.5, 基数 60k, ctx 80k (< 90k=60k*1.5) → 不心跳');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 100_000, wakeCtxBase: 60_000 })),
       [{ type: 'KEEPALIVE' }], 'tune ratio=1.5, 基数 60k, ctx 100k (> 90k) → 心跳');
resetCfg();

setCfg({ keepaliveMinTok: 50_000 });
assert(decideActions(mock({ idle_min: 5, ctx_tok: 65_000, wakeCtxBase: 60_000 })),
       [], 'wakeCtxBase 有值时忽略 keepaliveMinTok, 用 wakeCtxBase*1.2=72k, ctx 65k → 不心跳 (动态门优先)');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 60_000, wakeCtxBase: null })),
       [{ type: 'KEEPALIVE' }], '无基数 fallback 到 keepaliveMinTok=50k, ctx 60k > 50k → 心跳');
resetCfg();

console.log('\n[悬挂问句检测 · 已退出压缩链路, 只剩任务自动续跑在用]');
assert([{ type: detectAssistantQuestion('要不要现在重启？') ? 'Q' : 'X' }], [{ type: 'Q' }], '末尾 ？→ Q');
assert([{ type: detectAssistantQuestion('go?') ? 'Q' : 'X' }], [{ type: 'Q' }], '末尾 ? → Q');
assert([{ type: detectAssistantQuestion('要不要现在重启，还是你手动来') ? 'Q' : 'X' }], [{ type: 'Q' }], '"要不要...还是" 无问号 → Q (兜底短语)');
assert([{ type: detectAssistantQuestion('好的 我改完了。') ? 'Q' : 'X' }], [{ type: 'X' }], '陈述句结尾 → X (不误判)');
assert([{ type: detectAssistantQuestion('') ? 'Q' : 'X' }], [{ type: 'X' }], '空文本 → X');
// 🔴 这段正则本来就认不全中文反复问句(「对不对」「是不是」都漏), 2026-09-11 实测被它漏掉一次
// 就把整个会话清了。所以判定链路已经不看它 —— 清空会话这种不可逆动作, 不该由一张词表决定。
assert([{ type: detectAssistantQuestion('还是你先看这张表对不对。') ? 'Q' : 'X' }], [{ type: 'X' }],
       '「对不对。」它就是认不出来 —— 记录既有缺陷, 而压缩已不再依赖它');
assert(decideActions(mock({ idle_min: 2, ctx_tok: 300_000 })),
       [{ type: 'SAVE_NUDGE', reason: 'ctx_tier' }], '带不带悬挂问句都一样: 该提醒就提醒, 反正不销毁任何东西');

console.log('\n[T2 / T3]');
assert(decideActions(mock({ idle_min: 30 * 60, ctx_tok: 50_000 })),
       [{ type: 'COMPACT', reason: 'tier2_timeout' }], 'T2 (30h) ctx 50k → 直接压 (30 小时没人说话 = 没人在看)');
assert(decideActions(mock({ idle_min: 30 * 60, ctx_tok: 20_000 })),
       [], 'T2 (30h) ctx 20k → 无动作');
assert(decideActions(mock({ idle_min: 8 * 24 * 60, ctx_tok: 50_000 })),
       [{ type: 'SLEEP', reason: 'tier3' }], 'T3 → SLEEP (仅观察)');

// ── 胖度梯度 ──
// 三档 15%/30%/45% 原样保留(2026-09-11 未改档位), 改的只是动作: 这三档从"直接压"换成"发提醒"
// —— 它们判的是"胖", 判不出"人在不在"。强制压缩仍有三条: 80% 红线 + keepalive_maxed + tier2_timeout。
// 档位越高催得越密(30min / 15min / 5min), 正文也各写一份, 措辞紧急度递增。
console.log('\n[胖度梯度 · 地板档 150k~300k: 维持"停手 1min"]');
assert(decideActions(mock({ idle_min: 0.5, ctx_tok: 200_000 })),
       [], 'ctx 200k idle 30s → 不催 (地板档要满 1min, 别在人打字时插嘴)');
assert(decideActions(mock({ idle_min: 1.5, ctx_tok: 200_000 })),
       [{ type: 'SAVE_NUDGE', reason: 'ctx_tier' }], 'ctx 200k idle 90s → 催一次');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 100_000 })),
       [{ type: 'KEEPALIVE' }], 'ctx 100k idle 5min → 不催, 只保活 (低于地板, 再闲也不催)');

console.log('\n[胖度梯度 · 紧一档 300k~450k: idle 门缩到 15s, 15min 催一次]');
assert(decideActions(mock({ idle_min: 0.4, ctx_tok: 350_000 })),
       [{ type: 'SAVE_NUDGE', reason: 'ctx_tier' }], 'ctx 350k idle 24s → 催');
assert(decideActions(mock({ idle_min: 0.1, ctx_tok: 350_000 })),
       [], 'ctx 350k idle 6s → 不催 (还没到 15s, 你可能只是在换气)');
assert(decideActions(mock({ idle_min: 5, ctx_tok: 350_000, lastSaveNudgeAgoMin: 10 })),
       [{ type: 'KEEPALIVE' }], 'ctx 350k 但 10min 前刚催过 → tight 档 15min 间隔内不重复');

console.log('\n[胖度梯度 · urgent 档 ≥450k: 回合一结束就催, 5min 一次]');
assert(decideActions(mock({ idle_min: 0, ctx_tok: 500_000 })),
       [{ type: 'SAVE_NUDGE', reason: 'ctx_tier' }], 'ctx 500k idle 0 → 立刻催 (每轮已是起步价 5 倍)');
assert(decideActions(mock({ idle_min: 0, ctx_tok: 500_000, running: true })),
       [], 'ctx 500k 但回合进行中 → 不催 (running 门永远优先, 不插正在跑的流)');
assert(decideActions(mock({ idle_min: 0, ctx_tok: 500_000, dirty: false })),
       [], 'ctx 500k 但 dirty=false → 不催 (没有没沉的活, 催什么)');
assert(decideActions(mock({ idle_min: 0, ctx_tok: 500_000, lastSaveNudgeAgoMin: 3 })),
       [], 'ctx 500k 但 3min 前刚催过 → urgent 档 5min 间隔内不重复');
assert(decideActions(mock({ idle_min: 0, ctx_tok: 500_000, lastSaveNudgeAgoMin: 6 })),
       [{ type: 'SAVE_NUDGE', reason: 'ctx_tier' }], 'ctx 500k · 6min 前催过 → 过了 5min 间隔, 再催一次');

console.log('\n[胖度梯度 · 纯函数边界]');
function gateCase(tok, want, label) {
  const g = compactGate(tok);
  const got = g ? g.tier : null;
  if (got === want) { console.log('  ✓', label); pass++; }
  else { console.log('  ✗', label, ' got:', got, ' want:', want); fail++; }
}
gateCase(149_999, null, '149,999 → 不压');
gateCase(COMPACT_HARDCAP_SOFT_TOK, 'soft', '150k 整 → soft (边界含等号)');
gateCase(299_999, 'soft', '299,999 → soft');
gateCase(COMPACT_TIER_TIGHT_TOK, 'tight', '300k 整 → tight');
gateCase(449_999, 'tight', '449,999 → tight');
gateCase(COMPACT_TIER_URGENT_TOK, 'urgent', '450k 整 → urgent');
gateCase(800_000, 'urgent', '800k → urgent');
// persona_tune 把 idle 调得比梯度还紧的人格, 不该被梯度反向放松
const tuned = compactGate(350_000, COMPACT_HARDCAP_SOFT_TOK, 0.1);
if (tuned.idleMin === 0.1) { console.log('  ✓ tune idleMin=0.1 的人格进 tight 档仍是 0.1 (梯度只收紧不放松)'); pass++; }
else { console.log('  ✗ tune idleMin=0.1 被梯度放松成', tuned.idleMin); fail++; }
// 起压地板可被 persona_tune 抬高/压低
if (compactGate(120_000, 100_000) && compactGate(120_000, 100_000).tier === 'soft') { console.log('  ✓ 地板可 tune: softFloor=100k 时 120k 就进 soft 档'); pass++; }
else { console.log('  ✗ softFloor 覆盖失效'); fail++; }

// 🔴 按 window 比例分档 —— 老版三档写死 150k/300k/450k 在 200k 窗口的模型上后两档永远够不着,
// 分档整个瘸掉。现在传 windowTok 就按 15%/30%/45% 现算, 200k 模型上门在 30k/60k/90k 触发。
function gateByWin(tok, win, want, label) {
  const g = compactGate(tok, null, undefined, win);
  const got = g ? g.tier : null;
  if (got === want) { console.log('  ✓', label); pass++; }
  else { console.log('  ✗', label, ' got:', got, ' want:', want); fail++; }
}
console.log('\n[压缩梯度 · 按 window 比例分档]');
gateByWin( 29_999, 200_000, null,     '200k 窗口 · ctx 29,999 → 不压 (地板 30k=15%)');
gateByWin( 30_000, 200_000, 'soft',   '200k 窗口 · ctx 30k 整 → soft');
gateByWin( 60_000, 200_000, 'tight',  '200k 窗口 · ctx 60k → tight (30%)');
gateByWin( 90_000, 200_000, 'urgent', '200k 窗口 · ctx 90k → urgent (45%) — 老版此处只有 soft, 后两档永远够不着');
gateByWin(150_000, 1_000_000, 'soft',   '1M 窗口 · ctx 150k → soft (与老死值同)');
gateByWin(300_000, 1_000_000, 'tight',  '1M 窗口 · ctx 300k → tight');
gateByWin(450_000, 1_000_000, 'urgent', '1M 窗口 · ctx 450k → urgent');
gateByWin(149_999, 1_000_000, null,     '1M 窗口 · ctx 149,999 → 不压 (地板 150k=15%)');

// 🔴 起压地板还得跟起床成本挂钩 —— 2026-09-04 实测: 200k 窗口的人格 wakeCtxBase 17k~66k,
// 而纯比例地板只有 30k, 于是压完立刻又够条件, 半小时自动压 6 次, 每轮白烧一次起床。
console.log('\n[起压地板 · 不得低于起床成本 × 3]');
function gateByWake(tok, win, wake, want, label) {
  const g = compactGate(tok, null, undefined, win, wake);
  const got = g ? g.tier : null;
  if (got === want) { console.log('  ✓', label); pass++; }
  else { console.log('  ✗', label, ' got:', got, ' want:', want); fail++; }
}
gateByWake( 50_000, 200_000, 60_000, null,     '200k 窗口 · 起床 60k · ctx 50k → 不压 (地板抬到 180k, 老版此处已压 → 死循环)');
gateByWake(180_000, 200_000, 60_000, 'urgent', '200k 窗口 · 起床 60k · ctx 180k → 压 (地板到了, 且早过 45% 档)');
gateByWake( 51_000, 200_000, 17_000, 'soft',   '200k 窗口 · 起床 17k · ctx 51k → 压 (地板 51k, 起床便宜就该早压)');
gateByWake(150_000, 1_000_000, 50_000, 'soft', '1M 窗口 · 起床 50k · ctx 150k → soft (两项算出来一样, 老行为不变)');
gateByWake(100_000, 1_000_000, 17_000, null,   '1M 窗口 · 起床 17k · ctx 100k → 不压 (比例项 150k 兜住, 不因起床便宜就狂压)');
gateByWake(149_999, 1_000_000, null,   null,   '1M 窗口 · 首次苏醒未测出基数 → 退回纯比例, 与老行为一致');
{
  // 小窗口 + 贵起床 = 地板高过红线, 这条轨道自然失效只剩红线兜底(算出来该如此, 不是特例)
  const g = compactGate(100_000, null, undefined, 128_000, 40_000);
  if (g === null) { console.log('  ✓ 128k 窗口 · 起床 40k · ctx 100k → 省钱轨道不触发, 交给 80% 红线(102.4k)'); pass++; }
  else { console.log('  ✗ 小窗口本该只剩红线, 却进了', g.tier); fail++; }
}

// —— 记时间戳那一侧 ——
// 上面那三条只测了【消费】lastBgLaunchTs 的一侧, 谁来设它没人测 —— 于是 consume.js 里那个条件
// 写死了 `b.name === 'Bash'`, 用 Agent 挂后台的人格照压不误, 而这三条断言全绿。
// 两侧只测一侧的盲区, 拿源码断言堵上。
console.log('\n[记时间戳那一侧 · 不能只认 Bash]');
{
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'agent', 'consume.js'), 'utf8');
  const setter = /if \(\(?b\.input && b\.input\.run_in_background === true\)[\s\S]{0,200}?lastBgLaunchTs = Date\.now\(\)/;   // 11-10 起工作流(一律后台)也算
  if (setter.test(src)) { console.log('  ✓ 判据是"这次调用要不要后台跑", 不挑工具名'); pass++; }
  else { console.log('  ✗ consume.js 里 lastBgLaunchTs 的设置条件变了 —— 确认 Agent 挂后台时也记得上'); fail++; }
  if (!/b\.name === ['"]Bash['"] && b\.input && b\.input\.run_in_background/.test(src)) {
    console.log('  ✓ 没有写死只认 Bash'); pass++;
  } else { console.log('  ✗ 又写死成只认 Bash 了(2026-08-26 修过一次: Agent 挂的后台任务会被压缩杀掉)'); fail++; }
}

// —— 接入故障挂起期间不许再烧钱 ——
// 2026-09-18 实测的代价: 三个人格挂了近 4 小时, 保活/提醒轨道全程照跑。挂起的人格发什么都是
// 白撞同一个错, 保活保的那份 cache 更是永远用不上。只留 PARK(不花 token) 和 SLEEP(纯 log)。
console.log('\n[挂起期间停手 · 除了 PARK 一律不做]');
{
  // 同样的参数, 不挂起时本该出 KEEPALIVE
  assert(decideActions(mock({ idle_min: 5, ctx_tok: 300_000, kaCount: 0 })),
         [{ type: 'SAVE_NUDGE' }, { type: 'KEEPALIVE' }], '对照组: 没挂起 → 提醒 + 保活照出');
  assert(decideActions(mock({ idle_min: 5, ctx_tok: 300_000, kaCount: 0, authBlocked: true })),
         [], '🔴 挂起中 → 不保活(cache 保了也用不上, 纯烧钱)');
  // 够胖 + 够闲, 本该出 SAVE_NUDGE
  assert(decideActions(mock({ idle_min: 40, ctx_tok: 300_000, ctx_pct: 30, kaCount: 99, authBlocked: true })),
         [], '🔴 挂起中 → 不发存记忆提醒(人格答不了话, 提醒只会堆气泡)');
  // 红线级也不例外: 压缩要跑一整个回合, 挂起时跑不动
  assert(decideActions(mock({ idle_min: 40, ctx_tok: 850_000, ctx_pct: 85, kaCount: 99, authBlocked: true })),
         [], '🔴 挂起中 → 连红线压缩都不发(它同样要一个跑得动的回合)');
  // PARK 是唯一放行的: 不花 token, 且挂起的人格攥着的子进程握的还是旧凭证
  assert(decideActions(mock({ idle_min: 40, ctx_tok: 5_000, dirty: false, kaCount: 99, authBlocked: true })),
         [{ type: 'PARK' }], '🔴 挂起中仍放行 PARK —— 它不花钱, 而那个子进程握的是旧凭证');
}

console.log('\n[闲了就清空 idleClearMin (行业版店铺助手)]');
{
  setCfg({ idleClearMin: 5 });
  assert(decideActions(mock({ idle_min: 6, ctx_tok: 40_000 })),
         [{ type: 'IDLE_CLEAR', reason: 'idle_clear' }], '闲 6min · 有活 → 清空, 不保活');
  assert(decideActions(mock({ idle_min: 4, ctx_tok: 40_000 })),
         [], '闲 4min 未到点 → 什么都不做(保活整条关掉)');
  assert(decideActions(mock({ idle_min: 6, ctx_tok: 40_000, running: true })),
         [], '回合进行中 → 不清');
  assert(decideActions(mock({ idle_min: 6, ctx_tok: 40_000, hasStream: false })),
         [], '流已不在(刚清过) → 不重复清');
  assert(decideActions(mock({ idle_min: 6, ctx_tok: 40_000, bgLaunchAgoMin: 1 })),
         [], '后台任务刚开跑 → 不清');
  assert(decideActions(mock({ idle_min: 1, ctx_tok: 850_000, ctx_pct: 85 })),
         [{ type: 'COMPACT', reason: 'red_line' }], '红线照旧优先走沉淀式压缩');
  resetCfg();
  assert(decideActions(mock({ idle_min: 6, ctx_tok: 40_000 })).filter((a) => a.type === 'IDLE_CLEAR'),
         [], '没开 idleClearMin → 不会闲时清空(个人版行为不变)');
}

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
