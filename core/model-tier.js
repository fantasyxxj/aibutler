// model-tier.js — 按档选模型: 用户选「最强 / 强 / 日常 / 省钱」, 我们在他这把 key 能看到的清单里
// 找那一档能用的具体型号。
//
// 规矩(作者 2026-11-07):
//   · 厂家表 config/models/vendors.json 只写官方**家族名**, 不写版本号 —— 同档命中多个时按名字里的
//     版本号从大到小排, 新版本出来自动排到最前, 不用改表。乱起名的网关不管: 一个都匹配不上就用清单第一个。
//   · 名字对上不等于有货(上游没额度时 /models 照列、messages 回 500), 所以**每个候选都真发一条**,
//     第一个通的才用, 最多试 maxProbe 个。
//   · 整档都不通就如实返回失败和原因, **不悄悄换档** —— 换不换档、花多少钱, 由用户自己定。
'use strict';

const PREVIEW_RE = /(preview|exp|beta|alpha|test)/i;

function rx(s) { return new RegExp(s, 'i'); }

// 名字里的数字串 → 版本向量。同档里按它从大到小排, 预览版排在正式版之后。
// 日期快照(qwen-plus-2025-12-01 · claude-haiku-4-5-20251001)里的日期不是版本号: 先摘出来, 只当最后一位比,
// 否则 2025 会压过 3.7, 新一代反而排到老快照后面(11-07 千问真 key 实撞)。
function versionKey(id) {
  const str = String(id);
  const date = str.match(/20\d{2}-?\d{2}-?\d{2}|\d{6,8}/);   // 2025-12-01 · 20251001 · 260915
  const base = date ? str.replace(date[0], '') : str;
  const nums = (base.match(/\d+/g) || []).map(Number);
  return [...nums, -1, date ? Number(date[0].replace(/-/g, '')) : 0];
}
function byNewest(a, b) {
  const pa = PREVIEW_RE.test(a), pb = PREVIEW_RE.test(b);
  if (pa !== pb) return pa ? 1 : -1;
  const va = versionKey(a), vb = versionKey(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] || 0) - (va[i] || 0);
    if (d) return d;
  }
  return a.length - b.length;
}

// 清单 → 这一档的候选, 按优先序。families 是正则串数组(先列的家族优先), exclude 命中的整个剔掉。
function candidatesForTier(ids, vendor, tier) {
  const ex = (vendor.exclude || []).map(rx);
  const usable = ids.filter((id) => id && !ex.some((r) => r.test(id)));
  const out = [];
  for (const fam of ((vendor.tiers || {})[tier] || [])) {
    const r = rx(fam);
    for (const id of usable.filter((x) => r.test(x)).sort(byNewest)) if (!out.includes(id)) out.push(id);
  }
  return { usable, matched: out };
}

// 人格模型名: 协议决定前缀(见 agent-sdk resolveModel)。Anthropic 协议是裸型号。
function personaModel(protocol, id) {
  return protocol === 'anthropic' || !protocol ? id : `${protocol}/${id}`;
}

// base_url → 厂家。凭据上记了 vendor 就直接用; 老凭据只有地址, 按 host 认。
function vendorFor(table, { vendor, base_url, key } = {}) {
  const list = (table && table.vendors) || [];
  if (vendor) { const v = list.find((x) => x.id === vendor); if (v) return v; }
  const host = (u) => { try { return new URL(u).host; } catch (_) { return ''; } };
  const h = host(base_url || '');
  // 地址空着 = 某家官方端点, 是哪家只能看 key 的长相: Claude 是 sk-ant-, Gemini 是 AIza, 其余 sk- 是 OpenAI
  if (!h) {
    const k = String(key || '');
    const id = /^sk-ant-/.test(k) || !k ? 'anthropic' : /^AIza/.test(k) ? 'gemini' : /^sk-/.test(k) ? 'openai' : 'anthropic';
    return list.find((x) => x.id === id) || null;
  }
  return list.find((x) => x.base_url && host(x.base_url) === h) || null;
}

