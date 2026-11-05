// idle-watcher.js — 人格空闲期的自我维护: 保活 / 压缩 / 体检 / 子进程回收。两版共用。
//
// 大脑和记忆是内核, 所以这条巡检轨道也必须是一份 —— 以前调度层写在 personal/main.js 里,
// 行业版一条都没接, 店小二的记忆库从来没做过体检 (2026-09-04 作者点破)。
// 纯判定住在隔壁两个 gate 模块 (compact-gate / checkup-gate), 这里只管调度与执行。
// 宿主差异全部收在 host 适配对象里: personal 有 registry 多人格, 行业版一进程一人格。
//
// 🔴 decideActions 是纯函数 (不碰宿主 IO), test-idle-watcher.js 直接 require 它 ——
//    以前那份测试是把 main.js 的决策矩阵逐字抄了一遍, 改一处要同步两处, 必漂。
'use strict';

const {
  compactGate,
  COMPACT_HARDCAP_IDLE_MIN,
  COMPACT_HARDCAP_MIN_INTERVAL_MS,
} = require('./compact-gate');
const { checkupGate, checkupFindings, conflictFinding,
        CONFLICT_SAMPLE_CAP, CHECKUP_IDLE_MIN } = require('./checkup-gate');
const sched = require('./schedule');
const reminders = require('./reminders');

const IDLE_WATCH_INTERVAL_MS = 30_000;
const HEARTBEAT_COOLDOWN_MS = 240_000;   // 4 min · Anthropic cache TTL=5min, 留 1min buffer
/* 🔴 短路标记的无条件上界。心跳一轮是几秒的事, 挂到这个岁数只有一种解释: **那一轮的收尾
   信号没来**。把复位挂在「下一轮一定会来」这个假设上是本仓反复栽的同一个坑
   (core/agent/turn-release.js:12 已经写下这句), 而这里的假设更脆: SDK 会把排队的提交并进
   正在跑的那一轮, 于是两次提交只回一个 result, 心跳那一份的 onTurnEnd 永远不来。
   卡住的代价是保活/记忆体检/清空自愈**全停且无声**, 所以宁可多发一次心跳。 */
const HEARTBEAT_PENDING_MAX_MS = 120_000;   // 2 min
const KEEPALIVE_MIN_TOK = 20_000;        // ctx <20k (起床清单量级) 冷读极便宜, 不值当保活
const KEEPALIVE_MAX_TIMES = 10;          // 保 N 次 ≈ 冷起 1 次 (cache_read 0.1× vs input 1×) → N=10 盈亏平衡
const BG_HOLD_MIN = 30;                  // 后台任务开跑后暂缓压缩的时长(分钟)
const PARK_IDLE_MIN = 30;                // 闲置多久把子进程还回去
const TASK_CONTINUE_MAX = 8;

// 🔴 续跑退避表 (作者 2026-09-25 定案): 第 N 次续跑前等多久。老版固定 2 秒 × 8 连发是纯空转 ——
// 能被列进清单又还 pending 的, 必然是有东西要解决, 不是催两秒就能变出来的。分钟级足够。
// 表末之后维持末值, 直到撞 TASK_CONTINUE_MAX 或 markActivity 清零。
const TASK_CONTINUE_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000, 1_800_000];   // 1m · 2m · 5m · 10m · 30m

// 第 run 次续跑该等多久 (run 从 1 起算)。
function taskContinueDelayMs(run) {
  const i = Math.max(0, Math.min((run || 1) - 1, TASK_CONTINUE_BACKOFF_MS.length - 1));
  return TASK_CONTINUE_BACKOFF_MS[i];
}

// COMPACT 失败指数退避: 每次失败按此表延时下一次尝试. 表末之后视为"卡死", 永久退避直到 markActivity 重置.
const COMPACT_BACKOFF_MS = [30_000, 120_000, 300_000, 900_000];

function classifyTier(lastActivityTs) {
  const hours = (Date.now() - lastActivityTs) / 3_600_000;
  if (hours < 24) return 'T1';
  if (hours < 24 * 7) return 'T2';
  return 'T3';
}

// AI 悬挂问句检测: 回合末抛问句给用户 = 等回复中。
// ⚠️ 只剩 personal/main.js 的"任务自动续跑"在用, 猜漏了顶多多跑一轮。
// 压缩链路已不再用它 —— 靠一段正则词表猜中没猜中来决定要不要清空会话, 判据配不上后果(2026-09-11 作者批)。
function detectAssistantQuestion(text) {
  if (!text) return false;
  const tail = String(text).trim().slice(-100);
  if (/[?？]\s*$/.test(tail)) return true;
  if (/(要不要|是否|好吗|对吗|行吗|可以吗|吗\s*$|继续吗|开始吗|你想|如何|怎么办|哪个|选哪)/.test(tail)) return true;
  return false;
}

