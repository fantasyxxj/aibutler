// test-openers.js — 文件路径右键"用某某打开"的跨平台门禁
// 背景: 0.0.53 曾因 `open -a` 是 macOS 专用, 就把 Windows 上的 Chrome/VSCode 两项整个砍掉。
//       正确做法是换实现不是删功能 → 这里钉住"两个平台都得有", 以及三方(main/preload/renderer)接线对齐。
// main.js 是 electron 主进程(require 会拉 electron), 故按文本静态断言, 不实例化。
const fs = require('fs');
const path = require('path');

const read = require('./kernel-src').readSrc;   // 源码可能在 core/ 也可能在仓根, 解析收在一处
const MAIN = read('main.js');
const PRELOAD = read('preload.js');
const RENDERER = read('renderer/renderer.js');

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('  PASS ' + label); } else { fail++; console.log('  FAIL ' + label); } };

// ---- A. 主进程: 两个平台都要有解析分支 ----
console.log('\n== A. main.js 打开方式解析 ==');
ok(/const APP_TARGETS\s*=/.test(MAIN), 'APP_TARGETS 表存在');
for (const key of ['chrome', 'vscode']) {
  const block = new RegExp(`${key}:\\s*\\{[\\s\\S]{0,700}?\\n  \\}`).exec(MAIN);
  ok(!!block, `APP_TARGETS.${key} 有定义`);
  if (!block) continue;
  ok(/mac:\s*'/.test(block[0]), `${key} 有 mac 分支(open -a 的 app 名)`);
  ok(/win:\s*\(\)\s*=>\s*\[/.test(block[0]), `${key} 有 win 分支(exe 候选路径)`);
  const winPaths = (block[0].match(/\.exe`/g) || []).length;
  ok(winPaths >= 2, `${key} win 候选 ≥2 处安装位置(实际 ${winPaths})`);
}
ok(/process\.env\.PROGRAMFILES/.test(MAIN) && /PROGRAMFILES\(X86\)/.test(MAIN) && /process\.env\.LOCALAPPDATA/.test(MAIN),
  'win 候选覆盖 PROGRAMFILES / (X86) / LOCALAPPDATA 三类安装位置');

console.log('\n== B. resolveOpener: 探测而非扫盘 ==');
ok(/function resolveOpener\(/.test(MAIN), 'resolveOpener 存在');
ok(/_openerCache/.test(MAIN), '探测结果有缓存(不每次右键都探)');
ok(/'open',\s*\['-Ra'/.test(MAIN), 'mac 侧用 open -Ra 查 LaunchServices 判装没装');
ok(!/mdfind|find\s+\/|ls\s+-R/.test(MAIN.slice(MAIN.indexOf('const APP_TARGETS'), MAIN.indexOf('list-openers'))),
  '不扫盘找二进制(禁 mdfind/find //ls -R)');

console.log('\n== C. open-with-app 真按平台分流 ==');
const handler = /ipcMain\.handle\('open-with-app'[\s\S]*?\n\}\);/.exec(MAIN);
ok(!!handler, 'open-with-app handler 存在');
if (handler) {
  ok(/resolveOpener\(app\)/.test(handler[0]), '起进程前先解析本机可用性');
  ok(/kind === 'mac'/.test(handler[0]), '有 mac 分支');
  ok(/opener\.exe/.test(handler[0]), '有 win 分支(直接 spawn exe)');
  ok(/本机没找到/.test(handler[0]), '没装时回明确错误而不是静默失败');
}

// ---- D. 三方接线对齐: main handle ↔ preload 暴露 ↔ renderer 消费 ----
// (这个坑犯过两次: preload 暴露了 renderer 没接 / renderer 调了 preload 没暴露)
console.log('\n== D. main ↔ preload ↔ renderer 对齐 ==');
for (const [channel, api] of [['list-openers', 'listOpeners'], ['open-with-app', 'openWithApp']]) {
  ok(new RegExp(`ipcMain\\.handle\\('${channel}'`).test(MAIN), `main 有 handle('${channel}')`);
  ok(new RegExp(`${api}:\\s*\\(.*?\\)\\s*=>\\s*ipcRenderer\\.invoke\\('${channel}'`).test(PRELOAD),
    `preload.${api} → invoke('${channel}')`);
  ok(new RegExp(`window\\.butler\\.${api}\\(`).test(RENDERER), `renderer 真的调了 window.butler.${api}()`);
}

// ---- E. 渲染层: 菜单由 listOpeners 驱动, 不再硬编码 app 名 / 不再按平台砍功能 ----
console.log('\n== E. renderer 菜单构建 ==');
ok(/_openers/.test(RENDERER), '菜单项来自主进程返回的可用列表');
ok(!/openWithApp\(p,\s*'Google Chrome'\)/.test(RENDERER) && !/openWithApp\(p,\s*'Visual Studio Code'\)/.test(RENDERER),
  '不再硬编码 macOS app 名(改传 chrome/vscode 逻辑名)');
const menuFn = /function showPathContextMenu[\s\S]*?\n\}/.exec(RENDERER);
ok(!!menuFn && !/IS_WIN\s*\?/.test(menuFn[0]),
  '菜单不再按 IS_WIN 砍掉整组"用某某打开"(Windows 与 Mac 一致)');
// 文案本身搬进 i18n.js 之后, 这里守的仍是同一件事: **只有**这一项按平台分叉,
// 且两个平台各有各的说法。文字长什么样归 test-i18n.js 管。
ok(/revealLabel\s*=\s*\(\)\s*=>\s*\(?\s*IS_WIN\s*\?\s*t\('reveal_explorer'\)\s*:\s*t\('reveal_finder'\)/.test(RENDERER),
  '仅"在文件管理器中显示"的文案按平台走(资源管理器/Finder)');

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
