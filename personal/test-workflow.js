// test-workflow.js — 手顺引擎(个人版)。跑法: node test-workflow.js
//
// 这个门禁盯的不是「能翻页」, 而是几件**翻页看起来正常、实际已经坏了**的事:
//   [3] 往回翻会不会偷偷改掉进度印 —— 坏了的话屏幕上一切正常, 只有记录是错的
//   [5] 包里带函数会不会被执行 —— 那等于验签只证明了"是谁给的", 没证明"内容安全"
//   [7] 翻页会不会去叫 AI —— 坏了只体现在账单上, 屏幕上一模一样
//   [9] 引擎会不会为了第二个手顺被改一行 —— 这是当初拆引擎/定义的唯一判据
'use strict';

require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const os = require('os');
const path = require('path');

const workflow = require('../core/workflow');
const workflowProgress = require('../core/workflow-progress');
const packages = require('../core/packages');
const commands = require('../core/commands');
const { uiStrings } = require('./i18n');

let pass = 0, fail = 0;
const ok = (c, m) => {
  if (c && typeof c.then === 'function') { fail++; console.log(`  ✗ ${m} — ok() 收到了 promise`); return; }
  if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-'));
const progress = workflowProgress.create(path.join(tmp, 'app'));

const { SIGNED_PKG } = require('./fixture-package');   // 真私钥签过的包 · 单一真源(见该文件里的事故说明)

/* ─────────── [1] 签名包 → 引擎, 走通 ─────────── */
console.log('\n[1] 签名包落地后, 引擎就认得这个手顺');
{
  workflow.reset();
  const r = packages.install(SIGNED_PKG, { dataDir: tmp });
  ok(r.ok === true, `包装得上${r.ok ? '' : ' — ' + r.code + ': ' + r.message}`);

  const all = packages.loadAll({ dataDir: tmp });
  const l = workflow.loadFromPackages(all, { progress });
  ok(l.loaded.length === 1 && l.loaded[0].id === 'demo_lesson', '引擎装上了 demo_lesson');
  ok(l.loaded[0].steps === 3, '三步都在');
  ok(workflow.has('demo_lesson', 's2'), 's2 在顺序里');
  ok(!workflow.has('demo_lesson', 'nope'), '不存在的一步不认');

  const sum = workflow.summary('zh-CN');
  ok(sum[0].title === '示例课' && sum[0].firstStep === 's1' && sum[0].total === 3,
     '给 AI 的清单: 标题/第一步/共几屏都对');
}

/* ─────────── [2] 一屏 = 内容 + 导航 ─────────── */
console.log('\n[2] 每屏都带导航, 且首尾形状不同');
{
  const S = uiStrings('zh-CN');
  const first = workflow.view('demo_lesson', 's1', { locale: 'zh-CN' });
  ok(first.includes('第一步'), '首屏有内容');
  ok(!first.includes(`to=s1|label=${S.wf_back}`) && !first.includes(S.wf_back), '首屏没有"上一步"(前面没有了)');
  ok(first.includes(`wf_go|wf=demo_lesson|to=s2|from=s1|mark=done`), '首屏的"下一步"带 done 印');
  ok(first.includes('mark=skipped'), '首屏有"先跳过"');
  ok(first.includes('1 / 3'), '首屏显示 1 / 3');

  const mid = workflow.view('demo_lesson', 's2', { locale: 'zh-CN' });
  ok(mid.includes(`wf_go|wf=demo_lesson|to=s1|label=${S.wf_back}`), '中间屏能往回翻');
  // 🔴 往回翻的按钮**不带 mark** —— 带了的话, 回头看一眼就把记录改写了。
  ok(!/to=s1\|from=s2/.test(mid), '往回翻的按钮不带 from/mark(回看不改记录)');
  ok(mid.includes('2 / 3'), '中间屏显示 2 / 3');

  const last = workflow.view('demo_lesson', 's3', { locale: 'zh-CN' });
  ok(last.includes('wf_finish|wf=demo_lesson|from=s3'), '末屏是"全部完成"不是"下一步"');
  // 末屏还留着"上一步"(也是 wf_go), 所以不能拿 wf_go 判 —— 要判的是**没有往前那一个**:
  // 往前的按钮才带 mark, 末屏一个 mark 都不该有(有就是能翻到不存在的第 4 屏)。
  ok(!last.includes('mark='), '末屏没有往前的按钮(翻不到不存在的第 4 屏)');
  ok(last.includes(`wf_go|wf=demo_lesson|to=s2|label=${S.wf_back}`), '末屏仍能往回翻');
}

/* ─────────── [3] 进度印: 只有按钮打得上, 回看打不上 ─────────── */
console.log('\n[3] 进度印只由按下的按钮产生');
{
  const before = progress.snapshot('demo_lesson', ['s1', 's2', 's3']);
  ok(before.doneCount === 0 && before.skipped === 0, '一开始什么印都没有');

  // 一步都没走过时不给 to, 落第一屏 —— 全新的人不该被丢到中间。
  ok(workflow.go('demo_lesson', {}, { locale: 'zh-CN' }).step === 's1', '没有任何进度时落第一屏');

  workflow.go('demo_lesson', { to: 's2', from: 's1', mark: 'done' }, { locale: 'zh-CN' });
  ok(progress.snapshot('demo_lesson', ['s1', 's2', 's3']).doneCount === 1, '按"下一步"打上了 done');

  workflow.go('demo_lesson', { to: 's3', from: 's2', mark: 'skipped' }, { locale: 'zh-CN' });
  const snap = progress.snapshot('demo_lesson', ['s1', 's2', 's3']);
  ok(snap.doneCount === 1 && snap.skipped === 1, '跳过的事实单独留着, 没和 done 混成一个空白');

  // 往回翻: go 不带 mark, 印一个字都不能动。
  workflow.go('demo_lesson', { to: 's1' }, { locale: 'zh-CN' });
  const after = progress.snapshot('demo_lesson', ['s1', 's2', 's3']);
  ok(after.doneCount === 1 && after.skipped === 1, '往回翻之后印没变');

  ok(fs.existsSync(progress.file()), '印真的落到盘上了(关掉 app 也还在)');
  const reread = workflowProgress.create(path.join(tmp, 'app')).snapshot('demo_lesson', ['s1', 's2', 's3']);
  ok(reread.doneCount === 1 && reread.skipped === 1, '重新读盘拿到的是同一份');

  /* 入口按钮不给 to: 落点由引擎自己从进度取, 不再让 AI 查一趟再递回来。
     此刻 s1=done · s2=skipped · s3=空白, 该续的是 s2(跳过的一步不算做完, 不能跨过去)。 */
  const resumed = workflow.go('demo_lesson', {}, { locale: 'zh-CN' });
  ok(resumed.ok === true && resumed.step === 's2', '不给 to 时落在还没做完的第一屏');
  const untouched = progress.snapshot('demo_lesson', ['s1', 's2', 's3']);
  ok(untouched.doneCount === 1 && untouched.skipped === 1, '这样落一次不会动到印');
}

/* ─────────── [4] 拼错的一步要喊出来, 不能闷头走 ─────────── */
console.log('\n[4] 拼错的名字一律弹回');
{
  const r1 = workflow.go('demo_lesson', { to: 'nope' }, {});
  ok(r1.ok === false && r1.code === 'unknown_step', '去处不存在 → unknown_step');
  const r2 = workflow.go('no_such_wf', { to: 's1' }, {});
  ok(r2.ok === false && r2.code === 'unknown_workflow', '手顺不存在 → unknown_workflow');
  // from 拼错时若默默放行, 结果是"进度永远填不满"而没人知道为什么。
  const r3 = workflow.go('demo_lesson', { to: 's2', from: 'typo', mark: 'done' }, {});
  ok(r3.ok === false && r3.code === 'unknown_step', 'from 拼错也弹回(不然进度永远填不满)');
}

/* ─────────── [5] 包里只能有数据 ─────────── */
console.log('\n[5] 包带不进可执行的东西');
{
  // 就算有人拿到私钥签了一个带 body 函数的包, 装上之后那个函数也不该被当成"这一步怎么画"。
  // JSON 本来就存不下函数 —— 这条守的是"以后有人图省事改成 eval/new Function"。
  const src = require('./kernel-src').readSrc('workflow.js');
  ok(!/\beval\s*\(/.test(src), 'workflow.js 里没有 eval');
  ok(!/new\s+Function\s*\(/.test(src), 'workflow.js 里没有 new Function');
  ok(!/require\s*\(\s*[^'"]/.test(src), 'workflow.js 里没有动态 require');

  // 包里写了 body/mark/finish 也一律无视: 定义是我们从数据现搭的。
  workflow.reset();
  const r = workflow.registerPackage({
    type: 'workflow', id: 'evil', version: '1',
    steps: [{ id: 'a', md: 'A' }],
    body: 'BOOM', finish: 'BOOM',
  }, { progress });
  ok(r.ok === true, '带了多余字段的包照样装(只是那些字段没用)');
  ok(typeof workflow.get('evil').body === 'function', 'body 是引擎搭的函数, 不是包里那根字符串');
  ok(workflow.view('evil', 'a', {}).includes('A'), '画出来的是包里的 md');
}

/* ─────────── [6] 形状不对的包整个不装 ─────────── */
console.log('\n[6] 形状不对就整个不装, 不留半个残疾手顺');
{
  const bad = [
    [{ steps: [] }, '一步都没有'],
    [{ steps: [{ id: 'a b', md: 'x' }] }, 'id 里有空格'],
    [{ steps: [{ id: 'a', md: 'x' }, { id: 'a', md: 'y' }] }, 'id 重复'],
    [{ steps: [{ id: 'a' }] }, '没有 md'],
    [{ steps: [{ id: 'a', md: {} }] }, 'md 是个空对象'],
  ];
  for (const [p, why] of bad) {
    ok(workflow.checkWorkflowPayload({ type: 'workflow', id: 'x', version: '1', ...p }) !== null,
       `挡住: ${why}`);
  }
  ok(workflow.checkWorkflowPayload({
    type: 'workflow', id: 'x', version: '1', steps: [{ id: 'a', md: 'x' }],
  }) === null, '正常的包放行');

  // 一片坏叶子不能让别的手顺一起消失。
  workflow.reset();
  const l = workflow.loadFromPackages({
    accepted: [
      { type: 'workflow', id: 'good', version: '1', steps: [{ id: 'a', md: 'A' }] },
      { type: 'workflow', id: 'broken', version: '1', steps: [] },
      { type: 'knowledge', id: 'other', version: '1' },
    ],
    rejected: [],
  }, { progress });
  ok(l.loaded.length === 1 && l.loaded[0].id === 'good', '好的照装');
  ok(l.failed.length === 1 && l.failed[0].id === 'broken', '坏的单独报出来');
  ok(!workflow.has('other', 'a'), '不是 workflow 类型的包不进引擎');
}

/* ─────────── [7] 翻页不叫 AI ─────────── */
console.log('\n[7] 翻页 0 次模型调用');
{
  ok(commands.notifyAi('wf_go') === false, 'wf_go 不通知 AI(18 屏就是 18 次计费)');
  ok(commands.notifyAi('wf_finish') === true, 'wf_finish 通知 AI(一整件事结束了, 它该知道)');
  const cat = commands.catalog();
  ok(cat.wf_go && cat.wf_go.channel === 'local', 'wf_go 是本机命令(断网也能翻)');
  ok(cat.wf_finish && cat.wf_finish.channel === 'local', 'wf_finish 也不出这台机器(个人版没有平台)');
  for (const [name, decl] of Object.entries(cat)) {
    ok(decl.channel === 'local', `${name} 是 local —— 个人版没有第二条路`);
  }
}

/* ─────────── [8] 走一遍完整的按按钮流程 ─────────── */
console.log('\n[8] 从头按到尾(走命令层, 跟界面点的是同一条路)');
(async () => {
  workflow.reset();
  workflow.loadFromPackages(packages.loadAll({ dataDir: tmp }), { progress });

  const r1 = await commands.run('wf_go', { wf: 'demo_lesson', to: 's1' }, { locale: 'zh-CN' });
  ok(r1.ok && r1.render.includes('第一步'), '第 1 屏');
  const r2 = await commands.run('wf_go', { wf: 'demo_lesson', to: 's2', from: 's1', mark: 'done' }, { locale: 'zh-CN' });
  ok(r2.ok && r2.render.includes('2 / 3'), '第 2 屏');
  const r3 = await commands.run('wf_go', { wf: 'demo_lesson', to: 's3', from: 's2', mark: 'done' }, { locale: 'zh-CN' });
  ok(r3.ok && r3.render.includes('3 / 3'), '第 3 屏');
  const rf = await commands.run('wf_finish', { wf: 'demo_lesson', from: 's3' }, { locale: 'zh-CN' });
  ok(rf.ok === true, '完成');
  ok(rf.message === uiStrings('zh-CN').wf_done, '完成语走界面语言');
  ok(progress.snapshot('demo_lesson', ['s1', 's2', 's3']).doneCount === 3, '三步都记上了');

  // 目录里没有的名字要红字, 不能静默吞。
  const bad = await commands.run('rm_rf', {}, {});
  ok(bad.ok === false && bad.code === 'unknown_command', '目录外的命令弹回');
  const miss = await commands.run('wf_go', { to: 's1' }, {});
  ok(miss.ok === false && miss.code === 'missing_param', '缺必填参数弹回');

  // to 不是必填: 入口按钮只给 wf, 落点由引擎从进度取。此刻三步都 done, 该回到第一屏。
  const entry = await commands.run('wf_go', { wf: 'demo_lesson' }, { locale: 'zh-CN' });
  ok(entry.ok === true && entry.step === 's1', '只给 wf 也走得通(全做完了就回第一屏)');

  /* ─────────── [9] 装第二个手顺, 引擎一行都不用改 ─────────── */
  console.log('\n[9] 第二个手顺不需要动引擎(这是当初拆开的唯一判据)');
  {
    const engineBefore = require('./kernel-src').readSrc('workflow.js');
    const r = workflow.registerPackage({
      type: 'workflow', id: 'second', version: '1',
      title: '第二个', steps: [{ id: 'x', md: 'X' }, { id: 'y', md: 'Y' }],
    }, { progress });
    ok(r.ok === true, '第二个手顺装上了');
    ok(workflow.view('second', 'x', { locale: 'zh-CN' }).includes('1 / 2'), '它自己会算进度条');
    ok(workflow.ids().length === 2, '两个手顺并存, 互不相干');
    ok(require('./kernel-src').readSrc('workflow.js') === engineBefore, '引擎文件一个字节都没动');
  }

  /* ─────────── [10] 语言 ─────────── */
  console.log('\n[10] 跟着界面语言走, 缺翻译不给空白');
  {
    workflow.reset();
    workflow.loadFromPackages(packages.loadAll({ dataDir: tmp }), { progress });
    const ja = workflow.view('demo_lesson', 's1', { locale: 'ja' });
    ok(ja.includes('一歩目'), '日文界面拿到日文那份');
    ok(ja.includes(uiStrings('ja').wf_next), '导航按钮也是日文');
    // s3 没有日文, 但绝不能给一屏空白 —— 空白没法自己诊断, 看到中文至少知道是包没翻译。
    const ja3 = workflow.view('demo_lesson', 's3', { locale: 'ja' });
    ok(ja3 && ja3.includes('收尾'), '缺日文时退到默认语言, 不是空屏');
    const en = workflow.view('demo_lesson', 's3', { locale: 'en' });
    ok(en.includes('Wrap up'), '英文那份取得到');
    // s2 只有一根字符串(不分语言) —— 各语言都该拿到它。
    ok(workflow.view('demo_lesson', 's2', { locale: 'en' }).includes('第二步'), '不分语言的那步各语言通用');
  }

  /* ─────────── [11] 按钮文字里的 | 和 }} ─────────── */
  console.log('\n[11] 按钮文字混进 | 或 }} 要当场炸, 不能烂在屏幕上');
  {
    let threw = false;
    try { workflow.safeLabel('a|b', 'test'); } catch (_) { threw = true; }
    ok(threw, '| 被拦下');
    threw = false;
    try { workflow.safeLabel('a}}b', 'test'); } catch (_) { threw = true; }
    ok(threw, '}} 被拦下');
    threw = false;
    try { workflow.safeLabel('', 'test'); } catch (_) { threw = true; }
    ok(threw, '空字符串被拦下');
    // 三种语言的导航文案实际都得过得了这一关。
    for (const loc of ['zh-CN', 'en', 'ja']) {
      const S = uiStrings(loc);
      for (const k of ['wf_back', 'wf_next', 'wf_skip', 'wf_finish']) {
        ok(!!S[k] && !S[k].includes('|') && !S[k].includes('}}'), `${loc} 的 ${k} 干净且非空`);
      }
      ok(String(S.wf_progress).includes('{i}') && String(S.wf_progress).includes('{n}'),
         `${loc} 的进度条有 {i}/{n} 两个占位`);
      ok(!!S.wf_done, `${loc} 有完成语`);
    }
  }

  /* ─────────── [12] 手顺一个字都不进常驻提示语 ─────────── */
  // 2026-08-20 作者定: 手顺的设计侧知识(翻屏花不花钱 / 拆几屏 / wf_go 怎么拼)属于【流程设计者】。
  // 执行侧人格拿到的是签好名的成品流程, 一屏屏走完就行 —— 那些知识对它没有收件人。
  // 原口径是"装了才讲"(零手顺零注入), 现收紧为"装了也不讲"。
  console.log('\n[12] 手顺不进常驻提示语(装没装都一样)');
  {
    workflow.reset();
    ok(workflow.summary().length === 0, '没装 → 清单是空的');
    const agentSrc = require('./kernel-src').kernelSource();
    ok(!/_workflowSystemPromptBlock/.test(agentSrc), 'agent.js 不再拼手顺提示语块');
    ok(!/prompts\/workflows/.test(agentSrc), '装配处不引用 workflows 模板');
    ok(!fs.existsSync(path.join(__dirname, '../core/config/prompts/workflows.md')), 'workflows.md 已删');
  }

  /* ─────────── [13] 真 DOM 闭环: 点按钮 → 整屏换掉 ─────────── */
  // 只测引擎会漏掉最要命的一段: 引擎再对, 界面没把 catalog/runCommand/renderInto 接上,
  // 屏幕上就是一行"未知命令"红字 —— 行业版为这个栽过一次(门禁全绿, 真机每个按钮都是红的)。
  // 所以这里把 md.js → widgets.js → commands.run → 再渲染 整条路真跑一遍。
  console.log('\n[13] 真 DOM: 点一下就换屏, 全程不叫 AI');
  {
    const vm = require('vm');
    const { JSDOM } = require('jsdom');
    const { window } = new JSDOM('<!doctype html><html><body></body></html>');
    const document = window.document;

    const mdBox = { window: {} };
    vm.createContext(mdBox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'renderer', 'md.js'), 'utf8'), mdBox);
    const renderMarkdown = mdBox.window.renderMarkdown;
    const W = require(path.join(__dirname, 'renderer', 'widgets.js'));

    workflow.reset();
    workflow.loadFromPackages(packages.loadAll({ dataDir: tmp }), { progress });

    const toAI = [];
    let widgets;
    // 跟 renderer.js 里那三行逐字对应: 先塞纯文本, 再整块渲染, 再上控件。
    const renderInto = (node, md) => {
      node.textContent = md;
      node.innerHTML = renderMarkdown(node.textContent);
      widgets.paint(node);
    };
    widgets = W.create({
      document,
      strings: () => uiStrings('zh-CN'),
      catalog: () => commands.catalog(),
      runCommand: async (name, args) => {
        const r = await commands.run(name, args, { locale: 'zh-CN' });
        if (r.ok && commands.notifyAi(name)) toAI.push(name);
        return r;
      },
      sendToAI: (text) => toAI.push(text),
      renderInto,
    });

    // AI 写的开场: 一段话 + 第一屏的入口按钮。
    const body = document.createElement('div');
    body.innerHTML = renderMarkdown('咱们开始吧。\n\n{{cmd:wf_go|wf=demo_lesson|to=s1|label=开始}}');
    widgets.paint(body);

    ok(!body.querySelector('.cmd-error'), '入口按钮没变成红字(目录真的接上了)');
    const entry = body.querySelector('button.cmd-btn');
    ok(!!entry && entry.textContent === '开始', '入口按钮画出来了');

    await entry.click();
    await new Promise((r) => setTimeout(r, 0));
    ok(!!body.querySelector('.wf-panel'), '按下去后出现了手顺框');
    ok(body.textContent.includes('第一步'), '第 1 屏的内容上屏了');
    ok(body.textContent.includes('咱们开始吧'), '气泡里 AI 那段话还在(只换框不换气泡)');
    ok(body.textContent.includes('1 / 3'), '进度条上屏了');

    // 一路按"下一步"到底。
    const clickByText = async (t) => {
      const b = [...body.querySelectorAll('button.cmd-btn')].find((x) => x.textContent === t);
      ok(!!b, `找得到「${t}」按钮`);
      if (b) { await b.click(); await new Promise((r) => setTimeout(r, 0)); }
    };
    await clickByText('下一步');
    ok(body.textContent.includes('第二步') && body.textContent.includes('2 / 3'), '换到第 2 屏');
    await clickByText('下一步');
    ok(body.textContent.includes('第三步') && body.textContent.includes('3 / 3'), '换到第 3 屏');
    ok(toAI.length === 0, '翻到这里为止, 一次都没惊动 AI');

    await clickByText('上一步');
    ok(body.textContent.includes('第二步'), '往回翻也换屏');
    await clickByText('下一步');
    await clickByText('全部完成');
    ok(toAI.length === 1 && toAI[0] === 'wf_finish', '只有"全部完成"通知了 AI');
    ok(progress.snapshot('demo_lesson', ['s1', 's2', 's3']).doneCount === 3, '三步的印都落下了');

    // 反面: 目录里没有的命令必须红字, 不能静默。
    const bad = document.createElement('div');
    bad.innerHTML = renderMarkdown('{{cmd:drop_database|label=按我}}');
    widgets.paint(bad);
    ok(!!bad.querySelector('.cmd-error'), '目录外的命令在屏幕上是红字');
    ok(!bad.querySelector('button.cmd-btn'), '而且压根画不出按钮');
  }

  /* ─────────── [14] 界面那三根线真的接上了 ─────────── */
  console.log('\n[14] renderer 把 catalog / runCommand / renderInto 都接了');
  {
    const src = fs.readFileSync(path.join(__dirname, 'renderer', 'renderer.js'), 'utf8');
    ok(/catalog:\s*\(\)\s*=>\s*cmdCatalog/.test(src), 'catalog 接的是真目录(不再是空对象)');
    ok(/runCommand:/.test(src), 'runCommand 接了');
    ok(/renderInto:/.test(src), 'renderInto 接了(没有它按钮只会变成一行字, 不会换屏)');
    ok(/commandCatalog\(\)/.test(src), '开窗时会去取目录');
    const pre = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
    for (const k of ['commandCatalog', 'runCommand']) {
      ok(new RegExp(`${k}:`).test(pre), `preload 暴露了 ${k}`);
    }
    const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    for (const ch of ['command-catalog', 'run-command']) {
      ok(main.includes(`ipcMain.handle('${ch}'`), `主进程接了 ${ch}`);
    }
    // preload 暴露了而 renderer 没人接 —— 这个坑踩过两次, 这里守住手顺这几根线。
    for (const k of ['commandCatalog', 'runCommand']) {
      ok(src.includes(k), `renderer 真的用了 ${k}(不是暴露完就撂那儿)`);
    }
    ok(!pre.includes('listWorkflows'), '没有暴露没人接的口子');
    // 手顺必须在开人格之前装好 —— 晚一步, 人格 plugin_find 查的就是个空目录, 而它会
    // 据此回一句"没有现成的"然后自己现编一套, 屏幕上完全看不出是装载顺序错了。
    const iLoad = main.indexOf('loadWorkflowPackages()');
    const iOpen = main.indexOf('for (const d of toOpen) openPersona(d)');
    ok(iLoad > 0 && iOpen > 0 && iLoad < iOpen, '装手顺排在开人格之前');
  }

  /* ─────────── [15] 插件目录: 装了哪些只能查, 查完直接给能贴的那一行 ─────────── */
  // 2026-08-20 作者定的插件模型: 一个插件 = 若干页面模板 + (多页时)一份流程定义。
  // AI 常驻只知道"有插件这回事"(靠 plugin_find 的工具说明, 它本来就在上下文里),
  // **装了哪些一个字都不常驻** —— 装十个就每轮为那十个付钱, 而其中九个这辈子用不上。
  console.log('\n[15] 插件目录: 只能查, 且查完不用自己拼语法');
  {
    const pluginCatalog = require('../core/plugin-catalog');
    const uiPackages = require('../core/ui-packages');
    workflow.reset();
    uiPackages.reset();
    ok(pluginCatalog.list().length === 0, '一个都没装 → 目录是空的');

    workflow.loadFromPackages(packages.loadAll({ dataDir: tmp }), { progress });
    uiPackages.registerPackage({ id: 'mathdrill', version: '1', title: '九九练习', html: '<div>x</div>' });

    ok(pluginCatalog.list().length === 2, '手顺包和界面包在同一份目录里(对 AI 是同一件事)');
    const wf = pluginCatalog.get('demo_lesson');
    const ui = pluginCatalog.get('mathdrill');
    ok(wf && wf.kind === 'workflow' && wf.pages > 1, '多屏的标 workflow 且报得出屏数');
    ok(ui && ui.kind === 'ui' && ui.pages === 1, '单页的标 ui · 一页 = 不需要流程定义');

    // entry 是「原样贴进回复就能用」的那一行 —— AI 不该知道 wf_go / {{ui:}} 怎么拼。
    ok(wf.entry.startsWith('{{cmd:wf_go|wf=demo_lesson|') && wf.entry.endsWith('}}'),
       '手顺的入口是拼好的 wf_go 按钮');
    // 目录里的入口是被原样抄走的那一行, 钉死第一屏就等于把走到一半的人送回起点。
    ok(!wf.entry.includes('to='), '入口不钉死屏号, 落点留给引擎按进度定');
    ok(ui.entry === '{{ui:mathdrill}}', '界面的入口是 {{ui:}}');

    ok(pluginCatalog.find('mathdrill').length === 1 && pluginCatalog.find('不存在的东西').length === 0,
       '关键词找得到, 也找得空');
    ok(pluginCatalog.find('').length === 2 && pluginCatalog.find(undefined).length === 2,
       '留空 = 全给(「先看看有啥」是正当问法)');
    ok(pluginCatalog.get('没这个') === null, '没装的返 null(而不是给一行拼错的语法)');

    // 标题是包自己带的, 混进 | 或 }} 会让按钮无声地烂成一段死文字 —— 要到屏幕上才看得出来。
    workflow.reset();
    uiPackages.reset();
    workflow.register('evil', { stepIds: ['a'], body: () => 'x', title: 'a|b}}c' });
    const e = pluginCatalog.get('evil');
    ok(e.entry === '{{cmd:wf_go|wf=evil|label=a/bc}}', '标题里的 | 和 }} 被洗掉');

    const agentSrc = require('./kernel-src').kernelSource();
    ok(/const tools = \[[^\]]*pluginFind[^\]]*pluginOpen/.test(agentSrc), '两个工具真进了 tools 数组');
    const desc = JSON.parse(fs.readFileSync(path.join(__dirname, '../core/config/tools/descriptions.json'), 'utf8'));
    for (const k of ['plugin_find', 'plugin_open']) ok(!!desc[k], `descriptions.json 有 ${k} 的说明`);
    // 工具说明本身就是常驻的那一句 —— 再往提示语里写一份就是第二份副本。
    const promptDir = path.join(__dirname, '../core/config/prompts');
    const prompts = fs.readdirSync(promptDir).map((f) => fs.readFileSync(path.join(promptDir, f), 'utf8')).join('\n');
    ok(!/plugin_find|plugin_open/.test(prompts), '常驻提示语里没有第二份说明');

    workflow.reset();
    uiPackages.reset();
  }

  /* ─────────── [16] 插件能力零常驻 ─────────── */
  // 2026-08-27 作者: 那句常驻提示语拆了。deferred 工具名单每轮本来就把 mcp__butler__plugin_find
  // 的名字摆在 AI 眼前, 它 ToolSearch select 一下就拿到完整 description(插件是什么 / 何时该想到
  // 它 / 查不到怎么办, 全在里头) —— 常驻那一句是同一件事说第二遍。
  console.log('\n[16] 插件能力零常驻');
  {
    ok(!fs.existsSync(path.join(__dirname, '../core/config/main/plugin_hint.md')), '那句常驻提示语的配置文件已删');
    const agentSrc = require('./kernel-src').kernelSource();
    ok(!/_takePluginHint|_pluginHintGiven|plugin_hint/.test(agentSrc), '内核里不再有任何插件常驻注入的残留');
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${fail ? '❌' : '✅'} test-workflow: ${pass} 过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
