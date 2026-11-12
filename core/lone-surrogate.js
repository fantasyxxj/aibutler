// lone-surrogate.js — 半个 emoji(孤立的 UTF-16 代理项)。两版共用。
// 按 .length / slice 截文字会把 emoji 从中间切开, 剩下那半个存进记忆或日志, 之后每次发请求都带着它:
// DeepSeek 报 400「unexpected end of hex escape」, 智谱报 500「surrogates not allowed」。
// 这里给三样: 删掉它(写库、写日志前) · 查有没有(体检) · 截文字时不切开(源头)。
// 发请求前的最后一道在 agent-sdk/src/providers/well-formed.ts。

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const LONE_ONE = new RegExp(LONE.source);

const dropLone = (s) => (typeof s === 'string' ? s.replace(LONE, '') : s);
const hasLone = (s) => typeof s === 'string' && LONE_ONE.test(s);

// 写库的参数: 数组或命名参数对象, 只动字符串
function cleanParams(p) {
  if (typeof p === 'string') return dropLone(p);
  if (Array.isArray(p)) return p.map((v) => (typeof v === 'string' ? dropLone(v) : v));
  if (p && typeof p === 'object' && !ArrayBuffer.isView(p)) {
    const o = {};
    for (const k of Object.keys(p)) o[k] = typeof p[k] === 'string' ? dropLone(p[k]) : p[k];
    return o;
  }
  return p;
}

// JSON.stringify 的 replacer: 落盘的 JSON 里不留半个 emoji
const jsonReplacer = (_k, v) => (typeof v === 'string' ? dropLone(v) : v);

// 取前 n 个 UTF-16 单元, 末尾正好是半个 emoji 就少取一个
function head(s, n) {
  const t = String(s).slice(0, Math.max(0, n));
  return /[\uD800-\uDBFF]$/.test(t) ? t.slice(0, -1) : t;
}
// 取后 n 个, 开头正好是后半个就少取一个
function tail(s, n) {
  if (n <= 0) return '';
  const t = String(s).slice(-n);
  return /^[\uDC00-\uDFFF]/.test(t) ? t.slice(1) : t;
}

module.exports = { dropLone, hasLone, cleanParams, jsonReplacer, head, tail };
