// memory.js — 人格原生图记忆引擎(纯 JS, 无原生依赖)。
// memory_db.py v2 的忠实移植: canon(文件名)锚 + [[链接]]边 + 遗忘曲线热度 + 图扩散检索 + doctor。
// 每个人格 new MemoryGraph(memoryDir) 各自一张图 → 「完整人格自带图记忆」。
//
// 2026-08-13 存储回到 SQLite(memory-store.js, wasm 版无原生依赖), 取代中途用过的 memory_index.json。
// 换回来的理由是写路径的复杂度: JSON 方案每存一条记忆都要重读全部 .md 再整体写盘 3.1MB,
// 实测 742 节点 228ms —— 存一条记忆的代价正比于已有记忆总量, 这条曲线不可接受。
// .md 仍是唯一真相源, 库是派生索引(删库可从 .md 重建, 只有热度史 last_used/use_count 只活在库里)。
//
// 2026-08-24 拆包(内核抽包第 2 步): 本文件只剩类骨架与组装。
//   常量与纯函数 → memory/primitives.js(v1 与 v2 共用同一份打分算法)
//   各方法族 → memory/v1-{files,retrieval,semantic,browse,doctor,write}.js
const path = require('path');
const { MemoryStore } = require('./memory-store');
const {
  canon, hotness, today, todayLocal, nowLocalISO, localTimestampShort, addDays, daysBetween,
  tokenize, pinnedGate, enStem, isEnWord, stemSet, rrfOrder, semanticWeight, hubDamp,
  setAliasesFile, loadAliases, parseFrontmatter,
  EMBED_MODEL, VECTOR_TAG, PINNED_QUOTA, PINNED_MAX_CHARS, TYPE_DEFAULT_IMP, SKIP_FILES, SKIP_LINK, INDEX_FILE,
  IMP_BASE, IMP_HL, REC_W, USE_W, SUPERSEDED_PENALTY, HOP_DECAY,
  PINNED_STALE_HINT, REVIEW_DUE_DAYS, COGNITION_REFRESH_N,
} = require('./memory/primitives');

// class 片段挂回原型。必须用 defineProperty + getOwnPropertyDescriptor 而不是 Object.assign:
// class 方法不可枚举, assign 会静默拷 0 个还不报错。
function mixin(target, ...fragments) {
  for (const F of fragments) {
    for (const k of Object.getOwnPropertyNames(F.prototype)) {
      if (k === 'constructor') continue;
      Object.defineProperty(target.prototype, k, Object.getOwnPropertyDescriptor(F.prototype, k));
    }
  }
  return target;
}

class MemoryGraph {
  constructor(memoryDir) {
    this.dir = path.resolve(memoryDir);
    this.indexPath = path.join(this.dir, INDEX_FILE);
    this.store = new MemoryStore(this.dir);
    this._cache = null;      // {nodes, links} 进程内快照, 文件有变动时失效
    this._vecCache = null;   // 向量快照, 补算后失效
    this.embedModel = VECTOR_TAG;
  }
}

mixin(MemoryGraph,
  require('./memory/v1-files'),
  require('./memory/v1-retrieval'),
  require('./memory/v1-semantic'),
  require('./memory/v1-browse'),
  require('./memory/v1-doctor'),
  require('./memory/v1-write'),
);

module.exports = { MemoryGraph, canon, hotness, today, PINNED_QUOTA, PINNED_MAX_CHARS, pinnedGate, tokenize, EMBED_MODEL, VECTOR_TAG,
  setAliasesFile,
  // 下面这些是给 memory-v2.js 复用的【纯函数与标定常数】。导出而不是复制一份, 是因为两版
  // 并存期间最怕的就是打分算法各改各的 —— 行业版与 butler 已经这么漂了 677 行, 不能再来一次。
  // v2 只该替换"数据从哪来", 不该重写"怎么打分"。
  rrfOrder, semanticWeight, hubDamp, daysBetween, addDays, loadAliases, localTimestampShort,
  enStem, isEnWord, stemSet,
  // 迁移器要按【和 v1 逐字段一致】的方式解析同一批 .md, 复制一份解析器就等于给自己埋一处静默漂移。
  parseFrontmatter, TYPE_DEFAULT_IMP, SKIP_FILES, SKIP_LINK,
  todayLocal, nowLocalISO,
  IMP_BASE, IMP_HL, REC_W, USE_W, TYPE_DEFAULT_IMP, SUPERSEDED_PENALTY, HOP_DECAY,
  PINNED_STALE_HINT, REVIEW_DUE_DAYS, COGNITION_REFRESH_N };
