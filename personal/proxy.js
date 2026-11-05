// proxy.js — 把用户配的代理真正应用到「所有出网路径」。
//
// butler 出网有三类, 各走各的客户端, 一个都不能漏:
//   ① claude CLI 子进程(模型请求, 流量大头) —— 认 HTTP(S)_PROXY 环境变量, 靠继承 process.env
//   ② butler 自己的 fetch(bus / LINE / TG / 能力包工具) —— **Node 内建 fetch 不读任何代理环境变量**,
//      必须换成 undici 的 fetch 并挂全局 dispatcher。这是最容易漏的一类。
//   ③ node:https 的下载(whisper 引擎/模型) —— 同样不读环境变量, 见 voice-stt.js 改用 fetch。
//
// 注意 ②: npm 装的 undici 和 Node 内建 fetch 是**两个实例**, 只调 setGlobalDispatcher 不换 fetch
// 是没用的(实测内建 fetch 命中代理 0 次)。所以这里直接把 globalThis.fetch 换掉。
'use strict';

const { fetch: undiciFetch, EnvHttpProxyAgent, Agent, setGlobalDispatcher } = require('undici');

const ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];
let _fetchPatched = false;
let _current = { on: false, url: null, no_proxy: '' };

function current() { return { ..._current }; }

// current() → apply() 能吃的形状, 供"测试连接"结束后原样还原。
function _asSettings(c) {
  return { proxy: { enabled: c.on, url: c.url || '', no_proxy: c.no_proxy || '' } };
}

// 幂等: 设置面板改一次调一次。
function apply(settings) {
  const p = (settings && settings.proxy) || {};
  const url = String(p.url || '').trim();
  const on = !!(p.enabled && url);

  for (const k of ENV_KEYS) delete process.env[k];
  if (on) {
    // 大小写两套都设: 各家 CLI 认哪个的都有, 少设一个就有工具漏网。
    process.env.HTTP_PROXY = url;  process.env.http_proxy = url;
    process.env.HTTPS_PROXY = url; process.env.https_proxy = url;
    const np = String(p.no_proxy || '').trim();
    if (np) { process.env.NO_PROXY = np; process.env.no_proxy = np; }
  }

  // EnvHttpProxyAgent 在构造时读上面刚设好的环境变量, 顺带白送 NO_PROXY 白名单支持。
  setGlobalDispatcher(on ? new EnvHttpProxyAgent() : new Agent());
  if (!_fetchPatched) { globalThis.fetch = undiciFetch; _fetchPatched = true; }

  _current = { on, url: on ? url : null, no_proxy: on ? String(p.no_proxy || '').trim() : '' };
  return current();
}

// 子进程 env 白名单用: 只有开着代理才吐出这几个键。
// (bus MCP 子进程的 env 是白名单式的, 不继承 process.env 全量, 漏了这几个就不走代理)
function envForChild() {
  if (!_current.on) return {};
  const out = {};
  for (const k of ENV_KEYS) if (process.env[k]) out[k] = process.env[k];
  return out;
}

// 「测试连接」按钮: 让用户填完能当场知道通没通, 而不是等下次对话失败才发现。
// 打 Anthropic API 根路径 —— 无需凭证, 能收到任何 HTTP 状态码就说明链路通了。
async function test(settings, timeoutMs = 8000) {
  const saved = current();
  const t0 = Date.now();
  try {
    apply(settings);
    const resp = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET', signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: true, status: resp.status, ms: Date.now() - t0,
             detail: `连通 (HTTP ${resp.status}) · ${Date.now() - t0}ms` };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, detail: `连不上: ${e.message}` };
  } finally {
    // 测试用的是"待验证"的设置, 不能就这么留下 —— 恢复成测试前的状态, 由调用方决定要不要保存。
    apply(_asSettings(saved));
  }
}

module.exports = { apply, test, current, envForChild };
