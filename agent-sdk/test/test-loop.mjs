// 主循环: 消息顺序 / 工具执行 / 钩子 / 软插话 / 打断 / 出错重试, 全部对着假的 Anthropic 网关跑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { query, tool, createSdkMcpServer } from '../dist/index.js';
import { anthropicStep, fakeFetch, userMsg, queue, sse, GATEWAY_ENV } from './helpers.mjs';

function butlerServer(calls) {
  return createSdkMcpServer({ name: 'butler', version: '0.0.1', tools: [
    tool('echo', 'echo back', { text: z.string() }, async ({ text }) => { calls.push(text); return { content: [{ type: 'text', text: `echo:${text}` }] }; }, { alwaysLoad: true }),
    tool('later', 'a deferred tool', { n: z.number().optional() }, async () => ({ content: [{ type: 'text', text: 'later ok' }] })),
  ] });
}

async function take(q, pred) {
  const got = [];
  for (;;) {
    const { value, done } = await q.next();
    if (done) return got;
    got.push(value);
    if (pred(value, got)) return got;
  }
}
const isResult = (m) => m.type === 'result';

test('一轮: init → 回放 → stream_event → assistant → 工具 → assistant → result', async () => {
  const echoed = [];
  const f = fakeFetch([
    anthropicStep([{ text: '我查一下' }, { tool: { id: 'tu1', name: 'mcp__butler__echo', input: { text: '日本語' } } }]),
    anthropicStep([{ text: '好了' }]),
  ]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'deepseek-v4-flash', env: GATEWAY_ENV, fetch: f, systemPrompt: 'SYS', includePartialMessages: true,
    extraArgs: { 'replay-user-messages': null }, mcpServers: { butler: butlerServer(echoed) } } });
  p.push(userMsg('你好', 'uuid-1'));
  const msgs = await take(q, isResult);
  const kinds = msgs.map((m) => m.type + (m.subtype ? '/' + m.subtype : '') + (m.isReplay ? '/replay' : ''));
  assert.equal(kinds[0], 'system/init');
  assert.equal(kinds[1], 'user/replay');
  assert.equal(msgs[1].uuid, 'uuid-1');
  assert.ok(kinds.includes('stream_event'));
  const assistants = msgs.filter((m) => m.type === 'assistant');
  assert.equal(assistants.length, 2);
  const tu = assistants[0].message.content.find((b) => b.type === 'tool_use');
  assert.deepEqual(tu.input, { text: '日本語' });
  assert.deepEqual(echoed, ['日本語']);
  // 用量换算: 未命中 / 命中分开
  assert.equal(assistants[0].message.usage.input_tokens, 10);
  assert.equal(assistants[0].message.usage.cache_read_input_tokens, 90);
  const r = msgs.at(-1);
  assert.equal(r.subtype, 'success');
  assert.equal(r.is_error, false);
  assert.equal(r.result, '好了');
  assert.equal(r.modelUsage['deepseek-v4-flash'].contextWindow, 1_000_000);
  // 第二次请求里带着工具结果
  const second = f.calls[1].body;
  const tr = JSON.stringify(second.messages);
  assert.match(tr, /echo:日本語/);
  // 网关: baseURL 补 /v1, 两种鉴权头都在
  assert.equal(f.calls[0].url, 'http://gw.test/v1/messages');
  // 缓存断点: system 末尾有 cache_control
  assert.ok(JSON.stringify(f.calls[0].body.system).includes('cache_control'));
  p.close();
  await q.return();
});

