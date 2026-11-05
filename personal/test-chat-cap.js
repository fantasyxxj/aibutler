// test-chat-cap.js — 聊天区只留最近 N 条气泡, 更早的从 DOM 卸掉。
//
// 为什么有这条闸: 2026-08-27 实测, 流式输出烧掉的 CPU 与聊天区常驻气泡条数**线性相关** ——
// 同一段回复(1500 chunk / 7500 字), 0 条时 5.4s CPU, 1000 条 13.8s, 4000 条 37s, 10000 条 102s。
// 换写法一概无效(appendData 1.04x · rAF 合滚 1.2x · block 布局 1.29x · content-visibility 0.95x ·
// 删 :has() 0.99x · 干脆不滚 1.33x), 代价来自"scroller 里有几千个盒子"本身。
// 所以上限这件事本身就是修复, 一旦被谁改回无上限, CPU 会悄悄涨回去且没人看得出来。
//
// 手法: trimChat 只碰数组和 DOM, 不需要布局 → 从 renderer.js 原文里把它和常量抠出来, 在 jsdom 上真跑。
//       抠不到就直接红, 免得函数改了名而测试还在自娱自乐。
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

const SRC = fs.readFileSync(path.join(__dirname, 'renderer', 'renderer.js'), 'utf8');

// ---- 从原文里取出被测代码 ----
function sliceFn(src, header) {
  const at = src.indexOf(header);
  if (at === -1) return null;
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
  }
  return null;
}
const capLine = SRC.match(/const SCREEN_MSG_CAP = (\d+);/);
const hardLine = SRC.match(/HARD_MSG_CAP = (\d+)/);
const trimSrc = sliceFn(SRC, 'function trimChat(tab)');

console.log('\n== 被测代码取得到 ==');
ok(!!capLine, 'renderer.js 里有 SCREEN_MSG_CAP 常量');
ok(!!hardLine, 'renderer.js 里有 HARD_MSG_CAP 常量(往上翻时的兜底上限)');
ok(!!trimSrc, 'renderer.js 里有 trimChat(tab)');
if (!capLine || !hardLine || !trimSrc) { console.log(`\n结果: ${pass} pass, ${fail + 1} fail`); process.exit(1); }

const CAP = Number(capLine[1]);
const HARD = Number(hardLine[1]);
ok(CAP >= 100 && CAP <= 1000, `上限在几百这一档(实际 ${CAP}) —— 太小会看不见上文, 太大等于没限`);
ok(HARD > CAP && HARD <= 3000, `兜底上限比常规上限大但仍有限(实际 ${HARD}) —— 无上限等于没修`);

const trimChat = new Function('SCREEN_MSG_CAP', 'HARD_MSG_CAP', `${trimSrc}; return trimChat;`)(CAP, HARD);

// ---- jsdom 真 DOM ----
const dom = new JSDOM('<!doctype html><div class="chat"></div>');
const doc = dom.window.document;
// 每个用例一个全新容器 —— 共用一个的话上一个用例剩下的气泡会算进下一个用例
const mkTab = () => {
  const chat = doc.createElement('div');
  doc.body.appendChild(chat);
  return { chat, msgEls: [], activeBubble: null, stick: true };
};
function add(tab, text) {
  const el = doc.createElement('div');
  el.className = 'msg';
  el.textContent = text;
  tab.chat.appendChild(el);
  tab.msgEls.push(el);
  trimChat(tab);
  return el;
}
const inDom = (tab) => tab.chat.querySelectorAll('.msg').length;

console.log('\n== 超过上限就卸掉最早的 ==');
{
  const tab = mkTab();
  for (let i = 0; i < CAP; i++) add(tab, 'm' + i);
  ok(inDom(tab) === CAP, `刚好 ${CAP} 条时一条都不卸`);
  const first = tab.msgEls[0];
  add(tab, 'overflow');
  ok(inDom(tab) === CAP, `第 ${CAP + 1} 条进来后 DOM 仍是 ${CAP} 条`);
  ok(!first.isConnected, '被卸的是最早那条');
  ok(tab.msgEls.length === CAP, '数组和 DOM 不脱节');
  ok(tab.msgEls[tab.msgEls.length - 1].textContent === 'overflow', '最新那条在末尾');
}

console.log('\n== 🔴 正在流式输出的那条气泡永远不动 ==');
{
  const tab = mkTab();
  for (let i = 0; i < CAP + 50; i++) add(tab, 'm' + i);
  tab.activeBubble = tab.msgEls[0];           // 人为把它摆到最前, 模拟"该卸的正好是它"
  const before = tab.msgEls.length;
  add(tab, '新的');
  ok(tab.activeBubble.isConnected, '🔴 activeBubble 没被卸掉 —— 卸掉它 = 正在打的字消失');
  ok(tab.msgEls[0] === tab.activeBubble, 'activeBubble 仍在队首(没被 shift 出去)');
  ok(tab.msgEls.length === before + 1, '碰到 activeBubble 就停手, 不硬卸后面的');
}

