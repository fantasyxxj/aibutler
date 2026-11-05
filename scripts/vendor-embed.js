// scripts/vendor-embed.js — 把语义检索所需的两个前端产物从 node_modules 取到 renderer/vendor/。
//
// 为什么要拷而不是直接依赖 node_modules:
//   @huggingface/transformers 在 Node 侧硬依赖 onnxruntime-node —— 那是 211MB 的**原生**二进制,
//   而我没有 Windows 机器可验(打包漏没漏只能靠"我记得配过", 那不是验证)。所以它只当 devDependency,
//   一个字节都不进安装包; 真正进包的是渲染进程用的 web 构建 + wasm 运行时, 纯字节码, 零平台差异。
//
// 产物是可再生的, 所以 renderer/vendor/ 不进 git —— 打包脚本会先跑这一步。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'core', 'embed', 'vendor');

// jsep 那份 25MB 是给 WebGPU 用的; 我们跑 CPU wasm, 拿 12MB 这份就够。
// 选错的后果不是报错而是包大一倍, 属于不看不会发现的那类浪费。
//
// 后两项是推理库 import 的【裸模块说明符】(onnxruntime-common / onnxruntime-web/webgpu)。
// 谁都不认裸说明符 —— 浏览器要 importmap, Node 要 node_modules。所以拷完原地把这两个说明符
// 改写成相对路径(patchBareSpecifiers), 两边都不必垫片。少拷一个的表现是
// "一加载就报 Failed to resolve module specifier", 门禁 [6] 守着。
const FILES = [
  ['@huggingface/transformers/dist/transformers.web.min.js', 'transformers.web.min.js'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.wasm'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.mjs'],
  ['onnxruntime-web/dist/ort.wasm.bundle.min.mjs', 'ort.wasm.bundle.min.mjs'],
];
// 整目录拷: onnxruntime-common 的 ESM 是几十个互相相对引用的小文件, 单拷 index.js 没用。
const DIRS = [['onnxruntime-common/dist/esm', 'ort-common']];

// 裸说明符 → 相对路径。**硬失败**: 升级 transformers 后这两个串一旦对不上, 现在就红,
// 而不是等到运行时报一句跟真实原因毫无关系的 "Failed to resolve module specifier"。
const BARE = [
  ['from"onnxruntime-common"', 'from"./ort-common/index.js"'],
  ['from"onnxruntime-web/webgpu"', 'from"./ort.wasm.bundle.min.mjs"'],
];
function patchBareSpecifiers(file) {
  let s = fs.readFileSync(file, 'utf8');
  for (const [bare, rel] of BARE) {
    if (!s.includes(bare)) throw new Error(`${path.basename(file)} 里找不到 ${bare} —— transformers 换版本了, 先核对新的 import 形状再改这里`);
    s = s.split(bare).join(rel);
  }
  fs.writeFileSync(file, s);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const f = path.join(from, ent.name), t = path.join(to, ent.name);
    if (ent.isDirectory()) { n += copyDir(f, t); continue; }
    // .d.ts / .map 是给编辑器和调试器的, 运行时用不到 —— 不拷, 省下一半文件数。
    if (/\.(d\.ts|map)$/.test(ent.name)) continue;
    fs.copyFileSync(f, t); n++;
  }
  return n;
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const done = [];
  for (const [src, dst] of FILES) {
    const from = path.join(ROOT, 'node_modules', src);
    if (!fs.existsSync(from)) {
      // 硬失败: 静默跳过会打出一个"装上了但语义检索永远初始化失败"的包。
      throw new Error(`缺少 ${src} —— 先 npm i -D @huggingface/transformers`);
    }
    const to = path.join(OUT, dst);
    fs.copyFileSync(from, to);
    if (dst === 'transformers.web.min.js') patchBareSpecifiers(to);
    done.push(`${dst} (${(fs.statSync(to).size / 1048576).toFixed(1)}MB)`);
  }
  for (const [src, dst] of DIRS) {
    const from = path.join(ROOT, 'node_modules', src);
    if (!fs.existsSync(from)) throw new Error(`缺少目录 ${src}`);
    const n = copyDir(from, path.join(OUT, dst));
    done.push(`${dst}/ (${n} 文件)`);
  }
  // utilityProcess 里 import 这个目录下的 .js 必须被当成 ESM —— 没有这份 package.json,
  // Node 按 CJS 解析 transformers.web.min.js, 报 "To load an ES module, set type: module"。
  fs.writeFileSync(path.join(OUT, 'package.json'), '{ "type": "module" }\n');
  done.push('package.json (type:module)');
  console.log('vendor-embed:', done.join(', '));
}

if (require.main === module) main();
module.exports = { main, FILES, OUT };