// 记录人格 activity (分级依据) + 清心跳短路标记 (免真消息响应被吞).
function markActivity(s) {
  if (!s) return;
  s.last_activity_ts = Date.now();
  s.heartbeat_pending = false;
  s.lastTurnWasQuestion = false;   // 用户/peer 回话了, 清悬挂问句位(限流软顶用; 续跑已不看它)
  s.taskContinueRuns = 0;          // 有人说话了 → 自动续跑次数清零
  // 退避到分钟级之后, 挂起的那次续跑可能还在定时器里等着 —— 人一说话就作废, 免得
  // 对话已经走远了它还按一分钟前的清单补跑一轮。
  if (s.taskContinueTimer) { clearTimeout(s.taskContinueTimer); s.taskContinueTimer = null; }
  if (s.compactFailCount || s.compactBackoffUntil) {
    s.compactFailCount = 0;
    s.compactBackoffUntil = 0;
  }
}

// 体检: 先过便宜的门, 最后才跑 doctor —— doctor 要遍历全部节点逐个读 body, 近千节点的库
// 不便宜, 绝不能每 30s 巡检都跑一遍。
function decideCheckup(s, { running, idle_min, ctx_tok, personaCfg, checkupDefaults, log }) {
  if (running) return null;
  const ck = { ...(checkupDefaults || {}), ...personaCfg };   // 人格级可覆盖全局默认
  if (idle_min < (Number(ck.checkupIdleMin) || CHECKUP_IDLE_MIN)) return null;
  const st = s.butler && s.butler.memory && s.butler.memory.store;
  if (!st || typeof st.getMeta !== 'function') return null;   // v1 库没有 meta 表, 这条通路不生效
  let lastTs = 0;
  try { lastTs = Number(st.getMeta('last_checkup_ts')) || 0; } catch (_) { return null; }

  const due = checkupGate({
    running,
    idleMin: idle_min, ctxTok: ctx_tok, lastCheckupTs: lastTs, now: Date.now(), cfg: ck,
  });
  if (!due) return null;

  // 🔴 不管有没有查出问题都要记时间戳, 否则库干净的时候会每 30s 重跑一遍体检。
  //    "查过了" 和 "查出问题了" 是两件事, 计时器跟的是前者。
  try { st.setMeta('last_checkup_ts', String(Date.now())); } catch (_) {}

  // 🔴 doctor(455ms) 与冲突普扫(3.4s)【不在这里跑】。这函数是每 30s 巡检都会走的决策矩阵,
  //    而它是同步的 —— 在这儿跑重活等于每次体检都把主进程占死几秒, 界面一个字都打不进。
  //    真扫描搬到 executeIdleAction 的 CHECKUP 分支(那边本来就是 async), 分片让出事件循环。
  return { reason: due.reason, cfg: ck };
}

// 真扫描。跑多久都行 —— 它在后台分片跑, 用户无感知; 扫出东西了才戳人格。
async function runCheckup(s, ck, log) {
  const findings = [];
  try { findings.push(...checkupFindings(s.butler.memory.doctor(), ck)); } catch (e) {
    (log || console.error)(`[checkup] ${s.butler.name} doctor 失败: ${e && e.message}`);
  }
  // 冲突普扫并进体检: 全库两两配对本来就是"定期体检"该干的活, 挂在起床或每次检索上都是错位。
  try {
    // 只报个数不带明细(信号不是医生, 哪两条打架让人格自己跑 conflict_scan 拿实时的);
    // 取样上限放得宽是因为扫描在后台分片跑、用户无感知(见函数头), 措辞与到顶判定在 gate 里。
    const cf = conflictFinding(await s.butler.memory.conflictCandidatesChunked({ max: CONFLICT_SAMPLE_CAP }));
    if (cf) findings.push(cf);
  } catch (e) {
    (log || console.error)(`[checkup] ${s.butler.name} 冲突普扫失败: ${e && e.message}`);
  }
  return findings;
}

/**
 * 决策矩阵。纯函数 —— 除 decideCheckup 会写一次 meta 时间戳外不碰宿主 IO。
 * opts: { personaCfg, checkupDefaults, log }
 *   personaCfg      人格级参数覆盖 (personal 走 registry, 行业版给 {} 即可)
 *   checkupDefaults 体检阈值全局默认 (config-loader 的 main/memory_checkup)
 */
