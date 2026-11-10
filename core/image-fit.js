// image-fit.js — 发给模型的图先缩到它看得了的尺寸, 被服务商拒了再往下缩一级。
// 模型本来就会把大图缩到自己的原生上限再看(Claude 4.7+ 长边 2576px, 更早的 1568px, OpenAI 2048px),
// 先缩到那个数, 模型看到的跟服务端替它缩的是同一张; 没超的原样发。只缩尺寸: PNG 照旧 PNG(截图上的字
// 经不起 JPEG), 缩完还超过字节上限才转 JPEG 85。用 Electron 自带的 nativeImage, 不加依赖; 不在 Electron
// 里(单测)或格式读不了就原样返回 null, 调用方照发原图。
// 被拒后缩到哪一级能过, 按「凭据 + 模型」记在 <数据目录>/app/cache/image-limits.json, 下次直接用。
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 5 * 1024 * 1024;   // base64 后的长度; Claude 官方 10MB, 经 Bedrock / 网关常是 5MB, 取小的
const MIN_EDGE = 384;                 // 再小就认不出东西了, 到这儿还不行就换成文字说明

let _native;
function native() {
  if (_native !== undefined) return _native;
  try { const e = require('electron'); _native = (e && typeof e === 'object' && e.nativeImage) || null; } catch (_) { _native = null; }
  return _native;
}

// 官方写明的原生长边上限; 认不出的厂家按 2048
function edgeForModel(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (/claude-(opus|sonnet|haiku|fable|mythos)-(4-[789]|[5-9])/.test(id)) return 2576;
  if (/claude/.test(id)) return 1568;
  return 2048;
}

// b64 → { data, mediaType, width, height, changed } | null(读不了)
function fit(b64, mediaType, maxEdge, maxBytes = MAX_BYTES) {
  const ni = native();
  if (!ni || !b64) return null;
  let img;
  try { img = ni.createFromBuffer(Buffer.from(b64, 'base64')); } catch (_) { return null; }
  if (!img || img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const long = Math.max(width, height);
  if (long <= maxEdge && b64.length <= maxBytes) return { data: b64, mediaType, width, height, changed: false };
  const k = long > maxEdge ? maxEdge / long : 1;
  const w = Math.max(1, Math.round(width * k)), h = Math.max(1, Math.round(height * k));
  const small = k < 1 ? img.resize({ width: w, height: h, quality: 'best' }) : img;
  const keepPng = !/jpe?g/i.test(mediaType || '');
  let buf = keepPng ? small.toPNG() : small.toJPEG(85);
  let mt = keepPng ? 'image/png' : 'image/jpeg';
  if (buf.toString('base64').length > maxBytes && keepPng) { buf = small.toJPEG(85); mt = 'image/jpeg'; }
  return { data: buf.toString('base64'), mediaType: mt, width: w, height: h, changed: true };
}

function limitsFile() {
  try { return path.join(require('./host').paths.dataDir(), 'app', 'cache', 'image-limits.json'); } catch (_) { return null; }
}
function readLimits() {
  const f = limitsFile();
  try { return f ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; } catch (_) { return {}; }
}

// 给 Butler 引擎的钩子(options.imageFit): key = 凭据 + 模型; 只记发成功的那一级
function hookFor(key, modelId) {
  return {
    edge: () => { const v = readLimits()[key]; return Number(v) > 0 ? Number(v) : edgeForModel(modelId); },
    fit: (b64, mediaType, maxEdge) => fit(b64, mediaType, maxEdge),
    learn: (edge) => {
      const f = limitsFile();
      if (!f || !(edge > 0)) return;
      const all = readLimits();
      if (all[key] === edge) return;
      all[key] = edge;
      try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(all)); } catch (_) {}
      console.log(`[image-fit] ${key} 记下能过的长边 ${edge}px`);
    },
    minEdge: MIN_EDGE,
  };
}

module.exports = { fit, edgeForModel, hookFor, MAX_BYTES, MIN_EDGE };
