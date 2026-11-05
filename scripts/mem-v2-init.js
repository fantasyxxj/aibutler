#!/usr/bin/env node
// mem-v2-init.js — 按 memory-schema-v2.sql 建空库并自检。
//
// 用法: node scripts/mem-v2-init.js [目标目录]   (默认 /tmp/mem-v2-lab)
//
// 🔴 只建空库, 绝不碰任何真实记忆库 —— 目标目录里若已有 memory.db 会直接拒绝, 不覆盖。
// 自检不是"建完了没报错就算过": 约束这种东西不验就等于没有, 尤其外键 ——
// PRAGMA foreign_keys 是【连接级】的, 写在 .sql 里被 exec 执行未必留在后续连接上,
// 这正是最容易以为配了其实没配的一处。

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 2;
const SCHEMA_FILE = path.join(__dirname, '..', 'memory-schema-v2.sql');
const outDir = path.resolve(process.argv[2] || '/tmp/mem-v2-lab');
const dbPath = path.join(outDir, 'memory.db');

const checks = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    checks.push({ ok: true, name, detail: detail || '' });
  } catch (e) {
    checks.push({ ok: false, name, detail: e.message });
  }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

if (fs.existsSync(dbPath)) {
  console.error(`✗ ${dbPath} 已存在。本脚本只建空库, 不覆盖既有库。先删或换目录。`);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const { Database } = require('node-sqlite3-wasm');
const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
const db = new Database(dbPath);
db.exec(sql);
db.run('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v',
  ['schema_version', String(SCHEMA_VERSION)]);

// ── 1. 表齐 ────────────────────────────────────────────────
const WANT_TABLES = ['nodes', 'edges', 'pinned', 'redlines', 'error_log', 'history', 'vectors', 'meta'];
check('8 张表全部建出', () => {
  const got = db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .map(r => r.name).sort();
  const missing = WANT_TABLES.filter(t => !got.includes(t));
  assert(missing.length === 0, `缺表: ${missing.join(',')}`);
  return got.join(' ');
});

// ── 2. 索引齐 ──────────────────────────────────────────────
const WANT_IDX = ['idx_nodes_status', 'idx_nodes_type', 'idx_nodes_hot',
  'idx_edges_dst', 'idx_edges_rel', 'idx_errlog_node', 'idx_history_node'];
check('7 个显式索引全部建出', () => {
  const got = db.all(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'`)
    .map(r => r.name);
  const missing = WANT_IDX.filter(i => !got.includes(i));
  assert(missing.length === 0, `缺索引: ${missing.join(',')}`);
  return `${got.length} 个`;
});

// ── 3. 外键开关是否真的在这条连接上生效 ──────────────────────
// 实测结论: node-sqlite3-wasm 裸开库就是 ON, 所以下面两条【验的是驱动默认值, 不是 .sql 那行】。
// 标准 SQLite 默认 OFF, 故这个"通过"是驱动送的, 不是我们挣的 —— 存储层仍须显式设置。
check('当前连接 foreign_keys 为 ON(注: 由驱动默认值提供)', () => {
  const r = db.get('PRAGMA foreign_keys');
  const v = r && (r.foreign_keys !== undefined ? r.foreign_keys : Object.values(r)[0]);
  assert(v === 1, `实际值 ${JSON.stringify(r)}`);
  return 'ON';
});

// ── 4. 各表 CRUD ───────────────────────────────────────────
check('nodes 增删改查 + 数字主键自增', () => {
  db.run(`INSERT INTO nodes(slug,title,claim,keywords,body,type,importance,created,last_used)
          VALUES(?,?,?,?,?,?,?,?,?)`,
    ['feedback_demo_one', '示例一', '命题: 段表不必独立, 因为 claim 已经是不读正文的摘要',
      'section 段表 命题', '正文若干', 'feedback', 'high', '2026-08-16', '2026-08-16']);
  db.run(`INSERT INTO nodes(slug,title,claim,type,created,last_used) VALUES(?,?,?,?,?,?)`,
    ['reference_demo_two', '示例二', '命题: 数字主键会抹掉检索信号, keywords 是补偿不是装饰',
      'reference', '2026-08-16', '2026-08-16']);
  const rows = db.all('SELECT id,slug,claim FROM nodes ORDER BY id');
  assert(rows.length === 2, `期望 2 行, 实得 ${rows.length}`);
  assert(rows[0].id === 1 && rows[1].id === 2, `主键未从 1 自增: ${rows.map(r => r.id)}`);
  db.run('UPDATE nodes SET claim=? WHERE id=?', ['命题: 改过了', 1]);
  assert(db.get('SELECT claim FROM nodes WHERE id=1').claim === '命题: 改过了', 'UPDATE 未生效');
  return `id ${rows.map(r => r.id).join(',')}`;
});

check('claim NOT NULL 约束生效', () => {
  let threw = false;
  try { db.run('INSERT INTO nodes(slug,title) VALUES(?,?)', ['x_no_claim', '无命题']); }
  catch (_) { threw = true; }
  assert(threw, '插入了没有 claim 的节点 —— 命题不是可选字段, 这条必须挡住');
  return '挡住了';
});

check('slug UNIQUE 约束生效', () => {
  let threw = false;
  try {
    db.run('INSERT INTO nodes(slug,title,claim) VALUES(?,?,?)',
      ['feedback_demo_one', '重名', '命题: 重复 slug']);
  } catch (_) { threw = true; }
  assert(threw, 'slug 重复没被挡 —— 迁移期靠 slug 找节点, 重了就找错人');
  return '挡住了';
});

check('edges 同一对节点可并存多种 rel', () => {
  db.run('INSERT INTO edges(src,dst,rel,made_by,created) VALUES(?,?,?,?,?)', [1, 2, 'relates', 'human', '2026-08-16']);
  db.run('INSERT INTO edges(src,dst,rel,made_by,created) VALUES(?,?,?,?,?)', [1, 2, 'supersedes', 'human', '2026-08-16']);
  const n = db.get('SELECT COUNT(*) c FROM edges WHERE src=1 AND dst=2').c;
  assert(n === 2, `期望 2 条并存, 实得 ${n} —— 主键必须是 (src,dst,rel)`);
  let threw = false;
  try { db.run('INSERT INTO edges(src,dst,rel) VALUES(?,?,?)', [1, 2, 'relates']); } catch (_) { threw = true; }
  assert(threw, '同 rel 重复边没被主键挡住');
  return '2 条并存, 同 rel 重复被挡';
});

check('edges 外键指向不存在的节点会被拒', () => {
  let threw = false;
  try { db.run('INSERT INTO edges(src,dst,rel) VALUES(?,?,?)', [1, 9999, 'relates']); } catch (_) { threw = true; }
  assert(threw, '悬空边没被挡 —— 现行库 95 条悬空边就是这么来的, 新库必须从源头堵住');
  return '悬空边被拒';
});

check('pinned / redlines / error_log / history / vectors 可写', () => {
  db.run('INSERT INTO pinned(node_id,added_at,reason) VALUES(?,?,?)', [1, '2026-08-16', '最常查']);
  db.run(`INSERT INTO redlines(node_id,trigger_pattern,correct_action,level) VALUES(?,?,?,?)`,
    [1, 'kill|pkill', '先问作者, 绝不擅自杀进程', 'block']);
  db.run('INSERT INTO error_log(node_id,at,raw,count) VALUES(?,?,?,?)', [1, '2026-08-16', '踩过的原话', 1]);
  db.run(`INSERT INTO history(node_id,at,op,field,before,after,actor) VALUES(?,?,?,?,?,?,?)`,
    [1, '2026-08-16', 'upsert', 'claim', '旧命题', '命题: 改过了', '码上飞']);
  db.run('INSERT INTO vectors(node_id,dim,vec,model,src_hash,embedded_at) VALUES(?,?,?,?,?,?)',
    [1, 4, new Uint8Array(16), 'demo-model', 'abcd1234', '2026-08-16']);
  const c = ['pinned', 'redlines', 'error_log', 'history', 'vectors']
    .map(t => `${t}=${db.get(`SELECT COUNT(*) c FROM ${t}`).c}`);
  return c.join(' ');
});

check('一个节点可同时是 pinned 和 redline(配额各算各的)', () => {
  const n = db.get(`SELECT COUNT(*) c FROM pinned p JOIN redlines r ON p.node_id=r.node_id`).c;
  assert(n === 1, `期望节点 1 同时在两表, 实得 ${n} —— 这是拆扩展表最主要的收益`);
  return '正交成立';
});

// ── 5. 级联删除 ────────────────────────────────────────────
check('删节点后 5 张挂靠表全部级联清干净', () => {
  db.run('DELETE FROM nodes WHERE id=?', [1]);
  const left = {};
  for (const t of ['edges', 'pinned', 'redlines', 'history', 'vectors']) {
    const col = t === 'edges' ? 'src' : 'node_id';
    left[t] = db.get(`SELECT COUNT(*) c FROM ${t} WHERE ${col}=1`).c;
  }
  const dirty = Object.entries(left).filter(([, v]) => v > 0);
  assert(dirty.length === 0, `残留: ${dirty.map(([k, v]) => `${k}=${v}`).join(',')}`);
  // error_log 是 SET NULL 不是 CASCADE: 犯过的错要留着, 哪怕那条记忆已经删了
  const orphan = db.get('SELECT node_id FROM error_log').node_id;
  assert(orphan === null, `error_log 应保留但 node_id 置空, 实得 ${orphan}`);
  return 'CASCADE 干净, error_log 按 SET NULL 保留';
});

check('schema_version 写入 meta', () => {
  const v = db.get(`SELECT v FROM meta WHERE k='schema_version'`).v;
  assert(v === String(SCHEMA_VERSION), `期望 ${SCHEMA_VERSION}, 实得 ${v}`);
  return v;
});

db.close();

// ── 复开一次: 验证约束是持久的 schema 属性, 不是本次会话的临时状态 ──
const db2 = new Database(dbPath);
check('复开连接后表结构仍在(落盘而非内存)', () => {
  const n = db2.get(`SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).c;
  assert(n === WANT_TABLES.length, `期望 ${WANT_TABLES.length} 张, 实得 ${n}`);
  return `${n} 张`;
});
check('复开连接后外键【行为】仍拦得住悬空边', () => {
  db2.run('INSERT INTO nodes(slug,title,claim) VALUES(?,?,?)', ['probe_fk', '探针', '命题: 外键要真拦得住']);
  const nid = db2.get(`SELECT id FROM nodes WHERE slug='probe_fk'`).id;
  let threw = false;
  try { db2.run('INSERT INTO edges(src,dst,rel) VALUES(?,?,?)', [nid, 999999, 'relates']); } catch (_) { threw = true; }
  db2.run('DELETE FROM nodes WHERE id=?', [nid]);
  // 验行为而不是验 PRAGMA 读数: 读数只说明开关的位置, 行为才说明它接着线
  assert(threw, '悬空边插进去了 —— 外键没生效, 存储层必须显式开');
  return '拦住了';
});
db2.close();

const pass = checks.filter(c => c.ok).length;
console.log(`\n建库: ${dbPath}  (${(fs.statSync(dbPath).size / 1024).toFixed(1)} KB)\n`);
for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? '  — ' + c.detail : ''}`);
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
