// chips.js — 输入框上方 prompt 快捷按钮。renderer.js 已 1157 行, 按 ≤500 行铁律独立成文件。
// 契约(单向依赖): 本文件只暴露 window.chipsUI, 由 renderer.js 在切标签/busy 变化时调;
//   不读 renderer.js 的内部状态, sid 一律由调用方传入。发消息复用现成 window.emitUserMessage。
// 行为: 点一下=直接把 prompt 全文当用户消息发出去(气泡显示全文, 顺带教用户怎么说话), 不是填进输入框。
//   点一下只计数, 按钮**留在原地**(2026-08-17 作者统一口径, 取消了原先的"点过即焚")。
//   退休只有两条路: 用户说清掉, 或 AI 发现长期没人点后【提醒用户】—— 程序不自动删。
//   池子空了就不显示任何东西 —— 跟没有 chip 的基线一致, 不做兜底。

(() => {
  const bar = () => document.getElementById('chipbar');
  let curSid = null;
  let disabled = false;

  function paint(chips) {
    const el = bar();
    if (!el) return;
    el.innerHTML = '';
    const list = Array.isArray(chips) ? chips : [];
    el.style.display = list.length ? '' : 'none';
    for (const c of list) {
      if (!c || !c.label || !c.prompt) continue;
      const b = document.createElement('button');
      b.className = 'chip' + (c.kind === 'main' ? ' chip-main' : '');
      b.type = 'button';
      b.disabled = disabled;
      b.title = c.prompt;   // 悬停看全文, 点之前知道会发出去什么
      b.textContent = (c.icon ? c.icon + ' ' : '') + c.label;
      b.addEventListener('click', () => onClick(c));
      el.appendChild(b);
    }
  }

  async function onClick(c) {
    if (disabled || !curSid) return;
    const sid = curSid;
    // 先发再计数: 发送是用户要的结果, 计数只是统计, 顺序反了会出现"记上了但没发出去"
    if (typeof window.emitUserMessage === 'function') window.emitUserMessage(sid, c.prompt);
    try {
      const r = await window.butler.bumpChip(sid, c.id);
      if (sid === curSid) paint((r && r.chips) || []);
    } catch (e) { console.error('[chips] bumpChip 失败:', e); }
  }

  async function refresh(sid) {
    curSid = sid || null;
    if (!curSid) return paint([]);
    try {
      const r = await window.butler.getChips(curSid);
      paint((r && r.chips) || []);
    } catch (e) { console.error('[chips] getChips 失败:', e); paint([]); }
  }

  // AI 忙时置灰: 跟 sendBtn 同状态, 防手滑在流式中途再塞一条
  function setDisabled(v) {
    disabled = !!v;
    const el = bar();
    if (el) el.querySelectorAll('button.chip').forEach((b) => { b.disabled = disabled; });
  }

  // 🔴 切界面语言时按钮必须跟着换。出厂 chip 的 label/prompt 是按显示语言现挑的
  // (core/registry.js 的 resolveChips → localize), 但挑是在【取的那一刻】发生的 ——
  // 没有这个订阅, 已经画在屏幕上的按钮会停在旧语言直到重启, 而且不报错。
  // 订阅放在这儿而不是 renderer.js: 按钮的所有者对自己的语言负责, 少一处跨文件耦合。
  // 只重取不重画别的 —— refresh 里就是 getChips + paint, 语言已在主进程侧更新完才发的事件。
  if (window.butler && window.butler.onLocaleChanged) {
    window.butler.onLocaleChanged(() => { if (curSid) refresh(curSid); });
  }

  window.chipsUI = { refresh, setDisabled, paintFor: (sid, chips) => { if (sid === curSid) paint(chips); } };
})();
