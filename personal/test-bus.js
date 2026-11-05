// test-bus.js — core/bus.js: 跟服务端说话的唯一一份客户端。
// 跑法: node test-bus.js
//
// 取代了原 test-agent-bus-send.js(那时 buildSend/interpretSend 是 plugins 下的纯函数)。
// 现在拼装与解析都在 BusEndpoint 里, 所以起一个真 HTTP server 测**真实发出去的东西** ——
// 比测纯函数更靠谱: 协议错在 header 或 URL 上时, 纯函数测试是发现不了的。
const assert = require('assert');
const http = require('http');
const { BusEndpoint, BusRegistry, BusPoller } = require('../core/bus');

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { console.log('  ✓', name); pass++; })
  .catch((e) => { console.log('  ✗', name, '—', e.message); fail++; });

// 收下每一次请求, 让断言能看见真正发出去的 method/url/headers/body
const got = [];
let reply = { status: 200, body: {} };
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    got.push({ method: req.method, url: req.url, headers: req.headers,
               body: body ? JSON.parse(body) : null });
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
});

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const v1 = new BusEndpoint({ id: 'biz', kind: 'v1', base_url: base, token: 'T1' });
  const bh = new BusEndpoint({ id: 'hub', kind: 'bothub', base_url: base + '/api/v1/agent-bus', token: 'T2', agent: 'me' });
  const last = () => got[got.length - 1];

  console.log('\n[1] exec 信封 (v1): 平台只开一个口子时, 真实调用包在 content 里');
  reply = { status: 200, body: { result: { rows: 3 } } };
  await ok('打 /bus/v1/agent/exec, body 是 {command, content, correlation_id}', async () => {
    const r = await v1.exec({ command: 'apicall', content: { method: 'GET', path: '/bus/v1/store' } });
    assert.equal(last().url, '/bus/v1/agent/exec');
    assert.equal(last().body.command, 'apicall');
    assert.deepEqual(last().body.content, { method: 'GET', path: '/bus/v1/store' });
    assert.equal(last().body.correlation_id, null);
    assert.ok(r.ok);
  });
  await ok('信封只是运输壳, 交给上层的是里面的 result', async () => {
    const r = await v1.exec({ command: 'apicall', content: {} });
    assert.equal(r.text, JSON.stringify({ rows: 3 }));
  });
  await ok('带 Bearer 与 Idempotency-Key, 且键长不超过平台硬限 36', async () => {
    await v1.exec({ command: 'apicall', content: {} });
    assert.equal(last().headers.authorization, 'Bearer T1');
    assert.ok(last().headers['idempotency-key'].length <= 36);
  });
  await ok('🔴 同一个 correlation_id 派生同一把幂等键(重试才认得出是同一次)', async () => {
    await v1.exec({ command: 'apicall', content: {}, correlationId: 'job-7' });
    const k1 = last().headers['idempotency-key'];
    await v1.exec({ command: 'apicall', content: {}, correlationId: 'job-7' });
    assert.equal(last().headers['idempotency-key'], k1);
    await v1.exec({ command: 'apicall', content: {} });
    assert.notEqual(last().headers['idempotency-key'], k1, '不传 correlation_id 就该每次一把新的');
  });

  console.log('\n[2] call 裸 REST (v1): GET 走 query, 其余走 body');
  reply = { status: 200, body: { ok: true } };
  await ok('GET 把参数拼进 query', async () => {
    await v1.call({ method: 'GET', path: '/bus/v1/reservations', query: { date: '2026-08-24' } });
    assert.equal(last().url, '/bus/v1/reservations?date=2026-08-24');
    assert.equal(last().body, null);
  });
  await ok('POST 把参数放 body, 要幂等才带 Idempotency-Key', async () => {
    await v1.call({ method: 'POST', path: '/bus/v1/line/send', body: { to: 'U1', text: 'hi' }, idempotency: true });
    assert.deepEqual(last().body, { to: 'U1', text: 'hi' });
    assert.ok(last().headers['idempotency-key']);
  });
  await ok('不要幂等就不带那个 header(别让平台白记一笔)', async () => {
    await v1.call({ method: 'POST', path: '/x', body: {} });
    assert.equal(last().headers['idempotency-key'], undefined);
  });

  console.log('\n[3] 平台拒绝: code 要保持机器可读(界面靠它分语言, 不能糊成一句话)');
  reply = { status: 409, body: { detail: { code: 'seat_conflict', message: '満席になりました', capacity_remaining: 0 } } };
  await ok('detail.code / message / 附加字段都留在 detail 里', async () => {
    const r = await v1.call({ method: 'GET', path: '/x' });
    assert.equal(r.ok, false);
    assert.equal(r.detail.code, 'seat_conflict');
    assert.equal(r.detail.capacity_remaining, 0);
    assert.ok(r.error.includes('seat_conflict'), '给 AI 的那句话里也要有 code');
  });
  reply = { status: 422, body: { detail: { code: 'validation_failed', errors: [{ loc: ['body', 'dow'], msg: 'field required' }] } } };
  await ok('422 要指出是哪个字段错了(只说"校验失败"会让对方原样再发一次)', async () => {
    const r = await v1.call({ method: 'POST', path: '/x', body: {} });
    assert.equal(r.detail.fields[0].at, 'body.dow');
    assert.ok(r.error.includes('dow'));
  });

  console.log('\n[4] bothub 协议: 判成功看 id, 不看 ok');
  reply = { status: 200, body: { ok: true, id: 5 } };
  await ok('POST {url}/send, body 是 {from_agent,to_agent,text,payload}', async () => {
    const r = await bh.send({ to: 'baibai', text: 'hi', payload: { kind: 'q' } });
    assert.equal(last().url, '/api/v1/agent-bus/send');
    assert.deepEqual(last().body, { from_agent: 'me', to_agent: 'baibai', text: 'hi', payload: { kind: 'q' } });
    assert.equal(r.text, '✅ 已发 id=5');
  });
  await ok('两头空白要去掉(对面按名字精确匹配)', async () => {
    await bh.send({ to: '  baibai  ', text: ' hi ' });
    assert.equal(last().body.to_agent, 'baibai');
    assert.equal(last().body.text, 'hi');
  });
  reply = { status: 200, body: { ok: true, id: null, dropped: 'silent' } };
  await ok('心跳/ACK 前缀被服务端静默 drop —— 要说出来, 否则看着像发成功了', async () => {
    const r = await bh.send({ to: 'x', text: 'ACK' });
    assert.ok(r.text.includes('静默 drop'));
  });
  reply = { status: 200, body: { ok: true, id: 7, dedup: true } };
  await ok('30 分钟内同 (from,to,text) 会被去重, id 指向原消息', async () => {
    const r = await bh.send({ to: 'x', text: 'hi' });
    assert.ok(r.text.includes('去重') && r.text.includes('7'));
  });
  reply = { status: 400, body: { detail: 'from_agent/to_agent required' } };
  await ok('4xx 带出平台的话', async () => {
    const r = await bh.send({ to: 'x', text: 'hi' });
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('400') && r.error.includes('required'));
  });
  await ok('to / text 空一律不发(省一次必失败的往返)', async () => {
    const n = got.length;
    assert.equal((await bh.send({ to: '', text: 'hi' })).ok, false);
    assert.equal((await bh.send({ to: 'x', text: '  ' })).ok, false);
    assert.equal(got.length, n, '一个请求都不该发出去');
  });
  await ok('缺 agent(本机身份)就发不出去', async () => {
    const noAgent = new BusEndpoint({ kind: 'bothub', base_url: base, token: 'T' });
    assert.equal((await noAgent.send({ to: 'x', text: 'hi' })).ok, false);
  });

  console.log('\n[5] 协议族用错要当场说清, 不能悄悄打到别处');
  await ok('bothub 那条没有 exec', async () => assert.equal((await bh.exec({ command: 'x', content: {} })).ok, false));
  await ok('v1 那条没有 send', async () => assert.equal((await v1.send({ to: 'a', text: 'b' })).ok, false));

  console.log('\n[6] 取件: 两族游标语义不同, 对外统一成 {items, nextCursor}');
  reply = { status: 200, body: { events: [{ seq: 11, type: 'reservation.created', payload: { id: 1 } },
                                          { seq: 12, type: 'admin.config.update', payload: {} }] } };
  await ok('v1 用 seq, 推进到最后一条', async () => {
    const r = await v1.poll({ cursor: 10 });
    assert.equal(last().url.includes('cursor=10'), true);
    assert.equal(r.items.length, 2);
    assert.equal(r.items[0].type, 'reservation.created');
    assert.equal(r.nextCursor, 12);
  });
  reply = { status: 200, body: { messages: [{ id: 3 }, { id: 9 }] } };
  await ok('bothub 用 after_id, 推进到最大 id', async () => {
    const r = await bh.poll({ cursor: 2 });
    assert.ok(last().url.includes('after_id=2'));
    assert.equal(r.nextCursor, 9);
  });
  reply = { status: 200, body: { messages: [{ id: 1 }, { id: 2 }] } };
  await ok('🔴 服务端回吐旧消息也不能倒着走(否则原地死循环)', async () => {
    const r = await bh.poll({ cursor: 5 });
    assert.equal(r.items.length, 0);
    assert.equal(r.nextCursor, 5);
  });
  reply = { status: 401, body: {} };
  await ok('401/403 标成 authFailed —— 调用方该停轮询而不是退避重试', async () => {
    try { await v1.poll({ cursor: 0 }); assert.fail('该抛'); }
    catch (e) { assert.ok(e.authFailed); }
  });

  console.log('\n[7] BusRegistry: 有序, 第一个是默认');
  const reg = new BusRegistry([
    { id: 'business', kind: 'v1', base_url: base, token: 'A' },
    { id: 'admin', kind: 'v1', base_url: base, token: 'B' },
    { id: 'nope' },   // 没 base_url
  ]);
  await ok('没 base_url 的不算一条 bus', () => assert.equal(reg.size, 2));
  await ok('不点名 = 第一条', () => assert.equal(reg.get().id, 'business'));
  await ok('点名取对应那条', () => assert.equal(reg.get('admin').token, 'B'));
  await ok('🔴 点名点错返回 null, 不许兜底发给默认那条(发错地方比报错糟得多)',
           () => assert.equal(reg.get('typo'), null));
  await ok('describe 标出默认那条(AI 要据此决定往哪发)', () => {
    assert.ok(reg.describe().includes('(默认)'));
    assert.ok(reg.describe().includes('admin'));
  });
  await ok('一条都没配时 describe 也要说人话', () => {
    assert.ok(new BusRegistry([]).describe().includes('没有配'));
  });

  // 这台 srv 立刻返回空批, 正是"服务端不 hold"的那种实现。三个 v1 长轮询调用点都没传
  // idleMs, 所以不空转这件事一旦全押在服务端 hold 上, 换个实现就是满速打请求。
  console.log('\n[9] 服务端不 hold 时, 取件循环也不许空转');
  await ok('空批立刻返回 → 一秒内请求数是个位数, 不是几千', async () => {
    reply = { status: 200, body: { events: [] } };
    const before = got.length;
    const poller = new BusPoller({ endpoint: v1, tag: 'idle-test', onItem: () => {} });
    poller.start();
    await new Promise((r) => setTimeout(r, 1200));
    await poller.stop();
    const n = got.length - before;
    assert.ok(n > 0, '循环压根没跑起来的话这条断言等于没测');
    assert.ok(n <= 5, `1.2 秒发了 ${n} 次 —— 空批之后没歇`);
  });

  srv.close();
  console.log(`\n${fail ? '❌' : '✅'} test-bus: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
