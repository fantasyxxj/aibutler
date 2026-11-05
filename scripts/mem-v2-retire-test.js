// mem-v2-retire-test.js — 6.7 淘汰四问
// 验的是"引擎强制提问 + AI 按客观判据答": 满仓时把清单和四问交出去, 且前两问由引擎替它答。
// 运行: node scripts/mem-v2-retire-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MemoryGraphV2, PINNED_QUOTA } = require('../core/memory-v2');

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { if (ok) { pass++; console.log(`  ✅ ${name}${extra ? ' · ' + extra : ''}`); } else { fail++; console.error(`  ❌ ${name}${extra ? ' · ' + extra : ''}`); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-v2-retire-'));
const g = new MemoryGraphV2(dir);
const mk = (slug, claim, extra = {}) =>
  g.upsert({ slug, title: slug, claim, body: claim, type: 'reference', ...extra }).id;

// 填满配额
const ids = [];
for (let i = 0; i < PINNED_QUOTA; i++) {
  const id = mk(`ref_fill_${i}`, `第 ${i} 条常查的东西成立`);
  g.setPinned(id, '填充');
  ids.push(id);
}
t(`配额已填满 ${PINNED_QUOTA}`, g.pinnedAll().length === PINNED_QUOTA);

console.log('\n=== T1: 满仓报错要带清单 + 四问, 不是一句"满了" ===');
const extra = mk('ref_late_comer', '后来的这条也想进快查');
let msg = '';
try { g.setPinned(extra, '想插队'); } catch (e) { msg = e.message; }
t('确实拦住了', !!msg);
t('带了当前清单', msg.includes('ref_fill_0'));
t('带了四问', msg.includes('场景还在吗') && msg.includes('已被代码强制了吗'));
t('点名了是哪条没写进去', msg.includes('ref_late_comer'));
t('警告别按冷热挑', msg.includes('遵守得越好'), '遵守悖论');
t('给了 demote 出路', msg.includes('demote'));

console.log('\n=== T2: 前两问由引擎客观答出来 ===');
// 第二问「已被代码强制了吗」: v2 才答得出 —— 红线走 PreToolUse 硬挡, 已挡住的不必再占快查名额
g.setRedline(ids[1], { trigger_pattern: 'Bash:\\brm\\s+-rf', correct_action: '先问一句' });
// 第一问「场景还在吗」的两路客观信号
g.upsert({ slug: 'ref_fill_2', title: 'ref_fill_2', claim: '第 2 条常查的东西成立', status: 'archived' });
g.upsert({ slug: 'ref_fill_3', title: 'ref_fill_3', claim: '第 3 条常查的东西成立', review_due: '2020-01-01' });

const audit = g.pinnedAudit();
const why = new Map(audit.candidate_reasons.map((c) => [c.slug, c.why.join('|')]));
t('红线那条被点成候选', why.has('ref_fill_1'), why.get('ref_fill_1'));
t('理由说清是代码挡着', (why.get('ref_fill_1') || '').includes('红线'));
t('已归档的被点成候选', why.has('ref_fill_2'), why.get('ref_fill_2'));
t('复核过期的被点成候选', why.has('ref_fill_3'), why.get('ref_fill_3'));
t('没信号的不乱点', !why.has('ref_fill_9'));
t('candidates 与 reasons 对得上', audit.candidates.length === audit.candidate_reasons.length);

console.log('\n=== T3: 候选理由要出现在满仓报错里(不然它还得自己再查一遍) ===');
let msg2 = '';
try { g.setPinned(extra, '再试'); } catch (e) { msg2 = e.message; }
t('清单里带了可降标注', msg2.includes('← 可降'));
t('标注挂在对的那条上', /ref_fill_1 —.*← 可降/.test(msg2));

console.log('\n=== T4: 只推荐不自动执行(冷不是淘汰理由) ===');
t('候选没被自动降级', g.pinnedAll().length === PINNED_QUOTA);
t('换人仍要显式 demote', (() => {
  g.setPinned(extra, '换人', { demote: ids[1] });
  return g.pinnedAll().length === PINNED_QUOTA && !g.pinnedAll().some((m) => m.slug === 'ref_fill_1');
})());

g.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? '❌' : '✅'} ${pass} 绿 ${fail} 红`);
process.exit(fail ? 1 : 0);
