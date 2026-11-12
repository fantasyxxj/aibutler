// test-update-check.js — 检查升级: 比版本号 · 查最新版两条路 · 只提示不下载 · 忽略这版记得住。
// 用法: node personal/test-update-check.js (假 fetch, 不联网)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { create, newer, assetName, links } = require('./update-check');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));

const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, url: headers.url || '', json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] || null } });
function rig(answers, current = '1.1.3') {
  const sent = [], opened = [], ui = [];
  const fetch = async (url, o) => { sent.push({ url, o }); const a = answers.shift(); if (a instanceof Error) throw a; return a; };
  const u = create({ fetch, current, stateFile: path.join(dir, `s-${Math.random()}.json`), sendUI: (ch, d) => ui.push([ch, d]), openExternal: (x) => opened.push(x) });
  return { u, sent, opened, ui };
}

(async () => {
  console.log('=== 比版本号 ===');
  ok(newer('1.1.10', '1.1.9'), '1.1.10 比 1.1.9 新(按数字段, 不按字符串)');
  ok(newer('v1.2.0', '1.1.9'), '带 v 前缀也认');
  ok(!newer('1.1.3', '1.1.3'), '一样不算新');
  ok(!newer('1.1.2', '1.1.3'), '旧的不算新');

  console.log('=== 安装包文件名与链接 ===');
  ok(assetName('1.1.4', 'win32') === 'aibutler-1.1.4-setup.exe', 'Windows');
  ok(assetName('1.1.4', 'darwin', 'arm64') === 'aibutler-1.1.4-arm64.dmg', 'Mac Apple 芯片');
  ok(assetName('1.1.4', 'darwin', 'x64') === 'aibutler-1.1.4-x64.dmg', 'Mac Intel');
  const l = links('1.1.4');
  ok(l.mirror === `https://gh-proxy.com/${l.direct}`, '备用镜像 = gh-proxy + 直链');

  console.log('=== API 查到新版: 挂提示, 不自动下载 ===');
  let r = rig([res(200, { tag_name: 'v1.1.4' })]);
  await r.u.check();
  ok(r.ui.at(-1)[0] === 'update-available' && r.ui.at(-1)[1].latest === '1.1.4', '推给界面 latest=1.1.4');
  ok(r.opened.length === 0, '没点之前不打开任何下载');
  ok(r.u.act({ action: 'download' }).ok && r.opened[0] === links('1.1.4').direct, '点「下载」开直链');
  ok(r.u.act({ action: 'mirror' }).ok && r.opened[1] === links('1.1.4').mirror, '点「备用镜像」开镜像');

  console.log('=== API 不通: 看 releases/latest 跳到哪个 tag ===');
  r = rig([new Error('ECONNRESET'), res(302, null, { location: 'https://github.com/fantasyxxj/aibutler/releases/tag/v1.2.0' })]);
  await r.u.check();
  ok(r.u.view().latest === '1.2.0', '第二条路查到 1.2.0');
  ok(r.sent[1].o.redirect === 'manual', '第二条路不跟跳转, 读 location');

  console.log('=== 已是最新 / 两条路都不通: 不挂 ===');
  r = rig([res(200, { tag_name: 'v1.1.3' })]);
  await r.u.check();
  ok(r.u.view().latest === null, '同版本不挂');
  r = rig([new Error('x'), new Error('y')]);
  await r.u.check();
  ok(r.u.view().latest === null && r.ui.at(-1)[1].latest === null, '查不到不挂, 也不报错');

  console.log('=== 忽略这版: 记住, 更新的版本出来再报 ===');
  r = rig([res(200, { tag_name: 'v1.1.4' }), res(200, { tag_name: 'v1.1.4' }), res(200, { tag_name: 'v1.1.5' })]);
  await r.u.check();
  ok(r.u.act({ action: 'ignore' }).ok && r.u.view().latest === null, '点「忽略这版」后不再挂');
  await r.u.check();
  ok(r.u.view().latest === null, '再查到同一版仍不挂');
  await r.u.check();
  ok(r.u.view().latest === '1.1.5', '出了 1.1.5 照报');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
