// manager.js — 独立管理窗口: 人格列表(展开式编辑 name/wakePhrase, 指定管家, 删) + 建人格表单
//
// 界面语言: 与 renderer.js 同一套 —— 字典在主进程 i18n.js, 这边只拿快照(S) 用 t() 取。
// manager.html 里的中文是"主进程还没回话那几十毫秒"的出厂帧, applyStrings 之后一律被字典覆盖。
const listEl = document.getElementById('list');
const toastEl = document.getElementById('toast');
const F = { name: document.getElementById('f-name'), dir: document.getElementById('f-dir'),
            wake: document.getElementById('f-wake'), butler: document.getElementById('f-butler'),
            choose: document.getElementById('f-choose'), create: document.getElementById('f-create'),
            importBtn: document.getElementById('f-import'),
            accSub: document.getElementById('f-acc-sub'), accApi: document.getElementById('f-acc-api'), sdk: document.getElementById('f-sdk'),
            cred: document.getElementById('f-cred'),
            modelSel: document.getElementById('f-model-sel'), modelManual: document.getElementById('f-model-manual'),
            modelCustom: document.getElementById('f-model-custom'), modelBack: document.getElementById('f-model-back'),
            modelSrc: document.getElementById('f-model-src') };

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

// 记住哪些人格的编辑面板正展开(refresh 后保留), 由 id 索引
const expanded = new Set();

// 模型下拉选项。来源由主进程按当前接入方式决定: 走 API/网关 → 问那个端点要; 订阅 → 问 SDK
// 控制通道要; 都拉不到才回落 config/models/list.json 那份手写清单。换完接入方式重开本窗口即重拉。
// 编辑面板里用 input+datalist 而非 select: 走第三方网关时模型名千奇百怪(实测一家网关 46 个模型
// 里只有 1 个是 claude-* 命名), 清单拉不回来也必须能手输。
// 清单跟着**这个人格**选的接入方式走(订阅问 SDK / 用 key 问那个端点), 所以两份分开缓存 ——
// 同一个窗口里 A 人格走订阅、B 人格走 key 是常态, 一份缓存会串味。
let _MODEL_OPTIONS = null, _MODEL_SRC = null;
const _MODEL_CACHE = {};
// 缓存按【接入方式 + 哪条凭据】分桶: 两条凭据多半是两个网关, 能开的模型清单不一样,
// 只按 api/sub 分会让换凭据之后还看着上一条的清单。
async function ensureModelOptions(useApi, credentialId) {
  const k = useApi ? `api:${credentialId || ''}` : 'sub';
  if (_MODEL_CACHE[k]) { ({ options: _MODEL_OPTIONS, src: _MODEL_SRC } = _MODEL_CACHE[k]); return _MODEL_OPTIONS; }
  try {
    const r = await window.butler.listModelOptions({ useApi: !!useApi, credentialId: credentialId || '' });
    _MODEL_OPTIONS = (r && r.options) || [];
    _MODEL_SRC = r || null;
  } catch (e) { console.error('[manager] listModelOptions failed:', e && e.message); _MODEL_OPTIONS = []; _MODEL_SRC = null; }
  _MODEL_CACHE[k] = { options: _MODEL_OPTIONS, src: _MODEL_SRC };
  return _MODEL_OPTIONS;
}
// 清单从哪来的一行小字。"只有几个"到底是网关就这么多还是没拉到, 不写出来没人分得清。
function modelSrcNote() {
  if (!_MODEL_SRC) return '';
  const n = (_MODEL_OPTIONS || []).length;
  // 三种来源要说三种话: 现拉到了 / 订阅就用内置官方清单(这是正解不是回落) / 端点没给清单才回落
  const key = { live: 'mgr_model_src_live', builtin: 'mgr_model_src_builtin' }[_MODEL_SRC.source] || 'mgr_model_src_fallback';
  return t(key, { n, from: _MODEL_SRC.from });
}

// 模型下拉必须是 select, 不能是 input+datalist: datalist 会拿输入框现有值去过滤候选,
// 所以一旦填了具体模型名, 下拉里就只剩它自己一条, 看着像"没得选"。手输能力(第三方网关的
// 模型名千奇百怪)靠末尾这条「其它」+ 下面的手输框保住。
const MODEL_CUSTOM = '__custom__';
const isKnownModel = (v) => (_MODEL_OPTIONS || []).some((o) => o.id === (v || ''));
// defaultOpt: 新建表单才给的「跟随默认」空值项。编辑面板不给 —— 那里空值的含义已经由末尾
// 「其它」+ 空手输框表达得了; 新建时则需要一个能被选中的显式默认项, 否则一打开就停在「其它」上。
// needModel: 用 API key 时没有能用的默认模型(Butler 引擎留空直接报错, 作者 2026-11-05 定) ——
// 不给「跟随默认」, 清单里的空 id 项也剔掉, 没选过就默认选中第一个。
function modelOptionsHtml(cur, { defaultOpt = false, needModel = false } = {}) {
  const list = needModel ? (_MODEL_OPTIONS || []).filter((o) => o.id) : (_MODEL_OPTIONS || []);
  if (needModel) { defaultOpt = false; if (!cur && list.length) cur = list[0].id; }
  const known = list.some((o) => o.id === (cur || ''));
  // id 不在 label 里就补上 —— 手写清单的 label 只有中文描述, 走网关时 id 才是关键信息
  const text = (o) => (!o.id || String(o.label || '').includes(o.id) ? (o.label || o.id) : `${o.label || o.id} — ${o.id}`);
  const rows = defaultOpt ? [`<option value=""${cur ? '' : ' selected'}>${esc(t('mgr_model_inherit'))}</option>`] : [];
  rows.push(...list.map((o) =>
    `<option value="${esc(o.id)}"${o.id === (cur || '') ? ' selected' : ''}>${esc(text(o))}</option>`));
  // 有「跟随默认」兜底时, 空值不再意味着"该去手输", 所以别把「其它」选中。
  const customSel = known || (defaultOpt && !cur) ? '' : ' selected';
  rows.push(`<option value="${MODEL_CUSTOM}"${customSel}>${esc(t('mgr_model_custom'))}</option>`);
  return rows.join('');
}

