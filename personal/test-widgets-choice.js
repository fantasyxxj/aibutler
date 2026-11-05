// test-widgets-choice.js — 单选 {{pick:}} / 复选 {{picks:}} 的行为。
// 跑法: node test-widgets-choice.js
//
// 从 test-widgets.js 分出来: 那个文件已经到了行数上限。这一族守的是"选项摆在外面"
// 那类控件, 与输入框/按钮/图是两回事。
//
// 只用正则看源码等于没测 —— 读值、锁表单、重画后恢复都是"按下去才发生"的行为, 所以上真 DOM。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { window } = dom;
const { document } = window;

const mdBox = { window: {} };
vm.createContext(mdBox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'renderer', 'md.js'), 'utf8'), mdBox);
const renderMarkdown = mdBox.window.renderMarkdown;

const W = require(path.join(__dirname, 'renderer', 'widgets.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

const STRINGS = { widget_no_key: '缺少字段名', widget_no_options: '没有选项', widget_no_label: '按钮没有文字' };

function paintInto(body) {
  W.create({
    document,
    strings: () => STRINGS,
    catalog: () => ({}),
    runCommand: async () => ({ ok: true }),
    sendToAI: (text, from) => { sent.push({ text, from }); },
  }).paint(body);
}
let sent = [];
function mount(markdown) {
  sent = [];
  const body = document.createElement('div');
  body.innerHTML = renderMarkdown(markdown);
  paintInto(body);
  return { body, sent };
}
const q = (body, sel) => body.querySelector(sel);
const click = (el) => el.dispatchEvent(new window.Event('click'));

console.log('[1] 建成真的 radio / checkbox');
{
  const { body } = mount('口味 {{pick:taste|清淡,适中,重口}} 忌口 {{picks:avoid|香菜,葱,辣}}');
  const one = q(body, '.md-chk:not(.is-multi)'), many = q(body, '.md-chk.is-multi');
  ok(one && one.querySelectorAll('input[type=radio]').length === 3, 'pick → 三个 radio');
  ok(many && many.querySelectorAll('input[type=checkbox]').length === 3, 'picks → 三个 checkbox');
  ok(one.dataset.key === 'taste' && many.dataset.key === 'avoid', 'key 落在 data-key');
  ok(body.querySelectorAll('.md-widget').length === 0, '空壳不残留(全被 replaceWith)');
  ok(body.textContent.includes('口味') && body.textContent.includes('忌口'), '前后正文原样保留');
}

console.log('\n[2] 读值 —— 单选一个, 复选逗号串');
{
  const { body } = mount('{{pick:taste|清淡,适中,重口}} {{picks:avoid|香菜,葱,辣}}');
  const one = q(body, '.md-chk:not(.is-multi)'), many = q(body, '.md-chk.is-multi');
  ok(one.value === '', '什么都没选时是空 —— 不替人默认选第一个');
  one.querySelectorAll('input')[1].checked = true;
  ok(one.value === '适中', '单选读出选中那个');
  const boxes = many.querySelectorAll('input');
  boxes[0].checked = true; boxes[2].checked = true;
  ok(many.value === '香菜, 辣', '复选读出逗号串');
}

console.log('\n[3] value= 预选');
{
  const { body } = mount('{{pick:taste|清淡,适中,重口|value=重口}} {{picks:avoid|香菜,葱,辣|value=香菜,辣}}');
  ok(q(body, '.md-chk:not(.is-multi)').value === '重口', '单选预选生效');
  ok(q(body, '.md-chk.is-multi').value === '香菜, 辣', '复选预选多个生效');
}

console.log('\n[4] 选中的值跟着按钮回到 AI, 按完就锁上');
{
  const { body, sent } = mount('口味 {{pick:taste|清淡,重口}} 忌口 {{picks:avoid|香菜,葱}} {{btn:就这样}}');
  q(body, '.md-chk:not(.is-multi)').querySelectorAll('input')[1].checked = true;
  q(body, '.md-chk.is-multi').querySelectorAll('input')[0].checked = true;
  click(q(body, 'button.md-btn'));
  ok(sent.length === 1, '按一次发一条');
  ok(sent[0].text.includes('- taste: 重口'), '单选的值带上了');
  ok(sent[0].text.includes('- avoid: 香菜'), '复选的值带上了');
  ok(q(body, '.md-chk').classList.contains('is-locked'), '锁上之后整块标成 is-locked');
  ok(Array.from(q(body, '.md-chk').querySelectorAll('input')).every((b) => b.disabled),
     '里面每个都禁用了(二度按不出第二条)');
}

console.log('\n[5] 一个都没选就按 —— 不硬塞一个值上去');
{
  const { body, sent } = mount('{{pick:taste|清淡,重口}} {{btn:定}}');
  click(q(body, 'button.md-btn'));
  ok(!sent[0].text.includes('taste'), '空的字段不出现在发言里(没选就是没选, 不能替他答)');
}

console.log('\n[6] 重画不丢已选项');
{
  const raw = '{{pick:taste|清淡,重口}} {{picks:avoid|香菜,葱}} {{btn:定}}';
  const { body } = mount(raw);
  q(body, '.md-chk:not(.is-multi)').querySelectorAll('input')[1].checked = true;
  q(body, '.md-chk.is-multi').querySelectorAll('input')[1].checked = true;
  const snap = W.snapshotFields(body);
  body.innerHTML = renderMarkdown(raw);
  paintInto(body);
  W.restoreFields(body, snap);
  ok(q(body, '.md-chk:not(.is-multi)').value === '重口', '重画后单选还在');
  ok(q(body, '.md-chk.is-multi').value === '葱', '重画后复选还在');
}

console.log('\n[7] 两组单选互不串台');
{
  const { body } = mount('{{pick:a|甲,乙}} {{pick:b|甲,乙}}');
  const [g1, g2] = body.querySelectorAll('.md-chk');
  ok(g1.querySelector('input').name !== g2.querySelector('input').name, '两组的分组名不同');
  g1.querySelectorAll('input')[0].checked = true;
  g2.querySelectorAll('input')[1].checked = true;
  ok(g1.value === '甲' && g2.value === '乙', '各选各的, 谁也没把谁挤掉');
}

console.log('\n[8] 缺字段名 / 零选项都出红字, 不静默');
{
  ok(q(mount('{{pick:}}').body, '.cmd-error'), 'pick 没写字段名 → 红字');
  ok(q(mount('{{picks:avoid}}').body, '.cmd-error'), 'picks 零选项 → 红字');
  ok(!q(mount('{{pick:taste|清淡,重口}}').body, '.cmd-error'), '写全了就不该有红字');
}

console.log('\n[9] 建控件只走 createElement —— 选项里的标签只当字显示');
{
  const { body } = mount('{{pick:x|<b>粗</b>,乙}}');
  ok(!q(body, '.md-chk b'), '选项文字里的 <b> 没变成真标签');
  ok(body.textContent.includes('<b>粗</b>'), '原样当文字显示出来');
}

console.log('\n[10] 括号里的逗号不是分隔符 —— 坐标 A (3,2) 这类选项要活着');
{
  const { body } = mount('{{pick:ans|A (3,2),B (1,4),C (5,0)}}');
  const one = q(body, '.md-chk:not(.is-multi)');
  const texts = Array.from(one.querySelectorAll('input')).map((b) => b.value);
  ok(texts.length === 3, '三个坐标切成三个选项, 没被切成六个');
  ok(texts[0] === 'A (3,2)' && texts[2] === 'C (5,0)', '括号内的逗号原样留在选项文字里');
  one.querySelectorAll('input')[0].checked = true;
  ok(one.value === 'A (3,2)', '读值拿到完整坐标');
}
{
  const { body } = mount('{{picks:r|(1,5],[0,2),(3,8]}}');
  const many = q(body, '.md-chk.is-multi');
  ok(many.querySelectorAll('input').length === 3, '方括号区间也按三个切');
  const boxes = many.querySelectorAll('input');
  boxes[0].checked = true; boxes[2].checked = true;
  ok(many.value === '(1,5], (3,8]', '复选读出的串里区间是完整的');
  many.value = '(1,5], (3,8]';
  ok(many.querySelectorAll('input')[0].checked && many.querySelectorAll('input')[2].checked
     && !many.querySelectorAll('input')[1].checked, '同一个串塞回去能原样还原(读写往返自洽)');
}
{
  const { body } = mount('{{pick:ans|A (3,2),B (1,4)|value=B (1,4)}}');
  ok(q(body, '.md-chk:not(.is-multi)').value === 'B (1,4)', 'value= 预选带逗号的选项也认');
}
{
  const { body } = mount('{{sel:ans|A (3,2),B (1,4)}}');
  ok(body.querySelectorAll('select.md-sel option').length === 2, '下拉走同一条切法');
}
{
  const { body } = mount('{{pick:ans|A (3,2,B (1,4}}');
  const n = q(body, '.md-chk:not(.is-multi)').querySelectorAll('input').length;
  ok(n === 4, '括号不配对 → 退回裸切(4 个), 而不是把后面的选项整个吞掉');
}
{
  // 10-14 行业版 dev: 模型写成竖线分隔, 原先只渲染出第一个选项
  const { body } = mount('{{pick:period|全部时间|这个月|最近三个月}} {{sel:s|甲|乙}}');
  ok(q(body, '.md-chk:not(.is-multi)').querySelectorAll('input').length === 3, '竖线分隔的单选三个选项都在');
  ok(body.querySelectorAll('select.md-sel option').length === 2, '竖线分隔的下拉两个选项都在');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} test-widgets-choice: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