function decideActions(s, opts = {}) {
  const cfg = opts.personaCfg || {};
  const u = s.butler.usage() || {};
  const ctx_pct = u.pct || 0;
  const ctx_tok = u.inTok || 0;
  const idle_min = (Date.now() - s.last_activity_ts) / 60_000;
  const tier = classifyTier(s.last_activity_ts);
  const meta = { tier, idle_min: Math.round(idle_min), ctx_tok, ctx_pct };
  const actions = [];
  // 🔴 回合进行中禁止一切非红线压缩: 长回合期间 last_activity_ts 不更新, 静默判定会误判 idle,
  // doCompact 会拆掉正在跑的流. 红线例外 (救命优先).
  const running = !!(s.butler.isRunning && s.butler.isRunning());
  // 🔴 后台任务在跑 ≠ 回合在跑: 人格起了后台构建后回合正常结束, isRunning() 立刻为假,
  // 被判 idle 压缩恰恰杀掉它正在等的那个构建。到期自动放行, 免得一次漏记就把压缩永久锁死。
  const dirty = !!s.butler.dirtySinceLastClear;
  const maxTimes = Number(cfg.keepaliveMaxTimes) || KEEPALIVE_MAX_TIMES;
  // 动态门 = wakeCtxBase(苏醒稳态基数) × ratio. 语义 "净涨超 ratio-1 才值得保 cache".
  // 首次苏醒尚未写入基数时走 keepaliveMinTok 死值兜底。
  const ratio    = Number(cfg.keepaliveRatio)    || 1.2;
  const wakeBase = s.butler.wakeCtxBase || 0;
  const minTok   = wakeBase ? Math.round(wakeBase * ratio) : (Number(cfg.keepaliveMinTok) || KEEPALIVE_MIN_TOK);
  const kaCount  = s.butler.keepalive_count || 0;
  const bgHoldMs = (cfg.bgHoldMin != null ? Number(cfg.bgHoldMin) : BG_HOLD_MIN) * 60_000;
  const bgBusy   = bgHoldMs > 0 && Date.now() - (s.butler.lastBgLaunchTs || 0) < bgHoldMs;
  // 胖度梯度: 决定这一档要等多久空闲才开口、以及多久催一次。null = 还没到该提醒的胖度。
  const gate = compactGate(
    ctx_tok,
    cfg.compactHardcapSoftTok || null,              // 不覆盖时 gate 用 max(window*0.15, wakeBase*3) 现算
    cfg.compactHardcapIdleMin != null ? cfg.compactHardcapIdleMin : COMPACT_HARDCAP_IDLE_MIN,
    u.window || null,                               // 让 gate 按 window 比例分档, 200k/1M 通用
    wakeBase);                                      // 地板不得低于起床成本的倍数, 免得压完立刻又够条件

  // ── 上下文轨道 (与保活并行判定, 不排斥) ──
  // 🔴 强制压缩三条: 80% 红线 + keepalive_maxed + tier2_timeout —— 后两条是"人确实走了"的**证据**,
  //    没人在看的会话该压就压, 那个比例本来就是按最省钱算出来的。
  //    只有 ctx 三档(15/30/45%)降为提醒(SAVE_NUDGE): 那三档判的是"胖", 判不出"人在不在",
  //    而人还在的时候清空会话是不可逆的。理由见 core/compact-gate.js 头部。
  const nudgeGap = cfg.compactHardcapMinIntervalMs || (gate && gate.nudgeIntervalMs) || COMPACT_HARDCAP_MIN_INTERVAL_MS;
  const nudgeDue = Date.now() - (s.lastSaveNudgeTs || 0) >= nudgeGap;
  // 闲了就清空(人格级 idleClearMin 分钟, 0/缺省 = 关): 开了它, 保活轨道整条停掉, 闲到这个分钟数直接清。
  // 适用于「连续性全靠记忆和库, 上下文只是工作内存」的人格(行业版店铺助手) —— 保活是为续 cache, 而清了
  // 之后新会话只重写固定底座, 比一直按整段上下文续命便宜(10-19 作者定)。
  const idleClearMin = Number(cfg.idleClearMin) || 0;
  if (ctx_pct >= 80) {
    // 硬红线: 无视 tier/idle/dirty 立即压. 救命防被动压缩丢线索. doCompact 本身是"先沉淀再清空"。
    actions.push({ type: 'COMPACT', reason: 'red_line', ...meta });
  } else if (idleClearMin > 0 && dirty && !running && !bgBusy && idle_min >= idleClearMin
             && s.butler.hasStream && s.butler.hasStream()) {
    actions.push({ type: 'IDLE_CLEAR', reason: 'idle_clear', ...meta });
  } else if (dirty && !running && !bgBusy && kaCount >= maxTimes && nudgeDue) {
    // keepalive_maxed: 保 maxTimes 次都没人回 —— 这是"人确实走了"的证据, 比 idle 时钟准, 所以照旧直接压。
    actions.push({ type: 'COMPACT', reason: 'keepalive_maxed', ctx_tier: 'urgent', keepalive_count: kaCount, ...meta });
  } else if (dirty && !running && !bgBusy && tier === 'T2' && ctx_tok >= 30_000 && nudgeDue) {
    actions.push({ type: 'COMPACT', reason: 'tier2_timeout', ctx_tier: 'urgent', ...meta });
  } else if (dirty && !running && !bgBusy && gate && idle_min >= gate.idleMin && nudgeDue) {
    // 🔴 排在两条压缩之后: 提醒抢在前面会把它们 else 掉, 于是 ctx 越胖反而越不压, 正好反了。
    actions.push({ type: 'SAVE_NUDGE', reason: 'ctx_tier', ctx_tier: gate.tier, ...meta });
  }

  // ── KEEPALIVE 轨道 ──
  // T1 · idle≥4min · ctx≥minTok(动态) · dirty · kaCount<maxTimes → 保活. cache TTL 5min, 心跳 4min/次续到.
  // 回合进行中不保活: 长回合的工具调用本身就在续 cache, 此时插心跳会吞真回合输出.
  if (!idleClearMin && dirty && tier === 'T1' && idle_min >= 4 && ctx_tok >= minTok && kaCount < maxTimes && !running) {
    actions.push({ type: 'KEEPALIVE', keepalive_count: kaCount, keepalive_max: maxTimes, wake_base: wakeBase, min_tok: minTok, ...meta });
  }

  // ── CHECKUP 轨道: 定期给记忆库做体检, 有问题就戳人格 ──
  // 躲开 COMPACT: 压缩会拆掉正在跑的流, 而体检要跑一整个回合。
  // **体检优先, 保活让路** —— 体检本身就是一个真回合, 跑完 cache 自然续上;
  // 反过来让体检等保活的话, dirty=true 时保活一直在, 体检就永远等不到。
  if (!actions.some((a) => a.type === 'COMPACT' || a.type === 'SAVE_NUDGE')) {
    const cu = decideCheckup(s, {
      running, idle_min, ctx_tok,
      personaCfg: cfg, checkupDefaults: opts.checkupDefaults, log: opts.log,
    });
    if (cu) {
      const ka = actions.findIndex((a) => a.type === 'KEEPALIVE');
      if (ka >= 0) actions.splice(ka, 1);
      actions.push({ type: 'CHECKUP', ...cu, ...meta });
    }
  }

  // ── PARK 轨道: 闲置人格把子进程还回去 ──
  // 只在 !dirty 时回收 —— 手头没有没沉淀的活, 拆了不丢东西。
  // 天然排在压缩之后: 压缩跑完才会 dirty=false。复活由下一条消息的 ensureStream 完成, **插件不停**。
  const parkIdleMin = cfg.parkIdleMin != null ? Number(cfg.parkIdleMin) : PARK_IDLE_MIN;
  if (parkIdleMin > 0 && !dirty && !running && !bgBusy
      && idle_min >= parkIdleMin
      && !actions.length                       // 这一轮还有别的活要干就先让路, 下一轮再回收
      && s.butler.hasStream && s.butler.hasStream()) {
    actions.push({ type: 'PARK', reason: 'idle_reclaim', ...meta });
  }

  // ── T3 观察 (仅 log; 子进程回收已由 PARK 轨道接手) ──
  if (tier === 'T3') actions.push({ type: 'SLEEP', reason: 'tier3', ...meta });

  // 🔴 接入故障挂起中: 这个人格现在发什么都是白撞一次同样的错, 保活心跳更是纯烧钱
  // (保的那份 cache 根本用不上)。除了把子进程还回去, 一律不做 —— 等人点重登。
  // 代价实测: 2026-09-18 三个人格挂了近 4 小时, 期间保活/压缩轨道照常在跑。
  // PARK 留着是对的: 它不花 token, 而挂起的人格攥着子进程毫无意义(子进程握的还是旧凭证)。
  if (s.butler._authBlocked) {
    return actions.filter((a) => a.type === 'PARK' || a.type === 'SLEEP');
  }

  return actions;
}

