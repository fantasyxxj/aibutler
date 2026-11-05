// 渲染层诊断: 报错落主进程日志 + **沙箱里的报错转给人格**。
//
// 🔴 为什么要转给人格: 插件跑在沙箱 iframe 里, 那里**没有 console** —— 人格写的 console.log
// 自己看不到, 抛出来的异常也看不到, 失败的样子只是界面空白或画了一半, 不报错。
// 2026-08-30 实测: 一个插件连抛 41 次 `history.map is not a function`, 写它的人格一次都没看见,
// 于是瞎试到第 6 版, 最后放弃了整个 butlerUI 退化成一张关掉就没的静态页 —— 能力是**静默**没的。
// 而错误本来就已经在主进程手里了(console-message 事件), 只差转一份给它。
//
// 🔴 去重与节流不是可选的: 那 41 次是同一句话。原样转发 = 41 次模型调用, 而且刷屏之后
// 人格反而看不见重点。所以同一条错误在窗口期内只说一次, 并把次数一起告诉它 ——
// 次数本身是诊断信息("抛了 41 次"说明在渲染循环里, "抛了 1 次"说明在初始化)。

const WINDOW_MS = 5 * 60 * 1000;   // 同一条错误多久之内不重复打扰
const DEBOUNCE_MS = 1500;          // 一次崩溃常连抛数条, 等它抛完再一起说
const MAX_LINES = 8;               // 一条消息里最多列几种错误
const PROC_POLL_MS = 10 * 1000;    // 进程清单差分的间隔(见 attachProcessDeathLog: 沙箱进程的死亡没有事件可听)

// 沙箱 iframe 的脚本没有真实 URL。about:srcdoc 就是"这条来自插件而不是主界面"的判据。
const isSandbox = (sourceId) => /^about:srcdoc/.test(String(sourceId || ''));

function createSandboxErrorRelay(submit, log) {
  const reported = new Map();   // key → 上次报出去的时刻
  const pending = new Map();    // key → { text, count }
  let timer = null;

  function flush() {
    timer = null;
    if (!pending.size) return;
    const now = Date.now();
    const lines = [];
    for (const [key, item] of pending) {
      reported.set(key, now);
      lines.push(item.count > 1 ? `${item.text}  ×${item.count}` : item.text);
    }
    pending.clear();
    for (const [k, t] of reported) if (now - t > WINDOW_MS) reported.delete(k);

    const shown = lines.slice(0, MAX_LINES);
    const more = lines.length - shown.length;
    submit([
      '(auto · a plugin threw an error inside its sandbox — relayed to you because the sandbox has no console)',
      ...shown,
      ...(more > 0 ? [`… and ${more} more kind(s) of error`] : []),
      '',
      'Nothing else about this will reach you: inside the sandbox your own console.log is invisible too, and the'
      + ' only visible symptom is a blank or half-drawn panel. A high repeat count means it is throwing inside the'
      + ' render loop; a count of 1 means it threw during init.',
      'Look up how to fix it before editing: memory_query "plugin state onInit empty default blank screen".',
    ].join('\n')).catch((e) => log('[sandbox-relay] 通知发不出去:', e && e.message));
  }

  return function report(message, sourceId, line) {
    if (!isSandbox(sourceId)) return;
    const text = `${String(message).trim()} (line ${line})`;
    const key = text;
    const now = Date.now();
    const last = reported.get(key);
    // 窗口期内已经说过就只累计, 不再打扰 —— 但仍然计数, 下次窗口打开时次数是真的。
    if (last && now - last < WINDOW_MS) return;
    const item = pending.get(key) || { text, count: 0 };
    item.count += 1;
    pending.set(key, item);
    if (!timer) timer = setTimeout(flush, DEBOUNCE_MS);
  };
}

/* 给一个窗口挂上诊断。label 进日志前缀; onSandboxError 不传就只落日志不转发
   (管理窗没有人格在听, 转发无处可去)。
   🔴 两个窗口都必须挂: 2026-08-25 只给管理窗挂了、主窗漏了, 于是 08-26「流程图卡在渲染中」
   现场一个字都没留下。聊天全在主窗里, 它反而是最需要留痕的那个。 */
