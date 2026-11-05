// scripts/mem-v2-enword-test.js — 英文按词匹配 / 中文按子串匹配
//
// 锁的是【事实】不是写法: "can 不该命中 cancel"、"中文子串必须照旧命中"。
// 内部换实现(正则/词干表/缓存)不该让这些断言变红 —— 换了还红, 说明真的改坏了。
const path = require('path');
const os = require('os');
const fs = require('fs');
const { enStem, isEnWord, stemSet } = require(path.join(__dirname, '..', 'core', 'memory'));
const { MemoryGraphV2 } = require(path.join(__dirname, '..', 'core', 'memory-v2'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };

console.log('\n== 词干归一 ==');
for (const [a, b] of [['cancel', 'cancelled'], ['cancel', 'cancellation'], ['book', 'booking'],
                      ['book', 'books'], ['policy', 'policies'], ['run', 'running'],
                      ['open', 'opened'], ['note', 'notes']]) {
  ok(enStem(a) === enStem(b), `${a} 与 ${b} 归到同一词干 (${enStem(a)})`);
}

console.log('\n== 削过头的必须不削 ==');
// thing→th · notes→not 这类会把不同的词并到一起, 比不削更糟。
for (const [a, b] of [['can', 'cancel'], ['art', 'start'], ['not', 'notes'], ['th', 'thing']]) {
  ok(enStem(a) !== enStem(b), `${a} 与 ${b} 不并到一起`);
}

console.log('\n== 词边界 ==');
const s = stemSet('reference_biz_cancel_policy');
ok(!s.has(enStem('can')), 'can 不命中 cancel_policy(下划线也算词边界)');
ok(s.has(enStem('cancel')), 'cancel 命中');
ok(s.has(enStem('policies')), 'policies 命中 policy(两侧都归一)');
ok(!stemSet('what_you_do start here').has(enStem('art')), 'art 不命中 start');

console.log('\n== 语言判定 ==');
ok(!isEnWord('预约'), '中文不当英文词');
ok(!isEnWord('予約'), '日文不当英文词');
ok(!isEnWord('ab'), '两字母太短不当词(避免把缩写噪音拉进来)');
ok(isEnWord('cancel'), '英文词认出来');

console.log('\n== 端到端: 中文子串照旧, 英文不再伪命中 ==');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enword-'));
const g = new MemoryGraphV2(dir);
g.upsert({ slug: 'reference_cancel_policy', title: 'Cancellation policy',
           claim: 'Guests may cancel a booking up to 24 hours before arrival.',
           keywords: 'cancel booking refund', type: 'reference' });
g.upsert({ slug: 'reference_yuyue_guanli', title: '预约管理',
           claim: '预约管理页面可以改期和取消。', keywords: '预约 改期', type: 'reference' });

const hitSlugs = (q) => g.query(q, { minTier: 'low', semantic: false }).map((r) => r.slug);
ok(hitSlugs('cancel').includes('reference_cancel_policy'), 'cancel 查得到');
ok(hitSlugs('cancelled').includes('reference_cancel_policy'), 'cancelled 查得到(词干归一)');
ok(!hitSlugs('can').includes('reference_cancel_policy'), '🔴 can 查不到 cancel —— 词边界生效');
ok(hitSlugs('预约').includes('reference_yuyue_guanli'), '🔴 中文子串照旧: 预约 命中 预约管理');
ok(hitSlugs('管理').includes('reference_yuyue_guanli'), '中文子串照旧: 管理 命中 预约管理');

console.log('\n== IDF 与命中判定必须用同一把尺 ==');
// 从前 df 统计走裸 includes 而命中判定也走裸 includes, 两边一起错所以看不出来。
// 只修命中不修 df, 英文把握度照样上不来 —— 这条断言就是钉住"两边同尺"。
const enHit = g.query('cancel', { minTier: 'low', semantic: false })
  .find((r) => r.slug === 'reference_cancel_policy');
ok(enHit && enHit.confidence > 0.15,
   `英文单词查询的把握度要过闭嘴线 (实际 ${enHit ? enHit.confidence.toFixed(3) : 'n/a'})`);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
