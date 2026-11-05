// 提示缓存。
// Anthropic 协议(含讲 Anthropic 协议的网关): 显式打断点 —— 系统提示词末尾一个(连同排在它前面的
// 工具定义一起缓存), 最近两条消息各一个(滚动前进, 上一轮的断点正好是这一轮的命中前缀)。
// 其余家(OpenAI / DeepSeek / Qwen …)是服务端自动前缀缓存, 不用标记, 只要前缀稳定:
// 工具顺序固定、系统提示词整段不变 —— 这两条由 tools/registry.ts 与 loop.ts 保证。

import type { Family } from './resolve.js';

const EPHEMERAL = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };

export function systemMessages(system: string, family: Family): any[] {
  if (!system) return [];
  return [{ role: 'system', content: system, ...(family === 'anthropic' ? { providerOptions: EPHEMERAL } : {}) }];
}

// 返回带断点的浅拷贝, 不改历史本身(断点每轮要挪)。
export function markMessages(messages: any[], family: Family): any[] {
  if (family !== 'anthropic' || !messages.length) return messages;
  const out = messages.slice();
  let marked = 0;
  for (let i = out.length - 1; i >= 0 && marked < 2; i--) {
    const m = out[i];
    if (m.role === 'system') continue;
    out[i] = { ...m, providerOptions: { ...(m.providerOptions || {}), ...EPHEMERAL } };
    marked++;
  }
  return out;
}
