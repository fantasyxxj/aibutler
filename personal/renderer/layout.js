// layout.js — 上下 / 左右两种布局, 由用户在顶栏切(每人格记住, 存在 side-state 里)。
//
// 上下 = 原来的样子, 侧栏不出现。人格划的重点照样存, 顶栏按钮上出角标告诉用户新挂了几条。
// 左右 = 宽屏用法: 左栏放提醒条、任务面板、chip(不再占对话的高度), 右栏放「划重点」和常驻板。
// 窗口窄到 1100px 以下时按上下排, 「划重点」和布局键都不显示; 拉宽自动回左右 —— 用户选的布局不改(作者 11-12 定)。
//
// 搬的是现成的节点(reminderBar / taskpanel / chipbar / 各标签的常驻板), 原处留一个注释当锚,
// 切回上下时原样插回去, 各模块自己的逻辑一行不用改。
// 🔴 常驻板里有沙箱 iframe, iframe 一挪位置就会重载 —— 所以只在「布局真的变了」时整体搬一次,
//    切标签不搬(左右时所有标签的板都放在右栏, 只显示当前那块)。
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const railL = $('railLBody'), railBoard = $('railBoard'), btn = $('layoutBtn'), badge = $('layoutBadge');
  if (!railL || !railBoard || !btn || !window.Marks) return;

  // 任务面板平时是第一次有任务才建; 这里先建好, 搬家时才有东西可搬
  if (!$('taskpanel')) {
    const tp = document.createElement('div');
    tp.id = 'taskpanel'; tp.className = 'hidden';
    const strip = $('attachstrip');
    strip.parentNode.insertBefore(tp, strip);
  }

  const homes = new Map();   // 节点 → 原处的锚
  function stash(n) {
    if (homes.has(n)) return;
    const c = document.createComment(`home:${n.id || n.className}`);
    n.parentNode.insertBefore(c, n);
    homes.set(n, c);
  }
  function goHome(n) { const c = homes.get(n); if (c && c.parentNode && n.previousSibling !== c) c.parentNode.insertBefore(n, c.nextSibling); }
  const movers = () => ['reminderBar', 'taskpanel', 'chipbar'].map($).filter(Boolean);

  const NARROW = 1100;      // 与 layout.css 无关, 只在这里判: 窄了按上下排
  let applied = null;        // 当前生效的布局, 只有变了才搬
  function apply() {
    const sid = activeSid;
    const lr = window.Marks.state(sid).layout === 'lr' && window.innerWidth > NARROW;
    body.classList.toggle('lr', lr);
    btn.classList.toggle('hidden', window.innerWidth <= NARROW);   // 窄了只能按上下排, 切换键按了也没用, 不出来(作者 11-12)
    const mode = lr ? 'lr' : 'tb';
    if (mode !== applied) {
      applied = mode;
      for (const n of movers()) { stash(n); if (lr) railL.appendChild(n); else goHome(n); }
      for (const tab of tabs.values()) {
        if (!tab.boardEl) continue;
        if (lr) { if (tab.boardEl.parentNode !== railBoard) railBoard.appendChild(tab.boardEl); }
        else if (tab.boardEl.parentNode !== tab.panel) tab.panel.insertBefore(tab.boardEl, tab.panel.firstChild);
      }
    } else if (lr) {
      // 布局没变但可能新开了标签: 它的板还在面板里, 补搬过来
      for (const tab of tabs.values()) if (tab.boardEl && tab.boardEl.parentNode !== railBoard) railBoard.appendChild(tab.boardEl);
    }
    for (const tab of tabs.values()) if (tab.boardEl) tab.boardEl.classList.toggle('cur', tab.sid === sid);
    paintBtn();
  }

  function paintBtn() {
    const sid = activeSid;
    const lr = window.Marks.state(sid).layout === 'lr';
    const n = lr ? 0 : window.Marks.unseen(sid);
    btn.classList.toggle('on', lr);   // 按钮显示用户选的; 窄窗口暂按上下排不改它
    badge.textContent = n ? String(n) : '';
    badge.classList.toggle('hidden', !n);
    btn.title = n ? t('layout_badge', { n }) : t('layout_hint');
  }

  btn.addEventListener('click', async () => {
    const sid = activeSid;
    if (!sid) return;
    const next = window.Marks.state(sid).layout === 'lr' ? 'tb' : 'lr';
    await window.Marks.setLayout(sid, next);
    apply();
  });

  // 拖窗口宽窄跨过 1100px 时换排法(只在真跨过时搬, apply 自己判)
  let rz = null;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(apply, 150); });

  window.Marks.mount($('marksBox'));
  window.Marks.onChange((sid) => { if (sid === activeSid) paintBtn(); });
  $('lang').addEventListener('change', () => setTimeout(() => { window.Marks.paint(); paintBtn(); }, 300));

  // renderer.js 在切标签、读完历史后调这个
  window.layoutUI = {
    async sync(sid) { await window.Marks.show(sid); if (sid === activeSid) apply(); },
  };
  if (activeSid) window.layoutUI.sync(activeSid);
})();
