// checkup-gate.js — 记忆库定期体检: ①现在该不该体检 ②体检报告里哪些指标算超标。两个纯判定。
//
// 病根 (2026-08-17 作者):「不说他们不会体检的」「让他自己挂任务是不靠谱的。就是 butler 体检,
// 有问题戳他, 他改一下。下次体检, 有问题再戳, 否则他就永远不做了」。
//
// 🔴 所以这里刻意【无状态】—— 不建任务队列, 不记"派过什么活", 不需要人格标完成。
//    每次体检都重新算当前库的状态: 问题还在就再戳一次, 问题没了自己就不出现。
//    **当前状态本身就是队列。** 人格赖不掉(下次还戳), 也不用它自己记着(它记不住)。
//    对比 chores 那套(key 幂等 + 标 done + 防复活): 那是"这一版必须做的活", 有明确终点;
//    体检是常态巡检, 没有终点, 用任务队列反而要处理一堆"周期到了怎么让 done 的复活"的假问题。
//
// 判定放独立纯函数而不是写进 main.js: test-idle-watcher.js 把 decideActions 逐字抄了一份,
// 往那种结构里加判定要改两处、必漂 (migrate-gate.js / compact-gate.js 同理)。
'use strict';

const CHECKUP_INTERVAL_DAYS = 7;             // 多久体检一次
const CHECKUP_IDLE_MIN = 8;                  // 空闲几分钟才戳。比 MIGRATE 的 6min 再晚一步 —— 保活/压缩/迁移先决策, 别抢
const CHECKUP_CTX_MAX_TOK = 300_000;         // 上下文已经这么肥就别加体检报告了, 等压缩把它收回去

// 返回 null = 现在不体检; 返回 {reason} = 该体检了。
//
// 🔴 2026-08-18 拆掉 dirty / questionPending 两道门 (作者:「说过话就不体检了？」)。
//    原先照抄 migrate-gate 的口径, 结果这条轨道**从没触发过一次** —— 硬证据是真库 meta 表里
//    连 last_checkup_ts 都不存在(main.js 是"查过了就写", 键缺席=一次都没走到)。
//    根因: 两道门语义互斥, 真实使用中凑不到一起。
//      · dirty=false  语义是「自上次清空以来没有真消息」, 只有 COMPACT 清空才归零
//      · questionPending=false 语义是「AI 上一轮不是问句」, 只有用户回话才清零
//    → 要同时成立, 得是"清空后起床那轮恰好不以问句结尾, 且用户之后 N 分钟不理它"。
//      人格起床惯例是汇报完问一句"接着做吗", 所以这条缝从没打开过。
//    关键区别: **idle 会自然恢复, dirty 不会**。用一个不会自愈的锁去守一件周期性的事,
//    结果必然是永远不做。「别打扰」的正确表达只有一个 —— 用户已经 N 分钟没动了, 那就是 idleMin。
//    questionPending 同理: 它防的是"压缩把语境冲掉", 而体检只插一行短标签, 冲不掉什么。
//
// ⚠️ 顺序很重要: 必须先过这道闸再去跑 doctor()。doctor 要遍历全部节点逐个读 body,
//    近千节点的库不便宜, 绝不能每轮 idle 巡检(30s 一次)都跑一遍。
function checkupGate({
  running = false,
  idleMin = 0,
  ctxTok = 0,
  lastCheckupTs = 0,
  now = 0,
  cfg = {},
} = {}) {
  if (running) return null;                      // 回合进行中: 插进去会拆掉正在跑的流

  const days = num(cfg.checkupIntervalDays, CHECKUP_INTERVAL_DAYS);
  const idleGate = num(cfg.checkupIdleMin, CHECKUP_IDLE_MIN);
  const ctxMax = num(cfg.checkupCtxMaxTok, CHECKUP_CTX_MAX_TOK);

  if (days <= 0) return null;                    // 0 = 关掉体检的逃生门
  if (idleMin < idleGate) return null;
  if (ctxTok > ctxMax) return null;
  if (now - (lastCheckupTs || 0) < days * 86_400_000) return null;

  return { reason: lastCheckupTs ? 'interval_due' : 'never_checked' };
}

