// test-model-table.js — 模型定义扩展表: 两份逐格拼 · 认同族 · 取派活三档。跑: node test-model-table.js
require('./host-wiring');
const path = require('path');
const assert = require('assert');
const factory = require(path.join(__dirname, '../core/config/models/vendors.json'));
const { merge, familyOf, tierModels } = require('../core/model-table');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + e.message); } };
const vendor = (t, id) => t.vendors.find((v) => v.id === id);

console.log('\n=== 两份逐格拼: 本机写了的格整格替换, 没写的照用出厂 ===');
ok('只覆盖 openai 的 cheap 一格: cheap 用本机的, 其余三档与 label/protocol 照用出厂', () => {
  const t = merge(factory, { vendors: [{ id: 'openai', tiers: { cheap: ['gpt-opus-like'] } }] });
  const o = vendor(t, 'openai'), f = vendor(factory, 'openai');
  assert.deepStrictEqual(o.tiers.cheap, ['gpt-opus-like']);
  for (const k of ['top', 'strong', 'daily']) assert.deepStrictEqual(o.tiers[k], f.tiers[k]);
  assert.strictEqual(o.protocol, f.protocol);
  assert.strictEqual(o.label, f.label);
});
ok('用户把便宜档填成 opus 也照用(不排前排后, 不留出厂后备)', () => {
  const t = merge(factory, { vendors: [{ id: 'anthropic', tiers: { cheap: ['opus'] } }] });
  assert.deepStrictEqual(vendor(t, 'anthropic').tiers.cheap, ['opus']);
  assert.deepStrictEqual(tierModels(t, 'claude-opus-5-5', ['claude-opus-5-5', 'claude-haiku-4-5']).cheap, 'claude-opus-5-5');
});
ok('本机新厂家追加在后, 出厂各家都还在; 出厂表本身不被改动', () => {
  const before = JSON.stringify(factory);
  const t = merge(factory, { vendors: [{ id: 'mygw', protocol: 'anthropic', base_url: 'https://gw.example', tiers: { cheap: ['^xx-fast$'] } }] });
  assert.strictEqual(t.vendors.length, factory.vendors.length + 1);
  assert.ok(vendor(t, 'mygw'));
  assert.strictEqual(JSON.stringify(factory), before);
});
ok('没有本机表 = 原样出厂', () => {
  assert.deepStrictEqual(merge(factory, null).vendors.map((v) => v.id), factory.vendors.map((v) => v.id));
});

console.log('\n=== 认同族 ===');
const T = merge(factory, null);
ok('claude-opus-5-5 → anthropic / strong; [1m] 后缀也认', () => {
  const f = familyOf(T, 'claude-opus-5-5');
  assert.strictEqual(f.vendor.id, 'anthropic'); assert.strictEqual(f.tier, 'strong');
  assert.strictEqual(familyOf(T, 'claude-opus-4-7[1m]').vendor.id, 'anthropic');
});
ok('deepseek/deepseek-v4-pro → deepseek(命中最长的那家, 不被 Gemini 的 -pro 抢走)', () => {
  assert.strictEqual(familyOf(T, 'deepseek/deepseek-v4-pro').vendor.id, 'deepseek');
  assert.strictEqual(familyOf(T, 'deepseek-v4-pro').vendor.id, 'deepseek');
});
ok('网关乱名字认不出 → null', () => {
  assert.strictEqual(familyOf(T, 'my-gw-model-7'), null);
});
ok('本机给网关加的厂家: 按地址认, 乱名字也认得', () => {
  const t = merge(factory, { vendors: [{ id: 'mygw', protocol: 'anthropic', base_url: 'https://gw.example', tiers: { strong: ['^xx-big$'], cheap: ['^xx-fast$'] } }] });
  const f = familyOf(t, 'xx-big', { base_url: 'https://gw.example' });
  assert.strictEqual(f.vendor.id, 'mygw'); assert.strictEqual(f.tier, 'strong');
  assert.strictEqual(tierModels(t, 'xx-big', ['xx-big', 'xx-fast'], { base_url: 'https://gw.example' }).cheap, 'xx-fast');
});

console.log('\n=== 取派活三档 ===');
ok('Claude: 清单里各档取最新, 裸名(Anthropic 协议)', () => {
  const ids = ['claude-opus-5-5', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-haiku-3-5'];
  assert.deepStrictEqual(tierModels(T, 'claude-opus-5-5', ids), { strong: 'claude-opus-5-5', daily: 'claude-sonnet-5', cheap: 'claude-haiku-4-5-20251001' });
});
ok('子代理跟主模型走同一条通道: 主模型带 deepseek/ 前缀, 子代理也带', () => {
  const r = tierModels(T, 'deepseek/deepseek-v4-pro', ['deepseek-v4-pro', 'deepseek-v4-flash']);
  assert.strictEqual(r.cheap, 'deepseek/deepseek-v4-flash');
  assert.strictEqual(r.strong, 'deepseek/deepseek-v4-pro');
});
ok('清单里没有那一档 → 那一档不给(调用方退回主模型); 清单拉不到 → 全不给', () => {
  assert.strictEqual(tierModels(T, 'claude-opus-5-5', ['claude-opus-5-5']).cheap, undefined);
  assert.deepStrictEqual(tierModels(T, 'claude-opus-5-5', null), {});
});
ok('grok 便宜档只认 grok 自家的便宜型号: grok-4-fast 归日常, 别家的 xx-fast 不算 grok', () => {
  const ids = ['grok-4.7', 'grok-4-fast', 'grok-build-0.1', 'openai-fast'];
  assert.strictEqual(tierModels(T, 'grok/grok-4.7', ids).cheap, 'grok/grok-build-0.1');
  assert.strictEqual(tierModels(T, 'grok/grok-4.7', ['grok-4.7', 'grok-4-fast', 'openai-fast']).cheap, undefined);
  assert.notStrictEqual((familyOf(T, 'mistral-fast') || {}).vendor && familyOf(T, 'mistral-fast').vendor.id, 'grok');
});
ok('豆包(manual)不分档: 主模型是豆包或方舟代卖的别家, 子代理都用主模型', () => {
  const a = { base_url: 'https://ark.cn-beijing.volces.com/api/v3' };
  const ids = ['doubao-seed-2-0-pro-260215', 'doubao-seed-2-0-mini-260428', 'deepseek-v4-pro-260425', 'deepseek-v4-flash-ga-260731'];
  assert.deepStrictEqual(tierModels(T, 'compat/doubao-seed-2-0-pro-260215', ids, a), {});
  assert.deepStrictEqual(tierModels(T, 'compat/deepseek-v4-pro-260425', ids, a), {});
});
ok('派活只出 strong / daily / cheap, 不出 top', () => {
  assert.ok(!('top' in tierModels(T, 'claude-opus-5-5', ['claude-fable-5-1', 'claude-opus-5-5'])));
});

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
