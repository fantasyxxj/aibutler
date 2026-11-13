// voice-sensevoice.js — SenseVoice 本地 STT 引擎(sherpa-onnx-node), voice-stt.js 优先走这条
// 暴露: available() 运行库能否加载 / findModel(roots) / installModel(roots, downloadFrom, onProgress) / transcribe(wavBytes, lang, modelDir)
//
// 为什么换: whisper ggml-base 认中文大量出同音错字(收藏夹→收藏家、三菜一汤→一趟), -l auto 还常吐繁体;
// 2026-11-13 同一批合成语音实测 SenseVoice int8 全对, 每句约 70ms, 中英日韩粤一个模型。教育版早已在用。
// 运行库是进程内 .node 模块, 不需要 whisper-cli 那样的外部可执行文件, 也就没有 brew / 漏打包那一类坑。
// 加载不了(行业版没装这个依赖、或平台缺预编译)时 available() 为 false, voice-stt 照旧走 whisper。
const fs = require('fs');
const path = require('path');
const os = require('os');

const MODEL_NAME = 'sensevoice-int8-2024-07-17';
// HF 上 int8 单独那个仓要登录(401), 完整仓里自带同一份 model.int8.onnx(sha256 c71f0ce0…), 取它的两个文件就够。
const HF_REPO = '/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/';
const FILES = ['model.int8.onnx', 'tokens.txt'];
// SenseVoice 认的语种; 其余一律交给它自己判(auto)。
const LANGS = new Set(['zh', 'en', 'ja', 'ko', 'yue']);
// SenseVoice 认日文时按词吐空格(「憂鬱 な 気分の 日 は」); 两边都是中日文字或全角标点的空格去掉, 英文词间的留着。
const CJK = '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー、。，！？「」]';
const CJK_GAP = new RegExp(`(?<=${CJK})\\s+(?=${CJK}|\\d)|(?<=\\d)\\s+(?=${CJK})`, 'gu');   // 「午後 3時」的数字两侧也算

let _sherpa;   // undefined = 没试过 · null = 加载失败
function sherpa() {
  if (_sherpa === undefined) {
    try { _sherpa = require('sherpa-onnx-node'); }
    catch (e) { _sherpa = null; console.log(`[stt] SenseVoice 运行库不可用, 走 whisper: ${(e && e.message || e).toString().split('\n')[0]}`); }
  }
  return _sherpa;
}
const available = () => !!sherpa();

const writableModelDir = (roots) => path.join(roots.writable || path.join(os.homedir(), '.butler'), 'whisper', 'models', MODEL_NAME);
const bundledModelDir = (roots) => (roots.bundled ? path.join(roots.bundled, 'whisper', 'models', MODEL_NAME) : null);
const complete = (dir) => !!dir && FILES.every((f) => { try { return fs.statSync(path.join(dir, f)).size > 0; } catch (_) { return false; } });

function findModel(roots) {
  return [bundledModelDir(roots), writableModelDir(roots)].find(complete) || null;
}

async function installModel(roots, downloadFrom, bases, onProgress) {
  const dir = writableModelDir(roots);
  // 两个文件按体积占比报进度: tokens.txt 只有 300KB, 不值得单独占一半进度条。
  const weight = { 'model.int8.onnx': 99, 'tokens.txt': 1 };
  let done = 0;
  onProgress({ phase: 'model', pct: 0, noteCode: 'stt_downloading_model' });
  for (const f of ['tokens.txt', 'model.int8.onnx']) {
    await downloadFrom(bases, HF_REPO + f, path.join(dir, f),
      (pct) => onProgress({ phase: 'model', pct: Math.floor(done + pct * weight[f] / 100), noteCode: 'stt_downloading_model' }));
    done += weight[f];
  }
  onProgress({ phase: 'model', pct: 100, noteCode: 'stt_model_ready' });
}

// 识别器加载约 1 秒、占几百 MB, 按 模型目录+语种 缓存一份, 不每句重建。
const _recs = new Map();
function recognizer(modelDir, lang) {
  const key = `${modelDir}|${lang}`;
  if (!_recs.has(key)) {
    _recs.set(key, new (sherpa().OfflineRecognizer)({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        senseVoice: { model: path.join(modelDir, 'model.int8.onnx'), language: lang, useInverseTextNormalization: 1 },
        tokens: path.join(modelDir, 'tokens.txt'),
        numThreads: 2,
        provider: 'cpu',
      },
    }));
  }
  return _recs.get(key);
}

// recorder.js 交来的是 16kHz 单声道 16-bit WAV; 找 data 块转 Float32, 采样率照头里写的报给识别器。
function parseWav(bytes) {
  const b = Buffer.from(bytes);
  const sampleRate = b.readUInt32LE(24);
  let off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'data') {
      const end = Math.min(b.length, off + 8 + size);
      const n = Math.floor((end - off - 8) / 2);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
      return { sampleRate, samples };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('wav: no data chunk');
}

function transcribe(wavBytes, lang, modelDir) {
  const l = LANGS.has(lang) ? lang : 'auto';
  const rec = recognizer(modelDir, l);
  const stream = rec.createStream();
  stream.acceptWaveform(parseWav(wavBytes));
  rec.decode(stream);
  return String(rec.getResult(stream).text || '').replace(CJK_GAP, '').trim();
}

module.exports = { available, findModel, installModel, transcribe, MODEL_NAME };
