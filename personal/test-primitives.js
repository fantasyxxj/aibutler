// test-primitives.js — 包带的命令(热更) + 原语。跑法: node test-primitives.js
//
// 这套守的是「commands.json 能随包热更, 而热更本身安全」这句话到底成不成立。
// 三条结构性的东西, 每一条坏了都不报错:
//   ①内置优先 —— 坏了的表现是"按钮上写着保存草稿, 按下去其实在翻页"
//   ②channel 不从包读 —— 坏了的表现是"数据去了另一个平台", 个人版看不出来, 行业版是真跨越
//   ③名字必须带包前缀 —— 坏了的表现是两个包互相覆盖, 而谁也查不出是谁覆盖了谁
'use strict';

require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const path = require('path');
const commands = require('../core/commands.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

const reset = () => commands.pkgCommandsReset();

/* ─────────── [1] 内置优先: 包不许重定义内置命令 ─────────── */
console.log('\n[1] 内置优先 —— 防标签欺骗');
{
  reset();
  const before = commands.catalog().wf_go;
  ok(!!before, '内置的 wf_go 在目录里');

  // 包想把 wf_go 换成自己的: 改按钮文字, 顺便把 notify_ai 翻成 true
  commands.registerPackageCommands('evil', {
    wf_go: { primitive: 'speak', label_default: '保存草稿', notify_ai: true },
  });
  const after = commands.catalog().wf_go;
  ok(after.label_default === before.label_default, '🔴 wf_go 的按钮文字没被包改掉');
  ok(after.notify_ai === before.notify_ai, '🔴 wf_go 的 notify_ai 没被包改掉');
  ok(after.primitive === undefined, 'wf_go 仍然走内置实现, 不是包挑的原语');
  // 包写的那条并没有消失, 只是它落在自己的前缀下 —— 不覆盖别人, 也不白丢
  ok(!!commands.catalog()['evil.wf_go'], '包那条落在 evil.wf_go 下(不覆盖内置, 也不静默丢)');
  reset();
}

/* ─────────── [2] channel 只能源码定 ─────────── */
console.log('\n[2] channel 不从包读');
{
  reset();
  commands.registerPackageCommands('geo', {
    ship: { primitive: 'speak', channel: 'admin', summary: 'x' },
  });
  const d = commands.catalog()['geo.ship'];
  ok(!!d, 'geo.ship 收下了');
  ok(d.channel === 'local', '🔴 包写的 channel=admin 被丢掉, 一律 local');
  reset();
}

/* ─────────── [3] 名字: 强制带包前缀 ─────────── */
console.log('\n[3] 名字与前缀');
{
  reset();
  const r = commands.registerPackageCommands('geo', { flip: { primitive: 'speak' } });
  ok(r.added.includes('geo.flip'), '收进来时由宿主加前缀 → geo.flip');
  ok(!commands.catalog().flip, '裸名字 flip 不在目录里(包自报的全名不算数)');

  // 两个包各有一个 flip, 互不干扰
  commands.registerPackageCommands('math', { flip: { primitive: 'speak' } });
  ok(!!commands.catalog()['geo.flip'] && !!commands.catalog()['math.flip'],
     '🔴 两个包各有 flip, 各归各(撞名之后谁覆盖谁是查不出来的)');

  const bad = commands.registerPackageCommands('Geo!', { flip: { primitive: 'speak' } });
  ok(!bad.ok, '包 id 不合法 → 整个拒');
  const r2 = commands.registerPackageCommands('geo', { 'a/b': { primitive: 'speak' } });
  ok(r2.rejected.some((x) => x.name === 'a/b'), '命令名带斜杠 → 拒(它会变成文件名/前缀的一部分)');
  reset();
}

/* ─────────── [4] 原语是能力上限: 包挑不出新的 ─────────── */
console.log('\n[4] 原语 —— 能力的真实上限');
{
  reset();
  const r = commands.registerPackageCommands('geo', {
    a: { primitive: 'speak' },
    b: { primitive: 'exec' },
    c: { primitive: '' },
    d: { summary: '没写 primitive' },
  });
  ok(r.added.includes('geo.a'), 'primitive=speak 收下');
  ok(r.rejected.some((x) => x.name === 'b'), '🔴 primitive=exec 拒(表里没有就是没有)');
  ok(r.rejected.some((x) => x.name === 'c'), 'primitive 空 → 拒');
  ok(r.rejected.some((x) => x.name === 'd'), '没写 primitive → 拒(不给默认值: 默认值就是漏)');

  const names = Object.keys(commands.PRIMITIVES).sort();
  ok(JSON.stringify(names) === JSON.stringify(
       ['ai_access', 'asset', 'bus', 'db', 'mail', 'message', 'pron', 'record', 'save_file', 'secret', 'speak', 'state', 'web']),
     `原语就这十三个: ${names.join(' / ')}`);

  // —— message: 沙箱通往 AI 的唯一一条路(2026-08-21 新增) ——
  // 在它之前, 包里填的东西没有任何办法送到模型那儿, 而失败的样子是"念了一段但 AI 什么都没收到"。
  reset();
  commands.registerPackageCommands('form', {
    submit: { primitive: 'message' },
    quiet: { primitive: 'message', notify_ai: false },
    say: { primitive: 'speak' },
    mark: { primitive: 'state' },
  });
  ok(commands.notifyAi('form.quiet') === true,
     '🔴 message 声明成 notify_ai:false 也强制通知 —— 否则是白调一次且不报错的静默陷阱');
  ok(commands.notifyAi('form.say') === false,
     '🔴 speak 默认不通知 AI(它的 message 是空串, 通知过去只是个光秃秃的命令名)');
  ok(commands.notifyAi('form.mark') === false, '🔴 state 默认不通知 AI(同样是空 message)');

  // 白名单: 包声明里不认识的字段一律不进目录
  reset();
  commands.registerPackageCommands('geo', {
    x: { primitive: 'speak', handler: 'require("fs")', endpoint: 'http://evil', summary: 'ok' },
  });
  const d = commands.catalog()['geo.x'];
  ok(d.summary === 'ok', '认识的字段(summary)收下');
  ok(d.handler === undefined && d.endpoint === undefined,
     '🔴 不在白名单上的字段(handler/endpoint)一律丢掉');
  reset();
}

/* ─────────── [5] 认识名字但没实现 → 天然封顶 ─────────── */
console.log('\n[5] 天然封顶: 目录能热更, 实现不能');
{
  reset();
  const src = require('./kernel-src').readSrc('commands.js');
  ok(/not_implemented/.test(src), 'run() 里留着 not_implemented 这条路');
  // 直接验行为: 目录里凭空多一条没实现的, 跑起来必须红字而不是静默
  commands.registerPackageCommands('geo', { ghost: { primitive: 'speak' } });
  ok(!!commands.catalog()['geo.ghost'], '目录里有 geo.ghost');
  reset();
}

/* ─────────── [6] 原语各自的死约束 ─────────── */
console.log('\n[6] 原语自己守自己 —— 目录里的 params 不是防线');
(async () => {
  reset();
  commands.registerPackageCommands('geo', {
    say: { primitive: 'speak' },          // 故意不写 params: 包可以把校验删光
    dump: { primitive: 'save_file' },
    note: { primitive: 'state' },
  });

  const spoken = [];
  const saved = [];
  const stated = [];
  const ctx = {
    locale: 'zh-CN',
    speak: async (t) => { spoken.push(t); },
    saveFile: async (n, c) => { saved.push({ n, c }); return { ok: true, path: '/tmp/' + n }; },
    uiState: (pkg, k, v) => { stated.push({ pkg, k, v }); return { ok: true }; },
  };

  // speak
  let r = await commands.run('geo.say', { text: '你好' }, ctx);
  ok(r.ok && spoken[0] === '你好', 'speak 念出来了');
  r = await commands.run('geo.say', {}, ctx);
  ok(!r.ok, '🔴 目录里没声明 required, 原语自己仍然挡住了空内容');
  r = await commands.run('geo.say', { text: '<hidden>偷偷念</hidden>' }, ctx);
  ok(!r.ok, '🔴 speak 不收标签(能写 SSML 就能让"念的"和"看见的"不是一回事)');
  r = await commands.run('geo.say', { text: 'x'.repeat(3000) }, ctx);
  ok(!r.ok, 'speak 太长 → 拒');
  r = await commands.run('geo.say', { text: '你好' }, { locale: 'zh-CN' });
  ok(!r.ok && r.code === 'no_voice', '宿主没给朗读能力 → 说清楚, 不假装念了');

  // message —— 沙箱通往 AI 的唯一一条路。它不碰外界, 所以连 ctx 都不需要。
  commands.registerPackageCommands('form', { submit: { primitive: 'message' } });
  r = await commands.run('form.submit', { text: '姓名: 张三' });
  ok(r.ok && r.message === '姓名: 张三',
     '🔴 message 把内容原样交回 —— 能到 AI 那儿的只有这个 message, 空了就等于没说');
  r = await commands.run('form.submit', { text: '<b>张三</b>' });
  ok(!r.ok && r.code === 'bad_param',
     '🔴 message 不收标签(收了包就能往对话里塞 HTML, 屏上写的和送出去的成两回事)');
  r = await commands.run('form.submit', { text: '   ' });
  ok(!r.ok && r.code === 'missing_param', 'message 空内容 → 拒');

  // save_file
  r = await commands.run('geo.dump', { filename: 'a.txt', content: 'hi' }, ctx);
  ok(r.ok && saved[0].n === 'a.txt', 'save_file 存下了');
  r = await commands.run('geo.dump', { filename: '../../etc/passwd', content: 'x' }, ctx);
  ok(!r.ok, '🔴 文件名里带路径 → 拒(存哪儿只能由用户在系统保存框里定)');
  r = await commands.run('geo.dump', { filename: 'a/b.txt', content: 'x' }, ctx);
  ok(!r.ok, '文件名里带斜杠 → 拒');
  r = await commands.run('geo.dump', { filename: 'big.txt', content: 'x'.repeat(3 * 1024 * 1024) }, ctx);
  ok(!r.ok, 'save_file 内容超 2MB → 拒');

  // state
  r = await commands.run('geo.note', { key: 'lv', value: '3' }, ctx);
  ok(r.ok && stated[0].pkg === 'geo' && stated[0].k === 'lv', 'state 记下了');
  ok(stated[0].pkg === 'geo', '🔴 抽屉按"哪个包声明的这条命令"认');
  // 包想去写别人的抽屉: 参数里写 pkg 也没用, 原语根本不看这个参数
  r = await commands.run('geo.note', { key: 'x', value: '1', pkg: 'math' }, ctx);
  ok(stated[1].pkg === 'geo', '🔴 参数里写 pkg=math 不算数, 还是写进 geo 自己的抽屉');
  r = await commands.run('geo.note', {}, ctx);
  ok(!r.ok, 'state 没有 key → 拒');

  // 目录里没有的名字
  r = await commands.run('nope', {}, ctx);
  ok(!r.ok && r.code === 'unknown_command', '目录里没有的名字 → unknown_command');

  /* ─── bus 原语: 能力由宿主注入, 端点只从声明读 ───
     ①个人版没有那条路, 所以同一张原语表在这边就是"没有" —— 跟 db/saveFile 同一个套路。
     ②端点从 decl.http 读而不是从参数读: 声明随包签名, 参数是界面现填的。
       这一条坏了的表现是"包能叩任何一个端点", 而且不报错。
     ③**包里没有"道具"这个概念** —— 曾经声明里写的是道具名, 由一份 tools.json 查出端点。
       那层帐面已经取消, 端点直接写在这条命令的声明里。 */
  console.log('\n[5] bus 原语 —— 能力靠宿主注入, 端点只从声明读');
  reset();
  const GEO_HTTP = { method: 'GET', path: '/bus/v1/geo/rows' };
  commands.registerPackageCommands('geo', { rows: { primitive: 'bus', http: GEO_HTTP } });
  r = await commands.run('geo.rows', {}, { locale: 'zh-CN' });
  ok(!r.ok && r.code === 'no_bus', '🔴 个人版没注入 bus → no_bus(原语在, 但这台机器没有那条路)');
  const called = [];
  const busCtx = { locale: 'zh-CN',
                   bus: async (pkg, http, a) => { called.push({ pkg, http, a }); return { ok: true, data: [1, 2] }; } };
  r = await commands.run('geo.rows', { date: 'today' }, busCtx);
  ok(r.ok && r.data && r.data.length === 2, '注入了 bus 就叩得通, 数据走 data');
  ok(r.message === '', '🔴 数据不进 message(那是通往 AI 的路, 三十行表塞进去是白烧一轮)');
  ok(called[0].http.path === GEO_HTTP.path && called[0].pkg === 'geo', '端点来自声明');
  r = await commands.run('geo.rows', { http: { method: 'DELETE', path: '/bus/v1/everything' } }, busCtx);
  ok(called[1].http.path === GEO_HTTP.path, '🔴 参数里写 http= 不算数, 叩的还是声明里那个');
  ok(commands.notifyAi('geo.rows') === false, 'bus 默认不惊动 AI');
  reset();
  commands.registerPackageCommands('geo', { bare: { primitive: 'bus' } });
  r = await commands.run('geo.bare', {}, busCtx);
  ok(!r.ok && r.code === 'unknown_command', '没声明端点的 bus 命令 → 登记那一刻就被拒(不等按下去才发现)');
  reset();
  const outOfCage = commands.registerPackageCommands('geo', {
    esc: { primitive: 'bus', http: { method: 'GET', path: '/admin/v1/everything' } } });
  ok(outOfCage.added.length === 0 && outOfCage.rejected.length === 1,
     '🔴 /bus/v1/ 以外的 path 登记不进去(安全笼: 禁任意代理)');
  {
    const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    const seg = (mainSrc.split("ipcMain.handle('run-command'")[1] || '').slice(0, 1200);
    ok(!/\bbus:/.test(seg), '🔴 个人版的 run-command 没注入 bus(注入了就等于给包开了一条出网的路)');
  }

  reset();
  console.log(`\n${fail === 0 ? '✅' : '❌'} primitives: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
