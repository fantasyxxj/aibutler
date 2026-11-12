// test-sandbox.js — 界面包的沙箱。跑法: node test-sandbox.js
//
// 这套门禁守的不是"沙箱能不能画出东西", 而是**它到底关不关得住**。
// 沙箱的坏法有个共同点: 坏了照样能用, 而且看不出来 —— 加了 allow-same-origin,
// 界面照画; CSP 漏了 connect-src, 界面照画。只有在有人真去拿数据的那天才知道。
// 所以下面每一条断言都对着一个"坏了也不报错"的点。
'use strict';

require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const sandbox = require('./renderer/sandbox.js');
const uiState = require('../core/ui-state.js');
const uiPackages = require('../core/ui-packages.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

const SRC = fs.readFileSync(path.join(__dirname, 'renderer', 'sandbox.js'), 'utf8');
const PKG = { id: 'demo', version: '1', html: '<p id=hi>hello</p>', css: 'p{color:red}', js: 'window.ran=1;' };

/* ─────────── [1] CSP: 沙箱属性挡不住出网, 挡出网的是 CSP ─────────── */
console.log('\n[1] CSP —— 这层唯一挡得住"把屏幕上的东西发出去"的东西');
{
  const doc = sandbox.buildDoc(PKG);
  ok(/default-src 'none'/.test(sandbox.CSP), "default-src 'none'(sandbox 属性本身不挡 fetch)");
  ok(!/unsafe-eval/.test(sandbox.CSP), "没有 'unsafe-eval'(eval 是不受签名管的二次下发入口)");
  ok(!/https?:/.test(sandbox.CSP), 'CSP 里没有任何 http 来源');
  ok(!/connect-src/.test(sandbox.CSP) || /connect-src 'none'/.test(sandbox.CSP),
     "没给 connect-src 开口(default-src 'none' 已经兜住)");
  ok(/form-action 'none'/.test(sandbox.CSP), "form-action 'none'(表单提交是绕开 fetch 的另一条出网路)");
  ok(/base-uri 'none'/.test(sandbox.CSP), "base-uri 'none'(改 base 能把相对路径引到别处)");

  // 位置: CSP 必须在包的任何东西之前, 晚一步就有一段内容不受它管
  const iCsp = doc.indexOf('Content-Security-Policy');
  ok(iCsp > 0 && iCsp < doc.indexOf(PKG.html), 'CSP 排在包的 html 之前');
  ok(iCsp < doc.indexOf(PKG.css), 'CSP 排在包的 css 之前');
  ok(iCsp < doc.indexOf(PKG.js), 'CSP 排在包的 js 之前');
  // 桥必须在包的脚本之前, 否则包一开跑就找不到 butlerUI
  ok(doc.indexOf('butlerUI') < doc.indexOf(PKG.js), '桥排在包的脚本之前');
  ok(doc.includes(PKG.html) && doc.includes(PKG.css) && doc.includes(PKG.js), '包的三段都进了文档');

  const empty = sandbox.buildDoc({ id: 'x', html: '<p>x</p>' });
  ok(/Content-Security-Policy/.test(empty), '没有 css/js 的包照样带 CSP');

  // 包级 media: 只放开 media-src, 别的一字不变
  const radio = sandbox.cspFor({ media: ['https:'] });
  ok(/media-src butler-asset: https:(;|$)/.test(radio), `media 写 https: → media-src 放开任意 https: ${radio.match(/media-src[^;]*/)[0]}`);
  ok(radio.replace(/media-src[^;]*/, '') === sandbox.CSP.replace(/media-src[^;]*/, ''), 'media 只动 media-src, connect-src / img-src 等不变');
  ok(/media-src butler-asset: https:\/\/\*\.jamendo\.com https:\/\/a\.b\.com:8000/.test(sandbox.cspFor({ media: ['*.jamendo.com', 'a.b.com:8000'] })), '域名 / *.域名 / 带端口 → 只放这些 https 地址');
  ok(sandbox.cspFor({}) === sandbox.CSP && sandbox.cspFor({ media: ['http:', 'javascript:', "'unsafe-inline'"] }) === sandbox.CSP, '没声明或写了认不出的, CSP 原样');
  ok(sandbox.buildDoc({ id: 'r', html: '<p>r</p>', media: ['https:'] }).includes('media-src butler-asset: https:'), 'buildDoc 用的是这个包自己的 CSP');
  ok(/media/.test(sandbox.checkUiPayload({ html: '<p>x</p>', media: ['http:'] }) || '') && /media/.test(sandbox.checkUiPayload({ html: '<p>x</p>', media: 'https:' }) || ''), '登记时 media 写错就拒, 说清哪项认不出');
  ok(sandbox.checkUiPayload({ html: '<p>x</p>', media: ['https:', '*.somafm.com'] }) === null, '写对的 media 照收');
}

/* ─────────── [2] iframe 属性: allow-same-origin 一旦混进来这层就白做了 ─────────── */
console.log('\n[2] iframe 的 sandbox 属性');
{
  ok(/allow-scripts/.test(SRC), '源码里给了 allow-scripts(不给的话包的代码根本不跑)');
  ok(!/allow-same-origin/.test(SRC.replace(/allow-same-origin 绝[^\n]*/g, '').replace(/\/\/[^\n]*/g, '')),
     '🔴 源码里没有 allow-same-origin(注释里提到它是在警告, 不算)');
  ok(!/allow-top-navigation|allow-popups|allow-modals|allow-downloads/.test(SRC),
     '没开 top-navigation / popups / modals / downloads');
}

/* ─────────── [3] 认 source 不认 origin ─────────── */
console.log('\n[3] 收消息认的是哪个 window, 不是 origin');
{
  // 无 same-origin 的 iframe, origin 恒为 "null" —— 而**任何**不透明来源都是 "null",
  // 拿它当身份等于谁都能冒充。
  ok(/e\.source !== frame\.contentWindow/.test(SRC), '比对的是 e.source === contentWindow');
  ok(!/e\.origin\s*===|e\.origin\s*!==/.test(SRC), '没有拿 e.origin 做判断');
  ok(/postMessage\(m, '\*'\)/.test(SRC), "往里发用 targetOrigin '*'(不透明来源写死具体值发不进去)");
}

/* ─────────── [4] route(): 沙箱说的每句话都要过一遍 ─────────── */
console.log('\n[4] route —— 从沙箱进来的消息怎么解读');
{
  ok(sandbox.route(null) === null, 'null → 丢');
  ok(sandbox.route('ready') === null, '字符串 → 丢(必须是对象)');
  ok(sandbox.route({ t: 'nope' }) === null, '不认识的类型 → 丢');
  ok(sandbox.route({ t: 'ready' }).act === 'ready', 'ready 认得');
  ok(sandbox.route({ t: 'beat' }).act === 'beat', 'beat 认得');

  ok(sandbox.route({ t: 'resize', h: 200 }).h === 200, 'resize 200 → 200');
  ok(sandbox.route({ t: 'resize', h: 99999 }).h === 4000, 'resize 撑到十万 → 封在 4000(不给它霸占整个窗口)');
  ok(sandbox.route({ t: 'resize', h: 1 }).h === 40, 'resize 撑到 1 → 抬到 40(0 高的框点不着也看不见)');
  ok(sandbox.route({ t: 'resize', h: 'x' }) === null, 'resize 非数字 → 丢');
  ok(sandbox.route({ t: 'resize', h: Infinity }) === null, 'resize Infinity → 丢');

  const c = sandbox.route({ t: 'call', id: 3, name: 'wf_go', args: { wf: 'a', to: 'b' } });
  ok(c.act === 'call' && c.id === 3 && c.name === 'wf_go', 'call 认得, 请求 id 留着(并发时靠它配对)');
  ok(c.args.wf === 'a' && c.args.to === 'b', 'call 的参数带过来了');
  ok(sandbox.route({ t: 'call', name: 'x' }) === null, 'call 没有 id → 丢(回话认不了领)');
  ok(sandbox.route({ t: 'call', id: 1 }) === null, 'call 没有名字 → 丢');

  const nested = sandbox.route({ t: 'call', id: 1, name: 'x', args: { a: { deep: 1 }, b: [1, 2], c: 5 } });
  ok(nested.args.a && nested.args.a.deep === 1 && nested.args.b[1] === 2 && nested.args.a !== undefined, 'call 的结构参数誊写一份带过去(web 的 query / body 靠它)');
  const loop = { }; loop.self = loop;
  const big = { s: 'x'.repeat(sandbox.MAX_STRUCT_ARG + 1) };
  const odd = sandbox.route({ t: 'call', id: 1, name: 'x', args: { loop, big, ok: { v: 1 } } });
  ok(odd.args.loop === undefined && odd.args.big === undefined && odd.args.ok.v === 1, '循环引用 / 超过上限的结构参数丢掉, 其余照收');
  ok(nested.args.c === '5', 'call 的参数一律转成字符串(跟 {{cmd:}} 那条路同一种形状)');

  const p = sandbox.route({ t: 'call', id: 1, name: 'x', args: { op: 'run', sql: 'INSERT INTO t VALUES(?,?)', params: ['张三', 128.5] } });
  ok(Array.isArray(p.args.params) && p.args.params.length === 2 && p.args.params[0] === '张三' && p.args.params[1] === 128.5, 'db 原语的 params 数组放行(标量原样保留)');
  const p2 = sandbox.route({ t: 'call', id: 1, name: 'x', args: { params: [{ a: 1 }] } });
  ok(p2.args.params[0] === '[object Object]', 'params 里再嵌套对象 → String 化, 不带进引用');
}

/* ─────────── [5] state: 有上限, 而且存不下要说 ─────────── */
console.log('\n[5] 包自己存的东西');
{
  ok(sandbox.checkState({ a: 1 }).text === '{"a":1}', '正常对象存得下');
  const big = { s: 'x'.repeat(sandbox.MAX_STATE_BYTES + 10) };
  ok(!!sandbox.checkState(big).bad, `超过 ${sandbox.MAX_STATE_BYTES} 字节 → 拒(不然 while(true) 里存就能写满磁盘)`);
  const cyc = {}; cyc.self = cyc;
  ok(!!sandbox.checkState(cyc).bad, '循环引用 → 拒, 不抛异常');
  ok(!!sandbox.checkState(undefined).bad, 'undefined → 拒');
}

/* ─────────── [6] 形状检查 ─────────── */
console.log('\n[6] 包的形状');
{
  ok(sandbox.checkUiPayload(PKG) === null, '正常包通过');
  ok(!!sandbox.checkUiPayload(null), '空包 → 拒');
  ok(!!sandbox.checkUiPayload({ id: 'a' }), '没有 html → 拒');
  ok(!!sandbox.checkUiPayload({ id: 'a', html: '   ' }), 'html 全是空白 → 拒');
  ok(!!sandbox.checkUiPayload({ id: 'a', html: '<p>x</p>', js: 123 }), 'js 不是文字 → 拒');
}

/* ─────────── [7] 真 DOM: 挂上去以后长什么样 ─────────── */
console.log('\n[7] 真 DOM 挂载');
{
  const dom = new JSDOM('<div id="body"><span class="md-widget" data-kind="ui" data-spec="demo"></span></div>');
  const d = dom.window.document;
  global.window = dom.window;   // sandbox.js 里 addEventListener 挂在 window 上

  const calls = [];
  const sb = sandbox.create({
    document: d,
    strings: () => ({}),
    locale: () => 'ja',
    commandNames: () => ['wf_go'],
    runCommand: async (name, args) => { calls.push({ name, args }); return { ok: true, message: 'done' }; },
    readState: () => ({ seen: 3 }),
    writeState: () => {},
  });

  const node = d.querySelector('.md-widget');
  const h = sb.mount(node, PKG);
  ok(!!h, '挂上了');
  const frame = d.querySelector('iframe.ui-frame');
  ok(!!frame, 'DOM 里出现了 iframe');
  ok(frame.getAttribute('sandbox') === 'allow-scripts', '🔴 sandbox 属性就是 allow-scripts 这一项');
  ok(!frame.hasAttribute('src'), '没有 src(内容走 srcdoc, 不从任何地方加载)');
  ok(/Content-Security-Policy/.test(frame.getAttribute('srcdoc') || ''), 'srcdoc 里带着 CSP');
  ok(!d.querySelector('.md-widget'), '原来那个占位没了(被换掉了)');
  h.destroy();
  ok(!d.querySelector('iframe.ui-frame'), 'destroy 之后 iframe 拆干净了');

  // 形状不对的包: 不留空白, 出红字
  const node2 = d.createElement('span');
  d.getElementById('body').appendChild(node2);
  const r2 = sb.mount(node2, { id: 'bad' });
  ok(r2 === null, '形状不对的包不挂');
  ok(!!d.querySelector('.cmd-error'), '形状不对 → 屏幕上有红字(不静默留一块空白)');

  delete global.window;
}

/* ─────────── [8] ui-state: 一个包一个抽屉 ─────────── */
console.log('\n[8] ui-state 落盘');
{
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'uistate-'));
  const st = uiState.create(dir);

  ok(st.read('a') === null, '没存过 → null');
  ok(st.write('a', { n: 1 }).ok, 'a 存得下');
  ok(st.write('b', { n: 2 }).ok, 'b 存得下');
  ok(st.read('a').n === 1 && st.read('b').n === 2, '🔴 两个包各存各的, 没互相冲掉');
  ok(st.write('a', { n: 9 }).ok && st.read('a').n === 9, '同一个包覆盖自己的');

  const big = { s: 'x'.repeat(uiState.MAX_BYTES + 10) };
  const r = st.write('a', big);
  ok(!r.ok && /太大/.test(r.message), '超上限 → 拒且带理由(界面那侧已挡一道, 这侧是真碰盘的人)');
  ok(st.read('a').n === 9, '被拒之后原来的没被弄坏');
  ok(!st.write('', { x: 1 }).ok, '没有包 id → 拒');

  fs.writeFileSync(path.join(dir, uiState.FILE_NAME), '{ 坏掉的 json');
  ok(uiState.create(dir).read('a') === null, '文件读坏了 → 当空的, 不抛');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ─────────── [9] ui-packages: 界面的代码一个字都不该进 AI ─────────── */
