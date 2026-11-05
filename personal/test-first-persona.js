// test-first-persona.js — 开机开谁 · 没人格时**不兜底创建**。
//
// 治的病(作者 2026-09-20 报): 干净机器上还没接 AI, 启动链照样兜底造一个"管家"出来, 然后
// 让它去上一堂要调模型的出生教育 —— 建了个不会说话的助手, 而且目录已经默默定死, 想换想迁
// 都不行。现在一个都不兜底, 交给空状态屏让用户先接 AI、顺手挑目录, 点了才建。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const firstPersona = require('./first-persona');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { console.log('  ✓', name); pass++; } else { console.log('  ✗', name); fail++; } };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'firstpersona-'));
const SELF = path.join(ROOT, 'personas', 'butler-self');

// —— 最小替身: 只实现 planStartup 真正用到的那几个方法 ——
function fakeRegistry(personas = []) {
  const calls = { ensureEntry: [], ensureButler: [], setCapabilitySeen: [] };
  return {
    calls,
    list: () => personas,
    ensureEntry(dir, opts) { calls.ensureEntry.push([dir, opts]); return { id: 'x', homeDir: dir, name: (opts && opts.name) || 'x' }; },
    ensureButler(dir) { calls.ensureButler.push(dir); return { id: 'b', homeDir: dir, name: '管家', wakePhrase: '起床' }; },
    setCapabilitySeen(id, v) { calls.setCapabilitySeen.push([id, v]); },
  };
}
const fakePaths = { butlerSelfHome: () => SELF };
function fakePersona() {
  const calls = { ensureMemory: [], ensurePersonaFile: [] };
  return {
    calls,
    resolveMemoryDir: (home) => path.join(home, '.claude', 'memory'),
    ensureMemory(dir, name) { calls.ensureMemory.push([dir, name]); fs.mkdirSync(dir, { recursive: true }); },
    ensurePersonaFile(home, dir, name) { calls.ensurePersonaFile.push([home, dir, name]); },
  };
}

console.log('\n[没有任何人格 → 一个都不建]');
{
  const reg = fakeRegistry([]);
  const per = fakePersona();
  const r = firstPersona.planStartup({ tabDirs: [], registry: reg, paths: fakePaths, persona: per, appVersion: '9.9.9' });
  t('toOpen 是空的(渲染层据此显示空状态屏)', Array.isArray(r.toOpen) && r.toOpen.length === 0);
  t('没有 entry', r.entry === null);
  t('🔴 没有凭空登记一个人格', reg.calls.ensureEntry.length === 0 && reg.calls.ensureButler.length === 0);
  t('🔴 没有写 persona.md / MEMORY.md', per.calls.ensureMemory.length === 0 && per.calls.ensurePersonaFile.length === 0);
  t('newborn=false(没人出生, 就不该有人上课)', r.newborn === false);
}

console.log('\n[上次开着标签 → 照开]');
{
  const a = path.join(ROOT, 'p-a');
  fs.mkdirSync(path.join(a, '.claude', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(a, '.claude', 'memory', 'persona.md'), '# 甲', 'utf8');
  const reg = fakeRegistry([]);
  const per = fakePersona();
  const r = firstPersona.planStartup({ tabDirs: [a], registry: reg, paths: fakePaths, persona: per, appVersion: '9.9.9' });
  t('原样开上次那些', r.toOpen.length === 1 && r.toOpen[0] === a);
  t('住过人 → 不算新生儿', r.newborn === false);
  t('不算新生儿就不打补课戳', reg.calls.setCapabilitySeen.length === 0);
}

console.log('\n[标签状态丢了但登记簿还在 → 开管家那个]');
{
  const other = path.join(ROOT, 'p-other');
  const reg = fakeRegistry([{ id: 'o', homeDir: other }, { id: 's', homeDir: SELF }]);
  const per = fakePersona();
  const r = firstPersona.planStartup({ tabDirs: [], registry: reg, paths: fakePaths, persona: per, appVersion: '9.9.9' });
  t('挑的是管家那个, 不是列表第一个', r.toOpen.length === 1 && r.toOpen[0] === SELF);
  t('默认那个给名字"管家"而非目录名', reg.calls.ensureEntry.some(([d, o]) => d === SELF && o && o.name === '管家'));
}

console.log('\n[目录空着 → 才铺新生儿脚手架]');
{
  const reg = fakeRegistry([{ id: 's', homeDir: SELF }]);
  const per = fakePersona();
  const r = firstPersona.planStartup({ tabDirs: [], registry: reg, paths: fakePaths, persona: per, appVersion: '9.9.9' });
  t('是新生儿', r.newborn === true);
  t('写了 MEMORY.md 骨架', per.calls.ensureMemory.length === 1);
  t('写了 persona.md 骨架', per.calls.ensurePersonaFile.length === 1);
  t('打了补课戳(免得出生完立刻被补一遍刚学的)', reg.calls.setCapabilitySeen.length === 1
    && reg.calls.setCapabilitySeen[0][1] === '9.9.9');
}

console.log('\n[looksInhabited · 接管已有目录的判据]');
{
  const d = path.join(ROOT, 'mem-probe');
  fs.mkdirSync(d, { recursive: true });
  t('空目录 → 没住人', firstPersona.looksInhabited(d) === false);
  fs.writeFileSync(path.join(d, 'MEMORY.md'), 'x', 'utf8');
  t('只有 MEMORY.md 也算住了人', firstPersona.looksInhabited(d) === true);
  t('目录不存在 → 没住人, 且不抛', firstPersona.looksInhabited(path.join(ROOT, 'nope')) === false);

  // 🔴 两个 md 是会被自动补写的骨架, 真身是这两样: 只剩它们的目录被判空 = 出生礼物覆盖掉已有记忆库
  const db = path.join(ROOT, 'mem-db-only');
  fs.mkdirSync(db, { recursive: true });
  fs.writeFileSync(path.join(db, 'memory.v2.db'), 'x', 'utf8');
  t('🔴 只有 memory.v2.db 也算住了人', firstPersona.looksInhabited(db) === true);

  const sess = path.join(ROOT, 'mem-session-only');
  fs.mkdirSync(sess, { recursive: true });
  fs.writeFileSync(path.join(sess, '.session.json'), '{}', 'utf8');
  t('🔴 只有 .session.json 也算住了人', firstPersona.looksInhabited(sess) === true);
}

console.log('\n[birth · 没会话就别硬来]');
{
  let gifted = 0;
  firstPersona.birth({ session: null, entry: { homeDir: SELF }, memDir: SELF, gift: () => { gifted++; }, onboard: () => {} });
  t('没有会话 → 一件事都不做(不抛)', gifted === 0);
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${fail ? '❌' : '✅'} test-first-persona: ${pass} 过 / ${fail} 败\n`);
process.exit(fail ? 1 : 0);
