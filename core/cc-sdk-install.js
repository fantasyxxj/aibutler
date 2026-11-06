// cc-sdk-install.js — 「使用 Claude 订阅」: 用户自己开, 才去 npm 现下 Claude Agent SDK。
//
// 为什么这么做(作者 2026-11-05 定): SDK 和 claude 二进制是 Anthropic 的闭源许可, 我们的包不能带;
// 但有订阅的人用订阅跑最划算, 不能把他们挡在门外。所以包里不带, 用户在系统设置里确认 Anthropic
// 条款后, 由他自己这台机器从 npm 下载 —— 我们不分发。安装包只有这一个版本, 作者自己用的也是它。
//
// 版本和哈希在打包时由 scripts/dist.js 从 package-lock 烙进 package.json 的 butlerCcSdk,
// 开发时直接读 package-lock。下载完逐个校验 sha512, 对不上就删掉报错, 不落半份。
// 装好的样子: <dataDir>/vendor/claude-agent-sdk/<版本>/{sdk/sdk.mjs, bin/claude(.exe)}。
// 开启 / 关闭都要重启 app 才算数: SDK 加载结果和 claude 路径都在启动时定下(util.js / main.js)。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SCOPE = '@anthropic-ai';
const MAIN = 'claude-agent-sdk';
const REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'];   // 官方在前, 国内镜像兜底
const ROOT = path.join(__dirname, '..');

const platPkg = () => `${MAIN}-${process.platform}-${process.arch}`;
const binName = () => (process.platform === 'win32' ? 'claude.exe' : 'claude');

// 版本清单所在的 app 根目录。宿主可给 paths.appRoot(): 行业版打包后 core 在 node_modules/@butler/core 里, 上一层没有 package.json
function appRoot() {
  try { const f = require('./host').paths.appRoot; if (typeof f === 'function') return f(); } catch (_) {}
  return ROOT;
}

// { version, integrity: { <包名>: 'sha512-…' } } | null
let _manifest;
function manifest() {
  if (_manifest !== undefined) return _manifest;
  _manifest = null;
  const root = appRoot();
  try {
    const m = require(path.join(root, 'package.json')).butlerCcSdk;
    if (m && m.version && m.integrity) return (_manifest = m);
  } catch (_) {}
  try {   // 开发: 没烙过, 现读 lock
    const pk = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages || {};
    const main = pk[`node_modules/${SCOPE}/${MAIN}`];
    if (!main) return _manifest;
    const integrity = {};
    for (const [k, v] of Object.entries(pk)) {
      const n = k.replace(`node_modules/${SCOPE}/`, '');
      if (k.startsWith(`node_modules/${SCOPE}/${MAIN}`) && v.integrity && v.version === main.version) integrity[n] = v.integrity;
    }
    _manifest = { version: main.version, integrity };
  } catch (_) {}
  return _manifest;
}

// 本来就有 SDK: 开发机的 node_modules(安装包里一律不带)。BUTLER_CC_BUNDLED=0 只给测试用: 在开发机上装作没带。
function bundled() {
  // BUTLER_SIMULATE_INSTALL=1: dev 模拟刚装好的安装包, 仓里那份 SDK 当没有(安装包本就不带)
  if (process.env.BUTLER_CC_BUNDLED === '0' || process.env.BUTLER_SIMULATE_INSTALL === '1') return false;
  try { require.resolve(`${SCOPE}/${MAIN}`); return true; } catch (_) { return false; }
}

// root 可由宿主直接给: personal/paths.js 解析 claude 路径时 core/host 可能还没接好
function baseDir(root) { return path.join(root || require('./host').paths.dataDir(), 'vendor', MAIN); }
function filesDir(root) { const m = manifest(); return m ? path.join(baseDir(root), m.version) : null; }
const exists = (p) => { try { return !!p && fs.existsSync(p); } catch (_) { return false; } };
// 两个标记(作者 2026-11-05 定: 关闭和删除分开, 删之前要用户确认):
//   .off    = 用户关了订阅, 文件留着, 再开启不用重新下载
//   .remove = 用户确认删, 但 Windows 上 claude.exe 正在跑删不掉, 下次启动(register)再删; 有它就当没下载过
const offMark = (root) => baseDir(root) + '.off';
const removeMark = (root) => baseDir(root) + '.remove';
function hasFiles(root) {
  const d = filesDir(root);
  return !!d && !exists(removeMark(root)) && exists(path.join(d, 'sdk', 'sdk.mjs')) && exists(path.join(d, 'bin', binName()));
}
const active = (root) => hasFiles(root) && !exists(offMark(root));

// 开着的 SDK 入口 / claude 二进制; 没下载或已关闭返回 null
function sdkEntry(root) { return active(root) ? path.join(filesDir(root), 'sdk', 'sdk.mjs') : null; }
function binPath(root) { return active(root) ? path.join(filesDir(root), 'bin', binName()) : null; }

// installed = 文件在 · enabled = 文件在且没关
function status() {
  const m = manifest();
  const applicable = !!m && !bundled() && !!(m.integrity[MAIN] && m.integrity[platPkg()]);
  return { applicable, installed: applicable && hasFiles(), enabled: applicable && active(), installing: !!_inflight, version: m ? m.version : '' };
}

function sri(file) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha512');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => res('sha512-' + h.digest('base64'))).on('error', rej);
  });
}

function untar(tgz, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  // Win10 1803+ 自带 tar.exe, mac/linux 都有 —— 同 voice-stt 的解压
  const t = spawnSync('tar', ['-xzf', tgz, '-C', outDir], { timeout: 300000 });
  if (t.status !== 0) throw new Error(`extract failed: ${String(t.stderr || t.error || '').slice(0, 200)}`);
  return path.join(outDir, 'package');   // npm 包解出来都套一层 package/
}

