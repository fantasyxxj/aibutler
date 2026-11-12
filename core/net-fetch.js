// net-fetch.js — 插件联网的唯一出口: 宿主替包去叩它**自己声明过**的地址。
//
// 沙箱照旧一个字节出不去(CSP default-src 'none'), 这里不松那道墙, 而是在墙外开一扇只认名单的门。
// 作者 2026-10-23 拍板: 「插件都是自己做的」, 所以开放; 但开放的形状是名单, 不是任意代理 ——
// 包里的界面代码随便写, 它能现填的只有 url 里 {} 那几个空和 query / body, 去哪儿由随包签名的声明定。
//
// 包级 `net`: ["api.example.com", "*.example.com", "203.0.113.5", "192.168.1.20:8080"]
//   · 域名精确匹配; `*.x.com` 匹配 x.com 的任意子域(不含 x.com 本身)
//   · 写了端口就只认那个端口, 没写就只认协议默认端口(80 / 443)
// 命令声明 `http`: { method, url, headers?, secret?: { name, header?, format?, query? } }
//   · url 的协议 + 主机 + 端口必须是字面量, {} 只许出现在路径和 query 里 —— 登记那一刻就查
//   · secret 由宿主从本机金库按名字取出塞进请求头, 包和 AI 都读不到原文
'use strict';

const TIMEOUT_MS = 15000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
// 这些头由宿主管: 让包改 Host / Cookie 等于绕过名单或冒用别的身份
const BANNED_HEADERS = new Set(['host', 'cookie', 'connection', 'content-length', 'transfer-encoding', 'proxy-authorization']);

/* 名单里的一项 → { host, wildcard, port|null }; 不合法返回 null */
function parseNetEntry(raw) {
  const s = String(raw || '').trim().toLowerCase();
  const m = s.match(/^(\[[0-9a-f:]+\]|[^:]+)(?::(\d{1,5}))?$/);
  if (!m) return null;
  const host = m[1];
  const port = m[2] ? Number(m[2]) : null;
  if (port !== null && (port < 1 || port > 65535)) return null;
  if (IPV4_RE.test(host)) return host.split('.').every((x) => Number(x) <= 255) ? { host, wildcard: false, port } : null;
  if (/^\[[0-9a-f:]+\]$/.test(host)) return { host, wildcard: false, port };
  if (!HOST_RE.test(host)) return null;
  if (host.startsWith('*.')) return { host: host.slice(2), wildcard: true, port };
  return { host, wildcard: false, port };
}

/* 包级 net 字段: 返回 { list, bad } —— bad 是不认识的项, 由调用方告警 */
function parseNet(net) {
  if (net === undefined || net === null) return { list: [], bad: [] };
  if (!Array.isArray(net)) return { list: [], bad: [String(net)] };
  const list = [], bad = [];
  for (const x of net) { const e = parseNetEntry(x); if (e) list.push(e); else bad.push(String(x)); }
  return { list, bad };
}

function allowed(u, list) {
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  const host = u.hostname.toLowerCase();
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  return list.some((e) => {
    const hit = e.wildcard ? host.endsWith('.' + e.host) : host === e.host;
    if (!hit) return false;
    return e.port === null ? port === (u.protocol === 'https:' ? 443 : 80) : port === e.port;
  });
}

