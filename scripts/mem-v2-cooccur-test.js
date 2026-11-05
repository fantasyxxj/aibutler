// mem-v2-cooccur-test.js — 5.2 共现自动建边
// 运行: node scripts/mem-v2-cooccur-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MemoryGraphV2 } = require('../core/memory-v2');

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { if (ok) { pass++; console.log(`  ✅ ${name}${extra ? ' · ' + extra : ''}`); } else { fail++; console.error(`  ❌ ${name}${extra ? ' · ' + extra : ''}`); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-v2-co-'));
const g = new MemoryGraphV2(dir);
const mk = (slug, claim) => g.upsert({ slug, title: slug, claim, body: claim, type: 'reference' }).id;
const A = mk('alpha', '甲说的那件事成立');
const B = mk('beta', '乙说的那件事成立');
const C = mk('gamma', '丙说的那件事成立');
const D = mk('delta', '丁说的那件事成立');

const co = () => g.store.allEdges().filter((e) => e.rel === 'co_used');
const pair = (x, y) => co().find((e) => (e.src === Math.min(x, y) && e.dst === Math.max(x, y)));

console.log('\n=== T1: 一起 touch 才长边 ===');
g.touch([A]);
t('单条 touch 不长边', co().length === 0);
g.touch([A, B]);
t('两条一起 touch 长出一条', co().length === 1);
t('标成 engine 长的', pair(A, B).made_by === 'engine');
t('无方向, 只存一行', co().filter((e) => (e.src === A && e.dst === B) || (e.src === B && e.dst === A)).length === 1);

console.log('\n=== T2: weight 是累计次数, 不被覆盖 ===');
t('第一次 weight=1', pair(A, B).weight === 1);
g.touch([B, A]);
t('反过来传也算同一对', co().length === 1);
t('第二次 weight=2', pair(A, B).weight === 2);

console.log('\n=== T3: 攒够 2 次才参与扩散 ===');
g.touch([C, D]);
t('C-D 已建边(weight=1)', pair(C, D).weight === 1);
const nbOnce = g.neighbors(C, { hops: 1 }).map((n) => n.slug);
t('只共用过 1 次 → 还不扩散', !nbOnce.includes('delta'), nbOnce.join(',') || '(无邻居)');
g.touch([C, D]);
const nbTwice = g.neighbors(C, { hops: 1 }).map((n) => n.slug);
t('攒到 2 次 → 扩散生效', nbTwice.includes('delta'), nbTwice.join(','));

console.log('\n=== T4: 大批 touch 算扫库, 不算一起用 ===');
const before = co().length;
const many = ['alpha', 'beta', 'gamma', 'delta'].concat([5, 6, 7].map((i) => mk('n' + i, '第' + i + '条')));
g.touch(many);
t(`${many.length} 条一起 touch 不长边`, co().length === before, `仍 ${co().length} 条`);

console.log('\n=== T5: 自动边不碰人写的边 ===');
g.link ? g.link({ from_id: 'alpha', to_id: 'beta', rel: 'relates' }) : g.addEdge(A, B, 'relates', 'human');
const humanEdge = g.store.allEdges().find((e) => e.rel === 'relates' && e.made_by === 'human');
t('人写的 relates 还在', !!humanEdge);
t('共现边没被顶掉', !!pair(A, B), `weight=${pair(A, B) && pair(A, B).weight}`);
t('两种边分得开', co().every((e) => e.made_by === 'engine'));

console.log('\n=== T6: 建边失败不挡 touch ===');
const bak = g.store.bumpCoEdge;
g.store.bumpCoEdge = () => { throw new Error('故意炸'); };
const done = g.touch([A, B]);
t('touch 照常返回', done.length === 2);
g.store.bumpCoEdge = bak;

g.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? '❌' : '✅'} ${pass} 绿 ${fail} 红`);
process.exit(fail ? 1 : 0);
