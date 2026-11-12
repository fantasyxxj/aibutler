'use strict';
// 工具参数平铺: 参数直接写在顶层, 如 task(op='create', subject='…'), 不套 args={…}。
//
// 嵌套对象里的中日文, 模型会写成 \uXXXX(10-20 r13 重放实测, haiku 写错码就成错字);
// core/escape-guard.js 只能打回让它重写, 10-26~11-02 一周打回 98 次, 全在套 args 的工具上
// (task 56 · bus_admin 17 · plugin_open 15 · memory_admin 9 · plugin_call 1)。
// 平着写的同一句 0/10 —— 所以从源头不给嵌套的口子。
//
// 平铺的参数也要写进 schema: 严格按定义出参的模型(智谱 glm 等)只生成声明过的键,
// 没声明的整个带不出来 —— 11-12 老黄的 glm-5.3 调 bus_admin 三次都只剩 op。
// 所以 op 表里出现过的参数名全部声明成可选(opsShape, 同 biz_do 的 flatShape);
// 参数随插件 / 脚本变、没法事先列的工具, 另声明一个文本口袋 params(PARAMS_FIELD)。
// loose() 照留: 老会话里照旧套 args={…} 的那一次照收, 顶层同名键压过 args 里的。

function looseShape(z, shape) {
  const o = z.object(shape);
  return typeof o.loose === 'function' ? o.loose() : o;   // 测试里的假 z 没有 loose
}

// op 表(每个 op 有 req / opt)→ schema: op 枚举 + 全部参数名并集, 一律可选、不限类型。
// 校验仍由 op 表在运行时做, 缺什么回参数表。extra = 工具另有的固定参数(会压过同名)。
function opsShape(z, OPS, extra) {
  const shape = {};
  const names = new Set();
  for (const s of Object.values(OPS)) for (const k of [...(s.req || []), ...(s.opt || [])]) names.add(k);
  names.delete('op');
  for (const k of [...names].sort()) shape[k] = z.any().optional();
  return looseShape(z, { op: z.enum(Object.keys(OPS)), ...shape, ...(extra || {}) });
}

const PARAMS_DESC = 'Other parameters as text, one key=value per line (e.g. "name=…\\nprice=…"). Top-level keys work too.';
function paramsField(z) { return z.string().optional().describe(PARAMS_DESC); }

// params 文本 → 对象: 一行一个 key=value, 只在第一个 = 处切; 整段是 JSON 对象也收。
function parseParams(s) {
  if (typeof s !== 'string' || !s.trim()) return {};
  const t = s.trim();
  if (t.startsWith('{')) {
    try { const o = JSON.parse(t); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch (_) { /* 按行解析 */ }
  }
  const out = {};
  for (const line of t.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (k) out[k] = line.slice(i + 1).trim();
  }
  return out;
}

// 把顶层多出来的键、params 文本和旧写法 args 合成一份参数(顶层 > params > args)。
// 一个都没有 → undefined(=「回参数表」那条路)。
function gather(input, own) {
  const { args, params, ...rest } = input || {};
  const out = (args && typeof args === 'object' && !Array.isArray(args)) ? { ...args } : {};
  if (typeof params === 'string') Object.assign(out, parseParams(params));
  else if (params !== undefined && !own.includes('params')) out.params = params;
  for (const [k, v] of Object.entries(rest)) {
    if (own.includes(k) || v === undefined) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

module.exports = { looseShape, opsShape, paramsField, parseParams, gather };
