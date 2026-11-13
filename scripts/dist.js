#!/usr/bin/env node
// 打包: 只有这一个版本(作者 2026-11-05 定)。包里不带 Claude Agent SDK 和 claude 二进制 ——
// 想用 Claude 订阅的人在系统设置里自己开启, 那时才从 npm 下载(core/cc-sdk-install.js)。
// 下载认的版本和哈希在这里从 package-lock 取出, 烙进包内 package.json 的 butlerCcSdk。
//
// 用法: node scripts/dist.js --mac | --win  [--x64]  [--locked]  [--dir]
//   --x64 = mac 打 Intel 包(默认跟本机架构)
//   --locked = 分发版(源码锁, 见 personal/paths.js isLockedBuild) · --dir = 只出未压缩的 app 目录, 用来核内容
//
// mac 公证: 钥匙串里有 notarytool 凭据(默认名 butler-notary, 可用 APPLE_KEYCHAIN_PROFILE 换)就由
// electron-builder 在签名后公证 app 并装订, 再装进 dmg —— 装订在 app 上, 拖出 dmg 后断网首开也认。
// 没有凭据照常出包, 只是未公证。存凭据: xcrun notarytool store-credentials butler-notary --apple-id … --team-id …
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

// 语音识别运行库 sherpa-onnx 按平台分包(darwin-arm64 / darwin-x64 / win-x64 …), npm 只装本机那一份。
// 每个包只带目标平台那份(33MB 一份, 全带会白涨上百 MB), 并解到 asar 外: .node 和 dylib 不能从 asar 里加载。
const SHERPA_PLATS = ['darwin-arm64', 'darwin-x64', 'win-x64', 'win-ia32', 'win-arm64', 'linux-x64', 'linux-arm64'];
const sherpaTarget = ({ win = false, intel = false } = {}) => (win ? 'win-x64' : intel ? 'darwin-x64' : `darwin-${process.arch}`);

// 目标平台那份不在 node_modules 里(比如在 Apple 芯片上打 Intel / Windows 包)就从 npm 取同版本的 tarball 解进去。
function ensureSherpa(target) {
  const fs = require('fs');
  const dir = path.join(ROOT, 'node_modules', `sherpa-onnx-${target}`);
  if (fs.existsSync(path.join(dir, 'sherpa-onnx.node'))) return;
  const ver = require(path.join(ROOT, 'node_modules', 'sherpa-onnx-node', 'package.json')).version;
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sherpa-'));
  const tgz = execFileSync('npm', ['pack', `sherpa-onnx-${target}@${ver}`, '--silent'], { cwd: tmp }).toString().trim().split('\n').pop();
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xzf', path.join(tmp, tgz), '-C', dir, '--strip-components', '1']);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!fs.existsSync(path.join(dir, 'sherpa-onnx.node'))) throw new Error(`sherpa-onnx-${target}@${ver} 里没有 sherpa-onnx.node`);
  console.log(`[dist] 补装语音运行库 sherpa-onnx-${target}@${ver}`);
}

function buildConfig(base, { locked = false, intel = false, win = false } = {}) {
  const cfg = JSON.parse(JSON.stringify(base));
  const target = sherpaTarget({ win, intel });
  cfg.files = [...cfg.files, ...SHERPA_PLATS.filter((p) => p !== target).map((p) => `!node_modules/sherpa-onnx-${p}/**`)];
  cfg.asarUnpack = [...(cfg.asarUnpack || []), `node_modules/sherpa-onnx-${target}/**`];
  cfg.extraMetadata = { ...(cfg.extraMetadata || {}), butlerCcSdk: ccSdkManifest(), ...(locked ? { butlerFlavor: 'locked' } : {}) };
  if (locked) {
    cfg.mac = { ...cfg.mac, artifactName: '${productName}-${version}-${arch}-locked.${ext}' };
    cfg.nsis = { ...cfg.nsis, artifactName: '${productName} Setup ${version} locked.${ext}' };
  }
  if (intel) cfg.mac = { ...cfg.mac, artifactName: `\${productName}-\${version}-x64-intel${locked ? '-locked' : ''}.\${ext}` };
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
  const plat = { locked: want.includes('--locked'), intel: want.includes('--x64'), win: want.includes('--win') };
  ensureSherpa(sherpaTarget(plat));
  fs.writeFileSync(cfgFile, JSON.stringify(buildConfig(pkg.build, plat), null, 2));
  const builder = require('electron-builder');
  const dir = want.includes('--dir') ? 'dir' : undefined;
  if (!want.includes('--win') && !dir) {
    const profile = process.env.APPLE_KEYCHAIN_PROFILE || 'butler-notary';
    let ok = false;
    try { execFileSync('xcrun', ['notarytool', 'history', '--keychain-profile', profile], { stdio: 'ignore' }); ok = true; } catch {}
    if (ok) process.env.APPLE_KEYCHAIN_PROFILE = profile;
    console.log(ok ? `[dist] 公证: 用钥匙串凭据 ${profile}` : `[dist] ⚠️ 钥匙串里没有 notarytool 凭据 ${profile}, 这个包不公证`);
  }
  const targets = want.includes('--win') ? builder.Platform.WINDOWS.createTarget(dir, builder.Arch.x64) : builder.Platform.MAC.createTarget(dir, ...(want.includes('--x64') ? [builder.Arch.x64] : []));
  await builder.build({ targets, config: cfgFile });
})().catch((e) => { console.error(e); process.exit(1); });

module.exports = { buildConfig };
