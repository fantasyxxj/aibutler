// test-web-primitive.js — 插件联网(web 原语 + 包级 net 名单 + secret 密钥)。跑法: node test-web-primitive.js
//
// 守的是「开了联网, 但开的是名单不是任意代理」这句话:
//   ①去哪儿只从声明读, 主机不在 net 名单里登记就拒 ②跳转出名单当场停
//   ③密钥只能存 / 查有没有 / 清, 读不出原文; A 包取不到 B 包的
'use strict';

require('./host-wiring');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const commands = require('../core/commands.js');
const netFetch = require('../core/net-fetch.js');
const { PkgSecrets } = require('../core/pkg-secrets.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

// 假加密: 测的是「有没有读出口」, 不是加密本身
const cipher = { available: () => true, encrypt: (t) => Buffer.from('X' + t), decrypt: (b) => b.toString().slice(1) };

(async () => {
  let seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, method: req.method });
    if (req.url.startsWith('/out')) { res.writeHead(302, { location: 'http://example.invalid/steal' }); return res.end(); }
    if (req.url.startsWith('/hop')) { res.writeHead(302, { location: '/json?x=1' }); return res.end(); }
    if (req.url.startsWith('/big')) { res.writeHead(200); return res.end(Buffer.alloc(netFetch.MAX_BYTES + 10)); }
    let body = ''; req.on('data', (d) => (body += d));
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ hi: 1, url: req.url, body })); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;

  console.log('\n[1] 名单解析');
  {
    const { list, bad } = netFetch.parseNet(['api.example.com', '*.foo.com', '203.0.113.5', '192.168.1.2:8080', 'bad host', 'http://x.com']);
    ok(list.length === 4 && bad.length === 2, `认 4 项, 拒 2 项(${bad.join(' | ')})`);
    const al = (u) => netFetch.allowed(new URL(u), list);
    ok(al('https://api.example.com/x'), '精确域名放行');
    ok(!al('https://evil.api.example.com/x'), '没写通配, 子域不放');
    ok(al('https://a.b.foo.com/') && !al('https://foo.com/'), '*.foo.com 认子域, 不认 foo.com 本身');
    ok(!al('https://api.example.com:8443/'), '没写端口就只认默认端口');
    ok(al('http://192.168.1.2:8080/') && !al('http://192.168.1.2/'), '写了端口只认那个端口');
    ok(!al('ftp://api.example.com/'), '只认 http / https');
  }

  console.log('\n[2] 登记时查声明');
  commands.pkgCommandsReset();
  const r = commands.registerPackageCommands('weather', {
    get: { primitive: 'web', http: { method: 'GET', url: `${base}/json/{city}` }, ai: true },
    hop: { primitive: 'web', http: { url: `${base}/hop` } },
    out: { primitive: 'web', http: { url: `${base}/out` } },
    big: { primitive: 'web', http: { url: `${base}/big` } },
    post: { primitive: 'web', http: { method: 'POST', url: `${base}/json`, secret: { name: 'key' } } },
    viaq: { primitive: 'web', http: { url: `${base}/json`, secret: { name: 'key', query: 'client_id' } } },
    badq: { primitive: 'web', http: { url: `${base}/json`, secret: { name: 'key', query: 'a b' } } },
    elsewhere: { primitive: 'web', http: { url: 'https://evil.com/x' } },
    hosthole: { primitive: 'web', http: { url: 'http://{host}/x' } },
    badhdr: { primitive: 'web', http: { url: `${base}/json`, headers: { Host: 'evil.com' } } },
    setkey: { primitive: 'secret', op: 'set' },
    haskey: { primitive: 'secret', op: 'status' },
    readkey: { primitive: 'secret', op: 'get' },
  }, { net: [`127.0.0.1:${port}`] });
  const rej = Object.fromEntries(r.rejected.map((x) => [x.name, x.why]));
  ok(r.added.includes('weather.get') && r.added.includes('weather.post'), '名单内的命令收下');
  ok(!!rej.elsewhere, `名单外的主机登记就拒: ${rej.elsewhere}`);
  ok(!!rej.hosthole, `主机部分留空被拒: ${rej.hosthole}`);
  ok(!!rej.badhdr, `改 Host 头被拒: ${rej.badhdr}`);
  ok(!!rej.badq, `secret.query 名字不合法被拒: ${rej.badq}`);
  const r2 = commands.registerPackageCommands('nonet', { get: { primitive: 'web', http: { url: `${base}/json` } } });
  ok(r2.rejected.length === 1, `没声明 net 的包, web 命令全拒: ${r2.rejected[0] && r2.rejected[0].why}`);

  console.log('\n[3] 真发请求');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgsec-'));
  const store = new PkgSecrets(path.join(dir, 's.bin'), cipher);
  const ctx = { pkgSecrets: store };
  let x = await commands.run('weather.get', { city: 'tokyo/../x', query: { lang: 'zh' } }, ctx);
  ok(x.ok && x.data.body.hi === 1, '取回 JSON 并解析');
  ok(seen.at(-1).url === '/json/tokyo%2F..%2Fx?lang=zh', `{} 里的值被转义, 跑不出路径: ${seen.at(-1).url}`);
  x = await commands.run('weather.get', {}, ctx);
  ok(!x.ok && x.code === 'bad_args', '缺 {} 参数报错, 不留空洞');
  x = await commands.run('weather.hop', {}, ctx);
  ok(x.ok && x.data.body.url === '/json?x=1', '名单内跳转照跟');
  x = await commands.run('weather.out', {}, ctx);
  ok(!x.ok && x.code === 'redirect_blocked', `跳出名单当场停: ${x.message}`);
  x = await commands.run('weather.big', {}, ctx);
  ok(!x.ok && x.code === 'too_large', `超过上限不收: ${x.message}`);

  console.log('\n[4] 密钥');
  x = await commands.run('weather.post', { body: { a: 1 } }, ctx);
  ok(!x.ok && x.code === 'no_secret', '没设密钥就不发');
  x = await commands.run('weather.readkey', { name: 'key' }, ctx);
  ok(!x.ok, '🔴 没有读出原文的 op');
  x = await commands.run('weather.setkey', { name: 'key', value: 'sk-123' }, ctx);
  ok(x.ok && JSON.stringify(x).indexOf('sk-123') < 0, '存进去, 回执里不带原文');
  x = await commands.run('weather.haskey', { name: 'key' }, ctx);
  ok(x.ok && x.data.set === true, 'status 只回「设了」');
  x = await commands.run('weather.post', { body: { a: 1 } }, ctx);
  ok(x.ok && seen.at(-1).auth === 'Bearer sk-123' && x.data.body.body === '{"a":1}', '宿主把密钥塞进请求头, body 按 JSON 发');
  ok(JSON.stringify(x).indexOf('sk-123') < 0, '返回给界面的结果里没有密钥');
  const authBefore = seen.length;
  x = await commands.run('weather.viaq', { query: { tags: 'chill' } }, ctx);
  ok(x.ok && seen.at(-1).url === '/json?tags=chill&client_id=sk-123' && !seen.at(-1).auth, `secret.query 把密钥放进地址参数, 不进请求头: ${seen.at(-1).url}`);
  ok(seen.length === authBefore + 1, 'secret.query 只发一次请求');
  ok(store.get('other', 'key') === '', 'A 包的密钥, 按 B 包取不到');
  ok(fs.readFileSync(path.join(dir, 's.bin')).toString().startsWith('X'), '落盘的是 cipher 加过的');
  ok(commands.notifyAi('weather.get') === false, 'web 默认不唤醒 AI');

  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
