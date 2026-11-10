// 模型调工具前常先吐一个只有空白的正文块(「\n\n」)。与 Claude Code CLI 一致: 不进整条 assistant 消息, 也不回放进历史。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { query, tool, createSdkMcpServer } from '../dist/index.js';
import { anthropicStep, fakeFetch, userMsg, queue, GATEWAY_ENV } from './helpers.mjs';

test('空白正文块: 整条消息里没有它, 下一步请求的历史里也没有它', async () => {
  const f = fakeFetch([
    anthropicStep([{ text: '\n\n' }, { tool: { id: 't1', name: 'mcp__butler__echo', input: { text: 'x' } } }]),
    anthropicStep([{ text: '好了' }]),
  ]);
  const server = createSdkMcpServer({ name: 'butler', version: '0.0.1', tools: [
    tool('echo', 'echo back', { text: z.string() }, async ({ text }) => ({ content: [{ type: 'text', text } ] }), { alwaysLoad: true }),
  ] });
  const p = queue();
  const q = query({ prompt: p, options: { model: 'claude-haiku-4-5', env: GATEWAY_ENV, fetch: f, systemPrompt: 'SYS', mcpServers: { butler: server } } });
  p.push(userMsg('hi'));
  const assistants = []; let result;
  for await (const m of q) {
    if (m.type === 'assistant') assistants.push(m);
    if (m.type === 'result') { result = m; break; }
  }
  q.close?.();
  assert.deepEqual(assistants[0].message.content.map((b) => b.type), ['tool_use']);
  assert.equal(result.result, '好了');
  const replayed = f.calls[1].body.messages.find((m) => m.role === 'assistant');
  assert.ok(!replayed.content.some((b) => b.type === 'text' && !b.text.trim()), JSON.stringify(replayed.content));
});