test('content_block 事件序: text_delta / input_json_delta 都有, 且 stop 先于 assistant', async () => {
  const f = fakeFetch([anthropicStep([{ tool: { id: 'a', name: 'mcp__butler__echo', input: { text: 'x' } } }]), anthropicStep([{ text: 'ok' }])]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'claude-haiku-4-5', env: GATEWAY_ENV, fetch: f, includePartialMessages: true, mcpServers: { butler: butlerServer([]) } } });
  p.push(userMsg('hi'));
  const msgs = await take(q, isResult);
  const evs = msgs.filter((m) => m.type === 'stream_event').map((m) => m.event.type + (m.event.delta ? ':' + m.event.delta.type : ''));
  assert.ok(evs.includes('content_block_delta:input_json_delta'));
  assert.ok(evs.includes('content_block_delta:text_delta'));
  const firstAssistant = msgs.findIndex((m) => m.type === 'assistant');
  const firstStop = msgs.findIndex((m) => m.type === 'stream_event' && m.event.type === 'content_block_stop');
  assert.ok(firstStop < firstAssistant);
  p.close(); await q.return();
});

test('PreToolUse: deny 不执行并把理由给模型; additionalContext 接在结果后面', async () => {
  const echoed = [];
  const f = fakeFetch([
    anthropicStep([{ tool: { id: 't1', name: 'mcp__butler__echo', input: { text: 'blocked' } } }, { tool: { id: 't2', name: 'mcp__butler__echo', input: { text: 'passed' } } }]),
    anthropicStep([{ text: 'done' }]),
  ]);
  const seen = [];
  const hook = async (input) => {
    seen.push(input.tool_name);
    if (input.tool_input.text === 'blocked') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'NO-WAY' } };
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'NOTE-HERE' } };
  };
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f, mcpServers: { butler: butlerServer(echoed) }, hooks: { PreToolUse: [{ hooks: [hook] }] } } });
  p.push(userMsg('go'));
  await take(q, isResult);
  assert.deepEqual(echoed, ['passed']);
  assert.deepEqual(seen, ['mcp__butler__echo', 'mcp__butler__echo']);
  const sent = JSON.stringify(f.calls[1].body.messages);
  assert.match(sent, /NO-WAY/);
  assert.match(sent, /NOTE-HERE/);
  p.close(); await q.return();
});

test('guardEmptyArgs 式的处理器拦截照样生效(调用走 McpServer 的 tools/call)', async () => {
  const echoed = [];
  const srv = butlerServer(echoed);
  const handlers = srv.instance.server._requestHandlers;
  const orig = handlers.get('tools/call');
  assert.ok(orig, 'tools/call 处理器在');
  handlers.set('tools/call', (req, extra) => {
    if (!req.params.arguments || !Object.keys(req.params.arguments).length) return Promise.resolve({ content: [{ type: 'text', text: 'EMPTY-GUARD' }] });
    return orig(req, extra);
  });
  const f = fakeFetch([anthropicStep([{ tool: { id: 'e', name: 'mcp__butler__echo', input: {} } }]), anthropicStep([{ text: 'k' }])]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f, mcpServers: { butler: srv } } });
  p.push(userMsg('x'));
  await take(q, isResult);
  assert.match(JSON.stringify(f.calls[1].body.messages), /EMPTY-GUARD/);
  assert.deepEqual(echoed, []);
  p.close(); await q.return();
});

test('延迟加载: 没标 alwaysLoad 的先只报名字, ToolSearch 之后下一步才带 schema', async () => {
  const f = fakeFetch([
    anthropicStep([{ tool: { id: 's', name: 'ToolSearch', input: { query: 'select:mcp__butler__later' } } }]),
    anthropicStep([{ tool: { id: 'l', name: 'mcp__butler__later', input: {} } }]),
    anthropicStep([{ text: 'fin' }]),
  ]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f, tools: ['ToolSearch'], mcpServers: { butler: butlerServer([]) } } });
  p.push(userMsg('x'));
  await take(q, isResult);
  const names = (i) => (f.calls[i].body.tools || []).map((t) => t.name);
  assert.ok(names(0).includes('mcp__butler__echo'));
  assert.ok(!names(0).includes('mcp__butler__later'));
  assert.match(JSON.stringify(f.calls[0].body.system), /mcp__butler__later/);
  assert.ok(names(1).includes('mcp__butler__later'));
  assert.match(JSON.stringify(f.calls[2].body.messages), /later ok/);
  p.close(); await q.return();
});

