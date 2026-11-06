// 联网搜索引擎 —— 只给 Butler 引擎的本机 WebSearch 用。
//
// 规则(作者 2026-11-06 定):
//   · 新装一家都不配 → 只用模型服务端自带的搜索(有就有, 没有就没有)
//   · 用户在设置里自己加引擎(TYPES 五种), 个数不限, 自己排先后, 排前的先试, 一家不通换下一家
//   · 加了引擎就只用这些, 不再给服务端搜索; 勾「禁用」→ 加过的全部不用、配置留着, 退回服务端自带
// 存法: settings.search = { engines: [{ id, type, url? }], disabled }, key 只进不出, 真值在
// secrets['search_key:<id>'](老版本的 brave / tavily 两把 id 恰好就是 'brave' / 'tavily', 迁移不用搬 key)。
// 运行时由 applyEnv 拼成 env.BUTLER_SEARCH_ENGINES(JSON 数组)交给 agent-sdk/src/tools/search-engines.ts。
'use strict';

const TYPES = {
  bing: { name: 'Bing' },
  duckduckgo: { name: 'DuckDuckGo' },
  brave: { name: 'Brave', key: true },
  tavily: { name: 'Tavily', key: true },
  searxng: { name: 'SearXNG', url: true },
};
const ENV = 'BUTLER_SEARCH_ENGINES';
// 老版本注入过的变量也一并清掉, 免得机器上残留的值混进来
const ENV_KEYS = [ENV, 'BRAVE_API_KEY', 'TAVILY_API_KEY', 'BUTLER_SEARCH_PREFER'];
const secretName = (id) => `search_key:${id}`;
const ID_RE = /^[a-z0-9_-]{1,40}$/;

// 读出当前配置。老版本(只有 prefer + 两把 key)第一次读时就地换算:
// 勾过优先的那家排第一且生效; 存了 key 却没勾优先的, 当年是「服务端优先」, 迁成禁用以保持原样。
function current(settings, secrets) {
  const s = settings.read().search || {};
  if (Array.isArray(s.engines)) {
    return {
      engines: s.engines.filter((e) => e && TYPES[e.type] && ID_RE.test(String(e.id))),
      disabled: !!s.disabled,
    };
  }
  const prefer = ['brave', 'tavily'].includes(s.prefer) ? s.prefer : '';
  const order = prefer ? [prefer, ...['brave', 'tavily'].filter((p) => p !== prefer)] : ['brave', 'tavily'];
  const engines = order.filter((p) => secrets.status(secretName(p)) === 'ok').map((p) => ({ id: p, type: p }));
  return { engines, disabled: engines.length > 0 && !prefer };
}

function list({ settings, secrets }) {
  const c = current(settings, secrets);
  return {
    engines: c.engines.map((e) => ({ ...e, key: TYPES[e.type].key ? secrets.status(secretName(e.id)) : '' })),
    disabled: c.disabled,
    types: Object.entries(TYPES).map(([type, t]) => ({ type, name: t.name, key: !!t.key, url: !!t.url })),
    keychain: secrets.available(),
  };
}

// patch = { engines: [{ id?, type, url?, key? }], disabled } —— 整张表替换, 顺序即先后。
// key 三态同凭据: undefined/'' = 不动 · null = 删 · 串 = 换。表里没了的那家, 它的 key 一并删掉。
function save({ settings, secrets }, patch = {}) {
  const before = current(settings, secrets);
  const engines = [];
  for (const e of Array.isArray(patch.engines) ? patch.engines : []) {
    if (!e || !TYPES[e.type]) continue;
    const id = ID_RE.test(String(e.id || '')) ? String(e.id) : `${e.type}-${Date.now().toString(36)}${engines.length}`;
    const row = { id, type: e.type };
    if (TYPES[e.type].url) row.url = String(e.url || '').trim();
    if (TYPES[e.type].key) {
      if (e.key === null) secrets.set(secretName(id), '');
      else if (typeof e.key === 'string' && e.key.trim()) {
        const r = secrets.set(secretName(id), e.key.trim());
        if (!r.ok) return r;
      }
    }
    engines.push(row);
  }
  for (const old of before.engines) {
    if (!engines.some((e) => e.id === old.id)) secrets.set(secretName(old.id), '');
  }
  const rest = { ...(settings.read().search || {}) };
  delete rest.prefer;
  settings.write({ search: { ...rest, engines, disabled: engines.length ? !!patch.disabled : false } });
  return { ok: true };
}

// 一家引擎能不能真用上: 要 key 的得有 key, SearXNG 得有地址
function runnable(e, secrets) {
  const t = TYPES[e.type];
  const conf = { type: e.type };
  if (t.key) { conf.key = secrets.get(secretName(e.id)) || ''; if (!conf.key) return null; }
  if (t.url) { conf.url = e.url || ''; if (!/^https?:\/\//.test(conf.url)) return null; }
  return conf;
}

// 每次建流现拼: 先清后设, 不继承机器上本来就有的同名变量(同 env.js 对 ANTHROPIC_* 的处理)。
function applyEnv(env) {
  for (const k of ENV_KEYS) delete env[k];
  try {
    const { settings, secrets } = require('./host');
    const c = current(settings, secrets);
    if (!c.disabled) {
      const confs = c.engines.map((e) => runnable(e, secrets)).filter(Boolean);
      if (confs.length) env[ENV] = JSON.stringify(confs);
    }
  } catch (_) { /* 宿主没注入 settings/secrets(测试进程、行业版): 不配本机引擎, 只用服务端自带 */ }
  return env;
}

// 设置页卡片上的「测一下」: 用这一家真搜一句。key 现填的优先, 没填用已存的。
async function test({ secrets }, e = {}) {
  if (!TYPES[e.type]) return { ok: false, error: 'unknown type' };
  const conf = { type: e.type };
  if (TYPES[e.type].key) conf.key = (typeof e.key === 'string' && e.key.trim()) || (e.id && secrets.get(secretName(e.id))) || '';
  if (TYPES[e.type].url) conf.url = String(e.url || '').trim();
  if (TYPES[e.type].key && !conf.key) return { ok: false, error: 'no key' };
  const { WebSearch } = await import('@butler/agent-sdk');
  const t0 = Date.now();
  const r = await WebSearch.run({ query: String(e.query || 'Wikipedia') }, { signal: new AbortController().signal, env: { [ENV]: JSON.stringify([conf]) } });
  const text = (r.content || []).map((c) => c.text).join('\n');
  const n = (text.match(/^\d+\. /gm) || []).length;
  return r.isError
    ? { ok: false, ms: Date.now() - t0, error: text.replace(/<\/?tool_use_error>/g, '').replace(/^Search failed: /, '') }
    : { ok: n > 0, ms: Date.now() - t0, count: n, first: (text.split('\n\n')[1] || '').split('\n')[0].replace(/^\d+\.\s*/, '') };
}

function register({ ipcMain, settings, secrets }) {
  ipcMain.handle('list-search-keys', async () => list({ settings, secrets }));
  ipcMain.handle('save-search-keys', async (_e, patch) => save({ settings, secrets }, patch || {}));
  ipcMain.handle('test-search-engine', async (_e, eng) => {
    try { return await test({ secrets }, eng || {}); } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });
}

module.exports = { TYPES, ENV_KEYS, list, save, applyEnv, test, register };
