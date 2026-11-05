#!/usr/bin/env node
// 打包: 只有这一个版本(作者 2026-11-05 定)。包里不带 Claude Agent SDK 和 claude 二进制 ——
// 想用 Claude 订阅的人在系统设置里自己开启, 那时才从 npm 下载(core/cc-sdk-install.js)。
// 下载认的版本和哈希在这里从 package-lock 取出, 烙进包内 package.json 的 butlerCcSdk。
//
// 用法: node scripts/dist.js --mac | --win  [--locked]  [--dir]
//   --locked = 分发版(源码锁, 见 personal/paths.js isLockedBuild) · --dir = 只出未压缩的 app 目录, 用来核内容
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });

function ccSdkManifest() {
  const m = require('../core/cc-sdk-install').manifest();
  if (!m || !m.integrity['claude-agent-sdk'] || !m.integrity['claude-agent-sdk-win32-x64']) throw new Error('package-lock 里缺 Claude Agent SDK 的哈希');
  return m;
}

function buildConfig(base, { locked = false } = {}) {
  const cfg = JSON.parse(JSON.stringify(base));
  cfg.extraMetadata = { ...(cfg.extraMetadata || {}), butlerCcSdk: ccSdkManifest(), ...(locked ? { butlerFlavor: 'locked' } : {}) };
  if (locked) {
    cfg.mac = { ...cfg.mac, artifactName: '${productName}-${version}-${arch}-locked.${ext}' };
    cfg.nsis = { ...cfg.nsis, artifactName: '${productName} Setup ${version} locked.${ext}' };
  }
  return cfg;
}

// 只在直接跑时打包: 门禁 / 别的脚本 require 它取 buildConfig 时不该顺手打出一个包
if (require.main === module) (async () => {
  const want = process.argv.slice(2);
  // 先在 agent-sdk 里补装它自己的依赖: 仓根 npm install 会把 file: 依赖的子依赖提到外面, 包里就缺了
  run('npm', ['run', 'build:agent-sdk']);
  run('node', ['scripts/vendor-embed.js']);
  // 配置对象会被 electron-builder 和 package.json 的 build 字段深合并(数组按下标合)。
  // 写成独立文件按路径传, 它就只读这一份。
  const os = require('os');
  const fs = require('fs');
  const cfgFile = path.join(os.tmpdir(), `butler-build-${process.pid}.json`);
  fs.writeFileSync(cfgFile, JSON.stringify(buildConfig(pkg.build, { locked: want.includes('--locked') }), null, 2));
  const builder = require('electron-builder');
  const dir = want.includes('--dir') ? 'dir' : undefined;
  const targets = want.includes('--win') ? builder.Platform.WINDOWS.createTarget(dir, builder.Arch.x64) : builder.Platform.MAC.createTarget(dir);
  await builder.build({ targets, config: cfgFile });
})().catch((e) => { console.error(e); process.exit(1); });

module.exports = { buildConfig };
