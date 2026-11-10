// DeepSeek 同一步既调本地工具又用服务端搜索时, 回传要照流出顺序: tool_use 在服务端块前面(否则 400)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolUseBeforeServerBlocks, withStreamToolOrder } from '../dist/providers/tool-order.js';

const th = { type: 'thinking', thinking: 't', signature: 's' };
const tu = { type: 'tool_use', id: 'c1', name: 'sys', input: {} };
const su = { type: 'server_tool_use', id: 'w1', name: 'web_search', input: {} };
const sr = { type: 'web_search_tool_result', tool_use_id: 'w1', content: [] };
const types = (c) => c.map((b) => b.type).join(',');

test('AI SDK 挪到最后的 tool_use 放回服务端块前面', () => {
  assert.equal(types(toolUseBeforeServerBlocks([th, su, sr, tu])), 'thinking,tool_use,server_tool_use,web_search_tool_result');
});

test('没有服务端块 / 没有 tool_use 时原样不动', () => {
  assert.equal(types(toolUseBeforeServerBlocks([th, tu])), 'thinking,tool_use');
  assert.equal(types(toolUseBeforeServerBlocks([th, su, sr])), 'thinking,server_tool_use,web_search_tool_result');
});

test('fetch 包装只改助手消息里的顺序, 其余照发', async () => {
  let sent;
  const f = withStreamToolOrder(async (_u, init) => { sent = JSON.parse(init.body); return new Response('{}'); });
  const body = { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: [th, su, sr, tu] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'd' }] }] };
  await f('http://x/v1/messages', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(types(sent.messages[1].content), 'thinking,tool_use,server_tool_use,web_search_tool_result');
  assert.equal(sent.messages[0].content, 'q');
  assert.equal(sent.messages[2].content[0].type, 'tool_result');
});
