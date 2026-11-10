// settings-ui.js — 独立系统设置窗口: 接入方式 / 网络代理 / 本机 API。
//
// 边界: 这里只放**跟人格无关**的东西 —— 换谁来用都一样的那些。
// 人格自己的(名字/头像/模型偏好/插件凭据)在 manager.js。代理和本机 API 原先长在人格管理窗口里,
// 那是归属放错了(它俩本来就是进程级、存在 settings.json 和登记簿顶层), 2026-08-17 挪来这里。
//
// 界面语言: 与 renderer.js/manager.js 同一套 —— 字典在主进程 i18n.js, 这边只拿快照(S) 用 t() 取。
const toastEl = document.getElementById('toast');

let S = {};
const t = (k, vars) => {
  const v = S[k];
  if (v == null) return '';
  return vars ? String(v).replace(/\{(\w+)\}/g, (m, n) => (vars[n] != null ? String(vars[n]) : m)) : v;
};

function toast(text) {
  toastEl.textContent = text; toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 1800);
}

// 凭据名字是用户自己填的, 拼进 innerHTML 前必须转义 —— 同 manager.js 那份
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- 凭据仓库 (多条: 名字 + 端点 + key) ----
// 一条一行, 现填现存。key 真值永远不回渲染层(主进程只说 keyState), 所以输入框空着 ≠ 没配:
// 空着保存 = 保持原样。
const ACL = document.getElementById('ac-list');
const ACADD = document.getElementById('ac-add');

let _credLast = null;      // 切语言时按快照重画, 不重新读盘(重读会冲掉没保存的输入)
let _draft = null;         // 正在新增的那条(还没落盘, 没有 id)
let _picking = false;      // 点了「加一条」、还在选厂家(vendor-cards.js)

function credRender(d) {
  if (d) _credLast = d;
  const s = _credLast; if (!s) return;
  const rows = [...(s.credentials || [])];
  if (_draft) rows.push(_draft);
  ACL.innerHTML = rows.length || _picking ? '' : `<div style="color:var(--muted);font-size:12px">${esc(t('sys_cred_empty'))}</div>`;
  for (const c of rows) ACL.appendChild(credRow(c, s.defaultCredentialId));
  if (_picking) {
    ACL.appendChild(window.VendorCards.picker(t, (v) => {
      // 选了厂家: 名字和官方地址带好, 只剩贴 key; 「其他」(v=null)就是自己填地址的空白表单
      _picking = false;
      _draft = { id: '', name: v ? v.label : '', base_url: v ? v.base_url : '', vendor: v ? v.id : '', keyState: 'none' };
      credRender();
      // 新加的那条在列表最后: 焦点和滚动都落在它上面(ACL.querySelector 拿到的是第一条, 已存的 key 框都是空的, 分不清在填哪条)
      const row = ACL.lastElementChild;
      const k = row && row.querySelector(v ? '.c-key' : '.c-name');
      if (row) row.scrollIntoView({ block: 'nearest' });
      if (k) k.focus();
    }, () => { _picking = false; credRender(); }));
  }
}

// 「其他」那种自己填地址的凭据可选的协议; 空 = 自动
const PROTO_LABEL = { '': 'sys_proto_auto', anthropic: 'sys_proto_anthropic', compat: 'sys_proto_compat' };

