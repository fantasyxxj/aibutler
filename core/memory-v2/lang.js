// 记忆引擎的语言机制单点: 四语常量 · 译文解析 · 检索变体 · 显示挑选。
//
// 为什么是【四】语不是三语: 2026-08-29 空库实测, 繁体字面查询打不中简体库 —— 同一条节点
// 简体「记忆 检索」命中 31.1, 繁体「記憶 檢索」0 命中。字面检索没有简繁折叠, zh-CN 和
// zh-TW 必须各存一份。(细节 [[reference_traditional_query_misses_simplified_memory]])
//
// 🔴 这一份同时服务两件事, 所以放在引擎里而不是各写各的:
//   ① 出厂记忆多语化 —— 检索时逐语言打分取最高, 显示时挑一份;
//   ② 引擎报错文案 —— 做不到多语覆盖而用户又可能看到的文本一律吐英文
//      ([[feedback_fallback_to_english_not_chinese_when_multilang_uncovered]])。
//   两件事共用的是同一条回落链: 想要的 → 简繁互替 → 英文 → 源语言。

// 权威清单与行业版后端 app/i18n_fields.py 的 KNOWN_LANGS 对齐。顺序无意义, 判存在用。
const LANGS = ['zh-CN', 'zh-TW', 'ja', 'en'];

// 出厂知识包是简体中文写的。节点自带的 title/claim/keywords 就是这一语, 不进 translations。
const SOURCE_LANG = 'zh-CN';

// 简繁互为兜底: 查不到想要的那一份时, 另一种中文远好过英文 —— 汉字大部分能读懂。
const ZH_SIBLING = { 'zh-CN': 'zh-TW', 'zh-TW': 'zh-CN' };

// translations 里每语存这三个字段。**没有 body** —— 正文译文在 body_i18n 冷列, 见 schema 注释。
const TR_FIELDS = ['title', 'claim', 'keywords'];

// 显示语言。'' = 跟着源语言走(个人版中文用户的默认), 由宿主在启动时 setLang 注入。
// 🔴 它只影响【显示挑哪一份】, 不影响检索 —— 检索永远全语言打分取最高, 所以这个值设错
// 的代价只是看到另一种语言的文案, 不会变成查不到。这正是不必判断查询语言的原因。
let _lang = '';

function normalizeLang(raw) {
  const s = String(raw || '').trim().replace('_', '-');
  if (!s) return '';
  const low = s.toLowerCase();
  if (low.startsWith('ja')) return 'ja';
  if (low.startsWith('en')) return 'en';
  if (low.startsWith('zh')) {
    // zh-Hant / zh-TW / zh-HK / zh-MO 都是繁体; 其余(zh / zh-Hans / zh-CN / zh-SG)按简体。
    if (/hant|tw|hk|mo/.test(low)) return 'zh-TW';
    return 'zh-CN';
  }
  return '';
}

function setLang(raw) { _lang = normalizeLang(raw); }
function getLang() { return _lang; }

// 回落链: 想要的 → 简繁互替 → 英文 → 源语言。
// 英文排在源语言(简体中文)前面是刻意的 —— 卖到日本的行业版, 店主读得懂英文的概率
// 远高于中文。想要的就是源语言时链子第一格就命中, 不受影响。
// 🔴 不传 want 时读【当前显示语言】, 不是直接回落源语言。差一个字的后果是报错文案永远吐中文:
// msg() 就是不带参数调它的, 而 setLang('ja') 之后本该走到英文那一格。
function fallbackChain(want) {
  const w = normalizeLang(want === undefined ? _lang : want) || SOURCE_LANG;
  const chain = [w];
  if (ZH_SIBLING[w]) chain.push(ZH_SIBLING[w]);
  chain.push('en');
  chain.push(SOURCE_LANG);
  return chain.filter((x, i) => chain.indexOf(x) === i);
}