// onProgress({ step: 'sdk'|'bin'|'extract', pct })
async function doInstall(onProgress) {
  const st = status();
  if (!st.applicable) return { ok: false, error: 'not_applicable' };
  fs.rmSync(offMark(), { force: true });   // 再开启: 文件还在就不用下载
  if (st.installed) return { ok: true };
  if (exists(removeMark())) { fs.rmSync(baseDir(), { recursive: true, force: true }); fs.rmSync(removeMark(), { force: true }); }
  const m = manifest();
  const { downloadFrom } = require('./voice-stt');   // 带代理 · 断点续传 · 逐源重试
  const stage = filesDir() + '.staging';
  fs.rmSync(stage, { recursive: true, force: true });
  const dl = path.join(baseDir(), 'downloads');
  const parts = [{ name: MAIN, step: 'sdk', dest: 'sdk' }, { name: platPkg(), step: 'bin', dest: 'bin' }];
  for (const p of parts) {
    const tgz = path.join(dl, `${p.name}-${m.version}.tgz`);
    if (!exists(tgz)) {
      await downloadFrom(REGISTRIES, `/${SCOPE}/${p.name}/-/${p.name}-${m.version}.tgz`, tgz, (pct) => onProgress({ step: p.step, pct }));
    }
    const got = await sri(tgz);
    if (got !== m.integrity[p.name]) {
      fs.rmSync(tgz, { force: true });
      throw new Error(`integrity mismatch: ${p.name}`);
    }
    onProgress({ step: 'extract', pct: 0 });
    const pkgDir = untar(tgz, path.join(stage, '_x', p.dest));
    fs.renameSync(pkgDir, path.join(stage, p.dest));
  }
  fs.rmSync(path.join(stage, '_x'), { recursive: true, force: true });
  if (process.platform !== 'win32') fs.chmodSync(path.join(stage, 'bin', binName()), 0o755);
  fs.rmSync(filesDir(), { recursive: true, force: true });
  fs.renameSync(stage, filesDir());   // 落正式名放最后: 中断只会留下 .staging
  fs.rmSync(dl, { recursive: true, force: true });
  console.log(`[cc-sdk] 已装好 Claude Agent SDK ${m.version} → ${filesDir()}`);
  return { ok: true };
}

let _inflight = null;
function install(onProgress = () => {}) {   // 单飞: 重复点只跟同一次
  if (!_inflight) {
    _inflight = doInstall(onProgress)
      .catch((e) => { console.error('[cc-sdk] 安装失败:', e && e.message); return { ok: false, error: String((e && e.message) || e) }; })
      .finally(() => { _inflight = null; });
  }
  return _inflight;
}

// 关闭订阅; deleteFiles = 用户在第二个确认框里同意删掉下载的文件
function disable({ deleteFiles } = {}) {
  if (_inflight) return { ok: false, error: 'installing' };
  fs.mkdirSync(path.dirname(offMark()), { recursive: true });
  fs.writeFileSync(offMark(), '');
  if (deleteFiles) {
    try { fs.rmSync(baseDir(), { recursive: true, force: true }); fs.rmSync(offMark(), { force: true }); }
    catch (e) { fs.writeFileSync(removeMark(), ''); console.log(`[cc-sdk] 文件占用中, 下次启动再删: ${e.message}`); }
  }
  console.log(`[cc-sdk] 已关闭 Claude 订阅${deleteFiles ? ', 删掉下载的文件' : ', 文件留着'}`);
  return { ok: true };
}

// 每次启动都查: 有要跑 Claude Code 的人格、本机却没有这一版要的 SDK(老包自带的那份随覆盖安装没了 /
// 安装包换了 SDK 版本)、也没被用户关过 → 先由宿主问一句, 同意才下载。
// 🔴 等下载完才返回: 宿主拿到 ok 就直接重启, 人格和主窗口都不在下载期间起来 ——
// 否则人格先在没有 SDK 的状态下起来, 立刻接入故障被挂起, 紧接着又被重启打断(作者 11-05)。
// 返回 null = 没下载(不需要 / 用户选了稍后) · { ok, error? } = 下载结果。
async function autoEnable({ hasSubscriptionPersona, confirm, onStart = () => {}, onProgress }) {
  const st = status();
  if (!st.applicable || st.installed || exists(offMark()) || !hasSubscriptionPersona()) return null;
  console.log(`[cc-sdk] 有要跑 Claude Code 的人格, 本机没有 ${st.version} → 问要不要下载`);
  if (confirm && !(await confirm())) { console.log('[cc-sdk] 用户选了稍后, 下次启动再问'); return null; }
  await onStart();
  return install(onProgress);
}

// relaunch: 宿主给的「重启 app」(core 不认识 Electron) · send: 往设置窗口推进度
function register({ ipcMain, relaunch, send }) {
  if (exists(removeMark())) {   // 上次关闭时没删干净的, 这次启动还没人用它, 删得掉
    try { fs.rmSync(baseDir(), { recursive: true, force: true }); fs.rmSync(removeMark(), { force: true }); fs.rmSync(offMark(), { force: true }); } catch (e) { console.error('[cc-sdk] 删除仍失败:', e.message); }
  }
  ipcMain.handle('cc-sdk-status', async () => status());
  ipcMain.handle('cc-sdk-install', async () => install((p) => send && send('cc-sdk-progress', p)));
  ipcMain.handle('cc-sdk-disable', async (_e, opts) => disable(opts || {}));
  ipcMain.handle('cc-sdk-relaunch', async () => { relaunch(); return { ok: true }; });
}

module.exports = { manifest, bundled, status, install, disable, autoEnable, sdkEntry, binPath, register };
