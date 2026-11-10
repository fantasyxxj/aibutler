// data-move.js — 系统设置「高级 → 数据位置」: 显示路径 · 打开文件夹 · 搬到别处。
//
// 搬家分两步, 中间隔一次重启:
//   ① 设置页点「搬到别处」→ 选目录、确认 → 在引导位记一张单子 data-move.json {from, to}, 然后重启 app。
//      正常退出会把所有人格停干净(含退出沉淀), 所以复制时没有任何东西还在往旧目录写。
//   ② 下次启动、任何人格起来之前(main.js 启动链 checkAll 之前)执行单子: 整份复制 → 改写新目录里
//      记着旧路径的几个文件 → 复制成功才改指针。中途失败指针不动, 旧目录一个字不碰, 新目录里半截的删掉。
//   旧目录保留, 用户确认没问题后自己删。三道闸里的「整份复制成功才改指针」是同一条规矩, 见 data-dir-guard.js。
//
// 只有打包版(或 BUTLER_SIMULATE_INSTALL=1 的 dev)有指针可改; 其余 dev 的数据目录由 BUTLER_DATA_DIR 定, 不给搬。
'use strict';

const fs = require('fs');
const path = require('path');
const { app, dialog, shell, ipcMain, BrowserWindow } = require('electron');
const paths = require('./paths');
const settings = require('./settings');
const i18n = require('./i18n');
const { strings } = require('./i18n-datadir');
const { hasData } = require('./data-dir-guard');

const ORDER_NAME = 'data-move.json';
const orderFile = () => path.join(paths.bootstrapDir(), ORDER_NAME);
const locale = () => i18n.normalizeLocale(settings.read().language) || i18n.normalizeLocale(app && app.getLocale()) || i18n.DEFAULT_LOCALE;
let relaunch = () => { app.relaunch(); app.quit(); };   // 启动链换成 main.js 的退出链(停人格 + 退出沉淀)
const canMove = () => paths.isPackaged() || process.env.BUTLER_SIMULATE_INSTALL === '1';

// 不跟着搬的: Electron 自己的缓存与单实例锁(默认数据目录就是 userData, 这些都住在里面), 指针和搬家单本身。
const SKIP = new Set(['data-location.json', ORDER_NAME, 'electron-profile', 'Cache', 'Code Cache', 'GPUCache', 'DawnCache',
  'DawnGraphiteCache', 'DawnWebGPUCache', 'Crashpad', 'Session Storage', 'Local Storage', 'blob_storage', 'Shared Dictionary',
  'SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile']);

// 写着数据目录绝对路径的文件: 登记簿里人格的 homeDir · 开着的标签 · 看板 · 人格自己的 persona.md(运行环境那几行)
function filesWithPaths(dir) {
  const app_ = path.join(dir, 'app');
  const out = ['personas.json', '.opentabs.json', 'board-state.json'].map((f) => path.join(app_, f));
  try {
    for (const p of fs.readdirSync(path.join(dir, 'personas'))) out.push(path.join(dir, 'personas', p, '.claude', 'memory', 'persona.md'));
  } catch (_) {}
  return out.filter((f) => fs.existsSync(f));
}

// 新目录里把旧路径前缀换成新的。JSON 里的路径是转义过的(Windows 反斜杠成双), 两种写法都换。
function rewritePaths(from, to) {
  const pairs = [[from, to], [JSON.stringify(from).slice(1, -1), JSON.stringify(to).slice(1, -1)]];
  let n = 0;
  for (const f of filesWithPaths(to)) {
    const s = fs.readFileSync(f, 'utf8');
    let r = s;
    for (const [a, b] of pairs) if (a !== b) r = r.split(a).join(b);
    if (r !== s) { fs.writeFileSync(f, r, 'utf8'); n++; }
  }
  return n;
}

// 选的目录能不能用。非空又不是数据目录的(比如选了 D:\) → 在里面建一个子目录装。返回 { ok, dest } 或 { ok:false, error }
function resolveDest(picked, cur, s) {
  const p = path.resolve(picked);
  const c = path.resolve(cur);
  if (paths.isUnderInstallRoot(p)) return { ok: false, error: s.at_risk_still_unsafe };
  let dest = p;
  let empty = true;
  try { empty = fs.readdirSync(p).filter((f) => !f.startsWith('.')).length === 0; } catch (_) {}
  if (!empty) {
    if (hasData(p)) return { ok: false, error: s.move_has_data };
    dest = path.join(p, 'ButlerData');
    if (fs.existsSync(dest)) return { ok: false, error: i18n.fmt(s.move_exists, { dir: dest }) };
  }
  const inside = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
  if (inside(dest, c) || inside(c, dest)) return { ok: false, error: s.move_same };
  return { ok: true, dest };
}

