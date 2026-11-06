// 双向通道回归: 飞书长连接 · 钉钉 Stream · Discord Gateway · Slack Socket Mode。
// 每家起一个本机假平台(HTTP 接口 + WebSocket), 走一遍: 连上 → 心跳 → 收消息交给人格(过滤机器人自己、
// 群里没 @ 的、重投的) → 确认帧 → 发消息打对接口 → 凭据检查 → 致命错误不再重连。不碰真平台。
// 飞书帧的字节对照值是用官方 SDK(@larksuiteoapi/node-sdk 1.76)的 pbbp2.Frame.encode 生成的。
const http = require('http');
const { WebSocketServer } = require('ws');
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

const feishu = require('./channels/feishu');
const dingtalk = require('./channels/dingtalk');
const discord = require('./channels/discord');
const slack = require('./channels/slack');

// 假平台: routes[path] = (body, req) => json; ws 连上调 onWs(sock, path)
async function fakePlatform(routes, onWs) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      let body = {}; try { body = b ? (req.headers['content-type'] || '').includes('json') ? JSON.parse(b) : Object.fromEntries(new URLSearchParams(b)) : {}; } catch (_) {}
      calls.push({ path: u.pathname, query: u.search, headers: req.headers, body });
      const h = routes[u.pathname];
      const out = h ? h(body, req) : { status: 404, j: {} };
      res.statusCode = out.status || 200; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(out.j !== undefined ? out.j : out));
    });
  });
  const wss = new WebSocketServer({ server: srv });
  const socks = [];
  wss.on('connection', (s, req) => { socks.push(s); onWs(s, req.url); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, ws: base.replace('http', 'ws'), calls, socks, close: () => { wss.close(); srv.close(); } };
}

