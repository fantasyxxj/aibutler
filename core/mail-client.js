// mail-client.js — 店のメールボックスを**この機械の中で**開き、この機械の中から送る。
//
// 作者 2026-09-02: 「私人邮件我们管他干嘛。放到客户端 —— 敏感信息放服务端才是他们忌讳的」。
// つまり店の SMTP/POP の凭据はサーバに預けない。預けなければ、漏れようが無い。
//
// 依存を足さないのは趣味ではない: 店に配る実体に外部ライブラリを一つ増やすと、
// その一つが壊れた日に全店が止まる。POP3 も SMTP も、必要なのは十数個のコマンドだけ。
//
// 🔴 受信は**消さない**(DELE を打たない)。店主が自分の携帯で開いても同じ手紙がそこに在る。
// 🔴 開く相手は UIDL で指す。番号は位置でしかなく、一通消された瞬間に全部ずれる。
'use strict';

const net = require('net');
const tls = require('tls');

const CRLF = '\r\n';

/* Every failure carries a `code`. The message is English only — it is read by logs
   and by the AI, never shown to the shop owner as-is. The owner-facing wording is
   looked up from the code by the UI package, which is the only layer that knows
   the display language. Writing a Japanese sentence here is what put Japanese
   error text in front of a shop owner running the Chinese UI. */
function mailFail(code, message, vars) {
  const e = new Error(message);
  e.code = code;
  if (vars) e.vars = vars;
  return e;
}

/* 一本の会話。行単位で読み、待っている応答が来たら次へ。
   POP3 も SMTP も「一行送って一行(または複数行)返る」だけなので、共用の土台はこれで足りる。 */
function connect({ host, port, secure, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const sock = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: true })
      : net.connect({ host, port });
    const onFail = (e) => reject(mailFail('connect_failed',
      `cannot reach ${host}:${port} — ${e.message}`, { host, port, detail: e.message }));
    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      reject(mailFail('timeout', `no response from ${host}:${port} within ${timeoutMs}ms`,
                      { host, port }));
    });
    sock.once('error', onFail);
    sock.once(secure ? 'secureConnect' : 'connect', () => {
      sock.removeListener('error', onFail);
      resolve(session(sock, timeoutMs));
    });
  });
}

function session(sock, timeoutMs) {
  let buf = '';
  const waiters = [];
  sock.setEncoding('binary');
  sock.on('data', (chunk) => {
    buf += chunk;
    while (waiters.length) {
      const w = waiters[0];
      const hit = w.match(buf);
      if (hit == null) break;
      buf = buf.slice(hit.consumed);
      waiters.shift();
      w.resolve(hit.text);
    }
  });
  const fail = (e) => { while (waiters.length) waiters.shift().reject(e); };
  sock.on('error', fail);
  sock.on('close', () => fail(mailFail('conn_closed', 'the server closed the connection')));

  const expect = (match) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(mailFail('timeout', 'the server stopped responding')), timeoutMs);
    waiters.push({
      match,
      resolve: (v) => { clearTimeout(t); resolve(v); },
      reject: (e) => { clearTimeout(t); reject(e); },
    });
    // 既に届いている分で足りることがある(接続直後の挨拶など)
    sock.emit('data', '');
  });

  // 一行返る物
  const line = () => expect((b) => {
    const i = b.indexOf(CRLF);
    return i < 0 ? null : { text: b.slice(0, i), consumed: i + 2 };
  });
  // 複数行返る物: 単独の "." で終わる(POP3 の multiline)
  const multiline = () => expect((b) => {
    const end = b.indexOf(`${CRLF}.${CRLF}`);
    if (end < 0) return null;
    return { text: b.slice(0, end), consumed: end + 5 };
  });

  return {
    send: (s) => sock.write(s + CRLF, 'binary'),
    line,
    multiline,
    raw: sock,
    upgrade: (host) => new Promise((resolve, reject) => {
      const up = tls.connect({ socket: sock, servername: host, rejectUnauthorized: true },
                             () => resolve(session(up, timeoutMs)));
      up.once('error', reject);
    }),
    end: () => { try { sock.destroy(); } catch (_) {} },
  };
}

/* ── 文字の復号 ──
   件名や差出人は RFC2047 で符号化されている(=?UTF-8?B?…?=)。日本語のメールは
   ISO-2022-JP や Shift_JIS も普通に来るので、TextDecoder に任せる(Electron は full-icu)。 */
function decodeWord(charset, enc, text) {
  let bytes;
  if (/^b$/i.test(enc)) bytes = Buffer.from(text, 'base64');
  else bytes = Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi,
    (_m, h) => String.fromCharCode(parseInt(h, 16))), 'binary');
  try { return new TextDecoder(charset).decode(bytes); }
  catch (_) { return bytes.toString('utf8'); }
}

function decodeHeader(s) {
  return String(s || '').replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi,
    (_m, cs, enc, text) => decodeWord(cs, enc, text)).trim();
}

