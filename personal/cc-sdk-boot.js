// cc-sdk-boot.js — 启动时补下 Claude Agent SDK 的那一段(问 → 进度小窗 → 重启)。见 core/cc-sdk-install.js。
// 单独成文件: main.js 已过 500 行上限。
// 🔴 时序(作者 11-05 定): 下载期间只有进度小窗, 主窗口和人格都不起; 下好直接重启, 不再弹框问;
// 下载失败 / 用户选稍后 → 返回 false, 宿主照常开人格、出主窗口。
'use strict';

const path = require('path');
const { BrowserWindow, dialog } = require('electron');

function progressWindow(title) {
  try {
    const win = new BrowserWindow({
      width: 380, height: 96, show: false, frame: false, transparent: true,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, center: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
    win.loadFile(path.join(__dirname, 'renderer', 'booting.html'), { search: `title=${encodeURIComponent(title)}&sub=` });
    return win;
  } catch (e) {
    console.error('[cc-sdk] 进度小窗打开失败(不影响下载):', e && e.message);
    return null;
  }
}

// 下载期间主进程没被占住, 小窗还收得到 executeJavaScript
function setSub(win, text) {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(`document.getElementById('sub').textContent = ${JSON.stringify(text)}`).catch(() => {});
}

// 返回 true = 已经在重启, 宿主别再往下走
async function run({ S, hasSubscriptionPersona, relaunch }) {
  let win = null;
  let last = '';
  const r = await require('../core/cc-sdk-install').autoEnable({
    hasSubscriptionPersona,
    confirm: () => dialog.showMessageBox({ type: 'info', buttons: [S.sys_cc_download, S.sys_cc_later], defaultId: 0, cancelId: 1, message: S.sys_cc_auto_ask })
      .then(({ response }) => response === 0),
    onStart: () => { win = progressWindow(S.sys_cc_auto_title); },
    onProgress: (p) => {   // 两个包: sdk 占 10%, bin 占 90%(同设置页 cc-sdk-ui.js)
      const text = p.step === 'extract' ? S.sys_cc_extracting
        : S.sys_cc_downloading.replace('{pct}', p.step === 'bin' ? 10 + Math.floor(p.pct * 0.9) : Math.floor(p.pct * 0.1));
      if (text !== last) setSub(win, (last = text));
    },
  });
  if (r && r.ok) {
    console.log('[cc-sdk] 下载完成 → 直接重启, 不起人格和主窗口');
    relaunch();
    return true;
  }
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
  if (r) await dialog.showMessageBox({ type: 'warning', message: S.sys_cc_auto_failed.replace('{err}', r.error || '') });
  return false;
}

module.exports = { run };
