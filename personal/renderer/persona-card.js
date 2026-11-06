// persona-card.js — 人格的头像与卡片, 主界面「人格 ▾」下拉和人格管理窗口共用一份。
//
// 挂在 window.PersonaCard 下而不是裸全局函数: manager.js 自己有个 const isImgAvatar,
// 同一页里再声明一个同名全局函数就是 SyntaxError, 整页脚本都不跑。
(() => {
  const AVATAR_COLORS = ['#e0567a', '#e08a56', '#c9a227', '#5cae5c', '#4aa3c7', '#6b7ae0', '#a15ce0', '#c74a9e'];
  // avatar 字段: 图片(data:/file:/http/绝对路径) → 照片头像; 否则 emoji; 空 → 字母头像
  const isImgAvatar = (v) => typeof v === 'string' && /^(data:|file:|https?:|\/)/.test(v);
  function avatarOf(persona) {
    const name = (persona && persona.name) || '?';
    const av = persona && persona.avatar;
    if (av && isImgAvatar(av)) return { img: av };
    if (av) return { emoji: av };
    let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return { letter: [...name][0] || '?', bg: AVATAR_COLORS[h % AVATAR_COLORS.length] };
  }
  function paintAvatar(el, persona) {
    if (!el) return;
    const a = avatarOf(persona);
    el.classList.toggle('is-emoji', !!a.emoji);
    el.classList.toggle('is-photo', !!a.img);
    if (a.img) {
      el.textContent = '';
      el.style.backgroundImage = `url("${a.img}")`;
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      el.style.backgroundColor = 'transparent';
    } else {
      el.style.backgroundImage = '';
      el.textContent = a.emoji || a.letter;
      el.style.background = a.emoji ? 'transparent' : a.bg;
    }
  }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function avatarEl(p, cls) { const a = el('span', 'pc-avatar ' + (cls || '')); paintAvatar(a, p); return a; }

  // 一行小字: 走订阅还是 key · 用哪个模型。卡片和下拉都用, 一眼分清两个同名风格的人格
  function metaLine(p, t) {
    const acc = p.accessMode === 'api' ? t('pc_access_api') : t('pc_access_sub');
    return `${acc} · ${p.model || t('mgr_model_default')}`;
  }

  // 下拉里的一行: 头像 + 名字 + 一行小字; 开着的亮绿点。点哪行都切过去(开着的直接切标签)
  function row(p, { t, onClick }) {
    const it = el('div', 'p-item' + (p.open ? ' open' : ''));
    const txt = el('div', 'p-txt');
    const nm = el('div', 'p-name', p.name);
    if (p.isButler) nm.appendChild(el('span', 'p-tag butler', t('butler')));
    txt.append(nm, el('div', 'p-meta', metaLine(p, t)));
    it.append(avatarEl(p, 'sm'), txt);
    if (p.open) { const dot = el('span', 'pc-dot'); dot.title = t('opened'); it.appendChild(dot); }
    it.addEventListener('click', onClick);
    return it;
  }

  // 管理窗口的卡片: 点卡片 = 打开对话; 「编辑」常驻, 不常用的收进「⋯」
  function card(p, { t, onOpen, onEdit, menu }) {
    const c = el('div', 'pc-card' + (p.open ? ' open' : ''));
    c.title = p.homeDir || '';
    const head = el('div', 'pc-head');
    const nm = el('div', 'pc-name', p.name);
    if (p.isButler) nm.appendChild(el('span', 'm-tag butler', t('butler')));
    const who = el('div', 'pc-who');
    who.append(nm, el('div', 'pc-meta', metaLine(p, t)));
    head.append(avatarEl(p, 'lg'), who);
    if (p.open) { const dot = el('span', 'pc-dot'); dot.title = t('opened'); head.appendChild(dot); }

    const more = el('button', 'pc-more', '⋯'); more.title = t('pc_more');
    const pop = el('div', 'pc-menu'); pop.hidden = true;
    for (const m of menu) {
      const b = el('button', m.danger ? 'danger' : '', m.label);
      b.disabled = !!m.disabled; if (m.title) b.title = m.title;
      b.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden = true; m.onClick(); });
      pop.appendChild(b);
    }
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const was = pop.hidden;
      document.querySelectorAll('.pc-menu').forEach((x) => { x.hidden = true; });
      pop.hidden = !was;
    });

    const foot = el('div', 'pc-foot');
    const edit = el('button', 'm-btn', t('mgr_edit'));
    edit.addEventListener('click', (e) => { e.stopPropagation(); onEdit(edit); });
    const open = el('button', 'm-btn primary', t('pc_open_chat'));
    open.addEventListener('click', (e) => { e.stopPropagation(); onOpen(); });
    foot.append(open, edit);

    c.append(head, more, pop, foot);
    c.addEventListener('click', onOpen);
    return { card: c, editBtn: edit };
  }

  document.addEventListener('click', () => document.querySelectorAll('.pc-menu').forEach((x) => { x.hidden = true; }));
  window.PersonaCard = { isImgAvatar, avatarOf, paintAvatar, row, card };
})();
