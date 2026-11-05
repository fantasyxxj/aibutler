// test-db.js — 插件数据库口子(db.js + commands.js 的 db 原语): SQLite 端到端。
// 跑法: node test-db.js
//
// 验三件事:
//   连接跟插件走 —— 两个 pkgId 各连各的库, 互不相通
//   query/run 读写两路 —— 建表/插/改/查/删都走 prepared statement
//   没配置 → SQLite 兜底, 坏 op → 拒绝
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../core/db');
const commands = require('../core/commands');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-db-'));
  const controlDir = () => path.join(tmp, 'app');
  const dataDir = () => tmp;
  const mgr = db.create({ controlDir, dataDir });
  const SQL = (pkgId, op, sql, params) => mgr.runOp(pkgId, op, sql, params);

  console.log('\n[1] query/run 读写两路(缺省 SQLite 兜底, 没写配置)');
  {
    const r = SQL('shop', 'run', 'CREATE TABLE orders(id INTEGER PRIMARY KEY, name TEXT)', []);
    ok(r.ok, '建表 run 成功');

    const ins = SQL('shop', 'run', 'INSERT INTO orders(name) VALUES (?)', ['张三']);
    ok(ins.ok && ins.changes === 1 && ins.lastInsertId === 1, `插入返 changes=1,lastInsertId=1 (got ${JSON.stringify(ins)})`);

    const ins2 = SQL('shop', 'run', 'INSERT INTO orders(name) VALUES (?)', ['李四']);
    ok(ins2.ok && ins2.lastInsertId === 2, '第二条 lastInsertId=2');

    const rows = SQL('shop', 'query', 'SELECT * FROM orders ORDER BY id', []);
    ok(rows.ok && rows.rows.length === 2 && rows.rows[0].name === '张三', '查询返 2 行, 内容对');

    const upd = SQL('shop', 'run', 'UPDATE orders SET name=? WHERE id=?', ['王五', 1]);
    ok(upd.ok && upd.changes === 1, '更新 changes=1');

    const one = SQL('shop', 'query', 'SELECT name FROM orders WHERE id=?', [1]);
    ok(one.ok && one.rows[0].name === '王五', '更新后读回的值对');

    const del = SQL('shop', 'run', 'DELETE FROM orders WHERE id=?', [2]);
    ok(del.ok && del.changes === 1, '删除 changes=1');
  }

  console.log('\n[2] 连接跟插件走 —— 两个包各连各的库');
  {
    SQL('shop', 'run', 'CREATE TABLE t(v TEXT)', []);
    SQL('shop', 'run', 'INSERT INTO t VALUES (?)', ['shop 的']);
    const a = SQL('shop', 'query', 'SELECT * FROM t', []);
    const b = SQL('other', 'query', 'SELECT * FROM t', []);
    ok(a.ok && a.rows.length === 1, 'shop 读到自己那 1 行');
    ok(!b.ok && b.code === 'db_failed', 'other 没有这张表 → 报错, 不是读到 shop 的数据');
  }

  console.log('\n[3] 参数化堵注入');
  {
    SQL('shop', 'run', 'CREATE TABLE u(name TEXT)', []);
    SQL('shop', 'run', 'INSERT INTO u VALUES (?)', ['x" OR 1=1 --']);
    const r = SQL('shop', 'query', 'SELECT * FROM u WHERE name=?', ['干净的值']);
    ok(r.ok && r.rows.length === 0, '带引号的恶意串当参数绑, 不改变 SQL 结构');
  }

  console.log('\n[4] db 原语(commands.js)的挡法');
  {
    const ctx = { db: (pkgId, op, sql, params) => mgr.runOp(pkgId, op, sql, params) };
    const decl = { pkg: 'shop' };
    const badOp = await commands.PRIMITIVES.db({ op: 'drop', sql: 'SELECT 1' }, ctx, decl);
    ok(!badOp.ok && badOp.code === 'bad_param', '坏 op 拒绝');
    const noSql = await commands.PRIMITIVES.db({ op: 'query', sql: '  ' }, ctx, decl);
    ok(!noSql.ok && noSql.code === 'missing_param', '空 sql 拒绝');
    const noDb = await commands.PRIMITIVES.db({ op: 'query', sql: 'SELECT 1' }, {}, decl);
    ok(!noDb.ok && noDb.code === 'no_db', '没注入 ctx.db → no_db');
    const good = await commands.PRIMITIVES.db({ op: 'query', sql: 'SELECT name FROM u WHERE name=?', params: ['干净的值'] }, ctx, decl);
    ok(good.ok, '原语正常走通(query)');
  }

  console.log('\n[5] 配置文件指定 driver:sqlite + file');
  {
    const dir = path.join(controlDir(), 'plugin-db');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cfgtest.json'), JSON.stringify({ driver: 'sqlite', file: path.join(tmp, 'custom.sqlite') }));
    const r = SQL('cfgtest', 'run', 'CREATE TABLE c(id INTEGER PRIMARY KEY)', []);
    ok(r.ok, '配置文件指定的 sqlite 文件能用');
    ok(fs.existsSync(path.join(tmp, 'custom.sqlite')), '落到了配置里写的文件');
  }

  console.log('\n[6] 缺驱动 → 报错说清去哪装, 不装死');
  {
    const dir = path.join(controlDir(), 'plugin-db');
    fs.writeFileSync(path.join(dir, 'mysqlx.json'), JSON.stringify({ driver: 'mysql2', host: 'x' }));
    const r = SQL('mysqlx', 'query', 'SELECT 1', []);
    ok(!r.ok && r.code === 'no_driver', `报 no_driver(got ${JSON.stringify(r)})`);
    ok(/mysql2/.test(r.message || ''), '报错里带驱动名');
  }

  mgr.close();
  console.log(`\n✅ test-db: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
