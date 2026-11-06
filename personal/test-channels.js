// 统一通道回归: 三家群机器人照各自格式发出去(加签对得上)、ChannelHost 的清单/默认对象/报错、
// send_message 工具、导出人格时 webhook 地址和密钥被剥掉、行业版摘掉 send_message。
// 全程打本机假服务器, 不碰真平台。
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

require('./host-wiring');
const { ChannelHost, TYPES } = require('./channels');
const { _test: W } = require('./channels/webhook');

(async () => {
  // —— 加签 ——
  const u = new URL(W.dingtalkUrl('https://oapi.dingtalk.com/robot/send?access_token=abc', 'SECxyz', 1700000000000));
  const want = crypto.createHmac('sha256', 'SECxyz').update('1700000000000\nSECxyz').digest('base64');
  ok(u.searchParams.get('timestamp') === '1700000000000' && u.searchParams.get('sign') === want && u.searchParams.get('access_token') === 'abc', '钉钉加签: timestamp 毫秒 + sign 拼进地址, 原 access_token 保留');
  const fs1 = W.feishuSign('fsec', 1700000000);
  ok(fs1.timestamp === '1700000000' && fs1.sign === crypto.createHmac('sha256', '1700000000\nfsec').update('').digest('base64'), '飞书加签: timestamp 秒, 以 "ts\\nsecret" 为 key 对空串签');

  // —— 假服务器 ——
  const got = [];
  let reply = { errcode: 0, code: 0 };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => { got.push({ url: req.url, body: JSON.parse(b || '{}') }); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(reply)); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-test-'));
  const inbound = [];
  const host = new ChannelHost({ personaName: 't', log: () => {}, stateFile: path.join(dir, 'state.json'), onMessage: (r) => inbound.push(r) });
  await host.install([
    { id: 'd1', type: 'dingtalk_hook', webhook_key: `${base}/ding?access_token=x`, secret: 's1' },
    { id: 'f1', type: 'feishu_hook', webhook_key: `${base}/feishu`, secret: 's2', label: '运营群' },
    { id: 'w1', type: 'wecom_hook', webhook_key: `${base}/wecom?key=k` },
    { id: 'off', type: 'wecom_hook', webhook_key: `${base}/x`, enabled: false },
    { id: 'bad', type: 'nope' },
  ]);
  const ids = host.list().map((c) => c.id).join(',');
  ok(ids === 'd1,f1,w1', `清单只含启用且认得的类型 (${ids})`);
  ok(host.list().every((c) => c.direction === 'send-only'), '群机器人标成 send-only');

  let r = await host.send('d1', { text: '你好' });
  ok(r.ok && got[0].url.startsWith('/ding?access_token=x&timestamp=') && got[0].body.msgtype === 'text' && got[0].body.text.content === '你好', '钉钉: text 消息, 地址带签');
  r = await host.send('f1', { text: 'hi' });
  ok(r.ok && got[1].body.msg_type === 'text' && got[1].body.content.text === 'hi' && got[1].body.sign && got[1].body.timestamp, '飞书: msg_type text, 签名在请求体');
  r = await host.send('w1', { text: 'yo' });
  ok(r.ok && got[2].url === '/wecom?key=k' && got[2].body.text.content === 'yo', '企业微信: key 在地址里, text 消息');
  reply = { errcode: 310000, errmsg: 'keywords not in content' };
  r = await host.send('d1', { text: 'x' });
  ok(!r.ok && /keywords/.test(r.error), '平台拒收时把对方的错误原文带回来');
  r = await host.send('zz', { text: 'x' });
  ok(!r.ok && /no channel/.test(r.error), '不存在的通道报错');

  // —— 双向通道: 没人来过消息就不能省 to; 来过之后默认回给他, 而且记在盘上 ——
  let sentTo = null;
  TYPES.fake_two = { dir: 'two', create: (cfg, ctx) => ({ start() { TYPES.fake_two.ctx = ctx; }, stop() {}, status: () => ({}), send: async ({ to }) => { sentTo = to; return { ok: true }; } }) };
  await host.install([{ id: 'two', type: 'fake_two' }]);
  r = await host.send('two', { text: 'x' });
  ok(!r.ok && /needs "to"/.test(r.error), '双向通道: 没有来过消息又没给 to → 说清要 to');
  TYPES.fake_two.ctx.onMessage({ chat_id: 'c42', from_id: 'u1', from_name: 'Ann', text: 'hello' });
  ok(inbound.length === 1 && inbound[0].channel === 'two' && inbound[0].chat_id === 'c42', '收件交给宿主, 带上 channel id');
  r = await host.send('two', { text: 'x' });
  ok(r.ok && sentTo === 'c42', '不给 to 就回给最后来消息的那个 chat');
  ok(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).two.chat_id === 'c42', '最后的 chat 落盘(重启后还认得)');
  delete TYPES.fake_two;

  // —— send_message 工具 ——
  await host.install([{ id: 'w1', type: 'wecom_hook', webhook_key: `${base}/wecom?key=k` }]);
  reply = { errcode: 0 };
  const McpChannels = require('../core/agent/mcp-channels');
  const self = Object.create(McpChannels.prototype); self.channelHost = host;
  const tools = self._channelTools({ tool: (name, d, shape, h) => ({ name, h }), z: require('zod'), D: {} });
  ok(tools.sendMessage && tools.sendMessage.name === 'send_message', '注册了 send_message');
  const txt = async (a) => (await tools.sendMessage.h(a)).content[0].text;
  ok(/w1 · WeCom group bot · send-only/.test(await txt({})), '不带 channel → 列出现有通道');
  ok(/✅ sent via w1/.test(await txt({ channel: 'w1', text: '<speak>hi</speak>' })) && got[got.length - 1].body.text.content === 'hi', '带 channel 就发, SSML 标签剥掉');
  self.channelHost = null;
  ok(/no channels/.test(await txt({})), '没接通道宿主时说没有通道, 不抛错');

  // —— 导出脱敏 / 行业版 / 说明文案 ——
  const { stripCredentials } = require('./persona-transfer');
  const sc = stripCredentials({ name: 'x', plugins: { channels: [{ id: 'd1', type: 'dingtalk_hook', webhook_key: 'https://oapi.dingtalk.com/robot/send?access_token=SECRET', secret: 'S', label: 'L' }] } });
  const ch0 = JSON.stringify(sc);
  ok(!/SECRET|"secret"/.test(ch0) && /"label":"L"/.test(ch0), '导出人格时 webhook 地址和加签密钥被剥掉, 名称留着');
  ok(/'send_message'/.test(fs.readFileSync(path.join(__dirname, '..', 'industry', 'app', 'industry-agent.js'), 'utf8')), '行业版摘掉 send_message');
  ok(!!require('../core/config/tools/descriptions.json').send_message, 'send_message 有工具说明');
  ok(/send_message/.test(fs.readFileSync(path.join(__dirname, '..', 'core', 'config', 'inbox', 'channel_single.md'), 'utf8')), '收件模板告诉人格用 send_message 回');

  await host.stopAll(); srv.close();
  if (fails) { console.log(`\n✗ ${fails} 项失败`); process.exit(1); }
  console.log('\n✓ 统一通道全部通过');
})().catch((e) => { console.error(e); process.exit(1); });
