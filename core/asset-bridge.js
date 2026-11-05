'use strict';
// asset-bridge.js — asset 原语: 插件读本地图片 / 音频 / 视频。
//
// 平台只管「能读哪些文件」, 怎么显示、怎么播由插件自己用 <img> <audio> <video> 做。
// 能读的只有两处:
//   1) 包自己的素材目录 <root>/<包id>/ 下的文件, 按相对名读, 不用授权;
//   2) 用户在系统打开框里亲手挑过的文件, 按包记在授权表里, 包只拿到 ref, 拿不到路径。
// 交给包的是 butler-asset://a/<令牌>/<文件名> 这种地址; 令牌只在本次运行里有效。
// 沙箱 CSP 只放 img-src / media-src, 包能显示能播, fetch 不到原始字节。
// 🔴 本文件不 require electron —— 选文件框由宿主注入, Response 用 node 自带的, 纯 node 下测得动。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const SCHEME = 'butler-asset';
const SCHEME_DESC = { scheme: SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } };

const KINDS = {
  image: { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' },
  audio: { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', opus: 'audio/ogg' },
  video: { mp4: 'video/mp4', webm: 'video/webm', m4v: 'video/mp4', mov: 'video/quicktime' },
};
const OPS = ['list', 'url', 'pick', 'forget'];
const PKG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const REF_RE = /^[0-9a-z]{10}$/;
const MAX_LIST = 500;
const MAX_TOKENS = 2000;

function typeOf(file) {
  const ext = path.extname(String(file)).slice(1).toLowerCase();
  for (const [kind, map] of Object.entries(KINDS)) if (map[ext]) return { kind, mime: map[ext] };
  return null;
}

// 包给的相对名 → 素材目录里的真实文件; 越界、软链出界、扩展名不认 → null
function resolveAsset(root, pkg, name) {
  const n = String(name || '');
  if (!n || n.includes('\0') || path.isAbsolute(n) || n.split(/[\\/]/).includes('..')) return null;
  if (!typeOf(n)) return null;
  let base, real;
  try {
    base = fs.realpathSync(path.join(root, pkg));
    real = fs.realpathSync(path.join(base, n));
  } catch (_) { return null; }
  if (real !== base && !real.startsWith(base + path.sep)) return null;
  try { if (!fs.statSync(real).isFile()) return null; } catch (_) { return null; }
  return real;
}

function walk(base, rel = '', out = []) {
  let ents = [];
  try { ents = fs.readdirSync(path.join(base, rel), { withFileTypes: true }); } catch (_) { return out; }
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= MAX_LIST) break;
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(base, r, out);
    else if (e.isFile() && typeOf(e.name)) out.push(r);
  }
  return out;
}

