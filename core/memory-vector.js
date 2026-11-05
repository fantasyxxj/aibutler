// memory-vector.js — 语义检索的向量算术(纯 JS, 无依赖)。
//
// 为什么没有向量数据库: 本地记忆的规模决定了它不需要。742 条 × 384 维 float32 = 1.1MB,
// 暴力算全量余弦实测 <2ms。sqlite-vec 这类扩展带来的是"按平台分发的二进制", 而它的 npm 包
// 按 os/cpu 上锁 —— 在 Mac 上装根本拿不到 Windows 那份, 会静默漏进包里, 而我没有 Windows 机器可验。
// 用不着的复杂度不引入, 尤其当它的失败模式是"打包时静默缺失"。
//
// 尺度(作者 2026-08-13 提醒"你要永存的, 早晚会很大"):
//   4 万条 × 384 维 float32 = 61MB 常驻 + 每次查询 4 万次点积(约 30-50ms)。仍可用但已到边界。
//   过了这条线该做的是 int8 量化(体积降 4 倍, 归一化向量上精度损失可忽略) + 只对关键词候选集算,
//   而不是引入向量库。两者都不改变本模块的接口。
const DIM_DEFAULT = 384;

// 入库前统一归一化, 于是余弦退化成点积 —— 省掉查询期每条一次的开方。
function normalize(vec) {
  const f = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i] * f[i];
  const n = Math.sqrt(s);
  if (!n || !isFinite(n)) return f;
  const out = new Float32Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = f[i] / n;
  return out;
}

// 两个已归一化向量的余弦。没归一化也能用(退化成点积, 值域会偏), 所以入库路径必须先 normalize。
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// 全量打分取 top-k。返回 [{id, score}], score ∈ [-1,1]。
// minScore 默认 0: 负相关的条目对"找相关记忆"毫无意义, 让它们进候选只会挤掉真结果。
function topK(queryVec, entries, { k = 20, minScore = 0 } = {}) {
  if (!queryVec || !entries || !entries.length) return [];
  const out = [];
  for (const e of entries) {
    if (!e.vec || e.vec.length !== queryVec.length) continue;
    const s = cosine(queryVec, e.vec);
    if (s <= minScore) continue;
    out.push({ id: e.id, score: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, k);
}

module.exports = { normalize, cosine, topK, DIM_DEFAULT };
