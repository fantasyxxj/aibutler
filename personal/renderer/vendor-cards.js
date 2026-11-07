// vendor-cards.js — 设置页「加一条」key 时先选厂家: 一排卡片, 点哪家就带好那家的名字和官方地址, 用户只贴 key。
// 最后一张「其他」= 网关 / 中转, 自己填地址(就是改版前那张空白表单)。
// 厂家表在 core/config/models/vendors.json, 经主进程 model-vendors 取; 选档不在这里, 在建人格时(tier-picker.js)。
'use strict';

(function () {
  const CSS = `
.vc { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 10px; margin-bottom: 8px; }
.vc-head { display: flex; align-items: center; font-size: 12.5px; color: var(--muted); margin-bottom: 8px; }
.vc-head span { flex: 1; }
.vc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 6px; }
.vc-grid button { border: 1px solid var(--line); background: var(--panel-2); color: var(--text); border-radius: var(--radius-sm);
  padding: 10px 6px; font-size: 13px; cursor: pointer; }
.vc-grid button:hover { border-color: var(--brand); }
.vc-grid button.vc-other { color: var(--muted); }
.vc-tag { font-size: 12px; color: var(--muted); white-space: nowrap; }
`;
  let vendors = [];
  let styled = false;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function load() {
    try { vendors = ((await window.butler.modelVendors()) || {}).vendors || []; } catch (_) { vendors = []; }
    return vendors;
  }

  // → 卡片框。onPick(vendor) · vendor = { id, label, base_url } 或 null(「其他」) · onCancel()
  function picker(t, onPick, onCancel) {
    if (!styled) { const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); styled = true; }
    const box = document.createElement('div');
    box.className = 'vc';
    box.innerHTML = `<div class="vc-head"><span>${esc(t('sys_vendor_pick'))}</span><button class="m-btn vc-cancel">${esc(t('sys_vendor_cancel'))}</button></div>
      <div class="vc-grid">${vendors.map((v, i) => `<button data-i="${i}">${esc(v.label)}</button>`).join('')}
      <button class="vc-other" data-i="-1">${esc(t('sys_vendor_other'))}</button></div>`;
    box.querySelector('.vc-cancel').addEventListener('click', onCancel);
    box.querySelectorAll('.vc-grid button').forEach((b) => b.addEventListener('click', () => {
      const v = vendors[Number(b.dataset.i)];
      onPick(v ? { id: v.id, label: v.label, base_url: v.base_url || '' } : null);
    }));
    return box;
  }

  const label = (id) => ((vendors.find((v) => v.id === id) || {}).label || '');

  window.VendorCards = { load, picker, label };
})();
