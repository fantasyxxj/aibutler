// test-config-override.js — 提示语外置的门禁。
// 守两件事:
//   ① config-loader 的覆盖层真的分层(用户目录 > 出厂), 且能热读 —— 这是"改提示语不用打包"的地基。
//   ② 引导类文案没有滑回硬编码 —— 这才是真正会退化的地方: 下次谁图省事直接写字符串, 就又要打包了。
// 🔴 隔离: 覆盖根走 BUTLER_DATA_DIR 指到临时目录, 绝不碰真数据。
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-cfgov-'));
process.env.BUTLER_DATA_DIR = TMP;

const cfg = require('./config-loader');
const OV = cfg.overrideRoot();
if (!OV || !OV.startsWith(TMP)) {
  console.error('❌ 隔离失败: 覆盖根不在临时目录', OV, '— 中止, 不跑测试');
  process.exit(1);
}

let pass = 0; let fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name); }
}

console.log('— 覆盖层分层 —');
const KEY = 'main/memory_dedupe_gate';
ok(!cfg.whichFile(KEY).overridden, '没放覆盖时走出厂默认');
ok(cfg.text(KEY).length > 0, '出厂文案读得到');

fs.mkdirSync(path.join(OV, 'main'), { recursive: true });
fs.writeFileSync(path.join(OV, 'main', 'memory_dedupe_gate.md'), '覆盖版 top={{top}}');
cfg._clearCache();
ok(cfg.whichFile(KEY).overridden, '放了覆盖后改走覆盖版');
ok(cfg.render(KEY, { top: 7 }) === '覆盖版 top=7', '覆盖版占位符照样填');

fs.unlinkSync(path.join(OV, 'main', 'memory_dedupe_gate.md'));
cfg._clearCache();
ok(!cfg.whichFile(KEY).overridden, '删掉覆盖后回落出厂默认');

console.log('— 挡门文案的内容契约 —');
const gate = cfg.render(KEY, { top: 250, gate: 200, slug: 'x', candidates: 'c' });
ok(!gate.includes('【推荐】'), '不预设推荐路径(【推荐】会把天平压向"往老节点加段")');
ok(/truth value/.test(gate), '先要求判命题真假, 而不是直接叫人选放哪一段');
ok(gate.includes('confirm_new'), '保留"确是新命题就新建"这条出路');
ok(gate.includes('{{') === false, '占位符全部填完, 没有漏网的 {{}}');

console.log('— 没滑回硬编码 —');
const src = require('./kernel-src').readSrc('memory-tools-v2.js');
// 取法变了(改从 core/host 拿宿主注入的加载器), 但要守的东西没变: 文案必须来自配置层, 不许硬编码。
ok(/require\(['"]\.\/host['"]\)/.test(src), 'memory-tools-v2.js 从 core 的注入面取配置层');
ok(/cfg\.(render|text|json)\(/.test(src), 'memory-tools-v2.js 真的在用配置层取文案');
ok(!src.includes('【推荐】'), 'memory-tools-v2.js 里没有硬编码的【推荐】');
ok(!src.includes('请三选一'), '挡门三选一不在代码里');
ok(src.includes("cfg.render('main/memory_dedupe_gate'"), '挡门走 cfg.render');

const QO = cfg.json('main/memory_query_output');
for (const k of ['empty', 'no_solid', 'suspects_head', 'suspects_tail', 'weak_head', 'weak_tail']) {
  ok(typeof QO[k] === 'string' && QO[k].length > 0, `memory_query_output 有 ${k}`);
}

// 🔴 textL 的 en 那一格认【裸 .md】—— config/ 的约定是"单份文案就是裸 .md, 且它是英文",
// 没有 `<key>.en.md` 这种文件。不认这个约定的后果(2026-09-26 实地): 链是 ['en','zh-CN'],
// en 那格找 `checkup_nudge.en.md` 找不到就往下走, 于是**英文界面拿到中文文案**。
console.log('— textL 按语言取件 —');
{
  const lang = require('../core/memory-v2/lang');
  const before = lang.getLang();
  const KEY_L = 'main/checkup_nudge';
  const HEAD = {
    en: /^\(System · /,
    ja: /^\(システム · /,
    'zh-TW': /^\(系統 · /,
    'zh-CN': /^\(系统 · /,
  };
  for (const [code, re] of Object.entries(HEAD)) {
    lang.setLang(code);
    cfg._clearCache();
    const first = cfg.textL(KEY_L).split('\n').find((l) => l.trim()) || '';
    ok(re.test(first), `${code} 拿到自己那一份 —— ${first.slice(0, 32)}`);
  }
  lang.setLang(before);
  cfg._clearCache();
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