// HTML 转义(防 XSS 注入到编辑面板 innerHTML)
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- 头像选择器 ----
const isImgAvatar = (v) => typeof v === 'string' && /^(data:|file:|https?:|\/)/.test(v);
// 全部用单码点 emoji: ZWJ 组合(🧑‍💻/👩‍💻/🧑‍🎨)在 Windows 上会被拆成两个字形, 撑乱格子且预览显示成两个
const COMMON_EMOJIS = ['🤖','💻','👾','🦋','🐱','🦊','🐼','🦉','🐧','🐷','🦁','🐰','🌸','🚀','💰','📊','📈','🎨','🎯','🧠','📚','☕','🔧','🎮','⚡','🎭','🍜','🐉','🌟','🦄'];
// 上传照片 → 居中裁成 128px 小方图 → JPEG data URL(体积小, 存 registry)
function fileToAvatarDataURL(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const S = 128;
      const cv = document.createElement('canvas'); cv.width = S; cv.height = S;
      const ctx = cv.getContext('2d');
      const scale = Math.max(S / img.width, S / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
      URL.revokeObjectURL(url);
      resolve(cv.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}
// 给编辑面板里的 .avatar-picker 挂交互; 选中值写进 .e-avatar-val
function wireAvatarPicker(box) {
  const wrap = box.querySelector('.avatar-picker');
  if (!wrap) return;
  const hidden = wrap.querySelector('.e-avatar-val');
  const preview = wrap.querySelector('.ap-preview');
  const emojiInput = wrap.querySelector('.ap-emoji-input');
  const grid = wrap.querySelector('.ap-grid');
  const setVal = (v) => {
    hidden.value = v || '';
    preview.textContent = ''; preview.style.backgroundImage = '';
    if (v && isImgAvatar(v)) { preview.style.backgroundImage = `url("${v}")`; preview.classList.add('img'); }
    else { preview.classList.remove('img'); preview.textContent = v || '?'; }
  };
  COMMON_EMOJIS.forEach((e) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ap-emo'; b.textContent = e;
    b.addEventListener('click', () => { emojiInput.value = e; setVal(e); });
    grid.appendChild(b);
  });
  emojiInput.addEventListener('input', () => setVal(emojiInput.value.trim()));
  wrap.querySelectorAll('.ap-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      wrap.querySelectorAll('.ap-tab').forEach((t) => t.classList.toggle('active', t === tab));
      wrap.querySelector('.ap-pane-emoji').hidden = tab.dataset.tab !== 'emoji';
      wrap.querySelector('.ap-pane-photo').hidden = tab.dataset.tab !== 'photo';
    });
  });
  const fileInput = wrap.querySelector('.ap-photo-file');
  wrap.querySelector('.ap-photo-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    const dataUrl = await fileToAvatarDataURL(f);
    if (dataUrl) setVal(dataUrl);
    fileInput.value = '';
  });
  wrap.querySelector('.ap-clear').addEventListener('click', () => { emojiInput.value = ''; setVal(''); });
  const cur = hidden.value;
  if (cur && !isImgAvatar(cur)) emojiInput.value = cur;
  setVal(cur);
  if (cur && isImgAvatar(cur)) wrap.querySelector('.ap-tab[data-tab="photo"]').click();
  return setVal;   // 供外部重置(如新建表单提交后清空)
}
// 新建表单的头像选择器(2 tab, 与编辑面板同款); 脚本在 body 末尾, DOM 已就绪
const createSetAvatar = wireAvatarPicker(document.getElementById('f-avatar-wrap'));

function pluginBadge(st) {
  if (st && st.running) return `<span class="pi-live">${esc(t('mgr_plugin_running'))}</span>`;
  if (st && st.mode === 'native') return `<span class="pi-dead">${esc(t('mgr_plugin_idle'))}</span>`;
  return `<span class="pi-off">${esc(t('mgr_plugin_off'))}</span>`;
}

