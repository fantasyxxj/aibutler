// test-plugin-call.js — 插件开放给人格的命令(ai:true)与 plugin_call 工具。运行: node test-plugin-call.js
//
// 守四件事: ① 只有声明 ai:true 的命令人格才调得到 ② 开放给人格的 db 命令 SQL 写死在声明里, 调用方改不了语句
// ③ plugin_find 列出可调的命令和写法 ④ 宿主没给执行器的版本(行业版)不出现 plugin_call。
require('./host-wiring');
const fs = require('fs');
const path = require('path');
const os = require('os');
const commands = require('../core/commands');
const { Butler } = require('../core/agent');

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { if (ok) { pass++; console.log(`  ✅ ${name}${extra ? ' · ' + extra : ''}`); } else { fail++; console.error(`  ❌ ${name}${extra ? ' · ' + extra : ''}`); } };

(async () => {
  console.log('\n[1] 声明: ai:true 才开放; db 命令开放时必须写死 sql');
  commands.pkgCommandsReset();
  const warn = console.warn; console.warn = () => {};
  commands.registerPackageCommands('todo-test', {
    add: { primitive: 'db', ai: true, summary: 'add one item', sql: 'INSERT INTO items(title) VALUES (?)',
           params: { title: { type: 'text', required: true } } },
    list: { primitive: 'db', ai: true, summary: 'list open items', sql: 'SELECT id, title FROM items' },
    remove: { primitive: 'db', summary: 'delete (person only)', sql: 'DELETE FROM items WHERE id = ?', params: { id: { type: 'int', required: true } } },
    raw: { primitive: 'db', ai: true, summary: 'free sql' },
  });
  console.warn = warn;
  const offered = commands.aiCommands('todo-test').map((c) => c.command).sort();
  t('只列出 ai:true 且合规的命令', JSON.stringify(offered) === JSON.stringify(['add', 'list']), offered.join(','));
  t('没写 sql 的 db 命令即使标了 ai 也不开放', !offered.includes('raw'));

  console.log('\n[2] 写死的 sql: 参数按声明顺序填空, 调用方传的 sql 不算数');
  let seen = null;
  const ctx = { db: (pkg, op, sql, params) => { seen = { pkg, op, sql, params }; return { ok: true, changes: 1 }; } };
  await commands.run('todo-test.add', { title: '买牛奶', sql: 'DROP TABLE items' }, ctx);
  t('用的是声明里的语句', seen && seen.sql === 'INSERT INTO items(title) VALUES (?)', seen && seen.sql);
  t('参数按 params 顺序取', seen && JSON.stringify(seen.params) === '["买牛奶"]');
  t('写语句走 run', seen && seen.op === 'run');
  t('库按声明的包认', seen && seen.pkg === 'todo-test');
  await commands.run('todo-test.list', {}, ctx);
  t('SELECT 走 query', seen && seen.op === 'query');

  console.log('\n[2b] 包级 db_setup: 第一次跑 db 命令前建表, 只跑一次; 只收 CREATE … IF NOT EXISTS');
  commands.pkgCommandsReset();
  console.warn = () => {};
  commands.registerPackageCommands('todo-test', {
    add: { primitive: 'db', ai: true, sql: 'INSERT INTO items(title) VALUES (?)', params: { title: { type: 'text', required: true } } },
  }, { dbSetup: ['CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, title TEXT)'] });
  commands.registerPackageCommands('bad-setup', {
    add: { primitive: 'db', ai: true, sql: 'INSERT INTO t(x) VALUES (?)', params: { x: {} } },
  }, { dbSetup: ['DROP TABLE t'] });
  console.warn = warn;
  const log = [];
  const ctx2 = { db: (pkg, op, sql) => { log.push(`${pkg}:${op}:${sql.slice(0, 12)}`); return { ok: true, changes: 1 }; } };
  await commands.run('todo-test.add', { title: 'a' }, ctx2);
  await commands.run('todo-test.add', { title: 'b' }, ctx2);
  t('建表在第一次写之前', log[0] === 'todo-test:run:CREATE TABLE', log.join(' / '));
  t('建表只跑一次', log.filter((x) => x.includes('CREATE')).length === 1);
  log.length = 0;
  await commands.run('bad-setup.add', { x: 1 }, ctx2);
  t('不是 CREATE … IF NOT EXISTS 的 db_setup 整个忽略', !log.some((x) => x.includes('DROP')), log.join(' / '));
  commands.pkgCommandsReset();
  console.warn = () => {};
  commands.registerPackageCommands('todo-test', {
    add: { primitive: 'db', ai: true, sql: 'INSERT INTO items(title) VALUES (?)', params: { title: { type: 'text', required: true } } },
    list: { primitive: 'db', ai: true, sql: 'SELECT id, title FROM items' },
    remove: { primitive: 'db', sql: 'DELETE FROM items WHERE id = ?', params: { id: { type: 'int', required: true } } },
  });
  console.warn = warn;

  console.log('\n[2c] 出厂待办簿插件: 开放 add/list/done, 删除只给人');
  const todo = require('../core/config/plugins/todo.json');
  const open = Object.entries(todo.commands).filter(([, d]) => d.ai === true).map(([k]) => k).sort();
  t('开放给人格的是 add/done/list', JSON.stringify(open) === '["add","done","list"]', open.join(','));
  t('开放的 db 命令都写死了 sql', open.every((k) => todo.commands[k].primitive !== 'db' || String(todo.commands[k].sql || '').trim()));
  t('remove 不开放', todo.commands.remove && todo.commands.remove.ai !== true);
  t('钉常驻板', todo.display === 'board');
  t('db_setup 合规', Array.isArray(todo.db_setup) && todo.db_setup.every((x) => /^\s*create\s+table\s+if\s+not\s+exists/i.test(x)));

  console.log('\n[3] 工具: 宿主给了执行器才有 plugin_call');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-plugincall-'));
  const calls = [];
  const b = new Butler(home, { name: '测试插件', isButler: false });
  b.personaOps = { runPluginCommand: async (name, args) => { calls.push({ name, args }); return { ok: true, changes: 1, message: 'write ok' }; } };
  const server = await b.buildMcp();
  const names = Object.keys(server.instance._registeredTools);
  t('注册了 plugin_call', names.includes('plugin_call'));
  t('白名单里有 plugin_call', (b.buildAllowedTools(false) || []).includes('mcp__butler__plugin_call'));
  const handlers = server.instance.server._requestHandlers;
  const call = async (n, a) => String(((await handlers.get('tools/call')({ method: 'tools/call', params: { name: n, arguments: a } },
    { signal: new AbortController().signal })).content || [{}])[0].text || '');
  const ok1 = await call('plugin_call', { id: 'todo-test', command: 'add', args: { title: '买牛奶' } });
  t('开放的命令照调', ok1.startsWith('✅') && calls.length === 1 && calls[0].name === 'todo-test.add', ok1.slice(0, 60));
  const no1 = await call('plugin_call', { id: 'todo-test', command: 'remove', args: { id: 1 } });
  t('只给人点的命令被拒, 并列出能调的', no1.startsWith('⚠️') && no1.includes('add') && calls.length === 1, no1.slice(0, 80));

  const b2 = new Butler(fs.mkdtempSync(path.join(os.tmpdir(), 'butler-plugincall2-')), { name: '无执行器', isButler: false });
  const server2 = await b2.buildMcp();
  t('没给执行器 → 不注册 plugin_call', !Object.keys(server2.instance._registeredTools).includes('plugin_call'));
  t('没给执行器 → 白名单里也没有', !(b2.buildAllowedTools(false) || []).includes('mcp__butler__plugin_call'));

  console.log('\n[4] 包自带的说明: plugin_find 每条带 summary, 查的就是它时给出完整 usage');
  const uiPackages = require('../core/ui-packages');
  uiPackages.registerPackage({ type: 'ui', id: 'say-test', version: '1', title: '跟读', html: '<p>x</p>',
    summary: '朗读打分', usage: '打开时传 args={text}', keywords: 'pronunciation' });
  uiPackages.registerPackage({ type: 'ui', id: 'say-test2', version: '1', title: '跟读二', html: '<p>x</p>' });
  const many = await call('plugin_find', { keyword: 'say-test' });
  t('列表每条带一句说明', many.includes('say-test　跟读') && many.includes('— 朗读打分'), many.slice(0, 160));
  t('关键词就是 id → 给完整用法', many.includes('How to use say-test:\n打开时传 args={text}'));
  const all = await call('plugin_find', {});
  t('列全部时不给完整用法, 只指路', !all.includes('How to use') && all.includes("plugin_find(keyword='say-test')"));
  t('按包的 keywords 也找得到', (await call('plugin_find', { keyword: 'pronunciation' })).includes('How to use say-test'));
  t('没写说明的包照旧只列标题', /say-test2　跟读二　\[single-page\]\n|say-test2　跟读二　\[single-page\]$/.test(all));
  uiPackages.reset();

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
