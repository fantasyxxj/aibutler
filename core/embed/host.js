// embed-host.js — 语义向量推理的宿主(主进程侧)。真正干活的在 embed-worker.js。
//
// 2026-09-13 换过一次容器: 隐藏 BrowserWindow → utilityProcess。
//   老理由是"推理库只在浏览器环境才走 wasm", 那句话对, 但它推不出"必须开窗口" —— wasm 在 Node
//   里本来就有, 三处环境适配写对就能跑(见 embed-worker.js 顶部那三条)。老方案的代价是为了跑一个
//   wasm 模型付了一整个渲染进程: 实测常驻 1227MB / 峰值 1702MB, 换到 utilityProcess 后约 740MB;
//   且隐藏窗是同一个 Chromium 里的**第二个渲染进程**, 与主界面共用合成器和 GPU 资源池,
//   utilityProcess 不在那条链上。向量数值两条路逐位相同(cosine=1, max_abs_diff=1e-8), 存量不用重算。
//
// ⚠️ 下面 registerScheme / installProtocol / urlFor 这套自定义协议**推理已经不用了**, 但 scripts/
//    下八个实验脚本和行业版 host-wiring 仍在调, 且 personal/test-memory-semantic.js 有断言盯着
//    main.js 里的调用顺序 —— 留着无害, 删了牵连一大片。
const path = require('path');
const fs = require('fs');

const SCHEME = 'butler-embed';
let _child = null;
let _ready = null;
let _seq = 0;
const _pending = new Map();
let _lastUseTs = 0;
const _stat = { forks: 0, calls: 0, texts: 0, ms: 0, lastRssMb: 0 };

// 必须在 app ready 之前调 —— privileged scheme 的注册时机是硬约束, 晚了静默失效,
// 表现为"协议能用但 import 还是被拦", 极难自诊断。
function registerScheme() {
  const { protocol } = require('electron');
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  }]);
}

// 协议只映射两个目录: 随包发的 vendor(推理库 + wasm 运行时) 和数据目录里的 models(下载来的模型)。
// 白名单式映射而不是"挂载一个根" —— 这个协议在渲染进程里可达, 不能让它变成任意读盘的口子。
function installProtocol() {
  const { protocol, net } = require('electron');
  const roots = {
    // app = 随包发的静态资源(推理宿主页面 + vendor 产物); models = 数据目录里下载来的模型。
    app: __dirname,
    models: (() => {
      try { return path.join(require('../host').paths.dataDir(), 'models'); }
      catch (_) { return path.join(__dirname, '..', 'models'); }
    })(),
  };
  protocol.handle(SCHEME, async (req) => {
    const u = new URL(req.url);
    const seg = u.pathname.replace(/^\/+/, '').split('/');
    const root = roots[seg[0]];
    if (!root) return new Response('not found', { status: 404 });
    const rel = seg.slice(1).join('/');
    const target = path.join(root, rel);
    // 目录穿越防护: 解析后必须仍在根之内。'..' 在 URL 里是合法字符, 不挡就等于开了读盘后门。
    const realRoot = path.resolve(root);
    if (!path.resolve(target).startsWith(realRoot)) return new Response('forbidden', { status: 403 });
    try {
      if (!fs.statSync(target).isFile()) return new Response('not found', { status: 404 });
    } catch (_) { return new Response('not found', { status: 404 }); }
    return net.fetch('file://' + target);
  });
}

function urlFor(kind, rel = '') { return `${SCHEME}://app/${kind}/${rel}`; }

