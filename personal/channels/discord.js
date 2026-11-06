// channels/discord.js — Discord 机器人, Gateway 长连接双向收发(只要 Bot Token)。
//
// 收: GET /gateway/bot 拿地址 → op10 hello 给心跳间隔 → op2 identify → op0 dispatch 里的 MESSAGE_CREATE。
//     intents = GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT; 最后这项是「特权」意图, 要在
//     Developer Portal → Bot 里打开 Message Content Intent, 没开平台用 4014 关连接。
//     私信每条都交给人格; 服务器频道里只有 @ 了机器人的才交。断线一律重新 identify(不做 resume, 简单可靠)。
// 发: POST /channels/{channel_id}/messages, 单条 2000 字, 长了切开发。
'use strict';
const { keepSocket, req, seenSet, chunks, Fatal } = require('./socket');

const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
// 这些关闭码重连也没用(官方 Gateway close event codes)
const FATAL = { 4004: 'Discord rejected the Bot Token (4004): copy it again from Developer Portal → Bot', 4010: 'Discord: invalid shard (4010)', 4011: 'Discord: sharding required (4011)', 4012: 'Discord: invalid API version (4012)', 4013: 'Discord: invalid intents (4013)', 4014: 'Discord withheld message content (4014): turn on Message Content Intent in Developer Portal → Bot' };
const api = (cfg) => cfg.api_base || 'https://discord.com/api/v10';   // api_base 只给门禁指到本机假服务器
const auth = (cfg) => ({ Authorization: `Bot ${cfg.bot_token}` });

module.exports = {
  dir: 'two',
  async check(cfg) {
    if (!cfg.bot_token) return { ok: false, error: 'Bot Token is required' };
    try {
      const r = await req(`${api(cfg)}/users/@me`, { method: 'GET', headers: auth(cfg) });
      return r.status === 200 ? { ok: true, note: r.j && r.j.username } : { ok: false, error: (r.j && r.j.message) || `HTTP ${r.status}` };
    } catch (e) { return { ok: false, error: e.message }; }
  },
  create(cfg, ctx) {
    const seen = seenSet();
    let seq = null, beat = null, acked = true, me = null, received = 0, sent = 0, lastError = null;
    const stopBeat = () => { clearTimeout(beat); clearInterval(beat); beat = null; };

    const sock = keepSocket({
      log: ctx.log,
      async dial() {
        const r = await req(`${api(cfg)}/gateway/bot`, { method: 'GET', headers: auth(cfg) });
        if (r.status === 401) throw new Fatal('Discord rejected the Bot Token (401): copy it again from Developer Portal → Bot');
        if (!r.j || !r.j.url) throw new Error((r.j && r.j.message) || `HTTP ${r.status}`);
        return `${r.j.url}/?v=10&encoding=json`;
      },
      onOpen() { seq = null; acked = true; },
      onClose(code) { stopBeat(); return FATAL[code] || null; },
      onFrame(data, s) {
        let p; try { p = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); } catch (_) { return; }
        if (p.s != null) seq = p.s;
        const hb = () => { if (!acked) { ctx.log('心跳没回应, 换一条连接'); return s.drop(); } acked = false; s.send(JSON.stringify({ op: 1, d: seq })); };
        if (p.op === 10) {
          const every = p.d.heartbeat_interval;
          stopBeat();
          beat = setTimeout(() => { hb(); beat = setInterval(hb, every); }, Math.floor(every * Math.random()));
          s.send(JSON.stringify({ op: 2, d: { token: cfg.bot_token, intents: INTENTS, properties: { os: process.platform, browser: 'butler', device: 'butler' } } }));
          return;
        }
        if (p.op === 11) { acked = true; return; }
        if (p.op === 1) { s.send(JSON.stringify({ op: 1, d: seq })); return; }
        if (p.op === 7 || p.op === 9) { s.drop(); return; }   // 平台让重连 / 会话失效: 换条连接重新 identify
        if (p.op !== 0) return;
        if (p.t === 'READY') { me = p.d.user; ctx.log(`已登录为 ${me.username}`); return; }
        if (p.t !== 'MESSAGE_CREATE') return;
        const m = p.d;
        if (!m || (m.author && m.author.bot) || seen(m.id)) return;
        if (m.guild_id && !(me && (m.mentions || []).some((u) => u.id === me.id))) return;
        const text = String(m.content || '').replace(/<@[!&]?\w+>/g, '').trim() || ((m.attachments || []).length ? '[attachment]' : '');
        if (!text) return;
        received++;
        ctx.onMessage({ from_id: m.author.id, from_name: m.author.global_name || m.author.username || '', chat_id: m.channel_id, chat_name: m.guild_id ? 'server channel' : 'direct', text });
      },
    });

    return {
      start() { if (!cfg.bot_token) throw new Error('Bot Token is required'); sock.start(); },
      stop() { stopBeat(); sock.stop(); },
      status() { return { running: sock.state.connected, ...sock.state, lastError: sock.state.lastError || lastError, received, sent, bot: me && me.username }; },
      async send({ to, text }) {
        if (!text) return { ok: false, error: 'text is empty' };
        if (!to) return { ok: false, error: 'no "to": give a Discord channel id' };
        try {
          for (const part of chunks(text, 2000)) {
            const r = await req(`${api(cfg)}/channels/${encodeURIComponent(to)}/messages`, { headers: auth(cfg), body: { content: part } });
            if (r.status !== 200) { lastError = (r.j && r.j.message) || `HTTP ${r.status}`; ctx.log(`发送失败: ${lastError}`); return { ok: false, error: lastError }; }
          }
          sent++; lastError = null; return { ok: true };
        } catch (e) { lastError = e.message; return { ok: false, error: e.message }; }
      },
    };
  },
};
