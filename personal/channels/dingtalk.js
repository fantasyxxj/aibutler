// channels/dingtalk.js — 钉钉企业内部应用机器人, Stream 模式双向收发(只要 ClientId + ClientSecret, 不要公网地址)。
//
// 收: POST api.dingtalk.com/v1.0/gateway/connections/open(带订阅的 topic)换 endpoint + ticket, 连
//     `${endpoint}?ticket=…`, 平台推 JSON 文本帧 { type: SYSTEM|EVENT|CALLBACK, headers: { topic, messageId }, data }。
//     SYSTEM/ping 原样回; 机器人消息是 CALLBACK、topic /v1.0/im/bot/messages/get, 要回一帧确认否则 60 秒内重投。
//     照官方 SDK dingtalk-stream 2.1.6 的 client 核对(2026-11-06)。
// 发: 刚来过消息的会话用消息里带的 sessionWebhook 直接回(有效期内); 过期或主动发就走 OpenAPI —
//     单聊 /v1.0/robot/oToMessages/batchSend(userIds = 员工 staffId), 群聊 /v1.0/robot/groupMessages/send
//     (openConversationId), 都带 robotCode(企业内部应用默认就是 ClientId)。
// chat_id 记成 u:<staffId> / g:<conversationId>, 重启后人格不带 to 也知道走哪个接口。
'use strict';
const { keepSocket, req, tokenCache, seenSet, Fatal } = require('./socket');

const TOPIC_ROBOT = '/v1.0/im/bot/messages/get';
const api = (cfg) => cfg.api_base || 'https://api.dingtalk.com';   // api_base 只给门禁指到本机假服务器
const tokenOf = (cfg) => tokenCache(async () => {
  const r = await req(`${api(cfg)}/v1.0/oauth2/accessToken`, { body: { appKey: cfg.client_id, appSecret: cfg.client_secret } });
  if (!r.j || !r.j.accessToken) throw new Error((r.j && r.j.message) || `HTTP ${r.status}`);
  return { token: r.j.accessToken, ttl: r.j.expireIn || 7200 };
});

function textOf(d) {
  if (d.msgtype === 'text') return String((d.text && d.text.content) || '').trim();
  if (d.msgtype === 'richText') return ((d.content && d.content.richText) || []).map((x) => x.text || '').join('').trim();
  return `[${d.msgtype || 'message'}]`;
}
// 人格给的 to 可能是我们记的 u:/g: 形式, 也可能是它自己从别处拿来的裸 id: cid 开头的是群会话
const target = (to) => {
  const m = /^([ug]):(.+)$/.exec(to);
  if (m) return { kind: m[1], id: m[2] };
  return /^cid/.test(to) ? { kind: 'g', id: to } : { kind: 'u', id: to };
};