/**
 * 造一个巡检器。宿主差异全在 host 里:
 *   sessions()            → Iterable<session>  personal 给 sessions.values(), 行业版给 [theOne]
 *   personaCfg(butler)    → object             人格级 persona_tune 覆盖, 没有就返回 {}
 *   checkupDefaults()     → object             体检阈值全局默认 (config-loader main/memory_checkup)
 *   renderCheckupNudge(o) → string             体检戳人格的那句话
 *   renderSaveNudge(o)    → string             上下文变胖时催人格存记忆/写交接清单的那句话(按 o.tier 取三档正文之一)
 *   muteSaveNudge         → boolean            可选。真 = 存档提醒那一轮静音不上屏(行业版); 不给 = 可见(个人版)
 *   scheduleHome(butler)  → string|null        人格目录(里面找 schedule.json; 提醒登记簿在 butler.memoryDir)。**不给就两样都不跑**
 *   appendEvent(name,t,d) → void               成本/决策事件日志, 可 no-op
 *   log(...)              → void
 */
function createIdleWatcher(host) {
  const log = host.log || console.log;
  const appendEvent = host.appendEvent || (() => {});
  const personaCfgOf = host.personaCfg || (() => ({}));
  const checkupDefaults = host.checkupDefaults || (() => ({}));

  // 全局 rate-limit 冻结时间戳: 任一人格撞铁板 → 到期前全体静默(不心跳/不压缩),
  // 免得每 30s 死磕重试自烧.
  let globalRateLimitedUntil = 0;

  // ——— 心跳: butler push 一条 self-explanatory heartbeat, subprocess 走一次真 API 请求续 cache TTL.
  // 心跳轮由 core 静音(agent/turn-mute.js), 界面零污染; s.heartbeat_pending 只管"心跳发了还没收尾", 由宿主 onTurnEnd 复位.
  async function sendHeartbeat(s) {
    if (!s) return { ok: false, error: '会话不存在' };
    if (s.heartbeat_pending) {
      const age = Date.now() - (s.heartbeat_pending_ts || 0);
      if (age < HEARTBEAT_PENDING_MAX_MS) return { ok: false, error: '心跳进行中' };
      // 自愈。一行落账 —— 無言で直すと、詰まっていた事自体が誰にも見えない。
      log(`[idle-watch] ${(s.butler && s.butler.name) || s.sid} heartbeat_pending が ${Math.round(age / 1000)}s 挂かったまま → 取り下げて続ける(回合の収尾信号が来なかった)`);
      s.heartbeat_pending = false;
    }
    // 🔴 回合进行中禁止心跳: heartbeat_pending 会短路所有 UI 事件, 把正在跑的真回合后半段输出全吞掉.
    if (s.butler.isRunning()) return { ok: false, error: '回合进行中, 跳过心跳' };
    s.heartbeat_pending = true;
    s.heartbeat_pending_ts = Date.now();   // 上界を測る為の起点(これが無いと age が常に巨大)
    const name = (s.butler && s.butler.name) || s.sid;
    const u_at_send = (s.butler.usage && s.butler.usage()) || {};
    appendEvent(name, 'keepalive_sent', { ctx_tok: u_at_send.inTok || 0, ctx_pct: u_at_send.pct || 0 });
    try {
      await s.butler.submit('[[HEARTBEAT]] (System · no-op cache keepalive · not a user message) Reply with just "ok" and nothing else.', undefined, { sourceKind: 'auto' });
      s.butler.keepalive_count = (s.butler.keepalive_count || 0) + 1;
      return { ok: true };
    } catch (e) {
      s.heartbeat_pending = false;   // submit 失败清标记, 免卡死
      appendEvent(name, 'keepalive_failed', { error: String((e && e.message) || e) });
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // 体检结果投给人格。
  // 🔴 **不设 heartbeat_pending**, 这是可见回合 —— 那个标记会把 onText/onTool 全部吞掉,
  //    人格问了用户也看不见, "干不干活还是 AI 跟用户决定"那条规矩就成了空话。
  async function sendCheckupNudge(s, findings = []) {
    if (!s) return { ok: false, error: '会话不存在' };
    if (s.heartbeat_pending) return { ok: false, error: '已有静默回合在跑' };
    if (s.butler.isRunning()) return { ok: false, error: '回合进行中, 跳过' };
    // 一行短摘要就够 —— 触发器是信号不是医生, 细节让人格自己跑 memory_admin(op=doctor) 拿实时的
    const summary = findings.map((f) => f.label).join(' · ');
    try {
      // _allowEmptyTurn: 整理完没有要问人的事就该一个字不说 —— 不开这个口子, 空回合兜底会把
      // 这份沉默当成"模型卡住"追问一次, 把刚消掉的噪音原样请回来。
      await s.butler.submit(host.renderCheckupNudge({ summary }), undefined, { sourceKind: 'auto', _allowEmptyTurn: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // 上下文变胖 → 催人格存记忆 + 写交接清单, 压不压由它自己拍板。
  // 🔴 与体检同理: **不设 heartbeat_pending**, 这是可见回合 —— 人格可能要回头问用户"现在方便清一下吗",
  //    静默回合会把那句话吞掉, "压不压由人格拍板"就又成了空话。
  async function sendSaveNudge(s, action) {
    if (!s) return { ok: false, error: '会话不存在' };
    if (s.heartbeat_pending) return { ok: false, error: '已有静默回合在跑' };
    if (s.butler.isRunning()) return { ok: false, error: '回合进行中, 跳过' };
    if (!host.renderSaveNudge) return { ok: false, error: '宿主没给 renderSaveNudge' };
    try {
      // 🔴 正文按档位分三份, 紧急度递增 —— 光靠催的密度分级不够, 同一段话读第三遍就没有分量了。
      const body = host.renderSaveNudge({
        tier: action.ctx_tier || 'soft',
        pct: action.ctx_pct,
        tok: action.ctx_tok,
        idle_min: action.idle_min,
      });
      const opts = { sourceKind: 'auto', _allowEmptyTurn: true,   // 没东西存就一个字不说, 同体检
        // 宿主可要求静音: 行业版不拿上下文的事问店主(save_nudge_urgent 覆盖), 这一轮的话只会把
        // 「This stretch produced…」这类内务独白摆到店主眼前(10-14 dev)。个人版不传, 照旧可见。
        _mute: !!host.muteSaveNudge };
      // 单独跑一轮(runAlone): 最高档不等人停手, 和刚打进来的一句合进同一轮, 那句就被提醒盖住(10-14 dev)。
      if (typeof s.butler.runAlone === 'function') s.butler.runAlone(body, opts, 'save-nudge');
      else await s.butler.submit(body, undefined, opts);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /* 定时任务 + 提醒登记簿(core/reminders.js)。**不进 decideActions** —— 到点就该跑, 跟闲不闲没关系,
     唯一要躲的是回合进行中。宿主不给 scheduleHome 就整条不跑(两版现在都给; 这是两版唯一的定时驱动)。
     防重记在记忆库 meta 里, 跟 last_checkup_ts 同一个地方 —— 人格目录里再放一个游标文件,
     就又多一份需要跟着人格一起搬的状态。 */
  async function runDueSchedules(s) {
    if (!host.scheduleHome) return;
    const home = host.scheduleHome(s.butler);
    if (!home) return;
    if (s.butler.isRunning()) return;
    const name = (s.butler && s.butler.name) || s.sid;
    // 横幅模式(个人版)下提醒由宿主挂给人看, 这里只跑 schedule.json 的定时唤醒。
    const remDir = reminders.delivery() === 'banner' ? null : s.butler.memoryDir;
    // 一次性提醒先走: 它不看 since, 过了点没发的(关机/忙)都在这里补上。一轮只发一条。
    const once = remDir ? reminders.popDueOnce(remDir) : null;
    if (once) {
      log(`[reminder] #${once.id} 到点 (${once.at})`);
      appendEvent(name, 'reminder_fired', { id: once.id, at: once.at });
      try { await s.butler.submit(reminders.buildPrompt(once), undefined, { sourceKind: 'auto' }); } catch (e) {
        log(`[reminder] #${once.id} 投递失败: ${e && e.message}`);
      }
      return;
    }
    const registry = sched.loadRegistry(home, log);
    const paused = s.butler.memoryDir ? reminders.pausedSchedules(s.butler.memoryDir) : new Set();   // reminder 工具 pause 掉的 sched:<id>
    const entries = [...(registry ? registry.entries.filter((e) => !paused.has(e.id)) : []), ...(remDir ? reminders.cronEntries(remDir) : [])];
    if (!entries.length) return;
    const st = s.butler.memory && s.butler.memory.store;
    if (!st || typeof st.getMeta !== 'function') return;

    let state = {};
    try { state = JSON.parse(st.getMeta('schedule_last_fired') || '{}'); } catch (_) { state = {}; }
    const since = Number(state._since) || Date.now() - 60_000;
    const due = sched.dueEntries({ entries }, new Date(), since, state);
    state._since = Date.now();

    for (const { entry, key } of due) {
      const body = entry.reminder ? reminders.buildPrompt(entry.reminder) : sched.buildPrompt(entry, home);
      if (!body) { log(`[schedule] ${entry.id}: 取不到正文, 跳过`); continue; }
      // 先记再发: 发失败就当这一次错过了。反过来(发完再记)会在崩溃时把同一条重发到下次开机,
      // 而定时任务重复执行比漏一次贵得多(可能是发信/结账这类真动作)。
      state[entry.id] = key;
      try { st.setMeta('schedule_last_fired', JSON.stringify(state)); } catch (_) {}
      log(`[schedule] ${entry.id} 到点 (cron ${entry.cron})`);
      appendEvent(name, 'schedule_fired', { id: entry.id, cron: entry.cron });
      try { await s.butler.submit(body, undefined, { sourceKind: 'auto' }); } catch (e) {
        log(`[schedule] ${entry.id} 投递失败: ${e && e.message}`);
      }
      return;   // 一轮只发一条, 免得几条同时到点把人格淹了; 剩下的下一轮接着来
    }
    try { st.setMeta('schedule_last_fired', JSON.stringify(state)); } catch (_) {}
  }

  async function executeIdleAction(action, s) {
    const name = (s.butler && s.butler.name) || s.sid;
    const tag = `[idle-watch] ${name}`;
    if (globalRateLimitedUntil > Date.now()) {
      if (action.type !== 'NOOP' && action.type !== 'SLEEP') {
        const remain = Math.round((globalRateLimitedUntil - Date.now()) / 1000);
        log(`${tag} → ${action.type} 跳过 (rate-limited, ${remain}s 后解封)`);
      }
      return;
    }
    switch (action.type) {
      case 'NOOP':
        return;
      case 'KEEPALIVE': {
        // 冷却期: 上次心跳 <240s 内跳过, 免每 30s 扫一次就触发一次心跳.
        const since_last = Date.now() - (s.last_heartbeat_ts || 0);
        const cooldown_ms = s.heartbeatCooldownMs || HEARTBEAT_COOLDOWN_MS;
        if (since_last < cooldown_ms) {
          log(`${tag} → KEEPALIVE skipped (cooldown ${Math.round(since_last / 1000)}s < ${cooldown_ms / 1000}s)`);
          appendEvent(name, 'keepalive_skipped', { reason: 'cooldown', since_last_ms: since_last, cooldown_ms, tier: action.tier, idle_min: action.idle_min });
          return;
        }
        log(`${tag} → KEEPALIVE (${action.tier}, idle=${action.idle_min}min, ctx=${action.ctx_tok}, pct=${action.ctx_pct}%)`);
        appendEvent(name, 'keepalive_decided', { tier: action.tier, idle_min: action.idle_min, ctx_tok: action.ctx_tok, ctx_pct: action.ctx_pct });
        const rHb = await sendHeartbeat(s); if (!rHb || !rHb.ok) log(`${tag} → KEEPALIVE 未送达: ${(rHb && rHb.error) || '(无返回)'}`); return rHb;   // 送不出去必须落账, 否则"每 30s 决策却从没发出"看不出异常
      }
      case 'SAVE_NUDGE': {
        // 先记时间戳再发: 发失败也算这一档催过了, 免得每 30s 巡检重试把人格淹了(下一个间隔照样会再催)。
        s.lastSaveNudgeTs = Date.now();
        log(`${tag} → SAVE_NUDGE (${action.reason}, ${action.ctx_tier}, ctx=${action.ctx_tok}, pct=${action.ctx_pct}%)`);
        appendEvent(name, 'save_nudge_sent', { reason: action.reason, tier: action.ctx_tier, ctx_tok: action.ctx_tok, ctx_pct: action.ctx_pct, idle_min: action.idle_min });
        const r = await sendSaveNudge(s, action);
        if (!r.ok) log(`${tag} → SAVE_NUDGE 未送达: ${r.error}`);
        return;
      }
      case 'COMPACT': {
        const now = Date.now();
        if (s.compactBackoffUntil && s.compactBackoffUntil > now) {
          const remain = Math.round((s.compactBackoffUntil - now) / 1000);
          log(`${tag} → COMPACT 跳过 (退避中 ${remain}s 后重试, 已失败 ${s.compactFailCount || 0}×)`);
          appendEvent(name, 'compact_skipped', { reason: 'backoff', remain_s: remain, fail_count: s.compactFailCount || 0 });
          return;
        }
        log(`${tag} → COMPACT (${action.reason}, ctx=${action.ctx_tok}, pct=${action.ctx_pct}%)`);
        appendEvent(name, 'compact_triggered', { source: 'idle-watch', reason: action.reason, ctx_tok: action.ctx_tok, ctx_pct: action.ctx_pct, tier: action.tier });
        try {
          await s.butler.doCompact(`idle-watcher: ${action.reason}`);
          s.lastCompactTs = Date.now();   // 防抖: 最小间隔判据
          s.compactFailCount = 0;
          s.compactBackoffUntil = 0;
          appendEvent(name, 'clear_completed', { source: 'idle-watch', reason: action.reason });
        } catch (e) {
          s.compactFailCount = (s.compactFailCount || 0) + 1;
          appendEvent(name, 'compact_failed', { source: 'idle-watch', reason: action.reason, error: String((e && e.message) || e), fail_count: s.compactFailCount });
          const overflow = s.compactFailCount > COMPACT_BACKOFF_MS.length;
          const idx = Math.min(s.compactFailCount - 1, COMPACT_BACKOFF_MS.length - 1);
          s.compactBackoffUntil = overflow ? Number.MAX_SAFE_INTEGER : now + COMPACT_BACKOFF_MS[idx];
          const label = overflow ? '永久 (需 markActivity 重置)' : `${Math.round(COMPACT_BACKOFF_MS[idx] / 1000)}s`;
          console.error(`${tag} COMPACT 失败 #${s.compactFailCount} → 退避 ${label}: ${e && e.message}`);
        }
        return;
      }
      case 'IDLE_CLEAR': {
        log(`${tag} → IDLE_CLEAR (idle=${action.idle_min}min, ctx=${action.ctx_tok})`);
        appendEvent(name, 'compact_triggered', { source: 'idle-watch', reason: action.reason, ctx_tok: action.ctx_tok, ctx_pct: action.ctx_pct, tier: action.tier });
        try {
          await s.butler.idleClear(`idle-watcher: ${action.reason}`);
          s.lastCompactTs = Date.now();
          appendEvent(name, 'clear_completed', { source: 'idle-watch', reason: action.reason });
        } catch (e) {
          appendEvent(name, 'compact_failed', { source: 'idle-watch', reason: action.reason, error: String((e && e.message) || e) });
          console.error(`${tag} IDLE_CLEAR 失败: ${e && e.message}`);
        }
        return;
      }
      case 'PARK': {
        const ctx =`idle=${action.idle_min}min, ctx=${action.ctx_tok}`;
        try {
          const done = await s.butler.park();
          if (!done) return;   // 流已经不在了(压缩刚拆过 / 上一轮已回收), 不是错
          log(`${tag} → PARK 子进程已回收 (${ctx}) · 下条消息自动复活`);
          appendEvent(name, 'parked', { reason: action.reason, idle_min: action.idle_min, ctx_tok: action.ctx_tok });
          // 顺带回收语义推理进程(约 740MB)。挂在这里而不是自带定时器 —— 固定周期回收会在
          // 连续工作的白天反复付 0.9 秒冷启动, 净亏。两道闸: 有人格闲到被 PARK, 且推理本身
          // 也 10 分钟没用过(后一道 disposeIfIdle 按 _lastUseTs 自己判), 别的人格在用就不会误收。
          try { require('./embed/host').disposeIfIdle({ idleMs: 10 * 60e3 }); } catch (_) {}
        } catch (e) {
          // 回收失败照旧留着流就行 —— 这条轨道是省内存, 不是保证正确性
          console.error(`${tag} PARK 失败(保持原样): ${e && e.message}`);
          appendEvent(name, 'park_failed', { error: String((e && e.message) || e) });
        }
        return;
      }
      case 'CHECKUP': {
        const findings = await runCheckup(s, action.cfg, log);
        // 零打扰: 库是干净的就一个字都不说 —— 每周雷打不动来一句"一切正常"是纯噪音。
        if (!findings.length) {
          log(`${tag} 体检完毕, 无超标项 —— 不打扰`);
          return;
        }
        const keys = findings.map((f) => f.key).join(',');
        log(`${tag} → CHECKUP (${findings.length} 项: ${keys}, ${action.reason}, idle=${action.idle_min}min, ctx=${action.ctx_tok})`);
        appendEvent(name, 'checkup_nudged', {
          findings: findings.map((f) => f.key), reason: action.reason,
          idle_min: action.idle_min, ctx_tok: action.ctx_tok,
        });
        // 时间戳在 decideCheckup 里就已经写进 meta 了, 所以投递失败也不会每 30s 死磕重发。
        const r = await sendCheckupNudge(s, findings);
        if (!r.ok) {
          log(`${tag} CHECKUP 未发出: ${r.error}`);
          appendEvent(name, 'checkup_nudge_failed', { error: r.error });
        }
        return;
      }
      case 'SLEEP':
        log(`${tag} → SLEEP (仅观察, ${action.reason}, tier=${action.tier}, idle=${action.idle_min}min, ctx=${action.ctx_tok})`);
        return;
    }
  }

  let timer = null;
  function start() {
    if (timer) return;
    timer = setInterval(async () => {
      for (const s of host.sessions()) {
        try {
          await runDueSchedules(s);
          // 一次 tick 两条轨道并行判. 同时命中 COMPACT+KEEPALIVE 时优先 COMPACT —— 压缩后 ctx 收缩, 心跳留到下轮.
          const actions = decideActions(s, {
            personaCfg: personaCfgOf(s.butler),
            checkupDefaults: checkupDefaults(),
            log,
          });
          // 压缩会拆流, 提醒本身就是一个真回合(自然续上 cache) —— 两者都让心跳没必要跑。
          const hasTurn = actions.some((a) => a.type === 'COMPACT' || a.type === 'SAVE_NUDGE');
          for (const action of actions) {
            if (hasTurn && action.type === 'KEEPALIVE') continue;
            await executeIdleAction(action, s);
          }
        } catch (e) { console.error('[idle-watch] scan error', (e && e.stack) || e); }
      }
    }, IDLE_WATCH_INTERVAL_MS);
    log(`[idle-watch] 已启用, 每 ${IDLE_WATCH_INTERVAL_MS / 1000}s 扫全体 sessions`);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    start, stop,
    sendHeartbeat, sendCheckupNudge, sendSaveNudge, executeIdleAction,
    runDueSchedules,   // 测试直调(personal/test-reminders.js), 免得等 30s 一拍
    setRateLimitedUntil: (ts) => { globalRateLimitedUntil = Math.max(globalRateLimitedUntil, Number(ts) || 0); },
    getRateLimitedUntil: () => globalRateLimitedUntil,
  };
}

module.exports = {
  createIdleWatcher,
  decideActions, decideCheckup, classifyTier, detectAssistantQuestion, markActivity, taskContinueDelayMs,
  IDLE_WATCH_INTERVAL_MS, HEARTBEAT_COOLDOWN_MS, COMPACT_BACKOFF_MS,
  KEEPALIVE_MIN_TOK, KEEPALIVE_MAX_TIMES, BG_HOLD_MIN, PARK_IDLE_MIN, TASK_CONTINUE_MAX, TASK_CONTINUE_BACKOFF_MS,
};
