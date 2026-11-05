// embed-worker.js — 语义向量推理的干活方, 跑在 Electron utilityProcess 里(纯 Node, 没有 Blink)。
//
// 为什么不是渲染进程了(2026-09-13 换的):
//   老方案给推理单开一个隐藏 BrowserWindow, 理由是"推理库只在浏览器环境才走 wasm"。那句话对,
//   但它推不出"必须开窗口" —— wasm 在 Node 里本来就有。代价是为了跑一个 wasm 模型付了一整个
//   渲染进程: 实测常驻 1227MB(峰值 1702MB), 而同样的活在这里只要约 740MB。更要紧的是
//   隐藏窗是**同一个 Chromium 里的第二个渲染进程**, 跟主界面共用合成器与 GPU 资源池;
//   utilityProcess 不在那条链上, 结构上就没有拖累界面的路径。
//
// 三处必须这么写, 少一处就报一个跟真实原因毫无关系的错:
const path = require('path');
const fsp = require('fs/promises');
const { pathToFileURL, fileURLToPath } = require('url');

// ① 🔴 必须在 import 之前, 而且只能用 defineProperty(直接赋值在 Electron 里静默无效)。
//    推理库靠 process.release.name==='node' 判环境, 判成 Node 之后会走它自己**没有打包进 web 构建**
//    的读盘分支, 报 `Unable to get model file path or buffer` —— 错误信息里没有一个字提到环境判定。
try {
  Object.defineProperty(process, 'release', {
    value: { ...process.release, name: 'electron-utility' },
    configurable: true, writable: true,
  });
} catch (_) {}

let pipe = null;
let cfgKey = '';

async function ensure(cfg) {
  const key = cfg.modelId + '|' + cfg.localModelPath;
  if (pipe && key === cfgKey) return pipe;
  const { env, pipeline } = await import(pathToFileURL(path.join(cfg.vendorDir, 'transformers.web.min.js')).href);

  // ② web 构建里没有读盘那段代码(被裁掉了), 但它把 fetch 留成了可替换钩子。
  //    用它把本地文件喂进去 —— 等价于老方案那个 butler-embed: 自定义协议, 只是不需要浏览器。
  env.fetch = async (input) => {
    const u = String((input && input.url) || input);
    // fileURLToPath 而不是 .pathname —— 后者在 Windows 上会留下前导斜杠("/E:/x")读不开。
    const p = u.startsWith('file://') ? fileURLToPath(u) : u;
    try { return new Response(await fsp.readFile(p), { status: 200 }); }
    catch (err) { return new Response(null, { status: 404, statusText: String(err && err.code) }); }
  };
  env.allowRemoteModels = false;   // 缺文件当场报错, 而不是偷偷去 CDN 拉(断网环境下那会变成一个无关的超时)
  env.allowLocalModels = true;
  env.localModelPath = cfg.localModelPath;
  // ③ backends.onnx 在 Node 下是懒初始化的空对象, 直接写 .wasm.xxx 会 TypeError。
  if (!env.backends.onnx.wasm) env.backends.onnx.wasm = {};
  // 🔴 必须是 file:// URL, 不能是裸路径: 这个值会被拼上文件名交给 ESM 动态 import, 而 Windows
  //    的盘符路径(E:\...)会让 loader 把 "e:" 当协议 —— ERR_UNSUPPORTED_ESM_URL_SCHEME。
  env.backends.onnx.wasm.wasmPaths = pathToFileURL(cfg.vendorDir).href + '/';
  env.backends.onnx.wasm.numThreads = 1;   // 没有 crossOriginIsolated 就没有 SharedArrayBuffer

  // mean pooling + L2 归一化是 e5 系列的既定用法; 换 CLS pooling 不报错, 只会让相似度整体偏掉。
  pipe = await pipeline('feature-extraction', cfg.modelId, { dtype: 'q8' });
  cfgKey = key;
  return pipe;
}

process.parentPort.on('message', async (e) => {
  const { id, texts, modelId, localModelPath, vendorDir } = e.data || {};
  const t0 = Date.now();
  try {
    const p = await ensure({ modelId, localModelPath, vendorDir });
    const loadedMs = Date.now() - t0;
    const out = await p(texts, { pooling: 'mean', normalize: true });
    const [n, dim] = out.dims;
    const flat = out.data;
    const vectors = [];
    for (let i = 0; i < n; i++) vectors.push(Array.from(flat.subarray(i * dim, (i + 1) * dim)));
    process.parentPort.postMessage({
      id, vectors,
      stat: { n, dim, ms: Date.now() - t0, loadMs: loadedMs, rssMb: +(process.memoryUsage().rss / 1048576).toFixed(1) },
    });
  } catch (err) {
    process.parentPort.postMessage({ id, error: String((err && err.message) || err) });
  }
});