function makeEditPanel(p) {
  useModelCache(p.accessMode === 'api', p.credentialId);   // 模型清单跟着这个人格的接入方式 + 凭据走
  const tg = (p.plugins && p.plugins.tg) || {};
  const busList = Array.isArray(p.plugins && p.plugins.buses) ? p.plugins.buses : [];
  const st = p.pluginStatus || {};
  const tgBadge = st.tg && st.tg.running
    ? `<span class="pi-live">${esc(t('mgr_tg_running', {
        offset: st.tg.offset, count: st.tg.msgCount || 0,
        err: st.tg.lastError ? '⚠' + st.tg.lastError : 'ok' }))}</span>`
    : pluginBadge(st.tg);
  const box = document.createElement('div'); box.className = 'edit-box';
  box.innerHTML = `
    <div class="e-line"><label>${esc(t('mgr_name'))}</label><input class="e-name" value="${esc(p.name)}"/></div>
    <div class="e-line"><label>${esc(t('mgr_avatar'))}</label>
      <div class="avatar-picker">
        <div class="ap-preview"></div>
        <div class="ap-body">
          <div class="ap-tabs">
            <button type="button" class="ap-tab active" data-tab="emoji">Emoji</button>
            <button type="button" class="ap-tab" data-tab="photo">${esc(t('mgr_photo'))}</button>
          </div>
          <div class="ap-pane ap-pane-emoji">
            <div class="ap-grid"></div>
            <input class="ap-emoji-input" placeholder="${esc(t('mgr_emoji_ph'))}" maxlength="8" />
          </div>
          <div class="ap-pane ap-pane-photo" hidden>
            <button type="button" class="m-btn ap-photo-btn">${esc(t('mgr_choose_photo'))}</button>
            <input type="file" accept="image/*" class="ap-photo-file" hidden />
            <button type="button" class="m-btn ap-clear" title="${esc(t('mgr_clear_hint'))}">${esc(t('mgr_clear'))}</button>
            <div class="ap-photo-hint">${esc(t('mgr_photo_hint'))}</div>
          </div>
        </div>
        <input type="hidden" class="e-avatar-val" value="${esc(p.avatar)}" />
      </div>
    </div>
    <div class="e-line"><label>${esc(t('mgr_wake'))}</label><textarea class="e-wake" placeholder="${esc(t('mgr_wake_ph_named', { name: p.name }))}">${esc(p.wakePhrase)}</textarea></div>
    <div class="e-line"><label>${esc(t('mgr_access'))}</label>
      <div>
        <label style="font-weight:normal${_subLoggedIn ? '' : ';opacity:.45'}${_ccAvail ? '' : ';display:none'}" title="${_subLoggedIn ? '' : esc(t('mgr_access_sub_locked'))}"><input type="radio" name="acc-${esc(p.id)}" class="e-acc-sub" ${p.accessMode === 'api' ? '' : 'checked'} ${_subLoggedIn ? '' : 'disabled'}> ${esc(t('mgr_access_sub'))}</label>
        <label style="font-weight:normal;margin-left:12px"><input type="radio" name="acc-${esc(p.id)}" class="e-acc-api" ${p.accessMode === 'api' ? 'checked' : ''}> ${esc(t('mgr_access_api'))}</label>
        <select class="e-cred" style="margin-left:8px;${p.accessMode === 'api' && _creds.length ? '' : 'display:none'}">${credOptionsHtml(p.credentialId)}</select>
        <div class="e-dir-note">${esc(_creds.length ? t('mgr_access_hint') : t('mgr_cred_none'))}</div>
      </div>
    </div>
    <div class="e-line"${_ccAvail ? '' : ' style="display:none"'}><label>${esc(t('mgr_sdk'))}</label>
      <div>
        <select class="e-sdk" ${p.accessMode === 'api' ? '' : 'disabled'}>${['claude-code', 'butler'].map((k) => `<option value="${k}"${(p.accessMode === 'api' ? (p.sdk || 'claude-code') : 'claude-code') === k ? ' selected' : ''}>${esc(sdkLabel(k))}</option>`).join('')}</select>
        <div class="e-dir-note e-sdk-note">${p.accessMode === 'api' ? '' : esc(t('mgr_sdk_sub_only'))}</div>
      </div>
    </div>
    <div class="e-line"><label>${esc(t('mgr_model'))}</label>
      <div>
        <select class="e-model-sel" title="${esc(t('mgr_model_hint'))}"
                style="width:100%;${isKnownModel(p.model) ? '' : 'display:none'}">${modelOptionsHtml(p.model)}</select>
        <div class="e-model-manual" ${isKnownModel(p.model) ? 'hidden' : ''}>
          <input class="e-model-custom" value="${esc(isKnownModel(p.model) ? '' : p.model)}"
                 placeholder="${esc(t('mgr_model_ph_custom'))}"/>
          <button type="button" class="m-btn e-model-back">${esc(t('mgr_model_back'))}</button>
        </div>
        <div class="e-dir-note e-model-src">${esc(modelSrcNote())}</div>
      </div>
    </div>
    <div class="e-line"><label>${esc(t('mgr_dir'))}</label><div class="e-dir" title="${esc(t('mgr_dir_locked_hint'))}">${esc(p.homeDir)} <span class="e-dir-note">${esc(t('mgr_dir_locked'))}</span></div></div>
    <div class="e-line"><label>${esc(t('mgr_voice'))}</label>
      <div>
        <label style="font-weight:normal"><input type="checkbox" class="e-voice-en" ${p.voice && p.voice.enabled ? 'checked' : ''}> ${esc(t('mgr_voice_toggle'))}</label>
        <span class="e-dir-note">${esc(t('mgr_voice_hint'))}</span>
      </div>
    </div>

    <div class="e-persona-md">
      <div class="e-plugin-head">${esc(t('mgr_pmd_head'))}</div>
      <textarea class="e-pmd" placeholder="${esc(t('mgr_pmd_loading'))}" spellcheck="false"></textarea>
      <div class="e-pmd-hint">${esc(t('mgr_pmd_hint'))}</div>
    </div>

    <div class="e-plugin">
      <div class="e-plugin-head">${esc(t('mgr_tg_head'))} ${tgBadge}</div>
      <div class="e-line"><label>${esc(t('mgr_mode'))}</label>
        <select class="pt-mode">
          <option value="off"    ${(tg.mode||'off')==='off'?'selected':''}>${esc(t('mgr_tg_mode_off'))}</option>
          <option value="native" ${(tg.mode||'')==='native'?'selected':''}>${esc(t('mgr_tg_mode_native'))}</option>
        </select>
      </div>
      <div class="e-line"><label>bot_token</label><input type="password" class="pt-token" placeholder="${esc(t('mgr_tg_token_ph'))}" value="${esc(tg.bot_token)}"/></div>
      <div class="e-line"><label>in_file</label><input class="pt-in" placeholder="${esc(t('mgr_tg_in_ph'))}" value="${esc(tg.in_file)}"/></div>
      <div class="e-line"><label>chat_ids</label><input class="pt-chats" placeholder="${esc(t('mgr_tg_chats_ph'))}" value="${(tg.chat_ids||[]).join(',')}"/></div>

      <div class="e-plugin-head" style="margin-top:8px">${esc(t('mgr_bus_head'))} ${pluginBadge(st.bothub)}</div>
      <div class="pb-endpoints"></div>
      <div class="e-line"><label></label><button class="m-btn pb-add" type="button">${esc(t('mgr_bus_add'))}</button></div>
    </div>

    <div class="e-actions"><button class="m-btn primary e-save">${esc(t('mgr_save'))}</button><button class="m-btn e-cancel">${esc(t('mgr_cancel'))}</button></div>`;

  // bus 目标表(可加/删)。**这里配得出来的就是全部** —— 以前 LINE 和中央大脑那两条
  // 只能手工改 personas.json, 于是实机上八个人格里只有一台真的配上了。
  const bhEl = box.querySelector('.pb-endpoints');
  function renderEndpoint(b, idx) {
    const sel = (v, cur) => (String(cur || '') === v ? 'selected' : '');
    const el = document.createElement('div'); el.className = 'pb-ep'; el.dataset.idx = idx;
    // kind 和"收件方式"都不再让人选, 但老条目的值必须跟着这一行走 —— 不记住就等于
    // "存一次把狂人那条 v1 的 dc-platform bus 改成 bothub", 那是静默毁别人的配置。
    el.dataset.kind = b.kind || 'bothub';
    el.dataset.inbox = b.inbox == null || b.inbox === false ? 'bothub' : String(b.inbox);
    el.innerHTML = `
      <div class="e-line"><label></label>
        <label style="font-weight:normal"><input type="checkbox" class="pbe-on" ${b.inbox === false ? '' : 'checked'}> ${esc(t('mgr_bus_on'))}</label>
      </div>
      <div class="e-line"><label>#${idx} id</label><input class="pbe-id" placeholder="${esc(t('mgr_bus_id_ph'))}" value="${esc(b.id)}"/></div>
      <div class="e-line"><label>base_url</label><input class="pbe-url" placeholder="${esc(t('mgr_bus_url_ph'))}" value="${esc(b.base_url)}"/></div>
      <div class="e-line"><label>agent</label><input class="pbe-agent" placeholder="${esc(t('mgr_bus_agent_ph'))}" value="${esc(b.agent)}"/></div>
      <div class="e-line"><label>token</label><input type="password" class="pbe-token" placeholder="Bearer token" value="${esc(b.token)}"/></div>
      <div class="e-line"><label></label><button class="m-btn danger pbe-del" type="button">${esc(t('mgr_bus_del'))}</button></div>`;
    el.querySelector('.pbe-del').addEventListener('click', () => { el.remove(); });
    return el;
  }
  busList.forEach((b, i) => bhEl.appendChild(renderEndpoint(b, i)));
  box.querySelector('.pb-add').addEventListener('click', () => {
    bhEl.appendChild(renderEndpoint({}, bhEl.children.length));
  });
  wireAvatarPicker(box); if (window.hubPanel) window.hubPanel.mount(box, p, renderEndpoint);   // 「连 hub」块(hub-panel.js); renderEndpoint 传进去是让它取到 token 后往这张表补一行
  return box;
}

