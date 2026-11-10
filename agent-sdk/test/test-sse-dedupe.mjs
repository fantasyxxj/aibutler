// 网关在一条流开头连发多个 message_start(gptproto 实测): 与 Claude Code CLI 一致, 只认最后一个接着答。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../dist/index.js';
import { dedupeMessageStart } from '../dist/providers/sse-dedupe.js';
import { anthropicStep, fakeFetch, userMsg, queue, GATEWAY_ENV } from './helpers.mjs';

const start = (id) => `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'x', content: [], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`;

async function readAll(stream) {
  const dec = new TextDecoder(); let s = '';
  for await (const c of stream) s += dec.decode(c, { stream: true });
  return s;
}

function chunked(text, size) {
  const enc = new TextEncoder().encode(text);
  return new ReadableStream({ start(ctl) { for (let i = 0; i < enc.length; i += size) ctl.enqueue(enc.slice(i, i + size)); ctl.close(); } });
}

test('开头连发三个 message_start: 只留最后一个, 其余事件原样保留(按 7 字节切块也对)', async () => {
  const body = start('a') + start('b') + anthropicStep([{ text: 'ok' }]).replace('"id":"m"', '"id":"c"');
  const out = await readAll(dedupeMessageStart(chunked(body, 7)));
  assert.equal((out.match(/event: message_start/g) || []).length, 1);
  assert.ok(out.includes('"id":"c"'));
  assert.ok(out.includes('"text":"ok"'));
  assert.ok(out.trimEnd().endsWith('data: {"type":"message_stop"}'));
});

test('正常的流一字不改', async () => {
  const body = anthropicStep([{ text: 'hello' }]);
  assert.equal(await readAll(dedupeMessageStart(chunked(body, 5))), body);
});

test('整轮: 网关连发 message_start 时照常答出, 不判断流', async () => {
  const dup = start('a') + start('b') + anthropicStep([{ text: '答出来了' }]);
  const f = fakeFetch([dup]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'claude-haiku-4-5', env: GATEWAY_ENV, fetch: f, systemPrompt: 'SYS' } });
  p.push(userMsg('hi'));
  let result;
  for await (const m of q) { if (m.type === 'result') { result = m; break; } }
  q.close?.();
  assert.equal(result.is_error, false);
  assert.equal(result.result, '答出来了');
  assert.equal(f.calls.length, 1);
});
