// test-persona-skeleton.js — 9.4 persona.md 只留五类
// 骨架是新生儿每一轮都要重读的东西, 所以它装什么 = 每个新人格的常驻底价。
// 运行: node test-persona-skeleton.js
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const os = require('os');
const path = require('path');
const persona = require('../core/persona');

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { if (ok) { pass++; console.log(`  ✅ ${name}${extra ? ' · ' + extra : ''}`); } else { fail++; console.error(`  ❌ ${name}${extra ? ' · ' + extra : ''}`); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-skel-'));
const memDir = path.join(tmp, '.claude/memory');
fs.mkdirSync(memDir, { recursive: true });
const p = persona.ensurePersonaFile(tmp, memDir, '试新生儿', '起床了试新生儿');
const md = fs.readFileSync(p, 'utf8');

console.log('\n=== T1: 六类齐全, 一类不少 ===');
for (const [k, needle] of [
  ['我是谁', '1 · Who I am'],
  ['我这行的硬规矩', '2 · The rules of my domain'],
  ['我能干什么', '3 · What I can do'],
  ['其余的怎么拿', '4 · How to get everything else'],
  ['出事了怎么办', '5 · What to do when things go wrong'],
  ['我此刻在哪', '6 · Where I am right now'],
]) t(k, md.includes(needle));

// 🔴 领域规则那一节必须**开箱是空的** + 带判据。它是人格常驻里唯一会长大的地方,
// 预填内容等于替人格决定它这行有什么规矩, 不写判据它就会把什么都往里堆。
t('领域规则开箱是空的', md.includes('(none yet)'));
t('领域规则带判据(只收治第一轮的)', /before\*{0,2} I start deciding/.test(md) && md.includes('memory graph'));

console.log('\n=== T2: 渲染干净 ===');
const stray = md.match(/\{\{\w+\}\}/g) || [];
t('没有未替换的占位符', stray.length === 0, stray.join(','));
t('名字渲染进去了', md.includes('I am 试新生儿'));
t('记忆库路径渲染进去了', md.includes(memDir));
t('唤醒语渲染进去了', md.includes('起床了试新生儿'));
t('唤醒语缺省有兜底', (() => {
  const d2 = path.join(tmp, 'b/.claude/memory');
  fs.mkdirSync(d2, { recursive: true });
  return fs.readFileSync(persona.ensurePersonaFile(path.join(tmp, 'b'), d2, 'X'), 'utf8').includes('(默认)');
})());

console.log('\n=== T3: 不点名任何工具(9.1 之后能力目录是唯一真源) ===');
// 老骨架硬编码着 memory_upsert/memory_hot/... 且写在 persona.js 里 ——
// test-tool-catalog 只扫 config/**/*.md, 正好扫不到它, 工具一改名新生儿就学到一个不存在的工具。
const named = md.match(/\bmemory_[a-z_]+|\bsend_[a-z_]+|\btalk_peer\b|\bcompact_context\b/g) || [];
t('骨架里一个工具名都没有', named.length === 0, named.join(','));
t('改成指向生成的工具目录', md.includes('tool registry'));

console.log('\n=== T4: 骨架住在 config 里(才进得了工具名闸门) ===');
t('config/main/persona_skeleton.md 在', fs.existsSync(path.join(__dirname, '../core/config/main/persona_skeleton.md')));
const src = require('./kernel-src').readSrc('persona.js');
t('persona.js 里不再有骨架正文', !src.includes('# 我是 ${name}'));

console.log('\n=== T5: 已存在不覆盖 ===');
fs.writeFileSync(p, '我自己改过的');
t('二次调用不动用户改过的档案', fs.readFileSync(persona.ensurePersonaFile(tmp, memDir, '试新生儿'), 'utf8') === '我自己改过的');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail ? '❌' : '✅'} ${pass} 绿 ${fail} 红`);
process.exit(fail ? 1 : 0);
