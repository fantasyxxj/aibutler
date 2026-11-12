// test-flat-args.js — 工具参数平铺(core/agent/flat-args.js)。运行: node test-flat-args.js
//
// 守三件事: ① 九个工具的 schema 里不再有装参数的嵌套对象(嵌套里的中日文模型会写成 \uXXXX)
// ② 参数直接写在顶层能到达执行处, 中日文原样 ③ 老会话里照旧套 args={…} 的调用照收
// ④ 平铺的参数写进了 schema(严格按定义出参的模型只生成声明过的键) ⑤ params 文本口袋照收。
require('./host-wiring');
const fs = require('fs');
const path = require('path');
const os = require('os');
const commands = require('../core/commands');
const uiPackages = require('../core/ui-packages');
const { Butler } = require('../core/agent');
const { gather, parseParams } = require('../core/agent/flat-args');

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { if (ok) { pass++; console.log(`  ✅ ${name}${extra ? ' · ' + extra : ''}`); } else { fail++; console.error(`  ❌ ${name}${extra ? ' · ' + extra : ''}`); } };

(async () => {
  console.log('\n[1] gather: 顶层键 + 旧 args 合成一份');
  t('只有固定参数 → undefined(回参数表那条路)', gather({ op: 'list' }, ['op']) === undefined);
  t('顶层键收下, 固定参数剔掉', JSON.stringify(gather({ op: 'x', id: 3, text: '予約' }, ['op'])) === '{"id":3,"text":"予約"}');
  t('旧 args 照收', JSON.stringify(gather({ op: 'x', args: { id: 3 } }, ['op'])) === '{"id":3}');
  t('顶层同名压过 args', gather({ op: 'x', args: { id: 3 }, id: 4 }, ['op']).id === 4);
  t('params 文本按行拆成键值, 只在第一个 = 处切', JSON.stringify(parseParams('name=鶏の唐揚げ\nprice=680\nq=a=b')) === '{"name":"鶏の唐揚げ","price":"680","q":"a=b"}');
  t('params 整段 JSON 也收', parseParams('{"price":680}').price === 680);
  t('params 并进参数, 顶层同名压过它', JSON.stringify(gather({ id: 'm', params: 'name=x\nprice=1', price: 2 }, ['id'])) === '{"name":"x","price":2}');

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

  console.log('\n[2b] schema: 平铺的参数都写进了定义');
  const props = (n) => Object.keys(((listed.find((x) => x.name === n) || {}).inputSchema || {}).properties || {});
  const has = (n, keys) => keys.every((k) => props(n).includes(k));
  t('bus_admin 声明了 to_agent / text / name', has('bus_admin', ['op', 'to_agent', 'text', 'name']), props('bus_admin').join(','));
  t('task 声明了 subject / id / status', has('task', ['op', 'subject', 'id', 'status']));
  t('reminder 声明了 text / at / cron / id', has('reminder', ['op', 'text', 'at', 'cron', 'id']));
  t('memory_admin 声明了 id / winner / loser', has('memory_admin', ['op', 'id', 'winner', 'loser']));
  t('persona_admin 声明了 field / value', has('persona_admin', ['op', 'field', 'value']));
  t('bus_exec 声明了 method / path / params', has('bus_exec', ['command', 'method', 'path', 'params']));
  for (const n of ['plugin_call', 'plugin_open', 'run_script']) t(`${n} 声明了 params 文本口袋`, has(n, ['params']));

  // 拼全部文本段: 结果里有日期时, 出口会在最前另加一段星期(core/agent/tool-dates.js)
  const call = async (n, a) => ((await handlers.get('tools/call')({ method: 'tools/call', params: { name: n, arguments: a } }, sig)).content || [])
    .filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');

  console.log('\n[3] 平铺调用到达执行处, 中日文原样');
  const r1 = await call('plugin_call', { id: 'todo-test', command: 'add', title: '牛乳を買う' });
  t('plugin_call 平铺', r1.startsWith('✅') && calls[0] && calls[0].args.title === '牛乳を買う', r1.slice(0, 60));
  const r2 = await call('plugin_call', { id: 'todo-test', command: 'add', args: { title: '买牛奶' } });
  t('plugin_call 旧 args 照收', r2.startsWith('✅') && calls[1] && calls[1].args.title === '买牛奶');
  const r3 = await call('plugin_call', { id: 'todo-test', command: 'add', params: 'title=鶏の唐揚げ' });
  t('plugin_call 走 params 文本', r3.startsWith('✅') && calls[2] && calls[2].args.title === '鶏の唐揚げ', r3.slice(0, 60));
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

  console.log('\n[4] 空参保护认得平铺工具的必填项');
  const rs = await call('run_script', {});
  t('run_script 不带参数 = 列脚本, 不被当成丢参', !rs.includes('空对象'), rs.split('\n')[0]);
  t('plugin_call 空参照拦(id 必填)', (await call('plugin_call', {})).includes('空对象'));
  t('memory_admin 空参照拦(op 必填)', (await call('memory_admin', {})).includes('空对象'));

  uiPackages.reset();
  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