// 从编辑面板读回 plugins 配置(供保存时传给 updatePersona)
function readPluginsFromPanel(box) {
  const chats = box.querySelector('.pt-chats').value.split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => !isNaN(n));
  const tg = {
    mode: box.querySelector('.pt-mode').value,   // 'off' | 'native'
    bot_token: box.querySelector('.pt-token').value.trim(),
    in_file: box.querySelector('.pt-in').value.trim(),
    chat_ids: chats,
  };
  // 表の**並び順がそのまま優先順位**: 一番上が既定の宛先。
  // bothub は agent(=この端末の名前)が無いと取りにも行けないので、そこだけ必須。
  const buses = [...box.querySelectorAll('.pb-ep')].map((el, i) => {
    // 面板上只剩一个开关: 开=这条 bus 收件, 关=挂着不收。kind 不再问 —— v1 已放弃, 新配的都是 bothub,
    // 老条目的 kind 和收件方式(v1 的 line / agent_bus)从 dataset 原样带回, 免得存一次就改了别人的配置。
    const kind = el.dataset.kind || 'bothub';
    const inbox = el.querySelector('.pbe-on').checked ? (el.dataset.inbox || 'bothub') : false;
    return {
      id: el.querySelector('.pbe-id').value.trim() || `bus${i + 1}`,
      kind,
      base_url: el.querySelector('.pbe-url').value.trim(),
      agent: el.querySelector('.pbe-agent').value.trim(),
      token: el.querySelector('.pbe-token').value.trim(),
      inbox: inbox || false,
    };
  }).filter((b) => b.base_url && (b.kind !== 'bothub' || b.agent));
  return { tg, buses };
}

// makeEditPanel 是同步渲染的, 所以渲染前先把全局那两个变量切到这个人格对应的那份缓存。
function useModelCache(useApi, credentialId) {
  const c = _MODEL_CACHE[useApi ? `api:${credentialId || ''}` : 'sub'];
  if (c) { _MODEL_OPTIONS = c.options; _MODEL_SRC = c.src; }
}

// 订阅通路能不能用。拿不到就当能用 —— 探测失败去置灰一个本来可选的选项, 比漏置灰更糟。
let _subLoggedIn = true;
let _ccAvail = true;   // 这台有没有 CC SDK; 没有(开源下载版)就只剩配 key, 订阅那项整个不出现
const sdkLabel = (k) => (k === 'butler' ? t('mgr_sdk_butler') : t('mgr_sdk_claude_code'));
// 凭据仓库快照。人格选「用 key」时要从这里挑一条 —— 挑的是名字, 地址和 key 在设置里维护。
let _creds = [], _defCred = '';
function credOptionsHtml(sel) {
  const cur = _creds.some((c) => c.id === sel) ? sel : (_defCred || (_creds[0] && _creds[0].id) || '');
  return _creds.map((c) => `<option value="${esc(c.id)}"${c.id === cur ? ' selected' : ''}>${esc(c.name)}${c.keyState === 'ok' ? '' : ' ⚠'}</option>`).join('');
}
async function refreshSubAuth() {
  try {
    const a = await window.butler.listCredentials();
    if (a && typeof a.subLoggedIn === 'boolean') _subLoggedIn = a.subLoggedIn;
    if (a && typeof a.ccAvailable === 'boolean') _ccAvail = a.ccAvailable;
    _creds = (a && a.credentials) || []; _defCred = (a && a.defaultCredentialId) || '';
  }
  catch (_) {}
  const lock = !_subLoggedIn;
  F.accSub.disabled = lock;
  F.accSub.parentElement.style.opacity = lock ? '.45' : '';
  F.accSub.parentElement.title = lock ? t('mgr_access_sub_locked') : '';
  F.accSub.parentElement.style.display = _ccAvail ? '' : 'none';
  if (lock && F.accSub.checked) F.accApi.checked = true;
}

