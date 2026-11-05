// test-hub-join.js — core/hub-join.js: 陌生管家自助连 hub 的申请/自取那条路。
// 跑法: node test-hub-join.js
//
// 起一个假 hub 起真 HTTP 服务, 测**真正发出去的东西**: 客户端有没有把 claim_secret 明文
// 漏上去、探活挑地址挑得对不对、拿到 token 之后有没有真把通道落进人格。
//
// 🔴 隔离: registry 开发模式落在 <repo>/app/personas.json —— 那是真人格数据。
//    这里把 paths.registryFile 换成临时目录, 换不成功直接退出不跑。
require('./host-wiring');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const paths = require('./paths');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-hubjoin-'));
const TMP_REG = path.join(TMP, 'personas.json');
paths.registryFile = () => TMP_REG;

const registry = require('../core/registry');
if (registry.regFile() !== TMP_REG) {
  console.error('❌ 隔离失败: registry 仍指向真数据', registry.regFile(), '— 中止, 不跑测试');
  process.exit(1);
}
const hubJoin = require('../core/hub-join');

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn)
  .then(() => { console.log('  ✓', name); pass++; })
  .catch((e) => { console.log('  ✗', name, '—', e.message); fail++; });

// 假 hub: 收下每一次请求, 并按 state 决定 claim 回什么
const got = [];
let approved = false;
let claimed = false;
const AGENT = 'feifei-7f3a';
const TOKEN = 'agb_faketoken';

const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = body ? JSON.parse(body) : null;
    got.push({ method: req.method, url: req.url, body: json });
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url.endsWith('/ping')) return send(200, { ok: true, service: 'agent-bus' });
    if (req.url.endsWith('/apply')) return send(200, { apply_id: 7, status: 'pending', resumed: false });
    if (req.url.endsWith('/claim')) {
      if (claimed) return send(200, { status: 'claimed' });
      if (!approved) return send(200, { status: 'pending' });
      claimed = true;
      return send(200, { status: 'granted', base_url: BASE, agent_name: AGENT, token: TOKEN });
    }
    send(404, { detail: 'not found' });
  });
});

