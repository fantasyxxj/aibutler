// memory-v2.js — 图记忆引擎 v2。数据来自 DB, 不再有 .md。
//
// 与 v1 的分工: **只替换"数据从哪来", 不重写"怎么打分"**。
// 打分算法与标定常数全部从 memory.js require 复用 —— butler 与行业版已经因为各改各的漂了 677 行,
// 两版并存期再复制一份打分逻辑, 等于第二次制造同一种病。
//
// 真正改掉的是四处:
//   1. 检索 haystack: v1 是 id+title / description, v2 是 slug+title+keywords / claim。
//      老 id 本身是检索文本(命中拿 3 分), 换数字主键后这份信号靠 slug+keywords 补回来。
//   2. pinned 不再是 importance 的一档, 也不进热度: 它是常驻层, 每个会话整份注入。
//   3. supersedes 成边之后有了执行力: 召回时引擎强制附带「已被 X 推翻」, 不再是 nodes 上一个没人看的字段。
//   4. 写路径全进 DB, 修订历史由 store 内建, 不再有 _revisions/*.jsonl 旁路。
//
// 2026-08-24 拆包(内核抽包第 2 步): 本文件只剩类骨架与组装。
//   标定值 → memory-v2/tuning.js · 常量与纯函数 → memory-v2/consts.js
//   宿主注入面 → memory-v2/host.js · 各方法族 → memory-v2/{retrieval,semantic,browse,pinned,write,doctor}.js
// 🔴 抽包同时解开了两根宿主耦合: 数据目录与配置层不再由记忆体自己去拿, 改由宿主递进来(见 host.js)。
// 没有宿主时能力降级但不报错 —— 这是"任何应用都能单独吃记忆体"的前提。
const {
  canon, todayLocal, nowLocalISO, PINNED_QUOTA, setAliasesFile,
} = require('./memory');
const { MemoryStoreV2 } = require('./memory-store-v2');
const { tune, reloadTuning, currentTuning, TUNING_DEFAULTS } = require('./memory-v2/tuning');
const {
  IMP_BASE_V2, IMP_HL_V2,
  bodyHardTokens,
  bodySize, checkBodyLimit, estTokens, semConf, tierOf, hotnessV2,
} = require('./memory-v2/consts');

// class 片段挂回原型。必须用 defineProperty + getOwnPropertyDescriptor 而不是 Object.assign:
// class 方法不可枚举, assign 会静默拷 0 个还不报错; 而且这样才搬得动 getter(本类有 embedModel)。
function mixin(target, ...fragments) {
  for (const F of fragments) {
    for (const k of Object.getOwnPropertyNames(F.prototype)) {
      if (k === 'constructor') continue;
      Object.defineProperty(target.prototype, k, Object.getOwnPropertyDescriptor(F.prototype, k));
    }
  }
  return target;
}

class MemoryGraphV2 {
  constructor(memoryDir) {
    this.dir = memoryDir;
    this.store = new MemoryStoreV2(memoryDir);
    this._embed = null;
    this._queryVec = null;
    this._idx = null;
    this._idxRev = null;
  }

  close() { this._idx = null; this._idxRev = null; this._vecSnap = null; this.store.close(); }

  // v1 这里要扫 .md 的 mtime/size 决定增量重建。v2 没有文件, 库就是真相, 直接读。
  //
  // 🔴 带缓存。这条路是 O(库大小) 的: 全量拉 1500 节点 + 6000 边在 JS 里重拼对象实测 22ms,
  // 而每轮自动召回都要走一次 —— 库越长越慢, 且每次约 3MB 垃圾。
  // 缓存之所以能在热路径上活着: **检索不写图**(query 只往 recall_log 记账), 真正动
  // nodes/edges/pinned 的是 touch/upsert 那类, 它们会把 store.graphRev() 顶掉。
  // ⚠️ 返回的是**共享对象**, 调用方只读不改(当前 retrieval/browse/doctor/pinned/write 全是
  // map/filter/some, 没有原地改行的)。要改里面的行请先拷贝, 否则脏的是所有后续检索。
  _fresh() {
    const rev = this.store.graphRev();
    if (this._idx && this._idxRev === rev) return this._idx;
    const nodes = this.store.allNodes();
    const edges = this.store.allEdges();
    const pinned = new Set(this.store.pinnedIds());
    this._idx = { nodes, edges, pinned };
    this._idxRev = rev;
    return this._idx;
  }

  _hot(m) {
    return hotnessV2(m.importance, m.last_used, m.use_count);
  }
}

mixin(MemoryGraphV2,
  require('./memory-v2/retrieval'),
  require('./memory-v2/semantic'),
  require('./memory-v2/browse'),
  require('./memory-v2/pinned'),
  require('./memory-v2/write'),
  require('./memory-v2/doctor'),
);

// 🔴 这几个档位值是【模块加载时的快照】, 与拆包前一致 —— 拆包前它们是 let, reloadTuning()
// 只改模块内部那份, 已经 require 出去的拷贝本来就不会跟着动。要拿实时值走 currentTuning()。
const TIER_HI = tune('tier_hi');
const TIER_MID = tune('tier_mid');
const FALLBACK_CONF = tune('fallback_conf');
const SEM_FLOOR = tune('sem_floor');
const SEM_CEIL = tune('sem_ceil');

module.exports = { MemoryGraphV2, hotnessV2, IMP_BASE_V2, IMP_HL_V2,
  TIER_HI, TIER_MID, FALLBACK_CONF, SEM_FLOOR, SEM_CEIL, tierOf, semConf, estTokens,
  reloadTuning, currentTuning, TUNING_DEFAULTS,
  bodyHardTokens, bodySize, checkBodyLimit,
  // 转出给宿主, 让行业版只 require 这一个文件就够 —— 它现在从 core/memory.js 拿这几样。
  // v2 的"今天"一律是本地的今天(v1 的 today() 是写死 UTC+8 的历史口径, 不带过来)。
  canon, today: todayLocal, todayLocal, nowLocalISO, PINNED_QUOTA, setAliasesFile };
