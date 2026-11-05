'use strict';
// 工具参数平铺: 参数直接写在顶层, 如 task(op='create', subject='…'), 不套 args={…}。
//
// 嵌套对象里的中日文, 模型会写成 \uXXXX(10-20 r13 重放实测, haiku 写错码就成错字);
// core/escape-guard.js 只能打回让它重写, 10-26~11-02 一周打回 98 次, 全在套 args 的工具上
// (task 56 · bus_admin 17 · plugin_open 15 · memory_admin 9 · plugin_call 1)。
// 平着写的同一句 0/10 —— 所以从源头不给嵌套的口子。
//
// 做法: schema 只声明工具自己的固定参数, 用 loose() 收下其余顶层键(JSON schema 带
// additionalProperties), 不必把所有 op 的参数并集逐个声明。老会话里照旧套 args={…} 的
// 那一次照收, 顶层同名键压过 args 里的。

function looseShape(z, shape) {
  const o = z.object(shape);
  return typeof o.loose === 'function' ? o.loose() : o;   // 测试里的假 z 没有 loose
}

// 把顶层多出来的键和旧写法 args 合成一份参数。一个都没有 → undefined(=「回参数表」那条路)。
function gather(input, own) {
  const { args, ...rest } = input || {};
  const out = (args && typeof args === 'object' && !Array.isArray(args)) ? { ...args } : {};
  for (const [k, v] of Object.entries(rest)) {
    if (own.includes(k) || v === undefined) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

module.exports = { looseShape, gather };
