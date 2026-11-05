// test-bothub-filter.js — 分级唤醒过滤 v1 (worker_ant) 单测。gitignored, 证据用。
// 跑法: /usr/local/bin/node test-bothub-filter.js
const assert = require('assert');
const { BothubNativeChannel, classifyBusMsg } = require('./plugins/bothub-native');

let pass = 0, fail = 0;
const cases = [];
function t(name, fn) { cases.push([name, fn]); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— 分类规则 ——
t('kind=reply → silent', () => assert.equal(classifyBusMsg({ text: '随便', payload: { kind: 'reply' } }), 'silent'));
t('kind=ack → silent', () => assert.equal(classifyBusMsg({ text: 'x', payload: { kind: 'ack' } }), 'silent'));
t('kind=heartbeat → silent', () => assert.equal(classifyBusMsg({ text: 'x', payload: { kind: 'heartbeat' } }), 'silent'));
t('前缀 [ACK] → silent', () => assert.equal(classifyBusMsg({ text: '[ACK] 收到' }), 'silent'));
t('前缀 [REPLY] → silent', () => assert.equal(classifyBusMsg({ text: '[REPLY] bus#5050 收到' }), 'silent'));
t('前缀 [P2- → silent', () => assert.equal(classifyBusMsg({ text: '[P2-低优] 不急' }), 'silent'));
t('猫猫心跳(无 payload) → silent', () => assert.equal(classifyBusMsg({ from_agent: 'dc_cursor_bot', text: '【猫猫·心跳】ok' }), 'silent'));
t('前缀 [P0- → immediate (唯一立即档)', () => assert.equal(classifyBusMsg({ text: '[P0-炸了] 生产挂了' }), 'immediate'));
t('前缀 [P1- → debounce (值班协议: 记录不打扰)', () => assert.equal(classifyBusMsg({ text: '[P1-高优] 尽快' }), 'debounce'));
t('kind=question → debounce', () => assert.equal(classifyBusMsg({ text: '请问', payload: { kind: 'question' } }), 'debounce'));
t('kind=request → debounce', () => assert.equal(classifyBusMsg({ text: 'x', payload: { kind: 'request' } }), 'debounce'));
t('kind=task → debounce', () => assert.equal(classifyBusMsg({ text: 'x', payload: { kind: 'task' } }), 'debounce'));
t('kind=alert → debounce', () => assert.equal(classifyBusMsg({ text: 'x', payload: { kind: 'alert' } }), 'debounce'));
t('规则序: kind=reply 但文本 [P0- → 静默优先(规则1先于2)', () => assert.equal(classifyBusMsg({ text: '[P0-x]', payload: { kind: 'reply' } }), 'silent'));
t('自由文本无 payload 无前缀 → debounce', () => assert.equal(classifyBusMsg({ text: '顺便说一句' }), 'debounce'));
t('有 payload 但无 kind (千行生产申请) → debounce', () => assert.equal(classifyBusMsg({ text: '【Owner 千行·生产上线申请】', payload: { message_type: 'prod_release_application' } }), 'debounce'));

// —— channel 行为 ——
function mkChan(agent, tuning, wakes, logs) {
  const cfg = { endpoints: [{ url: 'http://bus.test', agent }], _tuning: tuning };
  return new BothubNativeChannel(cfg, 'test', (l) => logs && logs.push(l), (evt) => wakes.push(evt));
}
const ep = (agent) => ({ url: 'http://bus.test', agent });
let mid = 100;
const msg = (text, payload) => ({ id: ++mid, from_agent: 'peer', text, payload });

t('分级对所有 agent 生效: 普通消息 debounce 攒着, 心跳静默', () => {
  const wakes = [];
  const c = mkChan('xiaokai', { debounceMs: 60000, debounceMax: 5 }, wakes);
  c._process(ep('xiaokai'), 0, [msg('普通消息'), msg('【心跳】x')]);
  assert.equal(wakes.length, 0, '不再立即唤醒');
  assert.equal(c.gradeStates.get(0).pending, 1);
  assert.equal(c.gradeStates.get(0).silentCount, 1);
});

t('分级对所有 agent 生效: 非 worker_ant 也吃 P0 立即唤醒', () => {
  const wakes = [];
  const c = mkChan('xiaokai', { debounceMs: 60000, debounceMax: 5 }, wakes);
  c._process(ep('xiaokai'), 0, [msg('先攒一条'), msg('[P0-炸] 快')]);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].kind, 'immediate');
  assert.equal(wakes[0].count, 2);
});

