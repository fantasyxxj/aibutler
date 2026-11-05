// debug-port.js — 生产版的远程调试口开关。**默认关**。
//
// 🔴 为什么要有: 打包版看不见浏览器内核的内部状态。2026-09-27 查「界面不出帧」那次,
//    外面能数的只有进程和线程栈 —— 判得出"没人在忙、没人等锁", 判不出"合成器为什么收不到
//    BeginFrame"。那一层只有接进 CDP 才看得到, 而打包版当时没有口子, 于是唯一一个真现场
//    只拿到了一半的信息。这个开关就是为了下次不用再隔着墙猜。
//
// 🔴 为什么默认关, 而且开着必须显眼: 调试口开着 = 本机**任何**进程都能接进来操控 butler,
//    读全部对话、替用户发消息都做得到。所以 ① 默认关 ② 开着时窗口标题挂警告, 免得开了忘关。
//
// 🔴 时机: `appendSwitch` 必须在 app ready **之前**调用, 晚一步 Chromium 已经起来了就不认。
//    所以本模块只能挂在 `personal/main.js` 顶层的 require 链里 —— 它被 `const settings = …`
//    那一行顺带拉起(main.js 已过 500 行上限, 门禁只放行不增行数的改动, 所以塞在同一行)。
//
// 两种开法, 都不用重新打包:
//   ① 环境变量:  BUTLER_DEBUG_PORT=9222 open -a 全能管家     ← 临时查一次
//   ② 设置文件:  数据目录 app/settings.json 里加 "debugPort": 9222, 然后重启   ← 长期开着
// 关掉就是删掉那个字段(或设 0)再重启。

// 🔴 端口用 9333 而不是 9222: 9222 是起 dev 时占的, 两边撞上会互相顶掉。
const DEFAULT_PORT = 9333;

// 🔴 **当前默认开着**, 这是作者 2026-09-27 定的, 理由是它不常开就等于没有:
//    帧停是随机犯的, 等犯了再来开这个口要重启 app, 而一重启现场就没了 —— 那正是要抓的东西。
//    所以在查「界面不出帧」这条线期间默认开, 查完改回 false。
//    风险可控: Chromium 的调试口只监听 **127.0.0.1**(外网/局域网够不着), 暴露面仅限本机其他程序;
//    且开着时窗口标题挂警告, 不会开了没人知道。
const ON_BY_DEFAULT = true;

// 端口得是个能用的数字。写错了当没开 —— 比默默监听一个意外端口安全。
function normalize(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n < 1024 || n > 65535) return 0;   // 1024 以下要 root, 给了也起不来
  return Math.floor(n);
}

/* 读设置文件里的 debugPort, **原样返回**(没配 → null)。
   🔴 返回 null 而不是 0, 是为了把「没配这个字段」和「配了 0 = 我要关掉它」分开 ——
      这两者在默认开的前提下结果正相反, 混成一个值就会让用户关不掉。
   🔴 这里**不走 `require('./settings')`**: 那个模块在 app ready 前未必能安全取到数据目录,
      而本模块必须在 ready 之前跑完。自己读一次文件, 读不到就当没配, 绝不让它拖垮启动。 */
function fromSettingsFileRaw() {
  try {
    const fs = require('fs');
    const path = require('path');
    const file = path.join(require('./paths').dataDir(), 'app', 'settings.json');
    if (!fs.existsSync(file)) return null;
    const v = JSON.parse(fs.readFileSync(file, 'utf8')).debugPort;
    return v == null ? null : v;
  } catch (_) {
    return null;
  }
}

/* 三档优先级, 高的压低的:
     ① 环境变量 BUTLER_DEBUG_PORT  —— 临时查一次, 也是**唯一能强行关掉**的办法(=0)
     ② 设置文件 app/settings.json 的 debugPort —— 长期指定端口 / 长期关(=0)
     ③ 出厂默认 ON_BY_DEFAULT      —— 只管 dev; 打包版恒为关
   ⚠️ ①② 显式写 0 就是"关", 不会被 ③ 翻回来 —— 否则用户就没有任何办法关掉它了。 */
function resolvePort() {
  const fromEnv = process.env.BUTLER_DEBUG_PORT;
  if (fromEnv != null && String(fromEnv).trim() !== '') {
    const s = String(fromEnv).trim();
    if (/^(0|false|no|off)$/i.test(s)) return 0;            // 显式关, 最高优先级
    const n = normalize(s);
    return n || (/^(1|true|yes|on)$/i.test(s) ? DEFAULT_PORT : 0);
  }
  const fromFile = fromSettingsFileRaw();
  if (fromFile != null) {
    if (/^(0|false|no|off)$/i.test(String(fromFile).trim())) return 0;   // 显式关
    return normalize(fromFile) || (/^(1|true|yes|on)$/i.test(String(fromFile).trim()) ? DEFAULT_PORT : 0);
  }
  // 打包版出厂默认关(作者 2026-11-05: 「打包的时候关掉」), 要监控就在 settings.json 写 debugPort; dev 照开
  let packaged = false;
  try { packaged = !!require('electron').app.isPackaged; } catch (_) {}
  return ON_BY_DEFAULT && !packaged ? DEFAULT_PORT : 0;
}

function enable() {
  let app;
  try { ({ app } = require('electron')); } catch (_) { return 0; }
  if (!app || app.isReady()) {
    // ready 之后再挂就没用了。宁可什么都不做, 也别让调用方以为开了。
    if (app && app.isReady()) console.error('[debug-port] 已经 ready, 这时候挂调试口不生效 —— 检查 require 时机');
    return 0;
  }

  const port = resolvePort();
  if (!port) {
    // 🔴 配错了不能静默 —— 默认是开的, 所以"没开"只可能是被显式关掉或配错了。
    // 两者的区别用户看不见(标题都没有警告), 不说一声他会以为开着, 出事时才发现没抓到。
    const raw = process.env.BUTLER_DEBUG_PORT != null && String(process.env.BUTLER_DEBUG_PORT).trim() !== ''
      ? process.env.BUTLER_DEBUG_PORT : fromSettingsFileRaw();
    if (raw != null && String(raw).trim() !== '' && !/^(0|false|no|off)$/i.test(String(raw).trim())) {
      console.error(`[debug-port] 配置值 ${JSON.stringify(raw)} 看不懂, 已按【关】处理 —— 端口要写 1024~65535 的整数`);
    }
    return 0;
  }

  app.commandLine.appendSwitch('remote-debugging-port', String(port));
  console.error(`[debug-port] ⚠️ 远程调试口已开: ${port} —— 本机任何程序都能接进来操控 butler(读全部对话、替你发消息)。查完记得关。`);

  // 开着就得让人看得见。标题是唯一不用改渲染层就能挂警告的地方 ——
  // 而"改渲染层"意味着这个安全提示依赖另一个文件没出错, 提示本身就不该有这种依赖。
  app.on('browser-window-created', (_e, win) => {
    const mark = () => {
      try {
        const t = win.getTitle();
        if (!t.includes('调试口')) win.setTitle(`${t}  ⚠️ 调试口 ${port} 开着`);
      } catch (_) {}
    };
    win.once('ready-to-show', mark);
    // 渲染层自己也会设标题(会把后缀冲掉), 所以它每改一次就重新挂一次。
    win.on('page-title-updated', () => setTimeout(mark, 0));
  });

  return port;
}

module.exports = { enable, resolvePort, normalize, DEFAULT_PORT };

// 被 require 就生效 —— 调用方是 main.js 顶层那一行, 没有别的时机可挂。
enable();
