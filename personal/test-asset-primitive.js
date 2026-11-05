// test-asset-primitive.js — 插件读本地资源(asset 原语 + core/asset-bridge.js)。跑法: node test-asset-primitive.js
//
// 守的是「插件能读图片音视频, 但只读得到两处」这句话:
//   ①包自己的素材目录按相对名读; .. / 绝对路径 / 软链出界 / 扩展名不认 一律读不到
//   ②用户在打开框里挑过的文件按包授权, A 包的 ref B 包用不了; forget 后地址也失效
//   ③交回的是令牌地址, 协议按令牌回文件并支持 Range ④op 从声明读, pick 只给人按
'use strict';

require('./host-wiring');
const fs = require('fs');
const os = require('os');
const path = require('path');
const commands = require('../core/commands.js');
const bridge = require('../core/asset-bridge.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-'));
  const root = path.join(tmp, 'plugin-assets');
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(path.join(root, 'pa', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(root, 'pb'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'pa', 'a.mp3'), Buffer.from('0123456789'));
  fs.writeFileSync(path.join(root, 'pa', 'sub', 'b.png'), Buffer.from('png'));
  fs.writeFileSync(path.join(root, 'pa', 'notes.txt'), 'x');
  fs.writeFileSync(path.join(root, 'pb', 'secret.mp4'), Buffer.from('mp4'));
  fs.writeFileSync(path.join(outside, 'x.mp3'), Buffer.from('out'));
  fs.symlinkSync(path.join(outside, 'x.mp3'), path.join(root, 'pa', 'link.mp3'));
  fs.writeFileSync(path.join(outside, 'movie.mov'), Buffer.from('movie-bytes'));
  fs.writeFileSync(path.join(outside, 'doc.pdf'), Buffer.from('pdf'));

  let pickReturns = [];
  let pickFilters = null;
  const assets = bridge.create({
    root: () => root,
    grantsFile: () => path.join(tmp, 'grants.json'),
    pickFiles: async (f) => { pickFilters = f; return pickReturns; },
  });
  const body = async (r) => Buffer.from(await r.arrayBuffer()).toString();

  console.log('\n[1] 素材目录: 列得出、按相对名读得到');
  const l = await assets.handle('pa', 'list', {});
  const names = l.data.assets.map((a) => a.name);
  ok(names.includes('a.mp3') && names.includes('sub/b.png'), `列出本包素材含子目录: ${names.join(', ')}`);
  ok(!names.includes('notes.txt'), '不认的扩展名不列');
  ok(l.data.assets.find((a) => a.name === 'a.mp3').kind === 'audio', '带类型 audio');
  const u = await assets.handle('pa', 'url', { name: 'a.mp3' });
  ok(u.ok && u.data.url.startsWith('butler-asset://a/') && u.data.kind === 'audio' && u.data.mime === 'audio/mpeg', `url 交回令牌地址 ${u.ok && u.data.url.slice(0, 40)}…`);
  ok(!u.data.url.includes(root), '地址里没有真实路径');
  ok((await body(assets.respond(u.data.url))) === '0123456789', '协议按令牌回文件内容');

  console.log('\n[2] 越界一律读不到');
  for (const name of ['../pb/secret.mp4', '/etc/hosts', path.join(outside, 'x.mp3'), 'sub/../../pb/secret.mp4', 'link.mp3', 'notes.txt', 'nope.mp3', '']) {
    const r = await assets.handle('pa', 'url', { name });
    ok(!r.ok, `拒 ${JSON.stringify(name)} → ${r.code}`);
  }
  const rb = await assets.handle('pa', 'url', { name: 'secret.mp4' });
  ok(!rb.ok, 'A 包按名字读不到 B 包的素材');
  ok(assets.respond('butler-asset://a/deadbeef/a.mp3').status === 404, '伪造令牌 404');

  console.log('\n[3] Range: 拖进度条只读那一段');
  const r1 = assets.respond(u.data.url, 'bytes=2-5');
  ok(r1.status === 206 && r1.headers.get('content-range') === 'bytes 2-5/10' && (await body(r1)) === '2345', '206 + 2-5 段');
  const r2 = assets.respond(u.data.url, 'bytes=7-');
  ok(r2.status === 206 && (await body(r2)) === '789', '开放尾段 7-');
  const r3 = assets.respond(u.data.url, 'bytes=-3');
  ok(r3.status === 206 && (await body(r3)) === '789', '后缀段 -3');
  ok(assets.respond(u.data.url, 'bytes=50-').status === 416, '超出范围 416');

  console.log('\n[4] pick: 用户挑的才授权, 按包隔离');
  pickReturns = [path.join(outside, 'movie.mov'), path.join(outside, 'doc.pdf')];
  const p = await assets.handle('pa', 'pick', {}, { kinds: ['video'] });
  ok(pickFilters && pickFilters[0].extensions.includes('mov') && !pickFilters[0].extensions.includes('mp3'), '声明 kinds:[video] 时选择框只列视频');
  ok(p.ok && p.data.picked.length === 1 && p.data.picked[0].kind === 'video', '不认的 pdf 不授权, mov 授权');
  const ref = p.data.picked[0].ref;
  ok(/^[0-9a-z]{10}$/.test(ref) && !JSON.stringify(p.data).includes(outside), `只交回 ref(${ref}), 不交路径`);
  const pu = await assets.handle('pa', 'url', { ref });
  ok(pu.ok && (await body(assets.respond(pu.data.url))) === 'movie-bytes', '凭 ref 读得到');
  ok(!(await assets.handle('pb', 'url', { ref })).ok, 'B 包拿 A 包的 ref 读不到');
  const again = await assets.handle('pa', 'pick', {}, {});
  ok(again.data.picked[0].ref === ref, '同一个文件再挑, ref 不变');
  const lp = await assets.handle('pa', 'list', {});
  ok(lp.data.picked.length === 1 && lp.data.picked[0].name === 'movie.mov', 'list 带出已授权文件');
  pickReturns = [];
  const none = await assets.handle('pa', 'pick', {}, {});
  ok(none.ok && none.data.picked.length === 0, '取消选择 = 空列表');

  console.log('\n[5] forget: 收回授权, 发过的地址也失效');
  const f = await assets.handle('pa', 'forget', { ref });
  ok(f.ok, 'forget 成功');
  ok(!(await assets.handle('pa', 'url', { ref })).ok, '收回后凭 ref 读不到');
  ok(assets.respond(pu.data.url).status === 404, '收回前发的地址也 404');

  console.log('\n[6] 经 commands: op 从声明读, pick 只给人按');
  const reg = commands.registerPackageCommands('pa', {
    pick: { primitive: 'asset', op: 'pick', kinds: ['audio'], ai: true },
    get: { primitive: 'asset', op: 'url', params: { name: {} }, ai: true },
    bad: { primitive: 'asset', op: 'delete' },
  });
  ok(reg.ok && reg.added.includes('pa.pick'), '登记 asset 命令');
  const decls = commands._PKG_COMMANDS;
  ok(decls.get('pa.pick').ai === false, 'pick 写了 ai:true 也只给人按');
  ok(decls.get('pa.get').ai === true, 'url 可以开放给人格');
  ok(JSON.stringify(decls.get('pa.pick').kinds) === '["audio"]', '声明字段 kinds 登记进来');
  const ctx = { asset: (pkg, op, args, decl) => assets.handle(pkg, op, args, decl) };
  const cr = await commands.run('pa.get', { name: 'a.mp3' }, ctx);
  ok(cr.ok && cr.data.kind === 'audio' && cr.message === '', `run 走通, message 为空(不进对话) ${cr.code || ''}`);
  const cb = await commands.run('pa.bad', {}, ctx);
  ok(!cb.ok && cb.code === 'bad_decl', `声明里不认的 op 被拒: ${cb.code}`);
  const cn = await commands.run('pa.get', { name: 'a.mp3' }, {});
  ok(!cn.ok && cn.code === 'no_asset', '宿主没接 asset 时说清楚');
  ok(commands.notifyAi('pa.get') === false, 'asset 默认不叫醒 AI');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${fail ? '❌' : '✅'} test-asset-primitive: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
