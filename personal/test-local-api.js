// test-local-api.js — Local Poke API 冒烟: 起服务 → 打 8 种请求 → 断言协议行为
// 不起 Electron: LocalApiServer 是纯 http 层, onPoke 用桩替代 (投递链路由 main.js 那 5 步负责, 已与 peerTalk 同构)
const assert = require('assert');
const http = require('http');
const { LocalApiServer } = require('./plugins/local-api');

const PORT = 18787;   // 避开真实 8787, 免撞用户在跑的实例
const poked = [];

const srv = new LocalApiServer({ enabled: true, port: PORT }, () => {}, async ({ persona, text, from }) => {
  if (persona === '不存在的人') return { ok: false, code: 404, error: '未找到人格 ' + persona };
  poked.push({ persona, text, from });
  return { ok: true, persona, delivered: true, was_opened: false };
});

function post(path_, body, raw) {
  return new Promise((resolve) => {
    const data = raw !== undefined ? raw : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: path_, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(out); } catch (_) {} resolve({ code: res.statusCode, json: j }); });
    });
    req.on('error', (e) => resolve({ code: 0, error: e.message }));
    req.end(data);
  });
}
function get(path_) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PORT, path: path_ }, (res) => {
      res.resume();
      res.on('end', () => resolve({ code: res.statusCode }));
    }).on('error', (e) => resolve({ code: 0, error: e.message }));
  });
}

(async () => {
  const r0 = srv.start();
  assert.ok(r0.ok, '服务应启动');
  await new Promise((r) => setTimeout(r, 150));

  // 1. 正常投递
  const r1 = await post('/v1/poke', { persona: '码上飞', text: '3100 端口没了', from: 'watchdog.py' });
  assert.strictEqual(r1.code, 200);
  assert.strictEqual(r1.json.ok, true);
  assert.strictEqual(r1.json.delivered, true);
  assert.strictEqual(poked.length, 1, 'onPoke 应被调用一次');
  assert.strictEqual(poked[0].text, '3100 端口没了');
  console.log('✅ 1 正常投递 → 200 + onPoke 调用');

  // 2. from 缺省
  await post('/v1/poke', { persona: '码上飞', text: 'hi' });
  assert.strictEqual(poked[1].from, '外部程序', 'from 缺省应兜底');
  console.log('✅ 2 from 缺省兜底「外部程序」');

  // 3/4. 参数校验
  const r3 = await post('/v1/poke', { text: '没写给谁' });
  assert.strictEqual(r3.code, 400);
  const r4 = await post('/v1/poke', { persona: '码上飞' });
  assert.strictEqual(r4.code, 400);
  console.log('✅ 3/4 缺 persona / 缺 text → 400');

  // 5. 未知人格 → 404 (onPoke 桩返回的 code 要如实透传)
  const r5 = await post('/v1/poke', { persona: '不存在的人', text: 'hi' });
  assert.strictEqual(r5.code, 404);
  assert.ok(/未找到人格/.test(r5.json.error));
  console.log('✅ 5 未知人格 → 404');

  // 6. 幂等去重: 同 key 第二次不再投递
  const before = poked.length;
  await post('/v1/poke', { persona: '码上飞', text: '重试消息', idempotency_key: 'k-1' });
  const r6 = await post('/v1/poke', { persona: '码上飞', text: '重试消息', idempotency_key: 'k-1' });
  assert.strictEqual(poked.length, before + 1, '同 key 只应投递一次');
  assert.strictEqual(r6.json.deduped, true);
  assert.strictEqual(r6.json.delivered, false);
  console.log('✅ 6 idempotency_key 去重 → 只投一次');

  // 7. 坏 JSON / 走错路由 / 走错方法
  const r7 = await post('/v1/poke', null, '{不是json');
  assert.strictEqual(r7.code, 400);
  const r7b = await post('/v1/nope', { persona: 'x', text: 'y' });
  assert.strictEqual(r7b.code, 404);
  const r7c = await get('/v1/poke');
  assert.strictEqual(r7c.code, 404);
  console.log('✅ 7 坏 JSON→400 · 错路由/错方法→404');

  // 8. 正文超限 → 413 (防本机脚本一次灌爆)
  const r8 = await post('/v1/poke', { persona: '码上飞', text: 'x'.repeat(70 * 1024) });
  assert.strictEqual(r8.code, 413);
  console.log('✅ 8 超 64KB 正文 → 413');

  srv.stop();
  await new Promise((r) => setTimeout(r, 100));
  // 9. 停了就真停了 (端口应拒连)
  const r9 = await post('/v1/poke', { persona: '码上飞', text: 'hi' });
  assert.strictEqual(r9.code, 0, 'stop 后应连不上');
  console.log('✅ 9 stop() 后端口关闭');

  console.log('\n🎉 test-local-api 全绿 (9/9)');
  process.exit(0);
})().catch((e) => { console.error('❌ 失败:', e && (e.stack || e.message)); srv.stop(); process.exit(1); });
