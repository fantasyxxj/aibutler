// schema-packages.js — 行业库表结构包(type: 'schema')的装填与升级。
//
// 界面包带的是画面, 手顺包带的是步骤, 这一种带的是**这个行业的表长什么样**。
// 三者走同一条货架通路下发, 装机端这一侧各有各的消费者, 这个文件是 schema 那一个。
//
// 为什么包里可以直接放 SQL: **SQL 是数据不是代码**。db 层本来就在执行插件递来的 SQL,
// 所以这不碰「core 从不执行包里的代码」那道安全笼 —— 包里没有一行会被 eval 的东西。
//
// 版本号记在【库自己的 _schema_version 表】里, 不写独立状态文件:
// 库被清掉重建时版本号跟着归零, migration 自然从头跑一遍; 记在文件里就会出现
// 「库空了但版本号还是 3」, 于是一条 SQL 都不跑, 留下一个没有表的空库。
'use strict';

const dbFactory = require('./db');
const { nowLocalISO } = require('./memory/primitives');   // 本地时区带偏移, 禁 UTC

const VERSION_TABLE = `CREATE TABLE IF NOT EXISTS _schema_version (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  version    INTEGER NOT NULL,
  updated_at TEXT    NOT NULL
)`;

/* 形状检查。宁可整包不装也不要装一半 —— 表结构装一半, 后面每一次读写都是谜题。 */
function checkPayload(p) {
  if (!p || typeof p !== 'object') return '包是空的';
  if (p.type !== 'schema') return `type 不是 schema: ${p.type}`;
  if (!p.id || !String(p.id).trim()) return '缺 id(它同时是行业库的文件名)';
  if (!Number.isInteger(p.schema_version) || p.schema_version < 1) {
    return `schema_version 必须是 ≥1 的整数, 收到 ${JSON.stringify(p.schema_version)}`;
  }
  if (!Array.isArray(p.migrations) || !p.migrations.length) return 'migrations 必须是非空数组';
  const seen = new Set();
  for (const m of p.migrations) {
    if (!m || !Number.isInteger(m.v) || m.v < 1) return 'migration 的 v 必须是 ≥1 的整数';
    if (seen.has(m.v)) return `migration v=${m.v} 出现了两次`;
    seen.add(m.v);
    if (!Array.isArray(m.sql) || !m.sql.length) return `migration v=${m.v} 的 sql 必须是非空数组`;
    for (const s of m.sql) {
      if (typeof s !== 'string' || !s.trim()) return `migration v=${m.v} 里有空语句`;
    }
  }
  // 🔴 这一条防的是写包的人加了 migration 却忘了抬 schema_version:
  // 不校验的话包发出去了、装机端也收了, 但那一版永远不会被跑, 且没有任何报错。
  const max = Math.max(...p.migrations.map((m) => m.v));
  if (max !== p.schema_version) {
    return `schema_version(${p.schema_version}) 与 migrations 里最大的 v(${max}) 对不上`;
  }
  return null;
}

function currentVersion(db) {
  db.run(VERSION_TABLE);
  const r = db.all('SELECT version FROM _schema_version WHERE id = 1');
  return r.length ? Number(r[0].version) || 0 : 0;
}

/* 把 v 大于库中当前版本的几段依次跑掉。**一段一个事务**:
   一段里的几条 SQL 要么全进要么全不进, 半截的表结构比没有更难收拾。 */
function migrate(db, payload) {
  const from = currentVersion(db);
  const todo = payload.migrations.filter((m) => m.v > from).sort((a, b) => a.v - b.v);
  if (!todo.length) return { from, to: from, applied: 0 };

  let at = from;
  for (const m of todo) {
    db.run('BEGIN');
    try {
      for (const sql of m.sql) db.run(sql);
      db.run('INSERT INTO _schema_version (id, version, updated_at) VALUES (1, ?, ?)'
             + ' ON CONFLICT(id) DO UPDATE SET version = excluded.version,'
             + ' updated_at = excluded.updated_at',
             [m.v, nowLocalISO()]);
      db.run('COMMIT');
      at = m.v;
    } catch (e) {
      try { db.run('ROLLBACK'); } catch (_) {}
      throw new Error(`migration v=${m.v} 失败, 已回滚该段; 库停在 v=${at}`
                      + `(${at === 0 ? '空库' : '可用'}): ${(e && e.message) || e}`);
    }
  }
  return { from, to: at, applied: todo.length };
}

/* 装一个 schema 包。dataDir 同时当 controlDir 用 —— 行业版两者本来就是同一个目录。 */
function applyPackage(payload, { dataDir }) {
  const bad = checkPayload(payload);
  if (bad) return { ok: false, code: 'bad_schema', message: bad };
  const id = String(payload.id).trim();
  try {
    const conn = dbFactory.create({ controlDir: () => dataDir, dataDir: () => dataDir })
      .openIndustry(id);
    if (!conn.db) return { ok: false, code: 'no_db', message: conn.err || '行业库打不开' };
    const r = migrate(conn.db, payload);
    return { ok: true, id, file: conn.file, ...r };
  } catch (e) {
    return { ok: false, code: 'migrate_failed', message: (e && e.message) || String(e) };
  }
}

/* 装上所有已落地的 schema 包。loaded = packages.loadAll() 的结果。
   一个坏了不影响别的 —— 和界面包同一个理由。 */
function loadFromPackages(loaded, { dataDir }) {
  const ok = [], failed = [];
  for (const p of (loaded && loaded.accepted) || []) {
    if (p.type !== 'schema') continue;
    const r = applyPackage(p, { dataDir });
    if (r.ok) ok.push({ id: r.id, from: r.from, to: r.to, applied: r.applied });
    else failed.push({ id: p.id, code: r.code, message: r.message });
  }
  return { loaded: ok, failed };
}

/* 壊れた行業庫を作り直す。控えが有るなら店主が自分で戻す(書き出したファイルを
   industry-db/ へ置き直すだけ)、無ければ空から。どちらにせよ此処では消して積み直す。

   🔴 版番号を**ファイルでは無く庫の中**の `_schema_version` に置いている御利益がこれ:
   庫を消せば版も一緒に消え、migration が v1 から自然に流れる。ファイルに置いていたら
   「庫は空なのに版は 4」になり、一条も走らず表の無い空庫が残る。 */
function resetIndustry(payload, { dataDir }) {
  const bad = checkPayload(payload);
  if (bad) return { ok: false, code: 'bad_schema', message: bad };
  const id = String(payload.id).trim();
  const conn = dbFactory.create({ controlDir: () => dataDir, dataDir: () => dataDir });
  const dropped = conn.dropIndustry(id);
  const rebuilt = applyPackage(payload, { dataDir });
  if (!rebuilt.ok) return rebuilt;
  return { ok: true, id, removed: dropped.removed, ...rebuilt };
}

module.exports = { checkPayload, applyPackage, loadFromPackages, resetIndustry,
                   currentVersion, VERSION_TABLE };
