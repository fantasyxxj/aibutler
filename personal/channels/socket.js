// channels/socket.js — 双向通道共用的底座: 长连接(先问平台要连接地址 → 连上 → 断了 1s→60s 退避重连)
// 加 JSON 请求和 access token 缓存。飞书长连接 · 钉钉 Stream · Discord Gateway · Slack Socket Mode
// 都是「桌面端主动连出去」, 所以不要公网地址。WebSocket 用 undici 的(已是依赖, Electron 33 的 Node 没有全局 WebSocket)。
'use strict';
const { WebSocket } = require('undici');

// 凭据错这类重连也没用的错误: 抛它, 底座就停下不再重试, 错误原文留在 status 里给界面看
class Fatal extends Error {}

// dial(): 返回这次的 wss 地址 · onOpen(sock) · onFrame(data, sock): data 是 string 或 ArrayBuffer
// onClose(code, reason): 返回一句话 = 这个关闭码是致命的, 不再重连
function keepSocket({ log, dial, onOpen, onFrame, onClose }) {
  let ws = null, stopped = true, timer = null, tries = 0;
  const st = { connected: false, since: null, lastError: null, reconnects: 0 };
  const retry = () => {
    if (stopped) return;
    const d = Math.min(1000 * 2 ** tries, 60000) + Math.floor(Math.random() * 1000);
    tries++; timer = setTimeout(open, d);
  };
  async function open() {
    timer = null;
    if (stopped) return;
    let url;
    try { url = await dial(); } catch (e) {
      st.lastError = e.message; log(`连接失败: ${e.message}`);
      if (e instanceof Fatal) { stopped = true; return; }
      return retry();
    }
    if (stopped) return;
    const s = new WebSocket(url); s.binaryType = 'arraybuffer'; ws = s;
    s.addEventListener('open', () => {
      if (ws !== s) return;
      tries = 0; st.connected = true; st.since = Date.now(); st.lastError = null;
      try { if (onOpen) onOpen(sock); } catch (e) { log(`onOpen 出错: ${e.message}`); }
    });
    s.addEventListener('message', (ev) => {
      if (ws !== s) return;
      Promise.resolve().then(() => onFrame(ev.data, sock)).catch((e) => log(`处理消息出错: ${e.message}`));
    });
    s.addEventListener('error', () => {});   // 后面一定跟着 close, 重连在那边做
    s.addEventListener('close', (ev) => {
      if (ws !== s) return;
      ws = null; st.connected = false;
      const fatal = onClose ? onClose(ev.code, ev.reason) : null;
      if (fatal) { st.lastError = fatal; log(fatal); stopped = true; return; }
      if (!stopped) { st.reconnects++; retry(); }
    });
  }
  const sock = {
    start() { if (!stopped) return; stopped = false; tries = 0; open(); },
    stop() {
      stopped = true; clearTimeout(timer); timer = null;
      const s = ws; ws = null; st.connected = false;
      try { if (s) s.close(); } catch (_) {}
    },
    send(data) { if (ws && ws.readyState === WebSocket.OPEN) { ws.send(data); return true; } return false; },
    // 平台叫我们换一条连接(心跳没回、服务端发了 reconnect): 关掉当前这条, close 里照常退避重连
    drop() { const s = ws; if (!s) return; try { s.close(); } catch (_) {} },
    state: st,
  };
  return sock;
}

// JSON 请求: 返回 { status, j }; 网络错误照常抛
async function req(url, { method = 'POST', headers = {}, body, form } = {}) {
  const h = { Accept: 'application/json', ...headers };
  let b;
  if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; b = new URLSearchParams(form).toString(); }
  else if (body !== undefined) { h['Content-Type'] = 'application/json; charset=utf-8'; b = JSON.stringify(body); }
  const resp = await fetch(url, { method, headers: h, body: b, signal: AbortSignal.timeout(15000) });
  let j = null; try { j = await resp.json(); } catch (_) {}
  return { status: resp.status, j };
}

// fetcher() 返回 { token, ttl(秒) }; 到期前 5 分钟换新的
function tokenCache(fetcher) {
  let tok = null, exp = 0, pending = null;
  return async () => {
    if (tok && Date.now() < exp - 300000) return tok;
    if (!pending) pending = fetcher().then((r) => { tok = r.token; exp = Date.now() + r.ttl * 1000; return tok; }).finally(() => { pending = null; });
    return pending;
  };
}

// 平台会重投没及时确认的消息: 记最近见过的 id, 同一条只交给人格一次
function seenSet(max = 500) {
  const s = new Set();
  return (id) => {
    if (!id) return false;
    if (s.has(id)) return true;
    s.add(id); if (s.size > max) s.delete(s.values().next().value);
    return false;
  };
}

// 按长度切: 各家单条上限不同(Discord 2000 字, Slack 建议 4000)
const chunks = (text, n) => { const out = []; for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n)); return out.length ? out : ['']; };

module.exports = { keepSocket, req, tokenCache, seenSet, chunks, Fatal };
