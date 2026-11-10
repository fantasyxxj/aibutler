// theme-ipc.js — 外观设置的主进程那一半, 自注册(main.js 只 require 一下): 界面深浅色(跟随系统 / 浅色 / 深色)
// · 顶栏「key · 模型 ▾」快速切换显不显示(settings.quickModelSwitch, 默认关, 作者 11-07)
// · 对话里显不显示工具调用条(settings.showToolCalls, 默认关, 作者 11-09)。
//
// 不往页面里挂 class: 改 nativeTheme.themeSource, 所有窗口连同插件 iframe 的
// prefers-color-scheme 当场跟着变, theme.css 两套 token 靠媒体查询切 —— 新开的窗口、
// 启动小窗、第三方插件都不用各自接一遍 IPC。系统弹框与右键菜单也跟着同一个值。
'use strict';

const { ipcMain, nativeTheme, BrowserWindow } = require('electron');
const settings = require('./settings');

const MODES = ['system', 'light', 'dark'];
const BG = { dark: '#1e1e28', light: '#f5f6fa' };   // 与 theme.css 的 --bg 同值: 窗口没画出来前那一帧的底色

function mode() { const m = settings.read().theme; return MODES.includes(m) ? m : 'system'; }
function apply(m) { nativeTheme.themeSource = m; }
function windowBg() { return nativeTheme.shouldUseDarkColors ? BG.dark : BG.light; }

apply(mode());

ipcMain.handle('get-theme', async () => ({ theme: mode() }));
ipcMain.handle('set-theme', async (_e, { theme } = {}) => {
  if (!MODES.includes(theme)) return { ok: false, error: 'unsupported_theme' };
  settings.write({ theme });
  apply(theme);
  for (const w of BrowserWindow.getAllWindows()) { try { w.setBackgroundColor(windowBg()); } catch (_) {} }
  return { ok: true, theme };
});

// 快速切换默认藏着: 设置里打开才在顶栏出现。改了广播给所有窗口, 主界面当场显隐。
ipcMain.handle('get-quick-switch', async () => ({ on: settings.read().quickModelSwitch === true }));
ipcMain.handle('set-quick-switch', async (_e, { on } = {}) => {
  settings.write({ quickModelSwitch: !!on });
  for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('quick-switch-changed', { on: !!on }); } catch (_) {} }
  return { ok: true, on: !!on };
});

// 对话里的工具调用条(✔ 🔧 memory_query · 完成)默认藏着: 状态栏已经显示正在跑哪个工具, 条目堆在对话里
// 挡正文(作者 11-09)。条目照常生成, 只是 CSS 不画, 打开开关当场全显示回来。
ipcMain.handle('get-tool-rows', async () => ({ on: settings.read().showToolCalls === true }));
ipcMain.handle('set-tool-rows', async (_e, { on } = {}) => {
  settings.write({ showToolCalls: !!on });
  for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('tool-rows-changed', { on: !!on }); } catch (_) {} }
  return { ok: true, on: !!on };
});

// 启动小贴士(renderer/tips.js): hideTips=true 不再自动弹, tipsSeen 记看过第一条(之后随机)。
// show-tips 是系统设置里「现在看一条」: 广播给各窗口, 只有主窗口挂了 tips.js, 顺手把它叫到前面。
ipcMain.handle('get-tips', async () => { const s = settings.read(); return { on: s.hideTips !== true, seen: s.tipsSeen === true }; });
ipcMain.handle('set-tips', async (_e, p = {}) => {
  const w = {};
  if (p.on !== undefined) w.hideTips = !p.on;
  if (p.seen) w.tipsSeen = true;
  settings.write(w);
  return { ok: true };
});
ipcMain.handle('show-tips', async () => {
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (/renderer\/index\.html/.test(w.webContents.getURL())) { w.show(); w.focus(); } w.webContents.send('tips-show'); } catch (_) {}
  }
  return { ok: true };
});

module.exports = { windowBg };
