#!/usr/bin/env node
// build-ui-package.js — 把一个界面包的源(html/css/js 三个文件 + meta.json)拼成 payload.json。
//
// 为什么要这个脚本: 界面包的 payload 里 html/css/js 是**字符串字段**。手写 JSON 就得手工
// 转义引号和换行 —— 那是明摆着迟早写错的活, 而且写错的表现是"界面画不出来"而不是报错。
// 有了这一步, 写包的人只管写正常的 html/css/js。
//
//   node scripts/build-ui-package.js personal/test/fixtures/ui-demo [-o payload.json]
//
// 出来的 payload.json 接着交给 sign-package.js 签名。签名之前它什么都不是 ——
// 装机端只认封好的包。
'use strict';

const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) {
  console.error('用法: node scripts/build-ui-package.js <包源目录> [-o out.json]');
  process.exit(1);
}

const read = (name) => {
  const p = path.join(dir, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
};

let meta;
try {
  meta = JSON.parse(read('meta.json') || '{}');
} catch (e) {
  console.error(`✗ meta.json 读不了: ${e.message}`);
  process.exit(1);
}

const html = read('index.html');
if (!html.trim()) { console.error('✗ index.html 是空的 —— 界面包至少要有 html'); process.exit(1); }

const payload = { ...meta, html, css: read('style.css'), js: read('app.js') };

const oi = process.argv.indexOf('-o');
const out = oi >= 0 && process.argv[oi + 1] ? process.argv[oi + 1] : path.join(dir, 'payload.json');
fs.writeFileSync(out, JSON.stringify(payload, null, 2));

const kb = (s) => `${(Buffer.byteLength(s || '') / 1024).toFixed(1)}KB`;
console.log(`✓ ${payload.type}/${payload.id}@${payload.version} → ${out}`);
console.log(`  html ${kb(payload.html)} · css ${kb(payload.css)} · js ${kb(payload.js)}`);
console.log(`  下一步: node scripts/sign-package.js sign ${out}`);
