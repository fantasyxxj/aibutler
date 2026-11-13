// voice-stt.js — 本地 STT adapter: SenseVoice 优先(voice-sensevoice.js), 运行库加载不了才走 whisper.cpp
// 暴露: detect() 探测 / setup(onProgress) 自动装引擎+模型 / transcribe(wavBytes, lang) 一段音频→文字 / saveAudio(homeDir, wavBytes) 写永久文件
// whisper.cpp 只吃 wav/mp3/ogg/flac; renderer 端 recorder.js 已封 16kHz mono 16-bit WAV, 落盘直用.
//
// 安装策略 (2026-08-10 作者拍板: 别让用户自己瞎弄):
//   Win  = 官方 release 是绿色包(exe+dll, 解压即用) → 我们代下代解压到自管目录, 用户零操作
//   Mac  = 官方不发预编译, 走 brew; brew 本身代替不了用户装, 但装完 brew 之后都由我们代跑
//   模型 = 两平台都由我们下 (纯数据文件, 无权限问题)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { nowLocalISO } = require('./memory');   // 时间一律本地时区(带偏移), 禁 UTC
const sv = require('./voice-sensevoice');

const ENGINE_TAG = 'v1.9.2';
// 下载源 = 基址列表 + 尾巴, downloadFrom() 逐个试到成功为止。官方在前, 镜像兜底。
// 🔴 镜像不是锦上添花, 是国内唯一走得通的路: 真机三连实测(2026-09-23) —— GitHub 直连
// HTTP 000, 配好本机代理后 curl 仍在 TLS 握手阶段报 schannel 失败, 只有前缀镜像成功。
// 所以"让用户去设置页填网络代理"那条现成方案在 Windows 上不保证管用。
// gh-proxy 的形状是把整条原 URL 接在后面, 所以它当基址用正好对得上。
const GH_BASES = ['https://github.com', 'https://gh-proxy.com/https://github.com'];
const HF_BASES = ['https://huggingface.co', 'https://hf-mirror.com'];
const WIN_ZIP_TAIL = `/ggml-org/whisper.cpp/releases/download/${ENGINE_TAG}/whisper-bin-x64.zip`;
const MODEL_TAIL = '/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
// zip 里 37 个文件只有这些用得上; 其余是 parakeet/SDL2/test-*/talk-llama.
// ggml-cpu-*.dll 是 9 个指令集变体(alderlake/cannonlake/cascadelake/haswell/icelake/
// sandybridge/skylakex/sse42/x64), whisper 运行时按 CPU 挑一个加载 —— 少拷一个都可能起不来.
const WIN_KEEP = /^(whisper-cli\.exe|whisper\.dll|ggml\.dll|ggml-base\.dll|ggml-cpu-.+\.dll)$/i;

// 用户自装 · 常见 brew 二进制路径 (Mac) + 跨平台 PATH 扫描
const CLI_ABS_CANDIDATES = process.platform === 'darwin' ? [
  '/opt/homebrew/bin/whisper-cli',    // Mac Apple Silicon brew
  '/usr/local/bin/whisper-cli',       // Mac Intel brew / manual
] : [];
const CLI_BIN_NAMES = process.platform === 'win32'
  ? ['whisper-cli.exe', 'main.exe', 'whisper.exe']
  : ['whisper-cli', 'main', 'whisper'];

