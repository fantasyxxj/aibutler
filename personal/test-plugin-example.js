// 出厂例子包回归测试 —— 跑: node test-plugin-example.js
//
// 出厂知识里那份「最小可跑插件」是给人格照着抄的。抄来的东西必须真的能装、能跑,
// 所以这里不另写一套判断, 而是把正文里的 JSON 抠出来喂给**引擎自己**的校验:
// packages.js 的形状检查、commands.js 的声明白名单、sandbox.js 的文档拼装。
// 例子和引擎哪天对不上, 这道闸就红 —— 散文会悄悄过期, 能跑的例子不会。
'use strict';

require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const path = require('path');
const packages = require('../core/packages');
const commands = require('../core/commands');

// 🔴 出厂知识住在三个包里, 按 slug 找一条必须三个都搜 —— 只读 leaf_core 会在包重划之后静默报"找不到"。
const KB = path.join(__dirname, '../core/config/onboarding/knowledge');
const SLUG = 'reference_plugin_minimal_working_example';

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ' → ' + extra : ''}`); }
}

const item = ['leaf_core.json', 'personal_common.json', 'butler_extra.json'].reduce((hit, f) => {
  if (hit) return hit;
  const p = path.join(KB, f);
  if (!fs.existsSync(p)) return null;
  return (JSON.parse(fs.readFileSync(p, 'utf8')).items || []).find((x) => x.slug === SLUG) || null;
}, null);

console.log('[1] 出厂包里有这条例子');
ok(!!item, `${SLUG} 存在`);
if (!item) { console.log('\n❌ 例子条目不在出厂包里, 后面没法验'); process.exit(1); }

console.log('[2] 正文里抠得出一份 JSON');
const m = String(item.body || '').match(/```json\n([\s\S]*?)\n```/);
ok(!!m, '正文里有 ```json 代码块');
let payload = null;
if (m) {
  try { payload = JSON.parse(m[1]); ok(true, 'JSON 解析得开'); }
  catch (e) { ok(false, 'JSON 解析得开', e.message); }
}
if (!payload) { console.log('\n❌ 抠不出 payload, 后面没法验'); process.exit(1); }

console.log('[3] 过引擎自己的形状检查(packages.js)');
// checkPayload 没导出, 用同一条路: install 走的就是它。这里直接比对它认的三件事。
ok(packages.SAFE_NAME.test(String(payload.type || '')), `type 合法: ${payload.type}`);
ok(packages.SAFE_NAME.test(String(payload.id || '')), `id 合法: ${payload.id}`);
ok(!!payload.version, `version 非空: ${payload.version}`);

console.log('[4] 界面包该有的字段都在');
for (const k of ['title', 'html', 'js']) ok(payload[k] != null && payload[k] !== '', `有 ${k}`);

console.log('[5] 🔴 例子不许自己喊 ready(butlerUI 上没这个方法)');
ok(!/butlerUI\s*\.\s*ready\s*\(/.test(String(payload.js)), 'js 里没有 butlerUI.ready(');

console.log('[6] 🔴 例子不许干沙箱里干不了的事');
// 先剥注释再扫: 例子里那句「沙箱里没有 require / fetch / eval / localStorage」是有用的说明,
// 不剥的话它自己会把这道闸打红。
const code = String(payload.js).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
for (const [re, label] of [
  [/\bfetch\s*\(/, 'fetch'],
  [/XMLHttpRequest/, 'XMLHttpRequest'],
  [/\beval\s*\(/, 'eval'],
  [/\brequire\s*\(/, 'require'],
  [/localStorage/, 'localStorage'],
]) ok(!re.test(code), `js 里没有 ${label}`);

console.log('[7] 命令声明过 commands.js 的白名单');
const decls = payload.commands || {};
ok(Object.keys(decls).length > 0, '至少声明了一条命令');
for (const [name, d] of Object.entries(decls)) {
  const extra = Object.keys(d).filter((k) => !commands.PKG_DECL_FIELDS.includes(k));
  ok(extra.length === 0, `${name} 只用白名单字段`, extra.join(','));
}

console.log('[8] 🔴 例子里调命令必须写带包 id 前缀的全名');
for (const name of Object.keys(decls)) {
  const full = `${payload.id}.${name}`;
  const called = String(payload.js).includes(`'${full}'`) || String(payload.js).includes(`"${full}"`);
  const shortOnly = !called && new RegExp(`['"]${name}['"]`).test(String(payload.js));
  ok(!shortOnly, `${name} 没有被写成短名调用`, `应该写 ${full}`);
}

console.log('[9] 例子文件和出厂包里那份没走散');
const onDisk = path.join(__dirname, '..', 'examples/hello-counter/payload.json');
if (fs.existsSync(onDisk)) {
  const disk = JSON.parse(fs.readFileSync(onDisk, 'utf8'));
  ok(JSON.stringify(disk) === JSON.stringify(payload), 'examples/hello-counter/payload.json 与出厂包一致');
} else {
  ok(false, 'examples/hello-counter/payload.json 存在');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} test-plugin-example: ${pass} 过 / ${fail} 败`);
process.exit(fail === 0 ? 0 : 1);