// JSON.parse 按【原字符串】缓存, 不挂在节点对象上 —— _fresh() 返回的是共享对象,
// 往上挂属性会脏掉所有后续检索(codemap 里明写的坑)。
const _parsed = new Map();
const PARSE_CACHE_MAX = 4000;
function parseJson(s) {
  if (!s || typeof s !== 'string') return null;
  if (_parsed.has(s)) return _parsed.get(s);
  let v = null;
  // 坏 JSON 当没有译文, 不抛 —— 一条译文写坏不该让整张图查不动。
  try { const o = JSON.parse(s); if (o && typeof o === 'object') v = o; } catch (_) { v = null; }
  if (_parsed.size >= PARSE_CACHE_MAX) _parsed.clear();
  _parsed.set(s, v);
  return v;
}

// 节点上挂了哪几语的译文。返回 {lang: {title, claim, keywords}}, 没有就空对象。
function translationsOf(node) {
  const o = parseJson(node && node.translations);
  if (!o) return {};
  const out = {};
  for (const k of Object.keys(o)) {
    const code = normalizeLang(k);
    if (!code || code === SOURCE_LANG) continue;   // 源语言不重复存, 存了也以节点本体为准
    const v = o[k];
    if (!v || typeof v !== 'object') continue;
    out[code] = v;
  }
  return out;
}

// 检索用: 这个节点有几份可打分的文本。第一份永远是源语言(节点本体)。
// 🔴 返回的对象只含参与打分的字段, 不含 slug —— slug 是全语言共用的, 由调用方拼进高价层。
function variantsOf(node) {
  const base = { lang: SOURCE_LANG };
  for (const f of TR_FIELDS) base[f] = node[f] || '';
  const tr = translationsOf(node);
  const langs = Object.keys(tr);
  if (!langs.length) return [base];
  const out = [base];
  for (const code of langs) {
    const v = { lang: code };
    // 某一语只翻了一半时, 缺的字段回落到源语言 —— 半份译文仍然比没有强。
    for (const f of TR_FIELDS) v[f] = tr[code][f] || node[f] || '';
    out.push(v);
  }
  return out;
}

// 显示用: 按当前显示语言挑一份 title/claim/keywords。
// want 显式传入时以它为准(工具面可以按调用方要求单条覆盖), 否则用全局 _lang。
function pick(node, want) {
  const tr = translationsOf(node);
  const src = { lang: SOURCE_LANG };
  for (const f of TR_FIELDS) src[f] = node[f] || '';
  for (const code of fallbackChain(want === undefined ? _lang : want)) {
    if (code === SOURCE_LANG) return src;
    const v = tr[code];
    if (!v) continue;
    const out = { lang: code };
    let any = false;
    for (const f of TR_FIELDS) {
      if (v[f]) { out[f] = v[f]; any = true; } else { out[f] = node[f] || ''; }
    }
    if (any) return out;
  }
  return src;
}

// 正文译文。node 要带 body_i18n(冷列, NODE_COLS 里没有) —— 只有真展开正文的那条路才拿得到,
// 拿不到就回落 body 本体。
function pickBody(node, want) {
  const o = parseJson(node && node.body_i18n);
  if (o) {
    for (const code of fallbackChain(want === undefined ? _lang : want)) {
      if (code === SOURCE_LANG) break;
      const v = o[code] || o[code.toLowerCase()];
      if (v && typeof v === 'string') return v;
    }
  }
  return node && node.body ? node.body : '';
}

// 各语言的自称。给模型看的语言策略要指名道姓("用日本語回答"), 说"用界面语言"它不知道是哪个。
const LANG_NAMES = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文', ja: '日本語', en: 'English' };
function langName(want) {
  return LANG_NAMES[normalizeLang(want === undefined ? _lang : want) || SOURCE_LANG];
}

// 通用取值: 传字符串原样返回, 传 {ja, en, 'zh-CN', 'zh-TW'} 就按回落链挑一份。
// 🔴 放在这里而不是各家自己写一个: chip 的 label、界面文案、记忆译文回落的规则必须是同一条,
// 否则同一个界面上一半按日文回落、一半按中文回落, 而且没有任何报错。
function localize(value, want) {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  for (const code of fallbackChain(want)) if (value[code]) return String(value[code]);
  const first = Object.keys(value)[0];
  return first ? String(value[first]) : '';
}

module.exports = {
  LANGS, SOURCE_LANG, TR_FIELDS, ZH_SIBLING, LANG_NAMES, langName, localize,
  normalizeLang, setLang, getLang, fallbackChain,
  translationsOf, variantsOf, pick, pickBody,
};
