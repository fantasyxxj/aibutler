// 同一步里相邻的只读调用一起跑、写操作守顺序; 子代理可以换模型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../dist/index.js';
import { anthropicStep, fakeFetch, userMsg, queue, GATEWAY_ENV } from './helpers.mjs';

async function untilResult(q) {
  const got = [];
  for (;;) { const { value, done } = await q.next(); if (done) return got; got.push(value); if (value.type === 'result') return got; }
}

// 假的内置工具: 每次跑 60ms, 记下起止时刻
function timed(name, log) {
  return {
    name, description: name, inputSchema: { type: 'object', properties: { k: { type: 'string' } } },
    async run(input) {
      const t0 = Date.now();
      await new Promise((r) => setTimeout(r, 60));
      log.push({ name, k: input.k, t0, t1: Date.now() });
      return { content: [{ type: 'text', text: `${name}:${input.k}` }] };
    },
  };
}

test('并发: 相邻的 Read 一起跑, 中间的 Write 等前面跑完、后面的等它跑完; 结果按原顺序回填', async () => {
  const log = [];
  const call = (id, name, k) => ({ tool: { id, name, input: { k } } });
  const f = fakeFetch([
    anthropicStep([call('r1', 'Read', 'a'), call('r2', 'Read', 'b'), call('r3', 'Read', 'c'), call('w1', 'Write', 'd'), call('r4', 'Read', 'e')]),
    anthropicStep([{ text: 'ok' }]),
  ]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f, systemPrompt: 'S', tools: ['Read', 'Write'],
    builtinTools: [timed('Read', log), timed('Write', log)] } });
  p.push(userMsg('go'));
  await untilResult(q);
  const at = (k) => log.find((x) => x.k === k);
  const firstThree = ['a', 'b', 'c'].map(at);
  assert.ok(Math.max(...firstThree.map((x) => x.t0)) < Math.min(...firstThree.map((x) => x.t1)), '三个 Read 时间上有重叠 = 一起跑');
  assert.ok(at('d').t0 >= Math.max(...firstThree.map((x) => x.t1)), 'Write 等三个 Read 都跑完才开始');
  assert.ok(at('e').t0 >= at('d').t1, 'Write 之后的 Read 等 Write 跑完');
  const results = f.calls[1].body.messages.at(-1).content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
  assert.deepEqual(results, ['r1', 'r2', 'r3', 'w1', 'r4'], '工具结果按原调用顺序回填');
  p.close(); await q.return();
});

test('Agent: model=haiku → 子代理那一步请求的是 haiku; 不给 model 沿用主模型', async () => {
  const f = fakeFetch([
    anthropicStep([{ tool: { id: 'ag1', name: 'Agent', input: { description: 'find', prompt: 'p1', model: 'haiku' } } }]),
    anthropicStep([{ text: 'R1' }]),
    anthropicStep([{ tool: { id: 'ag2', name: 'Agent', input: { description: 'find', prompt: 'p2' } } }]),
    anthropicStep([{ text: 'R2' }]),
    anthropicStep([{ text: 'done' }]),
  ]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'claude-opus-5-5', env: GATEWAY_ENV, fetch: f, systemPrompt: 'S', tools: ['Agent'] } });
  p.push(userMsg('go'));
  await untilResult(q);
  assert.equal(f.calls[0].body.model, 'claude-opus-5-5');
  assert.equal(f.calls[1].body.model, 'claude-haiku-4-5', '子代理换成 haiku');
  assert.equal(f.calls[3].body.model, 'claude-opus-5-5', '不给 model 就跟主代理一样');
  p.close(); await q.return();
});

test('Agent: 宿主 env 给了 ANTHROPIC_DEFAULT_HAIKU_MODEL 就用网关自己的型号名', async () => {
  const f = fakeFetch([
    anthropicStep([{ tool: { id: 'ag', name: 'Agent', input: { description: 'find', prompt: 'p', model: 'haiku' } } }]),
    anthropicStep([{ text: 'R' }]),
    anthropicStep([{ text: 'done' }]),
  ]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'claude-opus-5-5', env: { ...GATEWAY_ENV, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gw-haiku' }, fetch: f, systemPrompt: 'S', tools: ['Agent'] } });
  p.push(userMsg('go'));
  await untilResult(q);
  assert.equal(f.calls[1].body.model, 'gw-haiku');
  p.close(); await q.return();
});

test('Agent: 宿主给的三档表优先(别家协议也能换), cheap 与 haiku 同义', async () => {
  const f = fakeFetch([
    anthropicStep([{ tool: { id: 'ag', name: 'Agent', input: { description: 'find', prompt: 'p', model: 'cheap' } } }]),
    anthropicStep([{ text: 'R' }]),
    anthropicStep([{ tool: { id: 'ag2', name: 'Agent', input: { description: 'find', prompt: 'p', model: 'haiku' } } }]),
    anthropicStep([{ text: 'R2' }]),
    anthropicStep([{ text: 'done' }]),
  ]);
  const p = queue();
  const env = { ...GATEWAY_ENV, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-opus-5-5', BUTLER_SUBAGENT_MODELS: JSON.stringify({ cheap: 'gw-cheap-1' }) };
  const q = query({ prompt: p, options: { model: 'claude-opus-5-5', env, fetch: f, systemPrompt: 'S', tools: ['Agent'] } });
  p.push(userMsg('go'));
  await untilResult(q);
  assert.equal(f.calls[1].body.model, 'gw-cheap-1', '三档表压过 ANTHROPIC_DEFAULT_HAIKU_MODEL');
  assert.equal(f.calls[3].body.model, 'gw-cheap-1', 'haiku = cheap');
  p.close(); await q.return();
});