console.log('\n[9] ui-packages 登记处');
{
  uiPackages.reset();
  const r = uiPackages.loadFromPackages({
    accepted: [
      { type: 'ui', id: 'demo', version: '1', title: '演示', html: '<p>x</p>', js: 'var a=1' },
      { type: 'workflow', id: 'line', version: '1', steps: [{ id: 's1', md: 'x' }] },
      { type: 'ui', id: 'broken', version: '1' },
    ],
  });
  ok(r.loaded.length === 1 && r.loaded[0].id === 'demo', '只挑 type=ui 的(手顺包不归这儿管)');
  ok(r.failed.length === 1 && r.failed[0].id === 'broken', '坏的那个单独记账');
  ok(!!uiPackages.get('demo'), 'demo 登记上了');
  ok(uiPackages.get('broken') === null, '坏的没登记(不留半个能挂但画不出的)');
  ok(uiPackages.get('line') === null, '手顺包没被误收');

  const s = uiPackages.summary();
  const text = JSON.stringify(s);
  ok(s.length === 1 && s[0].id === 'demo', '清单里有 demo');
  ok(!/<p>x<\/p>/.test(text) && !/var a=1/.test(text),
     '🔴 给 AI 的清单里没有 html/js(既是白烧的钱, 也是让 AI 照着改一份的口子)');
  ok(uiPackages.get('demo').html === '<p>x</p>', '但沙箱那侧取得到真内容');

  // 装第二批要把上一批冲掉, 否则删掉的包会一直留在内存里
  uiPackages.reset();
  ok(uiPackages.ids().length === 0, 'reset 清干净');
}