module.exports = {
  dir: 'two',
  async check(cfg) {
    if (!cfg.client_id || !cfg.client_secret) return { ok: false, error: 'ClientId and ClientSecret are both required' };
    try { await tokenOf(cfg)(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  },
  create(cfg, ctx) {
    const token = tokenOf(cfg);
    const seen = seenSet();
    const hooks = new Map();   // chat_id → { url, exp }  会话内回复地址
    let received = 0, sent = 0, lastError = null;
    const ack = (s, msg, data) => s.send(JSON.stringify({ code: 200, headers: { contentType: 'application/json', messageId: msg.headers.messageId }, message: 'OK', data: JSON.stringify(data) }));

    const sock = keepSocket({
      log: ctx.log,
      async dial() {
        const r = await req(`${api(cfg)}/v1.0/gateway/connections/open`, {
          body: { clientId: cfg.client_id, clientSecret: cfg.client_secret, ua: 'butler', subscriptions: [{ type: 'EVENT', topic: '*' }, { type: 'CALLBACK', topic: TOPIC_ROBOT }] },
        });
        if (r.j && r.j.endpoint && r.j.ticket) return `${r.j.endpoint}?ticket=${encodeURIComponent(r.j.ticket)}`;
        const why = (r.j && (r.j.message || r.j.code)) || `HTTP ${r.status}`;
        if (r.status >= 400 && r.status < 500) throw new Fatal(`DingTalk refused the connection: ${why}`);
        throw new Error(why);
      },
      onFrame(data, s) {
        let msg; try { msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); } catch (_) { return; }
        const topic = msg.headers && msg.headers.topic;
        if (msg.type === 'SYSTEM') {
          if (topic === 'ping') s.send(JSON.stringify({ code: 200, headers: msg.headers, message: 'OK', data: msg.data }));
          else if (topic === 'disconnect') s.drop();
          return;
        }
        if (msg.type === 'EVENT') return ack(s, msg, { status: 'SUCCESS', message: 'success' });
        if (msg.type !== 'CALLBACK') return;
        ack(s, msg, { response: null });
        if (topic !== TOPIC_ROBOT) return;
        let d; try { d = JSON.parse(msg.data); } catch (_) { return; }
        if (seen(d.msgId || msg.headers.messageId)) return;
        const text = textOf(d);
        if (!text) return;
        const group = String(d.conversationType) === '2';
        const chat = group ? `g:${d.conversationId}` : `u:${d.senderStaffId || d.senderId}`;
        if (d.sessionWebhook) hooks.set(chat, { url: d.sessionWebhook, exp: Number(d.sessionWebhookExpiredTime) || 0 });
        received++;
        ctx.onMessage({ from_id: d.senderStaffId || d.senderId || '', from_name: d.senderNick || '', chat_id: chat, chat_name: group ? (d.conversationTitle || 'group') : 'direct', text });
      },
    });

    async function viaOpenApi(t, text) {
      const robotCode = cfg.robot_code || cfg.client_id;
      const msg = { robotCode, msgKey: 'sampleText', msgParam: JSON.stringify({ content: text }) };
      const [p, body] = t.kind === 'g' ? ['/v1.0/robot/groupMessages/send', { ...msg, openConversationId: t.id }] : ['/v1.0/robot/oToMessages/batchSend', { ...msg, userIds: [t.id] }];
      const r = await req(`${api(cfg)}${p}`, { headers: { 'x-acs-dingtalk-access-token': await token() }, body });
      if (r.status === 200 && r.j && !r.j.code) return { ok: true };
      return { ok: false, error: (r.j && (r.j.message || r.j.code)) || `HTTP ${r.status}` };
    }

    return {
      start() {
        if (!cfg.client_id || !cfg.client_secret) throw new Error('ClientId and ClientSecret are both required');
        sock.start();
      },
      stop() { sock.stop(); },
      status() { return { running: sock.state.connected, ...sock.state, lastError: sock.state.lastError || lastError, received, sent }; },
      async send({ to, text }) {
        if (!text) return { ok: false, error: 'text is empty' };
        if (!to) return { ok: false, error: 'no "to": give u:<staffId> for a person or g:<conversationId> for a group' };
        const t = target(String(to));
        const key = `${t.kind}:${t.id}`;
        try {
          let r;
          const h = hooks.get(key);
          if (h && h.exp > Date.now() + 60000) {
            const w = await req(h.url, { body: { msgtype: 'text', text: { content: text } } });
            r = w.j && w.j.errcode === 0 ? { ok: true } : { ok: false, error: (w.j && w.j.errmsg) || `HTTP ${w.status}` };
            if (!r.ok) { hooks.delete(key); r = await viaOpenApi(t, text); }
          } else r = await viaOpenApi(t, text);
          if (r.ok) { sent++; lastError = null; } else { lastError = r.error; ctx.log(`发送失败: ${r.error}`); }
          return r;
        } catch (e) { lastError = e.message; return { ok: false, error: e.message }; }
      },
    };
  },
  _test: { textOf, target },
};
