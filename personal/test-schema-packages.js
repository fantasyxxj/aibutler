// test-schema-packages.js — 行业库表结构包(type: 'schema')的回归测试。
//
// 盯死四件容易出事的:
//   ① 形状校验 —— 尤其「加了 migration 却忘了抬 schema_version」, 不拦的话那一版
//      永远不会被跑, 且没有任何报错
//   ② 只跑版本区间内的那几段, 且幂等 —— 重复装不重复跑
//   ③ 一段里有 SQL 炸了要整段回滚, 版本号停在上一段(半截的表结构比没有更难收拾)
//   ④ 装完之后, 插件走 runOp 读得到这些表, 但改不了它们的结构
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const schemaPackages = require('../core/schema-packages');
const dbFactory = require('../core/db');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-schema-'));
fs.mkdirSync(path.join(root, 'industry-db'), { recursive: true });
fs.mkdirSync(path.join(root, 'plugin-db'), { recursive: true });
const dataDir = root;
const apply = (p) => schemaPackages.applyPackage(p, { dataDir });
const db = () => dbFactory.create({ controlDir: () => dataDir, dataDir: () => dataDir });

const V1 = { v: 1, sql: ['CREATE TABLE customer (id INTEGER PRIMARY KEY, name TEXT)'] };
const V2 = { v: 2, sql: ['ALTER TABLE customer ADD COLUMN lang TEXT',
                         'CREATE TABLE customer_contact (id INTEGER PRIMARY KEY,'
                         + ' customer_id INTEGER NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL)'] };
const V3 = { v: 3, sql: ['CREATE INDEX ix_contact_value ON customer_contact (kind, value)'] };
const pack = (sv, ms) => ({ type: 'schema', id: 'restaurant', version: '1.0.0',
                            schema_version: sv, migrations: ms });

console.log('\n[1] 形状校验');
const bad = [
  ['type 不对', { type: 'ui', id: 'x', schema_version: 1, migrations: [V1] }],
  ['缺 id', { type: 'schema', schema_version: 1, migrations: [V1] }],
  ['schema_version 不是正整数', pack('3', [V1])],
  ['migrations 空', pack(1, [])],
  ['v 重复', { ...pack(2, [V1, { v: 1, sql: ['SELECT 1'] }]), schema_version: 1 }],
  ['sql 不是数组', pack(1, [{ v: 1, sql: 'CREATE TABLE t (i INT)' }])],
  ['sql 里有空串', pack(1, [{ v: 1, sql: ['CREATE TABLE t (i INT)', '  '] }])],
  ['加了 migration 却忘了抬 schema_version', pack(2, [V1, V2, V3])],
];
for (const [name, p] of bad) {
  const msg = schemaPackages.checkPayload(p);
  ok(`拒绝: ${name}`, !!msg, `checkPayload 放行了`);
}
ok('正常包通过校验', schemaPackages.checkPayload(pack(3, [V1, V2, V3])) === null,
   schemaPackages.checkPayload(pack(3, [V1, V2, V3])));

console.log('\n[2] 首次装: 空库跑完全部');
let r = apply(pack(3, [V1, V2, V3]));
ok('装上了', r.ok, JSON.stringify(r));
ok('从 v0 到 v3, 跑了 3 段', r.from === 0 && r.to === 3 && r.applied === 3, JSON.stringify(r));
let c = db().openIndustry('restaurant');
ok('_schema_version 记着 3', schemaPackages.currentVersion(c.db) === 3);
const tables = c.db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .map((x) => x.name);
ok('customer / customer_contact 都建出来了',
   tables.includes('customer') && tables.includes('customer_contact'), tables.join(','));
ok('v2 的加列生效',
   c.db.all('PRAGMA table_info(customer)').some((x) => x.name === 'lang'));

console.log('\n[3] 幂等: 同一个包再装一次不重复跑');
r = apply(pack(3, [V1, V2, V3]));
ok('一段都没跑', r.ok && r.applied === 0 && r.from === 3 && r.to === 3, JSON.stringify(r));

console.log('\n[4] 升级: 只跑新增的那一段');
const V4 = { v: 4, sql: ["ALTER TABLE customer ADD COLUMN notes TEXT DEFAULT ''"] };
r = apply(pack(4, [V1, V2, V3, V4]));
ok('只跑了 1 段', r.ok && r.from === 3 && r.to === 4 && r.applied === 1, JSON.stringify(r));
c = db().openIndustry('restaurant');
ok('notes 列出来了', c.db.all('PRAGMA table_info(customer)').some((x) => x.name === 'notes'));

