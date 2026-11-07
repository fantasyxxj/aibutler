// 联网搜索引擎设置回归(core/search-keys.js): 老版本 prefer + 两把 key 的迁移、整表保存与排序、
// 删引擎连 key 一起删、禁用后不注入、要 key 没 key / SearXNG 没地址的跳过、老环境变量被清掉。
// 用内存里的假 settings / secrets, 不碰真设置与钥匙串。
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

function fakes(search, keys = {}) {
  let st = { search };
  const vault = { ...keys };
  return {
    settings: { read: () => st, write: (p) => { st = { ...st, ...p }; } },
    secrets: {
      status: (n) => (vault[n] ? 'ok' : 'none'), get: (n) => vault[n] || '', available: () => true,
      set: (n, v) => { if (v) vault[n] = v; else delete vault[n]; return { ok: true }; },
    },
    vault,
    raw: () => st,
  };
}

const host = require('../core/host');
const SK = require('../core/search-keys');
const envOf = (f) => { host.install({ settings: f.settings, secrets: f.secrets }); return SK.applyEnv({ BRAVE_API_KEY: 'stale', BUTLER_SEARCH_PREFER: 'brave' }); };

// —— 新装: 什么都没配 ——
{
  const f = fakes(undefined);
  const l = SK.list(f);
  ok(l.engines.length === 0 && l.disabled === false && l.types.map((t) => t.type).join() === 'brave,tavily,searxng', '新装: 引擎表为空, 可选三种');
  const env = envOf(f);
  ok(!('BUTLER_SEARCH_ENGINES' in env) && !('BRAVE_API_KEY' in env) && !('BUTLER_SEARCH_PREFER' in env), '新装: 不注入本机引擎, 老变量被清掉 → 只用模型自带搜索');
}

// —— 老版本迁移 ——
{
  const f = fakes({ prefer: 'tavily' }, { 'search_key:brave': 'bk', 'search_key:tavily': 'tk' });
  const l = SK.list(f);
  ok(l.engines.map((e) => e.id).join() === 'tavily,brave' && !l.disabled && l.engines[0].key === 'ok', '老版本勾了优先 Tavily: 迁成 Tavily 在前、Brave 在后, 生效');
  const g = fakes({ prefer: '' }, { 'search_key:brave': 'bk' });
  ok(SK.list(g).disabled === true, '老版本存了 key 没勾优先(当年是服务端优先): 迁成禁用, 行为不变');
}

// —— 保存: 顺序、新 key、删引擎连 key ——
{
  const f = fakes(undefined, { 'search_key:brave': 'bk' });
  SK.save(f, { disabled: false, engines: [{ type: 'bing' }, { id: 'brave', type: 'brave', key: '' }, { type: 'tavily', key: 'tk2' }, { type: 'searxng', url: ' https://searx.test ' }] });
  const l = SK.list(f);
  ok(l.engines.map((e) => e.type).join() === 'brave,tavily,searxng', '保存整张表, 顺序照传入, 已拿掉的 Bing 存不进去');
  const tav = l.engines.find((e) => e.type === 'tavily');
  ok(tav.key === 'ok' && f.vault[`search_key:${tav.id}`] === 'tk2' && f.vault['search_key:brave'] === 'bk', '新 key 存进钥匙串, key 留空 = 不动旧的');
  ok(l.engines.find((e) => e.type === 'searxng').url === 'https://searx.test', 'SearXNG 地址去掉首尾空白');
  ok(!('prefer' in f.raw().search), '老的 prefer 字段被清掉');

  const conf = JSON.parse(envOf(f).BUTLER_SEARCH_ENGINES);
  ok(conf.map((c) => c.type).join() === 'brave,tavily,searxng' && conf[0].key === 'bk' && conf[1].key === 'tk2', '注入的引擎表按顺序带上各自的 key');

  SK.save(f, { disabled: false, engines: l.engines.filter((e) => e.type !== 'brave').map((e) => ({ id: e.id, type: e.type, url: e.url })) });
  ok(!f.vault['search_key:brave'] && SK.list(f).engines.length === 2, '删掉 Brave: 它的 key 一并删');

  SK.save(f, { disabled: true, engines: SK.list(f).engines.map((e) => ({ id: e.id, type: e.type, url: e.url })) });
  ok(!('BUTLER_SEARCH_ENGINES' in envOf(f)) && SK.list(f).engines.length === 2, '勾禁用: 配置留着, 但不注入 → 只用模型自带');

  SK.save(f, { disabled: true, engines: [] });
  ok(SK.list(f).disabled === false, '引擎全删光时禁用自动取消(没有东西可禁)');
}

// —— 用不上的跳过 ——
{
  const f = fakes({ engines: [{ id: 'brave', type: 'brave' }, { id: 'sx', type: 'searxng', url: '' }, { id: 'b', type: 'bing' }], disabled: false });
  ok(envOf(f).BUTLER_SEARCH_ENGINES === undefined, 'Brave 没 key、SearXNG 没地址的跳过; 老配置里的 Bing 也不注入(已拿掉) → 一家都没有就不设');
}

console.log(fails ? `\n✗ ${fails} 项失败` : '\n✓ 全部通过');
process.exit(fails ? 1 : 0);
