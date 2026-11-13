// marks.js — 「收藏夹」区。人格在回复里写 {{mark:标题}}, 这条回复就挂进侧栏, 一条条累积。
//
// 和常驻板(board.js)是两回事: 板是「槽位」, 同名再钉一次就顶掉旧的, 装的是一直要点的界面;
// 这里是「清单」, 只加不顶, 装的是长期干活时滚上去了还要回头看的结论 / 方案 / 路径 / 待拍板。
//
// 每条自己存一份正文(personal/side-state.js), 所以原消息被屏幕上限裁掉也照样点得开;
// 原消息还在屏幕上时多给一个「跳回原处」。
//
// 契约: 只暴露 window.Marks; 数据走 window.butler.side* / mark*; 用 renderer.js 的 t()(运行时才调)。
(function () {
  'use strict';

  const MARK_TOKEN = /\{\{mark:[^}\n]*\}\}[ \t]*\n?/g;
  const ANY_TOKEN = /\{\{(cmd|in|sel|btn|ui|pin|mark|picks|pick):[^}\n]*\}\}/g;

  // 列表里那几行预览: 去掉控件印和 markdown 符号, 取开头几行非空的
  function preview(text, lines = 3, max = 180) {
    const out = [];
    for (const raw of String(text || '').replace(ANY_TOKEN, '').split('\n')) {
      const s = raw.replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+|\|)/, '')
        .replace(/[*_`~]|\|/g, ' ').replace(/\s+/g, ' ').trim();
      if (!s || /^-{3,}$/.test(s) || /^:?-+:?(\s+:?-+:?)*$/.test(s)) continue;
      out.push(s);
      if (out.length >= lines) break;
    }
    const s = out.join('\n');
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  // 回放历史时把屏幕上的原消息认回已存的那条: 同标题里挑时刻最近、还没被认领的
  function pickForReplay(items, title, ts, taken) {
    let best = null, bestD = Infinity;
    for (const x of items) {
      if (x.title !== title || taken.has(x.id)) continue;
      const d = ts ? Math.abs(x.ts - ts) : 0;
      if (d < bestD) { best = x; bestD = d; }
    }
    return best;
  }

  const api = { preview, pickForReplay, MARK_TOKEN };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  const cache = new Map();          // sid → { layout, items }
  const listeners = new Set();
  let host = null, curSid = null;
  const open = new Set();           // 展开着的条目 id(重画时保持)
  const emit = (sid) => listeners.forEach((f) => { try { f(sid); } catch (_) {} });
  const tt = (k, v) => (typeof t === 'function' ? t(k, v) : k);   // t 是 renderer.js 顶层的 const, 不在 window 上

  async function load(sid, force) {
    if (!sid) return { layout: 'tb', items: [] };
    if (!force && cache.has(sid)) return cache.get(sid);
    let st = { layout: 'tb', items: [] };
    try { const r = await window.butler.sideRead(sid); if (r && !r.error) st = r; } catch (_) {}
    cache.set(sid, st);
    return st;
  }
  const state = (sid) => cache.get(sid) || { layout: 'tb', items: [] };
  const unseen = (sid) => state(sid).items.filter((x) => !x.seen).length;
  function put(sid, st) { if (st && !st.error) { cache.set(sid, { layout: st.layout, items: st.items || [] }); emit(sid); paint(); } }

  /* renderMd 描完一条气泡后调。src = 渲染前的 markdown 原文。
     replaying(开窗回放 / 往上翻补页)时不新增, 只把原消息认回已存的那条, 好让「跳回原处」可用。 */
  function harvest(sid, body, src, replaying) {
    const nodes = Array.from(body.querySelectorAll('.md-widget[data-kind="mark"]'));
    if (!nodes.length) return;
    const title = nodes.map((n) => (n.dataset.spec || '').trim()).find(Boolean) || '';
    nodes.forEach((n) => { const p = n.parentElement; n.remove(); if (p && p.tagName === 'P' && !p.textContent.trim() && !p.children.length) p.remove(); });
    const msg = body.closest('.msg');
    if (!title || !sid) return;
    if (msg) msg.classList.add('marked');
    const st = state(sid);
    if (replaying) {
      const taken = new Set(Array.from(document.querySelectorAll('.msg[data-mark-id]')).map((m) => m.dataset.markId));
      const it = pickForReplay(st.items, title, msg && Number(msg.dataset.ts), taken);
      if (it && msg) msg.dataset.markId = it.id;
      return;
    }
    const text = String(src || '').replace(MARK_TOKEN, '').trim();
    const ts = (msg && Number(msg.dataset.ts)) || Date.now();
    window.butler.markAdd(sid, title, text, ts).then((r) => {
      const item = r && r.item;
      if (!item) return;
      if (msg) msg.dataset.markId = item.id;
      const cur = state(sid);
      cache.set(sid, { layout: cur.layout, items: cur.items.concat(item) });
      emit(sid); paint();
    }).catch(() => {});
  }

  function fmtTime(ts) {
    const d = new Date(ts), p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const msgOf = (id) => document.querySelector(`.panel.show .msg[data-mark-id="${String(id).replace(/["\\]/g, '')}"]`);

  function jump(id) {
    const m = msgOf(id);
    if (!m) return;
    m.scrollIntoView({ block: 'start', behavior: 'smooth' });
    m.classList.add('mark-flash');
    setTimeout(() => m.classList.remove('mark-flash'), 1600);
  }

  async function del(sid, it) {
    if (!window.confirm(tt('marks_del_confirm', { title: it.title }))) return;
    open.delete(it.id);
    try { put(sid, await window.butler.markDel(sid, it.id)); } catch (_) {}
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // 画进侧栏。全部用 textContent / createElement —— 标题和正文都是模型写的。
  function paint() {
    if (!host) return;
    const sid = curSid;
    const items = state(sid).items.slice().reverse();   // 新的在上
    host.innerHTML = '';
    const head = el('div', 'mk-head');
    head.append(el('span', 'mk-h', tt('marks_title')), el('span', 'mk-n', items.length ? String(items.length) : ''));
    host.appendChild(head);
    const list = el('div', 'mk-list');
    host.appendChild(list);
    if (!items.length) { list.appendChild(el('div', 'mk-empty', tt('marks_empty'))); return; }
    for (const it of items) {
      const row = el('div', 'mk-item' + (open.has(it.id) ? ' open' : ''));
      const top = el('div', 'mk-top');
      top.append(el('span', 'mk-time', fmtTime(it.ts)), el('span', 'mk-title', it.title));
      const tools = el('span', 'mk-tools');
      if (msgOf(it.id)) {
        const j = el('button', 'mk-btn', '↩');
        j.type = 'button'; j.title = tt('marks_jump');
        j.addEventListener('click', (e) => { e.stopPropagation(); jump(it.id); });
        tools.appendChild(j);
      }
      const x = el('button', 'mk-btn', '✕');
      x.type = 'button'; x.title = tt('marks_del');
      x.addEventListener('click', (e) => { e.stopPropagation(); del(sid, it); });
      tools.appendChild(x);
      top.appendChild(tools);
      row.appendChild(top);
      if (open.has(it.id)) {
        const full = el('div', 'mk-full md');
        const src = String(it.text || '').replace(ANY_TOKEN, '');
        const html = typeof window.renderMarkdown === 'function' ? window.renderMarkdown(src) : '';
        if (html) full.innerHTML = html; else full.textContent = src;
        full.addEventListener('click', (e) => e.stopPropagation());   // 里面选字、点链接不收起
        row.appendChild(full);
      } else {
        row.appendChild(el('div', 'mk-prev', preview(it.text)));
      }
      top.addEventListener('click', () => { open.has(it.id) ? open.delete(it.id) : open.add(it.id); paint(); });
      row.addEventListener('click', (e) => { if (e.target === row || e.target.classList.contains('mk-prev')) top.click(); });
      list.appendChild(row);
    }
  }

  function mount(node) { host = node; paint(); }
  async function show(sid) { curSid = sid; await load(sid); paint(); }
  async function setLayout(sid, layout) {
    try { put(sid, await window.butler.sideLayout(sid, layout)); } catch (_) {}
  }
  function onChange(f) { listeners.add(f); }

  window.Marks = Object.assign({ load, state, unseen, harvest, mount, show, paint, setLayout, onChange }, api);
})();
