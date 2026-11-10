// 服务商因为提交内容拒收(超长 / 图片太大): 改掉那一块再发, 被拒的原样内容不留在历史里
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { query, tool, createSdkMcpServer } from '../dist/index.js';
import { anthropicStep, fakeFetch, queue, GATEWAY_ENV } from './helpers.mjs';

const enc = (t) => Buffer.from(t).toString('base64');
const BIG = enc('BIGIMAGEDATA'.repeat(10));
const SMALL = (e) => enc(`SMALL${e}`);
const err = (message, status = 400) => ({ status, body: { type: 'error', error: { type: 'invalid_request_error', message } } });
const imgMsg = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BIG } }] }, parent_tool_use_id: null, uuid: `u-${Math.random()}` });
const textMsg = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, uuid: `u-${Math.random()}` });

// 假钩子: 记下每次缩到多少, 缩完的数据带上长边好断言
function fakeFit(edge = 2048) {
  const h = { fits: [], learned: [], minEdge: 384,
    edge: () => edge,
    fit: (data, mediaType, maxEdge) => { h.fits.push(maxEdge); return maxEdge < 2048 ? { data: SMALL(maxEdge), mediaType: 'image/png', changed: true } : { data, mediaType, changed: false }; },
    learn: (e) => h.learned.push(e) };
  return h;
}

async function take(q) {
  const got = [];
  for (;;) { const { value, done } = await q.next(); if (done) return got; got.push(value); if (value.type === 'result') return got; }
}
const bodyOf = (f, i) => JSON.stringify(f.calls[i].body.messages);

test('classify: 智谱 1261 · 图太大(带像素上限) · 配置类 400 分得开', async () => {
  const { classify } = await import('../dist/errors.js');
  const { APICallError } = await import('ai');
  const e = (message, statusCode = 400) => new APICallError({ message, url: 'u', requestBodyValues: {}, statusCode });
  assert.equal(classify(e('Prompt exceeds max length')).rejected, 'prompt');
  assert.equal(classify(e('prompt is too long: 210000 tokens > 200000 maximum')).rejected, 'prompt');
  assert.equal(classify(e('whatever', 413)).rejected, 'prompt');
  const img = classify(e('messages.0.content.1.image.source.base64: image dimensions exceed max allowed size: 8000 pixels'));
  assert.equal(img.rejected, 'image'); assert.equal(img.limit, 8000);
  assert.equal(classify(e('messages.0.content.1.image.source.base64: image exceeds 5 MB maximum')).rejected, 'image');
  assert.equal(classify(e('model: claude-x not found')).rejected, undefined, '配置错误不当内容问题');
  assert.equal(classify(e('Prompt exceeds max length')).kind, 'invalid_request', '枚举照旧, 宿主那边不变');
});

test('图太大: 缩一级再发, 说明给模型, 记下能过的尺寸; 原图不再出现', async () => {
  const h = fakeFit();
  const f = fakeFetch([err('image exceeds 5 MB maximum'), anthropicStep([{ text: '看到了' }]), anthropicStep([{ text: '好' }])]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f, imageFit: h } });
  p.push(imgMsg('看图'));
  const m = await take(q);
  assert.equal(m.at(-1).result, '看到了'); assert.ok(!m.at(-1).is_error);
  const r = m.find((x) => x.subtype === 'api_retry');
  assert.equal(r.rejected, 'image'); assert.ok(r.retry_delay_ms > 0, '告诉宿主要重发');
  assert.ok(bodyOf(f, 0).includes(BIG));
  assert.ok(bodyOf(f, 1).includes(SMALL(1024)) && !bodyOf(f, 1).includes(BIG), '第二次发的是缩过的');
  assert.match(bodyOf(f, 1), /provider rejected the previous request \(image too large\)/);
  assert.deepEqual(h.learned, [1024]);
  p.push(textMsg('下一句'));
  await take(q);
  assert.ok(!bodyOf(f, 2).includes(BIG), '下一轮也不带原图');
  p.close(); await q.return();
});

