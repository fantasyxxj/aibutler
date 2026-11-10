// 模型下拉选项 —— "当前这条接入方式下, 真正能选哪些模型"。
// 单开文件因 main.js 撞行数闸。
//
// 清单一律现拉, config/models/list.json 的 options 只是拉不到时的兜底:
//   · 订阅   → 拿登录态 token 问官方 /v1/models
//   · 自带 key / 网关 → 问那个端点自己的 /v1/models (2026-08-15 实测 newapi 46 个模型里只有
//     1 个 claude-* 名, 所以官方那几个名字在网关上一个都打不通, 必须现拉)
// 这样官方发新模型当天就能选上, 不用为了一行型号重新打包。
const path = require('path');
const fs = require('fs');

// 登录态凭证原文 → { accessToken, expiresAt, ... }。macOS 在 keychain, 其余平台在 ~/.claude/.credentials.json。
function readClaudeCreds() {
  try {
    let raw = null;
    if (process.platform === 'darwin') {
      const { spawnSync } = require('child_process');
      const r = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf-8', timeout: 5000 });
      if (r.status === 0) raw = r.stdout;
    } else {
      const p = path.join(require('os').homedir(), '.claude', '.credentials.json');
      if (fs.existsSync(p)) raw = fs.readFileSync(p, 'utf-8');
    }
    if (!raw) return null;
    const j = JSON.parse(raw);
    return j.claudeAiOauth || j;
  } catch (e) { console.log(`[auth] 读凭证失败: ${e && e.message}`); return null; }
}

// 订阅态拿什么去问官方端点。setup-token 签发的长效 token 优先, 否则用登录态的 accessToken。
function subscriptionToken() {
  return process.env.CLAUDE_CODE_OAUTH_TOKEN || (readClaudeCreds() || {}).accessToken || null;
}

// 端点认哪些模型 —— 官方和第三方网关都实现 GET /v1/models。
// 🔴 bearerOnly 是订阅态**必须**给的: 官方端点两个头都在时只认 x-api-key, 拿 oauth token
//    当 api key 校验直接 401(实测)。网关那边反过来多数只认 Bearer, 所以默认两个都带。
async function modelsFromEndpoint(a, { bearerOnly = false } = {}) {
  const key = a.key;   // 启动快照里那把; 换了新 key 也得重开人格才拉新清单
  if (!key) return null;
  const base = (a.base_url || 'https://api.anthropic.com').replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' };
  if (!bearerOnly) headers['x-api-key'] = key;
  // OpenAI 兼容端点的地址自带版本段(…/compatible-mode/v1 · …/api/v3 · …/v1beta/openai), 清单在 /models;
  // 再拼 /v1/models 就成了 /v1/v1/models, 千问这类一律 404, 下拉只剩手填(11-07 修)
  const compat = /\/v\d+[a-z]*(\/openai)?$/.test(base);
  const res = await fetch(compat ? `${base}/models` : `${base}/v1/models?limit=1000`, { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) { console.error(`[models] ${base}/v1/models → ${res.status}`); return null; }
  const j = await res.json();
  const rows = Array.isArray(j.data) ? j.data : (Array.isArray(j) ? j : []);
  return rows.map((m) => ({ id: m.id, label: m.display_name && m.display_name !== m.id ? `${m.display_name} (${m.id})` : m.id }))
    .filter((o) => o.id);
}

// 🔴 现拉到的和手写的**不许重叠**(2026-08-18 作者: "订阅来的就是订阅的选项, api 来的就是 api 的选项")。
// keep 是手写清单里现拉替代不了的那几条(「跟随默认」这种 UI 构件, 订阅态还含 opus/sonnet/haiku 别名
// —— 它们是 Claude Code 的别名不是 API 型号, /v1/models 里没有)。
function mergeOptions(keep, live) {
  const seen = new Set();
  return [...keep, ...live].filter((o) => {
    if (o.id === 'default') return false;   // SDK 的别名, 跟我们 id='' 的「跟随默认」是同一件事
    if (seen.has(o.id)) return false;
    seen.add(o.id);
    return true;
  });
}

// 🔴 连**清单从哪来的**一起返回。只给一串选项的话, "下拉里只有几个"有两种截然不同的成因
//    (端点就这几个 / 压根没拉到回落了内置名单), 用户和我都只能靠猜 —— 让界面自己说出来。
// access = accessConfig(...) 的结果: null 表示订阅, 否则是 { key, base_url }。
async function listModelOptions({ builtin = [], access = null } = {}) {
  const widget = builtin.filter((o) => !o.id);                       // 「跟随默认」
  const alias = builtin.filter((o) => o.id && !/^claude-/.test(o.id));   // opus / sonnet / haiku 别名

  if (!access) {
    const tok = subscriptionToken();
    let live = null;
    if (tok) {
      try { live = await modelsFromEndpoint({ key: tok }, { bearerOnly: true }); }
      catch (e) { console.error('[models] 订阅现拉失败:', e && e.message); }
    }
    // 没登录 / 拉不到 → 退回手写清单原样(官方名在官方端点上本来就是对的, 不算误导)。
    if (!live || !live.length) return { options: builtin, source: 'builtin', from: 'SDK' };
    const options = mergeOptions([...widget, ...alias], live);
    console.log(`[models] 订阅现拉 ${live.length} 个, 下拉共 ${options.length} 条`);
    return { options, source: 'live', from: 'api.anthropic.com' };
  }

  // 非 Anthropic 协议的厂家(千问 · 豆包 · OpenAI …): 人格模型名要带协议前缀(compat/… openai/…), 引擎靠它选通道。
  // 清单里直接给带前缀的 id, 用户从下拉里选的就是能跑的那个; 显示仍是原名(11-07: 原先选了裸名会走错协议)。
  // 地址空着的 OpenAI 官方 key 也得去 OpenAI 拉, 不能拿它去问 api.anthropic.com。
  const { vendorFor, personaModel } = require('./model-tier');
  const v = vendorFor(require('./model-table').load(), access);
  const foreign = !!(v && v.protocol && v.protocol !== 'anthropic');
  const listAccess = foreign && !access.base_url ? { ...access, base_url: v.list_base || v.base_url } : access;
  const from = (listAccess.base_url || 'https://api.anthropic.com').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  let live = null;
  try { live = await modelsFromEndpoint(listAccess); }
  catch (e) { console.error('[models] 现拉失败:', e && e.message); }

  // API/网关拉不到 → 只剩「跟随默认」和手输口子。拿官方名去充数, 在网关上一个都打不通, 是误导。
  if (!live || !live.length) return { options: widget, source: 'fallback', from };
  // 认得出的厂家按出厂表 exclude 剔掉不能聊天的(图像 · 视频 · 向量 · 语音 …), 跟按档挑型号同一份名单
  if (v && Array.isArray(v.exclude) && v.exclude.length) {
    const ex = v.exclude.map((r) => new RegExp(r, 'i'));
    live = live.filter((o) => !ex.some((r) => r.test(o.id)));
  }
  if (foreign) live = live.map((o) => ({ ...o, id: personaModel(v.protocol, o.id) }));
  const options = mergeOptions(widget, live);
  console.log(`[models] ${from} 给了 ${live.length} 个, 下拉共 ${options.length} 条`);
  return { options, source: 'live', from };
}

module.exports = { readClaudeCreds, subscriptionToken, modelsFromEndpoint, listModelOptions };
