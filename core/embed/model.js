// memory-embed.js — 语义检索模型的落地管理(主进程侧)。
//
// 分工: 主进程只管【把模型文件弄到本地】, 真正的推理在渲染进程(那里才有 wasm 后端 ——
// 同一个库在 Node 侧会强行去要 onnxruntime-node 那 211MB 原生二进制, 而那是我验不了的 Windows 风险)。
//
// 下载复用 voice-stt 的 download(): 它走全局 undici dispatcher, 因此吃得到「网络代理」设置,
// 并且半成品只落 .part。另起一套下载 = 代理设置对它无效 = 国内用户直接卡死。
const fs = require('fs');
const path = require('path');

// 与 memory.js 的 EMBED_MODEL 必须一致 —— 那边拿它当向量的有效性标签, 这边拿它当下载路径。
const MODEL_ID = 'Xenova/multilingual-e5-small';
// 下载源候选在 voice-stt 里(两处共用一份): 官方在前, hf-mirror 兜底。
// 国内 huggingface.co 直连不通, 而这里失败是**静默**的 —— 没模型就没向量, 检索退化成纯
// 词面匹配, 不报错不弹窗, 用户只觉得"AI 什么都想不起来"。所以兜底必须自动, 不能等人来配代理。

// transformers.js 按 {localModelPath}/{model_id}/... 找文件, 所以目录结构必须原样照搬。
// quantized 那份 118MB(fp32 是 470MB): 归一化向量上 int8 量化的检索质量损失极小,
// 而 4 倍体积差在"用户首次要等多久"上是实打实的。
const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'onnx/model_quantized.onnx',
];

// 下载落点。**只有这里能写** —— 随包出厂的那份在 app 的 Resources 下, 只读。
// 跟 whisper 同样的理由: 用户把数据目录挪到别的盘时, 这 118MB 也该跟着走。
function writableRoot() {
  try { return path.join(require('../host').paths.dataDir(), 'models'); }
  catch (_) { return path.join(__dirname, '..', 'models'); }
}

// 随包出厂的那份。行业版走这条: 模型进安装包, 店主开机即用 —— 那一版既没有自动下载,
// 也没有设置里的下载入口, 缺了就是永久退化成纯词面匹配, 而店主只会觉得"它想不起事"。
// 根是 voice-stt 那对 vendor 根里的 bundled(whisper 用的同一个): 行业版 boot.js 已经注入,
// 打包后 = resourcesPath, dev = industry/vendor。个人版只注入 writable, 所以这里是 null,
// 行为原样不变 —— 它有自动下载, 129MB 不该再压进那个 dmg。
function bundledRoot() {
  try {
    const r = require('../voice-stt').vendorRoots();
    return r && r.bundled ? path.join(r.bundled, 'models') : null;
  } catch (_) { return null; }
}

// 某个根底下这五个文件齐不齐。逐个文件查而不是只看目录在不在 —— 中断的下载会留下半套文件,
// 那种状态下 transformers.js 的报错("failed to load model")完全看不出是缺文件。
function missingIn(root) {
  const dir = path.join(root, ...MODEL_ID.split('/'));
  return FILES.filter((f) => {
    try { return !fs.statSync(path.join(dir, f)).size; } catch (_) { return true; }
  });
}

// 读的位置: 数据目录那份优先(用户自己下的那份才可能比随包的新), 缺了才回随包那份。
// 两边都不齐时回可写位 —— detect 要照它报缺、install 要往它下载, 指到只读的 Resources 会下载失败。
function modelsRoot() {
  const w = writableRoot();
  if (!missingIn(w).length) return w;
  const b = bundledRoot();
  if (b && !missingIn(b).length) return b;
  return w;
}
function modelDir() { return path.join(modelsRoot(), ...MODEL_ID.split('/')); }

function detect() {
  const root = modelsRoot();
  const missing = missingIn(root);
  return { ok: missing.length === 0, dir: path.join(root, ...MODEL_ID.split('/')), root, missing, modelId: MODEL_ID };
}

// 下载全部缺失文件。onProgress({file, pct, index, total}) —— 粒度到单个文件,
// 因为 onnx 那个 118MB 占了 99% 的时间, 只报总体百分比会长时间看着像卡死。
async function install(onProgress = () => {}) {
  const { downloadFrom, HF_BASES } = require('../voice-stt');
  const st = detect();
  if (st.ok) return { ok: true, dir: st.dir, already: true };
  // 🔴 落点显式取可写位, 不用 modelDir(): 随包那份只装了一半时 modelDir 会指向 Resources, 写不进去。
  const dir = path.join(writableRoot(), ...MODEL_ID.split('/'));
  // 要下的是【可写位】缺的那些, 不是 st.missing —— 随包那份半齐时两者不是同一张单子。
  const todo = missingIn(writableRoot());
  fs.mkdirSync(path.join(dir, 'onnx'), { recursive: true });
  let i = 0;
  for (const f of todo) {
    i++;
    const tail = `/${MODEL_ID}/resolve/main/${f}`;
    const dest = path.join(dir, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await downloadFrom(HF_BASES, tail, dest, (pct, got, total) => {
      onProgress({ file: f, pct, got, total, index: i, count: todo.length });
    });
  }
  const after = detect();
  if (!after.ok) throw new Error(`模型文件仍缺: ${after.missing.join(', ')}`);
  return { ok: true, dir, downloaded: todo.length };
}

// 首启后台自动装。2026-08-13 定案: 语义检索默认开, 不再要用户点头, 也不按语言占比判 ——
// 四份语料 178 句实测中/日/英/跨语言全都只赚不赔, 而"按文字比例决定装不装"那个判据已被日文推翻
// (日文库几乎全是假名汉字, 按比例该判"不用装", 实际却是受益最大的一档: 命中 46%→62%)。
// 单飞: 每个人格启动都会走到这里, 而模型是全应用共享的一份, 并发下同一个文件会互相踩。
// 失败静默: 没模型时检索原样退化成纯关键词, 增强功能装不上不该惊动用户。
let installing = null;
function ensureInstalled(onProgress) {
  if (installing) return installing;
  if (module.exports.detect().ok) return Promise.resolve({ ok: true, already: true, dir: modelDir() });
  // 走 exports.install 而不是直接 install: 否则门禁没法替掉真下载, 而"单飞"和"失败静默"
  // 这两条承诺只靠 grep 源码是守不住的(一次 118MB 的真下载不能进门禁)。
  installing = module.exports.install(onProgress)
    .catch((e) => ({ ok: false, error: (e && e.message) || String(e) }))
    .then((r) => { installing = null; return r; });
  return installing;
}

// 渲染进程要的一切: 模型放哪、wasm 运行时放哪。
// 两个路径都必须是真实文件系统路径 —— asar 内的路径 wasm 加载器读不到,
// 所以 vendor/ 与 models/ 都不能被打进 asar(见 package.json 的 asarUnpack)。
function rendererConfig() {
  const st = detect();
  return {
    ready: st.ok,
    modelId: MODEL_ID,
    localModelPath: st.root,
    wasmDir: path.join(__dirname, 'renderer', 'vendor') + path.sep,
    missing: st.missing,
  };
}

module.exports = { MODEL_ID, FILES, detect, install, ensureInstalled, modelDir, modelsRoot, writableRoot, bundledRoot, rendererConfig };
