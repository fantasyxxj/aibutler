// test-bothub-inbox.js — bothub 收件箱: 拉到先落本地, 交付成功才算数, 没交出去的下次补交。
// 跑法: node personal/test-bothub-inbox.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BothubNativeChannel } = require('./plugins/bothub-native');
const { BothubInbox } = require('./plugins/bothub-inbox');

let pass = 0, fail = 0;
const cases = [];
function t(name, fn) { cases.push([name, fn]); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// url 指向一个连不上的口: start() 起的取件循环只会退避重试, 不碰网络上的真 bus。
const URL = 'http://127.0.0.1:9';
const EP = { url: URL, agent: 'me', token: 'agb_test' };
const KEY = `${URL}|me`;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bothub-inbox-'));
function mkChan(dir, wakes, tuning) {
  const cfg = { endpoints: [EP], _offsetDir: dir, _tuning: { debounceMs: 60000, debounceMax: 5, ...(tuning || {}) } };
  return new BothubNativeChannel(cfg, 'test', () => {}, (evt) => wakes.push(evt));
}
let mid = 100;
const msg = (text) => ({ id: ++mid, from_agent: 'peer', text });
const onDisk = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.bothub_inbox.json'), 'utf8')).items;

t('拉到的普通消息当场落盘(还在攒批, 没唤醒), 心跳不进收件箱', () => {
  const dir = tmpDir(), wakes = [];
  const c = mkChan(dir, wakes);
  c._process(EP, 0, [msg('普通'), msg('【心跳】x')]);
  assert.equal(wakes.length, 0);
  const items = onDisk(dir);
  assert.equal(items.length, 1);
  assert.equal(items[0].msg.text, '普通');
  assert.equal(items[0].done, null);
});

t('交付成功(ack true)才标已交付', () => {
  const dir = tmpDir(), wakes = [];
  const c = mkChan(dir, wakes);
  c._process(EP, 0, [msg('[P0-急] 快')]);
  assert.equal(wakes.length, 1);
  assert.equal(onDisk(dir)[0].done, null);
  wakes[0].ack(true);
  assert.ok(onDisk(dir)[0].done > 0);
});

t('攒批中关掉, 重开就补交; 补交成功后再开不再重复', async () => {
  const dir = tmpDir(), wakes1 = [];
  const c1 = mkChan(dir, wakes1);
  c1._process(EP, 0, [msg('a'), msg('b')]);
  await c1.stop();                       // 模拟关 app: 攒着的两条只唤醒过 0 次
  assert.equal(wakes1.length, 0);

  const wakes2 = [];
  const c2 = mkChan(dir, wakes2);
  c2.start();
  assert.equal(wakes2.length, 1);
  assert.deepEqual(wakes2[0].msgs.map((m) => m.text), ['a', 'b']);
  wakes2[0].ack(true);
  await c2.stop();

  const wakes3 = [];
  const c3 = mkChan(dir, wakes3);
  c3.start();
  await c3.stop();
  assert.equal(wakes3.length, 0);
});

t('交付失败(ack false)放回去, 过一会儿自己重交', async () => {
  const dir = tmpDir(), wakes = [];
  const c = mkChan(dir, wakes, { retryMs: 50 });
  c._process(EP, 0, [msg('[P0-急] 一')]);
  wakes[0].ack(false);
  await sleep(120);
  assert.equal(wakes.length, 2);
  assert.equal(wakes[1].msgs[0].text, '[P0-急] 一');
  wakes[1].ack(true);
  assert.ok(onDisk(dir)[0].done > 0);
  await c.stop();
});

t('上一批还在交付途中, 新来的 P0 只带新的, 不重复带上一批', () => {
  const dir = tmpDir(), wakes = [];
  const c = mkChan(dir, wakes);
  c._process(EP, 0, [msg('[P0-急] 一')]);
  c._process(EP, 0, [msg('[P0-急] 二')]);
  assert.equal(wakes.length, 2);
  assert.deepEqual(wakes[1].msgs.map((m) => m.text), ['[P0-急] 二']);
});

t('收件箱写不进去就抛, 游标不推(服务端下次还给)', () => {
  const dir = tmpDir(), wakes = [];
  const c = mkChan(dir, wakes);
  c.offsets.set(0, 50);
  c.inbox._save = () => { throw new Error('disk full'); };
  assert.throws(() => c._process(EP, 0, [msg('x')]), /disk full/);
  assert.equal(c.offsets.get(0), 50);
});

t('同一条重复拉到只存一份', () => {
  const dir = tmpDir();
  const box = new BothubInbox(path.join(dir, 'x.json'));
  const m = msg('dup');
  assert.equal(box.add(KEY, [m]), 1);
  assert.equal(box.add(KEY, [m]), 0);
  assert.equal(box.pending(KEY).length, 1);
});

(async () => {
  for (const [name, fn] of cases) {
    try { await fn(); pass++; console.log(`✅ ${name}`); }
    catch (e) { fail++; console.log(`❌ ${name}: ${e.message}`); }
  }
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();