(async () => {
  // ———————————————— 飞书 ————————————————
  const F = feishu._test;
  const golden = '08071094b4e4f4cb03182a20012a0d0a047479706512056576656e742a100a0a6d6573736167655f696412026d312a080a0373756d1201312a080a03736571120130420e7b2261223a22e4bda0e5a5bd227d';
  const gf = { SeqID: 7n, LogID: 123456789012n, service: 42, method: 1, headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'm1' }, { key: 'sum', value: '1' }, { key: 'seq', value: '0' }], payload: Buffer.from('{"a":"你好"}') };
  ok(F.encodeFrame(gf).toString('hex') === golden, '飞书 protobuf 编码跟官方 SDK 逐字节一致');
  ok(F.encodeFrame({ service: -5, method: 0, headers: [{ key: 'type', value: 'ping' }] }).toString('hex') === '0800100018fbffffffffffffffff0120002a0c0a0474797065120470696e67', '负数 service 也一致(10 字节 varint)');
  const d0 = F.decodeFrame(Buffer.from(golden, 'hex'));
  ok(d0.LogID === 123456789012n && d0.service === 42 && d0.headers[1].value === 'm1' && d0.payload.toString() === '{"a":"你好"}', '解码还原每个字段');
  ok(F.textOf({ message_type: 'text', content: '{"text":"@_user_1 帮我查一下"}' }) === '帮我查一下', '去掉 @ 占位符');
  ok(F.idType('ou_x') === 'open_id' && F.idType('oc_x') === 'chat_id', 'ou_ 发给人, oc_ 发给会话');

  const fEvent = (id, text, senderType = 'user') => Buffer.from(JSON.stringify({ schema: '2.0', header: { event_id: id, event_type: 'im.message.receive_v1' }, event: { sender: { sender_id: { open_id: 'ou_ann' }, sender_type: senderType }, message: { message_id: `om_${id}`, chat_id: 'oc_g1', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: `@_user_1 ${text}` }) } } }));
  const fUp = [];   // 客户端发上来的帧
  let fDial = 0;
  const fp = await fakePlatform({
    '/callback/ws/endpoint': (b) => { fDial++; return b.AppSecret === 'good' ? { code: 0, data: { URL: `${fp.ws}/fs?device_id=d&service_id=42`, ClientConfig: { PingInterval: 120 } } } : { code: 403, msg: 'app secret invalid' }; },
    '/open-apis/auth/v3/tenant_access_token/internal': (b) => (b.app_secret === 'good' ? { code: 0, tenant_access_token: 't-1', expire: 7200 } : { code: 10014, msg: 'app secret invalid' }),
    '/open-apis/im/v1/messages': () => ({ code: 0, data: {} }),
  }, (s) => { s.on('message', (m) => fUp.push(F.decodeFrame(m))); });
  const fIn = [];
  const fc = feishu.create({ app_id: 'cli_x', app_secret: 'good', api_base: fp.base }, { log: () => {}, onMessage: (r) => fIn.push(r) });
  fc.start();
  ok(await until(() => fUp.some((f) => f.method === 0 && f.headers[0].value === 'ping')), '飞书: 连上就发 ping 控制帧');
  ok(fUp[0].service === 42, 'ping 带上地址里的 service_id');
  const s1 = fp.socks[0];
  const whole = fEvent('e1', '你好');
  const half = Math.floor(whole.length / 2);
  const frag = (seq, part) => F.encodeFrame({ SeqID: BigInt(seq + 1), LogID: 9n, service: 42, method: 1, headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'mm' }, { key: 'sum', value: '2' }, { key: 'seq', value: String(seq) }], payload: part });
  s1.send(frag(1, whole.subarray(half))); s1.send(frag(0, whole.subarray(0, half)));
  ok(await until(() => fIn.length === 1), '分两片、倒序到达也能拼成一条交给人格');
  ok(fIn[0] && fIn[0].text === '你好' && fIn[0].chat_id === 'oc_g1' && fIn[0].from_id === 'ou_ann', '文本、会话、发送人都对');
  ok(await until(() => fUp.filter((f) => f.method === 1).length === 2), '每个数据帧都回了确认');
  const a1 = fUp.find((f) => f.method === 1);
  ok(a1 && a1.payload.toString() === '{"code":200}' && a1.headers.some((h) => h.key === 'biz_rt') && a1.LogID === 9n, '确认帧原样带回 LogID, payload 是 code 200');
  const one = (id, t, st) => F.encodeFrame({ SeqID: 1n, LogID: 1n, service: 42, method: 1, headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: id }, { key: 'sum', value: '1' }, { key: 'seq', value: '0' }], payload: fEvent(id, t, st) });
  s1.send(one('e1', '你好')); s1.send(one('e2', 'bot', 'app')); s1.send(one('e3', '第二条'));
  ok(await until(() => fIn.length === 2) && fIn[1].text === '第二条', '重投的同一事件只交一次, 机器人发的跳过');
  let r = await fc.send({ to: 'oc_g1', text: '收到' });
  const fm = fp.calls.find((c) => c.path === '/open-apis/im/v1/messages');
  ok(r.ok && fm.query === '?receive_id_type=chat_id' && fm.headers.authorization === 'Bearer t-1' && fm.body.msg_type === 'text' && JSON.parse(fm.body.content).text === '收到', '飞书发送: tenant token + im/v1/messages, 内容是 JSON 串');
  s1.terminate();
  ok(await until(() => fDial === 2 && fc.status().running, 5000), '连接断了自己重连');
  fc.stop();
  ok((await feishu.check({ app_id: 'cli_x', app_secret: 'good', api_base: fp.base })).ok, '检查凭据: 对的通过');
  ok(/invalid/.test((await feishu.check({ app_id: 'cli_x', app_secret: 'bad', api_base: fp.base })).error), '检查凭据: 错的带回平台原话');
  const fbad = feishu.create({ app_id: 'cli_x', app_secret: 'bad', api_base: fp.base }, { log: () => {}, onMessage: () => {} });
  const dialsBefore = fDial; fbad.start();
  ok(await until(() => /Feishu rejected the app/.test(fbad.status().lastError || '')), '凭据错: 状态里写明被拒');
  await new Promise((r2) => setTimeout(r2, 1500));
  ok(fDial === dialsBefore + 1, '凭据错不反复重连');
  fbad.stop();
  // 飞书 / Lark 两套租户: 没指定 domain 就两边各试一次, 认得的那边就是它
  // 实测: token 两边都发, 只有长连接接口对另一边的应用回 1000040351
  const wrong = await fakePlatform({ '/open-apis/auth/v3/tenant_access_token/internal': () => ({ code: 0, tenant_access_token: 't-cn', expire: 7200 }), '/callback/ws/endpoint': () => ({ code: 1000040351, msg: 'Incorrect domain name', data: { URL: '' } }) }, () => {});
  const lp = await fakePlatform({ '/open-apis/auth/v3/tenant_access_token/internal': () => ({ code: 0, tenant_access_token: 't-lark', expire: 7200 }), '/callback/ws/endpoint': () => ({ code: 0, data: { URL: 'wss://x/?service_id=1', ClientConfig: {} } }), '/open-apis/im/v1/messages': () => ({ code: 0 }) }, () => {});
  const sites = { ...F.SITES };
  F.SITES.feishu = wrong.base; F.SITES.lark = lp.base;
  const lc = await feishu.check({ app_id: 'cli_x', app_secret: 'good' });
  ok(lc.ok && lc.note === 'Lark', '飞书那边不认就试 Lark, 认得就用 Lark');
  const lcl = feishu.create({ app_id: 'cli_x', app_secret: 'good' }, { log: () => {}, onMessage: () => {} });
  r = await lcl.send({ to: 'oc_1', text: 'hi' });
  ok(r.ok && lp.calls.some((c) => c.path === '/open-apis/im/v1/messages' && c.headers.authorization === 'Bearer t-lark'), '之后的发送都走 Lark');
  F.SITES.lark = wrong.base;
  ok(/neither/.test((await feishu.check({ app_id: 'cli_x', app_secret: 'good' })).error || ''), '两边都回域名不对就报错');
  Object.assign(F.SITES, sites); lp.close(); wrong.close(); fp.close();

  // ———————————————— 钉钉 ————————————————
  const dUp = [];
  const dp = await fakePlatform({
    '/v1.0/gateway/connections/open': (b) => (b.clientSecret === 'good' && b.subscriptions.some((x) => x.type === 'CALLBACK' && x.topic === '/v1.0/im/bot/messages/get') ? { endpoint: `${dp.ws}/dt`, ticket: 'tk' } : { status: 401, j: { code: 'InvalidAuthentication', message: 'bad secret' } }),
    '/v1.0/oauth2/accessToken': (b) => (b.appSecret === 'good' ? { accessToken: 'at-1', expireIn: 7200 } : { status: 400, j: { message: 'bad secret' } }),
    '/v1.0/robot/oToMessages/batchSend': () => ({ processQueryKey: 'q' }),
    '/v1.0/robot/groupMessages/send': () => ({ processQueryKey: 'q' }),
    '/hook': () => ({ errcode: 0 }),
  }, (s, url) => { s.ticket = new URL(url, 'http://x').searchParams.get('ticket'); s.on('message', (m) => dUp.push(JSON.parse(String(m)))); });
  const dIn = [];
  const dc = dingtalk.create({ client_id: 'dingx', client_secret: 'good', api_base: dp.base }, { log: () => {}, onMessage: (x) => dIn.push(x) });
  dc.start();
  ok(await until(() => dp.socks.length === 1), '钉钉: 换到 endpoint + ticket 并连上');
  const ds = dp.socks[0];
  ok(ds.ticket === 'tk', 'ticket 带在连接地址上');
  ds.send(JSON.stringify({ specVersion: '1.0', type: 'SYSTEM', headers: { topic: 'ping', messageId: 'p1' }, data: '{"opaque":"x"}' }));
  ok(await until(() => dUp.some((m) => m.headers.messageId === 'p1')) && dUp[0].code === 200 && dUp[0].data === '{"opaque":"x"}', 'SYSTEM ping 原样回');
  const robot = (mid, extra) => JSON.stringify({ specVersion: '1.0', type: 'CALLBACK', headers: { topic: '/v1.0/im/bot/messages/get', messageId: mid, contentType: 'application/json' }, data: JSON.stringify({ msgId: mid, msgtype: 'text', text: { content: ' 查下库存 ' }, senderNick: '小王', senderStaffId: 's01', ...extra }) });
  ds.send(robot('m1', { conversationType: '2', conversationId: 'cidG', conversationTitle: '运营群', sessionWebhook: `${dp.base}/hook`, sessionWebhookExpiredTime: Date.now() + 3600e3 }));
  ok(await until(() => dIn.length === 1) && dIn[0].chat_id === 'g:cidG' && dIn[0].text === '查下库存' && dIn[0].from_name === '小王', '群里 @ 的消息: chat 记成 g:<会话>');
  ok(await until(() => dUp.some((m) => m.headers.messageId === 'm1' && m.code === 200)), '机器人消息回了确认帧');
  ds.send(robot('m1', { conversationType: '2', conversationId: 'cidG' }));
  ds.send(robot('m2', { conversationType: '1', conversationId: 'cidU' }));
  ok(await until(() => dIn.length === 2) && dIn[1].chat_id === 'u:s01', '重投去重; 单聊 chat 记成 u:<staffId>');
  r = await dc.send({ to: 'g:cidG', text: '好的' });
  ok(r.ok && dp.calls.some((c) => c.path === '/hook' && c.body.text.content === '好的'), '刚来过消息的群: 走 sessionWebhook 回');
  r = await dc.send({ to: 'u:s01', text: '提醒' });
  const bs = dp.calls.find((c) => c.path === '/v1.0/robot/oToMessages/batchSend');
  ok(r.ok && bs && bs.headers['x-acs-dingtalk-access-token'] === 'at-1' && bs.body.robotCode === 'dingx' && bs.body.userIds[0] === 's01' && JSON.parse(bs.body.msgParam).content === '提醒', '单聊主动发: batchSend, robotCode 默认是 ClientId');
  r = await dc.send({ to: 'cidOther', text: 'x' });
  ok(r.ok && dp.calls.some((c) => c.path === '/v1.0/robot/groupMessages/send' && c.body.openConversationId === 'cidOther'), '裸 cid 开头的当群会话发');
  dc.stop();
  ok(/bad secret/.test((await dingtalk.check({ client_id: 'dingx', client_secret: 'no', api_base: dp.base })).error), '钉钉检查凭据: 错的带回原话');
  const dbad = dingtalk.create({ client_id: 'dingx', client_secret: 'no', api_base: dp.base }, { log: () => {}, onMessage: () => {} });
  dbad.start();
  ok(await until(() => /DingTalk refused/.test(dbad.status().lastError || '')), '钉钉凭据错: 停下并写明原因');
  dbad.stop(); dp.close();

  // ———————————————— Discord ————————————————
  const gUp = [];
  let gDial = 0;
  const gp = await fakePlatform({
    '/gateway/bot': (b, req) => { gDial++; return req.headers.authorization === 'Bot good' ? { url: `${gp.ws}/gw` } : { status: 401, j: { message: '401: Unauthorized' } }; },
    '/users/@me': (b, req) => (req.headers.authorization === 'Bot good' ? { id: 'B1', username: 'butlerbot' } : { status: 401, j: { message: '401: Unauthorized' } }),
    '/channels/C9/messages': () => ({ id: 'x' }),
  }, (s) => {
    s.on('message', (m) => { const x = JSON.parse(String(m)); gUp.push(x); if (x.op === 1 && !gp.mute) s.send(JSON.stringify({ op: 11 })); });
    s.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 80 } }));
  });
  const gIn = [];
  const gc = discord.create({ bot_token: 'good', api_base: gp.base }, { log: () => {}, onMessage: (x) => gIn.push(x) });
  gc.start();
  ok(await until(() => gUp.some((m) => m.op === 2)), 'Discord: hello 之后发 identify');
  const idf = gUp.find((m) => m.op === 2);
  ok(idf.d.token === 'good' && (idf.d.intents & (1 << 15)) && (idf.d.intents & (1 << 12)) && (idf.d.intents & (1 << 9)), 'identify 带 token 和读消息、私信、频道的 intents');
  ok(await until(() => gUp.some((m) => m.op === 1)), '按 hello 给的间隔发心跳');
  const gs = gp.socks[0];
  const dsp = (t, d, s) => gs.send(JSON.stringify({ op: 0, t, s, d }));
  dsp('READY', { user: { id: 'B1', username: 'butlerbot' } }, 1);
  dsp('MESSAGE_CREATE', { id: '1', channel_id: 'C1', guild_id: 'G', content: '大家好', author: { id: 'U1', username: 'ann' }, mentions: [] }, 2);
  dsp('MESSAGE_CREATE', { id: '2', channel_id: 'C1', guild_id: 'G', content: '<@B1> 在吗', author: { id: 'U1', username: 'ann', global_name: 'Ann' }, mentions: [{ id: 'B1' }] }, 3);
  dsp('MESSAGE_CREATE', { id: '3', channel_id: 'C1', content: 'beep', author: { id: 'B2', bot: true } }, 4);
  dsp('MESSAGE_CREATE', { id: '4', channel_id: 'D7', content: '私聊一句', author: { id: 'U2', username: 'bob' } }, 5);
  ok(await until(() => gIn.length === 2), '频道里没 @ 的、别的机器人的跳过');
  ok(gIn[0].text === '在吗' && gIn[0].from_name === 'Ann' && gIn[0].chat_id === 'C1' && gIn[1].chat_id === 'D7', '@ 的去掉提及; 私信每条都交');
  await new Promise((r2) => setTimeout(r2, 200));
  ok(gUp.filter((m) => m.op === 1).slice(-1)[0].d === 5, '心跳带最新的序号');
  r = await gc.send({ to: 'C9', text: 'x'.repeat(4100) });
  const gm = gp.calls.filter((c) => c.path === '/channels/C9/messages');
  ok(r.ok && gm.length === 3 && gm[0].headers.authorization === 'Bot good' && gm[0].body.content.length === 2000, '超过 2000 字切成几条发');
  // 平台不回心跳 = 僵死连接: 换一条重新 identify
  gp.mute = true;
  ok(await until(() => gp.socks.length === 2), '心跳没回应就换一条连接');
  gp.mute = false;
  ok(await until(() => gUp.filter((m) => m.op === 2).length === 2), '新连接重新 identify');
  gp.socks[1].close(4014, 'Disallowed intent(s).');
  ok(await until(() => /Message Content Intent/.test(gc.status().lastError || '')), '4014: 状态里告诉用户去开 Message Content Intent');
  await new Promise((r2) => setTimeout(r2, 1300));
  ok(gDial === 2, '4014 这种致命关闭不再重连');
  gc.stop();
  ok((await discord.check({ bot_token: 'good', api_base: gp.base })).ok && !(await discord.check({ bot_token: 'bad', api_base: gp.base })).ok, 'Discord 检查凭据: 对的过、错的不过');
  gp.close();

  // ———————————————— Slack ————————————————
  const kUp = [];
  const kp = await fakePlatform({
    '/apps.connections.open': (b, req) => (req.headers.authorization === 'Bearer xapp-good' ? { ok: true, url: `${kp.ws}/sm` } : { ok: false, error: 'invalid_auth' }),
    '/auth.test': (b, req) => (req.headers.authorization === 'Bearer xoxb-good' ? { ok: true, user: 'butler' } : { ok: false, error: 'invalid_auth' }),
    '/chat.postMessage': () => ({ ok: true }),
  }, (s) => { s.on('message', (m) => kUp.push(JSON.parse(String(m)))); s.send(JSON.stringify({ type: 'hello' })); });
  const kIn = [];
  const kc = slack.create({ bot_token: 'xoxb-good', app_token: 'xapp-good', api_base: kp.base }, { log: () => {}, onMessage: (x) => kIn.push(x) });
  kc.start();
  ok(await until(() => kp.socks.length === 1), 'Slack: 用 xapp 换地址并连上');
  const ks = kp.socks[0];
  const env = (eid, event, id) => ks.send(JSON.stringify({ envelope_id: eid, type: 'events_api', payload: { event_id: id, event } }));
  env('E1', { type: 'app_mention', user: 'U1', text: '<@UBOT> 今天几号', channel: 'C1', ts: '1' }, 'ev1');
  env('E2', { type: 'message', channel_type: 'channel', user: 'U1', text: '闲聊', channel: 'C1', ts: '2' }, 'ev2');
  env('E3', { type: 'message', channel_type: 'im', bot_id: 'B', text: '我自己', channel: 'D1', ts: '3' }, 'ev3');
  env('E4', { type: 'message', channel_type: 'im', user: 'U2', text: '私信', channel: 'D1', ts: '4' }, 'ev4');
  env('E5', { type: 'message', channel_type: 'im', user: 'U2', text: '私信', channel: 'D1', ts: '4' }, 'ev4');
  ok(await until(() => kUp.length === 5), '每个信封都回 envelope_id 确认');
  ok(await until(() => kIn.length === 2) && kIn[0].text === '今天几号' && kIn[1].chat_id === 'D1', '只交 @ 和私信; 机器人消息、重投跳过');
  r = await kc.send({ to: 'D1', text: '3 号' });
  const kpm = kp.calls.find((c) => c.path === '/chat.postMessage');
  ok(r.ok && kpm.headers.authorization === 'Bearer xoxb-good' && kpm.body.channel === 'D1' && kpm.body.text === '3 号', '发送用 xoxb 调 chat.postMessage');
  kc.stop();
  ok((await slack.check({ bot_token: 'xoxb-good', app_token: 'xapp-good', api_base: kp.base })).ok, 'Slack 检查凭据: 两个 token 都对才过');
  ok(/App-Level Token: invalid_auth/.test((await slack.check({ bot_token: 'xoxb-good', app_token: 'xapp-bad', api_base: kp.base })).error), '指出是哪一个 token 不对');
  kp.close();

  // ———————————————— 登记 · 导出脱敏 ————————————————
  const { TYPES } = require('./channels');
  ok(['feishu_bot', 'dingtalk_bot', 'discord', 'slack'].every((t) => TYPES[t] && TYPES[t].dir === 'two' && typeof TYPES[t].check === 'function'), '四种双向通道都登记了, 都有 check');
  const { stripCredentials } = require('./persona-transfer');
  const ex = JSON.stringify(stripCredentials({ name: 'x', plugins: { channels: [
    { id: 'a', type: 'feishu_bot', app_id: 'cli_1', app_secret: 'S1' }, { id: 'b', type: 'dingtalk_bot', client_id: 'ding1', client_secret: 'S2' },
    { id: 'c', type: 'discord', bot_token: 'S3' }, { id: 'd', type: 'slack', bot_token: 'S4', app_token: 'S5' }] } }));
  ok(!/S[1-5]"/.test(ex), '导出人格时四家的 secret / token 都被剥掉');

  if (fails) { console.log(`\n✗ ${fails} 项失败`); process.exit(1); }
  console.log('\n✓ 双向通道全部通过');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
