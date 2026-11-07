// tier-picker.js — 建人格时「要多聪明?」四档按钮: 最强 · 强 · 日常(默认) · 省钱。
// 选一档就在这把 key 上找那一档能用的具体型号(主进程 pick-model-for-tier 真发一条试通), 结果写在按钮下面。
// 首启屏(empty-state.js)和人格管理(manager.js)共用; 文案走 i18n 的 tier_* 键, 由调用方传 t 进来。
// 规矩见 core/model-tier.js 顶部: 整档不通只如实说原因 + 给「换便宜一档」, 不替用户换档。
'use strict';

(function () {
  const ORDER = ['top', 'strong', 'daily', 'cheap'];
  const CSS = `
.tp { margin: 4px 0 8px; }
.tp-row { display: flex; gap: 6px; flex-wrap: wrap; margin: 4px 0 6px; }
.tp-row button { border: 1px solid var(--line); background: var(--panel-2); color: var(--text); border-radius: 999px; padding: 5px 12px; font-size: 12.5px; cursor: pointer; }
.tp .tp-row button.on, #emptyState .tp .tp-row button.on, #emptyState .tp .tp-row button.on:hover { border-color: var(--brand); background: var(--brand); color: #fff; font-weight: 500; }
.tp-row button:disabled { opacity: .4; cursor: default; }
.tp-hint { font-size: 12px; color: var(--muted); }
.tp-st { font-size: 12px; color: var(--muted); min-height: 1.4em; }
.tp-st.bad { color: var(--danger); }
.tp-st button { margin-left: 6px; font-size: 12px; }
`;
  let styled = false;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // 键名写成字面量: test-i18n 靠扫源码认键
  const label = (t, k) => ({ top: t('tier_top'), strong: t('tier_strong'), daily: t('tier_daily'), cheap: t('tier_cheap') }[k]);
  const why = (t, r) => ({ auth: t('tier_why_auth'), quota: t('tier_why_quota'), no_model: t('tier_why_no_model'), rate: t('tier_why_rate'),
    upstream: t('tier_why_upstream'), network: t('tier_why_network'), list_failed: t('tier_why_list_failed'), no_models: t('tier_why_no_models'),
    no_key: t('tier_why_no_key') }[r] || t('tier_why_error'));

  // opts: { t, credentialId(), onChange({ model, tier, ok }), tier? }  → { el, refresh(), model(), paint() }
  // tier: null = 一开始哪档都不亮(人格管理照抄管家的模型时用), 第一次试的时候落到日常
  function create(opts) {
    if (!styled) { const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); styled = true; }
    const el = document.createElement('div');
    el.className = 'tp';
    let tier = opts.tier === undefined ? 'daily' : opts.tier, model = '', seq = 0, last = null;
    const paint = () => {
      const t = opts.t;
      el.innerHTML = `<div class="es-field">${esc(t('tier_label'))}</div><div class="tp-hint">${esc(t('tier_hint'))}</div>
        <div class="tp-row">${ORDER.map((k) => `<button data-k="${k}"${k === tier ? ' class="on"' : ''}>${esc(label(t, k))}</button>`).join('')}</div>
        <div class="tp-st"></div>`;
      el.querySelectorAll('.tp-row button').forEach((b) => { b.onclick = () => { tier = b.dataset.k; paint(); run(); }; });
      status();
    };
    const status = () => {
      const st = el.querySelector('.tp-st'); const t = opts.t;
      if (!st) return;
      st.className = 'tp-st';
      if (!last) { st.textContent = ''; return; }
      if (last.pending) { st.textContent = t('tier_probing'); return; }
      if (last.ok) { st.textContent = (last.fallback ? t('tier_ok_fallback') : (last.used ? t('tier_ok_used') : t('tier_ok'))).replace('{model}', last.id); return; }
      st.classList.add('bad');
      const r = (last.tried && last.tried.length && last.reason === 'tier_unusable') ? last.tried[last.tried.length - 1].reason : last.reason;
      st.textContent = t('tier_fail').replace('{why}', why(t, r));
      const i = ORDER.indexOf(tier);
      if (i >= 0 && i < ORDER.length - 1) {
        const b = document.createElement('button');
        b.textContent = t('tier_cheaper');
        b.onclick = () => { tier = ORDER[i + 1]; paint(); run(); };
        st.appendChild(b);
      }
    };
    async function run() {
      if (!tier) { tier = 'daily'; paint(); }
      const my = ++seq;
      model = ''; last = { pending: true }; status();
      el.querySelectorAll('.tp-row button').forEach((b) => { b.disabled = true; });
      let r;
      try { r = await window.butler.pickModelForTier({ credentialId: opts.credentialId() || '', tier }); }
      catch (e) { r = { ok: false, reason: 'error' }; }
      if (my !== seq) return;   // 中途又点了别的档 / 换了 key: 旧结果作废
      last = r; model = r && r.ok ? r.model : '';
      el.querySelectorAll('.tp-row button').forEach((b) => { b.disabled = false; });
      status();
      if (opts.onChange) opts.onChange({ model, tier, ok: !!(r && r.ok) });
    }
    paint();
    return { el, refresh: run, model: () => model, tier: () => tier, paint };
  }

  window.TierPicker = { create };
})();