// 两个 vendor 根, 查找顺序 bundled → writable:
//   bundled  = 安装包里自带的(只读, 随 app 出厂) —— 🔴 行业版走这条: 店里装完就能用, 不让店长等下载,
//              也不赌店里的网能不能连上 GitHub / HuggingFace。装机必须是"下一步下一步"。
//   writable = 数据目录(可写) —— 出厂没带(某平台缺预编译)或将来要换模型时的兜底下载位置
// 宿主启动时用 setVendorRoots 注入; 没注入退回家目录, 保证门禁/CLI 环境也能跑。
// engine: 宿主选引擎。'sensevoice' = 运行库能加载就走 SenseVoice(个人版); 不传 = whisper(行业版随包带的就是它,
// 而 core 在仓里能顺着根 node_modules 摸到 sherpa, 不靠宿主显式选的话行业版 dev 会悄悄换引擎、去下新模型)。
let _roots = { bundled: null, writable: null, engine: null };
function setVendorRoots({ bundled, writable, engine } = {}) {
  _roots = { bundled: bundled || null, writable: writable || null, engine: engine || null };
}
const useSv = () => _roots.engine === 'sensevoice' && sv.available();
const writableDir = () => path.join(_roots.writable || path.join(os.homedir(), '.butler'), 'whisper');
const vendorBinDir = () => path.join(writableDir(), 'bin');
const vendorModel = () => path.join(writableDir(), 'models', 'ggml-base.bin');
const bundledBinDir = () => (_roots.bundled ? path.join(_roots.bundled, 'whisper', 'bin', process.platform) : null);
const bundledModel = () => (_roots.bundled ? path.join(_roots.bundled, 'whisper', 'models', 'ggml-base.bin') : null);

// 模型查找顺序: 出厂自带 → 我们下载的 → 用户手工放的
function modelCandidates() {
  return [
    bundledModel(),
    vendorModel(),
    path.join(os.homedir(), 'whisper-models', 'ggml-base.bin'),
    path.join(os.homedir(), 'whisper-models', 'ggml-small.bin'),
    path.join(os.homedir(), 'whisper-models', 'ggml-medium.bin'),
  ].filter(Boolean);
}

function findCli() {
  // 0. 出厂自带优先 —— 装完即可用, 用户什么都不用做
  for (const dir of [bundledBinDir(), vendorBinDir()]) {
    if (!dir) continue;
    for (const bin of CLI_BIN_NAMES) {
      const full = path.join(dir, bin);
      try { if (fs.existsSync(full)) return full; } catch (_) {}
    }
  }
  // 1. 硬编码绝对路径 (Mac brew 常见位置)
  for (const c of CLI_ABS_CANDIDATES) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  // 2. 跨平台扫 process.env.PATH (不依赖 which/where shell 命令 · Win 上 which 不存在 · PowerShell 里 where 是 Where-Object 别名)
  const paths = (process.env.PATH || '').split(path.delimiter);
  for (const dir of paths) {
    if (!dir) continue;
    for (const bin of CLI_BIN_NAMES) {
      const full = path.join(dir, bin);
      try { if (fs.existsSync(full)) return full; } catch (_) {}
    }
  }
  return null;
}

function findModel() {
  for (const m of modelCandidates()) {
    try { if (fs.existsSync(m)) return m; } catch (_) {}
  }
  return null;
}

