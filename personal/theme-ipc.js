// theme-ipc.js — 外观设置的主进程那一半, 自注册(main.js 只 require 一下): 界面深浅色(跟随系统 / 浅色 / 深色)
// · 顶栏「key · 模型 ▾」快速切换显不显示(settings.quickModelSwitch, 默认关, 作者 11-07)。
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

module.exports = { windowBg };