// ② 启动链调: 有搬家单就执行。要早于任何登记簿读写。opts.relaunch = main.js 的重启(走退出链)
function applyPending(opts = {}) {
  if (opts.relaunch) relaunch = opts.relaunch;
  const say = opts.say || ((o) => dialog.showMessageBoxSync(o));   // 门禁换成记下来, 不弹框
  let order = null;
  try { order = JSON.parse(fs.readFileSync(orderFile(), 'utf8')); } catch (_) { return; }
  try { fs.unlinkSync(orderFile()); } catch (_) {}   // 先撕单子: 不管成败都只试这一次, 不会每次启动都搬
  const s = strings(locale());
  const { from, to } = order || {};
  if (!from || !to || path.resolve(paths.dataDir()) !== path.resolve(from)) { console.error('[data-move] 单子和当前数据目录对不上, 不搬:', order); return; }
  const created = !fs.existsSync(to);
  try {
    console.log(`[data-move] 复制 ${from} → ${to}`);
    fs.cpSync(from, to, { recursive: true, force: true, errorOnExist: false,
      filter: (src) => src === from || !SKIP.has(path.basename(src)) });
    console.log(`[data-move] 改写路径 ${rewritePaths(from, to)} 个文件`);
    paths.setDataDir(to);
  } catch (e) {
    console.error('[data-move] 搬迁失败, 指针未动:', e && e.message);
    if (created) try { fs.rmSync(to, { recursive: true, force: true }); } catch (_) {}
    say({ type: 'warning', buttons: [s.ok], title: s.at_risk_failed_title, message: s.at_risk_failed_title,
      detail: i18n.fmt(s.at_risk_failed, { err: (e && e.message) || '' }) });
    return false;
  }
  say({ type: 'info', buttons: [s.ok], title: s.at_risk_done_title,
    message: i18n.fmt(s.at_risk_done_message, { dir: to }), detail: i18n.fmt(s.at_risk_done_detail, { dir: from }) });
  return true;
}

// 门禁在纯 node 下 require 本文件测 resolveDest / rewritePaths, 那里没有 ipcMain
if (ipcMain) {
  ipcMain.handle('data-dir-info', async () => ({ dir: paths.dataDir(), canMove: canMove() }));
  ipcMain.handle('data-dir-open', async () => { const e = await shell.openPath(paths.dataDir()); return { ok: !e, error: e }; });

  // ① 设置页「搬到别处」: 选目录 → 确认 → 写单子 → 重启。返回 { ok:false, error } 或 { ok:false } (取消); 成功就不返回了(在重启)
  ipcMain.handle('data-dir-move', async (e) => {
    if (!canMove()) return { ok: false, error: 'dev' };
    const s = strings(locale());
    const win = BrowserWindow.fromWebContents(e.sender);
    const cur = paths.dataDir();
    const r = await dialog.showOpenDialog(win, { title: s.at_risk_picker, defaultPath: path.dirname(cur), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false };
    const d = resolveDest(r.filePaths[0], cur, s);
    if (!d.ok) return d;
    const c = await dialog.showMessageBox(win, { type: 'question', buttons: [s.move_go, s.move_cancel], defaultId: 0, cancelId: 1,
      title: s.move_confirm_title, message: i18n.fmt(s.move_confirm_message, { from: cur, to: d.dest }), detail: s.move_confirm_detail });
    if (c.response !== 0) return { ok: false };
    fs.mkdirSync(paths.bootstrapDir(), { recursive: true });
    fs.writeFileSync(orderFile(), JSON.stringify({ from: cur, to: d.dest, at: new Date().toISOString() }, null, 2), 'utf8');
    console.log(`[data-move] 已记搬家单 ${cur} → ${d.dest}, 重启执行`);
    relaunch();
    return { ok: true };
  });
}

module.exports = { applyPending, resolveDest, rewritePaths, filesWithPaths };
