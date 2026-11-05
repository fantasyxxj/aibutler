// test-no-global-formdata-upload.js — 主进程代码里不许拿 FormData/Blob 配全局 fetch 传文件。
// 跑法: node personal/test-no-global-formdata-upload.js
//
// 为什么要这道门禁: personal/proxy.js 把 globalThis.fetch 换成了 **npm 装的 undici 那个实例**,
// 而 FormData / Blob 仍是 **Node 内建** 的类 —— 两套互不相认。npm undici 认不出内建 FormData,
// 于是整个 body 被**静默丢掉**: 请求照发、状态码 200、没有任何异常, 只是服务端收到一个没有文件
// 字段的请求。TG 那边的表现是 `Bad Request: there is no document in the request`。
//
// 这个坑藏了很久没人发现, 因为它在任何"干净"环境里都复现不出来: 裸 node、
// ELECTRON_RUN_AS_NODE=1、甚至真实 Electron 主进程 —— 只要没加载 proxy.js, 同一段代码全都成功。
// 所以靠手测是抓不住它的, 只能静态禁掉这个写法。
//
// 正确写法: 手工拼 multipart, 只经手 Buffer(自己生成 boundary + 自己设 Content-Type header),
// 这样跟谁家的 fetch 实现都无关。见 core/agent/mcp-channels.js 的 send_tg。
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.log('  ✗ ' + m)); };

const ROOT = path.join(__dirname, '..');
// 只查主进程侧。renderer/ 跑在 Chromium 里, 那边的 FormData 和 fetch 是同一套, 不受影响。
const SCAN_DIRS = ['core', 'app', 'industry/app'];
const SKIP = /node_modules|[/\\]renderer[/\\]|[/\\]vendor[/\\]|\.min\.js$/;

function walk(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (SKIP.test(rel)) continue;
    if (e.isDirectory()) walk(rel, out);
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => walk(d));
console.log(`\n[主进程] 扫 ${files.length} 个 .js`);
ok(files.length > 0, '扫到了文件');

const offenders = [];
for (const rel of files) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  src.split('\n').forEach((line, i) => {
    if (/new\s+FormData\s*\(/.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
  });
}
ok(offenders.length === 0,
  offenders.length
    ? `主进程里出现 new FormData() —— 配 proxy 换过的全局 fetch 会静默丢 body, 改成手工 multipart:\n      ${offenders.join('\n      ')}`
    : '主进程没有 new FormData() 的上传');

// send_tg 是踩过这个坑的那一处, 单独钉住它的正确形状, 免得以后被"顺手简化"回去。
const tgSrc = fs.readFileSync(path.join(ROOT, 'core/agent/mcp-channels.js'), 'utf8');
ok(/multipart\/form-data; boundary=/.test(tgSrc), 'send_tg 自己设了 multipart boundary 头');
ok(/Buffer\.concat/.test(tgSrc), 'send_tg 用 Buffer 拼 body');
ok(!/new\s+Blob\s*\(/.test(tgSrc), 'send_tg 不再构造 Blob');

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
