// single-instance.js — 一个数据目录只许跑一个个人版(作者 2026-11-10 定, 照行业版 industry/app/main.js)。
// 两个实例同开一套数据: 同一个人格库两边写(database is locked)、同一条通道消息两边各处理一遍、
// 收件游标互相踩 —— 启动却一切正常, 谁也看不出来。2026-11-10 dev 上一个前一天没关的实例就这么活了一整天。
// 取 OS 的锁(Electron requestSingleInstanceLock), 不在盘上放锁文件: kill -9 / 断电后锁跟着进程消失。
// 锁跟着 userData 走。dev 默认的 userData 和装机版同名(~/Library/Application Support/butler), 不挪的话
// 装机版开着 dev 就起不来, 两边还共用一份 Chromium 配置 —— 所以 dev 的 userData 挪进 dev 数据目录,
// BUTLER_DATA_DIR 并存的几套 dev 也就各锁各的。
'use strict';
const path = require('path');
const { app } = require('electron');
const paths = require('./paths');

// 要在 app ready 之前调。拿不到锁 = 已有实例在跑: 让它把窗口叫到前面, 自己退出, 返回 false。
function claim(onSecond) {
  if (!paths.isPackaged()) app.setPath('userData', path.join(paths.bootstrapDir(), 'electron-profile'));
  if (!app.requestSingleInstanceLock()) {
    console.log('[single-instance] 这套数据已有实例在跑, 本实例退出');
    app.exit(0);
    return false;
  }
  app.on('second-instance', () => { try { onSecond(); } catch (_) {} });
  return true;
}

module.exports = { claim };
