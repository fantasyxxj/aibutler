// 一轮 = 宿主的一条(或软插话并进来的几条)用户消息 → 若干步模型调用 + 工具执行 → result。
// 消息发什么、什么顺序, 都照 Claude Agent SDK: init → user(回放) → stream_event… → assistant →
// user(tool_result) → … → result。

import { generateText } from 'ai';
import { runStep, StepAborted, rid, type StepCall } from './step.js';
import { classify, backoffMs } from './errors.js';
import { userToModel, toolOutputToModel, toolOutputToBlock, errorOutput, toCcUsage } from './convert.js';
import { runPreToolUse } from './hooks.js';
import { systemMessages, markMessages } from './providers/cache.js';
import type { ToolOutput } from './tools/registry.js';
import { Session } from './session.js';

const MAX_RETRIES = 6;
const INTERRUPTED_NOTE = '[Request interrupted by user]';

export async function runTurn(s: Session, batch: any[], signal: AbortSignal): Promise<void> {
  const started = Date.now();
  let apiMs = 0;
  s.emit({ type: 'system', subtype: 'init', session_id: s.sessionId, model: s.modelId, cwd: s.cwd, tools: s.registry ? s.registry.entries.map((e) => e.name) : [], mcp_servers: s.mcpStatus, permissionMode: s.opts.permissionMode || 'default', apiKeySource: 'none', uuid: uuid() });
  for (const m of batch) admitUser(s, m);

  const total = toCcUsage(null);
  let lastText = '';
  let isError = false;
  let subtype = 'success';
  let steps = 0;

  if (s.setupError) {
    // 接不上模型(缺 key / 型号空): 每一轮都照实报一次, 宿主据此挂横幅, 而不是卡住不回
    const c = classify(s.setupError);
    s.emit({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 1, retry_delay_ms: 0, error_status: c.status, error: c.kind, session_id: s.sessionId, uuid: uuid() });
    lastText = `API Error: ${c.message}`;
    emitAssistant(s, [{ type: 'text', text: lastText }], total, 'end_turn');
    isError = true;
  }

  while (!s.setupError) {
    if (signal.aborted) { subtype = 'error_during_execution'; break; }
    const tools = s.registry!.toolSet();
    if (s.serverSearch) tools.web_search = s.serverSearch;
    // 思考块签名绑定产出时的工具清单。ToolSearch 加载了新工具 → 清单变了 → 旧思考块回放必 400
    // (`The tools list differs from the one this block was created with`)。丢掉旧思考块再发,
    // 与 API 的 drop_block 同义, 但不依赖网关转发 beta 头。
    const toolKey = Object.keys(tools).sort().join(',');
    if (s.toolKey && s.toolKey !== toolKey) s.history = dropReasoning(s.history);
    s.toolKey = toolKey;
    const system = s.system + s.registry!.deferredNotice();
    const instructions = systemMessages(system, s.family)[0];
    const messages = markMessages(s.history, s.family);

    let step: Awaited<ReturnType<typeof runStep>> | null = null;
    for (let attempt = 1; ; attempt++) {
      const t0 = Date.now();
      try {
        step = await runStep({ model: s.model, modelId: s.modelId, instructions, messages, tools, maxOutput: s.maxOutput, signal, emitEvent: (ev) => s.emitEvent(ev) });
        apiMs += Date.now() - t0;
        break;
      } catch (e: any) {
        apiMs += Date.now() - t0;
        if (e instanceof StepAborted || signal.aborted) {
          if (e && e.partialText) s.history.push({ role: 'assistant', content: [{ type: 'text', text: e.partialText }] });
          s.history.push({ role: 'user', content: [{ type: 'text', text: INTERRUPTED_NOTE }] });
          subtype = 'error_during_execution';
          break;
        }
        const c = classify(e);
        const retry = c.retryable && attempt < MAX_RETRIES;
        const delay = retry ? backoffMs(attempt) : 0;
        s.emit({ type: 'system', subtype: 'api_retry', attempt, max_retries: MAX_RETRIES, retry_delay_ms: delay, error_status: c.status, error: c.kind, session_id: s.sessionId, uuid: uuid() });
        s.log(`[api] ${s.modelId} 第 ${attempt} 次失败 status=${c.status} kind=${c.kind}: ${c.message.slice(0, 600)}`);
        if (!retry) {
          lastText = `API Error: ${c.status != null ? c.status + ' ' : ''}${c.message}`;
          emitAssistant(s, [{ type: 'text', text: lastText }], toCcUsage(null), 'end_turn');
          isError = true;
          break;
        }
        await sleep(delay, signal);
      }
    }
    if (!step) break;
    steps++;
    addUsage(total, step.usage);
    if (step.text) lastText = step.text;
    emitAssistant(s, step.blocks, step.usage, step.stopReason);
    s.history.push(...step.responseMessages);
    s.lastInput = step.usage.input_tokens + step.usage.cache_read_input_tokens + step.usage.cache_creation_input_tokens;

    if (!step.calls.length) {
      // 服务端工具跑太久时 Anthropic 回 pause_turn: 原样把历史再发一次让它接着跑
      if (step.stopReason === 'pause_turn' && steps < s.maxTurns) continue;
      break;
    }

    const results: Array<{ call: StepCall; out: ToolOutput }> = [];
    for (const call of step.calls) {
      const out = signal.aborted ? errorOutput(INTERRUPTED_NOTE) : await execTool(s, call, signal);
      results.push({ call, out });
    }
    s.history.push({ role: 'tool', content: results.map(({ call, out }) => ({ type: 'tool-result', toolCallId: call.id, toolName: call.name, output: toolOutputToModel(out) })) });
    s.emit({ type: 'user', message: { role: 'user', content: results.map(({ call, out }) => toolOutputToBlock(call.id, out)) }, parent_tool_use_id: null, session_id: s.sessionId, uuid: uuid() });

    if (signal.aborted) {
      s.history.push({ role: 'user', content: [{ type: 'text', text: INTERRUPTED_NOTE }] });
      subtype = 'error_during_execution';
      break;
    }
    // 软插话: 这一步期间到的新消息, 并进历史再调下一步(和 CLI 一样在工具间歇读到)
    for (const m of s.inbox.drain()) admitUser(s, m);
    if (steps >= s.maxTurns) { subtype = 'error_max_turns'; break; }
  }

  s.emit({
    type: 'result', subtype, is_error: isError, duration_ms: Date.now() - started, duration_api_ms: apiMs,
    num_turns: steps, result: lastText, session_id: s.sessionId, total_cost_usd: 0, usage: total,
    modelUsage: { [s.modelId]: { inputTokens: total.input_tokens, outputTokens: total.output_tokens, cacheReadInputTokens: total.cache_read_input_tokens, cacheCreationInputTokens: total.cache_creation_input_tokens, webSearchRequests: 0, costUSD: 0, contextWindow: s.contextWindow, maxOutputTokens: s.maxOutput } },
    permission_denials: [], uuid: uuid(),
  });
}