async function refresh() {
  await refreshSubAuth();   // 必须早于下面画各人格编辑面板: 那些单选是同步拼字符串的, 读的就是 _subLoggedIn
  const r = await window.butler.listPersonas();
  const list = (r && r.personas) || [];
  // 预拉缓存: 订阅那份总要, 走 key 的那份只在真有人格选了它时才去问端点(省一次 10s 超时)
  await ensureModelOptions(false);
  // 走 key 的人格各自预拉自己那条凭据的清单(两条凭据多半是两个网关, 清单不通用)
  for (const cid of new Set(list.filter((p) => p.accessMode === 'api').map((p) => p.credentialId || ''))) {
    await ensureModelOptions(true, cid);
  }
  listEl.innerHTML = '';
  for (const p of list) {
    const row = document.createElement('div'); row.className = 'row';
    const name = document.createElement('div'); name.className = 'm-name'; name.textContent = p.name;

    const dir = document.createElement('div'); dir.className = 'm-dir'; dir.textContent = p.homeDir; dir.title = p.homeDir;

    const tags = document.createElement('div'); tags.style.display = 'flex'; tags.style.gap = '4px';
    if (p.isButler) { const tag = document.createElement('span'); tag.className = 'm-tag butler'; tag.textContent = t('butler'); tags.appendChild(tag); }
    if (p.open)     { const tag = document.createElement('span'); tag.className = 'm-tag open';   tag.textContent = t('opened'); tags.appendChild(tag); }

    const editB = document.createElement('button'); editB.className = 'm-btn'; editB.textContent = t('mgr_edit');
    const setB = document.createElement('button'); setB.className = 'm-btn'; setB.textContent = t('mgr_set_butler'); setB.disabled = !!p.isButler;
    setB.title = t('mgr_set_butler_hint');
    setB.addEventListener('click', async () => {
      // 只在该人格"当前正开着"时提示: 管家身份标记会立刻切, 但它正跑的会话工具是启动时定死的,
      // list/open/create 这些管家专属工具要等会话重建(关标签重开 / 下次清空 / 重启 app)才长出来。
      // 没开的人格无需提示——下次打开就是全新会话, 自带管家能力。
      if (p.open && !window.confirm(t('mgr_set_butler_confirm', { name: p.name }))) return;
      const r2 = await window.butler.updatePersona(p.id, { isButler: true });
      if (r2.ok) toast(t(p.open ? 'mgr_butler_set_open' : 'mgr_butler_set', { name: p.name }));
    });

    const exp = document.createElement('button'); exp.className = 'm-btn'; exp.textContent = t('mgr_export');
    // 开着也能导: 后端先 persist + VACUUM INTO 出一致快照再打包。原先这里置灰, 而置灰的按钮
    // 在 Chromium 里收不到鼠标事件, title 那句解释永远弹不出来 —— 用户只看到"导出不能用"。
    exp.title = t('mgr_export_hint');
    exp.addEventListener('click', async () => {
      exp.disabled = true;
      const r2 = await window.butler.exportPersona(p.id);
      exp.disabled = false;
      if (r2.canceled) return;
      if (!r2.ok) { toast(t('mgr_export_failed') + (r2.error || '')); return; }
      const mb = (r2.size / 1048576).toFixed(1);
      // 摘掉了凭据就得说出来, 否则用户在新机器上会对着一个"看起来导成功了却连不上 TG"的人格发懵
      toast(r2.stripped && r2.stripped.length
        ? t('mgr_exported_stripped', { mb, list: r2.stripped.join(', ') })
        : t('mgr_exported', { mb }));
    });

    const del = document.createElement('button'); del.className = 'm-btn danger'; del.textContent = t('mgr_delete'); del.disabled = !!p.open;
    del.title = p.open ? t('mgr_delete_open_hint') : t('mgr_delete_hint');
    del.addEventListener('click', async () => {
      if (!confirm(t('mgr_delete_confirm', { name: p.name }))) return;
      const r2 = await window.butler.deletePersona(p.id);
      if (r2.ok) toast(t('mgr_deleted', { name: p.name })); else toast(t('mgr_delete_failed') + r2.error);
    });

    row.append(name, dir, tags, editB, setB, exp, del);
    listEl.appendChild(row);

    // 展开式编辑面板(隐藏或按上次状态)
    const panel = makeEditPanel(p);
    panel.style.display = expanded.has(p.id) ? 'block' : 'none';
    listEl.appendChild(panel);
    // 展开时懒加载 persona.md 内容 (只加载一次, 避免每次刷新覆盖用户改的)
    async function loadPersonaMdIfNeeded() {
      const ta = panel.querySelector('.e-pmd');
      if (ta.dataset.loaded === '1') return;
      const r = await window.butler.readPersonaMd(p.id);
      ta.value = r.ok ? r.content : (t('mgr_pmd_load_failed') + (r.error || ''));
      ta.dataset.loaded = '1';
    }
    editB.addEventListener('click', async () => {
      const showing = panel.style.display !== 'none';
      panel.style.display = showing ? 'none' : 'block';
      if (showing) expanded.delete(p.id); else { expanded.add(p.id); await loadPersonaMdIfNeeded(); }
      editB.textContent = showing ? t('mgr_edit') : t('mgr_collapse');
      if (!showing) panel.querySelector('.e-name').focus();
    });
    if (expanded.has(p.id)) { editB.textContent = t('mgr_collapse'); loadPersonaMdIfNeeded(); }

    // 语音开关: 勾选立即生效 + 落盘, 不依赖底部「保存」(之前要点保存才存, 太容易忘 → 状态丢)
    panel.querySelector('.e-voice-en').addEventListener('change', async (ev) => {
      const en = ev.target.checked;
      const r = await window.butler.updatePersona(p.id, { voice: { enabled: en, voice: (p.voice && p.voice.voice) || 'Tingting' } });
      if (r.ok) toast(t(en ? 'mgr_voice_on' : 'mgr_voice_off'));
      else { toast(t('mgr_voice_save_failed') + r.error); ev.target.checked = !en; }
    });

    // 清单 ⇄ 手输 二选一, 同一个位置换着显示 —— 两个框并排摆着看不出谁管谁
    const modelSel = panel.querySelector('.e-model-sel');
    const manual = panel.querySelector('.e-model-manual');
    const showManual = (on) => {
      manual.hidden = !on;
      modelSel.style.display = on ? 'none' : '';
      if (on) panel.querySelector('.e-model-custom').focus();
    };
    modelSel.addEventListener('change', (ev) => { if (ev.target.value === MODEL_CUSTOM) showManual(true); });

    // 切接入方式 → 立刻换清单: 订阅和网关能用的模型名几乎没有交集(实测一家网关 46 个模型里
    // 只有 1 个是 claude-* 命名), 还留着上一套的选项只会让人选中一个必然报错的名字。
    const accApi = panel.querySelector('.e-acc-api');
    const accSub = panel.querySelector('.e-acc-sub');
    const credSel = panel.querySelector('.e-cred');
    const sdkSel = panel.querySelector('.e-sdk');
    const sdkNote = panel.querySelector('.e-sdk-note');
    const baseSdk = p.sdk || 'claude-code';
    const reloadModels = async () => {
      const cur = manual.hidden ? modelSel.value : panel.querySelector('.e-model-custom').value.trim();
      // 凭据下拉只在「用 key」时露面 —— 走订阅时它无处可用, 摆着只会让人以为选了有效
      credSel.style.display = accApi.checked && _creds.length ? '' : 'none';
      // 引擎只对「用 key」有得选: 订阅只有 Claude Code 跑得了(行照样摆着, 置灰并说明); 没装 Claude Code 时整行不出现
      sdkSel.disabled = !accApi.checked;
      if (!accApi.checked) sdkSel.value = 'claude-code';
      else if (sdkSel.value === 'claude-code' && baseAccess !== 'api') sdkSel.value = baseSdk;
      sdkNote.textContent = accApi.checked ? '' : t('mgr_sdk_sub_only');
      await ensureModelOptions(accApi.checked, credSel.value);
      useModelCache(accApi.checked, credSel.value);
      modelSel.innerHTML = modelOptionsHtml(cur, { needModel: accApi.checked });
      panel.querySelector('.e-model-src').textContent = modelSrcNote();
      // 原来选的那个在新清单里没有 → 自动亮出手输框, 别让它悄悄落到别的模型上
      if (cur && !isKnownModel(cur)) { panel.querySelector('.e-model-custom').value = cur; showManual(true); }
    };
    // 🔴 切接入方式**只换清单, 不动手** —— 一切在「保存」那一刻才结算 (2026-08-18 作者口述)。
    //    理由: 切完模式用户多半还要接着挑一个新模型, 这时就重启等于按他半截的意图动手。
    //    锚点 base = 登记簿里存的那对, 也正是**在跑的会话真正用着的**那对; 取消时退回它。
    const baseAccess = p.accessMode === 'api' ? 'api' : 'subscription';
    const baseModel = p.model || '';
    const revertAccessAndModel = async () => {
      // 🔴 模式和模型必须**一起**退。只退模式的话, 留下的是用户在新模式清单里挑的那个模型名,
      //    旧端点根本不认识它 —— 而人格偏好优先级高于 env, 会被原样发给旧端点, 之后每轮都失败。
      (baseAccess === 'api' ? accApi : accSub).checked = true;
      credSel.value = p.credentialId || _defCred || (_creds[0] && _creds[0].id) || '';
      sdkSel.value = baseSdk;
      showManual(false);
      modelSel.value = isKnownModel(baseModel) ? baseModel : '';
      await reloadModels();
    };
    const onAccessChange = async () => { await reloadModels(); };
    accApi.addEventListener('change', onAccessChange);
    accSub.addEventListener('change', onAccessChange);
    // 换凭据 = 换端点, 能用的模型清单跟着换(同切接入方式那条道理)
    credSel.addEventListener('change', onAccessChange);
    panel.querySelector('.e-model-back').addEventListener('click', () => {
      modelSel.value = isKnownModel(p.model) ? (p.model || '') : '';
      showManual(false);
    });

    panel.querySelector('.e-save').addEventListener('click', async () => {
      const newName = panel.querySelector('.e-name').value.trim();
      const newWake = panel.querySelector('.e-wake').value;   // 允许留空 = 用默认
      const newAvatar = panel.querySelector('.e-avatar-val').value;
      if (!newName) { toast(t('mgr_name_required')); return; }
      // 手输框正露着 = 用手输的值; 否则用清单选的。'' = 跟随默认
      const newModel = manual.hidden
        ? panel.querySelector('.e-model-sel').value
        : panel.querySelector('.e-model-custom').value.trim();
      if (accApi.checked && (!newModel || newModel === MODEL_CUSTOM)) { toast(t('mgr_model_required')); return; }
      const patch = {};
      if (newName !== p.name) patch.name = newName;
      if (newAvatar !== (p.avatar || '')) patch.avatar = newAvatar;
      if (newWake !== (p.wakePhrase || '')) patch.wakePhrase = newWake;
      const newAccess = accApi.checked ? 'api' : 'subscription';
      const newCred = newAccess === 'api' ? credSel.value : (p.credentialId || '');
      // 引擎同接入方式: 建流那刻选定, 换了要重开 —— 一起走下面那条原子路
      const newSdk = newAccess === 'api' && _ccAvail ? sdkSel.value : baseSdk;
      const accessChanged = newAccess !== baseAccess || newCred !== (p.credentialId || '') || newSdk !== baseSdk;
      if (newSdk !== baseSdk) patch.sdk = newSdk;
      if (newAccess !== baseAccess) patch.accessMode = newAccess;
      if (newCred !== (p.credentialId || '')) patch.credentialId = newCred;
      if (newModel !== baseModel) {
        // 模型偏好改了 + 该人格当前开着 → 弹确认: 跟"设为管家"同构, 得等会话重启才生效。
        // 模式也变了的话这个确认不弹 —— 下面那个确认框已经把模型的新旧一并写清楚了, 别连弹两个。
        if (p.open && !accessChanged
            && !window.confirm(t('mgr_model_confirm', { name: p.name, model: newModel || t('mgr_model_default') }))) return;
        patch.model = newModel;   // '' = 传空显式取消偏好
      }
      // 插件配置合并进 patch(不管有没有改, 一起提交; 后端 upsert 合并到位)
      const newPlugins = readPluginsFromPanel(panel);
      const oldPlugins = p.plugins || {};
      // 🔴 这里必须写 buses: readPluginsFromPanel 返回的是 { tg, buses }, 没有 bothub 这个键。
      // 写成 bothub 时它恒为 undefined —— 面板里配的 bus 一条都进不了 patch, 表现是「按了保存什么都没发生」,
      // 而且不报错(2026-08-25 作者在 dev 上撞到)。这是 plugins.bothub 改名 plugins.buses 时漏改的一行。
      patch.plugins = { ...oldPlugins, tg: newPlugins.tg, buses: newPlugins.buses };

      // ── 🔴 模式变了: 走「沉淀 → 拆流 → 才写盘 → 重开」那条原子路, 不走 updatePersona ──
      // 顺序是死的。早一步写盘, update-persona 会把新模型 setModel 热切进**旧端点**的会话,
      // 沉淀当场就报错。所以整条交给 restart-persona 一个 IPC 做完, 渲染层不做"先存后重启"的两段式。
      if (accessChanged) {
        const label = (m) => m || t('mgr_model_default');
        // 人格没开着就没有"重启"可言, 下次打开自然是新配置 —— 不拿一次没意义的确认烦人
        if (p.open && !window.confirm(t('mgr_access_restart_confirm', {
          name: p.name,
          from: t(baseAccess === 'api' ? 'mgr_access_api' : 'mgr_access_sub') + (baseAccess === 'api' && _ccAvail ? ` · ${t('mgr_sdk')}: ${sdkLabel(baseSdk)}` : ''),
          to: t(newAccess === 'api' ? 'mgr_access_api' : 'mgr_access_sub') + (newAccess === 'api' && _ccAvail ? ` · ${t('mgr_sdk')}: ${sdkLabel(newSdk)}` : ''),
          fromModel: label(baseModel), toModel: label(newModel),
        }))) { await revertAccessAndModel(); return; }   // 取消 = 模式+模型退回 base, 一个字节不落盘
        const rr = await window.butler.restartPersona(p.id, patch);
        // 沉淀失败会在这里中止: 没拆流也没写盘, 表单原样留着 —— 宁可不重启, 不吞掉没沉下去的活
        if (!rr.ok) { toast(t('mgr_access_restart_failed') + (rr.error || '')); return; }
        const ta0 = panel.querySelector('.e-pmd');
        if (ta0.dataset.loaded === '1') await window.butler.writePersonaMd(p.id, ta0.value);
        toast(t(rr.wasOpen ? 'mgr_access_restarted' : 'mgr_saved'));
        expanded.delete(p.id);
        return;
      }

      const r2 = await window.butler.updatePersona(p.id, patch);
      if (!r2.ok) { toast(t('mgr_save_failed') + r2.error); return; }
      // 顺带保存 persona.md (如果面板载入过 → 用户可能改过)
      const ta = panel.querySelector('.e-pmd');
      let pmdMsg = '';
      if (ta.dataset.loaded === '1') {
        const r3 = await window.butler.writePersonaMd(p.id, ta.value);
        pmdMsg = r3.ok ? t(r3.applied ? 'mgr_pmd_applied' : 'mgr_pmd_saved') : (t('mgr_pmd_failed') + r3.error);
      }
      // 模型切没切成必须说清楚。切不动却不吭声, 用户会以为换了、实际还在拿旧模型烧旧价钱。
      let modelMsg = '';
      const ms = r2.modelSwitch;
      if (ms && ms.applied) modelMsg = t('mgr_model_hot', { model: ms.model || t('mgr_model_default') });
      else if (ms && ms.reason === 'deferred_busy') modelMsg = t('mgr_model_after_turn', { model: ms.model || t('mgr_model_default') });
      else if (ms && ms.reason) modelMsg = t('mgr_model_next_session');
      // 接入方式改了且人格开着: 端点/凭据在 env 里, spawn 那刻就定死了, 没有热切这条路 —— 明说要重开
      const accessMsg = r2.needsReopen ? t('mgr_access_reopen') : '';
      toast(t('mgr_saved') + pmdMsg + modelMsg + accessMsg);
      expanded.delete(p.id);
    });
    panel.querySelector('.e-cancel').addEventListener('click', () => {
      panel.style.display = 'none'; expanded.delete(p.id); editB.textContent = t('mgr_edit');
    });
  }
  if (!list.length) { listEl.innerHTML = `<div class="row" style="color:#888">${esc(t('mgr_empty'))}</div>`; }
}