console.log('\n== 用户滚上去看历史时不卸 ==');
{
  const tab = mkTab();
  for (let i = 0; i < CAP; i++) add(tab, 'm' + i);
  tab.stick = false;                          // 用户滚离底部
  for (let i = 0; i < 100; i++) add(tab, 'x' + i);
  ok(inDom(tab) === CAP + 100, '滚上去期间一条都不卸(否则等于在他眼皮底下抽走正在读的内容)');
  tab.stick = true;                           // 回到底部
  add(tab, '回底');
  ok(inDom(tab) === CAP, '回到底部后立刻补修剪回上限');
}

console.log('\n== 与 renderer.js 的接线 ==');
{
  const addFn = sliceFn(SRC, 'function addMsgTo(tab, role, text, ts)');
  ok(!!addFn && /tab\.msgEls\.push\(el\)/.test(addFn), 'addMsgTo 把气泡登记进 msgEls');
  ok(!!addFn && /trimChat\(tab\)/.test(addFn), 'addMsgTo 登记完就修剪(唯一入口, 别处不许再插消息)');
  ok(/msgEls: \[\]/.test(SRC), '建标签页时初始化了 msgEls');
  // 🔴 2026-08-27 真机抓到: 工具条 `msg tool pending` 直接 appendChild, 没登记 → 永远不被修剪,
  //    上限被悄悄架空(DOM 47 条 vs 数组 46 条)。所以每一个造 .msg 元素的地方都得登记。
  // 只认 msg 作为独立类名(顶层气泡), msg-body / msg-time 那些是气泡内部元素
  // 登记有两条路: 追加到底(push) / 往上翻时插到前面(splice) —— 认哪条都行, 一条都没有才是漏登记
  for (const m of SRC.matchAll(/className = '(msg(?: [^']*)?)'/g)) {
    const after = SRC.slice(m.index, m.index + 1400);
    ok(/msgEls\.(push\(el\)|splice\([^)]*, 0, el\))/.test(after) && /trimChat\(tab\)/.test(after),
       `🔴 造 "${m[1]}" 的地方登记进 msgEls 并修剪(漏一处, 那类元素就无上限地堆下去)`);
  }
  // 空气泡被撤时若不出列, 计数会虚高, 上限悄悄缩水
  ok(/msgEls\.indexOf\(tab\.activeBubble\)[\s\S]{0,160}?splice/.test(SRC),
     '🔴 撤掉空气泡时同步出列(不出列 → 计数虚高 → 提前挤掉活着的消息)');
}