function decodeBody(raw, charset, encoding) {
  /* 0xFF を超える文字が居る = 既に復号済みの文字列を渡された。そのまま返す ——
     ここで latin1 として読み直すと、一文字が一バイトに潰れて静かに化ける
     (例外も出ないので、店主が「読めない」と言うまで誰も気づかない)。 */
  if (!encoding && /[^\x00-\xFF]/.test(String(raw))) return String(raw);
  let bytes = Buffer.from(raw, 'binary');
  if (/base64/i.test(encoding || '')) bytes = Buffer.from(raw.replace(/\s+/g, ''), 'base64');
  else if (/quoted-printable/i.test(encoding || '')) {
    bytes = Buffer.from(raw.replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16))), 'binary');
  }
  try { return new TextDecoder(charset || 'utf-8').decode(bytes); }
  catch (_) { return bytes.toString('utf8'); }
}

/* 一通を読める形にする。本文は text/plain 優先、無ければ text/html からタグを落とす。
   添付は**開かない** —— 店主に読ませたいのは文面で、実行可能な物をこの機械に降ろす理由が無い。 */
function parseMessage(raw) {
  const sep = raw.indexOf(`${CRLF}${CRLF}`);
  const headText = sep < 0 ? raw : raw.slice(0, sep);
  const bodyText = sep < 0 ? '' : raw.slice(sep + 4);
  const heads = {};
  for (const l of headText.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = l.indexOf(':');
    if (i > 0) heads[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
  }
  const ctype = heads['content-type'] || 'text/plain';
  const charset = (/charset="?([^;"\s]+)/i.exec(ctype) || [])[1] || 'utf-8';
  const enc = heads['content-transfer-encoding'] || '';

  let body = '';
  /* 退信(multipart/report)は人が読む段がもう一枚 multipart/alternative に包まれて降りてくる。
     一枚しか剥がさないと、その段の頭が multipart/… としか書いておらず本文が空で返る ——
     店主には「開いたのに真っ白」としか見えない。だから multipart に当たったら中へ潜る。
     message/rfc822(退された元の手紙)へは潜らない: 欲しいのは退信の説明文で、元の文面ではない。 */
  const pickFrom = (text, head, want) => {
    const b = (/boundary="?([^;"\s]+)/i.exec(head) || [])[1];
    if (!b) return '';
    for (const p of text.split(`--${b}`)) {
      const ps = p.indexOf(`${CRLF}${CRLF}`);
      if (ps < 0) continue;
      const ph = p.slice(0, ps).toLowerCase();
      if (ph.includes('multipart/')) {
        const inner = pickFrom(p.slice(ps + 4), ph, want);
        if (inner) return inner;
        continue;
      }
      if (!ph.includes(want)) continue;
      const pcs = (/charset="?([^;"\s]+)/i.exec(ph) || [])[1] || charset;
      const penc = (/content-transfer-encoding:\s*(\S+)/i.exec(ph) || [])[1] || '';
      return decodeBody(p.slice(ps + 4), pcs, penc);
    }
    return '';
  };
  if (/boundary="?[^;"\s]+/i.test(ctype)) {
    body = pickFrom(bodyText, ctype, 'text/plain') || pickFrom(bodyText, ctype, 'text/html');
  } else {
    body = decodeBody(bodyText, charset, enc);
  }
  if (/<[a-z][\s\S]*>/i.test(body) && !/text\/plain/i.test(ctype)) {
    body = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return {
    subject: decodeHeader(heads.subject),
    from: decodeHeader(heads.from),
    date: heads.date || '',
    body: body.trim(),
  };
}

// ── POP3 ────────────────────────────────────────────────────────────
async function popOpen({ host, port = 995, user, pass, secure = true }) {
  let s = await connect({ host, port, secure });
  let hello = await s.line();
  if (!hello.startsWith('+OK')) throw mailFail('no_greeting', `POP3 did not greet: ${hello}`, { detail: hello });
  if (!secure) {
    // 110 番の平文口。STLS で上げてから認証する —— 生のまま合言葉を流さない。
    s.send('STLS');
    const r = await s.line();
    if (!r.startsWith('+OK')) throw mailFail('no_stls', 'this POP3 server does not support STLS');
    s = await s.upgrade(host);
    hello = '';
  }
  s.send(`USER ${user}`);
  if (!(await s.line()).startsWith('+OK')) { s.end(); throw mailFail('auth_user', 'POP3 rejected the user name'); }
  s.send(`PASS ${pass}`);
  if (!(await s.line()).startsWith('+OK')) { s.end(); throw mailFail('auth_failed', 'POP3 authentication failed'); }
  return s;
}

async function popUidls(s) {
  s.send('UIDL');
  const head = await s.line();
  if (!head.startsWith('+OK')) return new Map();   // 応えないサーバも居る
  const body = await s.multiline();
  const map = new Map();
  for (const l of body.split(CRLF)) {
    const [num, uid] = l.trim().split(/\s+/);
    if (num && uid) map.set(Number(num), uid);
  }
  return map;
}

