// reminder-banner.js — 到点的提醒挂在窗口顶上, 一条一行: 人格名 · 时间 · 提醒原文 · 忽略 / 稍后 / 处理。
//
// 提醒是给人看的: 挂出来时不切标签、不点亮未读、不叫醒人格。只有点「处理」, 主进程才打开那个人格,
// 这里再把提醒原文当作这个人说的一句话交给它(走和输入框一样的 emitUserMessage)。
// 文案四语与样式自带(同 empty-state.js) —— renderer.js / i18n.js 都已过 500 行, 不往里加。
// 依赖 renderer.js 的顶层: curLocale · switchTab · window.emitUserMessage。
(function () {
  const L = {
    'zh-CN': { ignore: '忽略', later: '稍后', handle: '处理', m10: '10 分钟后', h1: '1 小时后', tmr: '明早 9 点', more: '还有 {n} 条' },
    'zh-TW': { ignore: '忽略', later: '稍後', handle: '處理', m10: '10 分鐘後', h1: '1 小時後', tmr: '明早 9 點', more: '還有 {n} 條' },
    ja: { ignore: '無視', later: 'あとで', handle: '対応', m10: '10 分後', h1: '1 時間後', tmr: '明朝 9 時', more: 'ほか {n} 件' },
    en: { ignore: 'Ignore', later: 'Later', handle: 'Handle', m10: 'In 10 min', h1: 'In 1 hour', tmr: 'Tomorrow 9:00', more: '{n} more' },
  };
  const SHOW = 3;
  const s = () => L[curLocale] || L[String(curLocale || '').slice(0, 2)] || L.en;

  const css = document.createElement('style');
  css.textContent = '#reminderBar{display:flex;flex-direction:column;border-bottom:1px solid var(--line);border-left:3px solid var(--accent);background:var(--panel);color:var(--text);font-size:12px}'
    + '#reminderBar:empty{display:none}'
    + '#reminderBar .rb-row{display:flex;align-items:center;gap:8px;padding:5px 14px;min-width:0}'
    + '#reminderBar .rb-row+.rb-row{border-top:1px solid var(--line)}'
    + '#reminderBar .rb-who{flex:0 0 auto;font-weight:600;color:var(--text)}'
    + '#reminderBar .rb-when{flex:0 0 auto;color:var(--muted)}'
    + '#reminderBar .rb-text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}'
    + '#reminderBar button,#reminderBar select{flex:0 0 auto;padding:2px 10px;font-size:12px;border-radius:4px;border:1px solid var(--line);background:var(--panel-2);color:var(--text);cursor:pointer}'
    + '#reminderBar button.rb-go{background:var(--accent);border-color:var(--accent);color:#1e1e28}'
    + '#reminderBar .rb-more{padding:3px 14px;color:var(--muted)}';
  document.head.appendChild(css);

  const bar = document.createElement('div');
  bar.id = 'reminderBar';
  const anchor = document.getElementById('authBanner');
  anchor.parentNode.insertBefore(bar, anchor.nextSibling);

  let items = [];
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  function tomorrowNine() { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime(); }

  async function act(r, action, extra) {
    const res = await window.butler.reminderAct({ homeDir: r.homeDir, id: r.id, action, ...(extra || {}) });
    if (action === 'handle' && res && res.ok && res.sid) {
      await switchTab(res.sid);
      window.emitUserMessage(res.sid, res.text);
    }
  }

  function row(r) {
    const S = s();
    const line = el('div', 'rb-row');
    line.appendChild(el('span', 'rb-who', `⏰ ${r.persona}`));
    line.appendChild(el('span', 'rb-when', r.when.slice(5, 16)));
    const t = el('span', 'rb-text', r.text);
    t.title = r.text;
    line.appendChild(t);
    const ign = el('button', 'rb-ign', S.ignore);
    ign.onclick = () => act(r, 'ignore');
    const later = el('select', 'rb-later');
    [['', S.later], ['10', S.m10], ['60', S.h1], ['tmr', S.tmr]].forEach(([v, label]) => {
      const o = el('option', null, label); o.value = v; later.appendChild(o);
    });
    later.onchange = () => {
      const v = later.value;
      if (!v) return;
      act(r, 'snooze', v === 'tmr' ? { until: tomorrowNine() } : { minutes: Number(v) });
    };
    const go = el('button', 'rb-go', S.handle);
    go.onclick = () => act(r, 'handle');
    line.appendChild(ign); line.appendChild(later); line.appendChild(go);
    return line;
  }

  function paint() {
    bar.textContent = '';
    items.slice(0, SHOW).forEach((r) => bar.appendChild(row(r)));
    if (items.length > SHOW) bar.appendChild(el('div', 'rb-more', s().more.replace('{n}', items.length - SHOW)));
  }

  window.butler.onReminders((d) => { items = (d && d.items) || []; paint(); });
  window.butler.remindersGet().then((d) => { items = (d && d.items) || []; paint(); }).catch(() => {});
  // 切界面语言时按钮跟着换字
  document.getElementById('lang').addEventListener('change', () => setTimeout(paint, 300));
})();
