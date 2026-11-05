// test-bus-find.js — bus_admin(op='find'): 只知道对方叫什么时, 按本人名字/人格名查出他的 agent 号。
// to_agent 要的是号(agent-6d79), 人只知道名字 —— 号在 hub 批准时发, 本人名字是申请时填的(core/hub-join.js)。
// 起一个本地假 hub 接 GET /agents, 用真的 _channelTools 拿到 bus_admin 去调, 不起 SDK。
require('./host-wiring');
const http = require('http');
const assert = require('assert');
const { z } = require('zod');
const { BusRegistry } = require('../core/bus');
const McpChannelsMixin = require('../core/agent/mcp-channels');

let pass = 0, fail = 0;
async function ok(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + (e && e.message)); }
}

const ROSTER = [
  { agent_name: 'agent-ac6f', owner_name: '张三', display_name: '飞飞', last_seen_at: '2026-10-09T11:12:30' },
  { agent_name: 'agent-8032', owner_name: '张三丰', display_name: '老管家', last_seen_at: null },
];
const seen = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  seen.push({ path: u.pathname, name: u.searchParams.get('name'), auth: req.headers.authorization });
  if (u.pathname === '/api/v1/agent-bus/agents') {
    if (u.searchParams.get('name') === '炸') { res.writeHead(500); return res.end('boom'); }
    const q = u.searchParams.get('name');
    const agents = ROSTER.filter((a) => a.owner_name.includes(q) || a.display_name.includes(q) || a.agent_name === q);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ agents }));
  }
  res.writeHead(404); res.end('{"detail":"Not Found"}');
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/agent-bus`;
  const self = Object.assign(Object.create(McpChannelsMixin.prototype), {
    homeDir: '/tmp', tgBotToken: null,
    buses: new BusRegistry([{ id: 'hub', kind: 'bothub', base_url: base, token: 'agb_x', agent: 'me' }]),
  });
  const tool = (name, desc, schema, handler) => ({ name, desc, schema, handler });
  const { busAdmin } = self._channelTools({ tool, z, D: { bus_admin: 'd', bus_exec: 'd', send_tg: 'd' } });
  const call = async (args) => (await busAdmin.handler({ op: 'find', args })).content[0].text;

  console.log('[bus_admin op=find]');
  await ok('find 在 op 清单里', () => assert.ok(busAdmin.schema.shape.op.options.includes('find')));
  await ok('只给 op 只回参数表, 不发请求', async () => {
    const before = seen.length;
    const t = (await busAdmin.handler({ op: 'find' })).content[0].text;
    assert.ok(/name=…/.test(t), t);
    assert.strictEqual(seen.length, before);
  });
  await ok('按名字查: 带 token 打 GET /agents?name=', async () => {
    const t = await call({ name: ' 张三 ' });
    const last = seen[seen.length - 1];
    assert.strictEqual(last.path, '/api/v1/agent-bus/agents');
    assert.strictEqual(last.name, '张三', '名字要去掉首尾空白');
    assert.strictEqual(last.auth, 'Bearer agb_x');
    assert.ok(/agent-ac6f · 本人 张三 · 人格 飞飞 · 最近在线 2026-10-09 11:12/.test(t), t);
  });
  await ok('🔴 查出好几个: 都列出来, 并提醒让用户挑', async () => {
    const t = await call({ name: '张三' });
    assert.ok(/找到 2 个/.test(t) && /agent-8032/.test(t) && /让用户挑/.test(t), t);
  });
  await ok('只有一个时不多嘴', async () => {
    const t = await call({ name: '老管家' });
    assert.ok(/找到 1 个/.test(t) && !/让用户挑/.test(t), t);
  });
  await ok('查不到: 说清楚可能是对方还没登记名字', async () => {
    const t = await call({ name: '没这人' });
    assert.ok(/没找到/.test(t) && /还没在 hub 上登记/.test(t), t);
  });
  await ok('hub 出错: 报查找失败, 不装作没找到', async () => {
    const t = await call({ name: '炸' });
    assert.ok(/查找失败/.test(t) && !/没找到/.test(t), t);
  });

  server.close();
  console.log(`\n${fail ? '❌' : '✅'} test-bus-find: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
