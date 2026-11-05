// test-degradation-prompt.js — 9.3 降级路径常驻性
// 不变量: 空记忆库 / 无人格档 的裸实例, system prompt 里也必须有降级路径。
// 它一旦变成"按需从记忆里取", 就会在最需要它的那一刻(检索坏了)恰好取不到。
// 运行: node test-degradation-prompt.js
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Butler } = require('../core/agent');

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { if (ok) { pass++; console.log(`  ✅ ${name}${extra ? ' · ' + extra : ''}`); } else { fail++; console.error(`  ❌ ${name}${extra ? ' · ' + extra : ''}`); } };

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-degrade-'));
const butler = new Butler(tmpHome, { name: '测试飞飞' });
const sp = butler.appendSystemPrompt();

console.log('\n=== T1: 裸实例也带降级路径 ===');
t('有标题段', sp.includes('When things break'));
t('① 零命中 ≠ 不存在', sp.includes('I did not find it') && sp.includes('flaw in retrieval'));
t('② 不静默绕过', sp.includes('Never route around it silently'));
t('③ 该问还是该猜', sp.includes('Ask or guess'));
t('④ 说实话', sp.includes('tell the truth'));

console.log('\n=== T2: 位置 —— 紧跟记忆引擎, 在插话之前 ===');
const iMem = sp.indexOf('Your graph memory engine');
const iDeg = sp.indexOf('When things break');
const iInt = sp.indexOf('Interjections / interruptions');
t('记忆引擎 → 降级路径 → 插话', iMem > 0 && iDeg > iMem && iInt > iDeg, `${iMem}/${iDeg}/${iInt}`);

console.log('\n=== T3: 内容外置 · 改文件即改行为 ===');
const p = path.join(__dirname, '../core/config/prompts/degradation.md');
t('config/prompts/degradation.md 存在', fs.existsSync(p));
t('正文即 config 原文', sp.includes(fs.readFileSync(p, 'utf8').trim()));

console.log(`\n${fail ? '❌' : '✅'} ${pass} 绿 ${fail} 红`);
process.exit(fail ? 1 : 0);
