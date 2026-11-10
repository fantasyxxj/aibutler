// tier-picker.js — 建人格时「要多聪明?」四档按钮: 最强 · 强 · 日常(默认) · 省钱。
// 选一档就在这把 key 上找那一档能用的具体型号(主进程 pick-model-for-tier 真发一条试通), 结果写在按钮下面。
// 首启屏(empty-state.js)和人格管理(manager.js)共用; 文案走 i18n 的 tier_* 键, 由调用方传 t 进来。
// 规矩见 core/model-tier.js 顶部: 整档不通只如实说原因 + 给「换便宜一档」, 不替用户换档。
// 出厂表标 manual 的厂家(豆包)主进程回 manual: 不出四档, 只出提示和状态行; 用户在调用方原有的模型下拉里选,
// 调用方选中时调 check(型号), 只试那一个。
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
    no_key: t('tier_why_no_key'), not_open: t('tier_why_not_open') }[r] || t('tier_why_error'));

  // opts: { t, credentialId(), onChange({ model, tier, ok }), tier?, currentModel()?, onManual(on)? }
  //   → { el, refresh(), model(), paint(), manual(), check(型号) }
  // tier: null = 一开始哪档都不亮(人格管理照抄管家的模型时用), 第一次试的时候落到日常
  function create(opts) {
    if (!styled) { const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); styled = true; }
    const el = document.createElement('div');
    el.className = 'tp';
    let tier = opts.tier === undefined ? 'daily' : opts.tier, model = '', seq = 0, last = null;
    let manual = false, pickId = '', cred = null;   // manual: 这把 key 是自选型号的厂家; pickId: 用户在模型下拉里选中的
    const bare = (m) => String(m || '').replace(/^[a-z]+\//, '');
    const paint = () => {
      const t = opts.t;
      if (manual) {
        el.innerHTML = `<div class="es-field">${esc(t('tier_manual_label'))}</div><div class="tp-hint">${esc(t('tier_manual_hint'))}</div>
          <div class="tp-st"></div>`;
        status();
        return;
      }
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
      st.textContent = (manual ? t('tier_manual_fail') : t('tier_fail')).replace('{why}', why(t, r));
      const i = ORDER.indexOf(tier);
      if (!manual && i >= 0 && i < ORDER.length - 1) {
        const b = document.createElement('button');
        b.textContent = t('tier_cheaper');
        b.onclick = () => { tier = ORDER[i + 1]; paint(); run(); };
        st.appendChild(b);
      }
    };
    async function run() {
      if (!tier) { tier = 'daily'; paint(); }
      const credentialId = opts.credentialId() || '';
      if (credentialId !== cred) { cred = credentialId; manual = false; pickId = ''; }   // 换了 key: 选中的作废
      const my = ++seq;
      model = ''; last = { pending: true }; status();
      el.querySelectorAll('.tp-row button').forEach((b) => { b.disabled = true; });
      let r;
      try { r = await window.butler.pickModelForTier({ credentialId, tier, id: pickId }); }
      catch (e) { r = { ok: false, reason: 'error' }; }
      if (my !== seq) return;   // 中途又点了别的档 / 换了 key: 旧结果作废
      const wasManual = manual;
      manual = !!(r && r.manual);
      last = r && r.reason === 'pick' ? null : r; model = r && r.ok ? r.model : '';
      if (manual !== wasManual) { paint(); if (opts.onManual) opts.onManual(manual); }
      // 刚认出是自选型号的厂家、还没选过: 模型下拉里已停着一个就拿它试
      if (manual && !pickId && opts.currentModel && bare(opts.currentModel())) { pickId = bare(opts.currentModel()); return run(); }
      el.querySelectorAll('.tp-row button').forEach((b) => { b.disabled = false; });
      status();
      if (opts.onChange) opts.onChange({ model, tier, ok: !!(r && r.ok) });
    }
    paint();
    // 调用方的模型下拉选中一个: 自选型号厂家才试, 分档厂家不管(那边是档位决定型号)
    const check = (id) => { if (!manual || !bare(id) || bare(id) === pickId) return; pickId = bare(id); run(); };
    return { el, refresh: run, model: () => model, tier: () => tier, paint, manual: () => manual, check };
  }

  window.TierPicker = { create };
})();