F.choose.addEventListener('click', async () => {
  const r = await window.butler.chooseDirectory();   // note: 安装根里=不能用 · 已住人=会接管, 两种都得当场说
  if (r && r.ok) { F.dir.value = r.path; if (r.note) alert(r.note); }
});

// 导入人格。不弹确认框: 导入是纯增量(建一个新目录 + 多一条登记), 不动现有任何人格,
// 撤销就是把它删掉 —— 这种可逆动作拦一道确认只是徒增一次点击。
F.importBtn.addEventListener('click', async () => {
  // 落盘位置是导入唯一不可事后更改的选择(目录切换要迁记忆图, P6 才做), 所以没填目录时
  // 先说清默认落在哪, 给一次去选目录的机会 —— 别让人事后才发现人格进错了地方。
  // ⚠️ 2026-08-25 我一度以为是这行 confirm 让「导出后点导入没反应」, 把它删了 —— 判断错了,
  //    真凶是 toast 缺 pointer-events:none 挡住了按钮(见 style.css)。所以这道确认原样留着。
  if (!F.dir.value.trim() && !window.confirm(t('mgr_import_default_dir_confirm'))) return;
  F.importBtn.disabled = true;
  let r;
  // 🔴 恢复按钮必须在 finally 里。原先写在 await 后面一行, 只要这一路上任何地方抛了,
  //    按钮就永久卡在灰色 —— 用户连重试都做不到, 只能重启 app(2026-08-19 作者撞到)。
  try {
    // 目录框对"导入"同样生效: 留空 = 自动放在 personas/<名字>, 跟创建人格一个口径
    r = await window.butler.importPersona(F.dir.value.trim() || undefined);
  } catch (e) {
    toast(t('mgr_import_failed') + String((e && e.message) || e));
    return;
  } finally { F.importBtn.disabled = false; }
  if (!r || r.canceled) return;
  if (!r.ok) { toast(t('mgr_import_failed') + (r.error || '')); return; }
  F.dir.value = '';
  // 记忆是【灌进本机新建的库】的, 不是拷了个库文件过来 —— 报出真实条数用户才有得确认。
  // 光说"记忆跟过来了"是句空话: 少灌了一半也照样这么说。
  const mem = r.memory && r.memory.nodes ? ` · ${t('mgr_imported_memory', { n: r.memory.nodes })}` : '';
  toast((r.stripped && r.stripped.length
    ? t('mgr_imported_stripped', { name: r.name, list: r.stripped.join(', ') })
    : t('mgr_imported', { name: r.name })) + mem);
});