t('worker_ant: 纯静默批不唤醒, offset 照推', () => {
  const wakes = [];
  const c = mkChan('worker_ant', {}, wakes);
  const m1 = msg('[REPLY] 收到'), m2 = msg('x', { kind: 'reply' });
  c._process(ep('worker_ant'), 0, [m1, m2]);
  assert.equal(wakes.length, 0);
  assert.equal(c.offsets.get(0), m2.id);
  assert.equal(c.status().endpoints[0].gradeSilent, 2);
});

t('worker_ant: P0 立即唤醒且捎带 debounce 积压', () => {
  const wakes = [];
  const c = mkChan('worker_ant', { debounceMs: 60000, debounceMax: 5 }, wakes);
  c._process(ep('worker_ant'), 0, [msg('自由文本1'), msg('自由文本2')]);
  assert.equal(wakes.length, 0, 'debounce 攒着不该唤醒');
  c._process(ep('worker_ant'), 0, [msg('[P0-炸] 快')]);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].count, 3, '1 立即 + 2 积压');
  assert.equal(c.gradeStates.get(0).pending, 0, '积压已清');
  assert.equal(c.gradeStates.get(0).timer, null, '定时器已清');
});

t('worker_ant: debounce 攒满 5 条合并一次唤醒', () => {
  const wakes = [];
  const c = mkChan('worker_ant', { debounceMs: 60000, debounceMax: 5 }, wakes);
  c._process(ep('worker_ant'), 0, [msg('a'), msg('b')]);
  c._process(ep('worker_ant'), 0, [msg('c'), msg('d')]);
  assert.equal(wakes.length, 0);
  c._process(ep('worker_ant'), 0, [msg('e')]);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].count, 5);
});

t('worker_ant: debounce 到点(时间先到)合并唤醒', async () => {
  const wakes = [];
  const c = mkChan('worker_ant', { debounceMs: 120, debounceMax: 5 }, wakes);
  c._process(ep('worker_ant'), 0, [msg('a'), msg('b')]);
  assert.equal(wakes.length, 0);
  await sleep(250);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].count, 2);
});

t('worker_ant: 6h(缩短模拟) 无唤醒 + 静默堆积 → 扫尾唤醒一次', async () => {
  const wakes = [];
  const c = mkChan('worker_ant', { sweepAfterMs: 100 }, wakes);
  c._process(ep('worker_ant'), 0, [msg('[ACK] 1')]);
  assert.equal(wakes.length, 0, '未到窗口不扫');
  await sleep(150);
  c._process(ep('worker_ant'), 0, [msg('[ACK] 2')]);
  assert.equal(wakes.length, 1, '过窗口且堆积 → 扫尾');
  c._process(ep('worker_ant'), 0, [msg('[ACK] 3')]);
  assert.equal(wakes.length, 1, '刚扫过, lastWakeAt 已刷新不重复扫');
});

t('stop() 清 debounce 定时器, 停后不再唤醒', async () => {
  const wakes = [];
  const c = mkChan('worker_ant', { debounceMs: 100, debounceMax: 5 }, wakes);
  c._process(ep('worker_ant'), 0, [msg('a')]);
  await c.stop();
  await sleep(200);
  assert.equal(wakes.length, 0);
});

(async () => {
  for (const [name, fn] of cases) {
    try { await fn(); pass++; console.log(`✅ ${name}`); }
    catch (e) { fail++; console.log(`❌ ${name}: ${e.message}`); }
  }
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();
