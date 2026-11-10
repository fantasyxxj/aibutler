// test-flat-args.js — 工具参数平铺(core/agent/flat-args.js)。运行: node test-flat-args.js
//
// 守三件事: ① 九个工具的 schema 里不再有装参数的嵌套对象(嵌套里的中日文模型会写成 \uXXXX)
// ② 参数直接写在顶层能到达执行处, 中日文原样 ③ 老会话里照旧套 args={…} 的调用照收。
require('./host-wiring');
const fs = require('fs');
const path = require('path');
const os = require('os');
const commands = require('../core/commands');
const uiPackages = require('../core/ui-packages');
const { Butler } = require('../core/agent');
const { gather } = require('../core/agent/flat-args');

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { if (ok) { pass++; console.log(`  ✅ ${name}${extra ? ' · ' + extra : ''}`); } else { fail++; console.error(`  ❌ ${name}${extra ? ' · ' + extra : ''}`); } };

(async () => {
  console.log('\n[1] gather: 顶层键 + 旧 args 合成一份');
  t('只有固定参数 → undefined(回参数表那条路)', gather({ op: 'list' }, ['op']) === undefined);
  t('顶层键收下, 固定参数剔掉', JSON.stringify(gather({ op: 'x', id: 3, text: '予約' }, ['op'])) === '{"id":3,"text":"予約"}');
  t('旧 args 照收', JSON.stringify(gather({ op: 'x', args: { id: 3 } }, ['op'])) === '{"id":3}');
  t('顶层同名压过 args', gather({ op: 'x', args: { id: 3 }, id: 4 }, ['op']).id === 4);

  console.log('\n[2] schema: 九个工具不再声明嵌套参数对象');
  commands.pkgCommandsReset();
  commands.registerPackageCommands('todo-test', {
    add: { primitive: 'db', ai: true, summary: 'add one item', sql: 'INSERT INTO items(title) VALUES (?)',
           params: { title: { type: 'text', required: true } } },
  });
  uiPackages.registerPackage({ type: 'ui', id: 'say-test', version: '1', title: '跟读', html: '<p>x</p>' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-flatargs-'));
  const calls = [];
  const rendered = [];
  const b = new Butler(home, { name: '平铺测试', isButler: true });
  b.personaOps = {
    runPluginCommand: async (name, args) => { calls.push({ name, args }); return { ok: true, changes: 1, message: 'ok' }; },
    renderPlugin: (entry) => { rendered.push(entry); return true; },
  };
  const server = await b.buildMcp();
  const handlers = server.instance.server._requestHandlers;
  const sig = { signal: new AbortController().signal };
  const listed = (await handlers.get('tools/list')({ method: 'tools/list', params: {} }, sig)).tools;
  const NINE = ['task', 'reminder', 'memory_admin', 'persona_admin', 'bus_admin', 'bus_exec', 'run_script', 'plugin_open', 'plugin_call'];
  for (const n of NINE) {
    const s = (listed.find((x) => x.name === n) || {}).inputSchema;
    if (!s) { t(`${n} 已注册`, false); continue; }
    const nested = Object.entries(s.properties || {}).filter(([, v]) => v.type === 'object').map(([k]) => k);
    t(`${n}: 没有嵌套对象参数, 收顶层其余键`, !nested.length && s.additionalProperties !== false, nested.join(','));
  }

  // 拼全部文本段: 结果里有日期时, 出口会在最前另加一段星期(core/agent/tool-dates.js)
  const call = async (n, a) => ((await handlers.get('tools/call')({ method: 'tools/call', params: { name: n, arguments: a } }, sig)).content || [])
    .filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');

  console.log('\n[3] 平铺调用到达执行处, 中日文原样');
  const r1 = await call('plugin_call', { id: 'todo-test', command: 'add', title: '牛乳を買う' });
  t('plugin_call 平铺', r1.startsWith('✅') && calls[0] && calls[0].args.title === '牛乳を買う', r1.slice(0, 60));
  const r2 = await call('plugin_call', { id: 'todo-test', command: 'add', args: { title: '买牛奶' } });
  t('plugin_call 旧 args 照收', r2.startsWith('✅') && calls[1] && calls[1].args.title === '买牛奶');
  await call('plugin_open', { id: 'say-test', text: '君の企画書', lang: 'ja-JP' });
  t('plugin_open 平铺字段进了面板', rendered[0] && rendered[0].includes('|text=君の企画書') && rendered[0].includes('|lang=ja-JP'), rendered[0]);
  await call('task', { op: 'create', subject: '予約を確認する' });
  t('task 平铺', (await call('task', { op: 'list' })).includes('予約を確認する'));
  const tbl = await call('task', { op: 'update' });
  t('task 缺参数回的写法是平铺的', tbl.includes('id=…') && !tbl.includes('args='), tbl.split('\n')[0]);
  const rem = await call('reminder', { op: 'create', text: '复习日语', at: '2099-01-01 09:00' });
  t('reminder 平铺', /#\d/.test(rem) || rem.includes('✅'), rem.split('\n')[0]);
  const ma = await call('memory_admin', { op: 'arbitrate' });
  t('memory_admin 缺参数回的写法是平铺的', ma.includes('memory_admin(op="arbitrate", ') && !ma.includes('args='), ma.split('\n').pop().trim());
  const pa = await call('persona_admin', { op: 'tune', field: 'nope', value: 1 });
  t('persona_admin 平铺参数到达执行处', pa.includes('Invalid field: nope'), pa.split('\n')[0]);

  uiPackages.reset();
  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
