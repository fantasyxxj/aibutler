// scripts/cdp-eval.js — 往【正在跑的】dev 实例里执行一段 JS, 把结果打回来。
//
// 存在的理由: 界面改动只有真机能验。仓里原有的探针(svg-*-probe)都是自己另起一个 Electron 窗口,
// 验不了"我改的这版 app 跑起来到底长什么样"。这个是接上去看, 不是另起一个像的。
//
// 手搓 WebSocket 是刻意的: 装 ws 只为看一眼 DOM 不值当, 而且验证工具自带依赖会让它在
// 干净环境里第一个坏掉。CDP 只需要一次握手 + 一个文本帧, 四十行的事。
//
// 用法: node scripts/cdp-eval.js '<js 表达式>' [页面URL关键字, 默认 index.html]
const net = require('net');
const crypto = require('crypto');
const http = require('http');

const EXPR = process.argv[2];
const URL_HINT = process.argv[3] || 'index.html';
if (!EXPR) { console.error('用法: node scripts/cdp-eval.js "<js>" [url关键字]'); process.exit(2); }

const getJSON = (path_) => new Promise((res, rej) => {
  // 个人版 dev は 9222、行業版の検証インスタンスは 9225 —— 複製すると必ず漂うので口を開ける。
  http.get({ host: '127.0.0.1', port: Number(process.env.CDP_PORT) || 9222, path: path_ }, (r) => {
    let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

// 只发一帧、只收一帧, 所以不做分片与掩码之外的任何协议细节。
function evalOnce(wsUrl, expr) {
  return new Promise((resolve, reject) => {
    /* 🔴 超时定时器必须在每个出口 clearTimeout —— 不清的话, resolve 済みでも定时器が
       event loop に残り、**进程が CDP_TIMEOUT_MS まで退出しない**。画面側の答えは
       既に出ているのに呼び出し元(execFile)は子进程の終了を待つので、一回の eval が
       必ず超时値ぶん掛かる。2026-10-05 実測: `booking.avail` は页面内 221ms なのに
       drive.evalIn(既定 90s)経由だと毎回 85〜90 秒。能力套件の取証が丸ごとこれで
       空回りし、D 段が終わらなかった。 */
    let timer = null;
    const done = (fn) => (arg) => { if (timer) { clearTimeout(timer); timer = null; } fn(arg); };
    const ok = done(resolve); const ng = done(reject);
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let handshaked = false; let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!handshaked) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        handshaked = true; buf = buf.slice(i + 4);
        const payload = Buffer.from(JSON.stringify({
          id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true },
        }));
        const mask = crypto.randomBytes(4);
        const masked = Buffer.from(payload.map((b, j) => b ^ mask[j % 4]));
        let head;
        if (payload.length < 126) head = Buffer.from([0x81, 0x80 | payload.length]);
        else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0xfe; head.writeUInt16BE(payload.length, 2); }
        sock.write(Buffer.concat([head, mask, masked]));
      }
      // 服务端帧不带掩码
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f; let off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const msg = buf.slice(off, off + len).toString(); buf = buf.slice(off + len);
        let m; try { m = JSON.parse(msg); } catch (_) { continue; }
        if (m.id !== 1) continue;
        sock.destroy();
        if (m.result && m.result.exceptionDetails) return ng(new Error(JSON.stringify(m.result.exceptionDetails)));
        return ok(m.result && m.result.result ? m.result.result.value : undefined);
      }
    });
    sock.on('error', ng);
    timer = setTimeout(() => { sock.destroy(); ng(new Error('CDP 超时(dev 起了吗? 带 --remote-debugging-port=9222 了吗?)')); }, Number(process.env.CDP_TIMEOUT_MS) || 10000);
  });
}

(async () => {
  const targets = await getJSON('/json');
  // 包みの画面は butlerui:// の別 target に居る(宿主 CSP を継承しないため)。
  // page だけを見ていると、包みの中は永久に触れない。
  const page = targets.find((t) => (t.type === 'page' || t.type === 'iframe')
                                   && String(t.url).includes(URL_HINT));
  if (!page) { console.error('找不到页面, 现有:', targets.map((t) => t.url).join(' · ')); process.exit(1); }
  const v = await evalOnce(page.webSocketDebuggerUrl, EXPR);
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
