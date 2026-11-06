// channels/slack.js — Slack 应用, Socket Mode 双向收发(Bot Token xoxb- + App-Level Token xapp-, 不要公网地址)。
//
// 收: apps.connections.open(用 xapp)换 wss 地址, 平台推 JSON: hello / disconnect / events_api。
//     每个带 envelope_id 的信封立刻回 { envelope_id } 确认, 否则平台重投。
//     交给人格的: 私信(message, channel_type=im)和频道里 @ 机器人(app_mention); 机器人自己和别的 bot 的消息跳过。
//     要在 Event Subscriptions 订阅 message.im 和 app_mention, 应用要有 chat:write / im:history / app_mentions:read。
// 发: chat.postMessage(用 xoxb)。
'use strict';
const { keepSocket, req, seenSet, chunks, Fatal } = require('./socket');

const api = (cfg) => cfg.api_base || 'https://slack.com/api';   // api_base 只给门禁指到本机假服务器
const FATAL_ERR = /invalid_auth|not_authed|not_allowed_token_type|account_inactive|token_revoked/;

module.exports = {
  dir: 'two',
  async check(cfg) {
    if (!cfg.bot_token || !cfg.app_token) return { ok: false, error: 'Bot Token (xoxb-) and App-Level Token (xapp-) are both required' };
    try {
      const a = await req(`${api(cfg)}/auth.test`, { headers: { Authorization: `Bearer ${cfg.bot_token}` }, form: {} });
      if (!a.j || !a.j.ok) return { ok: false, error: `Bot Token: ${(a.j && a.j.error) || `HTTP ${a.status}`}` };
      const c = await req(`${api(cfg)}/apps.connections.open`, { headers: { Authorization: `Bearer ${cfg.app_token}` }, form: {} });
      if (!c.j || !c.j.ok) return { ok: false, error: `App-Level Token: ${(c.j && c.j.error) || `HTTP ${c.status}`}` };
      return { ok: true, note: a.j.user };
    } catch (e) { return { ok: false, error: e.message }; }
  },
  create(cfg, ctx) {
    const seen = seenSet();
    let received = 0, sent = 0, lastError = null;

    const sock = keepSocket({
      log: ctx.log,
      async dial() {
        const r = await req(`${api(cfg)}/apps.connections.open`, { headers: { Authorization: `Bearer ${cfg.app_token}` }, form: {} });
        if (r.j && r.j.ok && r.j.url) return r.j.url;
        const why = (r.j && r.j.error) || `HTTP ${r.status}`;
        if (FATAL_ERR.test(why)) throw new Fatal(`Slack rejected the App-Level Token: ${why}`);
        throw new Error(why);
      },
      onFrame(data, s) {
        let p; try { p = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); } catch (_) { return; }
        if (p.envelope_id) s.send(JSON.stringify({ envelope_id: p.envelope_id }));
        if (p.type === 'disconnect') { s.drop(); return; }
        if (p.type !== 'events_api') return;
        const ev = (p.payload && p.payload.event) || {};
        const dm = ev.type === 'message' && ev.channel_type === 'im' && !ev.subtype;
        if (!(dm || ev.type === 'app_mention') || ev.bot_id) return;
        if (seen((p.payload && p.payload.event_id) || ev.client_msg_id || `${ev.channel}:${ev.ts}`)) return;
        const text = String(ev.text || '').replace(/<@[A-Z0-9]+>/g, '').trim() || ((ev.files || []).length ? '[file]' : '');
        if (!text) return;
        received++;
        ctx.onMessage({ from_id: ev.user || '', from_name: '', chat_id: ev.channel, chat_name: dm ? 'direct' : 'channel', text });
      },
    });

    return {
      start() {
        if (!cfg.bot_token || !cfg.app_token) throw new Error('Bot Token (xoxb-) and App-Level Token (xapp-) are both required');
        sock.start();
      },
      stop() { sock.stop(); },
      status() { return { running: sock.state.connected, ...sock.state, lastError: sock.state.lastError || lastError, received, sent }; },
      async send({ to, text }) {
        if (!text) return { ok: false, error: 'text is empty' };
        if (!to) return { ok: false, error: 'no "to": give a Slack channel id (C…/D…) or a user id (U…)' };
        try {
          for (const part of chunks(text, 4000)) {
            const r = await req(`${api(cfg)}/chat.postMessage`, { headers: { Authorization: `Bearer ${cfg.bot_token}` }, body: { channel: to, text: part } });
            if (!r.j || !r.j.ok) { lastError = (r.j && r.j.error) || `HTTP ${r.status}`; ctx.log(`发送失败: ${lastError}`); return { ok: false, error: lastError }; }
          }
          sent++; lastError = null; return { ok: true };
        } catch (e) { lastError = e.message; return { ok: false, error: e.message }; }
      },
    };
  },
};
