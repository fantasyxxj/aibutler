'use strict';
// dev-window-place.js — dev 实例的主窗口开在哪块屏上。
//
// 为什么要有它: 验证一个界面改动就得起一个 dev 实例, 而 Electron 建窗口时用的是**主显示器** ——
// 也就是作者正在干活的那块。于是每验一次就往他脸上糊一个窗口。事后用 AppleScript 挪走治不了本:
// 挪只能发生在窗口已经存在之后, 必然先闪一下。所以坐标要在 `new BrowserWindow` 的参数里就给出去。
//
// 🔴 生产里执行不到, 不是"没被触发": 第一道闸是 `app.isPackaged`, 打包版直接原样返回, 哪怕有人
// 误设了环境变量也一样。第二道闸是 `BUTLER_DEV_SCREEN`, 不设的话 dev 也照旧 —— 作者自己
// `npm start` 起来的窗口位置不变, 只有验证脚本才带上这个变量。
//
// 两版共用, 放 core 不放 personal: 「验证实例糊在作者工作屏上」这件事两版一模一样。
//   个人版 `require('../core/dev-window-place')` · 行业版 `require('@butler/core/dev-window-place')`
//
// 用法(返回值直接摊进 BrowserWindow 的参数):
//   BUTLER_DEV_SCREEN=builtin  → 开在内置屏, 并在那块屏上居中

// 内置屏认 `display.internal`。认不出来(外接全拔了 / 驱动没报)就退回非主屏, 再没有就用主屏 ——
// 退回链上每一步都仍是个能用的窗口位置, 不会把窗口丢到坐标系外面去。
function pickDisplay(screen, want) {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  if (want !== 'builtin') return null;
  return all.find((d) => d.internal)
      || all.find((d) => d.id !== primary.id)
      || null;
}

module.exports = (width, height) => {
  const base = { width, height };
  const want = process.env.BUTLER_DEV_SCREEN;
  if (!want) return base;
  try {
    const { app, screen } = require('electron');
    if (app.isPackaged) return base;
    const d = pickDisplay(screen, want);
    if (!d) return base;
    const a = d.workArea;   // workArea 而不是 bounds: 躲开菜单栏和 Dock, 否则标题栏会被顶掉
    return {
      ...base,
      x: Math.round(a.x + Math.max(0, (a.width - width) / 2)),
      y: Math.round(a.y + Math.max(0, (a.height - height) / 2)),
    };
  } catch (_) {
    return base;   // screen 模块要等 app ready; 拿不到就按默认位置开, 验证实例开错屏不值得让 butler 起不来
  }
};
