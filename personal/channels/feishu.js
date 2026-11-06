// channels/feishu.js — 飞书 / Lark(国际版)自建应用机器人, 长连接双向收发(只要 App ID + App Secret, 不要公网地址)。
//
// 收: POST /callback/ws/endpoint 换一条 wss 地址, 连上后平台推二进制帧。帧格式是 protobuf pbbp2.Frame
//     (SeqID=1 LogID=2 service=3 method=4 headers=5 payload_encoding=6 payload_type=7 payload=8 LogIDNew=9,
//     Header{key=1 value=2}), 照官方 SDK @larksuiteoapi/node-sdk 1.76 的 ws-client 核对(2026-11-06)。
//     method 0 = 控制帧(ping/pong), 1 = 数据帧; 数据帧可能分片(headers 里 sum/seq), 拼齐后是事件 JSON。
//     每个数据帧原样回一帧、payload 换成 {"code":200}, 否则平台会重投。整个 SDK 30MB, 这里只用到这一小块, 所以自己写。
// 发: tenant_access_token → POST /open-apis/im/v1/messages。
// 群里只有 @ 机器人的消息才推过来(平台默认), 单聊每条都推。
'use strict';
const { keepSocket, req, tokenCache, seenSet, Fatal } = require('./socket');

// —— 最小 protobuf: 只认 varint 和长度前缀两种线型, 够 pbbp2 用 ——
function readVarint(u8, p) {
  let r = 0n, shift = 0n, b;
  do { b = u8[p++]; if (b === undefined) throw new Error('truncated frame'); r |= BigInt(b & 0x7f) << shift; shift += 7n; } while (b & 0x80);
  return [r, p];
}
function varint(v) {
  let x = BigInt.asUintN(64, BigInt(v)); const out = [];
  while (x > 0x7fn) { out.push(Number(x & 0x7fn) | 0x80); x >>= 7n; }
  out.push(Number(x));
  return Buffer.from(out);
}
const td = (b) => Buffer.from(b).toString('utf8');
function fields(u8, each) {
  let p = 0;
  while (p < u8.length) {
    let tag; [tag, p] = readVarint(u8, p);
    const no = Number(tag >> 3n), wt = Number(tag & 7n);
    if (wt === 0) { let v; [v, p] = readVarint(u8, p); each(no, v); }
    else if (wt === 2) { let n; [n, p] = readVarint(u8, p); const end = p + Number(n); each(no, u8.subarray(p, end)); p = end; }
    else if (wt === 1) p += 8;
    else if (wt === 5) p += 4;
    else throw new Error(`bad wire type ${wt}`);
  }
}
function decodeFrame(buf) {
  const f = { SeqID: 0n, LogID: 0n, service: 0, method: 0, headers: [], payload: null };
  fields(new Uint8Array(buf), (no, v) => {
    if (no === 1) f.SeqID = v; else if (no === 2) f.LogID = v;
    else if (no === 3) f.service = Number(BigInt.asIntN(32, v)); else if (no === 4) f.method = Number(BigInt.asIntN(32, v));
    else if (no === 5) { const h = {}; fields(v, (k, x) => { if (k === 1) h.key = td(x); else if (k === 2) h.value = td(x); }); f.headers.push(h); }
    else if (no === 6) f.payloadEncoding = td(v); else if (no === 7) f.payloadType = td(v);
    else if (no === 8) f.payload = Buffer.from(v); else if (no === 9) f.LogIDNew = td(v);
  });
  return f;
}
function encodeFrame(f) {
  const parts = [];
  const vf = (no, v) => parts.push(varint(no << 3), varint(v));
  const lf = (no, b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(String(b), 'utf8'); parts.push(varint((no << 3) | 2), varint(buf.length), buf); };
  vf(1, f.SeqID || 0n); vf(2, f.LogID || 0n); vf(3, f.service || 0); vf(4, f.method || 0);
  for (const h of f.headers || []) {
    const hb = Buffer.concat([varint(10), varint(Buffer.byteLength(h.key)), Buffer.from(h.key), varint(18), varint(Buffer.byteLength(h.value)), Buffer.from(h.value)]);
    lf(5, hb);
  }
  if (f.payloadEncoding != null) lf(6, f.payloadEncoding);
  if (f.payloadType != null) lf(7, f.payloadType);
  if (f.payload != null) lf(8, Buffer.from(f.payload));
  if (f.LogIDNew != null) lf(9, f.LogIDNew);
  return Buffer.concat(parts);
}
const hdr = (f) => Object.fromEntries(f.headers.map((h) => [h.key, h.value]));

