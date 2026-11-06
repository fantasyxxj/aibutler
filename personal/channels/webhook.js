// channels/webhook.js — 三家群机器人(钉钉自定义机器人 · 飞书自定义机器人 · 企业微信群机器人): 只发不收。
//
// 用户在群设置里加机器人, 拿到一条 webhook 地址(钉钉、飞书可再开「加签」给一串密钥), 粘进来就能发。
// 🔴 地址存在 webhook_key 字段而不是 webhook_url: 地址里带着 access_token / key, 等于密码;
//    导出人格时 persona-transfer.js 按字段名(token|secret|key…)剥凭据, 叫 url 就会跟着包走。
// 频率上限(官方文档, 2026-11 查): 钉钉 20 条/分 · 企业微信 20 条/分 · 飞书 100 次/分。
'use strict';
const crypto = require('crypto');

const hmac64 = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest('base64');

// 钉钉加签: timestamp(毫秒) + "\n" + secret 用 secret 做 HMAC-SHA256, base64 后 urlencode, 拼进地址
function dingtalkUrl(url, secret, now = Date.now()) {
  if (!secret) return url;
  const sign = encodeURIComponent(hmac64(secret, `${now}\n${secret}`));
  return `${url}${url.includes('?') ? '&' : '?'}timestamp=${now}&sign=${sign}`;
}
// 飞书加签: timestamp(秒) + "\n" + secret 当 key, 对空串做 HMAC-SHA256, base64; 放进请求体
function feishuSign(secret, nowSec = Math.floor(Date.now() / 1000)) {
  return { timestamp: String(nowSec), sign: hmac64(`${nowSec}\n${secret}`, '') };
}

async function post(url, body) {
  const resp = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  let j = null; try { j = await resp.json(); } catch (_) {}
  return { status: resp.status, j };
}

// 三家回执的成败字段各不同: 钉钉/企业微信 errcode, 飞书 code(老版本 StatusCode)
const okOf = (j) => j && (j.errcode === 0 || j.code === 0 || j.StatusCode === 0);
const errOf = (r) => (r.j && (r.j.errmsg || r.j.msg || r.j.StatusMessage)) || `HTTP ${r.status}`;

function make(build) {
  return {
    dir: 'send',
    create(cfg, ctx) {
      let sent = 0, lastError = null;
      return {
        start() { if (!cfg.webhook_key) throw new Error('webhook address is empty'); },
        stop() {},
        status() { return { running: true, sent, lastError }; },
        async send({ text }) {
          if (!text) return { ok: false, error: 'text is empty' };
          try {
            const { url, body } = build(cfg, text);
            const r = await post(url, body);
            if (okOf(r.j)) { sent++; lastError = null; return { ok: true, note: 'posted to the group' }; }
            lastError = errOf(r); ctx.log(`发送失败: ${lastError}`);
            return { ok: false, error: lastError };
          } catch (e) { lastError = e.message; return { ok: false, error: e.message }; }
        },
      };
    },
  };
}

module.exports = {
  dingtalk: make((c, text) => ({ url: dingtalkUrl(c.webhook_key, c.secret), body: { msgtype: 'text', text: { content: text } } })),
  feishu: make((c, text) => ({ url: c.webhook_key, body: { ...(c.secret ? feishuSign(c.secret) : {}), msg_type: 'text', content: { text } } })),
  wecom: make((c, text) => ({ url: c.webhook_key, body: { msgtype: 'text', text: { content: text } } })),
  _test: { dingtalkUrl, feishuSign },
};