async function popRetr(s, num) {
  s.send(`RETR ${num}`);
  const head = await s.line();
  if (!head.startsWith('+OK')) throw mailFail('retr_failed', `RETR ${num}: ${head}`, { detail: head });
  return s.multiline();
}

/* 最近の n 通。**本文は返さない**(抜粋だけ) —— 二十通の店で毎回全文を引くと、
   一覧を開くたびにそれだけ待たされる。 */
async function list(conf, { limit = 10 } = {}) {
  const s = await popOpen(conf);
  try {
    s.send('STAT');
    const stat = await s.line();
    const count = Number((stat.split(/\s+/)[1] || 0));
    if (!count) return { emails: [], count: 0 };
    const uids = await popUidls(s);
    const out = [];
    for (let i = count; i > Math.max(count - limit, 0); i -= 1) {
      try {
        const msg = parseMessage(await popRetr(s, i));
        out.push({ id: i, uid: uids.get(i) || null, subject: msg.subject, from: msg.from,
                   date: msg.date, snippet: msg.body.slice(0, 120) });
      } catch (_) { /* 一通壊れていても残りは見せる */ }
    }
    s.send('QUIT');
    return { emails: out, count: out.length };
  } finally { s.end(); }
}

// 一通の全文。uid で指す(番号は uid の無いサーバ向けの控え)。
async function read(conf, { uid, mail_id } = {}) {
  const s = await popOpen(conf);
  try {
    s.send('STAT');
    const count = Number(((await s.line()).split(/\s+/)[1] || 0));
    const uids = await popUidls(s);
    let target = Number(mail_id) || 0;
    if (uid) {
      const hit = [...uids.entries()].find(([, u]) => u === uid);
      // 消された物は**隣を開かない**。無くなったと言われた方が店主は困らない。
      if (!hit) throw mailFail('mail_gone', 'that mail is no longer in the mailbox');
      target = hit[0];
    }
    if (!target || target < 1 || target > count) {
      throw mailFail('bad_index', `no mail #${target} in the mailbox (${count} total)`,
                     { index: target, count });
    }
    const msg = parseMessage(await popRetr(s, target));
    s.send('QUIT');
    return { id: target, uid: uid || uids.get(target) || null, ...msg };
  } finally { s.end(); }
}

// ── SMTP ────────────────────────────────────────────────────────────
async function smtpCmd(s, cmd, okCode = /^2\d\d/) {
  if (cmd != null) s.send(cmd);
  let l = await s.line();
  // 複数行応答(250-…)は最後の一行まで読み切る
  while (/^\d\d\d-/.test(l)) l = await s.line();
  if (!okCode.test(l)) throw mailFail('smtp_error', `SMTP: ${cmd || 'greeting'} → ${l}`, { detail: l });
  return l;
}

function encodeHeaderWord(s) {
  // ASCII だけならそのまま。日本語の件名は B 符号化(受け側の互換が一番広い)。
  return /^[\x20-\x7E]*$/.test(s) ? s
    : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

async function send(conf, { to, subject, body, from }) {
  const port = conf.port || 587;
  const secure = port === 465;
  let s = await connect({ host: conf.host, port, secure });
  try {
    await smtpCmd(s, null);                                  // 挨拶
    await smtpCmd(s, 'EHLO localhost');
    if (!secure && conf.starttls !== false) {
      await smtpCmd(s, 'STARTTLS');
      s = await s.upgrade(conf.host);
      await smtpCmd(s, 'EHLO localhost');
    }
    if (conf.user) {
      // Keep auth out of the generic smtp_error bucket: "wrong password" is the
      // failure owners actually hit, and a raw SMTP reply makes a fixable problem
      // look unfixable.
      try {
        await smtpCmd(s, 'AUTH LOGIN', /^334/);
        await smtpCmd(s, Buffer.from(conf.user, 'utf8').toString('base64'), /^334/);
        await smtpCmd(s, Buffer.from(conf.pass || '', 'utf8').toString('base64'), /^235/);
      } catch (e) {
        throw mailFail('auth_failed', `SMTP authentication failed — ${e.message}`,
                       { detail: e.message });
      }
    }
    const sender = from || conf.from || conf.user;
    await smtpCmd(s, `MAIL FROM:<${sender}>`);
    await smtpCmd(s, `RCPT TO:<${to}>`);
    await smtpCmd(s, 'DATA', /^354/);
    const head = [
      `From: ${sender}`, `To: ${to}`, `Subject: ${encodeHeaderWord(String(subject || ''))}`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64', '',
    ].join(CRLF);
    const b64 = Buffer.from(String(body || ''), 'utf8').toString('base64').replace(/(.{76})/g, `$1${CRLF}`);
    s.send(`${head}${b64}${CRLF}.`);
    await smtpCmd(s, null);
    await smtpCmd(s, 'QUIT', /^2\d\d/).catch(() => {});
    return { ok: true, to };
  } finally { s.end(); }
}

module.exports = { list, read, send, parseMessage, decodeHeader, _connect: connect };
