// search-ui.js — 系统设置里的「联网搜索」区块: Brave / Tavily key + 优先用哪家。
// 跟 settings-ui.js 同页加载, 直接用它的 t() / toast()。规则与存法见 core/search-keys.js:
// key 只进不出(输入框空着 = 不改), 优先是单选, 默认「服务端优先」。

const SK = {
  input: { brave: document.getElementById('sk-brave'), tavily: document.getElementById('sk-tavily') },
  save: document.getElementById('sk-save'),
  radios: () => [...document.querySelectorAll('input[name="sk-prefer"]')],
};
let _skLast = null;

function skRender(d) {
  if (d) _skLast = d;
  const s = _skLast; if (!s) return;
  for (const [p, el] of Object.entries(SK.input)) {
    el.value = '';
    el.placeholder = s.keys[p] === 'ok' ? t('sys_api_key_saved') : (s.keys[p] === 'stale' ? t('sys_api_key_stale_ph') : '');
  }
  for (const r of SK.radios()) r.checked = r.value === (s.prefer || '');
}

async function skRefresh() {
  try { skRender(await window.butler.listSearchKeys()); }
  catch (e) { console.error('[settings] listSearchKeys failed:', e && e.message); }
}

async function skSubmit(patch) {
  const r = await window.butler.saveSearchKeys(patch);
  if (!r.ok) { toast(r.error === 'encryption_unavailable' ? t('sys_api_no_keychain') : t('mgr_save_failed') + (r.error || '')); return; }
  toast(t('sys_saved_restart'));
  skRefresh();
}

SK.save.addEventListener('click', () => {
  const prefer = (SK.radios().find((r) => r.checked) || {}).value || '';
  // 选了优先却既没存过也没现填 key: 存下去也不会生效(core/search-keys.js 会当作没勾), 当场说清楚
  if (prefer && _skLast && _skLast.keys[prefer] !== 'ok' && !SK.input[prefer].value.trim()) {
    toast(t('sys_search_need_key', { name: prefer === 'brave' ? 'Brave' : 'Tavily' }));
    return;
  }
  skSubmit({ brave: SK.input.brave.value, tavily: SK.input.tavily.value, prefer });
});

for (const b of document.querySelectorAll('.sk-del')) {
  b.addEventListener('click', () => {
    const p = b.dataset.p;
    // 删掉的正是优先那家 → 优先一并退回默认, 不留一个指向空 key 的勾
    skSubmit({ [p]: null, ...(_skLast && _skLast.prefer === p ? { prefer: '' } : {}) });
  });
}

window.butler.onLocaleChanged && window.butler.onLocaleChanged(() => skRender());
skRefresh();
