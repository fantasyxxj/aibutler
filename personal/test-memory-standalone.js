// 记忆体能不能被"一个跟 butler 毫无关系的应用"直接吃 —— 内核抽包第 2 步的验收判据。
//
// 这条测试的价值不在覆盖率, 在于它是**唯一**能挡住耦合悄悄长回来的东西:
// 只要有人在记忆体里 require 了 electron / paths.js / config-loader, 这里就红。
// 普通测试挡不住 —— 它们跑在仓里, 那些模块恰好都 require 得到。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
const t = (name, fn) => {
  try { const r = fn(); console.log(`  ok  ${name}${r ? ' — ' + r : ''}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}: ${e && e.message}`); process.exitCode = 1; }
};

console.log('记忆体独立性(不起 Electron, 不注入宿主):');

// 1. 装不下 electron 就该照样 require 得动。这里直接查依赖闭包里有没有它。
t('记忆体的依赖闭包里没有 electron', () => {
  const before = new Set(Object.keys(require.cache));
  require('../core/memory-v2');
  const loaded = Object.keys(require.cache).filter((p) => !before.has(p));
  const bad = loaded.filter((p) => /[\\/]electron[\\/]/.test(p) || p.endsWith('/paths.js') || p.endsWith('/config-loader.js'));
  assert.deepStrictEqual(bad, [], '不该被拉进来: ' + bad.join(', '));
  return `新载入 ${loaded.length} 个模块, 无宿主依赖`;
});

const { MemoryGraphV2 } = require('../core/memory-v2');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-standalone-'));
const g = new MemoryGraphV2(dir);

t('没有宿主注入也能建图', () => `库建在 ${path.basename(dir)}`);

t('写入一条', () => {
  const r = g.upsert({
    slug: 'standalone_probe', title: '独立性探针', type: 'reference', importance: 'high',
    claim: '命题: 记忆体不依赖宿主也能完成一次写入与检索。',
    keywords: '独立 standalone 探针 probe 解耦',
    body: '内核抽包第 2 步的验收样本。',
  });
  assert.ok(r && r.id, 'upsert 没返回 id');
  return `#${r.id}`;
});

t('检索得回来', () => {
  const rows = g.query('独立 探针', { k: 5 });
  const hit = rows.find((x) => x.slug === 'standalone_probe');
  assert.ok(hit, '刚写的那条没检索到');
  return `命中 tier=${hit.tier} conf=${hit.confidence}`;
});

t('标定值取得到(无覆盖层时走出厂默认)', () => {
  const { currentTuning } = require('../core/memory-v2');
  const cur = currentTuning();
  assert.strictEqual(typeof cur.tier_hi, 'number', 'tier_hi 不是数字');
  assert.ok(cur.tier_hi > cur.tier_mid, '高档线必须高于闭嘴线');
  return `tier_hi=${cur.tier_hi} tier_mid=${cur.tier_mid}`;
});

t('没有配置层时 pinned 四问走内置兜底而不是抛错', () => {
  const msg = g._pinnedFullMessage('standalone_probe');
  assert.ok(typeof msg === 'string' && msg.length > 20, '兜底文案没出来');
  return `${msg.split('\n')[0].slice(0, 24)}…`;
});

g.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log('\n配置加载器内核(来源链由宿主注入):');

t('加载器内核的依赖闭包里没有 electron / paths.js', () => {
  const before = new Set(Object.keys(require.cache));
  require('../core/config-loader');
  const loaded = Object.keys(require.cache).filter((p) => !before.has(p));
  const bad = loaded.filter((p) => /[\\/]electron[\\/]/.test(p) || p.endsWith('/paths.js'));
  assert.deepStrictEqual(bad, [], '不该被拉进来: ' + bad.join(', '));
  return `新载入 ${loaded.length} 个模块`;
});

t('任意来源链: 先命中先用, 落空回落出厂', () => {
  const { createConfigLoader } = require('../core/config-loader');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-standalone-'));
  const hi = path.join(d, 'hi'); const lo = path.join(d, 'lo');
  fs.mkdirSync(hi, { recursive: true }); fs.mkdirSync(lo, { recursive: true });
  fs.writeFileSync(path.join(lo, 'a.md'), '出厂'); fs.writeFileSync(path.join(lo, 'b.md'), '出厂B');
  fs.writeFileSync(path.join(hi, 'a.md'), '下发');
  const cfg = createConfigLoader({ sources: [hi, lo] });
  assert.strictEqual(cfg.text('a'), '下发', '高优先来源没赢');
  assert.strictEqual(cfg.text('b'), '出厂B', '高优先没有时该回落');
  assert.strictEqual(cfg.whichFile('a').overridden, true);
  assert.strictEqual(cfg.whichFile('b').overridden, false);
  fs.rmSync(d, { recursive: true, force: true });
  return '两级链行为正确';
});

t('单来源链(彻底下发, 无覆盖能力)也成立', () => {
  const { createConfigLoader } = require('../core/config-loader');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-single-'));
  fs.writeFileSync(path.join(d, 'only.md'), '唯一');
  const cfg = createConfigLoader({ sources: [d] });
  assert.strictEqual(cfg.text('only'), '唯一');
  assert.strictEqual(cfg.overrideRoot(), null, '单来源不该报告有覆盖层');
  fs.rmSync(d, { recursive: true, force: true });
  return 'overrideRoot=null';
});

console.log(`\n${pass} 条通过`);
