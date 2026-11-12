// data-move.js — 系统设置「高级 → 数据位置」: 显示路径 · 打开文件夹 · 搬到别处 · 清理旧数据。
//
// 搬家分两步, 中间隔一次重启:
//   ① 设置页点「搬到别处」→ 选目录、确认 → 在引导位记一张单子 data-move.json {from, to}, 然后重启 app。
//      正常退出会把所有人格停干净(含退出沉淀), 所以复制时没有任何东西还在往旧目录写。
//   ② 下次启动、任何人格起来之前(main.js 启动链 checkAll 之前)执行单子: 整份复制 → 改写新目录里
//      记着旧路径的几个文件 → 复制成功才改指针。中途失败指针不动, 旧目录一个字不碰, 新目录里半截的删掉。
//   旧目录保留, 搬成功后在引导位记 data-move-old.json {dir}; 设置页据此露出「清理旧数据」, 由程序只把当初复制过的
//   条目移进回收站 —— 旧目录若正是默认位(引导位本身), 指针和 main.log 还在里面, 整个删掉 app 就找不到数据了。
//   搬家和清理互斥: 有搬家单未执行不许清 · 清理中不许搬 · 上次的旧数据没清完不许直接再搬(用户确认保留才放行)。
//   三道闸里的「整份复制成功才改指针」是同一条规矩, 见 data-dir-guard.js。
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
const OLD_NAME = 'data-move-old.json';
const orderFile = () => path.join(paths.bootstrapDir(), ORDER_NAME);
const oldFile = () => path.join(paths.bootstrapDir(), OLD_NAME);
const locale = () => i18n.normalizeLocale(settings.read().language) || i18n.normalizeLocale(app && app.getLocale()) || i18n.DEFAULT_LOCALE;
let relaunch = () => { app.relaunch(); app.quit(); };   // 启动链换成 main.js 的退出链(停人格 + 退出沉淀)
const canMove = () => paths.isPackaged() || process.env.BUTLER_SIMULATE_INSTALL === '1';