/** root() = 素材根目录; grantsFile() = 授权表路径; pickFiles(filters) = 弹系统打开框, 回选中的绝对路径数组 */
function create({ root, grantsFile, pickFiles }) {
  const tokens = new Map();   // 令牌 → { pkg, file }

  const readGrants = () => { try { return JSON.parse(fs.readFileSync(grantsFile(), 'utf8')) || {}; } catch (_) { return {}; } };
  const writeGrants = (g) => {
    fs.mkdirSync(path.dirname(grantsFile()), { recursive: true });
    fs.writeFileSync(grantsFile(), JSON.stringify(g, null, 2));
  };
  const info = (file, extra) => {
    const t = typeOf(file);
    let size = null;
    try { size = fs.statSync(file).size; } catch (_) {}
    return { ...extra, kind: t && t.kind, size, missing: size == null || undefined };
  };

  function issue(pkg, file) {
    const token = crypto.randomBytes(18).toString('hex');
    tokens.set(token, { pkg, file });
    while (tokens.size > MAX_TOKENS) tokens.delete(tokens.keys().next().value);
    return `${SCHEME}://a/${token}/${encodeURIComponent(path.basename(file))}`;
  }

  async function handle(pkg, op, args = {}, decl = {}) {
    if (!PKG_RE.test(String(pkg || ''))) return { ok: false, code: 'bad_pkg', message: 'asset: 包 id 不合法' };
    if (!OPS.includes(op)) return { ok: false, code: 'bad_decl', message: `asset: op 只能是 ${OPS.join(' / ')}` };
    const mine = readGrants()[pkg] || {};

    if (op === 'list') {
      const base = path.join(root(), pkg);
      const assets = walk(base).map((name) => info(path.join(base, name), { name }));
      const picked = Object.entries(mine).map(([ref, g]) => info(g.path, { ref, name: g.name }));
      return { ok: true, data: { assets, picked } };
    }

    if (op === 'url') {
      const ref = String(args.ref || '').trim();
      let file = null, name = '';
      if (ref) {
        if (!REF_RE.test(ref) || !mine[ref]) return { ok: false, code: 'not_granted', message: `asset: 没有这个 ref ${ref}` };
        file = mine[ref].path; name = mine[ref].name;
        if (!typeOf(file) || !fs.existsSync(file)) return { ok: false, code: 'asset_missing', message: `asset: 文件已不在 ${name}` };
      } else {
        name = String(args.name || '').trim();
        if (!name) return { ok: false, code: 'missing_param', message: 'asset: 要给 name(素材目录里的相对名)或 ref(pick 交回的)' };
        file = resolveAsset(root(), pkg, name);
        if (!file) return { ok: false, code: 'asset_not_found', message: `asset: 素材目录里没有能读的 ${name}` };
      }
      const t = typeOf(file);
      return { ok: true, data: { url: issue(pkg, file), name, kind: t.kind, mime: t.mime } };
    }

    if (op === 'pick') {
      if (typeof pickFiles !== 'function') return { ok: false, code: 'no_window', message: 'asset: 没有可弹选择框的窗口' };
      const want = Array.isArray(decl.kinds) ? decl.kinds.filter((k) => KINDS[k]) : [];
      const kinds = want.length ? want : Object.keys(KINDS);
      const exts = kinds.flatMap((k) => Object.keys(KINDS[k]));
      const chosen = (await pickFiles([{ name: kinds.join(' / '), extensions: exts }])) || [];
      const all = readGrants();
      const cur = all[pkg] || {};
      const picked = [];
      for (const file of chosen) {
        const t = typeOf(file);
        if (!t || !kinds.includes(t.kind)) continue;
        const had = Object.entries(cur).find(([, g]) => g.path === file);
        const ref = had ? had[0] : crypto.randomBytes(5).toString('hex');
        cur[ref] = { path: file, name: path.basename(file), at: new Date().toISOString() };
        picked.push(info(file, { ref, name: cur[ref].name }));
      }
      if (picked.length) { all[pkg] = cur; writeGrants(all); }
      return { ok: true, data: { picked } };
    }

    // forget
    const ref = String(args.ref || '').trim();
    if (!REF_RE.test(ref)) return { ok: false, code: 'bad_param', message: 'asset: forget 要给 ref' };
    const all = readGrants();
    if (all[pkg] && all[pkg][ref]) {
      const file = all[pkg][ref].path;
      delete all[pkg][ref];
      if (!Object.keys(all[pkg]).length) delete all[pkg];
      writeGrants(all);
      for (const [t, v] of tokens) if (v.pkg === pkg && v.file === file) tokens.delete(t);
    }
    return { ok: true, data: { ref } };
  }

  /* 协议入口: 按令牌找文件, 支持 Range(拖进度条只读那一段)。宿主 protocol.handle 直接回它。 */
  function respond(url, rangeHeader) {
    let token = '';
    try { token = new URL(url).pathname.split('/')[1] || ''; } catch (_) {}
    const hit = tokens.get(token);
    const t = hit && typeOf(hit.file);
    let size = -1;
    try { if (t) size = fs.statSync(hit.file).size; } catch (_) {}
    if (size < 0) return new Response('not found', { status: 404 });
    const head = { 'Content-Type': t.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader || '').trim());
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size || start > end) return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      const body = Readable.toWeb(fs.createReadStream(hit.file, { start, end }));
      return new Response(body, { status: 206, headers: { ...head, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` } });
    }
    return new Response(Readable.toWeb(fs.createReadStream(hit.file)), { status: 200, headers: { ...head, 'Content-Length': String(size) } });
  }

  return { handle, respond };
}

module.exports = { create, resolveAsset, typeOf, KINDS, OPS, SCHEME, SCHEME_DESC };
