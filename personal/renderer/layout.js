// layout.js — 上下 / 左右两种布局, 由用户在顶栏切(每人格记住, 存在 side-state 里)。
//
// 上下 = 原来的样子, 侧栏不出现。人格划的重点照样存, 顶栏按钮上出角标告诉用户新挂了几条。
// 左右 = 宽屏用法: 左栏放提醒条、任务面板、chip(不再占对话的高度), 右栏放「收藏夹」和侧板。
// 常驻板分两块(作者 11-13): 上面那块永远在聊天面板顶上, 不搬; 侧板(包写 display:'side')左右排时进右栏, 上下排时排在上面那块下面。
// 窗口窄到 1100px 以下时按上下排, 「收藏夹」和布局键都不显示; 拉宽自动回左右 —— 用户选的布局不改(作者 11-12 定)。
// 左右时两栏靠对话那条边各有一根拖动条: 拖它调栏宽, 拖到边上收成 14px 细边(点一下或往外拖再展开)。
//   栏宽和收起全局一份记在 localStorage(作者 11-13 定); 收起只是看不见, 节点不搬, 收藏照样挂进去, 右栏细边出新增角标。
//
// 搬的是现成的节点(reminderBar / taskpanel / chipbar / 各标签的侧板), 原处留一个注释当锚,
// 切回上下时原样插回去, 各模块自己的逻辑一行不用改。
// 🔴 常驻板里有沙箱 iframe, iframe 一挪位置就会重载 —— 所以只在「布局真的变了」时整体搬一次,
//    切标签时只搬当前那块侧板, 而且只在它不在该在的地方时才搬(右栏里可以同时躺着几块, 只显示当前那块)。
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const railL = $('railLBody'), railBoard = $('railBoard'), btn = $('layoutBtn'), badge = $('layoutBadge');
  if (!railL || !railBoard || !btn || !$('gripL') || !$('gripR') || !window.Marks) return;

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
    }
    // 侧板只搬当前人格那块。别的人格的侧板留在原处: 不显示的地方本来就看不见, 而一搬 iframe 就重载 ——
    //   两个人格布局不同时, 切过去会把对方板上正在放的音乐整个重置(11-13 实测)。轮到它当前时再按它的布局搬。
    const cur = tabs.get(sid);
    if (cur && cur.sideEl) {
      if (lr) { if (cur.sideEl.parentNode !== railBoard) railBoard.appendChild(cur.sideEl); }
      else if (cur.sideEl.parentNode !== cur.panel) cur.panel.insertBefore(cur.sideEl, cur.boardEl.nextSibling);
    }
    for (const tab of tabs.values()) if (tab.sideEl) tab.sideEl.classList.toggle('cur', tab.sid === sid);
    if (lr) { noteFold(sid); paintRail('L'); paintRail('R'); }
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

  // —— 栏宽 ——
  const RAIL = { L: { rail: $('railL'), grip: $('gripL'), def: 260, dir: 1 }, R: { rail: $('railR'), grip: $('gripR'), def: 360, dir: -1 } };
  const MIN_W = 180, FOLD = 120, STRIP = 14, KEY = 'butler.rail.';
  const maxW = () => Math.max(MIN_W, Math.round(window.innerWidth * 0.4));
  const foldBase = new Map();   // sid → 右栏收起时已有的收藏 id; 之后新来的算进细边角标, 展开清空
  function railState(k) {
    let v = null;
    try { v = JSON.parse(localStorage.getItem(KEY + k)); } catch (_) {}
    const w = Number(v && v.w);
    return { w: w >= MIN_W ? w : RAIL[k].def, folded: !!(v && v.folded) };
  }
  const saveRail = (k, st) => { try { localStorage.setItem(KEY + k, JSON.stringify(st)); } catch (_) {} };

  // 正文永远按展开宽度排版, 收起只把栏本身收窄裁掉 —— 板里的插件不会因为变窄重新长高
  function paintRail(k, st = railState(k)) {
    const { rail } = RAIL[k];
    const w = Math.min(st.w, maxW());
    rail.classList.toggle('folded', st.folded);
    rail.style.width = (st.folded ? STRIP : w) + 'px';
    rail.querySelector('.rail-body').style.width = w + 'px';
    paintGrip(k, st);
  }
  function noteFold(sid) {
    if (sid && railState('R').folded && !foldBase.has(sid)) foldBase.set(sid, new Set(window.Marks.state(sid).items.map((x) => x.id)));
  }
  function paintGrip(k, st = railState(k)) {
    let n = 0;
    if (k === 'R') {
      const base = st.folded && foldBase.get(activeSid);
      n = base ? window.Marks.state(activeSid).items.filter((x) => !base.has(x.id)).length : 0;
      const b = $('gripBadge');
      b.textContent = n ? String(n) : '';
      b.classList.toggle('hidden', !n);
    }
    RAIL[k].grip.title = !st.folded ? t('rail_grip') : n ? t('rail_open_n', { n }) : t('rail_open');
  }

  for (const k of ['L', 'R']) {
    const { grip, dir } = RAIL[k];
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const st0 = railState(k), x0 = e.clientX;
      const w0 = st0.folded ? 0 : Math.min(st0.w, maxW());
      let st = st0, moved = false;
      body.classList.add('rail-drag'); grip.classList.add('cur');
      const move = (ev) => {
        const dx = (ev.clientX - x0) * dir;
        if (!moved && Math.abs(dx) < 3) return;
        moved = true;
        const w = w0 + dx;
        st = w < FOLD ? { w: st0.w, folded: true } : { w: Math.round(Math.max(MIN_W, Math.min(maxW(), w))), folded: false };
        paintRail(k, st);
      };
      const up = () => {
        grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
        body.classList.remove('rail-drag'); grip.classList.remove('cur');
        if (!moved) { if (!st0.folded) return; st = { w: st0.w, folded: false }; }   // 收起时单点 = 展开
        saveRail(k, st);
        if (k === 'R') { foldBase.clear(); noteFold(activeSid); }
        paintRail(k, st);
      };
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
    });
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
  window.Marks.onChange((sid) => { if (sid === activeSid) { paintBtn(); paintGrip('R'); } });
  $('lang').addEventListener('change', () => setTimeout(() => { window.Marks.paint(); paintBtn(); paintGrip('L'); paintGrip('R'); }, 300));

  // renderer.js 在切标签、读完历史后调这个
  window.layoutUI = {
    async sync(sid) { await window.Marks.show(sid); if (sid === activeSid) apply(); },
  };
  if (activeSid) window.layoutUI.sync(activeSid);
})();