// 文本消息的 content 是一段 JSON 字符串: {"text":"@_user_1 你好"}; @ 占位符去掉
function textOf(m) {
  let c = {}; try { c = JSON.parse(m.content || '{}'); } catch (_) {}
  if (m.message_type === 'text') return String(c.text || '').replace(/@_user_\d+\s*/g, '').trim();
  if (m.message_type === 'post') {
    const body = c.content || (Object.values(c)[0] || {}).content || [];
    return body.flat().map((x) => x.text || '').join('').replace(/@_user_\d+\s*/g, '').trim();
  }
  return `[${m.message_type}]`;
}

// 飞书(open.feishu.cn)和 Lark 国际版(open.larksuite.com)是两套租户, 用户不必分清, 没指定 domain 就自己认。
// 认法(实测 2026-11-06): tenant token 两边都发得出来, 认不出; 长连接接口对另一边的应用回
// 1000040351「Incorrect domain name」—— 所以按顺序问长连接接口, 没回这个码的那边就是它。按 cfg 对象记住, 不写回配置。
// api_base 只给门禁指到本机假服务器。
const SITES = { feishu: 'https://open.feishu.cn', lark: 'https://open.larksuite.com' };
const WRONG_SITE = 1000040351;
async function fetchToken(site, cfg) {
  const r = await req(`${site}/open-apis/auth/v3/tenant_access_token/internal`, { body: { app_id: cfg.app_id, app_secret: cfg.app_secret } });
  if (!r.j || r.j.code !== 0) throw new Error((r.j && r.j.msg) || `HTTP ${r.status}`);
  return { token: r.j.tenant_access_token, ttl: r.j.expire || 7200 };
}
const askEndpoint = (site, cfg) => req(`${site}/callback/ws/endpoint`, { headers: { locale: 'zh' }, body: { AppID: cfg.app_id, AppSecret: cfg.app_secret } });
const siteMemo = new WeakMap();
function siteOf(cfg) {
  if (cfg.api_base) return Promise.resolve(cfg.api_base);
  if (SITES[cfg.domain]) return Promise.resolve(SITES[cfg.domain]);
  if (!siteMemo.has(cfg)) {
    siteMemo.set(cfg, (async () => {
      for (const site of [SITES.feishu, SITES.lark]) {
        const r = await askEndpoint(site, cfg);
        if (!(r.j && r.j.code === WRONG_SITE)) return site;
      }
      throw new Error('neither Feishu nor Lark recognises this app');
    })().catch((e) => { siteMemo.delete(cfg); throw e; }));
  }
  return siteMemo.get(cfg);
}
const tokenOf = (cfg) => tokenCache(async () => fetchToken(await siteOf(cfg), cfg));
// 发给谁: ou_ 开头是个人 open_id, oc_ 开头是会话 chat_id(单聊、群聊都是)
const idType = (to) => (/^ou_/.test(to) ? 'open_id' : /^on_/.test(to) ? 'union_id' : /@/.test(to) ? 'email' : 'chat_id');