/* 登记时查一条 web 命令的声明。返回不合格的理由, 合格返回 null */
function badWebDecl(http, list) {
  if (!http || typeof http !== 'object' || !http.url) return 'web 原语要声明 http.url';
  const method = String(http.method || 'GET').toUpperCase();
  if (!METHODS.includes(method)) return `http.method 只能是 ${METHODS.join(' / ')}`;
  const m = String(http.url).match(/^(https?:\/\/[^/?#]+)/i);
  if (!m) return 'http.url 要以 http:// 或 https:// 开头';
  if (/[{}]/.test(m[1])) return 'http.url 的主机部分不能留 {} 空 (只许在路径和 query 里)';
  let u;
  try { u = new URL(m[1]); } catch (_) { return 'http.url 不是合法地址'; }
  if (!list.length) return '包里没有声明 net 名单';
  if (!allowed(u, list)) return `${u.host} 不在包的 net 名单里`;
  if (http.headers && (typeof http.headers !== 'object' || Object.keys(http.headers).some((k) => BANNED_HEADERS.has(k.toLowerCase())))) {
    return `http.headers 不能写 ${[...BANNED_HEADERS].join(' / ')}`;
  }
  if (http.secret !== undefined && !(http.secret && /^[a-z0-9_-]{1,32}$/.test(String(http.secret.name || '')))) {
    return 'http.secret 要写成 {name, header?, format?, query?}, name 只许小写字母数字 _ -';
  }
  if (http.secret && http.secret.query !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(String(http.secret.query))) {
    return 'http.secret.query 是地址参数名, 只许字母数字 _ -';
  }
  return null;
}

/* url 模板填空: {x} 换成 encodeURIComponent(args[x]); 缺参数就报错, 不留空洞 */
function fillUrl(tpl, args) {
  const missing = [];
  const url = String(tpl).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k) => {
    if (args[k] === undefined || args[k] === null || args[k] === '') { missing.push(k); return ''; }
    return encodeURIComponent(String(args[k]));
  });
  return { url, missing };
}

async function readCapped(res) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) return Buffer.from(await res.arrayBuffer());
  const parts = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_BYTES) { try { await reader.cancel(); } catch (_) {} throw Object.assign(new Error(`返回超过 ${MAX_BYTES / 1024 / 1024}MB`), { code: 'too_large' }); }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

/* 真正出网。decl = 登记过的命令声明(带 http 与 netList); args = 界面现填的;
   getSecret(name) → 明文或 ''。返回 { ok, data: { status, ok, content_type, body } } */
async function request(decl, args = {}, { getSecret, fetchImpl } = {}) {
  const http = decl.http || {};
  const list = decl.netList || [];
  const why = badWebDecl(http, list);
  if (why) return { ok: false, code: 'bad_decl', message: `web: ${why}` };
  const { url, missing } = fillUrl(http.url, args);
  if (missing.length) return { ok: false, code: 'bad_args', message: `web: 缺参数 ${missing.join(', ')}` };
  const u = new URL(url);
  if (args.query && typeof args.query === 'object') {
    for (const [k, v] of Object.entries(args.query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  const method = String(http.method || 'GET').toUpperCase();
  const headers = { ...(http.headers || {}) };
  if (http.secret) {
    const plain = typeof getSecret === 'function' ? await getSecret(http.secret.name) : '';
    if (!plain) return { ok: false, code: 'no_secret', message: `web: 密钥 ${http.secret.name} 还没设置` };
    // query = 放进地址参数的名字(Jamendo 这类只认 ?client_id=… 的接口); 不写就进请求头。
    if (http.secret.query) u.searchParams.set(String(http.secret.query), plain);
    else headers[http.secret.header || 'Authorization'] = String(http.secret.format || 'Bearer {}').replace('{}', plain);
  }
  let body;
  if (args.body !== undefined && method !== 'GET') {
    if (typeof args.body === 'string') body = args.body;
    else { body = JSON.stringify(args.body); if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'; }
  }
  const doFetch = fetchImpl || fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let cur = u; let res;
    // 跳转自己跟: 每一跳都重新对名单, 否则一个 302 就把请求带出了名单
    for (let hop = 0; ; hop += 1) {
      res = await doFetch(cur.toString(), { method, headers, body, redirect: 'manual', signal: ctl.signal });
      if (res.status < 300 || res.status >= 400 || !res.headers.get('location')) break;
      if (hop >= MAX_REDIRECTS) return { ok: false, code: 'too_many_redirects', message: 'web: 跳转太多次' };
      const next = new URL(res.headers.get('location'), cur);
      if (!allowed(next, list)) return { ok: false, code: 'redirect_blocked', message: `web: 跳转去的 ${next.host} 不在 net 名单里` };
      cur = next;
    }
    const buf = await readCapped(res);
    const ct = res.headers.get('content-type') || '';
    let out = buf.toString('utf8');
    if (/json/i.test(ct)) { try { out = JSON.parse(out); } catch (_) {} }
    return { ok: true, message: '', data: { status: res.status, ok: res.ok, content_type: ct, body: out } };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, code: 'timeout', message: `web: ${TIMEOUT_MS / 1000} 秒没回` };
    return { ok: false, code: (e && e.code) || 'web_failed', message: `web: ${(e && e.message) || e}` };
  } finally { clearTimeout(timer); }
}

module.exports = { parseNet, parseNetEntry, allowed, badWebDecl, fillUrl, request, MAX_BYTES, TIMEOUT_MS };
