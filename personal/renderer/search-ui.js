// search-ui.js — 系统设置里的「联网搜索」区块: 用户自己加搜索引擎、排先后、单家测一下、整体禁用。
// 跟 settings-ui.js 同页加载, 直接用它的 t() / toast()。规则与存法见 core/search-keys.js:
// 一家都不加 = 只用模型自带的搜索; 加了就只用加的这些(排前的先试); 勾禁用 = 加过的全不用、配置留着。
// 改动先留在页面上, 点保存才整张表写回; key 只进不出(输入框空着 = 不改)。

const SK = {
  list: document.getElementById('sk-list'),
  empty: document.getElementById('sk-empty'),
  offRow: document.getElementById('sk-off-row'),
  off: document.getElementById('sk-off'),
  type: document.getElementById('sk-type'),
  add: document.getElementById('sk-add'),
  save: document.getElementById('sk-save'),
};
let _sk = { engines: [], disabled: false, types: [] };   // 页面上的草稿
const skType = (type) => _sk.types.find((x) => x.type === type) || { name: type };

function skRow(e, i) {
  const ty = skType(e.type);
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 8px;border:1px solid var(--line);border-radius:6px'
    + (_sk.disabled ? ';opacity:.5' : '');
  const btn = (label, title, fn) => {
    const b = document.createElement('button');
    b.className = 'm-btn'; b.textContent = label; if (title) b.title = title;
    b.addEventListener('click', fn);
    return b;
  };
  const no = document.createElement('span');
  no.textContent = `${i + 1}.`; no.style.cssText = 'color:var(--muted);width:18px;font-size:12px';
  const name = document.createElement('b');
  name.textContent = ty.name; name.style.cssText = 'width:96px;font-size:13px';
  row.append(no, name);
  if (ty.key || ty.url) {
    const inp = document.createElement('input');
    inp.style.flex = '1'; inp.autocomplete = 'off';
    if (ty.key) {
      inp.type = 'password';
      inp.placeholder = e.key === 'ok' ? t('sys_api_key_saved') : (e.key === 'stale' ? t('sys_api_key_stale_ph') : 'API key');
      inp.value = e.newKey || '';
      inp.addEventListener('input', () => { e.newKey = inp.value; });
    } else {
      inp.placeholder = 'https://searx.example.com';
      inp.value = e.url || '';
      inp.addEventListener('input', () => { e.url = inp.value; });
    }
    row.append(inp);
  } else {
    const free = document.createElement('span');
    free.textContent = t('sys_search_no_key'); free.style.cssText = 'flex:1;color:var(--muted);font-size:12px';
    row.append(free);
  }
  const res = document.createElement('div');
  res.style.cssText = 'flex-basis:100%;font-size:12px;color:var(--muted);display:none';
  const move = (d) => { const j = i + d; if (j < 0 || j >= _sk.engines.length) return; const a = _sk.engines; [a[i], a[j]] = [a[j], a[i]]; skDraw(); };
  row.append(
    btn('↑', '', () => move(-1)),
    btn('↓', '', () => move(1)),
    btn(t('sys_search_test'), '', async (ev) => {
      ev.target.disabled = true;
      res.style.display = ''; res.style.color = 'var(--muted)'; res.textContent = t('sys_search_testing');
      const r = await window.butler.testSearchEngine({ id: e.id, type: e.type, url: e.url, key: e.newKey || '' });
      ev.target.disabled = false;
      res.style.color = r.ok ? 'var(--ok)' : 'var(--danger)';
      res.textContent = r.ok
        ? t('sys_search_test_ok', { ms: r.ms, n: r.count, first: r.first || '' })
        : t('sys_search_test_fail', { err: r.error === 'no key' ? t('sys_search_need_key', { name: ty.name }) : (r.error || '') });
    }),
    btn(t('mgr_delete'), '', () => { _sk.engines.splice(i, 1); skDraw(); }),
    res,
  );
  return row;
}

function skDraw() {
  SK.list.replaceChildren(..._sk.engines.map(skRow));
  const has = _sk.engines.length > 0;
  SK.empty.style.display = has ? 'none' : '';
  SK.offRow.style.display = has ? 'flex' : 'none';   // 加了至少一家才有「禁用」可勾
  SK.off.checked = !!_sk.disabled;
}

function skRender(d) {
  if (d) _sk = { ...d, engines: d.engines.map((e) => ({ ...e })) };
  SK.type.replaceChildren(..._sk.types.map((x) => { const o = document.createElement('option'); o.value = x.type; o.textContent = x.name; return o; }));
  skDraw();
}

async function skRefresh() {
  try { skRender(await window.butler.listSearchKeys()); }
  catch (e) { console.error('[settings] listSearchKeys failed:', e && e.message); }
}

SK.add.addEventListener('click', () => { _sk.engines.push({ type: SK.type.value, key: 'none' }); skDraw(); });
SK.off.addEventListener('change', () => { _sk.disabled = SK.off.checked; skDraw(); });

SK.save.addEventListener('click', async () => {
  // 要 key 的那家既没存过也没现填: 存下去也用不上(core/search-keys.js 会跳过它), 当场说清楚
  const miss = _sk.engines.find((e) => skType(e.type).key && e.key !== 'ok' && !(e.newKey || '').trim());
  if (miss) { toast(t('sys_search_need_key', { name: skType(miss.type).name })); return; }
  const r = await window.butler.saveSearchKeys({
    disabled: _sk.disabled,
    engines: _sk.engines.map((e) => ({ id: e.id, type: e.type, url: e.url, key: e.newKey || '' })),
  });
  if (!r.ok) { toast(r.error === 'encryption_unavailable' ? t('sys_api_no_keychain') : t('mgr_save_failed') + (r.error || '')); return; }
  toast(t('sys_saved_restart'));
  skRefresh();
});

window.butler.onLocaleChanged && window.butler.onLocaleChanged(() => skRender());
skRefresh();