// pip 版 openai-whisper 与 whisper.cpp 参数正相反(-f: cpp=输入文件 / python=输出格式),
// 混用不会在探测时报错, 要等真转写才非零退出. 所以必须在 detect 阶段认出来.
// 曾靠名字判断(认为只有 cpp 会叫 whisper-cli), 2026-08-10 被实机证伪 → 一律实跑 -h 认特征.
const _cppProbeCache = new Map();
function isWhisperCpp(cli) {
  if (_cppProbeCache.has(cli)) return _cppProbeCache.get(cli);
  const r = probeWhisperCpp(cli);
  _cppProbeCache.set(cli, r);
  return r;
}
function probeWhisperCpp(cli) {
  // 出厂自带 / 自管目录里的是我们自己放的, 一定是 cpp, 不必花一次 spawn
  for (const dir of [bundledBinDir(), vendorBinDir()]) {
    if (dir && cli.startsWith(dir + path.sep)) return true;
  }
  try {
    // python 版冷启要 import torch, 原来 5s 会超时 → 落进"判不准"分支被误放行
    const r = spawnSync(cli, ['-h'], { timeout: 20000, encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    if (/--model_dir|--output_format|--clip_timestamps|openai-whisper/i.test(out)) return false;
    if (/--no-timestamps|--output-txt|whisper\.cpp|--max-len/i.test(out)) return true;
  } catch (_) {}
  // 判不准: 代价不对称 —— 误拒只是让用户点一下装正确引擎, 误放是转写时一堆看不懂的报错.
  // 所以能代装就拒, 代装不了(如 Linux)才放行, 别把用户唯一的引擎误杀.
  return !engineAutoInstallable();
}

function findBrew() {
  for (const c of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

// 引擎能不能由我们代装: Win x64 有绿色包; Mac 要用户先有 brew
function engineAutoInstallable() {
  if (process.platform === 'win32') return process.arch === 'x64';
  if (process.platform === 'darwin') return !!findBrew();
  return false;
}

// 🔴 只返回**状态码**, 不返回文案。
// 「要不要下载语音引擎」是用户第一次点麦克风就会看到的东西 = 系统出厂内容, 必须跟界面语言走。
// 所以翻译交给 i18n, 这个模块不认识任何一种自然语言。
function noCliHint() {
  if (process.platform === 'win32') {
    return process.arch === 'x64' ? 'stt_can_download_engine' : 'stt_no_prebuilt_for_arch';
  }
  if (process.platform === 'darwin') {
    return findBrew() ? 'stt_can_brew_engine' : 'stt_need_homebrew';
  }
  return 'stt_install_manually';
}

function detect() {
  if (useSv()) {
    const model = sv.findModel(_roots);
    if (!model) return { ok: false, engine: 'sensevoice', error: 'no_model', hintCode: 'stt_can_download_model', canAutoInstall: true };
    return { ok: true, engine: 'sensevoice', model };
  }
  const cli = findCli();
  if (!cli) return { ok: false, error: 'no_cli', hintCode: noCliHint(), arch: process.arch, canAutoInstall: engineAutoInstallable() };
  if (!isWhisperCpp(cli)) {
    return { ok: false, cli, error: 'wrong_cli', hintCode: 'stt_wrong_cli', canAutoInstall: engineAutoInstallable() };
  }
  const model = findModel();
  if (!model) return { ok: false, cli, error: 'no_model', hintCode: 'stt_can_download_model', canAutoInstall: true };
  return { ok: true, cli, model };
}

// ---- 下载 (跟随 redirect · 进度回调 · 半成品不落正式名) ----
// 用 fetch 而不是 node:https —— node:https 不认任何代理设置, 国内用户下 GitHub/HuggingFace
// 会直接卡死。全局 fetch 已被 proxy.js 换成带 dispatcher 的 undici fetch, 走这条才吃得到代理。
// redirect 由 fetch 自己跟(默认 follow), 不用再手工递归。
async function download(url, destPath, onProgress) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const part = destPath + '.part';
  // 断点续传: 上次断在哪就从哪接着要。百兆级文件在弱网下断一次是常态,
  // 每次从头下不只是慢 —— 那是永远下不完(下到八成断线, 重来又断在八成)。
  let have = 0;
  try { have = fs.statSync(part).size; } catch (_) {}
  const headers = { 'User-Agent': 'butler' };
  if (have) headers.Range = `bytes=${have}-`;
  const resp = await fetch(url, { headers, redirect: 'follow' });
  if (!resp.ok) throw new Error(`download failed: HTTP ${resp.status}`);

  // 206 = 服务端认了续传; 200 = 它要从头给(不支持 Range, 或半成品已经比整份还大 = 文件换过了)。
  // 后者必须把旧的半成品丢掉重写, 否则拼出来的是一个没人会报错的坏文件。
  const resuming = have > 0 && resp.status === 206;
  if (!resuming) have = 0;
  const total = Number(resp.headers.get('content-length') || 0) + have;
  const f = fs.createWriteStream(part, resuming ? { flags: 'a' } : {});
  let got = have, lastPct = -1;
  try {
    for await (const chunk of resp.body) {
      got += chunk.length;
      const pct = total ? Math.floor(got / total * 100) : 0;
      if (pct !== lastPct) { lastPct = pct; onProgress(pct, got, total); }
      if (!f.write(chunk)) await new Promise((r) => f.once('drain', r));
    }
    await new Promise((res, rej) => { f.end((e) => (e ? rej(e) : res())); });
    fs.renameSync(part, destPath);      // 落正式名放在最后一步: 中断留下的只会是 .part
    return destPath;
  } catch (e) {
    // 半成品留着不删 —— 它就是下次续传的起点。只有落正式名才代表这份文件完整。
    try { f.destroy(); } catch (_) {}
    throw e;
  }
}

// 逐个基址试, 头一个下成就收工; 全试完还不成才抛最后那个错。
// 🔴 半成品 .part 故意跨源保留 —— 镜像发的是同一份字节, 换源之后照样接着下; 万一对不上,
// download() 里那句「200 而非 206 就把旧 part 丢掉重写」会兜住, 不会拼出一个坏文件。
async function downloadFrom(bases, tail, destPath, onProgress) {
  let lastErr;
  for (const base of bases) {
    try {
      return await download(base + tail, destPath, onProgress);
    } catch (e) {
      lastErr = e;
      console.error(`[download] 源不通, 换下一个: ${base} — ${(e && e.message) || e}`);
    }
  }
  throw lastErr;
}

function unzip(zipPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  // Win10 1803+ 自带 tar.exe (支持 zip); Mac/Linux 的 bsdtar 同样支持
  const t = spawnSync('tar', ['-xf', zipPath, '-C', outDir], { timeout: 120000 });
  if (t.status === 0) return true;
  if (process.platform === 'win32') {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`], { timeout: 120000 });
    if (ps.status === 0) return true;
  }
  throw new Error('extract failed: neither tar nor Expand-Archive available');
}

// 把解压目录里符合白名单的文件平铺拷进 binDir (zip 内是 Release/ 子目录, 拍平掉)
function collectWinBinaries(srcDir, binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  let n = 0;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (WIN_KEEP.test(ent.name)) { fs.copyFileSync(p, path.join(binDir, ent.name)); n++; }
    }
  };
  walk(srcDir);
  return n;
}

async function installEngine(onProgress) {
  if (process.platform === 'win32') {
    if (process.arch !== 'x64') throw new Error(`no official prebuilt binary for arch=${process.arch}`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-whisper-'));
    try {
      const zip = path.join(tmp, 'whisper.zip');
      onProgress({ phase: 'engine', pct: 0, noteCode: 'stt_downloading_engine' });
      await downloadFrom(GH_BASES, WIN_ZIP_TAIL, zip, (pct) => onProgress({ phase: 'engine', pct, noteCode: 'stt_downloading_engine' }));
      onProgress({ phase: 'engine', pct: 100, noteCode: 'stt_extracting' });
      unzip(zip, path.join(tmp, 'x'));
      const n = collectWinBinaries(path.join(tmp, 'x'), vendorBinDir());
      if (!n) throw new Error('whisper-cli.exe not found after extraction');
      onProgress({ phase: 'engine', pct: 100, noteCode: 'stt_engine_ready' });
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
    return;
  }
  if (process.platform === 'darwin') {
    const brew = findBrew();
    if (!brew) throw new Error('Homebrew is not installed');
    onProgress({ phase: 'engine', pct: 0, noteCode: 'stt_brew_installing' });
    await new Promise((resolve, reject) => {
      const p = spawn(brew, ['install', 'whisper-cpp'], { env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' } });
      let err = '';
      p.stdout.on('data', (b) => {
        const line = b.toString('utf8').trim().split('\n').pop();
        if (line) onProgress({ phase: 'engine', pct: 0, noteCode: 'stt_brew_installing', detail: line.slice(0, 80) });
      });
      p.stderr.on('data', (b) => { err += b.toString('utf8'); });
      p.on('error', reject);
      p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`brew install failed: ${err.slice(-300)}`)));
    });
    return;
  }
  throw new Error(`automatic install not supported on platform=${process.platform}`);
}

async function installModel(onProgress) {
  onProgress({ phase: 'model', pct: 0, noteCode: 'stt_downloading_model' });
  await downloadFrom(HF_BASES, MODEL_TAIL, vendorModel(), (pct) => onProgress({ phase: 'model', pct, noteCode: 'stt_downloading_model' }));
  onProgress({ phase: 'model', pct: 100, noteCode: 'stt_model_ready' });
}

// 一键补齐: 缺引擎装引擎, 缺模型下模型, 装完重新探测
async function setup(onProgress = () => {}) {
  try {
    if (useSv()) {
      if (!sv.findModel(_roots)) await sv.installModel(_roots, downloadFrom, HF_BASES, onProgress);
      const d = detect();
      // 换到 SenseVoice 之后, 以前我们替用户下的 whisper 模型(148MB)再也用不上, 新模型就位就删。
      // 只删 writable 下我们自己下的那份; 出厂自带的和用户手工放在家目录的不碰。
      if (d.ok) { try { fs.unlinkSync(vendorModel()); console.log('[stt] 已删旧 whisper 模型', vendorModel()); } catch (_) {} }
      return d.ok ? { ok: true, engine: d.engine, model: d.model } : { ok: false, error: d.error };
    }
    const cli = findCli();
    if (!cli || !isWhisperCpp(cli)) await installEngine(onProgress);
    if (!findModel()) await installModel(onProgress);
    const d = detect();
    if (!d.ok) return { ok: false, error: d.error, hint: d.hint };
    return { ok: true, cli: d.cli, model: d.model };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// wavBytes: Uint8Array | Buffer (16kHz mono s16le WAV); lang: 'auto'|'ja'|'en'|'zh'... 默认 auto
async function transcribe(wavBytes, lang = 'auto') {
  const d = detect();
  if (!d.ok) return { ok: false, error: d.error, hintCode: d.hintCode, canAutoInstall: d.canAutoInstall };
  // 排查用: 设了 BUTLER_STT_DUMP 就把每段录音连同语种存一份, 拿真人原声对比各引擎。平时不设, 什么都不落盘。
  if (process.env.BUTLER_STT_DUMP) {
    try { fs.mkdirSync(process.env.BUTLER_STT_DUMP, { recursive: true }); fs.writeFileSync(path.join(process.env.BUTLER_STT_DUMP, `${Date.now()}-${lang || 'auto'}.wav`), Buffer.from(wavBytes)); } catch (_) {}
  }
  if (d.engine === 'sensevoice') {
    try { return { ok: true, text: sv.transcribe(wavBytes, lang, d.model) }; }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
  // 临时 wav 用完即删(见 finally) —— 店里的对话音频不留在盘上, 这是客人的声音。
  const tmp = path.join(os.tmpdir(), `ib-stt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  try {
    fs.writeFileSync(tmp, Buffer.from(wavBytes));
    const args = ['-m', d.model, '-f', tmp, '-l', lang || 'auto', '-nt'];
    const text = await new Promise((resolve, reject) => {
      const p = spawn(d.cli, args);
      let out = '', err = '';
      p.stdout.on('data', (b) => { out += b.toString('utf8'); });
      p.stderr.on('data', (b) => { err += b.toString('utf8'); });
      p.on('error', reject);
      p.on('close', (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(`${d.cli} exit ${code}: ${err.slice(-400)}`));
      });
    });
    // whisper-cli -nt 输出前有个空行, 且行末可能带换行; 收尾 trim
    return { ok: true, text: text.trim() };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

// 写永久音频到人格目录 (record fence 提交流程用) → 返回绝对路径 + 秒数
async function saveAudio(homeDir, wavBytes) {
  const dir = path.join(homeDir, 'audio_uploads');
  fs.mkdirSync(dir, { recursive: true });
  const ts = nowLocalISO().replace(/[:.+]/g, '-');
  const file = path.join(dir, `${ts}.wav`);
  fs.writeFileSync(file, Buffer.from(wavBytes));
  // 从 WAV 头拿秒数: bytes 44+ = PCM 数据; 44 header, sr=16000, mono, 16-bit → sec = (size-44)/2/16000
  const bytes = wavBytes.byteLength || wavBytes.length || 0;
  const sec = Math.max(0, Math.round((bytes - 44) / 2 / 16000 * 10) / 10);
  return { ok: true, path: file, sec };
}

// 语义模型(core/embed/model.js)也吃这对根 —— 两样随包资产同一个 bundled 目录, 宿主只注入一次。
module.exports = { detect, setup, transcribe, saveAudio, download, downloadFrom, HF_BASES, setVendorRoots, vendorRoots: () => _roots, isWhisperCpp };