// 子进程按需拉起, 拉起后常驻到空闲回收 —— 模型加载一次约 0.9 秒, 每次查询重开等于把语义检索废掉。
async function ensureHost() {
  if (_ready) return _ready;
  _ready = (async () => {
    const { utilityProcess } = require('electron');
    const child = utilityProcess.fork(path.join(__dirname, 'embed-worker.js'), [], {
      stdio: 'inherit', serviceName: 'butler-embed',
    });
    child.on('message', (msg) => {
      const p = msg && _pending.get(msg.id);
      if (!p) return;
      _pending.delete(msg.id);
      if (msg.error) return p.reject(new Error(msg.error));
      const s = msg.stat || {};
      _stat.calls += 1; _stat.texts += s.n || 0; _stat.ms += s.ms || 0; _stat.lastRssMb = s.rssMb || 0;
      // 这一行是「1.7G 峰值是哪一次造成的」当初答不上来的原因 —— 老实现全程零日志。
      console.log(`[embed] ${s.n} 条 · ${s.ms}ms${s.loadMs > 200 ? ` (含模型加载 ${s.loadMs}ms)` : ''} · rss ${s.rssMb}MB`);
      // IPC 传过来的是普通数组, 转回 Float32Array 交给上层 —— 上层(memory-vector)按定长数组算点积。
      p.resolve((msg.vectors || []).map((a) => Float32Array.from(a)));
    });
    // 子进程没了就把在飞的请求就地了结并清空句柄, 下次 embed 自己重拉 —— 不清的话
    // _ready 会一直握着一个死进程, 语义检索坏到重启为止(2026-09-13 手动 kill 那次就是这个)。
    child.on('exit', (code) => {
      const n = _pending.size;
      for (const [, p] of _pending) p.reject(new Error('语义推理进程已退出'));
      _pending.clear();
      _child = null; _ready = null;
      if (code !== 0 || n) console.error(`[embed] 子进程退出 code=${code} · 丢弃在飞请求 ${n} 条`);
    });
    await new Promise((res) => child.once('spawn', res));
    _child = child;
    _stat.forks += 1;
    console.log(`[embed] 推理子进程已拉起(第 ${_stat.forks} 次)`);
    return child;
  })();
  return _ready;
}

// 主入口: 交给 memory.js 当 embedder 用。
// 失败一律抛错而不是返回空 —— 静默返回空会让"模型没装好"表现成"语义检索没结果",
// 那是最难查的一类故障(功能看起来在, 就是不准)。
async function embed(texts) {
  const cfg = require('./model').rendererConfig();
  if (!cfg.ready) throw new Error(`语义模型未就绪, 缺: ${cfg.missing.join(', ')}`);
  await ensureHost();
  const id = ++_seq;
  const p = new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    // 超时兜底: 隐藏窗口崩了的话 renderer 不会有任何回音, 不设超时就是永久挂起。
    setTimeout(() => {
      if (_pending.has(id)) { _pending.delete(id); reject(new Error('语义推理超时')); }
    }, 120000);
  });
  _lastUseTs = Date.now();
  _child.postMessage({
    id, texts,
    modelId: cfg.modelId,
    localModelPath: cfg.localModelPath,   // 真文件系统路径; worker 用自己的 env.fetch 读盘
    vendorDir: path.join(__dirname, 'vendor'),
  });
  return p;
}

// 🔴 必须连 _pending 一起了结: 只杀进程不清 pending, 在飞的那次会一直挂到 120 秒超时,
//    调用方看到的是「语义推理超时」而不是「刚被回收了」, 完全指不到真实原因。
function dispose(reason = 'manual') {
  const n = _pending.size;
  for (const [, p] of _pending) p.reject(new Error('语义推理进程已回收'));
  _pending.clear();
  const had = !!_child;
  try { if (_child) _child.kill(); } catch (_) {}
  _child = null; _ready = null;
  if (had) console.log(`[embed] 回收推理子进程(${reason})${n ? ` · 丢弃在飞请求 ${n} 条` : ''} · 本轮累计 ${_stat.calls} 次/${_stat.texts} 条, 峰值 rss ${_stat.lastRssMb}MB`);
  return { disposed: had };
}

// 空闲回收的入口: 由上层在「没人干活了」时调(个人版挂在 idle-watch 的 PARK 那一档)。
// 不自带定时器 —— 固定周期回收会在连续工作的白天反复付 0.9 秒冷启动, 那是净亏。
function disposeIfIdle({ idleMs = 0 } = {}) {
  if (!_child) return { skipped: 'not-running' };
  if (_pending.size) return { skipped: 'busy' };
  if (idleMs && Date.now() - _lastUseTs < idleMs) return { skipped: 'recent' };
  return dispose('idle');
}

function stats() {
  return { running: !!_child, forks: _stat.forks, calls: _stat.calls, texts: _stat.texts,
           totalMs: _stat.ms, lastRssMb: _stat.lastRssMb, pending: _pending.size, lastUseTs: _lastUseTs };
}

module.exports = { SCHEME, registerScheme, installProtocol, embed, ensureHost, dispose, disposeIfIdle, stats, urlFor };
