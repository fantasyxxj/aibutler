// test-persona-hotreload.js — persona.md 改了当轮就生效, 不用重启 butler
//
// 治的病: persona.md 原先只在人格构造那一刻读一次, 之后系统提示一直用 this.personaText 的快照。
// 而人格自己就会改自己这份档案 —— 改完不重启就不生效, 它看到的自己和文件里的自己是两个人。
//
// 只借 mixin 的方法来测: _refreshPersona 只用到 homeDir/memoryDir/personaText/name 四个字段,
// 没必要为它起一整个 Butler(那会连带 MemoryGraph、迁移、SDK)。
const fs = require('fs');
const os = require('os');
const path = require('path');
const SystemPromptMixin = require('../core/agent/system-prompt');

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { if (ok) { pass++; console.log(`  ✅ ${name}${extra ? ' · ' + extra : ''}`); } else { fail++; console.error(`  ❌ ${name}${extra ? ' · ' + extra : ''}`); } };

const refresh = SystemPromptMixin.prototype._refreshPersona;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-hot-'));
const mem = path.join(home, '.claude', 'memory');
fs.mkdirSync(mem, { recursive: true });
const file = path.join(mem, 'persona.md');

// 写文件并把 mtime 推到将来: 同一毫秒内连写两次, mtime 可能一模一样
let clock = Date.now();
const write = (txt) => {
  fs.writeFileSync(file, txt, 'utf8');
  clock += 2000;
  fs.utimesSync(file, new Date(clock), new Date(clock));
};

const quietLog = console.log;
const mk = (text) => ({ homeDir: home, memoryDir: mem, name: '测试人格', personaText: text });

console.log('\n=== T1: 改了就重读 ===');
write('# 我是甲');
const b = mk('# 我是甲');
console.log = () => {};   // 重读会打一行日志, 测试里掐掉
refresh.call(b);
console.log = quietLog;
t('没改动 → 内容不变', b.personaText === '# 我是甲');

write('# 我是甲\n新增: 每次都要先查记忆');
console.log = () => {};
refresh.call(b);
console.log = quietLog;
t('文件改了 → 当场读到新内容', b.personaText.includes('每次都要先查记忆'));

console.log('\n=== T2: 绝不把身份弄丢 ===');
// 编辑器保存的瞬间文件可能是空的; 撞上那一瞬不该让人格变回"通用助手"
const before = b.personaText;
write('');
console.log = () => {};
refresh.call(b);
console.log = quietLog;
t('文件被清空 → 保留上一版身份', b.personaText === before);

write('   \n\n  ');
console.log = () => {};
refresh.call(b);
console.log = quietLog;
t('文件只剩空白 → 保留上一版身份', b.personaText === before);

fs.rmSync(file, { force: true });
console.log = () => {};
refresh.call(b);
console.log = quietLog;
t('文件被删 → 保留上一版身份', b.personaText === before);

console.log('\n=== T3: 人格目录那份也认(记忆目录没有时) ===');
const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-hot2-'));
const mem2 = path.join(home2, '.claude', 'memory');
fs.mkdirSync(mem2, { recursive: true });
const file2 = path.join(home2, 'persona.md');
fs.writeFileSync(file2, '# 兜底位置的身份', 'utf8');
const b2 = { homeDir: home2, memoryDir: mem2, name: '测试人格2', personaText: null };
console.log = () => {};
refresh.call(b2);
console.log = quietLog;
t('记忆目录没有 → 读人格目录那份', b2.personaText === '# 兜底位置的身份');

console.log('\n=== T4: 两处都没有 → 不炸 ===');
const home3 = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-hot3-'));
const b3 = { homeDir: home3, memoryDir: path.join(home3, 'nope'), name: '测试人格3', personaText: null };
let threw = false;
try { refresh.call(b3); } catch (e) { threw = true; }
t('没有 persona.md 也不抛异常', !threw);
t('保持 null(调用方走默认身份)', b3.personaText === null);

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(home2, { recursive: true, force: true });
fs.rmSync(home3, { recursive: true, force: true });
console.log(`\n${fail ? '❌' : '✅'} ${pass} 绿 ${fail} 红`);
process.exit(fail ? 1 : 0);