function admitUser(s: Session, m: any): void {
  s.history.push(userToModel(m));
  if (s.replay) s.emit({ type: 'user', message: m.message, parent_tool_use_id: null, session_id: s.sessionId, uuid: m.uuid || uuid(), isReplay: true });
}

async function execTool(s: Session, call: StepCall, signal: AbortSignal): Promise<ToolOutput> {
  const entry = s.registry!.get(call.name);
  if (!entry) return errorOutput(`<tool_use_error>Error: No such tool available: ${call.name}</tool_use_error>`);
  if (!s.registry!.isLoaded(entry)) {
    return errorOutput(`<tool_use_error>${call.name} is a deferred tool and its schema is not loaded. Call ToolSearch with query "select:${call.name}" first.</tool_use_error>`);
  }
  if (call.invalid) return errorOutput(`<tool_use_error>InputValidationError: ${call.invalid}</tool_use_error>`);
  const v = await runPreToolUse(s.preHooks, { session_id: s.sessionId, cwd: s.cwd, permission_mode: s.opts.permissionMode }, call, signal, s.log);
  if (v.denied) return errorOutput(v.denied);
  let out: ToolOutput;
  try {
    const complete = async (system: string, user: string) => (await generateText({
      model: s.model, instructions: system, messages: [{ role: 'user', content: user }], maxOutputTokens: 2000, abortSignal: signal, maxRetries: 2,
    })).text;
    const runSubagent = s.isChild ? undefined : async (prompt: string, o: { type?: string }) => {
      const c = Session.child(s, o.type);
      let result: any = null;
      const drain = (async () => { for await (const m of c.out) if (m.type === 'result') result = m; })();
      await runTurn(c, [{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }], signal);
      c.out.close();
      await drain;
      return { text: result ? String(result.result || '') : '', isError: !result || !!result.is_error || result.subtype !== 'success' };
    };
    out = await entry.run(v.input, { cwd: s.cwd, signal, env: s.env, complete, runSubagent });
  } catch (e: any) {
    out = errorOutput(`<tool_use_error>${e && e.message ? e.message : String(e)}</tool_use_error>`);
  }
  if (v.notes.length) {
    out = { ...out, content: [...out.content, ...v.notes.map((n) => ({ type: 'text', text: `<system-reminder>\nPreToolUse hook additional context: ${n}\n</system-reminder>` }))] };
  }
  return out;
}

function emitAssistant(s: Session, blocks: any[], usage: any, stopReason: string): void {
  s.emit({
    type: 'assistant',
    message: { id: `msg_${rid()}`, type: 'message', role: 'assistant', model: s.modelId, content: blocks, stop_reason: stopReason, stop_sequence: null, usage },
    parent_tool_use_id: null, session_id: s.sessionId, uuid: uuid(),
  });
}

function addUsage(t: any, u: any): void {
  t.input_tokens += u.input_tokens; t.output_tokens += u.output_tokens;
  t.cache_read_input_tokens += u.cache_read_input_tokens; t.cache_creation_input_tokens += u.cache_creation_input_tokens;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
  });
}

export function uuid(): string {
  const c: any = (globalThis as any).crypto;
  if (c && c.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function dropReasoning(history: any[]): any[] {
  return history
    .map((m) => (m.role !== 'assistant' || !Array.isArray(m.content)) ? m
      : { ...m, content: m.content.filter((p: any) => p.type !== 'reasoning' && p.type !== 'redacted-reasoning') })
    .filter((m) => !Array.isArray(m.content) || m.content.length);
}
