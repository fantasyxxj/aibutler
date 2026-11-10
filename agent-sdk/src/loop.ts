// 一轮 = 宿主的一条(或软插话并进来的几条)用户消息 → 若干步模型调用 + 工具执行 → result。
// 消息发什么、什么顺序, 都照 Claude Agent SDK: init → user(回放) → stream_event… → assistant →
// user(tool_result) → … → result。

import { generateText } from 'ai';
import { runStep, StepAborted, rid, type StepCall } from './step.js';
import { classify, backoffMs } from './errors.js';
import { userToModel, toolOutputToModel, toolOutputToBlock, errorOutput, toCcUsage } from './convert.js';
import { runPreToolUse } from './hooks.js';
import { systemMessages, markMessages } from './providers/cache.js';
import type { ToolOutput, BuiltinTool, SubagentOpts, SubagentResult } from './tools/registry.js';
import type { BgStart } from './background.js';
import { STRUCTURED_OUTPUT } from './tools/agent.js';
import { Session, synthetic, type AgentRec } from './session.js';
import { Channel } from './channel.js';
import { est } from './context.js';

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
    emitAssistant(s, [{ type: 'text', text: lastText }], total, 'end_turn', c.kind);
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
          emitAssistant(s, [{ type: 'text', text: lastText }], toCcUsage(null), 'end_turn', c.kind);
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
    // 网关回报的输入数会偶发虚高(同一请求体报过 14458 也报过 24160), 占用按回报与自估取小;
    // 自估随 usage 带给宿主(ctx_estimate), 宿主的压缩 / 保活门槛同样取小。计费仍按回报原数。
    const reqEst = est(system) + est(JSON.stringify(Object.values(tools).map((t: any) => [t.description, t.inputSchema && t.inputSchema.jsonSchema]))) + est(JSON.stringify(messages));
    emitAssistant(s, step.blocks, { ...step.usage, ctx_estimate: reqEst }, step.stopReason);
    s.history.push(...step.responseMessages);
    const reported = step.usage.input_tokens + step.usage.cache_read_input_tokens + step.usage.cache_creation_input_tokens;
    s.lastInput = reported ? Math.min(reported, reqEst) : reqEst;
    // 占用诊断: 这一步实际送了多少(token)、各块多大(字符), 查「开局偏高」时看涨在哪块
    s.log(`[usage] ${s.modelId}${s.isChild ? ' (sub-agent)' : ''} step ${steps} in=${s.lastInput} reported=${reported} est=${reqEst} (new=${step.usage.input_tokens} read=${step.usage.cache_read_input_tokens} write=${step.usage.cache_creation_input_tokens}) system=${system.length}c tools=${Object.keys(tools).length}/${JSON.stringify(Object.values(tools).map((t: any) => [t.description, t.inputSchema && t.inputSchema.jsonSchema])).length}c history=${s.history.length}msg/${JSON.stringify(s.history).length}c`);

    if (!step.calls.length) {
      // 服务端工具跑太久时 Anthropic 回 pause_turn: 原样把历史再发一次让它接着跑
      if (step.stopReason === 'pause_turn' && steps < s.maxTurns) continue;
      break;
    }

    const results = await runCalls(s, step.calls, signal);
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
  if (s.replay && !m.isSynthetic) s.emit({ type: 'user', message: m.message, parent_tool_use_id: null, session_id: s.sessionId, uuid: m.uuid || uuid(), isReplay: true });
}

// 同一步里相邻的只读调用一起跑, 碰到会改东西的就等前面跑完再一个一个来(和 Claude Code 一样);
// 结果按原调用顺序回填, 历史和前缀缓存跟串行时一模一样。
async function runCalls(s: Session, calls: StepCall[], signal: AbortSignal): Promise<Array<{ call: StepCall; out: ToolOutput }>> {
  const run = (call: StepCall) => (signal.aborted ? Promise.resolve(errorOutput(INTERRUPTED_NOTE)) : execTool(s, call, signal));
  const outs: ToolOutput[] = [];
  for (let i = 0; i < calls.length;) {
    let j = i;
    while (j < calls.length && s.registry!.isReadOnly(calls[j].name)) j++;
    if (j === i) { outs.push(await run(calls[i])); i++; continue; }
    outs.push(...await Promise.all(calls.slice(i, j).map(run)));
    i = j;
  }
  return calls.map((call, k) => ({ call, out: outs[k] }));
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
    const runSubagent = s.isChild ? undefined : (prompt: string, o: SubagentOpts) => runChild(s, prompt, o, signal);
    const startBackground = s.isChild ? undefined : (o: BgStart) => s.bg.start({ ...o, toolUseId: call.id });
    const sendToAgent = s.isChild ? undefined : (to: string, message: string) => sendToChild(s, to, message, call.id);
    out = await entry.run(v.input, { cwd: s.cwd, signal, env: s.env, complete, runSubagent, startBackground, sendToAgent,
      stopBackground: s.isChild ? undefined : (id: string) => s.bg.stop(id), sessionId: s.sessionId, toolUseId: call.id });
  } catch (e: any) {
    out = errorOutput(`<tool_use_error>${e && e.message ? e.message : String(e)}</tool_use_error>`);
  }
  if (v.notes.length) {
    out = { ...out, content: [...out.content, ...v.notes.map((n) => ({ type: 'text', text: `<system-reminder>\nPreToolUse hook additional context: ${n}\n</system-reminder>` }))] };
  }
  return out;
}