console.log('\n[5] 一段里炸了 → 整段回滚, 版本停在上一段');
const V5BAD = { v: 5, sql: ["ALTER TABLE customer ADD COLUMN ok_col TEXT",
                            'CREATE TABLE customer (dup INT)'] };   // 第二条必炸(表已存在)
r = apply(pack(5, [V1, V2, V3, V4, V5BAD]));
ok('报了失败', !r.ok && r.code === 'migrate_failed', JSON.stringify(r));
ok('错误信息说清停在哪一版', /停在 v=4/.test(r.message || ''), r.message);
c = db().openIndustry('restaurant');
ok('版本号仍是 4', schemaPackages.currentVersion(c.db) === 4);
ok('那段里先成功的那条也被回滚了',
   !c.db.all('PRAGMA table_info(customer)').some((x) => x.name === 'ok_col'));

console.log('\n[6] 降版(包比库旧) → 什么都不做, 不报错');
r = apply(pack(2, [V1, V2]));
ok('不动库', r.ok && r.applied === 0 && r.to === 4, JSON.stringify(r));

console.log('\n[7] 装完之后, 插件能读写但改不了结构');
fs.writeFileSync(path.join(root, 'plugin-db', 'ui.booking.json'),
  JSON.stringify({ driver: 'sqlite', file: path.join(root, 'industry-db', 'restaurant.sqlite') }));
const conn = db();
r = conn.runOp('ui.booking', 'run', 'INSERT INTO customer (name, lang) VALUES (?, ?)', ['田中', 'ja']);
ok('插件能写入 migration 建的表', r.ok && r.lastInsertId >= 1, JSON.stringify(r));
r = conn.runOp('ui.booking', 'query', 'SELECT name, lang FROM customer', []);
ok('插件能读回来', r.ok && r.rows[0].name === '田中', JSON.stringify(r));
r = conn.runOp('ui.booking', 'run', 'ALTER TABLE customer ADD COLUMN sneaky TEXT', []);
ok('插件改不了表结构', !r.ok && r.code === 'ddl_forbidden', JSON.stringify(r));

console.log('\n[8] loadFromPackages: 挑出 schema 包, 别的类型不碰');
const loaded = { accepted: [
  { type: 'ui', id: 'booking', html: '<div></div>' },
  { type: 'workflow', id: 'setup' },
  pack(4, [V1, V2, V3, V4]),
  { type: 'schema', id: 'broken', schema_version: 9, migrations: [{ v: 1, sql: ['SELECT 1'] }] },
] };
const out = schemaPackages.loadFromPackages(loaded, { dataDir });
ok('装上 1 个, 坏的 1 个单独报', out.loaded.length === 1 && out.failed.length === 1,
   JSON.stringify(out));
ok('坏包不影响好包', out.loaded[0].id === 'restaurant' && out.failed[0].id === 'broken',
   JSON.stringify(out));

console.log('\n[9] 导出备份: 一个文件, 店主自己拿走');
const backup = path.join(root, 'backup', 'restaurant-20260917.sqlite');
let e = conn.exportIndustry('restaurant', backup);
ok('导出成功', e.ok && fs.existsSync(backup) && e.bytes > 0, JSON.stringify(e));
{
  const { Database } = require('node-sqlite3-wasm');
  const b = new Database(backup);
  ok('副本里有数据', b.all('SELECT name FROM customer')[0].name === '田中');
  ok('副本里也有版本号', b.all('SELECT version FROM _schema_version')[0].version === 4);
  b.close();
}
e = conn.exportIndustry('restaurant', backup);
ok('不覆盖已有的备份', !e.ok && e.code === 'dest_exists', JSON.stringify(e));

console.log('\n[10] 清库重建: 版本归零, migration 从头跑');
const before = conn.runIndustry('restaurant', 'query', 'SELECT COUNT(*) c FROM customer', []);
ok('重建前有数据', before.ok && before.rows[0].c === 1);
const rb = schemaPackages.resetIndustry(pack(4, [V1, V2, V3, V4]), { dataDir });
ok('重建成功', rb.ok && rb.removed === true, JSON.stringify(rb));
ok('从 v0 重新跑满 4 段', rb.from === 0 && rb.to === 4 && rb.applied === 4, JSON.stringify(rb));
const after = dbFactory.create({ controlDir: () => dataDir, dataDir: () => dataDir })
  .runIndustry('restaurant', 'query', 'SELECT COUNT(*) c FROM customer', []);
ok('表在, 但数据没了', after.ok && after.rows[0].c === 0, JSON.stringify(after));
ok('备份文件没被牵连', fs.existsSync(backup));

db().close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} test-schema-packages: ${pass} pass / ${fail} fail\n`);
process.exit(fail === 0 ? 0 : 1);
