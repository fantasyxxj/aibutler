// edit-tabs.js — 人格编辑面板分标签页: 基本 · AI · 身份档案 · 连接 · 高级。
//
// 面板本身仍由 manager.js 的 makeEditPanel 拼(字段、事件都在那儿), 这里只在拼好之后
// 按选择器把每一块认领到某个标签下 —— 不碰字段本身, 保存/取消照旧读整个面板。
// 只想换个头像的人不该一打开就面对 token 和 persona.md 原文(作者 2026-11-06 定)。
(() => {
  const TABS = [
    ['basic', 'mgr_tab_basic', ['.e-name', '.avatar-picker', '.e-voice-en']],
    ['ai', 'mgr_tab_ai', ['.e-acc-sub', '.e-sdk', '.e-model-sel']],
    ['profile', 'mgr_tab_profile', ['.e-persona-md']],
    ['connect', 'mgr_tab_connect', ['.e-plugin']],
    ['adv', 'mgr_tab_adv', ['.e-wake', '.e-dir']],
  ];
  let last = 'basic';   // 换个人格编辑时停在上次看的那页

  function apply(box, t) {
    const owner = (sel) => { const e = box.querySelector(sel); return e && (e.closest('.e-line') || e.closest('.e-persona-md, .e-plugin') || e); };
    const bar = document.createElement('div'); bar.className = 'e-tabs';
    const panes = {};
    for (const [id, key, sels] of TABS) {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.tab = id; b.textContent = t(key);
      bar.appendChild(b);
      panes[id] = sels.map(owner).filter(Boolean);
      panes[id].forEach((e) => { e.dataset.tab = id; });
    }
    // Telegram 只露模式和 bot token; in_file / chat_ids 收进折叠(bus 原始表 hub-panel 已经收了)
    const tgAdv = ['.pt-in', '.pt-chats'].map(owner).filter(Boolean);
    if (tgAdv.length) {
      const det = document.createElement('details'); det.className = 'e-fold';
      const sum = document.createElement('summary'); sum.textContent = t('mgr_tab_adv');
      det.appendChild(sum);
      tgAdv[0].parentNode.insertBefore(det, tgAdv[0]);
      tgAdv.forEach((e) => det.appendChild(e));
    }
    const show = (id) => {
      last = id;
      bar.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
      for (const [k, els] of Object.entries(panes)) els.forEach((e) => { e.hidden = k !== id; });
    };
    bar.addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) show(b.dataset.tab); });
    box.insertBefore(bar, box.firstChild);
    show(last);
  }

  window.EditTabs = { apply };
})();
