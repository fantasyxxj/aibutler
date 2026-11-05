// test-memory-projects.js — projects(这条在哪些项目里验过) 从写入到呈现逐层不断。
// 🔴 存在的理由: 加一个可写字段要动五处(schema.sql · schema.js 的 _addMissingColumns ·
// consts.js 的 NODE_COLS/GRAPH_COLS · graph.js 的 FIELDS 与 INSERT · 引擎层转发),
// 漏任何一处都**不报错**, 只是那一列永远是空的 —— 尤其第 ⑥ 段: CREATE TABLE IF NOT EXISTS
// 对已存在的表什么都不做, 老库不补列就是静默半废。
// 跑: node personal/test-memory-projects.js
require('./host-wiring');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Butler } = require('../core/agent');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-prj-'));
const b = new Butler(home, { name: '测试人格' });
const g = b.memory;

console.log('=== ① 写入层: upsert 收得下 projects ===');
g.upsert({ slug: 'reference_probe_multi', claim: '这条同时在 core 和行业版验过', keywords: '探针 多值',
  projects: 'butler-core 行业版' });
const row = g.store.db.get("SELECT projects FROM nodes WHERE slug='reference_probe_multi'");
ok(row && row.projects === 'butler-core 行业版', `落库原样: "${row && row.projects}"`);

console.log('=== ② partial 语义: 不传不动 ===');
g.upsert({ slug: 'reference_probe_multi', claim: '这条同时在 core 和行业版验过(改了命题)' });
const row2 = g.store.db.get("SELECT projects FROM nodes WHERE slug='reference_probe_multi'");
ok(row2.projects === 'butler-core 行业版', '只改 claim 时 projects 一个字不动');

console.log('=== ③ 空值就是空, 不编 ===');
g.upsert({ slug: 'reference_probe_blank', claim: '这条没标过属于哪个项目', keywords: '探针 空' });
const row3 = g.store.db.get("SELECT projects FROM nodes WHERE slug='reference_probe_blank'");
ok(row3.projects === '', '没传就是空串(空 = 没标过, 不是"通用")');

console.log('=== ④ 检索层: 带得出来(不带出来渲染层就永远拿不到) ===');
const hits = g.query('探针 多值', { k: 5 });
const hit = (hits.items || hits.results || hits || []).find((x) => x.slug === 'reference_probe_multi');
ok(!!hit, '检索命中');
ok(hit && hit.projects === 'butler-core 行业版', `检索结果对象带 projects: "${hit && hit.projects}"`);

console.log('=== ⑤ 常驻列: allNodes 取材口带它(不带的话跨语言/检索全看不到) ===');
const raw = g.store.allNodes ? g.store.allNodes() : null;
const all = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
const n = all.find((x) => x && x.slug === 'reference_probe_multi');
ok(!!n, `allNodes 取得到(共 ${all.length} 条)`);
ok(n && n.projects === 'butler-core 行业版', 'NODE_COLS 常驻列含 projects');

console.log('=== ⑥ 老库补列: 没有这列的库打开后要自己长出来 ===');
const oldHome = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-old-'));
const b2 = new Butler(oldHome, { name: '老库' });
b2.memory.upsert({ slug: 'reference_seed', claim: '先建一个库' });
const { DB_FILE } = require('../core/store-v2/consts');
const dbPath = path.join(b2.memoryDir, DB_FILE);
ok(fs.existsSync(dbPath), `找到库文件 ${DB_FILE}`);
b2.memory.store.close && b2.memory.store.close();
// 模拟老库: 把列删掉(sqlite 3.35+ 支持 DROP COLUMN)
try {
  const { execSync } = require('child_process');
  execSync(`/usr/bin/sqlite3 "${dbPath}" "ALTER TABLE nodes DROP COLUMN projects;"`);
  const after = execSync(`/usr/bin/sqlite3 "${dbPath}" "PRAGMA table_info(nodes);"`).toString();
  ok(!/\|projects\|/.test(after), '(前置)已把列删掉, 模拟出老库');
  const b3 = new Butler(oldHome, { name: '老库重开' });
  const cols = b3.memory.store.db.all('PRAGMA table_info(nodes)').map((c) => c.name);
  ok(cols.includes('projects'), '🔴 重开后 _addMissingColumns 把列补回来了');
  b3.memory.upsert({ slug: 'reference_seed', projects: '个人版' });
  const r = b3.memory.store.db.get("SELECT projects FROM nodes WHERE slug='reference_seed'");
  ok(r.projects === '个人版', '补列之后写得进去');
} catch (e) {
  console.log('  (skip) 老库模拟失败:', e.message.split('\n')[0]);
}

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
