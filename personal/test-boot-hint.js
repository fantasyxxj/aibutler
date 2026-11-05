// 启动提示小窗 (renderer/booting.html + main.js showBootingWindow) 回归。
// 跑: node test-boot-hint.js
//
// 病根(2026-08-20 作者报): 老用户第一次打开新版本要跑记忆迁移, 而迁移 + 出厂同步 + 起 SDK
// 子进程这一整段是**同步阻塞**的, 主窗口又排在它后面 —— 用户点开图标是"没反应, 等半天窗口才出来"。
//
// 这里盯的是三件最容易被改回去、且改回去之后完全静默的事:
//   ① 小窗必须在那段阻塞【之前】弹出来 —— 排到后面等于没有
//   ② 小窗必须自包含 —— 主进程一阻塞, IPC 就送不进去了, 靠 IPC 填文案的窗只会是个空白框
//   ③ 小窗必须在 finally 里关 —— 启动链抛异常时不关, 用户对着一个永远转圈的框
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const htmlPath = path.join(__dirname, 'renderer', 'booting.html');

console.log('\n=== 小窗本身 ===');
ok(fs.existsSync(htmlPath), 'renderer/booting.html 在');
const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';

// 🔴 自包含: 主进程在小窗显示之后就被同步代码占死, 那之后 IPC 一个字都送不进来。
// 靠 onXxx 回调填文案 = 用户看到空白框, 比没有提示更糟。
ok(!/ipcRenderer|window\.butler|require\(/.test(html),
   '🔴 不依赖 IPC / preload / require(主进程阻塞期间这些全是死的)');
ok(/URLSearchParams|location\.search/.test(html), '文案靠 query string 一次性带入');
ok(/@keyframes|animation:/.test(html), '动效是纯 CSS(renderer 独立进程, 主进程卡住它照转)');
ok(/id="title"/.test(html) && /id="sub"/.test(html), '标题和副文案都有落点');

console.log('\n=== 接线时序 ===');
const atShow = mainSrc.indexOf('showBootingWindow(');
const atOpen = mainSrc.indexOf('for (const d of toOpen) openPersona(d)');
ok(atShow !== -1, 'main.js 真的开了启动提示窗');
ok(atOpen !== -1, '找得到 openPersona 那段阻塞');
ok(atShow !== -1 && atOpen !== -1 && atShow < atOpen,
   '🔴 小窗弹在 openPersona 那段同步阻塞【之前】—— 排到后面等于没有');

// 关窗必须在 finally: 启动链中途抛异常(认证失败/人格目录坏了)时小窗要跟着走。
{
  const seg = mainSrc.slice(atOpen, atOpen + 600);
  ok(/finally\s*\{/.test(seg), '🔴 关小窗放在 finally 里(启动出错也不会留下一个永远转圈的框)');
  ok(/bootWin[\s\S]{0,80}destroy\(\)/.test(seg), 'finally 里真的 destroy 了它');
}

// 文案里的条数来自真实探测, 不是写死的话术。detectStart 只读目录不写盘。
console.log('\n=== 文案不说空话 ===');
ok(/detectStart\(/.test(mainSrc), '🔴 迁移条数来自 detectStart 实测, 不是写死的');
ok(/kind === 'A' \|\| .*kind === 'B'/.test(mainSrc), "只有 A/B(真有存量要迁)才报迁移文案");
{
  const at = mainSrc.indexOf('showBootingWindow');
  const seg = mainSrc.slice(at, at + 1600);
  ok(/ready-to-show/.test(seg), '等首帧画出来再返回(没等到就开跑 = 用户看到空白框)');
  ok(/setTimeout\(res/.test(seg), '首帧迟迟不来有兜底, 不把整个启动卡死在这');
  // 0.1.2 的现象: 门禁全绿而用户看不见窗口 —— show() 只排队, 上屏要 runloop 转一圈,
  // 返回后主线程立刻被同步代码占死。show 和 return 之间必须让出。
  ok(/win\.show\(\);[\s\S]{0,400}?await new Promise[\s\S]{0,60}?setTimeout[\s\S]{0,120}?return win/.test(seg),
    '🔴 show() 之后让出事件循环再返回(不让 = 窗口永远画不上屏)');
}

// 0.1.3 实机(Windows): 小窗出来了, 之后主窗口再没出现, 也没有报错。
// destroy(小窗) 到 createWindow() 之间窗口数是 0, window-all-closed 在非 darwin 上就地
// app.quit() —— app 在主窗口出生前退掉。mac 走 darwin 分支, 这条路径在 mac 上永远测不到。
console.log('\n=== 关小窗到开主窗之间的空窗期 ===');
{
  const at = mainSrc.indexOf("app.on('window-all-closed'");
  ok(at !== -1, '找得到 window-all-closed');
  const seg = mainSrc.slice(at, at + 400);
  ok(/startupDone/.test(seg),
    '🔴 window-all-closed 认启动期守卫(否则关掉启动小窗那一刻 Windows 直接退出 app)');
  ok(/createWindow\(\);\s*\n\s*startupDone = true/.test(mainSrc),
    '🔴 守卫在 createWindow() 之后才放开(放早了等于没守)');
}

// exe 属性/悬停提示读的是 package.json 的 description。它一度被当成 changelog 堆放地,
// 堆到 v0.0.58 之后再没人更新 —— 用户在 0.1.3 的 exe 上看到的是 58 版的更新说明。
// 更新说明的正经去处是 config/main/release_notes.json。
console.log('\n=== exe 属性里的说明 ===');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  ok(typeof pkg.description === 'string' && pkg.description.length <= 120,
    `🔴 description 是一句话产品描述而非 changelog(当前 ${(pkg.description || '').length} 字, 上限 120)`);
  ok(!/v\d+\.\d+\.\d+[:：]/.test(pkg.description || ''),
    '🔴 description 里没有版本号开头的更新条目(更新说明去 config/main/release_notes.json)');
  // author 空着 exe 的 CompanyName 会留着 Electron 二进制自带的 "GitHub, Inc.",
  // 用户在文件属性里看到的是 electron 仓库地址。
  ok(pkg.author && (pkg.author.name || typeof pkg.author === 'string'),
    '🔴 author 有值(空着 exe 属性会显示 Electron 自带的 GitHub, Inc.)');
  ok(pkg.build && pkg.build.copyright, 'build.copyright 有值(LegalCopyright)');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
