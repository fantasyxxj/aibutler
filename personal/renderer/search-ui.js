// search-ui.js — 系统设置里的「联网搜索」区块: 用户自己加搜索引擎、排先后、单家测一下、整体禁用。
// 跟 settings-ui.js 同页加载, 直接用它的 t() / toast()。规则与存法见 core/search-keys.js:
// 一家都不加 = 只用模型自带的搜索; 加了就只用加的这些(排前的先试); 勾禁用 = 加过的全不用、配置留着。
// 改动先留在页面上, 关窗(关闭键 · 红叉 · Esc)时有改动就问存不存, 存就整张表写回; key 只进不出(输入框空着 = 不改)。

const SK = {
  list: document.getElementById('sk-list'),
  empty: document.getElementById('sk-empty'),
  offRow: document.getElementById('sk-off-row'),
  off: document.getElementById('sk-off'),
  type: document.getElementById('sk-type'),
  add: document.getElementById('sk-add'),
};
let _sk = { engines: [], disabled: false, types: [] };   // 页面上的草稿
let _skBase = '';                                         // 上次从磁盘读到时草稿的样子, 关窗时拿来比
const skSnap = () => JSON.stringify({ d: !!_sk.disabled, e: _sk.engines.map((e) => [e.id || '', e.type, e.url || '', e.newKey || '']) });
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
  if (d) { _sk = { ...d, engines: d.engines.map((e) => ({ ...e })) }; _skBase = skSnap(); }
  // 下拉平时收着, 点「添加」才出来; 头一项是「选一家…」, 不预选哪家, 免得看着像已经加了
  const pick = document.createElement('option');
  pick.value = ''; pick.textContent = t('sys_search_pick'); pick.disabled = true; pick.selected = true;
  SK.type.replaceChildren(pick, ..._sk.types.map((x) => { const o = document.createElement('option'); o.value = x.type; o.textContent = x.name; return o; }));
  skDraw();
}

async function skRefresh() {
  try { skRender(await window.butler.listSearchKeys()); }
  catch (e) { console.error('[settings] listSearchKeys failed:', e && e.message); }
}

SK.add.addEventListener('click', () => {
  SK.type.value = ''; SK.type.style.display = '';
  SK.type.focus();
  try { SK.type.showPicker(); } catch {}
});
SK.type.addEventListener('change', () => {
  if (SK.type.value) { _sk.engines.push({ type: SK.type.value, key: 'none' }); skDraw(); }
  SK.type.value = ''; SK.type.style.display = 'none';
});
SK.off.addEventListener('change', () => { _sk.disabled = SK.off.checked; skDraw(); });

async function skSave() {
  // 要 key 的那家既没存过也没现填: 存下去也用不上(core/search-keys.js 会跳过它), 当场说清楚
  const miss = _sk.engines.find((e) => skType(e.type).key && e.key !== 'ok' && !(e.newKey || '').trim());
  if (miss) { toast(t('sys_search_need_key', { name: skType(miss.type).name })); return false; }
  const r = await window.butler.saveSearchKeys({
    disabled: _sk.disabled,
    engines: _sk.engines.map((e) => ({ id: e.id, type: e.type, url: e.url, key: e.newKey || '' })),
  });
  if (!r.ok) { toast(r.error === 'encryption_unavailable' ? t('sys_api_no_keychain') : t('mgr_save_failed') + (r.error || '')); return false; }
  return true;
}

// 关窗拦一下: beforeunload 里设 returnValue, Electron 就不关也不弹系统框, 改由页面自己问。
let _skLeave = false;
function skAskLeave() {
  if (document.getElementById('sk-leave')) return;
  const box = document.createElement('div');
  box.id = 'sk-leave';
  box.style.cssText = 'position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center';
  box.innerHTML = `<div style="background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px 20px;min-width:280px;box-shadow:0 8px 28px rgba(0,0,0,.2)">
    <div style="font-size:14px;margin-bottom:14px">${esc(t('sys_search_unsaved'))}</div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="m-btn" data-a="keep">${esc(t('sys_search_unsaved_keep'))}</button>
      <button class="m-btn" data-a="drop">${esc(t('sys_search_unsaved_drop'))}</button>
      <button class="m-btn primary" data-a="save">${esc(t('sys_search_unsaved_save'))}</button></div></div>`;
  box.addEventListener('click', async (ev) => {
    const a = ev.target.dataset && ev.target.dataset.a;
    if (!a) return;
    box.remove();
    if (a === 'keep') return;
    if (a === 'save' && !(await skSave())) return;
    _skLeave = true;
    window.close();
  });
  document.body.appendChild(box);
}
window.addEventListener('beforeunload', (e) => {
  if (_skLeave || skSnap() === _skBase) return;
  e.preventDefault(); e.returnValue = false;
  setTimeout(skAskLeave, 0);
});

window.butler.onLocaleChanged && window.butler.onLocaleChanged(() => skRender());
skRefresh();