console.log('\n== 往上翻: 从日志读回来, 不在内存里留对象 ==');
{
  const restoreSrc = sliceFn(SRC, 'async function restoreOlder(tab)');
  ok(!!restoreSrc, 'renderer.js 里有 restoreOlder(tab)');
  ok(/scrollTop < NEAR_TOP_PX[\s\S]{0,80}?restoreOlder\(tab\)/.test(SRC), '滚到接近顶部就去补一页');

  // 🔴 修剪必须是销毁。留着 DOM 对象等于把省下的内存又占回去(作者: "留着对象没用")
  const trimBody = sliceFn(SRC, 'function trimChat(tab)');
  ok(/list\.shift\(\)\.remove\(\)/.test(trimBody), '🔴 修剪 = 销毁, 不往任何缓冲区里存');
  ok(!/detached|_buffer|bufEls/.test(SRC), '🔴 没有藏着的气泡缓冲区(有的话内存又涨回去了)');

  if (restoreSrc) {
    // 🔴 定位靠【屏幕上最早那条落盘消息的时间戳】, 不靠条数。按条数的前提是"屏幕上那 N 条 ≡
    //    日志尾部那 N 条", 而屏幕是拿 .session.json 快照画的、日志 8-27 才上线 —— 前提不成立,
    //    表现就是往上翻时中间整段消息看不到(上一条从今天早上跳到昨天下午)。
    ok(/querySelector\('\.msg\[data-h\]\[data-ts\]'\)/.test(restoreSrc),
       '🔴 游标 = 屏幕上最早那条落盘消息(带 data-h + data-ts)');
    ok(/historyPage\(tab\.sid, before/.test(restoreSrc), '跟主进程要的是"比 before 更早"的那一页');
    ok(!/\bskip\b/.test(restoreSrc), '🔴 条数分页不许残留 —— 它正是丢消息的病根');
    // 🔴 用"问到空的时间点"而不是布尔标志: 刚装上这版时日志是空的, 随手滚一下顶就会把往上翻
    //    永久关掉, 之后攒出几百条日志也翻不动。时间点会自愈。
    ok(/if \(!older\.length\) \{ tab\._emptyBefore = before/.test(restoreSrc),
       '拿到空 → 记下"这个时间点往前没有了", 不再反复问');
    ok(/tab\._emptyBefore != null && before && before <= tab\._emptyBefore/.test(restoreSrc),
       '🔴 拦的判据是时间点比较, 不是布尔');
    ok(!/_pagedOut/.test(SRC), '🔴 没有"已到顶"的布尔标志残留(它会把当时没得翻固化成永远没得翻)');
    ok(/scrollTop \+= chat\.scrollHeight - before/.test(restoreSrc),
       '🔴 补滚动位置(不补的话上方多出一截, 正在看的那行会当场往下窜走)');
    ok(/setReplaying\(true\)/.test(restoreSrc),
       '🔴 翻出来的老 pin 印只摘不钉(否则半年前钉过的东西会自己蹦到板上)');
    // 🔴 "插到顶部"是挂在 tab 上的开关。描的过程中一旦 await 让出线程, 此刻正在流式输出的
    //    实时气泡也会被插到顶上去 —— 表现为 AI 正说着话, 字却出现在聊天区最上面。
    const paintPart = restoreSrc.slice(restoreSrc.indexOf('tab._insertBefore = chat.firstChild'));
    ok(paintPart && !/await/.test(paintPart.slice(0, paintPart.indexOf('finally'))),
       '🔴 设了 _insertBefore 之后到 finally 之间必须是同步的(有 await → 实时气泡会插到顶部)');
    ok(/for \(const m of older\) imgs\.push\(await fetchHistoryImgs/.test(restoreSrc),
       '图片附件在进入同步段之前就全部取完');
  }

  ok(/el\.dataset\.h = '1'/.test(sliceFn(SRC, 'function addMsgTo(tab, role, text, ts)') || ''),
     '来自/将进日志的气泡默认打记号');
  ok(/delete el\.dataset\.h/.test(sliceFn(SRC, 'function sysMsgTo(tab, text, extra') || ''),
     '🔴 界面自己说的话摘掉记号(它们不进日志, 算进去会让 skip 虚高而跳过真历史)');
}

console.log('\n== 🔴 重开窗口不恢复板 ==');
{
  const BOARD = fs.readFileSync(path.join(__dirname, 'renderer', 'board.js'), 'utf8');
  const harvestSrc = sliceFn(BOARD, 'function harvest(body)');
  ok(!!harvestSrc && /n\.remove\(\);\s*\n\s*if \(replaying\) continue;/.test(harvestSrc),
     '🔴 重放历史时 pin 印只摘不钉 —— 关掉窗口再开, 板必须是空的, 要用户重新钉才出来');
  ok(!!harvestSrc && /n\.remove\(\)/.test(harvestSrc),
     '印本身仍要摘掉(留着会在正文里显示成一个没人看得懂的标记)');
  const loadSrc = sliceFn(SRC, 'async function loadHistory(tab)');
  ok(!!loadSrc && /setReplaying\(true\)/.test(loadSrc), '开标签渲染历史时处于重放态');
  ok(!!loadSrc && /getHistory\(tab\.sid, SCREEN_MSG_CAP\)/.test(loadSrc),
     '🔴 开标签只要 SCREEN_MSG_CAP 条(不再一口气把整程历史灌进来)');
}

// 2026-09-13: stick 会被流式竞态误置成 false 且永不复位, 那时旧实现直接 return, DOM 无限堆。
// 现在改成放宽到 HARD_MSG_CAP —— 这一组守的就是"往上翻着不放也不会堆到天上"。
console.log('\n== 🔴 用户往上翻(stick=false)时仍有兜底上限 ==');
{
  const tab = mkTab();
  tab.stick = false;
  for (let i = 0; i < CAP + 50; i++) add(tab, 'm' + i);
  ok(inDom(tab) === CAP + 50, `往上翻时可以超过常规上限(${CAP + 50} 条还在)`);
  for (let i = 0; i < HARD; i++) add(tab, 'x' + i);
  ok(inDom(tab) === HARD, `但绝不越过兜底上限 ${HARD}(实际 ${inDom(tab)})`);
  ok(tab.msgEls.length === HARD, '数组和 DOM 不脱节');
  ok(tab.msgEls[tab.msgEls.length - 1].textContent === 'x' + (HARD - 1), '留下的是最新那批');
  // 补老消息走的是同一个插入函数(末尾就调 trimChat)。这时若照裁, 补一批被裁一批, 而且用户还在顶上,
  // 就会「到顶→补→被裁→仍在顶→再补」空转。_insertBefore 在场时必须一条都不动。
  tab._insertBefore = tab.msgEls[0];
  const n0 = inDom(tab);
  for (let i = 0; i < 20; i++) add(tab, 'old' + i);
  ok(inDom(tab) === n0 + 20, `补老消息时一条都不裁(${n0} → ${inDom(tab)})`);
  tab._insertBefore = null;
  add(tab, 'tail');
  ok(inDom(tab) === HARD, `补完之后下一条新消息把它冲回 ${HARD}(实际 ${inDom(tab)})`);
}

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
