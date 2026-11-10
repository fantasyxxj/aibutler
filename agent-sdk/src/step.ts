// 一步 = 一次模型调用。把 AI SDK 的 fullStream 逐个换成 Claude Agent SDK 的 stream_event,
// 同时攒出这一步的内容块(text / thinking / tool_use), 交给 loop 发 assistant 消息、执行工具。
//
// 对应关系(见 butler core/agent/consume.js 读的那几种):
//   start-step                 → message_start
//   text-start / -delta / -end → content_block_start{text} / text_delta / content_block_stop
//   reasoning-*                → content_block_start{thinking} / thinking_delta / stop
//   tool-input-start/-delta/-end → content_block_start{tool_use} / input_json_delta / stop
//   tool-call                  → 定稿该 tool_use 的 input(没流式分片的家在这里一次补齐 start/delta/stop)
//   finish-step                → message_delta + message_stop, 带 usage

import { streamText } from 'ai';
import { toCcUsage } from './convert.js';
import { StreamCut } from './errors.js';

export interface StepCall { id: string; name: string; input: any; invalid?: string }

export interface StepResult {
  blocks: any[];
  calls: StepCall[];
  usage: ReturnType<typeof toCcUsage>;
  stopReason: string;
  responseMessages: any[];
  text: string;
}

export interface StepArgs {
  model: any;
  modelId: string;
  instructions?: any;       // 系统提示词(SystemModelMessage, 可带缓存断点)
  messages: any[];          // 已打好缓存断点
  tools: Record<string, any>;
  maxOutput: number;
  signal: AbortSignal;
  emitEvent: (ev: any) => void;
}

