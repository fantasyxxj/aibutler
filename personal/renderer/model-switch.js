// model-switch.js — 主界面顶栏人格名字右边那颗「key · 模型 ▾」: 点开就地给当前人格换 key 和模型(作者 11-07)。
// 同一把 key 只换模型 = update-persona 热切, 下一轮生效; 换 key / 换接入方式 = restart-persona
// (先用旧那套沉淀 → 拆流 → 写盘 → 重开), 跟人格管理编辑面板走的是同两条后端路。
// 清单和「这把 key 上用过哪个」在 model-pick.js, 跟人格管理共用。t() 是 renderer.js 的, 只在运行时调。
'use strict';

(function () {
  const CUSTOM = '__custom__';
  // style.css 已过行数门禁, 样式跟着组件走(同 tier-picker.js)
  const CSS = `
#modelChip { -webkit-app-region: no-drag; max-width: 280px; flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  border: 1px solid var(--line); background: var(--panel-2); color: var(--muted); border-radius: 999px; padding: 3px 10px; font-size: 12px; cursor: pointer; }
#modelChip:hover { color: var(--text); background: var(--btn-hi); }
#modelChip.hidden { display: none; }
.ms-pop { position: fixed; z-index: 50; width: 300px; padding: 12px; display: flex; flex-direction: column; gap: 8px;
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-sm); box-shadow: 0 6px 24px rgba(0,0,0,.18); font-size: 13px; }
.ms-pop label { display: flex; flex-direction: column; gap: 4px; color: var(--muted); font-size: 12px; }
.ms-pop select, .ms-pop input { font-size: 13px; padding: 5px 6px; background: var(--field); color: var(--text); border: 1px solid var(--line); border-radius: 6px; }
.ms-note { min-height: 1em; font-size: 12px; color: var(--muted); white-space: pre-wrap; }
.ms-note:empty { display: none; }
.ms-btns { display: flex; justify-content: flex-end; gap: 8px; }
.ms-btns button { padding: 5px 14px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel-2); color: var(--text); cursor: pointer; }
.ms-btns .ms-apply { background: var(--accent); border-color: transparent; color: #1a1a1a; font-weight: 600; }`;
  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CSS }));
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const MP = window.ModelPick;
  const chip = document.getElementById('modelChip');
  let homeDir = '', persona = null, auth = { credentials: [], defaultCredentialId: '', subLoggedIn: true, ccAvailable: true };   // 凭据拿不到就当订阅能用, 别把唯一一项也藏掉
  let pop = null, closeTimer = 0, opening = false;
  let enabled = false;   // 设置里「快速切换模型」开了才显示, 默认关(作者 11-07)

  const credOf = (p) => p.credentialId || auth.defaultCredentialId || '';
  const credName = (id) => { const c = auth.credentials.find((x) => x.id === id); return c ? c.name : 'API Key'; };
  const accessLabel = (access, cred) => (access === 'api' ? credName(cred) : t('ms_sub'));
  const modelLabel = (m) => m || t('mgr_model_default');

  async function refresh() {
    const [r, a] = await Promise.all([window.butler.listPersonas(), window.butler.listCredentials().catch(() => null)]);
    if (a) auth = { credentials: a.credentials || [], defaultCredentialId: a.defaultCredentialId || '', subLoggedIn: a.subLoggedIn !== false, ccAvailable: a.ccAvailable !== false };
    persona = ((r && r.personas) || []).find((p) => p.homeDir === homeDir) || null;
    if (!persona || !enabled) { chip.classList.add('hidden'); close(); return; }
    const access = MP.accessOf(persona);
    chip.textContent = `${accessLabel(access, credOf(persona))} · ${modelLabel(persona.model)} ▾`;
    chip.classList.remove('hidden');
  }

  function close() { clearTimeout(closeTimer); if (pop) { pop.remove(); pop = null; } }

  async function open() {
    if (pop) { close(); return; }
    if (opening) return;   // 连点两下: 第一下还在等 refresh, 第二下不许再建一个关不掉的面板
    opening = true;
    try { await refresh(); } finally { opening = false; }
    const p = persona; if (!p || pop || !enabled) return;
    const baseAccess = MP.accessOf(p), baseCred = credOf(p);
    pop = document.createElement('div');
    pop.className = 'ms-pop';
    // 订阅那项: 这台没有 Claude Code 就不出现; 没登录则只在它正用着订阅时摆着(别让人挑一个必挂的)
    const subOk = auth.ccAvailable && (auth.subLoggedIn || baseAccess !== 'api');
    const accOpts = [
      ...(subOk ? [`<option value="sub"${baseAccess !== 'api' ? ' selected' : ''}>${esc(t('ms_sub'))}</option>`] : []),
      ...auth.credentials.map((c) => `<option value="api:${esc(c.id)}"${baseAccess === 'api' && c.id === baseCred ? ' selected' : ''}>${esc(c.name)}${c.keyState === 'ok' ? '' : ' ⚠'}</option>`),
    ];
    // 正用着的那一对必须在下拉里(凭据被删了 / 订阅退出了也一样), 否则下拉默认停在别的项上, 一点切换就换掉了
    if (!accOpts.some((o) => o.includes(' selected'))) {
      accOpts.unshift(baseAccess === 'api'
        ? `<option value="api:${esc(baseCred)}" selected>${esc(credName(baseCred))} ⚠</option>`
        : `<option value="sub" selected>${esc(t('ms_sub'))}</option>`);
    }
    pop.innerHTML = `
      <label>${esc(t('ms_access'))}<select class="ms-acc">${accOpts.join('')}</select></label>
      <label>${esc(t('ms_model'))}<select class="ms-model" disabled><option value="">${esc(t('ms_loading'))}</option></select></label>
      <input class="ms-custom" hidden placeholder="${esc(t('mgr_model_custom'))}">
      <div class="ms-note"></div>
      <div class="ms-btns"><button class="ms-cancel">${esc(t('ms_cancel'))}</button><button class="ms-apply">${esc(t('ms_apply'))}</button></div>`;
    document.body.appendChild(pop);
    const rect = chip.getBoundingClientRect();
    pop.style.top = `${rect.bottom + 6}px`;
    pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8))}px`;
    const accSel = pop.querySelector('.ms-acc'), modelSel = pop.querySelector('.ms-model');
    const customIn = pop.querySelector('.ms-custom'), note = pop.querySelector('.ms-note');
    const picked = () => { const v = accSel.value; return v === 'sub' ? { access: 'subscription', cred: '' } : { access: 'api', cred: v.slice(4) }; };
    const curModel = () => (modelSel.value === CUSTOM ? customIn.value.trim() : modelSel.value);

    const fill = async (switched) => {
      const { access, cred } = picked();
      modelSel.disabled = true;
      const { options } = await MP.load(access === 'api', cred);
      if (!pop || accSel.value !== (access === 'api' ? `api:${cred}` : 'sub')) return;   // 等的时候他又换了
      let cur = p.model || '', probe = false;
      if (switched) ({ model: cur, probe } = MP.choose(p, access, cred, options));
      const list = access === 'api' ? options.filter((o) => o.id) : options;
      const known = list.some((o) => o.id === cur);
      modelSel.innerHTML = list.map((o) => `<option value="${esc(o.id)}"${o.id === cur ? ' selected' : ''}>${esc(MP.label(o) || t('mgr_model_default'))}</option>`).join('')
        + `<option value="${CUSTOM}"${known ? '' : ' selected'}>${esc(t('mgr_model_custom'))}</option>`;
      customIn.hidden = known; customIn.value = known ? '' : cur;
      modelSel.disabled = false;
      if (probe) {
        const m = await MP.probeDaily(cred);
        if (pop && accSel.value === `api:${cred}` && modelSel.value === cur && [...modelSel.options].some((o) => o.value === m)) modelSel.value = m;
      }
    };
    accSel.addEventListener('change', () => { note.textContent = ''; modelSel.disabled = true; fill(true); });
    modelSel.addEventListener('change', () => { customIn.hidden = modelSel.value !== CUSTOM; if (!customIn.hidden) customIn.focus(); });
    pop.querySelector('.ms-cancel').addEventListener('click', close);
    pop.querySelector('.ms-apply').addEventListener('click', async () => {
      if (modelSel.disabled) return;   // 清单还没拉完: 下拉里还是占位或上一把 key 的清单
      const { access, cred } = picked();
      const model = curModel();
      if (access === 'api' && !model) { note.textContent = t('mgr_model_required'); return; }
      const sameKey = access === baseAccess && (access !== 'api' || cred === baseCred);
      if (sameKey && model === (p.model || '')) { note.textContent = t('ms_same'); return; }
      MP.rememberModel(p, access, access === 'api' ? cred : '', model);
      if (sameKey) {
        const r = await window.butler.updatePersona(p.id, { model });
        if (!r || !r.ok) { note.textContent = t('mgr_save_failed') + ((r && r.error) || ''); return; }
        const ms = r.modelSwitch;
        const key = ms && ms.applied ? 'mgr_model_hot' : (ms && ms.reason === 'deferred_busy' ? 'mgr_model_after_turn' : 'mgr_model_next_session');
        note.textContent = t(key, { model: modelLabel(model) }).replace(/^\s*·\s*/, '');
        refresh();
        const mine = pop;   // 等回话那会儿他可能关了又开了一个, 只收这一个
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => { if (pop === mine) close(); }, 2200);
        return;
      }
      const from = `${accessLabel(baseAccess, baseCred)} · ${modelLabel(p.model)}`;
      const to = `${accessLabel(access, cred)} · ${modelLabel(model)}`;
      if (!window.confirm(t('ms_restart_confirm', { name: p.name, from, to }))) return;
      const patch = { model, sdk: MP.sdkFor(p, access) };
      if (access !== baseAccess) patch.accessMode = access;
      if (access === 'api' && cred !== (p.credentialId || '')) patch.credentialId = cred;
      close();
      const r = await window.butler.restartPersona(p.id, patch);
      if (!r || !r.ok) window.alert(t('mgr_access_restart_failed') + ((r && r.error) || ''));
      refresh();
    });
    fill(false);
  }

  chip.addEventListener('click', (e) => { e.stopPropagation(); open(); });
  document.addEventListener('mousedown', (e) => { if (pop && !pop.contains(e.target) && e.target !== chip) close(); });
  document.addEventListener('keydown', (e) => { if (pop && e.key === 'Escape') close(); });
  window.butler.onRegistryChanged && window.butler.onRegistryChanged(() => { if (homeDir) refresh(); });
  // 小块文字是 t() 拼的, 换了界面语言要跟着重拼
  window.butler.onLocaleChanged && window.butler.onLocaleChanged(() => { if (homeDir) setTimeout(refresh, 0); });

  window.butler.getQuickSwitch().then((r) => { enabled = !!(r && r.on); if (homeDir) refresh(); }).catch(() => {});
  window.butler.onQuickSwitchChanged((d) => { enabled = !!(d && d.on); if (homeDir) refresh(); });

  // renderer.js 的 showPersona 每次切到一个人格时调
  window.ModelSwitch = { show(dir) { if (dir !== homeDir) close(); homeDir = dir || ''; refresh(); } };
})();
