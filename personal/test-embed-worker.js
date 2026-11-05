// test-embed-worker.js — 语义推理换到 utilityProcess 之后的门禁。
//
// 为什么要单独一个文件真跑一次推理: 这条链上有三处**环境适配**, 每一处坏掉的表现都是
// 一句跟真实原因毫无关系的报错(见 embed-worker.js 顶部)。静态断言只能守住"代码还在",
// 守不住"它还管用" —— 而最可能弄坏它的动作(升级 transformers)恰恰不会碰这三行代码。
//
// 跑法: node personal/test-embed-worker.js            静态断言, 秒回
//       node personal/test-embed-worker.js --live     额外起一次 Electron 真算一条向量(约 5 秒)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EMBED = path.join(ROOT, 'core', 'embed');
let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + (e && e.message)); }
}

console.log('\n[embed-worker] 容器与环境适配');

ok('推理跑在 utilityProcess, 不是隐藏窗口(换回 BrowserWindow 等于把 1.2G 拿回来)', () => {
  const h = fs.readFileSync(path.join(EMBED, 'host.js'), 'utf8');
  assert.ok(h.includes('utilityProcess.fork'), 'host.js 该 fork utilityProcess');
  assert.ok(!/new BrowserWindow/.test(h), 'host.js 不该再建 BrowserWindow');
});

ok('回收时连 _pending 一起了结', () => {
  const h = fs.readFileSync(path.join(EMBED, 'host.js'), 'utf8');
  const d = h.slice(h.indexOf('function dispose'));
  assert.ok(/_pending/.test(d.slice(0, 400)),
    '只杀进程不清 pending, 在飞那次会挂到 120 秒超时, 调用方看到的是「超时」而不是「被回收了」');
  assert.ok(/_ready = null/.test(d.slice(0, 400)),
    '不清 _ready 就再也拉不起新进程, 语义检索坏到重启为止');
});

ok('三处环境适配都在', () => {
  const w = fs.readFileSync(path.join(EMBED, 'embed-worker.js'), 'utf8');
  assert.ok(w.includes("Object.defineProperty(process, 'release'"),
    '① 少了它库会判成 Node, 走它没打包进 web 构建的读盘分支, 报 Unable to get model file path or buffer');
  assert.ok(w.indexOf("defineProperty(process, 'release'") < w.indexOf('await import('),
    '① 必须在 import 之前 —— 环境是导入那一刻定死的');
  assert.ok(/env\.fetch\s*=/.test(w), '② web 构建没有读盘代码, 必须接管 env.fetch');
  assert.ok(/backends\.onnx\.wasm\s*=\s*\{\}/.test(w),
    '③ Node 下 backends.onnx 是懒初始化的空对象, 直接写 .wasm.xxx 会 TypeError');
});

// mac 上两种写法都能跑, 所以这里只能靠静态断言守 —— 改回裸路径在本机一切正常,
// 只有 Windows 用户拿到的包会静默退回纯字面检索。
ok('给 onnx 的路径是 file:// URL, 不是裸路径(Windows 盘符会被当协议)', () => {
  const w = fs.readFileSync(path.join(EMBED, 'embed-worker.js'), 'utf8');
  assert.ok(/wasmPaths\s*=\s*pathToFileURL\(/.test(w),
    'wasmPaths 会被拼上文件名交给 ESM import, 裸的 E:\\ 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME');
  assert.ok(/fileURLToPath\(u\)/.test(w) && !/new URL\(u\)\.pathname/.test(w),
    'file:// 转回本地路径必须用 fileURLToPath —— .pathname 在 Windows 上留下前导斜杠 /E:/x 读不开');
});

ok('vendor 的裸模块说明符已改成相对路径, 且标了 type:module', () => {
  const p = path.join(EMBED, 'vendor', 'transformers.web.min.js');
  const s = fs.readFileSync(p, 'utf8');
  assert.ok(!s.includes('from"onnxruntime-common"') && !s.includes('from"onnxruntime-web/webgpu"'),
    '裸说明符还在 — 重跑 node scripts/vendor-embed.js, 它会改写');
  assert.ok(fs.existsSync(path.join(EMBED, 'vendor', 'package.json')),
    '缺 vendor/package.json(type:module) — Node 把 .js 当 CJS 解析, 报 "To load an ES module"');
});

ok('vendor-embed.js 会把改写和 package.json 一起再生(否则下次 vendor 就冲掉)', () => {
  const v = fs.readFileSync(path.join(ROOT, 'scripts', 'vendor-embed.js'), 'utf8');
  assert.ok(v.includes('patchBareSpecifiers'), '拷完必须改写裸说明符');
  assert.ok(/package\.json[\s\S]{0,120}type"?:\s*"?module/.test(v), '必须写出 vendor/package.json');
});

// —— 真跑一次: 只有它能证明这条链现在还通 ——
if (process.argv.includes('--live')) {
  console.log('\n[embed-worker] 真推理(起一次 Electron)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedgate-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"g","main":"m.js"}');
  fs.writeFileSync(path.join(dir, 'm.js'), `
const { app } = require('electron');
try { app.dock && app.dock.hide(); } catch (_) {}
require(${JSON.stringify(path.join(__dirname, 'host-wiring.js'))});   // 注入 paths, 否则 model.detect() 找不到 models/
const host = require(${JSON.stringify(path.join(EMBED, 'host.js'))});
const model = require(${JSON.stringify(path.join(EMBED, 'model.js'))});
app.whenReady().then(async () => {
  try {
    if (!model.detect().ok) { console.log('GATE_SKIP 模型没装'); return app.exit(0); }
    const v = await host.embed(['passage: 门禁探针']);
    const before = host.stats();
    host.dispose('gate');
    console.log('GATE_RESULT ' + JSON.stringify({
      dim: v[0].length, finite: v[0].every(Number.isFinite),
      norm: +Math.sqrt(v[0].reduce((s, x) => s + x * x, 0)).toFixed(4),
      running_before: before.running, running_after: host.stats().running,
    }));
  } catch (e) { console.log('GATE_ERROR ' + String(e && e.message)); }
  app.exit(0);
});`);
  const bin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  // 模型是运行时下载的, 只住在数据目录里。不指过去就永远"没装", 门禁会变成一条永远跳过的假绿。
  const dataDir = process.env.BUTLER_DATA_DIR
    || path.join(os.homedir(), 'Library', 'Application Support', 'butler');
  const r = spawnSync(bin, [dir], { encoding: 'utf8', timeout: 180000,
    env: { ...process.env, BUTLER_DATA_DIR: dataDir } });
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('GATE_')) || '';
  ok('真算得出向量, 384 维 · 全有限 · 已 L2 归一化 · dispose 后进程真的没了', () => {
    assert.ok(!line.startsWith('GATE_ERROR'), line || '没拿到结果: ' + String(r.stderr || '').slice(-300));
    if (line.startsWith('GATE_SKIP')) { console.log('    (模型没装, 这条跳过)'); return; }
    const d = JSON.parse(line.slice('GATE_RESULT '.length));
    assert.strictEqual(d.dim, 384, '维度变了 = 模型换了, 存量向量全部作废');
    assert.ok(d.finite, '出了 NaN/Inf — 环境适配坏了但没抛错, 这是最坏的一种');
    assert.ok(Math.abs(d.norm - 1) < 0.01, 'normalize 没生效, 余弦会整体偏掉');
    assert.strictEqual(d.running_before, true, '算完子进程该还活着');
    assert.strictEqual(d.running_after, false, 'dispose 之后该没了');
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