test('调了没加载的工具: 历史里该 id 只回一条 tool_result', async () => {
  const f = fakeFetch([
    anthropicStep([{ tool: { id: 'bad', name: 'mcp__butler__later', input: {} } }]),
    anthropicStep([{ text: 'fin' }]),
  ]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f, tools: ['ToolSearch'], mcpServers: { butler: butlerServer([]) } } });
  p.push(userMsg('x'));
  await take(q, isResult);
  const results = f.calls[1].body.messages.flatMap((m) => Array.isArray(m.content) ? m.content : [])
    .filter((b) => b.type === 'tool_result' && b.tool_use_id === 'bad');
  assert.equal(results.length, 1);
  p.close(); await q.return();
});

test('ToolSearch 加载新工具后, 旧思考块不再回放(签名绑定旧工具清单会 400)', async () => {
  const f = fakeFetch([
    anthropicStep([{ thinking: 'hmm' }, { tool: { id: 's', name: 'ToolSearch', input: { query: 'select:mcp__butler__later' } } }]),
    anthropicStep([{ thinking: 'again' }, { tool: { id: 'e', name: 'mcp__butler__echo', input: { text: 'a' } } }]),
    anthropicStep([{ text: 'fin' }]),
  ]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f, tools: ['ToolSearch'], mcpServers: { butler: butlerServer([]) } } });
  p.push(userMsg('x'));
  await take(q, isResult);
  const thinking = (i) => f.calls[i].body.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((b) => b.type === 'thinking').map((b) => b.thinking);
  assert.deepEqual(thinking(1), []);          // 工具清单变了: 'hmm' 丢掉
  assert.deepEqual(thinking(2), ['again']);   // 清单没再变: 'again' 照常回放
  p.close(); await q.return();
});

test('allowedTools 名单外的工具模型看不见', async () => {
  const f = fakeFetch([anthropicStep([{ text: 'a' }])]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f, allowedTools: ['mcp__butler__echo'], mcpServers: { butler: butlerServer([]) } } });
  p.push(userMsg('x'));
  await take(q, isResult);
  assert.deepEqual(f.calls[0].body.tools.map((t) => t.name), ['mcp__butler__echo']);
  p.close(); await q.return();
});

test('给了 tools 时内置工具不受 allowedTools 收紧(同 CC: 白名单外的 Agent 照样可用)', async () => {
  const f = fakeFetch([anthropicStep([{ text: 'a' }])]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f, tools: ['Agent'], allowedTools: ['mcp__butler__echo'], mcpServers: { butler: butlerServer([]) } } });
  p.push(userMsg('x'));
  await take(q, isResult);
  assert.deepEqual(f.calls[0].body.tools.map((t) => t.name).sort(), ['Agent', 'mcp__butler__echo']);
  p.close(); await q.return();
});

test('bypassPermissions 时 allowedTools 不收紧(同 CC)', async () => {
  const f = fakeFetch([anthropicStep([{ text: 'a' }])]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f, permissionMode: 'bypassPermissions', allowedTools: ['mcp__butler__echo'], mcpServers: { butler: butlerServer([]) } } });
  p.push(userMsg('x'));
  await take(q, isResult);
  assert.deepEqual(f.calls[0].body.tools.map((t) => t.name).sort(), ['Agent', 'SendMessage', 'TaskStop', 'mcp__butler__echo', 'mcp__butler__later']);
  p.close(); await q.return();
});

test('5xx 重试并发 api_retry; 401 不重试, result.is_error 且枚举是 authentication_failed', async () => {
  const f = fakeFetch([{ status: 503 }, anthropicStep([{ text: 'recovered' }]), { status: 401 }]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f } });
  p.push(userMsg('a'));
  const m1 = await take(q, isResult);
  const retry = m1.find((m) => m.subtype === 'api_retry');
  assert.equal(retry.error_status, 503);
  assert.equal(retry.error, 'server_error');
  assert.equal(m1.at(-1).result, 'recovered');
  p.push(userMsg('b'));
  const m2 = await take(q, isResult);
  const r2 = m2.find((m) => m.subtype === 'api_retry');
  assert.equal(r2.error, 'authentication_failed');
  assert.equal(m2.at(-1).is_error, true);
  p.close(); await q.return();
});