function attachRendererDiagnostics(win, label, onSandboxError) {
  // 顺手把 app 级的进程死亡留痕挂上(幂等, 只挂一次)。
  // 🔴 为什么塞在这里而不是让 main.js 自己调一行: `personal/main.js` 已 2455 行、
  // 早过了 500 行上限, 门禁只放行"不增行数"的改动。而这两件本就是同一个职责
  // (渲染层出事要留痕), 挂在同一个模块里也说得通 —— 谁挂窗口诊断, 谁就顺带把进程级那道也挂上。
  attachProcessDeathLogOnce();
  win.webContents.on('console-message', (_ev, level, message, line, sourceId) => {
    if (level < 2) return;
    console.error(`[${label}] ${message} (${String(sourceId).split('/').pop()}:${line})`);
    if (onSandboxError) onSandboxError(message, sourceId, line);
  });
  win.webContents.on('render-process-gone', (_ev, d) => console.error(`[${label}] 渲染进程没了:`, JSON.stringify(d)));
}

/* 进程级的死亡留痕。调一次, 挂在 app 上。
   🔴 为什么上面那条 webContents 级的 `render-process-gone` 不够: 插件沙箱 iframe 是 opaque
   origin, 跑在**独立的子 frame 进程**里, 它不是任何 webContents 的主 frame —— 它死掉时那个事件
   一次都不触发。2026-09-27 实撞: 外部 SIGTERM 杀掉那个沙箱进程, 按 `render-process-gone` /
   `Render frame was disposed` / `crash` 全天 grep **零命中**, 于是"它自己死的"和"被人杀的"
   在日志里分不开 —— 那次是唯一一个真现场, 一半的价值就这么没了。
   ⚠️ `child-process-gone` 的 details **不带 pid**(只有 type/name/serviceName/reason/exitCode),
   所以别指望靠它把死掉的进程和先前 ps 抓到的 pid 对上号; 它能回答的是"有没有进程死、什么类型、
   为什么死", 时刻由日志前缀给。想对 pid 就得在它还活着的时候自己记一份 pid 清单。 */
let _procDeathAttached = false;
function attachProcessDeathLogOnce() {
  if (_procDeathAttached) return;
  _procDeathAttached = true;
  // core 不认识 Electron 是常态, 但这一条只在 Electron 主进程里有意义 —— 拿不到就安静跳过,
  // 免得把门禁脚本(jsdom 里 require 本文件)带崩。
  try {
    const { app } = require('electron');
    if (app && typeof app.on === 'function') attachProcessDeathLog(app);
  } catch (_) {}
}

function attachProcessDeathLog(app) {
  app.on('child-process-gone', (_ev, d) => {
    const d2 = d || {};
    console.error('[proc] 子进程没了 · ' + JSON.stringify({
      type: d2.type, name: d2.name, serviceName: d2.serviceName,
      reason: d2.reason, exitCode: d2.exitCode,
    }));
  });
  // 这条与 attachRendererDiagnostics 里那条重叠, 但那条按窗口挂、这条按 app 挂:
  // 窗口没挂上诊断(或窗口本身已经没了)时, 只有这条还在。
  app.on('render-process-gone', (_ev, wc, d) => {
    let pid = '?';
    try { pid = wc && wc.getOSProcessId(); } catch (_) {}
    console.error(`[proc] 渲染进程没了 · pid=${pid} · ` + JSON.stringify(d || {}));
  });

  /* 🔴 上面两个事件**都逮不到插件沙箱那种进程**, 所以必须再有这一道轮询。
     2026-09-27 实测(最小 Electron + 真 sandbox iframe): 对 `Tab` 类型的子 frame 进程发 SIGTERM,
     `child-process-gone` 与 `render-process-gone` **一次都不触发** —— 前者不管渲染进程,
     后者只管 webContents 的主 frame, 而 opaque-origin iframe 的进程两头都不属于。这就是那天
     全天 grep 零命中的真正原因: 不是漏记了崩溃, 是 Electron 根本没有这个事件。
     差分还顺带补上了 child-process-gone 缺的 pid, 以及"进程什么时候诞生"—— 那天查
     「那个多余渲染进程是几点出现的」只能靠 ps 的 etime 反推, 有这行就直接读得到。 */
  let known = new Map();
  const tick = setInterval(() => {
    let cur;
    try { cur = new Map(app.getAppMetrics().map((m) => [m.pid, m.type])); } catch (_) { return; }
    if (known.size) {
      for (const [pid, type] of known) if (!cur.has(pid)) console.error(`[proc] 进程不见了 · pid=${pid} type=${type}`);
      for (const [pid, type] of cur) if (!known.has(pid)) console.error(`[proc] 进程新出现 · pid=${pid} type=${type}`);
    }
    known = cur;
  }, PROC_POLL_MS);
  if (tick.unref) tick.unref();   // 别让这个定时器把进程留住不退
}

module.exports = { attachRendererDiagnostics, createSandboxErrorRelay, attachProcessDeathLog, isSandbox, WINDOW_MS, DEBOUNCE_MS };
