// test-dormant-wake.js — 没打开的人格来消息自动唤醒(dormant-wake.js)的门禁, 全在本机, 不连真平台。
//   node personal/test-dormant-wake.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TYPES } = require('./channels');
const { wireChannels } = require('./channels/wire');
const dormant = require('./dormant-wake');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dormant-'));
const mk = (n) => { const d = path.join(tmp, n); fs.mkdirSync(path.join(d, '.claude', 'memory'), { recursive: true }); return d; };

// 假双向通道: 起来 30ms 后来一条消息
const fakeStarted = [];
TYPES.fake_bot = { dir: 'two', create: (spec, ctx) => ({
  start() { fakeStarted.push(spec.id); setTimeout(() => ctx.onMessage({ from_id: 'u1', from_name: 'alice', chat_id: 'c1', text: 'hello from fake' }), 30); },
  stop() {}, status() { return { running: true }; }, send: async () => ({ ok: true }),
}) };

// 假 TG: 记下每次 getUpdates 的 offset, 头一次就给一条消息
const tgCalls = [];
global.fetch = async (url) => {
  const m = /getUpdates\?offset=(\d+)/.exec(String(url));
  if (m) tgCalls.push(Number(m[1]));
  return { ok: true, status: 200, json: async () => ({ ok: true, result: [{ update_id: 42, message: { chat: { id: 7 }, from: { id: 7 }, text: 'hi', date: 1 } }] }) };
};

(async () => {
  const tgHome = mk('tg'), chHome = mk('ch'), offHome = mk('off');
  fs.writeFileSync(path.join(tgHome, '.claude', 'memory', 'tg_inbox.jsonl'), JSON.stringify({ update_id: 40 }) + '\n');
  const entries = [
    { id: 'a', name: 'TG人格', homeDir: tgHome, plugins: { tg: { mode: 'native', bot_token: 'T' } } },
    { id: 'b', name: '通道人格', homeDir: chHome, plugins: { channels: [{ id: 'fake1', type: 'fake_bot' }] } },
    { id: 'c', name: '关了开关', homeDir: offHome, wakeOnMessage: { channels: false, bothub: false }, plugins: { tg: { mode: 'native', bot_token: 'T2' }, channels: [{ id: 'fake2', type: 'fake_bot' }] } },
  ];
  const opened = new Set(), woke = [];
  const dw = dormant.create({
    registry: { list: () => entries, ensureBuses: () => [] },
    isOpen: (d) => opened.has(path.resolve(d)),
    wake: (d, why) => { woke.push([path.basename(d), why]); opened.add(path.resolve(d)); },
  });

  console.log('开关与守候');
  ok(JSON.stringify(dormant.planOf(entries[2], { ensureBuses: () => [] })) === '{}', '两个开关都关: 什么都不守');
  ok(dormant.wakeFlags({}).channels && dormant.wakeFlags({}).bothub, '没配开关: 两个都默认开');
  dw.sync();
  ok(dw.status().length === 2, `守着两个人格(实际 ${dw.status().map((s) => s.name).join(',')})`);
  await sleep(120);

  console.log('Telegram');
  ok(tgCalls[0] === 41, `从 in_file 水位线 +1 起看(offset=${tgCalls[0]})`);
  ok(tgCalls.length === 1, '看到消息就停, 不带新 offset 再拉(消息留给正式插件)');
  ok(woke.some(([n, w]) => n === 'tg' && w === 'Telegram'), 'TG 来消息 → 唤醒 TG人格');

  console.log('统一通道');
  ok(woke.some(([n]) => n === 'ch'), '通道来消息 → 唤醒 通道人格');
  ok(!fakeStarted.includes('fake2'), '关了开关的人格没起通道');
  const h = dw.takeChannelHost(chHome);
  ok(h && h.buf.length === 1, '守候攒下了那一条消息');
  const submitted = [];
  const s = { convo: [], persist() {}, butler: { name: '通道人格', memoryDir: path.join(chHome, '.claude', 'memory'),
    setChannelHost(x) { s.host = x; }, submit: async (t, a, o) => { submitted.push(o.rawText); } } };
  const startsBefore = fakeStarted.length;
  await wireChannels(s, entries[1], { cfg: { render: () => 'env' }, log: () => {}, handoff: h });
  ok(s.channels === h.host && s.host === h.host, 'wire.js 接手同一个 ChannelHost');
  ok(fakeStarted.length === startsBefore, '接手不重连');
  ok(submitted[0] === 'hello from fake', '攒下的消息补交给人格');
  ok(dw.takeChannelHost(chHome) === null, '交接只发生一次');

  console.log('对账');
  ok(dw.status().length === 0, '两个都唤醒了, 不再守');
  opened.delete(path.resolve(tgHome));
  dw.sync();
  ok(dw.status().some((x) => x.name === 'TG人格'), '关掉标签后重新守候');
  dw.release(tgHome);
  ok(dw.status().length === 0, '手动打开时守候让位');
  dw.stopAll();

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