// doctor() 报告 → 超标项的**短标签**清单。空数组 = 库是干净的, **不戳**
// (零打扰是这套机制能长期存活的前提: 每周雷打不动来一句"体检完毕一切正常"是纯噪音,
//  几次之后人格和用户都会开始无视它)。
//
// 🔴 作者 2026-08-17:「触发器自己不是医生, 就是一个信号而已」。
//    所以这里只出一行短标签, **不出诊断、不出药方**。理由有两条:
//    ① 越权 —— 该怎么收拾是 AI 的判断, 写死在引擎里等于替它想好了
//    ② 会过期 —— 信号带的是扫描那一刻的快照, AI 真动手时得自己跑 memory_admin(op=doctor) 拿实况
//
// 阈值全部可配。默认值是拍的, 没有实测依据 —— 跑一段时间看戳的频率再调。
function checkupFindings(report, cfg = {}) {
  if (!report) return [];
  const out = [];
  const t = (k, dflt) => num(cfg[k], dflt);
  const p = (kind) => (report.problems || []).find((x) => x.kind === kind);

  // pinned(常驻)超配额: 超 0 就报 —— 每条每轮都付钱, 满着的时候新条目也会被挡在外面
  const over = Math.max(0, (report.pinned || 0) - (report.quota || 0));
  if (over > 0) out.push({ key: 'pinned_over_quota', label: `pinned (resident) set is over quota by ${over}` });

  // ── 老记忆欠账: 肥大 + 缺命题 + 孤儿 + 缺归类 合并成一项 ──
  // 作者:「本身没处理的老记忆, 主要就是肥大的记忆, 不符合我们命题的规范的」。
  // 这几个数看着是几种毛病, 其实是同一批老节点的同一个病: 当年整段塞进来的,
  // 没按「一件事一个原子命题 + [[边]] 连相关」处理过。分开报纯属噪音。
  //
  // 🔴 2026-08-17 作者「那个 review 的合并了吧, 不用特殊做一个事务了」: 迁移欠账原本另有
  //    review_queue 一张表 + MIGRATE 一条轨道, 现在整个并进这一条信号。所以这里的四个数
  //    就是当年那张队列表的四类 reasons(split/claim/dangling→孤儿/classify), 区别只在于
  //    **它们每次体检现算**, 没有 pending/done —— 收拾干净了自己消失, 没收拾下次照样报。
  const fatN = ((p('节点过大(拆分候选)') || {}).count) || 0;
  // 两个 kind 都算进来: doctor 2026-08-19 把「真空命题」和「迁移兜底命题」拆成了两条
  // (性质不同、补法不同)。这里仍合并成一个数 —— 作者要的是一条短信号, 不是分类明细。
  // 🔴 漏掉哪个 kind 都是静默失效: 数变小了, 轨道照跑, 没人会发现。
  const noClaimN = (((p('缺命题') || {}).count) || 0) + (((p('命题待判真假') || {}).count) || 0);
  const noTypeN = ((p('缺归类') || {}).count) || 0;
  const isoN = report.isolated || 0;
  if (fatN >= t('fatNodes', 5) || noClaimN >= t('noClaim', 10)
      || isoN >= t('isolatedNodes', 20) || noTypeN >= t('noType', 10)) {
    const bits = [];
    if (fatN) bits.push(`oversized ${fatN}`);
    if (noClaimN) bits.push(`no claim ${noClaimN}`);
    if (noTypeN) bits.push(`unclassified ${noTypeN}`);
    if (isoN) bits.push(`orphans ${isoN}`);
    out.push({ key: 'legacy_backlog', label: `legacy nodes never cleaned up (${bits.join(' · ')})` });
  }

  const due = (report.review_due || []).length;
  if (due >= t('reviewDue', 3)) out.push({ key: 'review_due', label: `${due} projects are past their review date` });

  // 悬空边: 超 0 就报, 且它不是"该整理了"而是存储层外键没生效的故障信号
  const dangling = p('悬空边');
  if (dangling && dangling.count > 0) {
    out.push({ key: 'dangling_edges', label: `⚠️ ${dangling.count} dangling edges (storage-layer fault signal, not a cleanup item)` });
  }

  // 召回失败率: doctor 已判过样本量(≥20)和阈值(>50%)才会放进 problems
  if (p('召回失败率过半')) {
    out.push({ key: 'recall_fail', label: 'recall is failing more than half the time (this is the memory graph\'s report card — it outranks the rest)' });
  }

  return out;
}

// 冲突普扫的取样上限 —— 调用处按它取样, 这里按它判"到顶了没有"。
const CONFLICT_SAMPLE_CAP = 20;

// 取样结果 → 一条 finding (没扫到就是 null, 同上面那条零打扰原则)。
// 🔴 上限是取样数, 不是真实对数: 老代码取 max:2 又把 pairs.length 填进标签, 于是这行
//    **永远报"2 对"**, 库里 8 对还是 80 对都长一个样, 人格照着它判轻重就判错。
//    到顶报成 "20+", 让"还有更多"这件事本身可见, 而不是伪装成一个精确的小数字。
function conflictFinding(pairs, cap = CONFLICT_SAMPLE_CAP) {
  const n = (pairs || []).length;
  if (!n) return null;
  return {
    key: 'conflict_pairs',
    label: `${n >= cap ? `${cap}+` : n} memory pairs look like they contradict each other`,
  };
}

function num(v, dflt) {
  const n = Number(v);
  if (v === 0) return 0;
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

module.exports = {
  checkupGate,
  checkupFindings,
  conflictFinding,
  CONFLICT_SAMPLE_CAP,
  CHECKUP_INTERVAL_DAYS,
  CHECKUP_IDLE_MIN,
  CHECKUP_CTX_MAX_TOK,
};
