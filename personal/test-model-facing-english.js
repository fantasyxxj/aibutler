// test-model-facing-english.js — 喂给模型的字符串必须是英文单份。
//
// 病根 (2026-09-26 作者):「都说了英文兜底的, 你这改一次忘一次, 不是中文就是日文。」
// 当天实地抓到: 体检提示的模板按 renderL 分了四语, 填进 {{summary}} 的那行 label 却是
// 中文硬编码(`2 对记忆疑似互相打架`)。于是英文界面的店里, 助手收到「一段英文 + 一行中文」,
// 而那行中文恰好是它这一轮要处理的事 —— 回话语言整个被带跑。
//
// 🔴 为什么非要一道门禁: config/ 那一层早就干净了(逐份扫过, 只有引用日文原文、语音标签
//    示例这类合理用法), 会漏的从来是**代码里硬编码的注入字符串** —— 它们不在 config 目录,
//    没有 renderL/textL 经手, 谁也不会去翻。漏了也不报错, 只是某一天某家店的助手换了种语言说话。
//
// 判据只有一条: **受众定语言** —— 喂模型的一律英文单份; 给用户看的走 cfg.renderL 四语。
// 所以这里扫的是前者, 不碰后者。
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };

const CJK = /[一-鿿぀-ゟ゠-ヿ]/;

// 注释里的中文是这个仓库的常态(整个 core 的注释都是中文), 扫之前必须先剥掉,
// 否则满屏误报, 而一个天天误报的门禁等于没有。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')          // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');     // 行注释(避开 http:// 这类)
}

// 被扫的模式: 组装成 findings/label 递给人格的那些字面量。
// 只收模板串与引号串, 变量插值原样留着 —— 插的是数字, 不影响语言判定。
const LABEL_RE = /label:\s*(`[^`]*`|'[^']*'|"[^"]*")/g;

function scanLabels(file) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const hits = [];
  let m;
  while ((m = LABEL_RE.exec(src))) {
    const lit = m[1];
    if (CJK.test(lit)) hits.push(lit.slice(0, 60));
  }
  return hits;
}

console.log('[喂给模型的 label 必须英文]');
for (const rel of ['core/checkup-gate.js', 'core/idle-watcher.js']) {
  const hits = scanLabels(path.join(ROOT, rel));
  ok(hits.length === 0, `${rel} 的 label 无中日文${hits.length ? ' —— 命中: ' + hits.join(' | ') : ''}`);
}

// 体检那条通路是整件事的起因, 单独钉死: summary 是把 findings 的 label 拼起来的,
// 任何一条带中文, 整份提示就混了语言。
console.log('\n[体检 summary 这条通路]');
{
  const gate = require('../core/checkup-gate');
  const report = {
    pinned: 30, quota: 20,
    problems: [
      { kind: '节点过大(拆分候选)', count: 9 },
      { kind: '缺命题', count: 12 },
      { kind: '缺归类', count: 11 },
      { kind: '悬空边', count: 3 },
      { kind: '召回失败率过半' },
    ],
    isolated: 40,
    review_due: [1, 2, 3, 4],
  };
  const findings = gate.checkupFindings(report, {});
  ok(findings.length >= 5, `阈值全部超标时报满 (${findings.length} 项)`);
  const dirty = findings.filter((f) => CJK.test(f.label));
  ok(dirty.length === 0,
    `每一条 label 都是英文${dirty.length ? ' —— 命中: ' + dirty.map((f) => f.key).join(', ') : ''}`);
  // doctor 的 problems.kind 是中文(那是库内部的分类名, 不出现在提示里), 这里顺带确认
  // label 没有把 kind 原样抄进去 —— 抄了就等于把中文引回提示。
  ok(!findings.some((f) => f.label.includes('节点过大')),
    'label 没有把 doctor 的中文 kind 原样抄进去');
}

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
