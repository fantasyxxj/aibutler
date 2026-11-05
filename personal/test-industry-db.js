// test-industry-db.js — 行业库底座(core/db.js 第一步改造)的回归测试。
//
// 覆盖三件改动 + 一条底线:
//   ① 连接缓存按【解析后的文件路径】分桶, 不按 pkgId —— 多个包共用一个库文件时
//      只开一条连接(判据用 PRAGMA data_version: 自身写入不改它, 别的连接写才改)
//   ② 打开前的 WAL 自愈 —— 被别的客户端切成 WAL 的库照样能开
//   ③ 行业库(落在 industry-db/ 下的)拒 DDL, 结构只能由 migration 改
//   底线: 插件私有库一切照旧, 自己建表自己用, 一个字都不许变
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { create } = require('../core/db');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};

function freshRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-idb-'));
  fs.mkdirSync(path.join(root, 'control', 'plugin-db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'control', 'industry-db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  return root;
}
const mk = (root) => create({
  controlDir: path.join(root, 'control'),
  dataDir: path.join(root, 'data'),
});
const shareTo = (root, pkgs, file) => {
  for (const p of pkgs) {
    fs.writeFileSync(path.join(root, 'control', 'plugin-db', `${p}.json`),
      JSON.stringify({ driver: 'sqlite', file }));
  }
};

const root = freshRoot();
const ctrl = path.join(root, 'control');
const db = mk(root);

console.log('\n[1] 插件私有库照旧 —— 自己建表自己用');
let r = db.runOp('plugin.counter', 'run', 'CREATE TABLE hits (n INTEGER)', []);
ok('私有库可以建表(DDL 闸不该碰它)', r.ok, r.message);
r = db.runOp('plugin.counter', 'run', 'INSERT INTO hits VALUES (?)', [7]);
ok('私有库可以写入', r.ok && r.changes === 1, JSON.stringify(r));

console.log('\n[2] 多个包共用一个行业库文件');
const shared = path.join(ctrl, 'industry-db', 'restaurant.sqlite');
shareTo(root, ['ui.booking', 'ui.mail-box'], shared);
db.openIndustry('restaurant').db.run('CREATE TABLE customer (id INTEGER PRIMARY KEY, name TEXT)');
r = db.runOp('ui.booking', 'run', 'INSERT INTO customer (name) VALUES (?)', ['田中']);
ok('包 A 写入行业库', r.ok && r.lastInsertId === 1, JSON.stringify(r));
r = db.runOp('ui.mail-box', 'query', 'SELECT name FROM customer', []);
ok('包 B 读到包 A 写的行', r.ok && r.rows.length === 1 && r.rows[0].name === '田中', JSON.stringify(r));

console.log('\n[3] 同一个文件只开一条连接(否则并发写会 SQLITE_BUSY)');
const dv = (pkg) => {
  const x = db.runOp(pkg, 'query', 'PRAGMA data_version', []);
  return x.ok && x.rows[0] ? x.rows[0].data_version : `ERR ${JSON.stringify(x)}`;
};
const dvBefore = dv('ui.mail-box');
db.runOp('ui.booking', 'run', 'INSERT INTO customer (name) VALUES (?)', ['佐藤']);
ok('自身写入不改 data_version → 两个包是同一条连接',
   dvBefore === dv('ui.mail-box'), `${dvBefore} → ${dv('ui.mail-box')}`);
let busy = 0;
for (let i = 0; i < 300; i++) {
  const x = db.runOp(i % 2 ? 'ui.booking' : 'ui.mail-box',
                     'run', 'INSERT INTO customer (name) VALUES (?)', [`n${i}`]);
  if (!x.ok) busy += 1;
}
r = db.runOp('ui.booking', 'query', 'SELECT COUNT(*) c FROM customer', []);
ok('交替写 300 次无一失败', busy === 0 && r.rows[0].c === 302, `busy=${busy} rows=${r.rows[0].c}`);

console.log('\n[4] 行业库拒 DDL, 结构只能随行业包升级');
for (const sql of ['CREATE TABLE x (i INT)',
                   'ALTER TABLE customer ADD COLUMN phone TEXT',
                   'DROP TABLE customer',
                   '   drop   table customer']) {
  r = db.runOp('ui.booking', 'run', sql, []);
  ok(`拒绝 ${sql.trim().slice(0, 32)}`, !r.ok && r.code === 'ddl_forbidden', JSON.stringify(r));
}
r = db.runOp('ui.booking', 'run', 'UPDATE customer SET name = ? WHERE id = 1', ['鈴木']);
ok('DML 照常放行', r.ok && r.changes === 1, JSON.stringify(r));
r = db.runOp('ui.booking', 'query', 'SELECT name FROM customer WHERE id = 1', []);
ok('改完读得到新值', r.ok && r.rows[0].name === '鈴木', JSON.stringify(r));
r = db.runOp('plugin.counter', 'run', 'CREATE TABLE more (i INT)', []);
ok('私有库不受 DDL 闸影响', r.ok, JSON.stringify(r));
r = db.openIndustry('restaurant').db.run('ALTER TABLE customer ADD COLUMN phone TEXT');
ok('migration 口(openIndustry)能改结构', true);

console.log('\n[5] 被切成 WAL 的库照样打得开');
db.close();
const walFile = path.join(ctrl, 'industry-db', 'reform.sqlite');
{
  const { Database } = require('node-sqlite3-wasm');
  const d = new Database(walFile);
  d.run('CREATE TABLE t (v TEXT)');
  d.run("INSERT INTO t VALUES ('before')");
  d.close();
}
{   // 手工把文件头第 18/19 字节改成 2 = 模拟被别的客户端切成 WAL
  const fd = fs.openSync(walFile, 'r+');
  fs.writeSync(fd, Buffer.from([2, 2]), 0, 2, 18);
  fs.closeSync(fd);
}
let head = fs.readFileSync(walFile).subarray(18, 20);
ok('前置: 文件头已是 WAL(2,2)', head[0] === 2 && head[1] === 2, head.join(','));
const db2 = mk(root);
let back;
try { back = db2.openIndustry('reform').db.all('SELECT v FROM t'); }
catch (e) { back = `THREW: ${e.message}`; }
ok('打开后读得出原有数据', Array.isArray(back) && back[0] && back[0].v === 'before', JSON.stringify(back));
head = fs.readFileSync(walFile).subarray(18, 20);
ok('文件头被扳回 rollback(1,1)', head[0] === 1 && head[1] === 1, head.join(','));

console.log('\n[6] 没配置的包仍各落各的私有库');
r = db2.runOp('plugin.solo', 'run', 'CREATE TABLE own (i INT)', []);
ok('自动落 plugin-db/<id>.sqlite',
   r.ok && fs.existsSync(path.join(ctrl, 'plugin-db', 'plugin.solo.sqlite')), JSON.stringify(r));
r = db2.runOp('plugin.solo', 'query', 'SELECT name FROM sqlite_master WHERE name = ?', ['customer']);
ok('看不见行业库的表', r.ok && r.rows.length === 0, JSON.stringify(r));

console.log('\n[7] 助手自己的口: runIndustry / describeIndustry');
{
  const d0 = db2.describeIndustry('empty-one');
  ok('空库 describe 不报错, 表为空', d0.ok && d0.tables.length === 0 && d0.schema_version === 0,
     JSON.stringify(d0));
  const c3 = db2.openIndustry('reform');
  c3.db.run('CREATE TABLE guest (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  const d = db2.describeIndustry('reform');
  ok('列出表名', d.ok && d.tables.some((t) => t.table === 'guest'), JSON.stringify(d));
  const guest = d.tables.find((t) => t.table === 'guest');
  ok('列出列与约束', guest && guest.columns.join('|').includes('name TEXT NOT NULL'),
     JSON.stringify(guest));
  ok('_schema_version 不出现在清单里', d.tables.every((t) => t.table !== '_schema_version'),
     JSON.stringify(d.tables.map((t) => t.table)));

  let x = db2.runIndustry('reform', 'run', 'INSERT INTO guest (name) VALUES (?)', ['佐藤']);
  ok('助手能写入', x.ok && x.changes === 1, JSON.stringify(x));
  x = db2.runIndustry('reform', 'query', 'SELECT name FROM guest', []);
  ok('助手能查询', x.ok && x.rows[0].name === '佐藤', JSON.stringify(x));
  x = db2.runIndustry('reform', 'run', 'ALTER TABLE guest ADD COLUMN sneaky TEXT', []);
  ok('助手同样改不了表结构', !x.ok && x.code === 'ddl_forbidden', JSON.stringify(x));
  x = db2.runIndustry('', 'query', 'SELECT 1', []);
  ok('没给行业 id 时说清楚', !x.ok && x.code === 'missing_industry', JSON.stringify(x));
  x = db2.runIndustry('reform', 'query', 'SELECT * FROM no_such_table', []);
  ok('查不存在的表报错而不是静默', !x.ok && x.code === 'db_failed', JSON.stringify(x));
}

console.log('\n[8] 一个 controlDir 一个实例(行业版每执行一次命令就 create 一次)');
ok('同一个 controlDir 反复 create 拿到同一个实例', mk(root) === mk(root));
ok('拿到的就是在用的那个', mk(root) === db2);
const other = freshRoot();
ok('不同 controlDir 是不同实例', mk(other) !== db2);
mk(other).close();
fs.rmSync(other, { recursive: true, force: true });

db2.close();
ok('close 之后再 create 得到全新实例', mk(root) !== db2);
mk(root).close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} test-industry-db: ${pass} pass / ${fail} fail\n`);
process.exit(fail === 0 ? 0 : 1);