test('流断开、一个字没出(没有结束块): 按 NoOutputGeneratedError 认成可重试, 重发后只出一份回复', async () => {
  // 只来了 message_start 就断: AI SDK 报 NoOutputGeneratedError(「No output generated…finish chunk」), 11-07 测试 app 实际撞到的就是这种
  const cut = sse([
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], usage: { input_tokens: 1, output_tokens: 1 } } },
  ]);
  const f = fakeFetch([cut, anthropicStep([{ text: '完整回复' }])]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f } });
  p.push(userMsg('a'));
  const m = await take(q, isResult);
  const retry = m.find((x) => x.subtype === 'api_retry');
  assert.ok(retry, '要发 api_retry');
  assert.ok(retry.retry_delay_ms > 0, '断流要真重试(retry_delay_ms > 0), 宿主据此撤掉半截字');
  assert.equal(retry.error_status, null);
  assert.equal(f.calls.length, 2);
  const texts = m.filter((x) => x.type === 'assistant').flatMap((x) => x.message.content.filter((b) => b.type === 'text').map((b) => b.text));
  assert.deepEqual(texts, ['完整回复'], '断掉的那一步不进 assistant 消息');
  assert.equal(m.at(-1).is_error, false);
  assert.equal(m.at(-1).result, '完整回复');
  p.close(); await q.return();
});

test('回复说到一半流断了(finishReason=interrupted): 重发, 半截不进 assistant 消息', async () => {
  const half = sse([
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '收到，这就' } },
  ]);
  const f = fakeFetch([half, anthropicStep([{ text: '定好了。' }])]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f } });
  p.push(userMsg('a'));
  const m = await take(q, isResult);
  const retry = m.find((x) => x.subtype === 'api_retry');
  assert.ok(retry && retry.retry_delay_ms > 0, '要真重发');
  const texts = m.filter((x) => x.type === 'assistant').flatMap((x) => x.message.content.filter((b) => b.type === 'text').map((b) => b.text));
  assert.deepEqual(texts, ['定好了。']);
  assert.equal(m.at(-1).result, '定好了。');
  p.close(); await q.return();
});

test('200 开流后读正文断了(读超时 / 连接被掐): 重发, 不当成请求不合法', async () => {
  // 11-10 老黄 glm-5.3-flash: 流开了 5 分钟没数据被读超时掐断, AI SDK 报 status=200「Failed to process successful response」
  const half = sse([
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '说到一半' } },
  ]);
  const broken = () => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(half)); setTimeout(() => c.error(new TypeError('terminated')), 5); } });
  const f = fakeFetch([broken, anthropicStep([{ text: '完整回复' }])]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f } });
  p.push(userMsg('a'));
  const m = await take(q, isResult);
  const retry = m.find((x) => x.subtype === 'api_retry');
  assert.ok(retry && retry.retry_delay_ms > 0, '要真重试');
  assert.equal(retry.error_status, null, '不报 200');
  assert.equal(f.calls.length, 2);
  assert.equal(m.at(-1).result, '完整回复');
  assert.ok(!m.at(-1).is_error);
  p.close(); await q.return();
});