module.exports = {
  dir: 'two',
  async check(cfg) {
    if (!cfg.app_id || !cfg.app_secret) return { ok: false, error: 'App ID and App Secret are both required' };
    try { await tokenOf(cfg)(); return { ok: true, note: (await siteOf(cfg)) === SITES.lark ? 'Lark' : 'Feishu' }; } catch (e) { return { ok: false, error: e.message }; }
  },
  create(cfg, ctx) {
    const token = tokenOf(cfg);
    const seen = seenSet();
    const parts = new Map();   // message_id → { buf: [], at }  分片的数据帧先攒着
    let serviceId = 0, pingMs = 120000, pingTimer = null, received = 0, sent = 0, lastError = null;

    const sock = keepSocket({
      log: ctx.log,
      async dial() {
        const r = await askEndpoint(await siteOf(cfg), cfg);
        const j = r.j || {};
        if (j.code !== 0) {
          // 凭据错时这个接口也只回「internal error」(实测 2026-11-06), 拿同一组凭据换一次 token 才知道是不是凭据的事
          try { await token(); } catch (e) { throw new Fatal(`Feishu rejected the app: ${e.message}`); }
          // 1 = 平台忙, 1000040343 = 平台内部错: 等等再连; 其余(没开长连接、连接数超限)重试也没用
          if (j.code === 1 || j.code === 1000040343 || r.status >= 500) throw new Error(j.msg || `HTTP ${r.status}`);
          throw new Fatal(`Feishu refused the connection: ${j.msg || `code ${j.code}`}`);
        }
        serviceId = Number(new URL(j.data.URL).searchParams.get('service_id')) || 0;
        if (j.data.ClientConfig && j.data.ClientConfig.PingInterval) pingMs = j.data.ClientConfig.PingInterval * 1000;
        return j.data.URL;
      },
      onOpen(s) {
        const ping = () => { s.send(encodeFrame({ service: serviceId, method: 0, headers: [{ key: 'type', value: 'ping' }] })); pingTimer = setTimeout(ping, pingMs); };
        clearTimeout(pingTimer); ping();
      },
      onClose() { clearTimeout(pingTimer); return null; },
      onFrame(data, s) {
        if (typeof data === 'string') return;
        const f = decodeFrame(data);
        const h = hdr(f);
        if (f.method === 0) {
          if (h.type === 'pong' && f.payload) { try { const c = JSON.parse(td(f.payload)); if (c.PingInterval) pingMs = c.PingInterval * 1000; } catch (_) {} }
          return;
        }
        if (h.type !== 'event') { ctx.log(`跳过数据帧 type=${h.type}`); return; }
        // 先确认再处理: 人格回复可能要几十秒, 晚确认平台就重投
        const t0 = Date.now();
        s.send(encodeFrame({ ...f, headers: [...f.headers, { key: 'biz_rt', value: String(Date.now() - t0) }], payload: Buffer.from('{"code":200}') }));
        const sum = Number(h.sum) || 1, seq = Number(h.seq) || 0;
        let whole = f.payload;
        if (sum > 1) {
          const now = Date.now();
          for (const [k, v] of parts) if (now - v.at > 60000) parts.delete(k);
          const e = parts.get(h.message_id) || { buf: new Array(sum).fill(null), at: now };
          if (seq < 0 || seq >= e.buf.length) return;
          e.buf[seq] = f.payload; parts.set(h.message_id, e);
          if (e.buf.some((x) => !x)) return;
          parts.delete(h.message_id); whole = Buffer.concat(e.buf);
        }
        let ev; try { ev = JSON.parse(td(whole)); } catch (e) { ctx.log(`事件不是合法 JSON: ${e.message}`); return; }
        const type = ev.header && ev.header.event_type;
        if (type !== 'im.message.receive_v1') { ctx.log(`收到事件 ${type}, 不是消息, 跳过`); return; }
        const e = ev.event || {}, m = e.message || {}, sd = e.sender || {};
        if (sd.sender_type && sd.sender_type !== 'user') { ctx.log(`跳过 ${sd.sender_type} 发的消息`); return; }   // 别的机器人、自己发的
        if (seen((ev.header && ev.header.event_id) || m.message_id)) return;
        const text = textOf(m);
        if (!text) { ctx.log(`跳过空消息 (${m.message_type})`); return; }
        received++;
        ctx.onMessage({
          from_id: (sd.sender_id && sd.sender_id.open_id) || '', from_name: '',
          chat_id: m.chat_id, chat_name: m.chat_type === 'p2p' ? 'direct' : 'group', text,
        });
      },
    });

    return {
      start() {
        if (!cfg.app_id || !cfg.app_secret) throw new Error('App ID and App Secret are both required');
        sock.start();
      },
      stop() { clearTimeout(pingTimer); sock.stop(); },
      status() { return { running: sock.state.connected, ...sock.state, lastError: sock.state.lastError || lastError, received, sent }; },
      async send({ to, text }) {
        if (!text) return { ok: false, error: 'text is empty' };
        if (!to) return { ok: false, error: 'no "to": give a chat_id (oc_…) or a user open_id (ou_…)' };
        try {
          const r = await req(`${await siteOf(cfg)}/open-apis/im/v1/messages?receive_id_type=${idType(to)}`, {
            headers: { Authorization: `Bearer ${await token()}` },
            body: { receive_id: to, msg_type: 'text', content: JSON.stringify({ text }) },
          });
          if (r.j && r.j.code === 0) { sent++; lastError = null; return { ok: true }; }
          lastError = (r.j && r.j.msg) || `HTTP ${r.status}`; ctx.log(`发送失败: ${lastError}`);
          return { ok: false, error: lastError };
        } catch (e) { lastError = e.message; return { ok: false, error: e.message }; }
      },
    };
  },
  _test: { encodeFrame, decodeFrame, textOf, idType, SITES },
};
