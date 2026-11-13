// test-board.js — 常驻板(renderer/board.js): {{pin:}} 记号怎么从气泡搬到屏幕上方。
// 跑法: node test-board.js
//
// 行业版同款行为的个人版移植。这里用 jsdom 上真 DOM, 验三件事:
//   {{pin:槽名|ui=包id}} → 把界面包钉到板(沙箱长在那上面)
//   {{pin:槽名|title=…}} → 把正文整段搬上去
//   {{pin:槽名}}         → 撤下
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body><div id="board"></div></body></html>');
const { window } = dom;
const { document } = window;

// md.js 长在 window 上
const mdBox = { window: {} };
vm.createContext(mdBox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'renderer', 'md.js'), 'utf8'), mdBox);
const renderMarkdown = mdBox.window.renderMarkdown;

const Board = require(path.join(__dirname, 'renderer', 'board.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

console.log('\n[1] parsePin: "槽位|k=v" 切法');
{
  ok(JSON.stringify(Board.parsePin('预约')) === JSON.stringify({ slot: '预约', opts: {} }), '只有槽名');
  ok(JSON.stringify(Board.parsePin('预约|ui=resv')) === JSON.stringify({ slot: '预约', opts: { ui: 'resv' } }), 'ui= 认得');
  ok(Board.parsePin('a|b=c|d').opts.d === true, '裸 flag 记成 true');
  ok(Board.parsePin('a|title=约=定').opts.title === '约=定', '值里的 = 只按第一个切');
  ok(Board.parsePin('').slot === '', '空 spec → 空槽名');
  ok(Board.parsePin('   |x=1').slot === 'x=1', '开头空白那段被 filter(Boolean) 吃掉, x=1 变槽名(行业版同款切法)');
}

console.log('\n[2] harvest: 三个记号各自去该去的地方');
{
  const host = document.getElementById('board');
  const mounted = [];
  const board = Board.create({
    document,
    strings: () => ({ board_close: '撤', ui_unknown: '没装' }),
    host: () => host,
    uiPackage: (id) => (id === 'resv' ? { id: 'resv' } : null),
    mountUi: (node, pkg, args) => { mounted.push(pkg.id); margs.push(args || {}); },
  });
  const margs = [];

  const body = document.createElement('div');
  body.innerHTML = renderMarkdown('先看这块 {{pin:预约|ui=resv}} 还有 {{pin:备忘|title=今日备忘}} 撤掉 {{pin:旧表}}');
  board.harvest(body);

  ok(body.querySelectorAll('.md-widget[data-kind="pin"]').length === 0, '记号从气泡里抹干净(不留第二份)');
  ok(host.querySelectorAll('.board-card').length === 2, '两个钉住的槽位上了板(撤的那个不算)');
  ok(mounted.length === 1 && mounted[0] === 'resv', 'ui= 的那个真调了 mountUi(沙箱长在板上)');
  ok(JSON.stringify(margs[0]) === '{}', '没带初始值时交给沙箱的是空的');
  {
    const b2 = document.createElement('div');
    b2.innerHTML = renderMarkdown('{{pin:电台|ui=resv|mood=relax|mode=radio}}');
    board.harvest(b2);
    const a = margs[margs.length - 1] || {};
    ok(a.mood === 'relax' && a.mode === 'radio' && !('ui' in a) && !('title' in a), `钉板带的初始值交给沙箱(plugin_open 的参数): ${JSON.stringify(a)}`);
  }
  const resvCard = host.querySelector('.board-card[data-slot="预约"]');
  ok(resvCard && resvCard.querySelector('.board-title').textContent === '预约', 'ui 板的标题 = 槽名(没给 title 时)');
  ok(resvCard && resvCard.querySelector('.board-x'), '每块都有 ✕ 撤下口');
  const memoCard = host.querySelector('.board-card[data-slot="备忘"]');
  ok(memoCard && memoCard.querySelector('.board-title').textContent === '今日备忘', 'title 板标题用 title= 的值');
  ok(!host.querySelector('.board-card[data-slot="旧表"]'), '{{pin:旧表}} 是撤下, 不出板');
  ok(host.classList.contains('on'), '板上有东西 → .on 亮出来');
}

console.log('\n[3] 撤下与替换');
{
  const host = document.createElement('div');   // 每节一块新板, 别跟上节共享 DOM
  document.body.appendChild(host);
  const board = Board.create({
    document, strings: () => ({}), host: () => host,
    uiPackage: () => null, mountUi: () => {},
  });
  const body = document.createElement('div');
  body.innerHTML = renderMarkdown('{{pin:表|title=第一版}}');
  board.harvest(body);
  ok(host.querySelectorAll('.board-card').length === 1, '钉上去了');
  const body2 = document.createElement('div');
  body2.innerHTML = renderMarkdown('{{pin:表}}');
  board.harvest(body2);
  ok(host.querySelectorAll('.board-card').length === 0, '同名槽位再写 {{pin:表}} → 撤下');
  ok(!host.classList.contains('on'), '板空了 → .on 灭掉');
}

console.log('\n[4] 撤下要记住: 重放历史不把撤掉的钉回');
{
  const host = document.createElement('div');
  document.body.appendChild(host);
  const persisted = [];
  const board = Board.create({
    document, strings: () => ({}), host: () => host,
    uiPackage: (id) => ({ id }), mountUi: () => {},
    persistRemoved: (removed) => { persisted.length = 0; persisted.push(...removed); },
  });
  const body1 = document.createElement('div');
  body1.innerHTML = renderMarkdown('{{pin:预约|ui=resv}}');
  board.harvest(body1);
  ok(host.querySelectorAll('.board-card').length === 1, '钉上了预约');

  const body2 = document.createElement('div');
  body2.innerHTML = renderMarkdown('{{pin:预约}}');
  board.harvest(body2);
  ok(host.querySelectorAll('.board-card').length === 0, '{{pin:预约}} 撤下');
  ok(persisted.includes('预约'), '撤下的槽位进了黑名单(持久化口子被调)');

  // 🔴 2026-08-27 作者定: 关掉窗口 / butler 重开, 板上不准自己出现任何东西, 要用户重新钉才出来。
  //    所以重放历史(replaying)时 pin 印一律**只摘不钉** —— 撤没撤过都一样, 一块都不钉回。
  //    往上翻旧对话走的也是这条路: 半年前钉过的东西不该因为翻到它就蹦到板上。
  //    ⚠️ 本用例此前守的是相反的行为(重放时把没撤过的槽位钉回来), 那是旧口径, 已随需求作废。
  board.setRemoved(['预约']);
  board.setReplaying(true);
  const body3 = document.createElement('div');
  body3.innerHTML = renderMarkdown('{{pin:预约|ui=resv}}');
  board.harvest(body3);
  ok(host.querySelectorAll('.board-card').length === 0, '重放历史: 已撤的槽位不钉回');
  board.setReplaying(false);

  board.setRemoved([]);
  board.setReplaying(true);
  const seq = ['{{pin:表|title=a}}', '{{pin:表}}', '{{pin:表|title=b}}'];
  const bodies = [];
  for (const s of seq) {
    const b = document.createElement('div');
    b.innerHTML = renderMarkdown(s);
    board.harvest(b);
    bodies.push(b);
  }
  ok(host.querySelectorAll('.board-card').length === 0,
     '🔴 重放 钉→撤→钉: 板上仍然空的 —— 没撤过的也不钉, 要用户重新钉才出来');
  ok(bodies.every((b) => !b.querySelector('.md-widget[data-kind="pin"]')),
     '🔴 印本身要摘掉(留在正文里就成了一个没人看得懂的标记)');
  ok(!persisted.includes('表'), '重放不往黑名单里写(快照没被污染)');
  board.setReplaying(false);

  // 实时那条路不受影响: 不在重放态时, AI 说 {{pin:}} 就该真钉上
  const live = document.createElement('div');
  live.innerHTML = renderMarkdown('{{pin:表|title=live}}');
  board.harvest(live);
  ok(host.querySelectorAll('.board-card').length === 1, '实时 pin 照常钉上(只有重放才不钉)');
}

console.log('\n[side] 包写 display:side 的挂侧板, 别的挂上面那块');
{
  const top = document.createElement('div'), side = document.createElement('div');
  document.body.append(top, side);
  const pkgs = { radio: { id: 'radio', display: 'side' }, resv: { id: 'resv', display: 'board' } };
  const board = Board.create({
    document, strings: () => ({}), host: (where) => (where === 'side' ? side : top),
    uiPackage: (id) => pkgs[id] || null, mountUi: () => {},
  });
  const b = document.createElement('div');
  b.innerHTML = renderMarkdown('{{pin:radio|ui=radio}} {{pin:resv|ui=resv}} {{pin:memo|title=备忘}}');
  board.harvest(b);
  ok(side.querySelectorAll('.board-card').length === 1 && side.querySelector('[data-slot="radio"]'), 'side 包进侧板');
  ok(top.querySelectorAll('.board-card').length === 2, 'board 包和临时正文进上面那块');
  ok(top.classList.contains('on') && side.classList.contains('on'), '两块各自亮');
  board.pin('radio');
  ok(!side.querySelector('.board-card') && !side.classList.contains('on'), '撤下侧板那张 → 侧板灭');
  pkgs.resv.display = 'side';
  board.pin('resv|ui=resv');
  ok(side.querySelector('[data-slot="resv"]') && !top.querySelector('[data-slot="resv"]'), '同一槽换了摆法 → 搬过去, 不留两份');
}

console.log(`\n✅ test-board: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