test('图太大缩两级还不行: 第三次换成文字说明; 再被拒就报错收尾, 下一轮不带原图', async () => {
  const h = fakeFit();
  const f = fakeFetch([err('image exceeds 5 MB maximum'), err('image exceeds 5 MB maximum'), err('image exceeds 5 MB maximum'), err('image exceeds 5 MB maximum'), anthropicStep([{ text: '好' }])]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f, imageFit: h } });
  p.push(imgMsg('看图'));
  const m = await take(q);
  assert.equal(f.calls.length, 4, '三次改了再发, 之后不再试');
  assert.ok(bodyOf(f, 2).includes(SMALL(512)));
  assert.ok(bodyOf(f, 3).includes('exceeded the provider') && !bodyOf(f, 3).includes(SMALL(512)), '第三次是文字说明');
  assert.equal(m.at(-1).is_error, true);
  const last = m.filter((x) => x.subtype === 'api_retry').at(-1);
  assert.equal(last.rejected, 'image'); assert.equal(last.retry_delay_ms, 0);
  assert.deepEqual(h.learned, [], '没发成功就不记');
  p.push(textMsg('下一句'));
  await take(q);
  assert.ok(!bodyOf(f, 4).includes(BIG) && !bodyOf(f, 4).includes(SMALL(512)));
  p.close(); await q.return();
});

test('超长: 新内容里最长的那段截成首尾再发; 没有可截的就报错交给宿主', async () => {
  const long = 'A'.repeat(15_000) + 'MIDDLE' + 'Z'.repeat(15_000);
  const f = fakeFetch([err('Prompt exceeds max length'), anthropicStep([{ text: '收到' }]), err('Prompt exceeds max length')]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f } });
  p.push(textMsg(long));
  const m = await take(q);
  assert.equal(m.at(-1).result, '收到');
  assert.ok(!bodyOf(f, 1).includes('MIDDLE') && bodyOf(f, 1).includes('characters cut'), '截掉中间');
  p.push(textMsg('短的一句'));
  const m2 = await take(q);
  assert.equal(f.calls.length, 3, '没有够长的可截, 不再试');
  assert.equal(m2.at(-1).is_error, true);
  assert.equal(m2.filter((x) => x.subtype === 'api_retry').at(-1).rejected, 'prompt', '宿主据此压缩重发');
  p.close(); await q.return();
});

test('配置类 400 照旧不重发', async () => {
  const f = fakeFetch([err('model: claude-x not found')]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f, imageFit: fakeFit() } });
  p.push(imgMsg('看图'));
  const m = await take(q);
  assert.equal(f.calls.length, 1);
  assert.equal(m.at(-1).is_error, true);
  assert.equal(m.find((x) => x.subtype === 'api_retry').rejected, undefined);
  p.close(); await q.return();
});

test('工具读进来的图: 发之前就缩到钩子给的尺寸; 被拒再往下缩', async () => {
  const h = fakeFit(1568);
  const srv = createSdkMcpServer({ name: 'butler', version: '0.0.1', tools: [
    tool('shot', 'screenshot', { n: z.number().optional() }, async () => ({ content: [{ type: 'image', data: BIG, mimeType: 'image/png' }] }), { alwaysLoad: true }),
  ] });
  const f = fakeFetch([
    anthropicStep([{ tool: { id: 'tu1', name: 'mcp__butler__shot', input: {} } }]),
    err('image exceeds 5 MB maximum'),
    anthropicStep([{ text: '截图看了' }]),
  ]);
  const p = queue();
  const q = query({ prompt: p, options: { model: 'm', env: GATEWAY_ENV, fetch: f, imageFit: h, mcpServers: { butler: srv } } });
  p.push(textMsg('截个图'));
  const m = await take(q);
  assert.equal(m.at(-1).result, '截图看了');
  assert.ok(bodyOf(f, 1).includes(SMALL(1568)) && !bodyOf(f, 1).includes(BIG), '发之前已缩到 1568');
  assert.ok(bodyOf(f, 2).includes(SMALL(784)), '被拒后缩一半');
  assert.deepEqual(h.learned, [784]);
  p.close(); await q.return();
});
