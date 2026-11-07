// test-model-tier.js — 按档选模型(core/model-tier.js + core/config/models/vendors.json)。
// 不联网: 端点用假 fetch 回清单和试通结果。
'use strict';
const path = require('path');
const mt = require('../core/model-tier');
const table = require(path.join(__dirname, '../core/config/models/vendors.json'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const V = (id) => table.vendors.find((v) => v.id === id);

// ── 匹配: 家族名 + 版本排序 + 排除 ──
{
  const ids = ['claude-sonnet-4-6', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-1', 'claude-mythos-1'];
  const daily = mt.candidatesForTier(ids, V('anthropic'), 'daily').matched;
  ok(daily[0] === 'claude-sonnet-5-5', `Claude 日常档取最新 sonnet: ${daily.join(',')}`);
  ok(!mt.candidatesForTier(ids, V('anthropic'), 'top').matched.some((x) => /mythos/.test(x)), 'mythos 被排除');
}
{
  const ids = ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-image', 'gemini-3.1-pro-preview', 'gemini-embedding-2'];
  const g = V('gemini');
  ok(JSON.stringify(mt.candidatesForTier(ids, g, 'daily').matched) === '["gemini-3.8-flash"]', 'Gemini 日常档 flash 不吃 flash-lite / flash-image');
  ok(mt.candidatesForTier(ids, g, 'cheap').matched[0] === 'gemini-3.1-flash-lite', 'Gemini 省钱档是 flash-lite');
}
{
  const ids = ['qwen-plus', 'qwen3.7-plus', 'qwen-vl-plus', 'qwen-max', 'qwen3.8-max', 'qwen-flash', 'text-embedding-v4'];
  const q = V('qwen');
  ok(mt.candidatesForTier(ids, q, 'daily').matched[0] === 'qwen3.7-plus', '千问日常档取 qwen3.7-plus, 不要 qwen-vl-plus');
  ok(mt.candidatesForTier(ids, q, 'top').matched[0] === 'qwen3.8-max', '千问最强档取 qwen3.8-max');
  const snap = mt.candidatesForTier(['qwen-plus-2025-12-01', 'qwen3.7-plus', 'qwen-plus'], q, 'daily').matched;
  ok(snap[0] === 'qwen3.7-plus', `日期快照的年份不当大版本号: ${snap.join(',')}`);
}
{
  ok(mt.byNewest('model-2-preview', 'model-1') > 0, '预览版排在正式版后面');
  ok(mt.personaModel('compat', 'qwen-plus') === 'compat/qwen-plus' && mt.personaModel('anthropic', 'claude-x') === 'claude-x', '人格模型名按协议加前缀');
  ok(mt.vendorFor(table, { base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' }).id === 'qwen-intl', '老凭据按地址认出厂家');
  ok(mt.vendorFor(table, { base_url: '' }).id === 'anthropic', '空地址 = Claude 官方');
  ok(mt.vendorFor(table, { base_url: '', key: 'sk-proj-abc' }).id === 'openai' && mt.vendorFor(table, { base_url: '', key: 'sk-ant-x' }).id === 'anthropic' && mt.vendorFor(table, { base_url: '', key: 'AIzaX' }).id === 'gemini', '空地址按 key 长相认官方厂家');
  ok(mt.vendorFor(table, { base_url: 'http://wucur.com:6543' }) === null, '不认识的网关返回 null');
}

// ── 主入口: 清单 → 真试 → 第一个通的 ──
function fakeFetch(models, okSet, status = 500) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (!init.method) return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), { status: 200 });
    const id = JSON.parse(init.body).model;
    return okSet.has(id) ? new Response('{}', { status: 200 }) : new Response('{"error":{"message":"upstream empty response"}}', { status });
  };
  fn.calls = calls;
  return fn;
}

(async () => {
  {
    const f = fakeFetch(['qwen-max', 'qwen3.7-plus', 'qwen-plus'], new Set(['qwen-plus']));
    const r = await mt.pickForTier({ table, access: { base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', key: 'k' }, tier: 'daily', fetchImpl: f });
    ok(r.ok && r.model === 'compat/qwen-plus', `第一个不通就试下一个: ${r.model} (试了 ${r.tried.map((x) => x.id).join(',')})`);
    ok(f.calls[0].url === 'https://dashscope.aliyuncs.com/compatible-mode/v1/models', `OpenAI 兼容端点清单拼成 /models 不拼 /v1/models: ${f.calls[0].url}`);
    ok(f.calls[1].url.endsWith('/compatible-mode/v1/chat/completions'), '试通走 chat/completions');
  }
  {
    const f = fakeFetch(['claude-sonnet-5-5', 'claude-haiku-4-5'], new Set());
    const r = await mt.pickForTier({ table, access: { base_url: 'http://wucur.com:6543', key: 'k' }, tier: 'daily', fetchImpl: f });
    ok(!r.ok && r.reason === 'tier_unusable' && r.tried[0].reason === 'upstream', `整档不通不换档, 如实报原因: ${r.reason}/${r.tried.map((x) => x.reason)}`);
    ok(f.calls[0].url.startsWith('http://wucur.com:6543/v1/models') && f.calls[1].url === 'http://wucur.com:6543/v1/messages', '不认识的网关按 Anthropic 协议拉清单和试通');
  }
  {
    const f = fakeFetch(['weird-model-a', 'weird-model-b'], new Set(['weird-model-a']));
    const r = await mt.pickForTier({ table, access: { base_url: 'http://gw.test', key: 'k' }, tier: 'daily', fetchImpl: f });
    ok(r.ok && r.fallback && r.id === 'weird-model-a', '一个都匹配不上就用清单第一个, 标 fallback');
  }
  {
    const f = fakeFetch(['claude-opus-5-5'], new Set(['claude-opus-5-5']));
    const r = await mt.pickForTier({ table, access: { base_url: '', key: 'k' }, tier: 'strong', fetchImpl: f });
    ok(r.ok && r.model === 'claude-opus-5-5' && f.calls[0].url === 'https://api.anthropic.com/v1/models?limit=1000', 'Claude 官方: 裸型号 + 官方清单地址');
  }
  ok(mt.reasonOf(401, '') === 'auth' && mt.reasonOf(402, '') === 'quota' && mt.reasonOf(503, '无可用渠道') === 'no_model', '失败原因归类');

  console.log(`\n${fail ? '❌' : '✅'} test-model-tier: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