// 不跟着搬的: Electron 自己的缓存与单实例锁(默认数据目录就是 userData, 这些都住在里面), 指针和搬家单本身。
const SKIP = new Set(['data-location.json', ORDER_NAME, OLD_NAME, 'electron-profile', 'Cache', 'Code Cache', 'GPUCache', 'DawnCache',
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

const inside = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
const overlaps = (a, b) => { a = path.resolve(a); b = path.resolve(b); return inside(a, b) || inside(b, a); };

// 上次搬家留下、还没清的旧目录; 已经不在 / 没数据了 / 跟当前目录重叠的记录作废并撕掉。返回路径或 null
function pendingOld() {
  let dir = null;
  try { dir = JSON.parse(fs.readFileSync(oldFile(), 'utf8')).dir; } catch (_) { return null; }
  if (dir && hasData(dir) && !overlaps(dir, paths.dataDir())) return dir;
  forgetOld();
  return null;
}
function forgetOld() { try { fs.unlinkSync(oldFile()); } catch (_) {} }

// 旧目录里要清的条目 = 当初会被复制的那些(SKIP 之外); 旧目录正是引导位(默认位)时, main.log 和 logs/ 正被这次运行写着, 也留下
function oldEntries(dir) {
  const live = path.resolve(dir) === path.resolve(paths.bootstrapDir()) ? new Set(['main.log', 'logs']) : new Set();
  return fs.readdirSync(dir).filter((n) => !SKIP.has(n) && !live.has(n)).map((n) => path.join(dir, n));
}

let cleaning = false;
// 把旧数据逐项交给 trash(主进程是 shell.trashItem, 门禁换成假的)。全清掉才撕记录。返回 { ok, failed:[路径] } 或 { ok:false, error }
async function cleanOld(trash, s) {
  if (fs.existsSync(orderFile())) return { ok: false, error: s.old_busy_move };
  const dir = pendingOld();
  if (!dir) return { ok: false, error: s.old_gone };
  cleaning = true;
  const failed = [];
  try {
    for (const f of oldEntries(dir)) {
      try { await trash(f); } catch (e) { console.error('[data-move] 移进回收站失败:', f, e && e.message); failed.push(f); }
    }
  } finally { cleaning = false; }
  if (failed.length) return { ok: false, failed };
  forgetOld();
  if (path.resolve(dir) !== path.resolve(paths.bootstrapDir())) try { fs.rmdirSync(dir); } catch (_) {}   // 只剩空壳才删得掉
  console.log(`[data-move] 旧数据已移进回收站: ${dir}`);
  return { ok: true, dir };
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
    try { fs.writeFileSync(oldFile(), JSON.stringify({ dir: from, at: new Date().toISOString() }, null, 2), 'utf8'); } catch (_) {}
  } catch (e) {
    console.error('[data-move] 搬迁失败, 指针未动:', e && e.message);
    if (created) try { fs.rmSync(to, { recursive: true, force: true }); } catch (_) {}
    say({ type: 'warning', buttons: [s.ok], title: s.at_risk_failed_title, message: s.at_risk_failed_title,
      detail: i18n.fmt(s.at_risk_failed, { err: (e && e.message) || '' }) });
    return false;
  }
  say({ type: 'info', buttons: [s.ok], title: s.at_risk_done_title,
    message: i18n.fmt(s.at_risk_done_message, { dir: to }), detail: i18n.fmt(s.move_done_detail, { dir: from }) });
  return true;
}

// 门禁在纯 node 下 require 本文件测 resolveDest / rewritePaths, 那里没有 ipcMain
if (ipcMain) {
  // oldDir: 有就露出「清理旧数据」; 搬家单还没执行(本该已经在重启)时不给
  ipcMain.handle('data-dir-info', async () => ({ dir: paths.dataDir(), canMove: canMove(), oldDir: fs.existsSync(orderFile()) ? null : pendingOld() }));
  ipcMain.handle('data-dir-open', async () => { const e = await shell.openPath(paths.dataDir()); return { ok: !e, error: e }; });

  // ① 设置页「搬到别处」: 选目录 → 确认 → 写单子 → 重启。返回 { ok:false, error } 或 { ok:false } (取消); 成功就不返回了(在重启)
  ipcMain.handle('data-dir-move', async (e) => {
    if (!canMove()) return { ok: false, error: 'dev' };
    const s = strings(locale());
    if (cleaning) return { ok: false, error: s.move_busy_clean };
    const win = BrowserWindow.fromWebContents(e.sender);
    const cur = paths.dataDir();
    const old = pendingOld();
    if (old) {
      const k = await dialog.showMessageBox(win, { type: 'question', buttons: [s.old_keep_go, s.move_cancel], defaultId: 1, cancelId: 1,
        title: s.move_confirm_title, message: i18n.fmt(s.old_pending_message, { dir: old }), detail: s.old_pending_detail });
      if (k.response !== 0) return { ok: false };
      forgetOld();   // 用户选了保留: 那份从此归他自己管, 不再挂在按钮上
    }
    const r = await dialog.showOpenDialog(win, { title: s.at_risk_picker, defaultPath: path.dirname(cur), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false };
    const d = resolveDest(r.filePaths[0], cur, s);
    // 拦下的理由弹框说, 不交给设置页的 toast: 那条只闪 1.8 秒, 系统选目录框一关就过去了, 用户以为没拦(11-11 老黄实测)
    if (!d.ok) { await dialog.showMessageBox(win, { type: 'warning', message: d.error, buttons: ['OK'] }); return { ok: false }; }
    const c = await dialog.showMessageBox(win, { type: 'question', buttons: [s.move_go, s.move_cancel], defaultId: 0, cancelId: 1,
      title: s.move_confirm_title, message: i18n.fmt(s.move_confirm_message, { from: cur, to: d.dest }), detail: s.move_confirm_detail });
    if (c.response !== 0) return { ok: false };
    fs.mkdirSync(paths.bootstrapDir(), { recursive: true });
    fs.writeFileSync(orderFile(), JSON.stringify({ from: cur, to: d.dest, at: new Date().toISOString() }, null, 2), 'utf8');
    console.log(`[data-move] 已记搬家单 ${cur} → ${d.dest}, 重启执行`);
    relaunch();
    return { ok: true };
  });

  // 「清理旧数据」: 确认 → 逐项移进回收站 → 报结果。返回 { ok } / { ok:false, error? }
  ipcMain.handle('data-dir-clean-old', async (e) => {
    const s = strings(locale());
    const win = BrowserWindow.fromWebContents(e.sender);
    const dir = pendingOld();
    if (!dir || cleaning) return { ok: false };
    const c = await dialog.showMessageBox(win, { type: 'question', buttons: [s.old_go, s.move_cancel], defaultId: 0, cancelId: 1,
      title: s.old_confirm_title, message: i18n.fmt(s.old_confirm_message, { dir }), detail: s.old_confirm_detail });
    if (c.response !== 0) return { ok: false };
    const r = await cleanOld((f) => shell.trashItem(f), s);
    if (r.ok) await dialog.showMessageBox(win, { type: 'info', buttons: [s.ok], message: s.old_done });
    else await dialog.showMessageBox(win, { type: 'warning', buttons: [s.ok], message: r.error
      || i18n.fmt(s.old_failed, { n: r.failed.length, list: r.failed.slice(0, 8).join('\n') }) });
    return { ok: r.ok };
  });
}

module.exports = { applyPending, resolveDest, rewritePaths, filesWithPaths, pendingOld, cleanOld, oldEntries };
