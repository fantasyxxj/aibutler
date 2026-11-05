// test-agent-bus.js — Phase 1.5 agent-bus channel + translate handler unit tests.
// Run: /usr/local/bin/node test-agent-bus.js
//
// Covers: config guards, cursor persistence, /inbox long-poll drain, handler
// dispatch, /exec Idempotency-Key retry, JSON extraction fallbacks, prompt
// content (three cultural-trap rules), and the groupByField shape.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { AgentBusChannel } = require('./plugins/agent-bus');
const { buildPrompt, extractJson, groupByField } = require('./handlers/translate');

let pass = 0, fail = 0;
const cases = [];
function t(name, fn) { cases.push([name, fn]); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-'));
  return { dir: d, in_file: path.join(d, 'events.jsonl') };
}

// ---------- prompt content ----------

t('buildPrompt includes all three cultural-trap rules', () => {
  const p = buildPrompt('ja', ['en', 'zh-CN'], [{ key: 'menu_item.1.name_i18n', text: '唐揚げ' }]);
  assert.ok(p.includes('karaage'), 'karaage rule missing');
  assert.ok(p.includes('teriyaki'), 'teriyaki rule missing');
  assert.ok(p.includes('定食'), '定食 rule missing');
  assert.ok(p.includes('秘伝') || p.includes('branding'), 'branding rule missing');
  assert.ok(p.includes('"en"') && p.includes('"zh-CN"'), 'target langs missing');
});

t('extractJson strips ```json fences', () => {
  const src = 'sure, here it is:\n```json\n{"a":1}\n```\ncheers';
  assert.equal(extractJson(src), '{"a":1}');
});

t('extractJson recovers when prose wraps the object', () => {
  const src = 'prefix {"a":1} suffix';
  assert.equal(extractJson(src), '{"a":1}');
});

t('extractJson passthrough when payload is pure JSON', () => {
  assert.equal(extractJson('{"x":2}'), '{"x":2}');
});

t('groupByField splits name_i18n vs desc_i18n by key suffix', () => {
  const grouped = groupByField([
    { key: 'menu_item.5.name_i18n', values: { en: 'Karaage', 'zh-CN': '炸鸡' } },
    { key: 'menu_item.5.desc_i18n', values: { en: 'Crispy', 'zh-CN': '酥脆' } },
  ]);
  assert.deepEqual(grouped.name_i18n, { en: 'Karaage', 'zh-CN': '炸鸡' });
  assert.deepEqual(grouped.desc_i18n, { en: 'Crispy', 'zh-CN': '酥脆' });
});

// ---------- channel config guards ----------

t('start() fails when bus_base_url missing', () => {
  const c = new AgentBusChannel({}, 'test', () => {}, {});
  const r = c.start();
  assert.equal(r.ok, false);
  assert.ok(/bus_base_url/.test(r.error));
});

t('start() fails when store_token missing', () => {
  const c = new AgentBusChannel({ bus_base_url: 'http://x' }, 'test', () => {}, {});
  const r = c.start();
  assert.equal(r.ok, false);
  assert.ok(/store_token/.test(r.error));
});

t('start() fails when agent missing', () => {
  const c = new AgentBusChannel({ bus_base_url: 'http://x', store_token: 'k' }, 'test', () => {}, {});
  const r = c.start();
  assert.equal(r.ok, false);
  assert.ok(/agent/.test(r.error));
});

t('start() fails when in_file missing', () => {
  const c = new AgentBusChannel({ bus_base_url: 'http://x', store_token: 'k', agent: 'butler-store-1' },
                                 'test', () => {}, {});
  const r = c.start();
  assert.equal(r.ok, false);
  assert.ok(/in_file/.test(r.error));
});

