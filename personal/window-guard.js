// window-guard.js — 窗口状态的兜底守卫。
//
// 2026-09-13 现场: 主窗被发现卡在 macOS 全屏且尺寸塌成 0x0 —— 屏幕上什么都没有, 用户以为
// 程序没了, 而 butler 这边一切正常: 进程活着、日志照写、UI 事件照推。**既没人发现, 也没人记录,
// 更没有恢复路径**, 最后是从外面用 osascript 读 AXFullScreen 才弄明白。
// butler 自己从不设全屏也不设尺寸(全仓 setFullScreen/setBounds/setSize 零匹配), 所以这不是
// 谁写错了, 是缺一道守卫 —— 不管它怎么塌进去的, 出来的动作都一样, 修守卫不必先查清成因。
//
// ⚠️ macOS 在全屏态下**拒绝一切尺寸/位置修改**, 所以必须先退全屏; 而退全屏是带动画的异步过程,
//    setSize 得等 leave-full-screen 事件, 当场调会被系统弹回。
// 主窗建的时候设了 minWidth:640/minHeight:480, 用户手动拖不到这条线以下, 所以低于它的尺寸
// 只可能是窗口状态坏了。留一大截余量(而不是紧贴 640)是为了不跟系统的边界取整较劲。
const MIN_PX = 200;
const TICK_MS = 60e3;
const RESTORE = { width: 980, height: 780 };

function attachEscClose(win) {
  // 设置窗/管理窗全屏时红绿灯是自动隐藏的 —— 那时页面里没有任何关闭入口(三个文件里
  // close/Escape 零匹配), 用户只能干瞪眼。Esc 是这类对话框的通用退路。
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && !input.control && !input.meta && !input.alt) {
      e.preventDefault();
      if (!win.isDestroyed()) win.close();
    }
  });
}

function guardMainWindow(win, log = console.log) {
  if (!win) return;
  let fixing = false;

  const resize = () => {
    try { win.setSize(RESTORE.width, RESTORE.height); win.center(); } catch (_) {}
    fixing = false;
  };

  const check = (why) => {
    if (!win || win.isDestroyed() || fixing) return;
    let w, h;
    try { [w, h] = win.getSize(); } catch (_) { return; }
    if (w >= MIN_PX && h >= MIN_PX) return;
    fixing = true;
    const full = (() => { try { return win.isFullScreen(); } catch (_) { return false; } })();
    log(`[window-guard] 主窗尺寸塌成 ${w}x${h}(fullscreen=${full}, 触发=${why}) → 恢复中`);
    if (full) {
      // 退全屏是异步的; 尺寸只能等它退完再设, 当场设会被 macOS 弹回。
      win.once('leave-full-screen', resize);
      try { win.setFullScreen(false); } catch (_) { resize(); }
      setTimeout(() => { if (fixing) resize(); }, 3000);   // 事件没来也别一直卡着
    } else {
      resize();
    }
  };

  /* 🔴 显示器变更与主窗跨屏留痕。帧停只在某一套显示器配置下发生, 而窗口**具体哪一刻换的屏**,
     靠 frame-watchdog 那条 30 分钟心跳是夹不出来的 —— 2026-09-27 那次只夹到「09:18:06 还是
     dpr=2 / 09:44:54 最后一帧时已是 dpr=1」, 于是"开屏那一下就停"和"切过去待了一会儿才停"
     这两种情形分不开, 而它们指向的成因完全不同。记下时刻 + display id + scaleFactor, 停帧起点
     与切屏时刻的先后就直接可读, 不用再靠半小时心跳去夹。 */
  try {
    const { screen } = require('electron');
    const tag = (d) => (d ? `id=${d.id} ${d.label || ''} ${d.bounds.width}x${d.bounds.height}`
      + `@${d.bounds.x},${d.bounds.y} scale=${d.scaleFactor} hz=${Math.round(d.displayFrequency || 0)}` : '?');
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.on(ev, (_e, d, changed) => log(`[display] ${ev} · ${tag(d)}`
        + (changed && changed.length ? ` · 变了: ${changed.join(',')}` : '')));
    }
    let lastId = null;
    const noteScreen = (why) => {
      if (!win || win.isDestroyed()) return;
      let d;
      try { d = screen.getDisplayMatching(win.getBounds()); } catch (_) { return; }
      if (!d || d.id === lastId) return;      // 只在真的换了屏时记, 否则每次拖动都刷一行
      const from = lastId;
      lastId = d.id;
      log(`[display] 主窗换屏(${why}) · ${from === null ? '首次落位' : 'from id=' + from} → ${tag(d)}`);
    };
    noteScreen('启动');
    win.on('moved', () => noteScreen('moved'));
    screen.on('display-metrics-changed', () => noteScreen('metrics-changed'));
  } catch (_) { /* 拿不到 screen(非 Electron 主进程)就算了, 这只是留痕 */ }

  win.on('resize', () => check('resize'));
  win.on('leave-full-screen', () => check('leave-full-screen'));
  // 定时那道是兜底: 塌陷未必伴随 resize 事件(2026-09-13 那次就没人收到任何信号)。
  const timer = setInterval(() => check('tick'), TICK_MS);
  if (timer.unref) timer.unref();
  win.on('closed', () => clearInterval(timer));
}

module.exports = { attachEscClose, guardMainWindow, MIN_PX, RESTORE };
