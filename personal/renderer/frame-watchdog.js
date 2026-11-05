// 帧看门狗: 记录「渲染进程活着、JS 照常跑, 但合成器吐不出新帧」这个状态。
//
// 🔴 判据为什么成立: requestAnimationFrame 只在合成器真出帧时才回调, 而 setInterval 在帧停之后
// 照常跑(2026-09-13 已实证帧停期间渲染进程 JS 仍在跑、日志照写)。两者时间戳之差就是屏幕停了多久。
//
// 🔴 为什么要记 dpr 和窗口位置: 目前唯一已知的解法是把窗口拖到另一块屏, 而两块屏 DPI 不同
// (外接 1920x1080 @1x · 内置 2560x1600 Retina @2x)。停下和恢复各记一次这两个数, 就能直接判定
// 到底是"跨屏改了 scale factor 才救活"还是"动一下就行、跟屏无关" —— 这个问题查了三轮全是推测,
// 因为每次现场都只剩人的事后回忆。
//
// 报告走 console.error 而不是 console.log: 主进程只收 level>=2 的 console-message
// (core/renderer-diagnostics.js), log 级别不落日志。
//
// 不用常驻 rAF 循环: 注册了 rAF 就会让 Chromium 持续请求 BeginFrame(~60fps), 空闲时也不停,
// 在 8GB 机器上白耗电。改成每秒只讨一帧, 成本降 60 倍, 而帧停照样测得出来。

(() => {
  const STALL_MS = 5000;   // 超过这么久没出帧才算停(留出正常的重排/GC 抖动)
  const CHECK_MS = 1000;

  let lastFrameAt = performance.now();
  let waiting = false;     // 已经讨了一帧还没给 → 别再堆请求
  let stallStart = 0;

  // 节点数和 JS 堆是冲着「累积」那个假说记的: 撑爆的若是 Chromium 内部配额而不是系统内存,
  // 系统那头的 rss 看着一切正常, 只有这两个数会随开机时长一路涨。
  const where = () => {
    const heap = performance.memory
      ? ` jsHeap=${Math.round(performance.memory.usedJSHeapSize / 1048576)}MB`
      : '';
    return `dpr=${window.devicePixelRatio} pos=${window.screenX},${window.screenY} `
      + `size=${window.innerWidth}x${window.innerHeight} `
      + `nodes=${document.getElementsByTagName('*').length}${heap} `
      + `up=${Math.round(performance.now() / 60000)}min`;
  };

  // 帧停那一刻的数字没有基线就读不出「涨没涨」, 所以平时也按半小时留一条。
  setInterval(() => console.error(`[frame-watchdog] 基线 · ${where()}`), 30 * 60 * 1000);

  // 🔴 帧停期间的点击必须单独记: 画不出新帧的时候, 点击的视觉反馈(按钮按下、菜单弹出)同样画不出来,
  // 于是「真的没响应」和「响应了但你看不见」在屏幕上长得一模一样, 人只能报「界面不能点」。
  // 这一条落到日志里, 就等于替人回答了这个分不出来的问题。用捕获阶段, 免得被谁 stopPropagation 掉。
  document.addEventListener('click', (e) => {
    if (!stallStart) return;
    const el = e.target;
    console.error(`[frame-watchdog] 帧停期间收到点击 · <${el && el.tagName}#${(el && el.id) || '-'}>`
      + ' · 说明事件通道是通的, 坏的只有绘制');
  }, true);

  setInterval(() => {
    // 窗口不可见时 rAF 本来就不回调(后台节流), 那不是故障 —— 重置基准, 免得一切回来就误报。
    if (document.visibilityState !== 'visible') {
      lastFrameAt = performance.now();
      stallStart = 0;
      return;
    }

    if (!waiting) {
      waiting = true;
      requestAnimationFrame(() => { waiting = false; lastFrameAt = performance.now(); });
    }

    const gap = performance.now() - lastFrameAt;
    if (!stallStart && gap >= STALL_MS) {
      stallStart = lastFrameAt;
      console.error(`[frame-watchdog] 帧停了 · 已 ${Math.round(gap / 1000)}s · ${where()}`);
    } else if (stallStart && gap < STALL_MS) {
      console.error(`[frame-watchdog] 帧回来了 · 共停 ${Math.round((lastFrameAt - stallStart) / 1000)}s · ${where()}`);
      stallStart = 0;
    }
  }, CHECK_MS);
})();