// 游标的读写本身归 BusPoller (test-bus.js 覆盖)。这里只确认这条通道**接上了**
// 落盘的水位 —— 接错了的症状是 butler 重启后把处理过的事件再跑一遍。
t('cursor picks up the persisted watermark on start', () => {
  const { in_file, dir } = tmp();
  fs.writeFileSync(in_file + '.cursor', '42');
  const c = new AgentBusChannel({
    bus_base_url: 'http://x', store_token: 'k', agent: 'butler-store-1', in_file,
  }, 'test', () => {}, {});
  c.start();
  assert.equal(c.cursor, 42);
  c.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- integration: mock bus round-trip ----------

async function mockBus() {
  const inbox = [];  // events pushed by test
  const exec = [];   // /exec payloads received from channel
  let idempSeen = new Map();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
      if (req.method === 'GET' && req.url.startsWith('/bus/v1/agent/inbox')) {
        const auth = req.headers['authorization'] || '';
        if (auth !== 'Bearer testtok') { res.writeHead(401); return res.end(); }
        const url = new URL(req.url, 'http://x');
        const cursor = parseInt(url.searchParams.get('cursor') || '0', 10);
        const events = inbox.filter((e) => e.seq > cursor);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          events,
          cursor: events.length ? events[events.length - 1].seq : cursor,
        }));
      }
      if (req.method === 'POST' && req.url === '/bus/v1/agent/exec') {
        const key = req.headers['idempotency-key'] || '';
        if (!key) { res.writeHead(422); return res.end('{"detail":{"code":"idempotency_key_required"}}'); }
        if (idempSeen.has(key)) {
          const prior = idempSeen.get(key);
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify(prior));
        }
        const parsed = JSON.parse(body);
        exec.push({ key, body: parsed });
        const result = { ok: true, correlation_id: parsed.correlation_id, result: { echoed: true } };
        idempSeen.set(key, result);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(result));
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}`, inbox, exec };
}

t('channel drains inbox, dispatches translate, /exec receives apicall', async () => {
  const { server, base, inbox, exec } = await mockBus();
  const { in_file, dir } = tmp();
  const logs = [];
  let handlerCalls = 0;
  const handlers = {
    'translate.request': async (payload, ctx) => {
      handlerCalls += 1;
      const r = await ctx.send('apicall', {
        method: 'PUT',
        path: `/bus/v1/admin/menu/${payload.menu_item_id}/translations`,
        body: { name_i18n: { en: 'X' } },
      }, payload.correlation_id);
      assert.ok(r.ok, '/exec should succeed');
      return { replied: true };
    },
  };
  inbox.push({
    seq: 1, event_id: 'e1', agent: 'butler-store-1', type: 'translate.request',
    payload: { source_lang: 'ja', target_langs: ['en'], items: [{ key: 'menu_item.9.name_i18n', text: '唐揚げ' }],
               correlation_id: 'corr-1', menu_item_id: 9 },
    received_at: '2026-07-19T20:00:00',
  });
  const c = new AgentBusChannel({
    bus_base_url: base, store_token: 'testtok', agent: 'butler-store-1', in_file, wait: 0,
  }, 'test', (l) => logs.push(l), handlers);
  c.start();
  // Give the loop a couple of ticks to fetch + handle.
  for (let i = 0; i < 40 && handlerCalls === 0; i++) await sleep(50);
  await sleep(150);
  c.stop();
  assert.equal(handlerCalls, 1, `handler should have fired once; logs=${logs.join(' | ')}`);
  assert.equal(exec.length, 1, 'bus /exec should have received one command');
  assert.equal(exec[0].body.command, 'apicall');
  assert.equal(exec[0].body.correlation_id, 'corr-1');
  assert.equal(exec[0].body.content.path, '/bus/v1/admin/menu/9/translations');
  assert.equal(c.cursor, 1, 'cursor should have advanced to the processed seq');
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

t('channel: 401 stops the loop and records lastError', async () => {
  const { server, base } = await mockBus();
  const { in_file, dir } = tmp();
  const c = new AgentBusChannel({
    bus_base_url: base, store_token: 'wrong', agent: 'butler-store-1', in_file, wait: 0,
  }, 'test', () => {}, {});
  c.start();
  for (let i = 0; i < 30 && !c.stopped; i++) await sleep(50);
  assert.equal(c.stopped, true);
  assert.equal(c.lastError, 'token 无效');
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

t('channel: handler throw is caught and logged, cursor still advances', async () => {
  const { server, base, inbox } = await mockBus();
  const { in_file, dir } = tmp();
  const logs = [];
  const handlers = {
    'translate.request': async () => { throw new Error('kaboom'); },
  };
  inbox.push({
    seq: 1, event_id: 'e1', agent: 'butler-store-1', type: 'translate.request',
    payload: { correlation_id: 'corr-boom' }, received_at: '2026-07-19T20:00:00',
  });
  const c = new AgentBusChannel({
    bus_base_url: base, store_token: 'testtok', agent: 'butler-store-1', in_file, wait: 0,
  }, 'test', (l) => logs.push(l), handlers);
  c.start();
  for (let i = 0; i < 30; i++) { if (c.cursor === 1) break; await sleep(50); }
  await sleep(100);
  c.stop();
  assert.equal(c.cursor, 1, 'cursor advances even when handler throws (at-least-once policy)');
  assert.ok(logs.some((l) => /kaboom/.test(l)), 'handler exception should be logged');
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

t('/exec Idempotency-Key = <corr>-<command>; replay returns the cached body', async () => {
  const { server, base, exec } = await mockBus();
  const { in_file, dir } = tmp();
  const c = new AgentBusChannel({
    bus_base_url: base, store_token: 'testtok', agent: 'butler-store-1', in_file, wait: 0,
  }, 'test', () => {}, {});
  c.start();
  const r1 = await c.send('apicall', { method: 'PUT', path: '/bus/v1/admin/x' }, 'corr-99');
  const r2 = await c.send('apicall', { method: 'PUT', path: '/bus/v1/admin/x' }, 'corr-99');
  assert.ok(r1.ok && r2.ok);
  assert.equal(exec.length, 1, 'server only registered the first insert (replay hit cache)');
  await c.stop();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- runner ----------

(async () => {
  for (const [name, fn] of cases) {
    try { await fn(); pass += 1; console.log('  ✓', name); }
    catch (e) { fail += 1; console.log('  ✗', name, '\n     ', e.message); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
