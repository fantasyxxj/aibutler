// v2 存储层的常量与纯函数: 库文件名 · schema 版本 · 向量配方哈希 · 列清单。
// 由 memory-store-v2.js 顶部抽出(内核抽包第 2 步)。这里没有状态、不碰 DB。
const path = require('path');

// 🔴 必须与 v1 的 memory.db 分开两个文件。同名会撞得非常难看: v1 库里已经有一张 nodes 表,
// 于是 v2 的 CREATE TABLE IF NOT EXISTS nodes 什么都不做(它只管"在不在", 不管"长得对不对"),
// 建库看着成功, 第一条查询才炸 no such column: slug。实测老库上开 BUTLER_MEMORY_V2=1 必崩。
// 分开还顺带保证了迁移的可回滚性: 新库另起一个文件, 老库原封不动躺在旁边。
const DB_FILE = 'memory.v2.db';
const SCHEMA_VERSION = 2;
const SCHEMA_FILE = path.join(__dirname, '..', 'memory-schema-v2.sql');

// 喂 embedder 的配方: title + claim + keywords, **不含 body**。
// 2026-08-13 真库实测: 长正文毒化向量(hubness), 少数几条正文长的节点会挤进所有查询的 top。
// last_used/use_count 也不参与 —— 它们天天变, 跟着变会让全库向量每天全部作废重算。
function contentHash(title, claim, keywords) {
  const s = `${title || ''} ${claim || ''} ${keywords || ''}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    if (s.charCodeAt(i) > 0xff) { h ^= s.charCodeAt(i) >>> 8; h = Math.imul(h, 0x01000193) >>> 0; }
  }
  return h.toString(16).padStart(8, '0');
}

function floatsToBlob(arr) {
  const f = arr instanceof Float32Array ? arr : Float32Array.from(arr);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}
function blobToFloats(buf) {
  if (!buf) return null;
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const copy = new Uint8Array(u8.length);
  copy.set(u8);
  return new Float32Array(copy.buffer, 0, copy.length / 4);
}

// anchors 进常驻列是有意的: 它必须跟着检索结果一起露出来, 事后再查一趟就等于没有 ——
// 要核对的那一刻多一跳, 人就直接去 grep 了。长度上它是几个 path:line, 与 body 不是一个量级。
// translations 同理进常驻: 检索要拿它逐语言打分, 而 allNodes() 就是检索的取材口 ——
// 放冷列等于跨语言检索永远查不到, 正是这次要修的那个病。body_i18n 刻意留在外面(与 body 同档)。
// projects 同样进常驻: 它存在的意义就是在检索结果里当场提醒「这条是别的项目验的」,
// 事后再查一趟就等于没有。长度是几个项目名, 比 anchors 还短。
const NODE_COLS = `id,slug,title,claim,claim_provisional,keywords,anchors,projects,translations,type,importance,status,scope,
                   provenance,is_factory,exit_criteria,review_due,created,last_used,use_count`;

// 搬家用的完整内容列: 比 NODE_COLS 多 body(要带走), 少 id(数字主键不跨机器, 导入端重新发)。
// 🔴 schema 加列时这里要跟着加, 否则新字段会在搬家时静默丢失 —— 这也是它挨着 NODE_COLS 放的原因。
const GRAPH_COLS = `slug,title,claim,claim_provisional,keywords,anchors,projects,translations,body,body_i18n,type,importance,status,scope,
                    provenance,is_factory,exit_criteria,review_due,created,last_used,use_count`;

module.exports = {
  DB_FILE, SCHEMA_VERSION, SCHEMA_FILE, contentHash, floatsToBlob, blobToFloats,
  NODE_COLS, GRAPH_COLS,
};