// 起一个子代理跑完 prompt。o.signal 给了就跟它走(后台子代理随会话, 不随这一轮);
// o.schema 给了就多一个 StructuredOutput 工具, 子代理把结果按 schema 交进来, 拿回的是那个对象。
// o.agentId 给了就把子代理留下, SendMessage 能找回来续聊。
async function runChild(s: Session, prompt: string, o: SubagentOpts, turnSignal: AbortSignal): Promise<SubagentResult> {
  let structured: any;
  const extra = o.schema ? [structuredOutputTool(o.schema, (v) => { structured = v; })] : [];
  const c = Session.child(s, o.type, o.model, extra, o.cwd);
  const rec: AgentRec = { id: o.agentId || '', name: o.name, child: c, running: true };
  if (o.agentId) s.rememberAgent(rec);
  const r = await childRound(rec, [userText(prompt)], o.signal || turnSignal, o.onProgress);
  if (o.schema && structured === undefined && !r.isError) structured = parseJsonLoose(r.text);
  return { ...r, ...(o.schema ? { structured: structured === undefined ? null : structured } : {}) };
}

// 在子代理上跑一轮; 跑的期间 SendMessage 投进来、而它最后一步没工具调用所以没读到的, 接着再跑一轮读掉
async function childRound(rec: AgentRec, batch: any[], signal: AbortSignal, onProgress?: (name: string) => void): Promise<SubagentResult> {
  const c = rec.child;
  rec.running = true;
  let result: any = null;
  try {
    while (batch.length && !signal.aborted) {
      c.out = new Channel<any>();
      const drain = (async () => {
        for await (const m of c.out) {
          if (m.type === 'result') result = m;
          else if (onProgress && m.type === 'assistant') {
            for (const b of m.message?.content || []) if (b && b.type === 'tool_use') onProgress(b.name);
          }
        }
      })();
      await runTurn(c, batch, signal);
      c.out.close();
      await drain;
      batch = c.inbox.drain();
    }
  } finally { rec.running = false; }
  const text = result ? String(result.result || '') : '';
  const isError = !result || !!result.is_error || result.subtype !== 'success';
  return { text, isError };
}

function userText(text: string): any {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}

// SendMessage: 正在跑 → 投进它的收件箱(工具间歇读到); 停着 → 后台续跑一轮, 跑完照常通知主代理
function sendToChild(s: Session, to: string, message: string, toolUseId: string): { status: 'queued' | 'resumed' | 'missing'; taskId?: string; agentId?: string } {
  const rec = s.agents.get(to);
  if (!rec) return { status: 'missing' };
  if (rec.running) { rec.child.inbox.push(synthetic(message)); return { status: 'queued', agentId: rec.id }; }
  const label = rec.name || rec.id;
  rec.running = true;   // 后台任务真正开跑前就占住, 紧接着的第二条 SendMessage 走排队
  const taskId = s.bg.start({ description: `continue ${label}`, kind: 'local_agent', toolUseId, prompt: message,
    run: async (signal, progress) => {
      const r = await childRound(rec, [userText(message), ...rec.child.inbox.drain()], signal, (n) => progress(`using ${n}`, n));
      return { text: `${r.text || '(the agent returned no text)'}\n\nagentId: ${rec.id}${rec.name ? ` (name: ${rec.name})` : ''}`, isError: r.isError };
    } });
  return { status: 'resumed', taskId, agentId: rec.id };
}

function structuredOutputTool(schema: any, take: (v: any) => void): BuiltinTool {
  return {
    name: STRUCTURED_OUTPUT,
    description: 'Return your final result as structured data matching this schema. Call it exactly once, as your last action.',
    inputSchema: schema && schema.type === 'object' ? schema : { type: 'object', properties: {} },
    async run(input) {
      take(input);
      return { content: [{ type: 'text', text: 'Structured output received. Reply with one short line and stop.' }] };
    },
  };
}

function parseJsonLoose(text: string): any {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (m ? m[1] : text).trim();
  try { return JSON.parse(raw); } catch (_) { return undefined; }
}

// error: 这条是报错不是模型说的话(官方 SDK 的 SDKAssistantMessage.error 同名同义), 宿主据此换成给人看的说法
function emitAssistant(s: Session, blocks: any[], usage: any, stopReason: string, error?: string): void {
  s.emit({
    type: 'assistant',
    message: { id: `msg_${rid()}`, type: 'message', role: 'assistant', model: s.modelId, content: blocks, stop_reason: stopReason, stop_sequence: null, usage },
    parent_tool_use_id: null, session_id: s.sessionId, uuid: uuid(),
    ...(error ? { error } : {}),
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