let BASE = '';

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${srv.address().port}`;

  registry.upsert({ id: 'feifei', name: '飞飞', homeDir: TMP });

  console.log('\n== 探活: 挑第一个通的地址 ==');
  await ok('全不通时返回 null(不是抛异常)', async () => {
    assert.strictEqual(await hubJoin.pickEndpoint(['http://127.0.0.1:1']), null);
  });
  await ok('前一个不通就换后一个', async () => {
    assert.strictEqual(await hubJoin.pickEndpoint(['http://127.0.0.1:1', BASE]), BASE);
  });

  console.log('\n== 提示只弹一次 ==');
  await ok('装完从没问过 → 该弹', () => assert.strictEqual(hubJoin.shouldPrompt(), true));
  await ok('用户说不用 → 以后不再弹', () => {
    hubJoin.dismiss();
    assert.strictEqual(hubJoin.shouldPrompt(), false);
  });

  console.log('\n== 申请 ==');
  // dismiss 已经把 asked 落上了, 申请这条路照样能走(设置里点进来就是这个场景)
  hubJoin.ENDPOINTS.length = 0;
  hubJoin.ENDPOINTS.push(BASE);

  let applied;
  await ok('申请成功, 拿到 apply_id', async () => {
    applied = await hubJoin.apply({ displayName: '飞飞', ownerName: ' 作者 ', message: '我是作者的开发助手', personaId: 'feifei' });
    assert.ok(applied.ok, applied.error);
    assert.strictEqual(applied.applyId, 7);
  });
  await ok('没名字不发请求', async () => {
    const r = await hubJoin.apply({ displayName: '  ', ownerName: '作者', personaId: 'feifei' });
    assert.strictEqual(r.ok, false);
  });
  // 后台批的时候靠本人名字认人, 别人按名字找人也靠它 —— 不填就当场拒, 不发请求。
  await ok('🔴 没填本人名字不发请求', async () => {
    const before = got.length;
    const r = await hubJoin.apply({ displayName: '飞飞', ownerName: '  ', personaId: 'feifei' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(got.length, before, '不该发出请求');
  });
  // 身份按人格发: 不带 personaId 就落不进任何人格, 等于白申请 —— 宁可当场拒。
  await ok('不带 personaId 不发请求', async () => {
    const r = await hubJoin.apply({ displayName: '飞飞', ownerName: '作者' });
    assert.strictEqual(r.ok, false);
  });

  console.log('\n== 🔴 claim_secret 绝不能上网 ==');
  await ok('apply 送的是 sha256 不是明文', () => {
    const req = got.find((g) => g.url.endsWith('/apply'));
    const secret = hubJoin.getState('feifei').claim_secret;
    assert.ok(secret && secret.length > 20, 'secret 该已生成');
    assert.strictEqual(req.body.claim_hash, crypto.createHash('sha256').update(secret).digest('hex'));
    assert.ok(!JSON.stringify(req.body).includes(secret), '明文 secret 出现在请求体里');
  });
  await ok('apply 不上传 agent_name(发号是服务端的事)', () => {
    const req = got.find((g) => g.url.endsWith('/apply'));
    assert.strictEqual(req.body.agent_name, undefined);
    assert.strictEqual(req.body.display_name, '飞飞');
  });
  await ok('🔴 本人名字(去掉首尾空白)跟着申请送出去', () => {
    const req = got.find((g) => g.url.endsWith('/apply'));
    assert.strictEqual(req.body.owner_name, '作者');
  });
  // 号按人格发, 人只有一个: 本人名字按机器记, 给别的人格申请时界面直接带出来
  await ok('本人名字按机器记住, 不跟人格走', () => {
    assert.strictEqual(hubJoin.getState('feifei').owner_name, '作者');
    assert.strictEqual(hubJoin.getState('还没申请过的人格').owner_name, '作者');
    const raw = registry.loadRegistry().hubJoin;
    assert.strictEqual(raw.owner_name, '作者');
    assert.ok(!('owner_name' in raw.byPersona.feifei), '本人名字不该落进人格那一份');
  });

  console.log('\n== 自取 ==');
  await ok('没批准时不落通道', async () => {
    const r = await hubJoin.claim('feifei');
    assert.ok(r.ok && !r.granted && r.status === 'pending');
    const p = registry.get('feifei');
    assert.ok(!(p.plugins && p.plugins.buses && p.plugins.buses.length), '不该有通道');
  });

  await ok('批准后自取 → token 落进 plugins.buses', async () => {
    approved = true;
    const r = await hubJoin.claim('feifei');
    assert.ok(r.ok && r.granted, r.error);
    const buses = registry.get('feifei').plugins.buses;
    assert.strictEqual(buses.length, 1);
    assert.strictEqual(buses[0].kind, 'bothub');
    assert.strictEqual(buses[0].agent, AGENT);
    assert.strictEqual(buses[0].token, TOKEN);
    assert.strictEqual(buses[0].inbox, 'bothub');
    // bus.js 的 send 打的是 {base_url}/send —— 少了这段前缀就是 404
    assert.ok(buses[0].base_url.endsWith('/api/v1/agent-bus'), buses[0].base_url);
  });

  // 界面靠这个返回值往手填表里补一行; 不回 spec 的话保存人格时那张表读成空, 刚落盘的 token
  // 被空数组覆盖 —— 一次性签发, 抹掉就再没有(2026-09-07 老师 agent-8696 实撞)。
  await ok('🔴 自取的结果要把落好的通道原样交回界面', async () => {
    approved = true; claimed = false;
    registry.upsert({ id: 'feifei2', name: '飞飞2', homeDir: path.join(TMP, 'f2'), plugins: {} });
    await hubJoin.apply({ displayName: '飞飞2', ownerName: '作者', personaId: 'feifei2' });
    const r = await hubJoin.claim('feifei2');
    assert.ok(r.bus, '没把 spec 交回去');
    assert.deepStrictEqual(r.bus, registry.get('feifei2').plugins.buses[0]);
  });

  await ok('已连上的人格不再弹提示', () => assert.strictEqual(hubJoin.shouldPrompt(), false));

  await ok('重复自取不再发 token, 也不把通道弄坏', async () => {
    const r = await hubJoin.claim('feifei');
    assert.ok(r.ok && !r.granted && r.status === 'claimed');
    assert.strictEqual(registry.get('feifei').plugins.buses.length, 1);
  });

  // 后台撤了 token 之后必须能自愈: 收件循环吃到 401 → 清掉本地那份 → 面板(hubBusOf 连
  // token 一起看)回到「申请」。不清的话用户看到的是「已连接」而一条都收不到, 且无路可走。
  await ok('🔴 token 撤销后清掉本地那份, 但通道壳留着', () => {
    const before = registry.get('feifei').plugins.buses[0];
    assert.ok(before.token, '前提: 这时该有 token');
    const r = hubJoin.revokeLocalToken(before.agent);
    assert.ok(r.ok && r.cleared >= 1, '该清掉至少一条');
    const after = registry.get('feifei').plugins.buses[0];
    assert.strictEqual(after.token, '', 'token 没清掉');
    assert.ok(after.base_url && after.agent, '壳不该一起删 —— 重新 claim 时还要原地更新它');
  });

  await ok('清 token 只动 agent 名对得上的那条', () => {
    const r = hubJoin.revokeLocalToken('someone-else-entirely');
    assert.strictEqual(r.cleared, 0);
  });

  await ok('人格不存在时不写盘', async () => {
    claimed = false; approved = true;
    await hubJoin.apply({ displayName: '查无此人', ownerName: '作者', personaId: 'nobody' });
    const r = await hubJoin.claim('nobody');
    assert.strictEqual(r.ok, false);
  });

  // 🔴 一个人格一份身份: A 申请过不能让 B 的面板以为自己也申请过 —— 共用一份时
  // 服务端还会按 install_id 把 B 的申请 resume 到 A 那条上, 结果是所有人格都申请不了。
  await ok('身份按人格隔离: 申请状态与 install_id 都不串', () => {
    const a = hubJoin.getState('feifei');
    const b = hubJoin.getState('feifei2');
    const fresh = hubJoin.getState('never-applied');
    assert.ok(a.install_id && b.install_id, '两个人格都该有自己的 install_id');
    assert.notStrictEqual(a.install_id, b.install_id, 'install_id 串了');
    assert.notStrictEqual(a.claim_secret, b.claim_secret, 'claim_secret 串了');
    assert.strictEqual(fresh.apply_id, 0, '没申请过的人格不该看见别人的 apply_id');
    assert.strictEqual(fresh.status, '', '没申请过的人格不该看见别人的状态');
  });

  srv.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${fail ? '❌' : '✅'} test-hub-join: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