// —— 新建表单的接入方式 + 模型 ——
// 模型清单跟着接入方式走(订阅问 SDK / 用 key 问那个端点), 所以换了单选就得重拉一次, 否则
// 选的是订阅却在挑网关的模型名。
const createShowManual = (on) => {
  F.modelManual.hidden = !on;
  F.modelSel.style.display = on ? 'none' : '';
  if (on) F.modelCustom.focus();
};
async function refreshCreateModelOptions() {
  // 新建时凭据下拉默认落在「默认」那条 —— 这正是设置里那个默认选项的用处
  F.cred.innerHTML = credOptionsHtml(F.cred.value || _defCred);
  F.cred.style.display = F.accApi.checked && _creds.length ? '' : 'none';
  // 引擎: 只有装了 Claude SDK 才有得选; 选中的那个建人格时写死
  if (!F.sdk.options.length || F.sdk.dataset.cc !== String(_ccAvail)) {
    F.sdk.dataset.cc = String(_ccAvail);
    F.sdk.innerHTML = (_ccAvail ? ['claude-code', 'butler'] : ['butler']).map((k) => `<option value="${k}">${esc(sdkLabel(k))}</option>`).join('');
  }
  F.sdk.style.display = F.accApi.checked && _ccAvail ? '' : 'none';
  await ensureModelOptions(F.accApi.checked, F.cred.value);
  F.modelSel.innerHTML = modelOptionsHtml('', { defaultOpt: true, needModel: F.accApi.checked });
  F.modelSrc.textContent = modelSrcNote();
  createShowManual(false);
  F.modelCustom.value = '';
}
// 读表单当前选的模型。「跟随默认」和「其它但没填」都算没选 —— 交给主进程用默认。
const createModelValue = () => {
  if (!F.modelManual.hidden) return F.modelCustom.value.trim() || undefined;
  const v = F.modelSel.value;
  return (!v || v === MODEL_CUSTOM) ? undefined : v;
};
F.modelSel.addEventListener('change', (ev) => { if (ev.target.value === MODEL_CUSTOM) createShowManual(true); });
F.modelBack.addEventListener('click', () => { createShowManual(false); F.modelCustom.value = ''; F.modelSel.value = ''; });
F.accSub.addEventListener('change', refreshCreateModelOptions);
F.accApi.addEventListener('change', refreshCreateModelOptions);
F.cred.addEventListener('change', refreshCreateModelOptions);

