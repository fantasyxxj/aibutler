// test-graph-slot.js — 关联位: 连在前 3 条结果上的规矩, 查到它们就看得见。
// 跑法: node personal/test-graph-slot.js
//
// 病(2026-10-11 行业版实测): 店主教的规矩连在「新建预约」那条上, 自己分数也不低,
// 却排第 17 —— 出厂知识互相连得很密, 扩散时彼此加分, 新教的规矩连线少, 分数上永远压不过。
require('./host-wiring');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MemoryGraphV2 } = require('../core/memory-v2');
const { reloadTuning, setDataDir } = require('../core/memory-v2/tuning');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-graph-slot-'));
const g = new MemoryGraphV2(dir);
let pass = 0; let fail = 0;
const ok = (c, l) => { if (c) { console.log(`  ✓ ${l}`); pass++; } else { console.log(`  ✗ ${l}`); fail++; } };

// 一团互相连着的「出厂」预约知识, 个个都撞得上查询词
const fac = ['booking_create', 'booking_list', 'booking_move', 'booking_cancel', 'booking_mail', 'booking_line', 'booking_seat', 'booking_stats'];
for (const s of fac) g.upsert({ slug: s, type: 'reference', keywords: `booking reservation guest confirm${s === 'booking_create' ? ' create new' : ''}`, claim: `${s}: booking reservation guest how-to` });
for (const a of fac) g.upsert({ slug: a, links: fac.filter((b) => b !== a) });
for (const s of fac) g.store.db.run('UPDATE nodes SET is_factory = 1 WHERE id = ?', [g.resolve(s)]);
// 店主教的一条规矩: 跟查询词几乎不沾边, 只连在 booking_create 上
g.upsert({ slug: 'rule_close_with_greeting', type: 'feedback', importance: 'high',
  keywords: 'closing phrase', claim: 'Always end guest messages with a closing phrase', links: ['booking_create'] });

const q = 'booking reservation guest confirm create new';   // booking_create 稳居第一
console.log('\n[1] 连在前 3 条上的自长规矩会被带出来');
setDataDir(dir);
reloadTuning();
let rows = g.query(q, { k: 5, minTier: 'low' });
let hit = rows.find((r) => r.slug === 'rule_close_with_greeting');
ok(!!hit, '🔴 规矩进了前 5');
ok(hit && /关联/.test(hit.via), '来路标成「图·关联」, 看得出是连线带出来的');
ok(hit && hit.tier !== 'low', '把握度至少中档, 不会被下游当低档滤掉');
ok(rows.length === 5, '补位不撑大结果条数(挤掉的是第 k 条)');
ok(rows.findIndex((r) => r.slug === 'rule_close_with_greeting') === 3, '🔴 插在第 4 位(前 3 条之后), 调用方再截短也看得见');

console.log('\n[2] graph_slots=0 关掉 → 回到原样');
fs.writeFileSync(path.join(dir, 'memory-tuning.json'), JSON.stringify({ graph_slots: 0 }));
reloadTuning();
rows = g.query(q, { k: 5, minTier: 'low' });
ok(!rows.find((r) => r.slug === 'rule_close_with_greeting'), '关掉后规矩挤不进前 5(证明是关联位在起作用)');

console.log('\n[3] 没连线的不会被硬塞');
fs.rmSync(path.join(dir, 'memory-tuning.json'), { force: true });
reloadTuning();
g.upsert({ slug: 'rule_unlinked', type: 'feedback', importance: 'high', keywords: 'other', claim: 'An unrelated rule' });
rows = g.query(q, { k: 5, minTier: 'low' });
ok(!rows.find((r) => r.slug === 'rule_unlinked'), '没连在结果上的规矩不出现');

console.log('\n[4] flat 查询不补位');
rows = g.query(q, { k: 5, minTier: 'low', flat: true });
ok(!rows.find((r) => /关联/.test(r.via)), 'hops=0(flat)时没有关联位');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? '❌' : '✅'} test-graph-slot: ${pass} 过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
