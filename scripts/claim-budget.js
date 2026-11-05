// claim-budget.js — 量所有出厂/货架知识包的命题行注入预算(四语逐一量)。
//
// 超预算 = 那条知识**一个字都注入不进上下文**(不是截断), 而检索日志照样记它命中 ——
// 写完看不出任何异常。命中最狠的正是"AI 不会想到自己去查"的那类(行为约束、反直觉禁令):
// 那类只有自动召回一条通路, 走不通就等于这条知识不存在。
//
// 🔴 四语逐一量: 日文命题行是中文的 1.3-1.5 倍, 按中文量过不代表别的语言过, 而四种语言
//    都是一等公民 —— 哪种语言超, 哪种语言的用户就整条收不到。
// 🔴 不设豁免名单: 拿去比的是"能不能送出去"这条物理线, 挂免死金牌不会让它送得出去。
//
// 门禁 personal/test-onboarding.js 调它; 改货架包时也能直接跑: node scripts/claim-budget.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 随程序出厂那份。写死路径, 而且**失效了要报出来, 不许静默跳过** —— 2026-09-06 发现清单里
// 的 industry/packs/restaurant/knowledge/restaurant.json 早已随目录删除, 因为当时套了一层
// existsSync 过滤, 门禁照样全绿, 少量一个文件一直没人发现。
const SHIPPED = [
  'core/config/onboarding/knowledge/leaf_core.json',
  'core/config/onboarding/knowledge/butler_extra.json',
  'industry/platform/shelf/common/pack.common.json',
];

// 服务端货架那份(热更下发, 不随程序出厂)。走同一条 factory-sync、受同一条闸线约束。
// **扫目录而不是列清单** —— 开新行业会多出一整个 shelf/<行业>/, 列清单必漏。
const SHELF = 'industry/platform/shelf';

function shelfFiles() {
  const dir = path.join(ROOT, SHELF);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const sub of fs.readdirSync(dir)) {
    const d = path.join(dir, sub);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith('.json')) out.push(path.join(d, f));
  }
  return out;
}

// 包有三种形状: 出厂包/独立更新包 {items} · 激活包 {memory:{items}} · 裸数组。
function itemsOf(doc) {
  if (doc && doc.memory && Array.isArray(doc.memory.items)) return doc.memory.items;
  if (doc && Array.isArray(doc.items)) return doc.items;
  return Array.isArray(doc) ? doc : [];
}

/** → {limit, missing:[相对路径], over:['slug/lang(token数)'], counted:条数} */
function check() {
  const { estTokens } = require('../core/memory-v2.js');
  const tuning = require('../core/memory-v2/tuning.js');
  const limit = (tuning.tune || tuning)('recall_inject_budget');

  const shipped = SHIPPED.map((p) => path.join(ROOT, p));
  const missing = shipped.filter((p) => !fs.existsSync(p)).map((p) => path.relative(ROOT, p));

  const over = [];
  let counted = 0;
  for (const f of [...shipped, ...shelfFiles()]) {
    if (!fs.existsSync(f)) continue;
    let doc;
    try { doc = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    for (const it of itemsOf(doc)) {
      const slug = it.slug || it.id;
      if (!slug) continue;
      const claims = { 'zh-CN': it.claim };
      for (const [L, v] of Object.entries(it.translations || {})) claims[L] = v && v.claim;
      for (const [L, c] of Object.entries(claims)) {
        counted++;
        const n = estTokens(`- #999 ${slug} ${c || ''}`);
        if (n > limit) over.push(`${slug}/${L}(${n})`);
      }
    }
  }
  return { limit, missing, over, counted };
}

module.exports = { check };

if (require.main === module) {
  const r = check();
  console.log(`上限 ${r.limit} token · 量了 ${r.counted} 条命题行(四语各算一条)`);
  if (r.missing.length) console.log('❌ 清单里的文件已失效: ' + r.missing.join(' , '));
  if (r.over.length) console.log('❌ 超预算:\n  ' + r.over.join('\n  '));
  if (!r.missing.length && !r.over.length) console.log('✅ 全部在预算内');
  process.exit(r.missing.length || r.over.length ? 1 : 0);
}
