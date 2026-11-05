// 格式换算: Claude Agent SDK 的消息块 ⇄ AI SDK 的 ModelMessage, 以及工具结果。

import type { ToolOutput } from './tools/registry.js';

// 宿主推进来的用户消息(butler 的 buildUserMessage 产物) → AI SDK user message
export function userToModel(msg: any): any {
  const raw = msg?.message?.content;
  const blocks: any[] = typeof raw === 'string' ? [{ type: 'text', text: raw }] : Array.isArray(raw) ? raw : [];
  const content: any[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') content.push({ type: 'text', text: b.text });
    else if (b.type === 'image' && b.source?.type === 'base64') content.push({ type: 'image', image: b.source.data, mediaType: b.source.media_type });
    else if (b.type === 'document' && b.source?.type === 'base64') content.push({ type: 'file', data: b.source.data, mediaType: b.source.media_type || 'application/pdf' });
    else if (b.type === 'tool_result') content.push({ type: 'text', text: textOf(b.content) });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return { role: 'user', content };
}

function textOf(c: any): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n');
  return '';
}

// 工具输出 → AI SDK tool-result 的 output 字段
export function toolOutputToModel(out: ToolOutput): any {
  const texts = out.content.filter((c) => c.type === 'text').map((c) => c.text || '');
  const images = out.content.filter((c) => c.type === 'image' && c.data);
  const joined = texts.join('\n') || (images.length ? '' : '(no output)');
  if (images.length) {
    const value: any[] = [];
    if (joined) value.push({ type: 'text', text: joined });
    for (const im of images) value.push({ type: 'file', data: { type: 'data', data: im.data }, mediaType: im.mimeType || 'image/png' });
    return { type: 'content', value };
  }
  return out.isError ? { type: 'error-text', value: joined } : { type: 'text', value: joined };
}

// 工具输出 → Claude 格式的 tool_result 块(回发给宿主看的那条 user 消息)
export function toolOutputToBlock(id: string, out: ToolOutput): any {
  const content = out.content.map((c) => (c.type === 'image'
    ? { type: 'image', source: { type: 'base64', media_type: c.mimeType || 'image/png', data: c.data } }
    : { type: 'text', text: c.text || '' }));
  return { type: 'tool_result', tool_use_id: id, content, ...(out.isError ? { is_error: true } : {}) };
}

export function errorOutput(text: string): ToolOutput {
  return { content: [{ type: 'text', text }], isError: true };
}

// AI SDK usage → Anthropic 风格 usage(butler 的 sumInput 把三项相加当上下文大小)
export function toCcUsage(u: any): { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } {
  const d = u?.inputTokenDetails || {};
  const read = d.cacheReadTokens || 0;
  const write = d.cacheWriteTokens || 0;
  const fresh = d.noCacheTokens != null ? d.noCacheTokens : Math.max(0, (u?.inputTokens || 0) - read - write);
  return { input_tokens: fresh, output_tokens: u?.outputTokens || 0, cache_read_input_tokens: read, cache_creation_input_tokens: write };
}