function anthropicBase(base) {
  const u = String(base || 'https://api.anthropic.com').replace(/\/+$/, '');
  return /\/v1$/.test(u) ? u : `${u}/v1`;
}
function openaiBase(vendor, base) {
  return String(base || (vendor && (vendor.list_base || vendor.base_url)) || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

async function listIds({ protocol, vendor, base_url, key, fetchImpl = fetch }) {
  const isA = protocol === 'anthropic';
  const url = isA ? `${anthropicBase(base_url)}/models?limit=1000` : `${openaiBase(vendor, base_url)}/models`;
  const headers = { authorization: `Bearer ${key}` };
  if (isA) { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) return { ok: false, status: res.status, ids: [] };
  const j = await res.json();
  const rows = Array.isArray(j.data) ? j.data : (Array.isArray(j.models) ? j.models : (Array.isArray(j) ? j : []));
  return { ok: true, ids: rows.map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean) };
}

// 失败归类成用户看得懂的几种: 认证 · 没额度 · 没这个模型 · 上游出错 · 连不上
function reasonOf(status, text) {
  const s = String(text || '').toLowerCase();
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || /quota|insufficient|balance|余额|额度|billing|credit/.test(s)) return 'quota';
  if (status === 404 || /model.*(not|does not) exist|not found|no such model|unknown model|无可用渠道|no available channel/.test(s)) return 'no_model';
  if (status === 429) return 'rate';
  if (status >= 500) return 'upstream';
  return 'error';
}

async function probe({ protocol, vendor, base_url, key, id, fetchImpl = fetch }) {
  const isA = protocol === 'anthropic';
  const url = isA ? `${anthropicBase(base_url)}/messages` : `${openaiBase(vendor, base_url)}/chat/completions`;
  // 会话头: 有的网关没它直接 400(OpenCode Go), 与 agent-sdk 的 sessionHeaders 同口径
  const sid = `probe-${Date.now().toString(36)}`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-opencode-session': sid, 'x-session-id': sid, 'user-agent': 'butler-agent-sdk/0.1.0' };
  if (isA) { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
  const body = { model: id, messages: [{ role: 'user', content: 'hi' }] };
  if (protocol === 'openai') body.max_completion_tokens = 16; else body.max_tokens = 1;
  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (res.ok) return { id, ok: true };
    const text = await res.text().catch(() => '');
    return { id, ok: false, status: res.status, reason: reasonOf(res.status, text), detail: text.slice(0, 200) };
  } catch (e) {
    return { id, ok: false, status: 0, reason: 'network', detail: String(e && e.message || e).slice(0, 200) };
  }
}

// 主入口。access = { base_url, key, vendor? }。返回
//   { ok, model, id, tier, vendor, fallback, tried:[…], listed }  model 是写进人格的串(带协议前缀)
//   失败时 ok=false, reason ∈ list_failed | no_models | tier_unusable, tried 里有每个候选的原因
async function pickForTier({ table, access, tier, fetchImpl = fetch }) {
  const vendor = vendorFor(table, access) || { id: 'gateway', protocol: 'anthropic', tiers: (vendorFor(table, { vendor: 'anthropic' }) || {}).tiers, exclude: [] };
  const protocol = vendor.protocol || 'anthropic';
  const t = tier || (table && table.defaultTier) || 'daily';
  const max = Number(table && table.maxProbe) || 3;
  const base_url = access.base_url || vendor.base_url || '';
  const listed = await listIds({ protocol, vendor, base_url, key: access.key, fetchImpl }).catch(() => ({ ok: false, ids: [] }));
  // 清单那一跳就 401/403 = key 不对, 直接这么说; 别的失败(端点不给清单、连不上)才笼统说拉不到
  if (!listed.ok) return { ok: false, reason: listed.status === 401 || listed.status === 403 ? 'auth' : 'list_failed', status: listed.status, vendor: vendor.id, tier: t, tried: [] };
  const { usable, matched } = candidatesForTier(listed.ids, vendor, t);
  if (!usable.length) return { ok: false, reason: 'no_models', vendor: vendor.id, tier: t, tried: [] };
  const fallback = !matched.length;
  const pool = (fallback ? usable : matched).slice(0, max);
  const tried = [];
  for (const id of pool) {
    const r = await probe({ protocol, vendor, base_url, key: access.key, id, fetchImpl });
    tried.push(r);
    if (r.ok) return { ok: true, id, model: personaModel(protocol, id), tier: t, vendor: vendor.id, fallback, tried, listed: listed.ids.length };
  }
  return { ok: false, reason: 'tier_unusable', vendor: vendor.id, tier: t, fallback, tried, listed: listed.ids.length };
}

module.exports = { pickForTier, candidatesForTier, vendorFor, personaModel, byNewest, reasonOf, listIds, probe };
