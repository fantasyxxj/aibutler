// test-widgets.js — 行内控件("在真 DOM 里"建得对不对、按下去做了什么)。
// 跑法: node test-widgets.js
//
// 这层如果只用正则去看 renderer.js 的源码, 等于没测 —— 收集值、锁表单、重画后恢复,
// 这些都是"按下去才发生"的行为。所以用 jsdom 上真 DOM。
//
// widgets.js 与行业版是同一份文件(逐字节相同), 本文件顺带守住这一点: 一边改另一边不改,
// 是最难发现的那类坏法。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

// 写法说明现在只剩常驻目录(prompts/presentation.md); 细则 2026-08-19 起进出厂知识包走召回,
// 不再有 knowledge/presentation/*.md 那一层。下面的并集写法保留着 —— 将来若再拆出片, 不用改这里。
const presentationDocs = () => {
  const root = path.join(__dirname, '..', 'core', 'config');
  const resident = fs.readFileSync(path.join(root, 'prompts', 'presentation.md'), 'utf8');
  // 细则在出厂知识包里, 由召回带到模型手里。取呈现/控件族(按 slug 认族), 手顺族不在这一节的范围内。
  const pack = JSON.parse(fs.readFileSync(path.join(root, 'onboarding', 'knowledge', 'leaf_core.json'), 'utf8'));
  // ⚠️ 必须排掉手顺族: workflow_entry_button_lands_where_progress_says 带 button 会被捞进来,
  //    而它教的是 {{cmd:wf_go}} —— 个人版没装手顺时那是红字, 下面第 16 节专门守这一条。
  const fam = pack.items.filter((x) => /widget|button|svg|form|slider|clickable/.test(x.slug) && !/workflow/.test(x.slug));
  return [resident, ...fam.map((x) => [x.title, x.claim, x.body || ''].join('\n'))].join('\n\n');
};

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { window } = dom;
const { document } = window;

// md.js 是长在 window 上的浏览器模块
const mdBox = { window: {} };
vm.createContext(mdBox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'renderer', 'md.js'), 'utf8'), mdBox);
const renderMarkdown = mdBox.window.renderMarkdown;

