// update-check.js — 个人版检查升级: 有新版就在窗口顶上挂一行提示, 人点了才去下载(不自动下载安装, 作者 11-10 定)。
// 启动 1 分钟后查一次, 之后每 6 小时查一次。查 GitHub 最新 release 的版本号:
// 先问 API, 不通再看 releases/latest 跳转到哪个 tag(两条路都走 Electron 的 net.fetch, 跟 app 的代理设置)。
// 「下载」开对应平台的安装包直链, 「备用镜像」走 gh-proxy(与官网下载区同一种写法), 「忽略这版」记进 <控制目录>/update-check.json。
const fs = require('fs');
const path = require('path');

const REPO = 'fantasyxxj/aibutler';
const FIRST_DELAY = 60 * 1000;
const EVERY = 6 * 60 * 60 * 1000;
const TIMEOUT = 10 * 1000;

// '1.1.10' > '1.1.9'; 带 v 前缀、预发布后缀都按数字段比
function newer(a, b) {
  const p = (v) => String(v || '').replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

// 安装包文件名与 scripts/dist.js 产物、官网下载区一致
function assetName(ver, platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return `aibutler-${ver}-setup.exe`;
  if (platform === 'darwin') return `aibutler-${ver}-${arch === 'arm64' ? 'arm64' : 'x64'}.dmg`;
  return null;
}

function links(ver) {
  const page = `https://github.com/${REPO}/releases/tag/v${ver}`;
  const a = assetName(ver);
  const direct = a ? `https://github.com/${REPO}/releases/download/v${ver}/${a}` : page;
  return { page, direct, mirror: `https://gh-proxy.com/${direct}` };
}

function create({ fetch, current, stateFile, sendUI, openExternal, log = () => {} }) {
  let latest = null;          // 查到的比当前新的版本号; 没有就是 null
  let timer = null;

  const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch (_) { return {}; } };
  const writeState = (s) => { try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s, null, 2)); } catch (_) {} };

  async function get(url, opts = {}) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT);
    try { return await fetch(url, { ...opts, signal: ac.signal, headers: { 'User-Agent': 'aibutler-update-check', ...(opts.headers || {}) } }); }
    finally { clearTimeout(t); }
  }

  async function lookup() {
    try {
      const r = await get(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
      if (r.ok) { const j = await r.json(); if (j && j.tag_name) return String(j.tag_name).replace(/^v/i, ''); }
    } catch (_) { /* 换下一条路 */ }
    const r = await get(`https://github.com/${REPO}/releases/latest`, { redirect: 'manual' });
    const m = /\/releases\/tag\/v?([\w.-]+)/.exec(r.headers.get('location') || r.url || '');
    return m ? m[1] : null;
  }

  // 给界面的: 有就带版本号和链接, 被忽略的那版不报
  function view() {
    if (!latest || readState().ignored === latest) return { latest: null };
    return { latest, current, ...links(latest) };
  }

  async function check() {
    try {
      const v = await lookup();
      latest = v && newer(v, current) ? v : null;
      log(`[update-check] 当前 ${current} · 最新 ${v || '查不到'}${latest ? ' · 有新版' : ''}`);
    } catch (e) { log(`[update-check] 查不到: ${e && e.message}`); }
    sendUI('update-available', view());
  }

  function act({ action } = {}) {
    const v = view();
    if (!v.latest) return { ok: false };
    if (action === 'ignore') { writeState({ ...readState(), ignored: v.latest }); sendUI('update-available', view()); return { ok: true }; }
    if (action === 'download' || action === 'mirror') { openExternal(action === 'mirror' ? v.mirror : v.direct); return { ok: true }; }
    return { ok: false };
  }

  function start() {
    if (timer) return;
    timer = setTimeout(function tick() { check(); timer = setTimeout(tick, EVERY); }, FIRST_DELAY);
  }
  function stop() { clearTimeout(timer); timer = null; }

  return { start, stop, check, view, act };
}

// 主进程一行接上: 建起来、挂两个 IPC(update-get / update-act)、开始定时查
function wire({ ipcMain, sendUI, controlDir, log }) {
  const { app, net, shell } = require('electron');
  const u = create({ fetch: (url, o) => net.fetch(url, o), current: app.getVersion(), stateFile: path.join(controlDir, 'update-check.json'),
    sendUI, openExternal: (url) => shell.openExternal(url), log });
  ipcMain.handle('update-get', async () => u.view());
  ipcMain.handle('update-act', async (_e, a) => u.act(a));
  return u;
}

module.exports = { create, wire, newer, assetName, links };
