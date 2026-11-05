// handlers/translate.js — Phase 1.5 menu translation handler for the agent-bus channel.
//
// Contract with plugins/agent-bus.js:
//   translate(payload, ctx) — payload = {source_lang, target_langs, items[], correlation_id, menu_item_id}
//     items = [{key: "menu_item.<id>.name_i18n", text: "唐揚げ"}, ...]
//     Returns after ctx.send('apicall', {...}) so the bus applies the writes.
//
// The prompt encodes three cultural-trap edicts (spec §1.5 / §4.4):
//   - Loanwords already assimilated in English keep the JP form:
//     teriyaki chicken NOT chicken teriyaki style; karaage NOT deep-fried chicken.
//   - "定食" stays "定食" in zh-CN (do not translate to "套餐").
//   - Owner branding phrases ("秘伝の唐揚げ") stay in the JP original — never
//     replace them with a paraphrase.
//
// zh-TW is NOT filled here; the VPS bus fills it via OpenCC s2twp when it writes.

// 与人格会话同一个 SDK 选择(cc / own), 见 core/agent/util.js
// 用到时才取: util 加载时就要宿主注入的 paths, 顶层 require 会让只拿 buildPrompt 这些纯函数的地方(门禁)也起不来
const loadSdk = (...a) => require('../../core/agent/util').loadSdk(...a);

const CULTURAL_TRAP_RULES = [
  '1) Loanwords already in the target lexicon keep the JP form:',
  '   - EN: karaage (NOT "deep-fried chicken"), teriyaki (NOT "chicken teriyaki style"),',
  '         yakitori, sashimi, ramen, izakaya — output them romanized.',
  '   - zh-CN: 定食 stays 定食 (do NOT rewrite to 套餐); 刺身 stays 刺身; 天ぷら → 天妇罗 OK.',
  '2) Owner branding phrases (「秘伝の…」「一心特製…」「店主おまかせ…」or any',
  '   proper-noun-flavored prefix in the JP source) MUST be preserved verbatim',
  '   in EVERY target language — do not paraphrase the branding, only translate',
  '   the descriptor tail that follows it.',
  '3) When unsure, prefer transliteration over creative translation — the owner',
  '   will review every field before publishing.',
].join('\n');

function buildPrompt(sourceLang, targetLangs, items) {
  const langList = targetLangs.map((l) => `"${l}"`).join(', ');
  const itemsBlock = items.map((it, i) =>
    `  ${i + 1}. key=${it.key}\n     JP: ${JSON.stringify(it.text)}`
  ).join('\n');
  return [
    `You are translating izakaya menu items from ${sourceLang} into: ${langList}.`,
    '',
    'Cultural-trap rules — read carefully, they are non-negotiable:',
    CULTURAL_TRAP_RULES,
    '',
    'Items to translate:',
    itemsBlock,
    '',
    'Output rules:',
    `- Return ONLY valid JSON. No prose, no markdown fences, no explanation.`,
    `- Shape: {"translations": [{"key": "<the item key>", "values": {${targetLangs.map((l) => `"${l}": "..."`).join(', ')}}}, ...]}`,
    '- Preserve the key exactly as given.',
    '- Every target language MUST be filled for every item (never null / empty).',
    '- If the JP source is a menu name (…name_i18n), the output should read as a',
    '  menu NAME in the target language (short, capitalized appropriately, no',
    '  trailing period). If the source is a description (…desc_i18n), output a',
    '  full descriptive sentence.',
  ].join('\n');
}

function extractJson(text) {
  // The model was instructed to return pure JSON, but be defensive:
  // strip common wrapper cases (```json ... ```, leading prose, trailing prose).
  const t = String(text || '').trim();
  if (t.startsWith('{')) return t;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const braceStart = t.indexOf('{');
  const braceEnd = t.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) return t.slice(braceStart, braceEnd + 1);
  return t;
}

// Consume a query() async generator until the terminal 'result' message.
async function runQuery(prompt) {
  const { query } = await loadSdk();
  const q = query({ prompt, options: { permissionMode: 'bypassPermissions' } });
  for await (const m of q) {
    if (m && m.type === 'result') {
      if (m.subtype !== 'success') {
        throw new Error(`SDK query failed: ${m.subtype || 'unknown'}`);
      }
      return m.result || '';
    }
  }
  throw new Error('SDK query ended without a result message');
}

// Group translated values by target of `menu_item.<id>.name_i18n` etc. into
// {name_i18n: {...}, desc_i18n: {...}} shape the bus PUT endpoint expects.
function groupByField(itemsWithValues) {
  const out = { name_i18n: {}, desc_i18n: {} };
  for (const it of itemsWithValues) {
    const parts = String(it.key || '').split('.');
    const field = parts[parts.length - 1];  // "name_i18n" | "desc_i18n"
    if (!out[field]) out[field] = {};
    Object.assign(out[field], it.values || {});
  }
  return out;
}

async function translate(payload, ctx) {
  const { source_lang, target_langs, items, correlation_id, menu_item_id } = payload || {};
  if (!source_lang || !Array.isArray(target_langs) || !Array.isArray(items) || !items.length) {
    ctx.onLog(`[translate] ⚠ invalid payload; correlation_id=${correlation_id}`);
    throw new Error('invalid translate payload');
  }
  if (!menu_item_id) {
    ctx.onLog(`[translate] ⚠ payload missing menu_item_id; correlation_id=${correlation_id}`);
    throw new Error('menu_item_id required');
  }

  const prompt = buildPrompt(source_lang, target_langs, items);
  const started = Date.now();
  const raw = await runQuery(prompt);
  const jsonText = extractJson(raw);
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    ctx.onLog(`[translate] ⚠ JSON parse failed; head="${jsonText.slice(0, 120)}" corr=${correlation_id}`);
    throw new Error(`translation JSON parse: ${e.message}`);
  }
  const translationsList = Array.isArray(parsed.translations) ? parsed.translations : [];
  if (!translationsList.length) throw new Error('empty translations array from model');

  const grouped = groupByField(translationsList);
  const elapsedMs = Date.now() - started;
  ctx.onLog(`[translate] ✓ corr=${correlation_id} menu_item=${menu_item_id} elapsed=${elapsedMs}ms`);

  const apicall = {
    method: 'PUT',
    path: `/bus/v1/admin/menu/${menu_item_id}/translations`,
    body: grouped,
  };
  const r = await ctx.send('apicall', apicall, correlation_id);
  if (!r.ok) {
    ctx.onLog(`[translate] ⚠ /exec failed: ${r.error}; corr=${correlation_id}`);
    throw new Error(`bus /exec failed: ${r.error}`);
  }
  return { replied: true, elapsed_ms: elapsedMs };
}

module.exports = { translate, buildPrompt, extractJson, groupByField };