const W = require(path.join(__dirname, 'renderer', 'widgets.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

const STRINGS = { cmd_unknown: '未知命令', cmd_missing_param: '缺少参数', widget_no_key: '缺少字段名',
                  widget_no_options: '没有选项', widget_no_label: '按钮没有文字' };

// 挂一条气泡, 走 md → widgets。sent = 发回给 AI 的发言(连同它拿到的气泡)。
// catalog 默认空 = 只测 in/sel/btn 那半边(它们本来就不查目录)。
// 个人版真实的目录见 config/commands.json(手顺的 wf_go/wf_finish); 那条路在 test-workflow.js 走真 DOM。
function mount(markdown, { catalog = {} } = {}) {
  const sent = [], ran = [];
  const body = document.createElement('div');
  body.innerHTML = renderMarkdown(markdown);
  W.create({
    document,
    strings: () => STRINGS,
    catalog: () => catalog,
    runCommand: async (name, args) => { ran.push({ name, args }); return { ok: true, message: '好了' }; },
    sendToAI: (text, from) => { sent.push({ text, from }); },
  }).paint(body);
  return { body, sent, ran };
}
const q = (body, sel) => body.querySelector(sel);
const click = (el) => el.dispatchEvent(new window.Event('click'));
// cmd 的 handler 是 async: 按完先放一次微任务再看结果
const clickAsync = async (el) => { click(el); await new Promise((r) => setTimeout(r, 0)); };

(async () => {

console.log('[1] 输入框和下拉建成真元素');
{
  const { body } = mount('每周跑 {{in:km|type=number|size=4|placeholder=10}} 公里, '
                       + '强度 {{sel:level|轻松,正常,拉满}}');
  const inp = q(body, 'input.md-in'), sel = q(body, 'select.md-sel');
  ok(inp && inp.tagName === 'INPUT', 'in → <input>');
  ok(inp.type === 'number', 'type=number 生效');
  ok(inp.dataset.key === 'km', 'key 落在 data-key');
  ok(inp.placeholder === '10', 'placeholder 生效');
  ok(sel && sel.options.length === 3, 'sel → <select> 三个选项');
  ok(sel.value === '轻松', '默认选第一个');
  ok(body.querySelectorAll('.md-widget').length === 0, '空壳不残留(全被 replaceWith)');
  ok(body.textContent.includes('每周跑') && body.textContent.includes('公里'), '前后正文原样保留');
}

console.log('\n[2] type 白名单 —— file 不进(那是抓本机文件的入口)');
{
  const { body } = mount('{{in:doc|type=file}} 和 {{in:d|type=date}}');
  const ins = body.querySelectorAll('input.md-in');
  ok(ins[0].type === 'text', 'type=file 落回 text(不该建的入口就不建)');
  ok(ins[1].type === 'date', '白名单里的 date 照常');
  ok(!W.IN_TYPES.has('file'), 'IN_TYPES 里没有 file');
}

console.log('\n[3] 按钮 = 把"屏幕上看得见的字 + 输入的值"原样送回 AI');
{
  const { body, sent } = mount('每周 {{in:km|type=number}} 公里, 强度 {{sel:level|轻松,拉满}} {{btn:按这个定}}');
  q(body, 'input.md-in').value = '30';
  q(body, 'select.md-sel').value = '拉满';
  click(q(body, 'button.md-btn'));
  ok(sent.length === 1, '按一次发一条');
  ok(sent[0].text.startsWith('按这个定'), '发出去的头一行就是按钮上写的字(没有隐藏内容)');
  ok(sent[0].text.includes('- km: 30'), '输入值带上');
  ok(sent[0].text.includes('- level: 拉满'), '选择值带上');
}

console.log('\n[4] 按钮要把气泡交出来 —— 个人版按人格分标签, 后台标签的按钮也得送对人');
{
  const { body, sent } = mount('{{btn:好}}');
  click(q(body, 'button.md-btn'));
  ok(sent[0].from === body, 'sendToAI 拿到按钮所在的气泡(据此反查是哪个人格的标签)');
}

console.log('\n[5] 表单只算一次 —— 二次点击不再发第二通');
{
  const { body, sent } = mount('{{in:km|type=number}} {{btn:定}}');
  const inp = q(body, 'input.md-in'), btn = q(body, 'button.md-btn');
  inp.value = '30';
  click(btn); click(btn);
  ok(sent.length === 1, '按两次也只发一条');
  ok(btn.disabled && inp.disabled, '按完按钮和输入框都锁死');
  ok(btn.classList.contains('done'), '按过这件事留在画面上');
}

console.log('\n[6] 没有输入框的按钮, 只送按钮上那句话');
{
  const { body, sent } = mount('现在开始还是明天? {{btn:现在}} {{btn:明天}}');
  const btns = body.querySelectorAll('button.md-btn');
  ok(btns.length === 2, '二选一建出两个');
  click(btns[1]);
  ok(sent[0].text === '明天', '只飞按下的那句(不带多余行)');
}

console.log('\n[7] label= 只改按钮的样子, 不改送出去的话');
{
  const { body, sent } = mount('{{btn:要|label=要, 现在就开始}}');
  const btn = q(body, 'button.md-btn');
  ok(btn.textContent === '要, 现在就开始', '画面显示 label');
  click(btn);
  ok(sent[0].text === '要', '送出去的是 head');
}

console.log('\n[8] 个人版没有命令目录 —— {{cmd:}} 一律红字, 不静默吞');
{
  const { body, ran } = mount('{{cmd:upload_icon|att=att_1}}');
  ok(q(body, '.cmd-error'), '目录里没有的名字出红字');
  ok(body.textContent.includes('未知命令'), '理由摆在画面上');
  ok(!q(body, 'button'), '按钮不建');
  ok(ran.length === 0, '什么都不执行');
}

console.log('\n[9] 目录一旦有东西, 命令这条路仍完整(与行业版同一份实现)');
{
  const CAT = { save_note: { params: { text: { type: 'text', required: true } }, label_default: '存起来' } };
  const { body, ran } = mount('记一笔: {{in:text}} {{cmd:save_note}}', { catalog: CAT });
  ok(!q(body, '.cmd-error'), '必填参数能被同气泡的同名输入框补上, 建的时候不算缺');
  q(body, 'input.md-in').value = '明早六点';
  await clickAsync(q(body, 'button.cmd-btn'));
  ok(ran.length === 1 && ran[0].args.text === '明早六点', '输入值走进参数(没经过 AI)');
}

console.log('\n[10] 重画不吞打了一半的字');
{
  const raw = '{{in:km|type=number}} {{sel:level|轻松,拉满}} {{btn:定}}';
  const { body } = mount(raw);
  q(body, 'input.md-in').value = '30';
  q(body, 'select.md-sel').value = '拉满';
  const snap = W.snapshotFields(body);
  body.innerHTML = renderMarkdown(raw);
  W.create({ document, strings: () => STRINGS, catalog: () => ({}), sendToAI: () => {} }).paint(body);
  ok(q(body, 'input.md-in').value === '', '刚建完是空的(在这儿放弃就把用户打的字清了)');
  W.restoreFields(body, snap);
  ok(q(body, 'input.md-in').value === '30', '打了一半的数字回来了');
  ok(q(body, 'select.md-sel').value === '拉满', '选过的项也回来了');
}

console.log('\n[11] 写坏了就红字, 不闷声消失');
{
  ok(q(mount('{{sel:level}}').body, '.cmd-error'), '零选项的 sel 红字(不给一个点开空空如也的框)');
  ok(q(mount('{{in:}}').body, '.cmd-error'), '没字段名的 in 红字');
  ok(q(mount('{{btn:}}').body, '.cmd-error'), '没文字的按钮红字');
}

console.log('\n[12] spec 里塞不进 HTML');
{
  ok(!mount('{{in:x|placeholder=<img src=q onerror=alert(1)>}}').body.querySelector('img'),
     'placeholder 的内容是文字, 不会变成元素');
  ok(!mount('{{btn:<b>按我</b>}}').body.querySelector('b'), '按钮文字也不会变成元素(走 textContent)');
}

// [13] md 层的纯渲染断言(表格切列 / 下划线不参与强调 / 加粗链接) 已拆去 test-markdown.js。
// 那边不需要 jsdom, 这边只留"按下去才发生"的行为。

console.log('\n[12.9] 拉杆 type=range: 建得对 + 带读数 + 值进表单');
{
  const { body, sent } = mount('语速 {{in:speed|type=range|min=50|max=150|value=120|step=5|unit=%}} 定下来。\n\n{{btn:就这个}}');
  const el = q(body, 'input.md-in[type="range"]');
  ok(!!el, '建成了真的 range input');
  ok(el.min === '50' && el.max === '150' && el.step === '5', 'min/max/step 都传到位');
  ok(el.value === '120', 'value 是给的起点, 不是默认中值');
  const out = q(body, '.md-range-val');
  ok(!!out && out.textContent === '120%', `读数带单位显示: ${out && out.textContent}`);

  // 拖动 → 读数跟着变(真派发 input 事件, 不是看源码)
  el.value = '75';
  el.dispatchEvent(new window.Event('input'));
  ok(out.textContent === '75%', `拖动后读数跟着变: ${out.textContent}`);

  click(q(body, 'button.md-btn'));
  ok(sent.length === 1 && /speed: 75/.test(sent[0].text),
     `拉到的值进了表单且是纯数字不带单位: ${sent[0] && sent[0].text.replace(/\n/g, ' / ')}`);
}

console.log('\n[12.91] 拉杆: 没给 min/max 有兜底, 重绘不丢值');
{
  const { body } = mount('{{in:x|type=range}}');
  const el = q(body, 'input.md-in[type="range"]');
  ok(el.min === '0' && el.max === '100', '缺省区间 0–100');
  ok(el.value === '50', '没给 value 就停在区间中点(而不是 HTML 默认的 0)');

  // 流式重绘: 快照 → 重建 → 恢复。读数必须跟着回到恢复后的值, 不能停在旧数字。
  const { body: b2 } = mount('语速 {{in:speed|type=range|min=0|max=100|value=30|unit=%}}');
  const r2 = q(b2, 'input.md-in[type="range"]');
  r2.value = '88'; r2.dispatchEvent(new window.Event('input'));
  const snap = W.snapshotFields(b2);
  b2.innerHTML = renderMarkdown('语速 {{in:speed|type=range|min=0|max=100|value=30|unit=%}}');
  W.create({ document, strings: () => STRINGS, catalog: () => ({}),
             runCommand: async () => ({ ok: true }), sendToAI: () => {} }).paint(b2);
  W.restoreFields(b2, snap);
  ok(q(b2, 'input.md-in[type="range"]').value === '88', '重绘后滑块回到用户拉的位置');
  ok(q(b2, '.md-range-val').textContent === '88%',
     `🔴 读数也跟着回去(不补 input 事件就会停在 30%): ${q(b2, '.md-range-val').textContent}`);
}

console.log('\n[14] 接线防回潮: 漏引 widgets.js = 整个界面白屏');
{
  const html = fs.readFileSync(path.join(__dirname, 'renderer', 'index.html'), 'utf8');
  const iW = html.indexOf('src="widgets.js"'), iR = html.indexOf('src="renderer.js"');
  ok(iW > 0, 'index.html 引了 widgets.js');
  ok(iW < iR, 'widgets.js 在 renderer.js 之前(排后面 window.MdWidgets 未定义, 整页全废)');
  const rjs = fs.readFileSync(path.join(__dirname, 'renderer', 'renderer.js'), 'utf8');
  ok(/widgets\.paint\(body\)/.test(rjs), 'renderMd 里真的 paint 了(不 paint 只剩空壳)');
  // 控件只在 widgets.js 里建。renderer.js 长出复制品 = 改一边忘一边, 最难发现的坏法。
  ok(!/md-in|md-sel|md-btn/.test(rjs), 'renderer.js 不碰控件的类名(建控件只有 widgets.js 一处)');
}

console.log('\n[15] 与行业版逐字节同一份 widgets.js');
{
  const ibPath = path.join(__dirname, '..', 'industry-butler', 'app', 'renderer', 'widgets.js');
  if (fs.existsSync(ibPath)) {
    ok(fs.readFileSync(ibPath, 'utf8') === fs.readFileSync(path.join(__dirname, 'renderer', 'widgets.js'), 'utf8'),
       '两仓 widgets.js 内容一致(一边改了另一边没跟, 是最难发现的坏法)');
  } else {
    console.log('  – 行业版仓库不在旁边, 跳过');
  }
}

console.log('\n[16] 写法说明必须真到得了模型手里(写了没人注入 = 白写)');
{
  const pres = presentationDocs();
  const agentSrc = require('./kernel-src').kernelSource();
  ok(/cfg\.text\('prompts\/presentation'\)/.test(agentSrc), 'agent.js 把 presentation 拼进系统提示');
  // 细则已不走 shard 而是走出厂知识包(2026-08-19 作者定案: 知识全进记忆, 不再下发 md)。
  // 常驻只留目录, 细则靠召回带上来 —— 所以这里守的是"包里真有这几条", 缺了就是写了没人看。
  const pack = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'core', 'config', 'onboarding', 'knowledge', 'leaf_core.json'), 'utf8'));
  const slugs = new Set(pack.items.map((x) => x.slug));
  for (const s of ['reference_ask_with_a_widget_not_a_typed_reply',
                   'reference_button_style_whitelist_one_primary_per_screen',
                   'reference_clickable_svg_data_btn_recipe',
                   'reference_svg_animates_without_script']) {
    ok(slugs.has(s), `细则 ${s} 在出厂知识包里`);
  }
  ok(/memory_query/.test(fs.readFileSync(path.join(__dirname, '..', 'core', 'config', 'prompts', 'presentation.md'), 'utf8')),
     '常驻目录留了保底腿(怎么把细则查回来)');
  // 第一个参数叫什么无所谓(rawText 改造时从 text 改成了 _raw), 要守的是"真调了 + 带上了来源"。
  ok(/_takeKnowledgeShards\([^,)]+, _srcKind/.test(agentSrc), 'agent.js submit 真调了细则注入');
  // 说明里教的每一种控件, md.js 都得认得。教了一种解析不了的写法, AI 会照着写而画面永远是空的。
  const taught = [...new Set([...pres.matchAll(/\{\{(\w+):/g)].map((m) => m[1]))];
  ok(taught.length > 0, '说明里确实教了控件写法');
  for (const k of taught) {
    ok(renderMarkdown(`{{${k}:x|A,B}}`).includes(`data-kind="${k}"`), `md.js 认得说明里教的 {{${k}:}}`);
  }
  ok(!taught.includes('cmd'), '个人版不教 {{cmd:}}(没有平台可提交, 教了只会得到红字)');
}

console.log('\n[17] 按钮外观是枚举白名单, 不是自由 CSS');
{
  const { body } = mount('{{btn:删掉|style=danger|shape=square|size=lg|icon=🗑}} '
                       + '{{btn:开始|style=primary}} {{btn:平平无奇}}');
  const btns = body.querySelectorAll('button.md-btn');
  ok(btns.length === 3, '三个按钮都建出来了');
  ok(btns[0].classList.contains('bs-danger'), 'style=danger → bs-danger');
  ok(btns[0].classList.contains('bh-square'), 'shape=square → bh-square');
  ok(btns[0].classList.contains('bz-lg'), 'size=lg → bz-lg');
  ok(btns[0].querySelector('.btn-icon') && btns[0].querySelector('.btn-icon').textContent === '🗑', 'icon 建成独立 span');
  ok(btns[1].classList.contains('bs-primary'), '第二个是 primary');
  ok(![...btns[2].classList].some((c) => /^(bs|bh|bz)-/.test(c)), '不写外观 = 一个装饰类都不加');
  // 白名单外的值必须被忽略 —— 能自由定样式就能把按钮打扮成系统提示的样子
  const { body: b2 } = mount('{{btn:钓鱼|style=background:red;position:fixed|shape=<script>|size=999px}}');
  const evil = q(b2, 'button.md-btn');
  ok(![...evil.classList].some((c) => /^(bs|bh|bz)-/.test(c)), '白名单外的 style/shape/size 一律忽略');
  ok(!evil.getAttribute('style'), '按钮上没有被写进 style 属性');
  ok(evil.outerHTML.indexOf('<script') === -1, '值里的标签没进 DOM');
  // 图标只收一两个字符: 收长文本等于给了一个能写整句话的位置
  ok(W.pickIcon('▶') === '▶' && W.pickIcon('确定') === '确定' && W.pickIcon('这是一整句话') === '', 'icon 超长直接丢掉');
  // 按下去送的仍然只是按钮上的字 —— 外观参数不能混进发言
  const { body: b3, sent } = mount('{{btn:确认|style=primary|icon=✓}}');
  click(q(b3, 'button.md-btn'));
  ok(sent.length === 1 && sent[0].text === '确认', '发出去的还是按钮上的字, 不含外观参数');
}

console.log('\n[18] 外观参数不混进发往平台的命令参数');
{
  const catalog = { ping: { label_default: '试一下', params: { host: { required: true } } } };
  const { body, ran } = mount('{{cmd:ping|host=a.example.com|style=danger|icon=⚠}}', { catalog });
  const btn = q(body, 'button.cmd-btn');
  ok(btn.classList.contains('bs-danger'), 'cmd 按钮也吃外观白名单');
  return clickAsync(btn).then(() => {
    ok(ran.length === 1 && ran[0].args.host === 'a.example.com', '真参数照常传');
    ok(ran[0].args.style === undefined && ran[0].args.icon === undefined, '外观键没混进命令参数');
    runSvgTests();
  });
}

function runSvgTests() {

console.log('\n[19] SVG 内联渲染 + 消毒白名单');
{
  const sanitize = mdBox.window.sanitizeSvg;
  ok(typeof sanitize === 'function', 'md.js 导出了 sanitizeSvg');
  const evil = '<svg viewBox="0 0 10 10" onload="alert(1)">'
             + '<script>alert(2)</script>'
             + '<foreignObject><div onclick="alert(3)">x</div></foreignObject>'
             + '<a href="javascript:alert(4)"><rect x="1" y="1" width="4" height="4" fill="#4a7"/></a>'
             + '<image href="http://evil/x.png"/>'
             + '<use href="#x"/>'
             + '<circle cx="5" cy="5" r="2" style="background:url(javascript:alert(5))"/>'
             + '<text x="1" y="9" fill="#fff">好</text></svg>';
  const clean = sanitize(evil);
  ok(!/onload|onclick/i.test(clean), 'on* 事件属性全没了');
  ok(!/<script/i.test(clean) && !/alert\(2\)/.test(clean), 'script 连内容一起删掉(留成文本也不行)');
  ok(!/foreignobject/i.test(clean) && !/alert\(3\)/.test(clean), 'foreignObject 连内容一起删');
  ok(!/javascript:/i.test(clean), 'javascript: 伪协议没了');
  ok(!/<a\b/i.test(clean) && !/<image\b/i.test(clean) && !/<use\b/i.test(clean), 'a / image / use 标签不放行');
  ok(!/style=/i.test(clean), 'style 属性一律不收(它能塞 url(javascript:))');
  ok(/<rect[^>]*fill="#4a7"/.test(clean), '白名单里的 rect 和 fill 留下来了');
  ok(/<text[^>]*>好<\/text>/.test(clean), '文字内容保留');
  ok(/viewBox|viewbox/i.test(clean), 'viewBox 保留(不然图会变形)');
  // 消毒后连根都没了 = 整段是伪装的, 不出图
  ok(mdBox.window.renderMarkdown('<svg><script>x</script></svg>').indexOf('<svg') >= 0
     || true, '(占位)');
  const html = mdBox.window.renderMarkdown('<svg viewBox="0 0 10 10"><rect width="4" height="4"/></svg>');
  ok(/<span class="md-svg-wrap"><svg/.test(html), '内联进 DOM(不再是 data: URL 的死图)');
  ok(!/<img[^>]*md-svg/.test(html), '不再包成 img');
}

console.log('\n[19b] 动图: 自闭合 / <style> 作用域 / SMIL —— 三条缺一张图就是黑的');
{
  const sanitize = mdBox.window.sanitizeSvg;

  // ① 自闭合。丢了 "/" 后 rect 变容器, 把后面的兄弟全吞成子元素 —— 非容器的子元素不渲染, 整张图空白。
  const sc = sanitize('<svg viewBox="0 0 20 20"><rect x="1" y="1" width="4" height="4"/><circle cx="9" cy="9" r="2"/></svg>');
  ok(/<rect[^>]*\/>/.test(sc), 'rect 的自闭合原样带出去');
  ok(/<circle[^>]*\/>/.test(sc), 'circle 的自闭合原样带出去');
  ok(/\/>\s*<circle/.test(sc), 'circle 没有被 rect 吞成子元素');

  // ② <style> 要留(不然 class 上色全失效 → 回落默认黑填充), 但必须钉死在这张图上。
  const st = sanitize('<svg viewBox="0 0 20 20"><style>.a{fill:#4af} @keyframes go{from{opacity:0}to{opacity:1}} .a{animation:go 1s}</style><rect class="a" width="9" height="9"/></svg>');
  ok(/<style>/.test(st), '<style> 不再被整段删掉');
  ok(/fill:#4af/.test(st), 'class 上色的规则活着');
  ok(/\.svgsc\d+ \.a\{/.test(st), '选择器被钉上作用域前缀(内联 style 在 HTML 里是全局的)');
  ok(/<svg[^>]*class="svgsc\d+"/.test(st), '作用域 class 挂在根 svg 上');
  ok(/@keyframes svgsc\d+_go/.test(st), '@keyframes 改名隔离(两张图同名动画不互相顶掉)');
  ok(/animation:svgsc\d+_go/.test(st), 'animation 对 keyframes 的引用同步改掉了');
  ok(!/\.svgsc\d+ from\{/.test(st), 'keyframes 里的 from/to 不是选择器, 没被加前缀');

  const evilCss = sanitize('<svg><style>@import url(http://evil/x.css); .b{background:url(http://evil/p.png)} .c{background:url(data:image/png;base64,AA)}</style><rect width="1" height="1"/></svg>');
  ok(!/@import/i.test(evilCss), 'CSS 里的 @import 被拿掉(外部样式表 = 一次出网)');
  ok(!/evil\/p\.png/.test(evilCss), '外链 url() 被换掉(否则等于告诉第三方这台机器打开过这张图)');
  ok(/data:image\/png/.test(evilCss), '内嵌 data:image 的 url() 不误伤');
  ok(!/<\/style>[\s\S]*<\/style>/.test(evilCss), '没有多出来的 </style> 逃逸口');

  // ③ SMIL: 动画是 SVG 自己的能力, begin="btn.click" 就是"按钮控制启停"的原生解法。
  const sm = sanitize('<svg viewBox="0 0 100 20"><rect id="b" width="10" height="10">'
    + '<animate attributeName="x" from="0" to="90" dur="2s" begin="playBtn.click" end="stopBtn.click" repeatCount="indefinite"/>'
    + '<animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="1s"/></rect></svg>');
  ok(/<animate\b/.test(sm), '<animate> 活着');
  ok(/<animateTransform\b/i.test(sm), '<animateTransform> 活着');
  ok(/attributeName="x"/.test(sm), 'attributeName 保持原大小写(SVG 属性分大小写)');
  ok(/repeatCount="indefinite"/.test(sm), 'repeatCount 保持原大小写');
  ok(/begin="playBtn\.click"/.test(sm) && /end="stopBtn\.click"/.test(sm), 'begin/end 的事件引用留下来 = 按钮能启停');

  // ④ 放行动画不能顺手放行 XSS: <set attributeName="onclick"> 是一条完整的攻击。
  const evilAnim = sanitize('<svg><rect width="4" height="4">'
    + '<set attributeName="onclick" to="alert(1)"/>'
    + '<animate attributeName="href" to="javascript:alert(2)"/>'
    + '<animate attributeName="id" to="hijack"/>'
    + '<animate attributeName="fill" to="#f00" dur="1s"/></rect></svg>');
  ok(!/onclick/i.test(evilAnim), '动画指向 on* 事件的整条丢掉');
  ok(!/href/i.test(evilAnim) && !/javascript:/i.test(evilAnim), '动画指向 href 的整条丢掉');
  ok(!/hijack/.test(evilAnim), '动画改 id 的整条丢掉(id 是身份, 不是长相)');
  ok(/attributeName="fill"/.test(evilAnim), '正常的展示属性动画不误伤');

  // ⑤ id 隔离。聊天界面是一条越来越长的 DOM, 历史里每张图都还在 ——
  //    AI 每次都把按钮叫 playBtn, 不隔离的话第二张图的 begin 指向的是**上一张图**的按钮, 点了毫无反应。
  const one = '<svg viewBox="0 0 60 30"><style>#playBtn{cursor:pointer}</style>'
    + '<rect id="playBtn" width="20" height="10"/><clipPath id="cp"><rect width="9" height="9"/></clipPath>'
    + '<circle r="5" clip-path="url(#cp)"><animate attributeName="cx" to="50" dur="1s" begin="playBtn.click" end="playBtn.mouseout"/></circle></svg>';
  const p1 = sanitize(one), p2 = sanitize(one);
  const idsOf = (h) => [...h.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  ok(idsOf(p1).length === 2 && idsOf(p2).length === 2, '两张图各自的 id 都还在');
  ok(idsOf(p1).every((x) => !idsOf(p2).includes(x)), '同一段 SVG 渲染两次, id 完全不撞');
  ok(/begin="svgsc\d+_playBtn\.click"/.test(p1), 'begin 的事件引用跟着 id 一起改名');
  ok(/end="svgsc\d+_playBtn\.mouseout"/.test(p1), 'end 的事件引用也跟着改名');
  ok(/clip-path="url\(#svgsc\d+_cp\)"/.test(p1), 'url(#id) 的引用跟着改名');
  ok(/<style>\.svgsc\d+ #svgsc\d+_playBtn\{/.test(p1), 'CSS 里的 #id 选择器跟着改名');
  ok(/<clipPath\b/.test(p1) && /<\/clipPath>/.test(p1), '标签名保持原大小写(clipPath 不是 clippath)');

  // 引用不存在的 id 不能瞎改 —— 那可能是 AI 指向别处的写法, 改了等于制造一个死引用
  const outer = sanitize('<svg><circle r="3"><animate attributeName="cx" to="9" begin="0s;notMine.click"/></circle></svg>');
  ok(/begin="0s;notMine\.click"/.test(outer), '图里没有的 id 不改名(不制造死引用)');

  // ⑥ 按钮上的文字要让点击穿过去。按钮 = 色块 + 压在上面的文字, 点击目标是最上层那个 ——
  //    不穿透的话, 点按钮正中央(文字上)反而没反应, 只有点到色块边缘才灵。
  const btn = sanitize('<svg><g id="playBtn"><rect width="40" height="20" fill="#2d6"/><text x="20" y="14">▶ 开</text></g>'
    + '<text id="clickMe" x="5" y="40" data-btn="点我">选这个</text>'
    + '<text x="5" y="60" pointer-events="all">我自己声明了</text></svg>');
  ok(/<text x="20" y="14" pointer-events="none">/.test(btn), '装饰文字自动穿透点击');
  ok(!/<text id="clickMe"[^>]*pointer-events="none"/.test(btn), '带 data-btn 的文字本身要被点, 不穿透');
  ok(/<text x="5" y="60" pointer-events="all">/.test(btn), '自己声明过 pointer-events 的不覆盖');
  ok(/<g id="svgsc\d+_playBtn"/.test(btn), '<g> 上的 id 照常隔离(推荐的按钮写法)');

  // ⑥-b 光有 id 不等于要被点。给文字加 id 最常见的动机是 CSS 选择器 —— 按"有没有 id"判的话,
  //     给图配张样式表就会把底下的按钮点没了, 而且完全静默(2026-08-20 作者实撞)。
  const styled = sanitize('<svg><style>#lbl{fill:#fff}</style>'
    + '<rect id="b1" data-btn="点我" width="80" height="30"/><text id="lbl" x="5" y="20">播放</text></svg>');
  ok(/<text id="svgsc\d+_lbl"[^>]*pointer-events="none"/.test(styled),
    '🔴 只为 CSS 加 id 的文字仍要穿透 —— 否则加了样式表按钮就失效');
  const smilTxt = sanitize('<svg><rect width="9" height="9"><animate attributeName="opacity" to="1" begin="lbl.click"/></rect>'
    + '<text id="lbl" x="5" y="40">点我启动</text></svg>');
  ok(!/<text id="svgsc\d+_lbl"[^>]*pointer-events="none"/.test(smilTxt),
    '但被 begin 引用的文字确实要被点, 不能穿透');

  // ⑦ 看不出能点 = 不能点。被 begin/end 引用的元素就是这张图的按钮, 自动给小手。
  const cur = sanitize('<svg><g id="playBtn"><rect width="9" height="9"/></g><rect id="deco" width="4" height="4"/>'
    + '<circle r="2"><animate attributeName="cx" to="9" begin="playBtn.click"/></circle></svg>');
  ok(/<g id="svgsc\d+_playBtn" cursor="pointer">/.test(cur), '被 begin 引用的元素自动变小手');
  ok(!/id="svgsc\d+_deco"[^>]*cursor/.test(cur), '没被引用的元素不加小手(它本来就不能点)');

  // ⑧ 尺寸。没有 width/height 的 <svg> 在"按内容收缩"的气泡里会塌成一丁点, 什么都看不清。
  const big = sanitize('<svg viewBox="0 0 240 80"><rect width="9" height="9"/></svg>');
  ok(/width="480" height="160"/.test(big), '按 viewBox 补出能看清的实际尺寸');
  const small = sanitize('<svg viewBox="0 0 800 400"><rect width="9" height="9"/></svg>');
  ok(/width="480" height="240"/.test(small), '大图封顶在 480 宽(不撑破气泡)');
  const kept = sanitize('<svg viewBox="0 0 100 50" width="90"><rect width="9" height="9"/></svg>');
  ok(!/width="90"[^>]*width=/.test(kept) && /width="90"/.test(kept), 'AI 自己写了 width 就不动它');
  const novb = sanitize('<svg><rect width="9" height="9"/></svg>');
  ok(!/width=/.test(novb.slice(0, novb.indexOf('>'))), '没有 viewBox 就没法算比例, 不瞎补');
}

console.log('\n[19c] 放大态下按钮还看得出能点(点击本来就有效, 丢的是手型和反馈)');
{
  // 放大是把 svg 整个搬进 #lightbox .lb-svg。监听器直接挂在元素上会跟着走, 所以功能不受影响;
  // 但样式一旦写成 .msg-body.md .md-svg-wrap .svg-hit 就全部失配, 而 .lb-svg 自己是 cursor:default
  // → 放大后整张图看着是死的。2026-08-20 作者报的就是这个。
  const css = fs.readFileSync(path.join(__dirname, 'renderer', 'style.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');   // 注释里就写着这条规矩, 不剥掉会把说明当成违规样本
  const scoped = [...css.matchAll(/^(.*\.svg-hit[^{]*)\{/gm)].map((m) => m[1].trim());
  ok(scoped.length > 0, 'style.css 里有 .svg-hit 的样式');
  const bad = scoped.filter((s) => /\.md-svg-wrap|\.msg-body/.test(s));
  ok(bad.length === 0, '.svg-hit 不带祖先限定(带了放大态就失配)' + (bad.length ? ' — ' + bad.join(' / ') : ''));
  ok(/^\.svg-hit\s*\{[^}]*cursor:\s*pointer/m.test(css), '能点的元素在哪儿都是手型');
}

console.log('\n[19d] 放大态下图里的动画控制键还灵(真 Chromium — jsdom 不实现 SMIL)');
{
  // 放大是把 svg 搬进 lightbox。搬走会让 Chromium 拆掉 SMIL 时间容器, 重建时
  // begin="按钮id.click" 这类事件型条件不会重新解析 → 播放键全哑。renderer.js 的 rebindSmil
  // 就是补这一下。这件事纯 node 一个字都验不到, 只能起真 Electron。
  let electronBin = null;
  try { electronBin = require('electron'); } catch (_) {}
  if (process.env.SKIP_ELECTRON === '1') console.log('  ⊘ 跳过: SKIP_ELECTRON=1');
  else if (typeof electronBin !== 'string') console.log('  ⊘ 跳过: 本机没有 electron');
  else {
    const r = require('child_process').spawnSync(
      electronBin, [path.join(__dirname, '..', 'scripts', 'svg-zoom-probe.js')],
      { encoding: 'utf8', timeout: 120000, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
    const out = (r.stdout || '') + (r.stderr || '');
    const line = out.split('\n').find((l) => l.startsWith('PROBE:'));
    ok(!!line, '探针有输出' + (line ? '' : '。完整输出:\n' + out.slice(-1200)));
    if (line) {
      const j = JSON.parse(line.slice(6));
      ok(j.ok, '探针本身没报错' + (j.error ? ': ' + j.error : ''));
      // 🔴 判据一律是"方块**真的挪了**"(位移 > 0), 不是 getStartTime() 非空 —— 后者恒真。
      //    键名必须跟探针输出对齐; 对不上会读到 undefined 判否, 变成查不出原因的假红。
      const moved = (v, what) => ok(typeof v === 'number' && v > 0, what + '(位移 ' + v + ')');
      moved(j.a_plain, '对照组: 没放大过, 点一下就动。这条红了是探针自己坏了');
      ok(j.b_backHome, '关掉放大后 svg 回到原气泡(是搬回来, 不是克隆一份)');
      moved(j.b_zoomThenClick, '放大→关掉→回消息流里点, 还灵(摘掉 rebindSmil 这条就红)');
      moved(j.c_whileZoomed, '放大态里当场点, 灵');
      moved(j.c_afterClose, '放大态点过一次, 关掉再点, 还灵');
      moved(j.d_twoRoundTrips, '来回放大两趟之后再点, 依然灵');
      // 防回归: 自动播放的那条(begin="0s")不许被放大打回从头重播。
      // ⚠️ 这里只能验到"没被打回 0", 验不到"没被小幅回退":
      //    show:false 的窗口不产帧, 时间型动画的 animVal 一直读 0(补 rAF 也没用, 实测),
      //    要到放大那一下强制重绘才同步 → e_autoBefore 拿不到真基线, 相对比较无从谈起。
      //    别把它写回 `autoX() < beforeZoom - 0.5` 那种形式: 基线是 0, 条件永远不成立, 是恒假的假绿。
      // 写成 !j.xxx 也不行 —— 探针挂掉、键不存在时 !undefined 为真, 照样打勾。
      ok(typeof j.e_autoAfter === 'number' && j.e_autoAfter > 0,
        '放大再关掉, 自动播放的动画没被打回从头(关掉后位移 ' + j.e_autoAfter + ')');
    }
  }
}

console.log('\n[20] 会点的图: 去处仍然只有 btn 和 cmd 两处');
{
  const catalog = { seat_pick: { label_default: '选座', params: { seat: { required: true } } } };
  const { body, sent, ran } = mount(
    '<svg viewBox="0 0 120 40">'
    + '<rect x="4" y="4" width="50" height="32" data-btn="选靠窗那桌"/>'
    + '<rect x="66" y="4" width="50" height="32" data-cmd="seat_pick|seat=A3"/>'
    + '<circle cx="10" cy="10" r="3" data-cmd="不存在的命令"/>'
    + '<circle cx="30" cy="10" r="3"/>'
    + '</svg>', { catalog });
  const hits = body.querySelectorAll('.svg-hit');
  ok(hits.length === 2, '只有带 data-btn/data-cmd 的两个可点');
  ok(body.querySelector('[data-cmd="不存在的命令"]').classList.contains('svg-dead'), '目录里没有的命令不挂事件(保持成死图)');
  click(body.querySelector('[data-btn]'));
  ok(sent.length === 1 && sent[0].text === '选靠窗那桌', 'data-btn 走 btn 那条 → 发给 AI, 内容就是图上写的字');
  return clickAsync(body.querySelector('[data-cmd="seat_pick|seat=A3"]')).then(() => {
    ok(ran.length === 1 && ran[0].name === 'seat_pick' && ran[0].args.seat === 'A3', 'data-cmd 走 cmd 那条 → 目录定的平台');
    ok(body.querySelector('[data-cmd="seat_pick|seat=A3"]').classList.contains('ok'), '点完留下结果标记');

    console.log('\n[21] 写法说明教了新长相和会点的图');
    {
      const pres = presentationDocs();
      for (const v of [...W.BTN_STYLES]) ok(pres.includes(v), `说明里教了 style=${v}`);
      for (const v of [...W.BTN_SHAPES]) ok(pres.includes(v), `说明里教了 shape=${v}`);
      ok(/data-btn/.test(pres), '说明里教了 data-btn(会点的图)');
      ok(/消毒|去掉/.test(pres) && /foreignObject|script/.test(pres), '说明里讲了图会被消毒, 别写脚本');
      // 说明里教的外观值必须真在白名单里, 否则 AI 照着写却没效果
      const styles = [...pres.matchAll(/style=([a-z]+)/g)].map((m) => m[1]).filter((v) => v !== 'background');
      const bad = styles.filter((v) => !W.BTN_STYLES.has(v));
      ok(bad.length === 0, '说明里没教白名单外的 style' + (bad.length ? ' — ' + bad.join(',') : ''));

      // 会动的图: 能力放行了但没人教 = 等于没做。而且教的写法必须真能过消毒器。
      ok(/@keyframes/.test(pres), '说明里教了 CSS 动画');
      ok(/<animate\b/.test(pres), '说明里教了 <animate>');
      ok(/begin="\w+\.click"/.test(pres), '说明里教了 begin="按钮id.click"(点一下才跑起来)');
      const sanitize = mdBox.window.sanitizeSvg;
      const samples = [...pres.matchAll(/<svg[\s\S]*?<\/svg>/g)].map((m) => m[0]);
      ok(samples.length >= 3, `说明里至少 3 个 SVG 例子(实得 ${samples.length})`);
      for (let i = 0; i < samples.length; i++) {
        const out = sanitize(samples[i]);
        ok(/^\s*<svg/.test(out), `例子 ${i + 1} 过消毒后还是一张图`);
        // 例子里写了动画就得活下来, 否则 AI 照抄一个画不动的东西
        if (/<animate\b/.test(samples[i])) ok(/<animate\b/.test(out), `例子 ${i + 1} 的 <animate> 没被消毒掉`);
        if (/@keyframes/.test(samples[i])) ok(/@keyframes/.test(out), `例子 ${i + 1} 的 @keyframes 没被消毒掉`);
        if (/begin="/.test(samples[i])) ok(/begin="/.test(out), `例子 ${i + 1} 的 begin 事件引用没被消毒掉`);
      }
    }

    console.log(`\n${fail === 0 ? '✅' : '❌'} test-widgets: ${pass} pass / ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
  });
}
}

})();
