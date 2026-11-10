// @ai-sdk/anthropic 回传助手消息时 moveToolUseBlocksToEnd: 本地 tool_use 一律挪到最后, 照 Claude 的要求。
// DeepSeek 的 Anthropic 端点同一步流出「thinking → tool_use → server_tool_use → web_search_tool_result」,
// 挪成「thinking → server_tool_use → web_search_tool_result → tool_use」它就 400
// (`content[].thinking in the thinking mode must be passed back`)。
// 非 Claude 模型走 Anthropic 协议时, 发请求前把 tool_use 挪回第一个服务端工具块前面, 即它流出时的位置。

const SERVER = /^server_tool_use$|_tool_result$/;

export function toolUseBeforeServerBlocks(content: any[]): any[] {
  if (!Array.isArray(content)) return content;
  const first = content.findIndex((b) => b && SERVER.test(b.type) && b.type !== 'tool_result');
  if (first < 0) return content;
  const moved = content.slice(first).filter((b) => b && b.type === 'tool_use');
  if (!moved.length) return content;
  const rest = content.slice(first).filter((b) => !(b && b.type === 'tool_use'));
  return [...content.slice(0, first), ...moved, ...rest];
}

export function withStreamToolOrder(base: typeof fetch): typeof fetch {
  return (async (url: any, init?: any) => {
    if (init && typeof init.body === 'string' && init.body.includes('"server_tool_use"')) {
      try {
        const b = JSON.parse(init.body);
        if (Array.isArray(b.messages)) {
          b.messages = b.messages.map((m: any) => m.role === 'assistant' && Array.isArray(m.content) ? { ...m, content: toolUseBeforeServerBlocks(m.content) } : m);
          init = { ...init, body: JSON.stringify(b) };
        }
      } catch { /* 不是 JSON 就原样发 */ }
    }
    return base(url, init);
  }) as typeof fetch;
}