function credRow(c, defId) {
  const box = document.createElement('div');
  box.style.cssText = 'border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px;margin-bottom:8px';
  const isNew = !c.id;
  const stale = c.keyState === 'stale';
  // 选过厂家卡片的: 地址是那家官方的, 不给改, 只显示是哪家; 「其他」和老凭据照旧自己填地址
  const vendorName = c.vendor ? (window.VendorCards.label(c.vendor) || c.vendor) : '';
  box.innerHTML = `
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <input class="c-name" type="text" value="${esc(c.name || '')}" placeholder="${esc(t('sys_cred_name_ph'))}" style="flex:0 0 140px"/>
      ${vendorName ? `<span class="vc-tag" style="flex:1;min-width:180px">${esc(t('sys_vendor_official', { vendor: vendorName }))}</span>`
    : `<input class="c-base" type="text" value="${esc(c.base_url || '')}" placeholder="https://api.anthropic.com" style="flex:1;min-width:180px"/>
      <select class="c-proto" style="flex:0 0 auto">${Object.entries(PROTO_LABEL).map(([p, k]) => `<option value="${p}" ${(c.protocol || '') === p ? 'selected' : ''}>${esc(t(k))}</option>`).join('')}</select>`}
      <label style="font-weight:normal;font-size:12px;white-space:nowrap"><input type="radio" name="cred-def" class="c-def" ${c.id && c.id === defId ? 'checked' : ''} ${isNew ? 'disabled' : ''}> ${esc(t('sys_cred_default'))}</label>
    </div>
    <div style="display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap">
      <input class="c-key" type="password" autocomplete="off" placeholder="${esc(c.keyState === 'ok' ? t('sys_api_key_saved') : (stale ? t('sys_api_key_stale_ph') : (c.vendor && c.vendor !== 'anthropic' ? t('sys_vendor_key_ph') : 'sk-ant-…')))}" style="flex:1;min-width:180px"/>
      <span class="c-status" style="font-size:12px;color:var(--muted)">${stale ? esc(t('sys_api_key_stale')) : ''}</span>
      <span style="flex:1"></span>
      <button class="m-btn c-test">${esc(t('sys_test'))}</button>
      <button class="m-btn c-del">${esc(t('mgr_delete'))}</button>
      <button class="m-btn primary c-save">${esc(t('mgr_save'))}</button>
    </div>`;
  const q = (k) => box.querySelector(k);
  // 协议只给「其他」那种自己填地址的选; 厂家卡片那条跟着厂家表走
  const patch = () => ({ id: c.id || undefined, name: q('.c-name').value.trim(), vendor: c.vendor || '',
                         base_url: q('.c-base') ? q('.c-base').value.trim() : (c.base_url || ''), apiKey: q('.c-key').value,
                         protocol: q('.c-proto') ? q('.c-proto').value : (c.protocol || '') });
  q('.c-save').addEventListener('click', async () => {
    if (!q('.c-name').value.trim()) { toast(t('sys_cred_need_name')); return; }
    // 新增的那条必须当场给 key, 否则存出来一条永远用不了的空壳
    if (isNew && !q('.c-key').value.trim()) { toast(t('sys_api_need_key')); return; }
    const pt = patch();
    // 新加的、只改名字的、没人在用的: 存了就完。改了正在用的端点或 key: 先问, 确定才存并重启那些人格;
    // 取消 = 什么都不存, 表单留着用户改到一半的样子
    const touches = !isNew && (pt.base_url !== (c.base_url || '') || pt.protocol !== (c.protocol || '') || !!pt.apiKey.trim());
    const users = touches ? ((await window.butler.credentialUsers(c.id)).users || []) : [];
    if (users.length && !confirm(t('sys_cred_restart_confirm', { name: pt.name, personas: users.map((u) => u.name).join('、') }))) return;
    const r = await window.butler.saveCredential(pt);
    if (!r.ok) { toast(r.error === 'encryption_unavailable' ? t('sys_api_no_keychain')
                     : r.error === 'name_required' ? t('sys_cred_need_name')
                     : r.error === 'bad_url' ? t('sys_cred_bad_url') : t('mgr_save_failed') + (r.error || '')); return; }
    _draft = null;
    const failed = [];
    for (const u of users) {
      const rr = await window.butler.restartPersona(u.id, {});
      if (!rr.ok) failed.push(u.name);
    }
    toast(failed.length ? t('sys_cred_restart_failed', { personas: failed.join('、') })
      : t(users.length ? 'sys_cred_saved_restarted' : 'sys_cred_saved'));
    credRefresh();
  });
  q('.c-del').addEventListener('click', async () => {
    if (isNew) { _draft = null; credRender(); return; }
    if (!confirm(t('sys_cred_del_confirm', { name: c.name }))) return;
    await window.butler.deleteCredential(c.id);
    credRefresh();
  });
  q('.c-test').addEventListener('click', async () => {
    q('.c-test').disabled = true;
    q('.c-status').textContent = t('sys_testing');
    q('.c-status').style.color = 'var(--muted)';
    const r = await window.butler.testCredential(patch());
    q('.c-test').disabled = false;
    // 厂家卡片那条路回的是 model/reason(core/credentials.js test), 原因文案与建人格选档共用 tier_why_*
    const why = { auth: 'tier_why_auth', quota: 'tier_why_quota', no_model: 'tier_why_no_model', rate: 'tier_why_rate', upstream: 'tier_why_upstream',
      network: 'tier_why_network', list_failed: 'tier_why_list_failed', no_models: 'tier_why_no_models' }[r.reason] || (r.reason ? 'tier_why_error' : '');
    const msg = r.model ? t('sys_vendor_test_ok', { model: r.model.replace(/^[a-z]+\//, '') }) : why ? t(why) : '';
    // 自动档测出了协议(OpenAI 兼容的还可能补上 /v1): 填回表单, 保存时一起存
    let found = '';
    if (r.ok && r.protocol && q('.c-proto') && !q('.c-proto').value) {
      q('.c-proto').value = r.protocol;
      if (r.base_url && q('.c-base')) q('.c-base').value = r.base_url;
      found = ' · ' + t('sys_proto_detected', { proto: t(PROTO_LABEL[r.protocol] || 'sys_proto_auto') });
    }
    q('.c-status').textContent = (r.ok ? '● ' : '○ ') + (msg || r.detail || (r.error === 'no_key' ? t('sys_api_need_key') : '')) + found;
    q('.c-status').style.color = r.ok ? 'var(--ok)' : 'var(--danger)';
  });
  q('.c-def').addEventListener('change', async () => {
    if (!c.id) return;
    await window.butler.setDefaultCredential(c.id);
    credRefresh();
  });
  return box;
}

async function credRefresh() {
  try { await window.VendorCards.load(); credRender(await window.butler.listCredentials()); }
  catch (e) { console.error('[settings] listCredentials failed:', e && e.message); }
}

ACADD.addEventListener('click', async () => {
  if (_draft || _picking) return;           // 一次只让加一条, 免得攒出一堆没存的空行
  await window.VendorCards.load();          // 先选厂家(vendor-cards.js), 选完才出表单
  _picking = true;
  credRender();
});

// ---- 订阅长效 token ----
// 背后是 `claude setup-token`。主进程那边会给它伪终端、按行拼出完整 token、并且**先真打一次
// API 验活才存** —— 所以这里只管三件事: 显示状态、按钮防重复点、把结果说清楚。
// 整个过程最长 10 分钟(等人在浏览器里点), 期间按钮必须禁用: 再点一次不会开第二个浏览器
// (主进程有单飞锁), 但用户会以为没反应而反复点。
const STG = document.getElementById('st-get');
const STC = document.getElementById('st-clear');
const STS = document.getElementById('st-state');

let _subtokLast = null;
function subtokRender(d) {
  if (d) _subtokLast = d;
  const s = _subtokLast; if (!s || !STS) return;
  const k = s.state === 'ok' ? 'sys_subtok_ok' : s.state === 'stale' ? 'sys_subtok_stale' : 'sys_subtok_none';
  STS.textContent = (s.state === 'ok' ? '● ' : '○ ') + t(k);
  STS.style.color = s.state === 'ok' ? 'var(--ok)' : s.state === 'stale' ? 'var(--warn)' : 'var(--muted)';
  STC.style.display = s.state === 'none' ? 'none' : '';     // 没配过就没什么可清
}

async function subtokRefresh() {
  try { subtokRender(await window.butler.subTokenState()); }
  catch (e) { console.error('[settings] subTokenState failed:', e && e.message); }
}

if (STG) STG.addEventListener('click', async () => {
  STG.disabled = true; STC.disabled = true;
  STS.textContent = t('sys_subtok_running');
  STS.style.color = 'var(--muted)';
  let r;
  try { r = await window.butler.runSetupToken(); }
  catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  STG.disabled = false; STC.disabled = false;
  if (r && r.ok) { toast(t('sys_subtok_done')); }
  else {
    // 失败照实说, 并且明确"你原来的登录没事" —— 否则用户会以为自己刚把登录搞坏了
    STS.textContent = t('sys_subtok_failed', { err: (r && r.error) || '' });
    STS.style.color = 'var(--danger)';
    return;                                   // 不 refresh: 让失败原因留在屏幕上
  }
  subtokRefresh();
});

if (STC) STC.addEventListener('click', async () => {
  if (!confirm(t('sys_subtok_clear_confirm'))) return;
  await window.butler.saveSubToken(null);
  toast(t('sys_saved_restart'));
  subtokRefresh();
});

// ---- 本机戳醒 API (进程级开关, 不属于任何人格) ----
const LA = { enabled: document.getElementById('la-enabled'), port: document.getElementById('la-port'),
             save: document.getElementById('la-save'), status: document.getElementById('la-status'),
             curl: document.getElementById('la-curl'), copy: document.getElementById('la-copy') };

// 切语言时按这份快照重画, 不重新读盘 —— 重读会把用户还没保存的输入冲掉
let _laLast = null;
function laRender(c) {
  if (c) _laLast = c;
  const s = _laLast; if (!s) return;
  LA.enabled.checked = !!s.enabled;
  LA.port.value = s.port;
  LA.status.textContent = s.running ? t('mgr_la_running', { port: s.port }) : t(s.enabled ? 'mgr_la_down' : 'mgr_la_off');
  LA.status.style.color = s.running ? 'var(--ok)' : (s.enabled ? 'var(--danger)' : 'var(--muted)');
  LA.curl.textContent = `curl -X POST http://127.0.0.1:${s.port}/v1/poke \\\n  -H 'Content-Type: application/json' \\\n  -d '{"persona":"${s.sample || t('mgr_la_sample_persona')}","from":"watchdog.py","text":"${t('mgr_la_sample_text')}"}'`;
}

async function laRefresh() {
  try {
    const c = await window.butler.getLocalApi();
    // 示例里填个真人格名, 复制出去就能直接跑
    const r = await window.butler.listPersonas();
    c.sample = (r && r.personas && r.personas[0] && r.personas[0].name) || '';
    laRender(c);
  } catch (e) { console.error('[settings] getLocalApi failed:', e && e.message); }
}

async function laSave() {
  LA.save.disabled = true;
  const r = await window.butler.setLocalApi({ enabled: LA.enabled.checked, port: Number(LA.port.value) });
  LA.save.disabled = false;
  if (!r.ok) { toast(t('mgr_save_failed') + r.error); return laRefresh(); }
  toast(r.running ? t('mgr_la_started', { port: r.localApi.port }) : t('mgr_la_stopped'));
  laRefresh();
}

LA.save.addEventListener('click', laSave);
LA.enabled.addEventListener('change', laSave);
LA.copy.addEventListener('click', () => { navigator.clipboard.writeText(LA.curl.textContent); toast(t('mgr_copied')); });

// ---- 网络代理 (进程级; 国内用户基本必配, 地址每台机器不同, 只能让用户自己填) ----
const PX = { enabled: document.getElementById('px-enabled'), url: document.getElementById('px-url'),
             noproxy: document.getElementById('px-noproxy'), test: document.getElementById('px-test'),
             save: document.getElementById('px-save'), status: document.getElementById('px-status') };

function pxStatus(text, color) { PX.status.textContent = text; PX.status.style.color = color; }

// 测试结果是这一刻真跑出来的实况, 切语言时不该被"已启用/直连"这种静态文案盖掉
let _pxLast = null, _pxShowingTest = false;
function pxRenderSaved(p) {
  if (p) _pxLast = p;
  const s = _pxLast || {};
  _pxShowingTest = false;
  pxStatus(s.enabled && s.url ? t('mgr_px_on', { url: s.url }) : t('mgr_px_direct'), s.enabled && s.url ? 'var(--ok)' : 'var(--muted)');
}

function pxPatch() {
  return { proxy: { enabled: PX.enabled.checked, url: PX.url.value.trim(), no_proxy: PX.noproxy.value.trim() } };
}

async function pxRefresh() {
  try {
    const s = await window.butler.getSettings();
    const p = (s && s.proxy) || {};
    PX.enabled.checked = !!p.enabled;
    PX.url.value = p.url || '';
    PX.noproxy.value = p.no_proxy || '';
    pxRenderSaved(p);
  } catch (e) { console.error('[settings] getSettings failed:', e && e.message); }
}

async function pxSave() {
  if (PX.enabled.checked && !PX.url.value.trim()) { toast(t('mgr_px_need_url')); return; }
  PX.save.disabled = true;
  const r = await window.butler.setSettings(pxPatch());
  PX.save.disabled = false;
  toast(t(r.proxy && r.proxy.on ? 'mgr_px_saved_on' : 'mgr_px_saved_off'));
  pxRefresh();
}

async function pxTest() {
  if (!PX.url.value.trim()) { toast(t('mgr_px_need_url')); return; }
  PX.test.disabled = true;
  pxStatus(t('mgr_px_testing'), 'var(--muted)');
  const r = await window.butler.testProxy(pxPatch());
  PX.test.disabled = false;
  pxStatus((r.ok ? '● ' : '○ ') + r.detail, r.ok ? 'var(--ok)' : 'var(--danger)');
  _pxShowingTest = true;
  toast(r.ok ? t('mgr_px_ok') : t('mgr_px_bad') + r.detail);
}

PX.save.addEventListener('click', pxSave);
PX.test.addEventListener('click', pxTest);

// ---- 界面语言 ----
// 使用文档开本版那份冻结文档(docs-versions/v<版本>/), 中文界面看中文, 其余看英文; 版本号取不到时开最新版
function docsHref(locale) {
  const v = window.butler.version, en = /^zh/.test(locale || '') ? '' : 'en/';
  const base = /^\d+\.\d+\.\d+$/.test(v || '') ? `docs-versions/v${v}/` : 'docs/';
  return `https://fantasyxxj.github.io/aibutler/${base}${en}`;
}
function applyStrings(payload) {
  S = (payload && payload.strings) || S;
  const dl = document.getElementById('docs-link'); if (dl && payload && payload.locale) dl.href = docsHref(payload.locale);
  document.title = t('sys_title');
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
}

window.butler.onLocaleChanged && window.butler.onLocaleChanged((payload) => {
  applyStrings(payload);
  laRender();                                 // 快照重画, 不读盘
  if (!_pxShowingTest) pxRenderSaved();
  credRender();                               // 快照重画, 不读盘
  subtokRender();                             // 同上: 状态条是 t() 拼的, 换语言要跟着重画
});

// ---- 外观: 跟随系统 / 浅色 / 深色 ----
const THEME_SEG = document.getElementById('themeSeg');
function themeMark(theme) { for (const b of THEME_SEG.querySelectorAll('button')) b.classList.toggle('on', b.dataset.theme === theme); }
THEME_SEG.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-theme]'); if (!b) return;
  const r = await window.butler.setTheme(b.dataset.theme);
  if (r && r.ok) themeMark(r.theme);
});