test('OpenAI 兼容协议没收到结束原因就断: InvalidResponseDataError 按类型判可重试', async () => {
  const { classify, StreamCut } = await import('../dist/errors.js');
  const { InvalidResponseDataError, NoOutputGeneratedError, APICallError } = await import('ai');
  assert.equal(classify(new InvalidResponseDataError({ data: undefined, message: 'Response stream ended without a finish reason.' })).retryable, true);
  assert.equal(classify(new NoOutputGeneratedError()).retryable, true);
  assert.equal(classify(new StreamCut('x')).retryable, true);
  // 开流后读正文断了: AI SDK 包成 statusCode=200 的 APICallError(provider-utils wrapResponseBodyStream)
  const body = Object.assign(new Error('Body Timeout Error'), { code: 'UND_ERR_BODY_TIMEOUT' });
  const mid = new APICallError({ message: 'Failed to process successful response', url: 'u', requestBodyValues: {}, statusCode: 200, cause: Object.assign(new TypeError('terminated'), { cause: body }) });
  const c = classify(mid);
  assert.equal(c.retryable, true, '200 读到一半断 = 断流, 重发');
  assert.notEqual(c.kind, 'invalid_request');
  assert.equal(c.status, null, '开流时那个 200 不当这次错误的状态');
  assert.match(c.message, /broke off midway \(UND_ERR_BODY_TIMEOUT: Body Timeout Error\)/, '底层原因带进消息');
  assert.equal(classify(new Error('No output generated. The model stream ended without a finish chunk.')).retryable, false, '只看类型: 普通 Error 带同样的字也不算');
});

test('报错消息带 error 字段(同官方 SDK), 正常回复不带', async () => {
  const f = fakeFetch([{ status: 401 }, anthropicStep([{ text: 'ok' }])]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f } });
  p.push(userMsg('a'));
  const m1 = await take(q, isResult);
  assert.equal(m1.find((x) => x.type === 'assistant').error, 'authentication_failed');
  p.push(userMsg('b'));
  const m2 = await take(q, isResult);
  assert.equal(m2.find((x) => x.type === 'assistant').error, undefined);
  p.close(); await q.return();
});

test('interrupt(): 当前轮以 error_during_execution 收尾, 会话不死, 下一条照常答', async () => {
  const f = fakeFetch([{ hang: true }, anthropicStep([{ text: 'after' }])]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f } });
  p.push(userMsg('slow'));
  const pending = take(q, isResult);
  await new Promise((r) => setTimeout(r, 100));
  await q.interrupt();
  const m1 = await pending;
  assert.equal(m1.at(-1).subtype, 'error_during_execution');
  p.push(userMsg('again'));
  const m2 = await take(q, isResult);
  assert.equal(m2.at(-1).result, 'after');
  p.close(); await q.return();
});

test('软插话: 工具执行期间到的消息并进下一步, 并回发 replay', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const srv = createSdkMcpServer({ name: 'butler', tools: [
    tool('wait', 'waits', { x: z.string() }, async () => { await gate; return { content: [{ type: 'text', text: 'waited' }] }; }, { alwaysLoad: true }),
  ] });
  const f = fakeFetch([anthropicStep([{ tool: { id: 'w', name: 'mcp__butler__wait', input: { x: '1' } } }]), anthropicStep([{ text: 'saw it' }])]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f, extraArgs: { 'replay-user-messages': null }, mcpServers: { butler: srv } } });
  p.push(userMsg('first', 'U1'));
  const pending = take(q, isResult);
  await new Promise((r) => setTimeout(r, 100));
  p.push(userMsg('INTERJECT', 'U2'));
  await new Promise((r) => setTimeout(r, 50));
  release();
  const msgs = await pending;
  const replays = msgs.filter((m) => m.isReplay).map((m) => m.uuid);
  assert.deepEqual(replays, ['U1', 'U2']);
  assert.match(JSON.stringify(f.calls[1].body.messages), /INTERJECT/);
  assert.equal(msgs.filter(isResult).length, 1);
  p.close(); await q.return();
});

test('没配 key: 每轮都报 authentication_failed 而不是卡住', async () => {
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' } } });
  p.push(userMsg('a'));
  const msgs = await take(q, isResult);
  assert.equal(msgs.find((m) => m.subtype === 'api_retry').error, 'authentication_failed');
  assert.equal(msgs.at(-1).is_error, true);
  p.close(); await q.return();
});