/* ─────────── [10] 接线: 少一根就是"能用但永远画不出" ─────────── */
console.log('\n[10] 三根线都接上了没有');
{
  const preload = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  const rend = fs.readFileSync(path.join(__dirname, 'renderer', 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, 'renderer', 'index.html'), 'utf8');
  const md = fs.readFileSync(path.join(__dirname, 'renderer', 'md.js'), 'utf8');

  for (const ch of ['ui-packages', 'ui-state-read', 'ui-state-write']) {
    ok(main.includes(`ipcMain.handle('${ch}'`), `main 有 ${ch}`);
    ok(preload.includes(`'${ch}'`), `preload 暴露了 ${ch}`);
  }
  // 犯过两次的毛病: preload 暴露了, renderer 没接 —— 于是永远没人调, 也永远不报错
  for (const fn of ['uiPackages', 'uiStateRead', 'uiStateWrite']) {
    ok(rend.includes(`window.butler.${fn}(`), `renderer 真的调了 butler.${fn}`);
  }
  ok(html.includes('sandbox.js'), 'index.html 装了 sandbox.js(不装的话 window.UiSandbox 是空的)');
  /* 语言从哪来。S 是字典本身(键全是界面文案), 里面没有"我是哪种语言"这一项 ——
     从 S 上取会静默拿到 undefined, 表现是日语用户的包永远收到中文, 而且不报错。 */
  ok(!/S\._locale|S\.locale\b/.test(rend), '🔴 沙箱的语言不是从字典 S 上取的');
  ok(/payload\.locale/.test(rend), '语言取自主进程回的 payload.locale');
  /* 版本号: preload 跑在沙箱里, require JSON 必然抛, 而 catch 只往 renderer 控制台写一行 ——
     窗口标题于是长期显示「v?」, 谁都不会注意到。同一类"静默失败"要在源码层挡住。 */
  // 先把注释剥掉再扫 —— 否则"别改回 require('./package.json')"这句警告本身会把门禁判红
  const preloadCode = preload.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/require\(['"]\.\/package\.json['"]\)/.test(preloadCode), '🔴 preload 不许 require package.json(沙箱里必然抛)');
  ok(/--butler-version=/.test(preload) && /--butler-version=/.test(main), '版本号由主进程用启动参数递给 preload');
  ok((main.match(/additionalArguments/g) || []).length >= 2, '两个窗口的 webPreferences 都带了版本参数');
  // 比 src= 而不是文件名: 文件顶上的注释里就提到过 renderer.js, 拿裸名字比会比到注释上去
  ok(html.indexOf('src="sandbox.js"') < html.indexOf('src="renderer.js"'),
     'sandbox.js 的 script 标签排在 renderer.js 之前(晚一步 window.UiSandbox 还没有)');
  // 比对 token 列表而不是整串正则字面量: 后者一加新控件就红, 而红的原因跟 ui/pin 毫无关系
  const kinds = ((md.replace(/\\/g, '').match(/\{\{\(([a-z|]+)\)/) || [])[1] || '').split('|');
  ok(kinds.includes('ui') && kinds.includes('pin'), 'md.js 认得 {{ui:}} 和 {{pin:}}');
  ok(rend.includes('mountUi'), 'renderer 把 mountUi 交给了 widgets');
}

/* ─────────── [11] 端到端: 真签的包 → 装 → 起 ─────────── */
// 前面几节都是拿手捏的对象试。这一节走真东西: test/fixtures/ui-demo 那个包是
// build-ui-package 拼的、sign-package 用真私钥签的, 跟以后下发给用户的是同一种。
// 🔴 它是**测试夹具, 不是教学例子** —— 教学例子只留 examples/hello-counter 一份。
//    夹具挪出 examples/ 是有意的: 顶着 examples 名头的旧包会被当成范例抄走(它 18 处硬编码色、
//    0 个 token、没接 onPush, 照它抄出来的就是今天那个白底白字)。
console.log('\n[11] 端到端: 真签的 demo 包');
{
  const packages = require('../core/packages.js');
  const commands = require('../core/commands.js');

  const pkgFile = path.join(__dirname, 'test', 'fixtures', 'ui-demo', 'demo.pkg.json');
  ok(fs.existsSync(pkgFile), 'personal/test/fixtures/ui-demo/demo.pkg.json 在(没有就先 build+sign 一遍)');

  const dataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'uipkg-'));
  const text = fs.readFileSync(pkgFile, 'utf8');

  const inst = packages.install(text, { dataDir });
  ok(inst.ok && inst.type === 'ui' && inst.id === 'demo', `装上了: ${inst.type}/${inst.id}@${inst.version}`);

  const all = packages.loadAll({ dataDir });
  ok(all.accepted.length === 1 && all.rejected.length === 0, '读回来一个, 没有被拒的');

  uiPackages.reset();
  commands.pkgCommandsReset();
  const u = uiPackages.loadFromPackages(all);
  const c = commands.loadFromPackages(all);
  ok(u.loaded.length === 1, '界面包认了');
  ok(c.loaded.length === 1 && c.loaded[0].added.includes('demo.say'), '包带的命令也认了: demo.say');
  ok(commands.catalog()['demo.remember'].channel === 'local', 'demo.remember 的 channel 由宿主定成 local');

  const pkg = uiPackages.get('demo');
  const doc = sandbox.buildDoc(pkg);
  ok(/id="car"/.test(doc), '文档里有那辆车(html 进去了)');
  ok(/@keyframes spin/.test(doc), 'css 进去了');
  ok(/butlerUI\.onInit/.test(doc), '包的 js 进去了');
  ok(doc.indexOf('Content-Security-Policy') < doc.indexOf('id="car"'), 'CSP 仍然排在最前');

  // 🔴 验签不是一次性仪式: 落地之后有人在盘上改了字节, 下次读就该落选。
  // 存的是**整个信封**就是为了这个 —— 只存内容的话, 改完没人知道。
  // 攻击的真实形状: 内容改掉、签名原样留着(改的人没有私钥, 重签不了)。
  // payload 是 base64, 所以要解开改再编回去 —— 直接在文件里搜明文是搜不到的。
  const onDisk = packages.fileOf(dataDir, 'ui', 'demo');
  const env = JSON.parse(fs.readFileSync(onDisk, 'utf8'));
  const inner = Buffer.from(env.payload_b64, 'base64').toString('utf8');
  ok(inner.includes('小车跑起来了'), '(先确认原文里有这句, 免得改了个寂寞)');
  env.payload_b64 = Buffer.from(inner.replace('小车跑起来了', '小车被改过了'), 'utf8').toString('base64');
  fs.writeFileSync(onDisk, JSON.stringify(env));

  const after = packages.loadAll({ dataDir });
  ok(after.accepted.length === 0 && after.rejected.length === 1,
     '🔴 盘上被改过 → 下次读就落选(验签每次都验, 不是装的时候验一回)');
  ok(/sig/i.test(after.rejected[0].code || ''), `落选理由是签名对不上: ${after.rejected[0].code}`);

  uiPackages.reset();
  commands.pkgCommandsReset();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? '✅' : '❌'} sandbox: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