// 管理和新建分两个视图(作者 2026-11-05 定): 进管理只看人格列表, 新建由菜单「新建人格」直接进(#create)。
let _view = 'list';
function showView(v) {
  const create = v === 'create';
  _view = create ? 'create' : 'list';
  document.getElementById('v-create').hidden = !create;
  document.getElementById('v-list').hidden = create;
  if (S.mgr_title) document.title = t(create ? 'mgr_new_persona' : 'mgr_title');
}
showView(location.hash === '#create' ? 'create' : 'list');
window.butler.onManagerView && window.butler.onManagerView(showView);

F.create.addEventListener('click', async () => {
  const name = F.name.value.trim();
  if (!name) { toast(t('mgr_name_required')); F.name.focus(); return; }
  if (F.accApi.checked && !createModelValue()) { toast(t('mgr_model_required')); return; }
  F.create.disabled = true;
  const r = await window.butler.createPersonaUI({
    name, homeDir: F.dir.value.trim() || undefined,
    wakePhrase: F.wake.value.trim() || undefined, isButler: F.butler.checked,
    avatar: document.getElementById('f-avatar-val').value || undefined,
    accessMode: F.accApi.checked ? 'api' : 'subscription',
    credentialId: F.accApi.checked ? (F.cred.value || undefined) : undefined,
    sdk: F.accApi.checked ? (F.sdk.value || 'butler') : undefined,
    model: createModelValue(),
  });
  F.create.disabled = false;
  if (r.ok) {
    toast(t('mgr_created', { name: r.name }));
    F.name.value = ''; F.dir.value = ''; F.wake.value = ''; F.butler.checked = false; createSetAvatar('');
    (_subLoggedIn ? F.accSub : F.accApi).checked = true; await refreshCreateModelOptions();
    showView('list');
  } else { toast(t('mgr_create_failed') + r.error); }
});

// 本机戳醒 API 和网络代理原先在这里, 2026-08-17 挪进系统设置窗口(settings-ui.js) —— 它俩不属于任何人格。

// ---- 界面语言 ----
// 静态文案走 data-i18n*, 动态生成的(人格行/编辑面板/状态条)只能整块重画。
function applyStrings(payload) {
  S = (payload && payload.strings) || S;
  document.title = t(_view === 'create' ? 'mgr_new_persona' : 'mgr_title');
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
}

window.butler.onRegistryChanged && window.butler.onRegistryChanged(refresh);
window.butler.onLocaleChanged && window.butler.onLocaleChanged(async (payload) => {
  applyStrings(payload);
  await refresh();
  refreshCreateModelOptions();   // 「跟随默认」那条是 t() 拼的, 换语言要重画
});

(async () => {
  // 先拿语言再画: 列表和编辑面板是 t() 拼出来的, S 还空着就画会得到一屏空白
  try { applyStrings(await window.butler.getLocale()); }
  catch (e) { console.error('[manager] getLocale failed:', e && e.message); }
  await refresh();
  // 排在 refresh 之后: refresh 渲染各人格编辑面板时会把模型清单缓存切来切去,
  // 中途填新建表单会拿到别人的那份。
  refreshCreateModelOptions();
})();
