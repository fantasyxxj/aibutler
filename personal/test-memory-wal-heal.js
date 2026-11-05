// test-memory-wal-heal.js — 被别的客户端切成 WAL 的库, 打开时要能自己扳回来。
//
// 🔴 为什么必须有这个门禁: WAL 库在本驱动下【怎么都用不了】, 而症状极具迷惑性 ——
// `new Database()` 是惰性的**不报错**, 其后每一次读/写/PRAGMA 才抛 `unable to open database file`,
// 连用来补救的 `PRAGMA journal_mode=DELETE` 它自己都抛。所以修复只能在打开**之前**改文件头。
// 2026-09-08 一台客户机器上的人格为此整整一天存不进也查不出。
// 跑: node personal/test-memory-wal-heal.js
require('./host-wiring');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { Butler } = require('../core/agent');
const { DB_FILE } = require('../core/store-v2/consts');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };

// 先拿 Butler 正常建一个库, 再用 sqlite3 CLI 把它切成 WAL —— 这正是现实里中招的路径。
function makeLibrary(name) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'walheal-'));
  const b = new Butler(home, { name });
  b.memory.upsert({ slug: 'reference_probe_wal', claim: '这条要在扳回之后还读得出来' });
  try { b.memory.store.close && b.memory.store.close(); } catch (_) {}
  return { home, db: path.join(b.memoryDir, DB_FILE) };
}
const headByte = (db) => fs.readFileSync(db)[18];

console.log('=== T1: 被切成 WAL 的库, 重开时自己扳回来 ===');
{
  const { home, db } = makeLibrary('WAL测试');
  execSync(`/usr/bin/sqlite3 "${db}" "PRAGMA journal_mode=WAL;"`);
  ok(headByte(db) === 2, `(前置)已切成 WAL, 文件头第18字节=${headByte(db)}`);

  const b2 = new Butler(home, { name: 'WAL测试' });
  ok(headByte(db) === 1, '🔴 重开后文件头扳回 1(rollback)');
  const hit = b2.memory.store.db.get("SELECT claim FROM nodes WHERE slug='reference_probe_wal'");
  ok(!!hit, '🔴 扳回之后读得出来(不报 unable to open database file)');
  ok(hit && /扳回之后还读得出来/.test(hit.claim), '数据没丢, 原文还在');
  b2.memory.upsert({ slug: 'reference_probe_after', claim: '扳回之后还能写' });
  const w = b2.memory.store.db.get("SELECT claim FROM nodes WHERE slug='reference_probe_after'");
  ok(!!w, '扳回之后写得进去');
  for (const s of ['-wal', '-shm']) ok(!fs.existsSync(db + s), `sidecar ${s} 已清掉`);
}

console.log('=== T2: 正常库不受影响(别乱动没病的库) ===');
{
  const { home, db } = makeLibrary('正常库');
  const before = fs.readFileSync(db).length;
  ok(headByte(db) === 1, '(前置)本来就是 rollback');
  const b2 = new Butler(home, { name: '正常库' });
  ok(headByte(db) === 1, '重开后仍是 1');
  const hit = b2.memory.store.db.get("SELECT claim FROM nodes WHERE slug='reference_probe_wal'");
  ok(!!hit, '数据照常读得到');
}

console.log('=== T3: -wal 里还有未回放数据时, 只报警不硬改 ===');
{
  const { home, db } = makeLibrary('未回放');
  execSync(`/usr/bin/sqlite3 "${db}" "PRAGMA journal_mode=WAL;"`);
  // 造一个非空 -wal: 硬扳会丢掉这批写入, 所以代码必须拒绝动手
  fs.writeFileSync(`${db}-wal`, Buffer.alloc(64, 7));
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try { new Butler(home, { name: '未回放' }); } catch (_) { /* 打不开是预期内的 */ }
  console.error = origErr;
  ok(headByte(db) === 2, '🔴 文件头没被动(不能丢掉未回放的那批写入)');
  ok(fs.existsSync(`${db}-wal`) && fs.statSync(`${db}-wal`).size > 0, '-wal 也没被删');
  ok(errs.some((e) => /未回放|journal_mode=DELETE/.test(e)), '🔴 出了声, 并给了人工修复命令');
}

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
