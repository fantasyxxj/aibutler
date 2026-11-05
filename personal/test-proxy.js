// test-proxy.js — 代理接线门禁
// 跑法: node test-proxy.js
// 验的是「配了代理之后, 出网到底走没走它」—— 起一个真代理进程数命中次数, 不看代码看行为。
// 覆盖: 内建 fetch 无视环境变量(问题本身) · apply 后 fetch 真走代理 · NO_PROXY 白名单 ·
//       关掉后回到直连 · 子进程 env 白名单 · 设置读写与默认值

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}`); fail++; }
};
const eq = (a, b, label) => ok(a === b, `${label} (got ${a}, want ${b})`);

// —— 最小代理: 记录每一次经过它的请求 ——
const hits = [];
const proxySrv = http.createServer((req, res) => {
  hits.push(`PLAIN ${req.url}`);
  const u = new URL(req.url);
  const p = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: req.method, headers: req.headers },
    (pr) => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); });
  p.on('error', () => { try { res.writeHead(502); res.end('bad gw'); } catch (_) {} });
  req.pipe(p);
});
proxySrv.on('connect', (req, clientSocket, head) => {
  hits.push(`CONNECT ${req.url}`);
  const [host, port] = req.url.split(':');
  const srv = net.connect(Number(port) || 443, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    srv.write(head); srv.pipe(clientSocket); clientSocket.pipe(srv);
  });
  srv.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => srv.destroy());
});
const originSrv = http.createServer((req, res) => res.end('origin-ok'));

(async () => {
  await new Promise((r) => proxySrv.listen(0, '127.0.0.1', r));
  await new Promise((r) => originSrv.listen(0, '127.0.0.1', r));
  const proxyUrl = `http://127.0.0.1:${proxySrv.address().port}`;
  const originUrl = `http://127.0.0.1:${originSrv.address().port}/ping`;

  console.log('\n[1] 问题本身: Node 内建 fetch 无视代理环境变量');
  process.env.HTTP_PROXY = proxyUrl; process.env.HTTPS_PROXY = proxyUrl;
  hits.length = 0;
  await fetch(originUrl).then((r) => r.text());
  eq(hits.length, 0, '设了 HTTP(S)_PROXY, 内建 fetch 仍然直连 —— 这就是必须换 dispatcher 的原因');
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY']) delete process.env[k];

  const proxy = require('./proxy');

  console.log('\n[2] apply 之后, fetch 真的走代理');
  proxy.apply({ proxy: { enabled: true, url: proxyUrl, no_proxy: '' } });
  hits.length = 0;
  const body = await fetch(originUrl).then((r) => r.text());
  eq(body, 'origin-ok', '内容照常拿得到(代理没把请求弄坏)');
  ok(hits.length >= 1, `请求经过了代理 (命中 ${hits.length} 次: ${hits.join(',') || '无'})`);
  eq(process.env.HTTPS_PROXY, proxyUrl, 'HTTPS_PROXY 已设(claude CLI 子进程靠继承它)');
  eq(process.env.https_proxy, proxyUrl, '小写变体也设了(有些工具只认小写)');

  console.log('\n[3] NO_PROXY 白名单');
  proxy.apply({ proxy: { enabled: true, url: proxyUrl, no_proxy: '127.0.0.1' } });
  hits.length = 0;
  await fetch(originUrl).then((r) => r.text());
  eq(hits.length, 0, '白名单里的地址直连, 不经过代理');

  console.log('\n[4] 关掉代理 → 回到直连, 环境变量清干净');
  proxy.apply({ proxy: { enabled: false, url: proxyUrl } });
  hits.length = 0;
  await fetch(originUrl).then((r) => r.text());
  eq(hits.length, 0, '关掉后不再走代理');
  ok(!process.env.HTTPS_PROXY && !process.env.https_proxy, '环境变量已清除(否则子进程还在偷偷走代理)');
  eq(proxy.current().on, false, 'current() 反映关闭状态');

  console.log('\n[5] enabled 但地址为空 = 没配 → 按直连处理, 不炸');
  const st = proxy.apply({ proxy: { enabled: true, url: '   ' } });
  eq(st.on, false, '空地址不算启用');

  console.log('\n[6] 子进程 env 白名单 (bus MCP 那种不继承 process.env 全量的)');
  proxy.apply({ proxy: { enabled: false, url: '' } });
  eq(Object.keys(proxy.envForChild()).length, 0, '没开代理 → 不往子进程塞任何东西');
  proxy.apply({ proxy: { enabled: true, url: proxyUrl, no_proxy: 'localhost' } });
  const childEnv = proxy.envForChild();
  eq(childEnv.HTTPS_PROXY, proxyUrl, '开了代理 → 子进程拿得到 HTTPS_PROXY');
  eq(childEnv.NO_PROXY, 'localhost', '子进程也拿得到 NO_PROXY');

  console.log('\n[7] 设置读写 (默认值 + 局部 patch 不丢字段)');
  // 开发模式下数据目录恒等于仓库根(paths.dataDir), setDataDir 改不动它 —— 所以别想着重定向到
  // 临时目录, 老实备份真文件、测完还原, 免得在工作区留垃圾。
  const settings = require('./settings');
  const sFile = settings.file();
  const hadBefore = fs.existsSync(sFile);
  const backup = hadBefore ? fs.readFileSync(sFile, 'utf8') : null;
  try {
    if (hadBefore) fs.unlinkSync(sFile);
    const d = settings.read();
    eq(d.proxy.enabled, false, '文件不存在时给默认值: 不启用代理');
    ok(d.proxy.no_proxy.includes('127.0.0.1'), '默认 no_proxy 含本机');
    settings.write({ proxy: { url: 'http://example:1080' } });
    const after = settings.read();
    eq(after.proxy.url, 'http://example:1080', '写入生效');
    eq(after.proxy.enabled, false, '局部 patch 不把没提到的字段抹掉');
    ok(fs.existsSync(sFile), '设置文件落盘');
  } finally {
    if (hadBefore) fs.writeFileSync(sFile, backup, 'utf8');
    else { try { fs.unlinkSync(sFile); } catch (_) {} }
  }
  ok(hadBefore === fs.existsSync(sFile), '测试没在工作区留下痕迹(原来有就还在, 原来没有就删干净)');

  console.log('\n[8] whisper 下载改走 fetch —— 因而也吃代理 (原来是 node:https, 怎么配都不走)');
  const payload = Buffer.alloc(64 * 1024, 7);      // 64KB, 够触发多次 data 事件
  const fileSrv = http.createServer((req, res) => {
    if (req.url === '/missing') { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'Content-Length': String(payload.length) });
    res.end(payload);
  });
  await new Promise((r) => fileSrv.listen(0, '127.0.0.1', r));
  const fileBase = `http://127.0.0.1:${fileSrv.address().port}`;
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-dl-'));
  const dest = path.join(dlDir, 'ggml-base.bin');
  const { download } = require('../core/voice-stt');

  proxy.apply({ proxy: { enabled: true, url: proxyUrl, no_proxy: '' } });
  hits.length = 0;
  const pcts = [];
  await download(`${fileBase}/model`, dest, (pct) => pcts.push(pct));
  eq(fs.readFileSync(dest).length, payload.length, '文件完整下载');
  ok(hits.length >= 1, `下载确实经过代理 (命中 ${hits.length} 次)`);
  ok(pcts.length > 0 && pcts[pcts.length - 1] === 100, `进度回调有推进且收在 100 (${pcts.length} 次)`);
  ok(!fs.existsSync(dest + '.part'), '.part 半成品已清理');

  const before = fs.readdirSync(dlDir).length;
  let threw = null;
  try { await download(`${fileBase}/missing`, path.join(dlDir, 'x.bin'), () => {}); }
  catch (e) { threw = e; }
  ok(threw && /404/.test(threw.message), `HTTP 错误会抛出且带状态码 (${threw && threw.message})`);
  eq(fs.readdirSync(dlDir).length, before, '失败不留半成品文件');

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} pass / ${fail} fail`);
  proxy.apply({ proxy: { enabled: false, url: '' } });
  proxySrv.close(); originSrv.close(); fileSrv.close();
  try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
