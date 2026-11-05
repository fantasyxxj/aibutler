// 真模型冒烟: 读 /tmp/gw.env 的网关, 用 butler 式的工具跑一轮(工具调用 + 中文 + 软插话不涉及)。
// 用法: node scripts/live-smoke.mjs [model]
import * as fs from 'node:fs';
import { z } from 'zod';
import { query, tool, createSdkMcpServer } from '../dist/index.js';
const kv = Object.fromEntries(fs.readFileSync(process.env.GW_ENV || '/tmp/gw.env', 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
// model 写成 compat/<id> 时走 OpenAI 兼容协议: GATEWAY_BASE_URL 后面补 /v1
const env = (process.argv[2] || '').startsWith('compat/')
  ? { OPENAI_BASE_URL: `${kv.GATEWAY_BASE_URL.replace(/\/+$/, '')}/v1`, OPENAI_API_KEY: kv.GATEWAY_TOKEN }
  : { ANTHROPIC_BASE_URL: kv.GATEWAY_BASE_URL, ANTHROPIC_AUTH_TOKEN: kv.GATEWAY_TOKEN, ANTHROPIC_API_KEY: kv.GATEWAY_TOKEN };
const model = process.argv[2] || 'deepseek-v4-flash';
const srv = createSdkMcpServer({ name: 'butler', tools: [
  tool('sys', 'System utilities. op="date" returns today\'s date and weekday.', { op: z.string().describe('date') }, async ({ op }) => ({ content: [{ type: 'text', text: op === 'date' ? '2026-11-03 Tuesday' : 'unknown op' }] }), { alwaysLoad: true }),
  tool('memory_upsert', 'Save one fact to memory.', { id: z.string(), claim: z.string() }, async (a) => { console.log('  >> memory_upsert', JSON.stringify(a)); return { content: [{ type: 'text', text: 'saved' }] }; }),
] });
let q0 = []; let waiter;
const prompt = { [Symbol.asyncIterator]() { return { next: () => q0.length ? Promise.resolve({ value: q0.shift(), done: false }) : new Promise((r) => { waiter = r; }) }; } };
const push = (t) => { const m = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: t }] }, uuid: `u${Date.now()}` }; if (waiter) { const w = waiter; waiter = null; w({ value: m, done: false }); } else q0.push(m); };
const q = query({ prompt, options: { model, env, systemPrompt: '你是店铺助手「小飞」。用简体中文回答。需要日期就调 mcp__butler__sys。店主告诉你的事实要先用 memory_upsert 存下(它是延迟工具, 先用 ToolSearch 取)。', tools: ['ToolSearch'], includePartialMessages: true, extraArgs: { 'replay-user-messages': null }, mcpServers: { butler: srv } } });
push('今天星期几？另外记一下：每周三店休。');
let text = '';
for await (const m of q) {
  if (m.type === 'stream_event' && m.event.delta?.type === 'text_delta') { process.stdout.write(m.event.delta.text); text += m.event.delta.text; }
  if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'tool_use') console.log(`\n  [tool] ${b.name} ${JSON.stringify(b.input)}  usage=${JSON.stringify(m.message.usage)}`);
  if (m.type === 'system' && m.subtype === 'api_retry') console.log('\n  [api_retry]', m.error_status, m.error);
  if (m.type === 'result') { console.log(`\n[result] ${m.subtype} is_error=${m.is_error} steps=${m.num_turns} ${m.duration_ms}ms usage=${JSON.stringify(m.usage)}`); break; }
}
process.exit(0);
