// test-memory-section-guard.js — memory_section session 级判重(2026-09-04 硬闸)
//
// 只测判重逻辑, 不起 electron/agent —— 用手写的 mock agent 直接调 sectionWithGuard, 断言:
//   ① 首次 section 返完整 body + hash
//   ② 同 session 再次 section 同 id → 返精简回执 + 同一 hash, 不含 body
//   ③ force=true → 忽略判重, 返完整 body
//   ④ sessionExpanded.clear() 后 → 又能返完整 body (模拟 clear/compact 边界)
//   ⑤ agent=null 时不走判重, 每次都返 body (纯函数调用姿势保留)

'use strict';

const { sectionWithGuard } = require('../core/memory-session-guard');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log('  ✓', label); pass++; }
  else { console.log('  ✗', label); fail++; }
}

const BODY = 'a'.repeat(120);
const wholeBody = (_node) => ({ slug: 'ref_x', content: BODY, hash: 'h1', lang: null });
const agent = { sessionExpanded: new Map() };

console.log('\n[① 首次调 → 完整 body + hash]');
const r1 = sectionWithGuard(agent, wholeBody, 'ref_x', false);
const txt1 = r1.content[0].text;
ok(txt1.includes(BODY), 'body 出现在返回值');
ok(txt1.includes('base_hash: h1'), 'hash 出现');
ok(!txt1.includes('already opened'), '不是重复回执');

console.log('\n[② 同 session 再次调 → 精简回执 + 同 hash, 不含 body]');
const r2 = sectionWithGuard(agent, wholeBody, 'ref_x', false);
const txt2 = r2.content[0].text;
ok(txt2.includes('already opened'), '有重复回执');
ok(txt2.includes('base_hash: h1'), '同 hash 仍在');
ok(!txt2.includes(BODY), 'body 未重发(核心断言)');

console.log('\n[③ force=true → 忽略判重返完整 body]');
const r3 = sectionWithGuard(agent, wholeBody, 'ref_x', true);
const txt3 = r3.content[0].text;
ok(txt3.includes(BODY), 'force=true 时 body 再次出现');
ok(!txt3.includes('already opened'), 'force=true 时不走重复回执');

console.log('\n[④ sessionExpanded.clear() 后 → 又能返完整 body (compact 边界)]');
agent.sessionExpanded.clear();
const r4 = sectionWithGuard(agent, wholeBody, 'ref_x', false);
ok(r4.content[0].text.includes(BODY), 'clear 后首次调重发 body (新会话应能重看)');

console.log('\n[⑤ agent=null → 每次都返 body (纯函数调用姿势, 无判重)]');
const r5a = sectionWithGuard(null, wholeBody, 'ref_x', false);
const r5b = sectionWithGuard(null, wholeBody, 'ref_x', false);
ok(r5a.content[0].text.includes(BODY) && r5b.content[0].text.includes(BODY), '两次都完整');

// 10-11 行业版 G2: 召回只给 slug, 自长规矩正文为空 → 展开后只见 "(x body is empty)", 规矩一个字没到眼前;
// 提示一次列三个 slug, 工具只收一个 → 模型传 ids 校验失败、直接放弃。
console.log('\n[⑥ 命题行永远印出来 · 正文为空也一样]');
const nodes = {
  rule_a: { slug: 'rule_a', claim: '数や日付は入力欄とボタンで聞く', content: '', hash: 'ha' },
  rule_b: { slug: 'rule_b', claim: 'お店の設定を直したらシステムも直す', content: BODY, hash: 'hb' },
};
const wb = (n) => { if (!nodes[n]) throw new Error(`node not found: ${n}`); return nodes[n]; };
const t6 = sectionWithGuard(null, wb, 'rule_a', false).content[0].text;
ok(t6.includes('数や日付は入力欄とボタンで聞く'), '正文为空时命题行照样给出');
ok(/claim above is the whole node/.test(t6), '明说命题行就是全部');
ok(sectionWithGuard(null, wb, 'rule_b', false).content[0].text.includes('お店の設定を直したらシステムも直す'), '有正文时命题行也在');

console.log('\n[⑦ 空格分隔一次展开多个 · 坏的那个不拖垮其余]');
const t7 = sectionWithGuard(null, wb, 'rule_a rule_b nope', false).content[0].text;
ok(t7.includes('入力欄') && t7.includes('システムも直す'), '两条都展开了');
ok(/nope: node not found/.test(t7), '找不到的那个单独报错');
ok(/Pass `node`/.test(sectionWithGuard(null, wb, '', false).content[0].text), '什么都没传 → 告诉它该传什么');

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
