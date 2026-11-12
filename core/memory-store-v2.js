// memory-store-v2.js — 图记忆存储层 v2。与 v1 的根本差别: **DB 就是真源, 没有 .md 了**。
//
// v1 的注释里写着"🔴 .md 文件仍然是唯一真相源, 库只是派生索引", v2 把这句话反过来。
// 连带消失的是三列 file_path/mtime/size 和整个 fileSigs() 增量重建机制 ——
// 没有文件要扫, 也就没有"哪些文件动过"这个问题。
//
// 另外三处不是搬家而是改性质:
//   1. 主键从语义 id 换成数字, slug 降为可改的人读别名(改名不断边, 因为边只存数字)。
//   2. description(摘要) 换成 claim(命题)。摘要判不了真假, 所以矛盾检测和 supersedes 边都无从谈起。
//   3. links(src,dst) 换成 edges(src,dst,rel,made_by)。边不再是正文 [[]] 的正则副产品。
//
// 沿用 v1 那条尺度约束: 常驻内存的量正比于【节点数】而不是【正文总量】, 所以 allNodes() 永不取 body。
//
// 2026-08-24 拆包(内核抽包第 2 步): 本文件只剩类骨架与组装。
//   常量与纯函数 → store-v2/consts.js · 各方法族 → store-v2/{schema,graph,pinned,logs,ops}.js
const path = require('path');
const { DB_FILE, SCHEMA_VERSION, SCHEMA_FILE, contentHash, floatsToBlob, blobToFloats } = require('./store-v2/consts');

// class 片段挂回原型。必须用 defineProperty + getOwnPropertyDescriptor 而不是 Object.assign:
// class 方法不可枚举, assign 会静默拷 0 个还不报错; 而且这样才搬得动 getter(本类有 db)。
function mixin(target, ...fragments) {
  for (const F of fragments) {
    for (const k of Object.getOwnPropertyNames(F.prototype)) {
      if (k === 'constructor') continue;
      Object.defineProperty(target.prototype, k, Object.getOwnPropertyDescriptor(F.prototype, k));
    }
  }
  return target;
}

class MemoryStoreV2 {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.dbPath = path.join(this.dir, DB_FILE);
    this._db = null;
  }

}

mixin(MemoryStoreV2,
  require('./store-v2/schema'),
  require('./store-v2/graph'),
  require('./store-v2/pinned'),
  require('./store-v2/logs'),
  require('./store-v2/ops'),
  require('./store-v2/lone-heal'),
);

module.exports = { MemoryStoreV2, contentHash, floatsToBlob, blobToFloats, DB_FILE, SCHEMA_VERSION, SCHEMA_FILE };
