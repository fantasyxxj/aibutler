// test-i18n-fallback.js — 守「挑语言只有一份实现, 且兜底不是日语」。
//
// 为什么要这道门禁: 这段逻辑曾经被各自抄了十几遍(core / 两版 renderer / 插件 / biz 前端),
// 兜底各写各的。于是「挑不到当前语言不许落日语」这条改了一处, 另外十几处照旧 ——
// 扫一轮改几处, 下次再长出新的。靠人记得是不行的, 所以让门禁记。
'use strict';

const fs = require('fs');
const path = require('path');
const { pickLang } = require('../core/i18n-pick.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };

const ROOT = path.join(__dirname, '..');
const SCAN = ['core', 'personal', 'industry/app', 'industry/plugins', 'industry/biz/frontend', 'industry/tools', 'industry/test'];
const SKIP_DIR = new Set(['node_modules', 'dist', '.next', '.data', '.git', 'out', 'build']);
const EXT = new Set(['.js', '.ts', '.tsx', '.mjs', '.cjs']);

// 本文件自己要写出这些模式当样例, 只好豁免。
const ALLOW = new Set([path.join('personal', 'test-i18n-fallback.js')]);

// 「兜底落日语」的写法: `.ja ||` / `|| 'ja'` / `["ja"] ||`
const BAD = /\.ja\s*\|\||\|\|\s*['"]ja['"]|\[\s*['"]ja['"]\s*\]\s*\|\|/;

function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(full, out); continue; }
    if (EXT.has(path.extname(e.name))) out.push(full);
  }
  return out;
}

console.log('\n[1] 全仓不许再出现「兜底落日语」的写法');
const hits = [];
for (const base of SCAN) {
  for (const f of walk(path.join(ROOT, base), [])) {
    const rel = path.relative(ROOT, f);
    if (ALLOW.has(rel)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((ln, i) => { if (BAD.test(ln)) hits.push(`${rel}:${i + 1}  ${ln.trim().slice(0, 90)}`); });
  }
}
ok(hits.length === 0, hits.length ? `这些地方还在兜底落日语:\n      ${hits.join('\n      ')}` : '一处都没有');

console.log('\n[2] 权威实现的兜底顺序: 当前语言 → 简繁近邻 → 英语 → 第一个');
const four = { ja: 'JA', 'zh-CN': 'CN', 'zh-TW': 'TW', en: 'EN' };
ok(pickLang(four, 'zh-CN') === 'CN', '有当前语言就用当前语言');
ok(pickLang({ ja: 'JA', 'zh-TW': 'TW', en: 'EN' }, 'zh-CN') === 'TW', '简体缺了先找繁体, 不落日语');
ok(pickLang({ ja: 'JA', 'zh-CN': 'CN', en: 'EN' }, 'zh-TW') === 'CN', '繁体缺了先找简体');
ok(pickLang({ ja: 'JA', en: 'EN' }, 'zh-CN') === 'EN', '🔴 中文全缺 → 落英语, 不是日语');
ok(pickLang({ ja: 'JA', en: 'EN' }, 'ko') === 'EN', '🔴 完全不认识的语言 → 落英语');
ok(pickLang({ ja: 'JA' }, 'zh-CN') === 'JA', '只有日语一种时才拿日语(那是唯一有的值)');
ok(pickLang('单语字符串', 'ja') === '单语字符串', '字符串原样过');
ok(pickLang(null, 'ja') === '' && pickLang(undefined, 'en') === '', '空值给空串, 不炸');

console.log(`\n${fail ? '❌' : '✅'} test-i18n-fallback: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