// AI SDK 的兼容性警告(如 "unsupported reasoning metadata")每次调用都打一遍。同一句只记一次。
// 宿主自己设过 AI_SDK_LOG_WARNINGS 就尊重它。
const g: any = globalThis as any;
if (g.AI_SDK_LOG_WARNINGS === undefined) {
  const seen = new Set<string>();
  g.AI_SDK_LOG_WARNINGS = (o: any) => {
    for (const w of o.warnings || []) {
      const key = `${o.model || ''}|${w.type}|${w.feature || w.setting || w.message || ''}|${w.details || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.error(`[agent-sdk] ${o.model || ''}: ${w.details || w.message || w.feature || w.type}`);
    }
  };
}

const STOP: Record<string, string> = { 'tool-calls': 'tool_use', stop: 'end_turn', length: 'max_tokens', 'content-filter': 'refusal' };

export class StepAborted extends Error {
  constructor(public partialText: string) { super('aborted'); }
}

export async function runStep(a: StepArgs): Promise<StepResult> {
  const hasTools = Object.keys(a.tools).length > 0;
  const r = streamText({
    model: a.model,
    ...(a.instructions ? { instructions: a.instructions } : {}),
    messages: a.messages,
    ...(hasTools ? { tools: a.tools } : {}),
    maxOutputTokens: a.maxOutput,
    abortSignal: a.signal,
    maxRetries: 0,              // 重试由 loop 自己做, 才能按次发 api_retry
    onError: () => {},          // 错误走 fullStream 的 error 分片, 不让 AI SDK 自己往控制台打
  });

  const blocks: any[] = [];
  const idx = new Map<string, number>();       // AI SDK 分片 id → 块序号
  const raw = new Map<number, string>();       // tool_use 块收到的原始参数文本
  const calls: StepCall[] = [];
  let usage = toCcUsage(null);
  let stopReason = 'end_turn';
  let text = '';
  let failed: unknown = null;
  let cut = false;

  const open = (key: string, block: any) => {
    const i = blocks.length;
    blocks.push(block);
    idx.set(key, i);
    a.emitEvent({ type: 'content_block_start', index: i, content_block: { ...block } });
    return i;
  };
  const close = (i: number) => a.emitEvent({ type: 'content_block_stop', index: i });

  try {
    for await (const p of r.fullStream as AsyncIterable<any>) {
      switch (p.type) {
        case 'start-step':
          a.emitEvent({ type: 'message_start', message: { id: `msg_${rid()}`, type: 'message', role: 'assistant', model: a.modelId, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
          break;
        case 'text-start': open(`t:${p.id}`, { type: 'text', text: '' }); break;
        case 'text-delta': {
          let i = idx.get(`t:${p.id}`);
          if (i == null) i = open(`t:${p.id}`, { type: 'text', text: '' });
          if (!p.text) break;
          blocks[i].text += p.text;
          text += p.text;
          a.emitEvent({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: p.text } });
          break;
        }
        case 'text-end': { const i = idx.get(`t:${p.id}`); if (i != null) close(i); break; }
        case 'reasoning-start': open(`r:${p.id}`, { type: 'thinking', thinking: '' }); break;
        case 'reasoning-delta': {
          let i = idx.get(`r:${p.id}`);
          if (i == null) i = open(`r:${p.id}`, { type: 'thinking', thinking: '' });
          if (!p.text) break;
          blocks[i].thinking += p.text;
          a.emitEvent({ type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: p.text } });
          break;
        }
        case 'reasoning-end': { const i = idx.get(`r:${p.id}`); if (i != null) close(i); break; }
        case 'tool-input-start': {
          const i = open(`u:${p.id}`, { type: p.providerExecuted ? 'server_tool_use' : 'tool_use', id: p.id, name: p.toolName, input: {} });
          raw.set(i, '');
          break;
        }
        case 'tool-input-delta': {
          const i = idx.get(`u:${p.id}`);
          if (i == null || !p.delta) break;
          raw.set(i, (raw.get(i) || '') + p.delta);
          a.emitEvent({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: p.delta } });
          break;
        }
        case 'tool-input-end': { const i = idx.get(`u:${p.id}`); if (i != null) close(i); break; }
        case 'tool-call': {
          let i = idx.get(`u:${p.toolCallId}`);
          if (i == null) {
            // 这家没流式吐参数: 一次补齐 start / delta / stop, 宿主那边的分片校验照常有料可判
            i = open(`u:${p.toolCallId}`, { type: p.providerExecuted ? 'server_tool_use' : 'tool_use', id: p.toolCallId, name: p.toolName, input: {} });
            const s = JSON.stringify(p.input ?? {});
            raw.set(i, s);
            a.emitEvent({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: s } });
            close(i);
          }
          const input = p.input && typeof p.input === 'object' ? p.input : {};
          blocks[i].input = input;
          if (p.providerExecuted) break;      // 服务端自己执行(web_search), 不归 loop 跑
          const call: StepCall = { id: p.toolCallId, name: p.toolName, input };
          if (p.invalid) call.invalid = String(p.error?.message || p.error || 'invalid tool call');
          calls.push(call);
          break;
        }
        // 服务端工具的结果: 照 Claude API 的样子出一个 web_search_tool_result 块
        case 'tool-result':
        case 'tool-error': {
          if (!p.providerExecuted) break;
          const out = p.type === 'tool-error' ? { type: 'web_search_tool_result_error', error_code: String(p.error?.message || p.error || 'error') } : p.output;
          const i = open(`x:${p.toolCallId}`, { type: 'web_search_tool_result', tool_use_id: p.toolCallId, content: out });
          close(i);
          break;
        }
        case 'finish-step':
          // 没说完流就断了: 不当这一步说完, 交给 loop 重发(用户自己按停走的是 abort 分片, 不在这里)
          if (p.finishReason === 'interrupted') { cut = true; break; }
          usage = toCcUsage(p.usage);
          stopReason = p.rawFinishReason === 'pause_turn' ? 'pause_turn' : (STOP[p.finishReason] || p.rawFinishReason || 'end_turn');
          a.emitEvent({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: usage.output_tokens } });
          a.emitEvent({ type: 'message_stop' });
          break;
        case 'error': failed = p.error; break;
        case 'abort': throw new StepAborted(text);
        default: break;
      }
      if (failed) break;
    }
  } catch (e) {
    if (a.signal.aborted || e instanceof StepAborted) throw new StepAborted(text);
    throw e;
  }
  if (a.signal.aborted) throw new StepAborted(text);
  if (failed) throw failed;
  if (cut) throw new StreamCut(text);

  let responseMessages: any[] = [];
  try { responseMessages = (await r.response).messages || []; } catch (_) { /* 拿不到就按块重建 */ }
  if (!responseMessages.length) responseMessages = [rebuildAssistant(blocks)];
  // 无效调用(没加载的工具 / 参数不合 schema)AI SDK 会自己补一条错误 tool-result;
  // loop 对 calls 里每一条都回填结果, 两份同 id 会被 API 400 拒掉。这里只留 loop 那份。
  const ours = new Set(calls.map((c) => c.id));
  responseMessages = responseMessages
    .map((m) => m.role !== 'tool' ? m : { ...m, content: (m.content || []).filter((p: any) => !(p.type === 'tool-result' && ours.has(p.toolCallId))) })
    .filter((m) => m.role !== 'tool' || m.content.length);
  // 只有空白的正文块(模型调工具前常先吐一个「\n\n」)跟 Claude Code CLI 一样不进整条消息, 也不进历史。
  const blank = (p: any) => p && p.type === 'text' && !String(p.text || '').trim();
  responseMessages = responseMessages
    .map((m) => m.role !== 'assistant' || !Array.isArray(m.content) ? m : { ...m, content: m.content.filter((p: any) => !blank(p)) })
    .filter((m) => m.role !== 'assistant' || !Array.isArray(m.content) || m.content.length);
  return { blocks: blocks.filter((b) => !blank(b)), calls, usage, stopReason, responseMessages, text };
}

function rebuildAssistant(blocks: any[]): any {
  const content: any[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && b.text) content.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') content.push({ type: 'tool-call', toolCallId: b.id, toolName: b.name, input: b.input });
  }
  return { role: 'assistant', content };
}

export function rid(): string {
  const c: any = (globalThis as any).crypto;
  return c && c.randomUUID ? c.randomUUID().replace(/-/g, '').slice(0, 24) : Math.random().toString(36).slice(2, 14);
}
