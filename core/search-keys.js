// 联网搜索 key(Brave / Tavily) —— 只给 Butler 引擎的本机 WebSearch 用。
//
// 规则(作者 2026-11-03 定): 配了 key 且勾了「优先」→ 只用这把 key 在本机搜;
// 不勾或没配 → 服务端搜索优先(Anthropic / OpenAI 协议自带的 web_search), 本机 WebSearch 兜底。
// 服务端到底搜不搜得到没法事先知道, 搜不到时由用户跟 AI 商量换法子, 这里不做探测。
//
// key 跟模型 key 一样只进不出: 渲染层只拿到 keyState, 真值存 secrets['search_key:<provider>']。
// 「优先」存 settings.search.prefer = 'brave' | 'tavily' | ''(单选: 两把都勾没有意义)。
'use strict';

const PROVIDERS = ['brave', 'tavily'];
const ENV_KEY = { brave: 'BRAVE_API_KEY', tavily: 'TAVILY_API_KEY' };
const ENV_KEYS = [...Object.values(ENV_KEY), 'BUTLER_SEARCH_PREFER'];
const secretName = (p) => `search_key:${p}`;

function list({ settings, secrets }) {
  const prefer = String((settings.read().search || {}).prefer || '');
  return {
    prefer: PROVIDERS.includes(prefer) ? prefer : '',
    keys: Object.fromEntries(PROVIDERS.map((p) => [p, secrets.status(secretName(p))])),
    keychain: secrets.available(),
  };
}

// patch: { brave?, tavily?, prefer? } · key 三态同凭据: undefined/'' = 不动 · null = 删 · 串 = 换
function save({ settings, secrets }, patch = {}) {
  for (const p of PROVIDERS) {
    const v = patch[p];
    if (v === null) secrets.set(secretName(p), '');
    else if (typeof v === 'string' && v.trim()) {
      const r = secrets.set(secretName(p), v.trim());
      if (!r.ok) return r;
    }
  }
  if (patch.prefer !== undefined) {
    const prefer = PROVIDERS.includes(patch.prefer) ? patch.prefer : '';
    settings.write({ search: { ...(settings.read().search || {}), prefer } });
  }
  return { ok: true };
}

// 每次建流现拼: 先清后设, 不继承机器上本来就有的同名变量(同 env.js 对 ANTHROPIC_* 的处理)。
// 勾了优先但那把 key 没存 → 不算优先, 照常服务端优先。
function applyEnv(env) {
  for (const k of ENV_KEYS) delete env[k];
  try {
    const { settings, secrets } = require('./host');
    for (const p of PROVIDERS) {
      const v = secrets.get(secretName(p));
      if (v) env[ENV_KEY[p]] = v;
    }
    const prefer = String((settings.read().search || {}).prefer || '');
    if (ENV_KEY[prefer] && env[ENV_KEY[prefer]]) env.BUTLER_SEARCH_PREFER = prefer;
  } catch (_) { /* 宿主没注入 settings/secrets(测试进程、行业版): 不给 key, 走服务端优先 */ }
  return env;
}

function register({ ipcMain, settings, secrets }) {
  ipcMain.handle('list-search-keys', async () => list({ settings, secrets }));
  ipcMain.handle('save-search-keys', async (_e, patch) => save({ settings, secrets }, patch || {}));
}

module.exports = { PROVIDERS, ENV_KEYS, list, save, applyEnv, register };
