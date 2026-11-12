// 发出去的请求里不许有半个 emoji: 工具返回被截断时留下的孤立代理项, 发请求前删掉(DeepSeek 400 / 智谱 500)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { query, tool, createSdkMcpServer } from '../dist/index.js';
import { dropLoneSurrogates, wellFormedBody, head, tail } from '../dist/providers/well-formed.js';
import { anthropicStep, fakeFetch, userMsg, queue, GATEWAY_ENV } from './helpers.mjs';

const HIGH = '😀'.slice(0, 1), LOW = '😀'.slice(1);
const LONE_ESC = /(?<!\\)(?:\\\\)*\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i;

test('删掉孤立的前半个、后半个, 完整 emoji 和普通文字不动', () => {
  assert.equal(dropLoneSurrogates(`特价${HIGH}后面`), '特价后面');
  assert.equal(dropLoneSurrogates(`${LOW}开头`), '开头');
  assert.equal(dropLoneSurrogates(`结尾${HIGH}`), '结尾');
  assert.equal(dropLoneSurrogates('正常 😀 👍🏻 文字'), '正常 😀 👍🏻 文字');
});

test('head / tail 截文字不切开 emoji', () => {
  assert.equal(head('ab😀cd', 3), 'ab');
  assert.equal(head('ab😀cd', 4), 'ab😀');
  assert.equal(tail('ab😀cd', 3), 'cd');
  assert.equal(tail('ab😀cd', 4), '😀cd');
  assert.equal(tail('ab', 0), '');
});

test('请求体: 有坏字符才重写, 干净的原样返回同一个字符串', () => {
  const clean = JSON.stringify({ messages: [{ content: '正常 😀 写着 \\ud83d 字样' }] });
  assert.equal(wellFormedBody(clean), clean);
  const bad = JSON.stringify({ messages: [{ content: [{ type: 'tool_result', content: `截断${HIGH}` }] }] });
  assert.match(bad, /\\ud83d/);
  const out = wellFormedBody(bad);
  assert.doesNotMatch(out, LONE_ESC);
  assert.equal(JSON.parse(out).messages[0].content[0].content, '截断');
  assert.equal(wellFormedBody('not json \\ud83d'), 'not json \\ud83d');
});

for (const model of ['deepseek-v4-flash', 'claude-haiku-4-5']) {
  test(`${model}: 工具返回带半个 emoji, 下一步请求体里没有它`, async () => {
    const raw = [];
    const step = (s) => (_b, init) => { raw.push(init.body); return s; };
    const f = fakeFetch([
      step(anthropicStep([{ tool: { id: 't1', name: 'mcp__butler__chat_log', input: {} } }])),
      step(anthropicStep([{ text: '好了' }])),
    ]);
    const server = createSdkMcpServer({ name: 'butler', version: '0.0.1', tools: [
      tool('chat_log', 'history', {}, async () => ({ content: [{ type: 'text', text: `老板说今天特价${HIGH}` }] }), { alwaysLoad: true }),
    ] });
    const p = queue();
    const q = query({ prompt: p, options: { model, env: GATEWAY_ENV, fetch: f, systemPrompt: 'SYS', mcpServers: { butler: server } } });
    p.push(userMsg(`hi ${LOW}`));
    let result;
    for await (const m of q) if (m.type === 'result') { result = m; break; }
    q.close?.();
    assert.equal(result.result, '好了');
    assert.equal(raw.length, 2);
    for (const b of raw) assert.doesNotMatch(b, LONE_ESC);
    assert.match(raw[1], /老板说今天特价/);
  });
}