// ---- 快速切换模型: 顶栏那颗「key · 模型 ▾」显不显示 ----
const QS = document.getElementById('qs-enabled');
QS.addEventListener('change', () => { window.butler.setQuickSwitch(QS.checked).catch(() => {}); });
// ---- 工具调用条: 对话里显不显示 ----
const TR = document.getElementById('tool-rows');
TR.addEventListener('change', () => { window.butler.setToolRows(TR.checked).catch(() => {}); });

// ---- 启动小贴士: 打开时弹不弹 / 当场看一条 ----
const TIPS = document.getElementById('tips-on');
TIPS.addEventListener('change', () => { window.butler.setTips({ on: TIPS.checked }).catch(() => {}); });
document.getElementById('tips-now').addEventListener('click', () => { window.butler.showTips().catch(() => {}); });

(async () => {
  window.butler.getTips().then((r) => { TIPS.checked = !!(r && r.on); }).catch(() => {});
  window.butler.getQuickSwitch().then((r) => { QS.checked = !!(r && r.on); }).catch(() => {});
  window.butler.getToolRows().then((r) => { TR.checked = !!(r && r.on); }).catch(() => {});
  window.butler.getTheme().then((r) => themeMark(r && r.theme)).catch(() => {});
  // 先拿语言再画: 状态条是 t() 拼出来的, S 还空着就画会得到一屏空白
  try { applyStrings(await window.butler.getLocale()); }
  catch (e) { console.error('[settings] getLocale failed:', e && e.message); }
  credRefresh();
  subtokRefresh();
  laRefresh();
  pxRefresh();
})();
