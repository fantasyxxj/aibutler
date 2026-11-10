// channel-cards.js — 人格编辑面板「通道」页: 已配好的通道一张张卡片, 末尾一张大加号卡。
//
// 只管呈现, 不碰字段: Telegram 那几格和 hub 那块(hub-panel.js)仍由 manager.js 的 makeEditPanel
// 拼, 这里把它们各自收进一个表单容器, 点卡片「设置」或从加号里选了类型才露出来。保存照旧由
// readPluginsFromPanel 按 .pt-* / .pb-ep 读回, 所以「添加」「移除」都是改这些字段, 点保存才生效。
// 加新通道类型 = 往 TYPES 里加一项。AIHUB(hub)是我们自己的服务, 排第一、单独底色、带说明, 其余是第三方平台(作者 2026-11-06 定)。
'use strict';
(() => {
  const CSS = `
.ch-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(190px, 1fr)); gap:10px; margin:4px 0 8px; }
.ch-card { position:relative; background:var(--panel); border:1px solid var(--line); border-radius:var(--radius-sm); padding:12px; display:flex; flex-direction:column; gap:10px; }
.ch-card.on { border-color:var(--brand-hi); }
.ch-head { display:flex; align-items:center; gap:10px; }
.ch-icon { font-size:24px; line-height:1; }
.ch-name { font-size:13.5px; font-weight:600; }
.ch-meta { font-size:11.5px; color:var(--muted); margin-top:2px; display:flex; align-items:center; gap:5px; }
.ch-meta .dot { width:7px; height:7px; border-radius:50%; background:var(--muted); }
.ch-meta .dot.live { background:var(--ok); }
.ch-foot { display:flex; gap:6px; }
.ch-add { border:1.5px dashed var(--btn-line); background:transparent; color:var(--muted); border-radius:var(--radius-sm); min-height:96px; cursor:pointer; font:inherit; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; }
.ch-add:hover { border-color:var(--brand-hi); color:var(--text); }
.ch-add .plus { font-size:34px; line-height:1; font-weight:300; }
.ch-add-wrap { position:relative; }
.ch-pick { position:absolute; top:calc(100% + 4px); left:0; z-index:6; width:300px; background:var(--panel); border:1px solid var(--line); border-radius:8px; box-shadow:0 8px 22px var(--shadow); padding:4px; }
.ch-pick[hidden] { display:none; }
.ch-pick .pk-title { font-size:11.5px; color:var(--muted); padding:6px 8px 4px; }
.ch-pick .pk-item { display:flex; align-items:center; gap:10px; width:100%; background:transparent; border:none; color:var(--text); text-align:left; padding:8px; border-radius:6px; font:inherit; cursor:pointer; }
.ch-pick .pk-item:hover:not(:disabled) { background:var(--hover); }
.ch-pick .pk-item:disabled { opacity:.45; cursor:default; }
.ch-pick .pk-txt { flex:1; min-width:0; }
.ch-pick .pk-name { font-size:13px; display:flex; gap:6px; align-items:center; }
.ch-pick .pk-desc { font-size:11.5px; color:var(--muted); }
.ch-pick .pk-tag { font-size:10.5px; color:var(--muted); border:1px solid var(--line); border-radius:3px; padding:0 4px; }
.ch-card.own { background:var(--tint); border-color:var(--brand); }
.ch-own { font-size:10.5px; font-weight:500; color:#fff; background:var(--brand); border-radius:3px; padding:0 5px; margin-left:6px; }
.ch-pick .pk-item.own .pk-desc { color:var(--text-2); }
.ch-pick .pk-sep { height:1px; background:var(--line); margin:4px 2px; }
.ch-form { border-top:1px solid var(--line); padding-top:8px; margin-top:4px; }
.ch-form[hidden] { display:none; }
.ch-hint { font-size:11.5px; color:var(--muted); margin:2px 0 6px; }
.ch-wake { display:flex; flex-direction:column; gap:4px; margin:2px 0 10px; font-size:12.5px; }
.ch-wake label { font-weight:normal; display:flex; align-items:center; gap:6px; }
`;
  if (!document.getElementById('channel-cards-css')) {
    const st = document.createElement('style'); st.id = 'channel-cards-css'; st.textContent = CSS;
    document.head.appendChild(st);
  }
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // plugins.channels 的类型。字段名带 key/secret 是故意的: 导出人格时按字段名剥凭据(persona-transfer.js)
  const hookFields = (sign) => [{ k: 'webhook_key', label: 'ch_f_webhook', ph: 'ch_f_webhook_ph' }, ...(sign ? [{ k: 'secret', label: 'ch_f_sign', ph: 'ch_f_sign_ph' }] : [])];
  // Slack 新建应用选 From a manifest 粘这段, 权限、事件、Socket Mode、私信页一次配好(字段照 docs.slack.dev/reference/app-manifest)
  const SLACK_MANIFEST = JSON.stringify({
    _metadata: { major_version: 2, minor_version: 1 },
    display_information: { name: 'Butler' },
    features: { app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false }, bot_user: { display_name: 'Butler', always_online: true } },
    oauth_config: { scopes: { bot: ['chat:write', 'im:history', 'app_mentions:read'] } },
    settings: { event_subscriptions: { bot_events: ['app_mention', 'message.im'] }, socket_mode_enabled: true },
  }, null, 2);
  let KINDS = {};
  const kinds = (t) => ({
    dingtalk_hook: { icon: '🔔', name: t('ch_dingtalk_hook'), desc: 'ch_hook_desc', help: 'ch_dingtalk_hook_help', dir: 'ch_send_only', fields: hookFields(true), ready: (c) => !!c.webhook_key },
    feishu_hook: { icon: '🪶', name: t('ch_feishu_hook'), desc: 'ch_hook_desc', help: 'ch_feishu_hook_help', dir: 'ch_send_only', fields: hookFields(true), ready: (c) => !!c.webhook_key },
    wecom_hook: { icon: '💬', name: t('ch_wecom_hook'), desc: 'ch_hook_desc', help: 'ch_wecom_hook_help', dir: 'ch_send_only', fields: hookFields(false), ready: (c) => !!c.webhook_key },
    // 双向的: 测试按钮只验凭据(ipc.js), 真收发要保存后人格开着
    feishu_bot: { icon: '🪶', name: t('ch_feishu_bot'), desc: 'ch_feishu_bot_desc', help: 'ch_feishu_bot_help', dir: 'ch_two_way', two: true,
      fields: [{ k: 'app_id', label: 'ch_f_app_id', ph: 'ch_f_feishu_id_ph', plain: true }, { k: 'app_secret', label: 'ch_f_app_secret', ph: 'ch_f_secret_ph' }], ready: (c) => !!(c.app_id && c.app_secret) },
    dingtalk_bot: { icon: '🔔', name: t('ch_dingtalk_bot'), desc: 'ch_dingtalk_bot_desc', help: 'ch_dingtalk_bot_help', dir: 'ch_two_way', two: true,
      fields: [{ k: 'client_id', label: 'ch_f_client_id', ph: 'ch_f_ding_id_ph', plain: true }, { k: 'client_secret', label: 'ch_f_client_secret', ph: 'ch_f_secret_ph' }], ready: (c) => !!(c.client_id && c.client_secret) },
    discord: { icon: '🎮', name: 'Discord', desc: 'ch_discord_desc', help: 'ch_discord_help', dir: 'ch_two_way', two: true,
      fields: [{ k: 'bot_token', label: 'ch_f_bot_token', ph: 'ch_f_discord_ph' }], ready: (c) => !!c.bot_token },
    slack: { icon: '#️⃣', name: 'Slack', desc: 'ch_slack_desc', help: 'ch_slack_help', dir: 'ch_two_way', two: true,
      copy: SLACK_MANIFEST,
      fields: [{ k: 'bot_token', label: 'ch_f_bot_token', ph: 'ch_f_slack_bot_ph' }, { k: 'app_token', label: 'ch_f_app_token', ph: 'ch_f_slack_app_ph' }], ready: (c) => !!(c.bot_token && c.app_token) },
  });

  function apply(panel, p, t) {
    KINDS = kinds(t);
    const plug = panel.querySelector('.e-plugin');
    if (!plug) return;
    const st = p.pluginStatus || {};
    // 把 makeEditPanel 拼好的两段收进各自的表单: 第二个小标题(bus)之前是 Telegram, 之后是 hub
    const heads = [...plug.children].filter((e) => e.classList.contains('e-plugin-head'));
    const forms = {};
    for (const [id, from, to] of [['tg', heads[0], heads[1]], ['hub', heads[1], null]]) {
      const f = document.createElement('div'); f.className = 'ch-form'; f.dataset.ch = id; f.hidden = true;
      plug.insertBefore(f, from);
      for (let e = from; e && e !== to;) { const n = e.nextElementSibling; f.appendChild(e); e = n; }
      forms[id] = f;
    }
    const q = (sel) => plug.querySelector(sel);
    const hubRows = () => [...plug.querySelectorAll('.pb-ep')];
    const hubConnected = () => hubRows().some((el) => el.dataset.kind === 'bothub' && el.querySelector('.pbe-token').value.trim());
    const hubPending = () => !!plug.querySelector('.hub-join .hub-check');
    let picked = null;   // 这次刚从加号里选的、还没填完的那一种, 也要有张卡

    const TYPES = [
      { id: 'hub', icon: '🌐', name: 'AIHUB', desc: t('ch_hub_desc'), dir: 'ch_two_way', own: true,   // 我们自己的服务: 置顶、单独底色、标「官方」
        has: () => hubRows().length > 0 || hubPending(),
        state: () => (st.bothub && st.bothub.running ? ['live', t('ch_running')] : hubConnected() ? ['', t('ch_connected')] : hubPending() ? ['', t('ch_pending')] : ['', t('ch_not_set')]),
        open: () => {},
        remove: () => { if (!window.confirm(t('ch_hub_remove_confirm'))) return false; hubRows().forEach((el) => el.remove()); return true; } },
      { id: 'tg', icon: '✈️', name: 'Telegram', desc: t('ch_tg_desc'), dir: 'ch_two_way',
        has: () => q('.pt-mode').value !== 'off' || !!q('.pt-token').value.trim(),
        state: () => (st.tg && st.tg.running ? ['live', t('ch_running')] : q('.pt-mode').value === 'off' ? ['', t('ch_paused')] : ['', t('ch_stopped')]),
        open: () => { q('.pt-mode').value = 'native'; },
        remove: () => { q('.pt-mode').value = 'off'; q('.pt-token').value = ''; return true; } },
    ];

    // plugins.channels 里那些(personal/channels/ 的统一适配器): 同一种可以加好几条(好几个群), 每条一张卡、一个表单
    const chans = ((p.plugins && p.plugins.channels) || []).map((c) => ({ ...c }));
    const formOf = (c) => {
      const K = KINDS[c.type];
      const f = document.createElement('div'); f.className = 'ch-form'; f.dataset.ch = c.id; f.hidden = true;
      f.innerHTML = `<div class="e-plugin-head">${K.icon} ${esc(K.name)}</div>`
        + `<div class="e-line"><label>${esc(t('ch_f_label'))}</label><input data-k="label" placeholder="${esc(K.name)}" value="${esc(c.label)}"/></div>`
        + K.fields.map((x) => `<div class="e-line"><label>${esc(t(x.label))}</label><input type="${x.plain ? 'text' : 'password'}" data-k="${x.k}" placeholder="${esc(t(x.ph))}" value="${esc(c[x.k])}"/></div>`).join('')
        + `<div class="e-line"><label></label><div><button type="button" class="m-btn ch-test">${esc(t(K.two ? 'ch_check' : 'ch_test'))}</button>${K.copy ? ` <button type="button" class="m-btn ch-copy">${esc(t('ch_copy_manifest'))}</button>` : ''} <span class="ch-hint ch-test-note"></span><div class="ch-hint">${esc(t(K.help))}</div></div></div>`;
      f.querySelectorAll('input[data-k]').forEach((el) => el.addEventListener('input', () => { c[el.dataset.k] = el.value.trim(); render(); }));
      const cp = f.querySelector('.ch-copy');
      if (cp) cp.addEventListener('click', async () => { await navigator.clipboard.writeText(K.copy); f.querySelector('.ch-test-note').textContent = t('ch_copied_manifest'); });
      f.querySelector('.ch-test').addEventListener('click', async () => {
        const note = f.querySelector('.ch-test-note'); note.textContent = t('ch_testing');
        const r = await window.butler.channelTest({ ...c }, t('ch_test_text'));
        note.textContent = r && r.ok ? t(K.two ? 'ch_check_ok' : 'ch_test_ok') : `${t(K.two ? 'ch_check_fail' : 'ch_test_fail')}${(r && r.error) || ''}`;
      });
      plug.insertBefore(f, forms.tg);
      forms[c.id] = f;
    };
    chans.forEach(formOf);
    panel._chRead = () => chans.filter((c) => KINDS[c.type] && KINDS[c.type].ready(c));

    const box = document.createElement('div');
    // 没打开时来消息要不要叫醒它(dormant-wake.js): 外部平台一个开关, AIHUB 单独一个 —— 那是 AI 之间的往来, 想不想被叫醒因人而异
    const wk = p.wakeOnMessage || {};
    box.innerHTML = `<div class="ch-wake"><label><input type="checkbox" class="ch-wake-ch" ${wk.channels === false ? '' : 'checked'}> ${esc(t('ch_wake_channels'))}</label>`
      + `<label><input type="checkbox" class="ch-wake-hub" ${wk.bothub === false ? '' : 'checked'}> ${esc(t('ch_wake_hub'))}</label></div>`
      + `<div class="ch-grid"></div><div class="ch-hint">${esc(t('ch_save_hint'))}</div>`;
    plug.insertBefore(box, plug.firstChild);
    panel._wakeRead = () => ({ channels: box.querySelector('.ch-wake-ch').checked, bothub: box.querySelector('.ch-wake-hub').checked });
    const grid = box.querySelector('.ch-grid');
    let openId = null;
    const show = (id) => {
      openId = openId === id ? null : id;
      for (const [k, f] of Object.entries(forms)) f.hidden = k !== openId;
      render();
    };

    // 双向通道在跑没跑: 人格开着时主进程把 ChannelHost.status() 带过来(main.js list-personas)
    const live = (c) => !!(st.channels && st.channels[c.id] && st.channels[c.id].running);
    const chState = (c, K) => {
      if (!K.ready(c)) return t('ch_not_set');
      if (!K.two || !st.channels) return t('ch_ready');
      const x = st.channels[c.id];
      return x && x.running ? t('ch_running') : x && x.lastError ? `${t('ch_stopped')}: ${x.lastError}` : t('ch_ready');
    };
    function chanCard(c) {
      const K = KINDS[c.type]; if (!K) return;
      const card = document.createElement('div'); card.className = 'ch-card' + (openId === c.id ? ' on' : '');
      card.innerHTML = `<div class="ch-head"><span class="ch-icon">${K.icon}</span><div><div class="ch-name">${esc(c.label || K.name)}</div>
        <div class="ch-meta"><span class="dot ${live(c) ? 'live' : ''}"></span>${esc(t(K.dir))} · ${esc(chState(c, K))}</div></div></div>
        <div class="ch-foot"><button type="button" class="m-btn ch-set">${esc(openId === c.id ? t('mgr_collapse') : t('ch_setup'))}</button><button type="button" class="m-btn ch-del">${esc(t('ch_remove'))}</button></div>`;
      card.querySelector('.ch-set').addEventListener('click', () => show(c.id));
      card.querySelector('.ch-del').addEventListener('click', () => {
        chans.splice(chans.indexOf(c), 1); forms[c.id].remove(); delete forms[c.id];
        if (openId === c.id) openId = null;
        render();
      });
      grid.appendChild(card);
    }

    function render() {
      grid.innerHTML = '';
      for (const ty of TYPES.filter((x) => x.has() || picked === x.id)) {
        const [cls, txt] = ty.state();
        const c = document.createElement('div'); c.className = 'ch-card' + (ty.own ? ' own' : '') + (openId === ty.id ? ' on' : '');
        c.innerHTML = `<div class="ch-head"><span class="ch-icon">${ty.icon}</span><div><div class="ch-name">${esc(ty.name)}${ty.own ? `<span class="ch-own">${esc(t('ch_official'))}</span>` : ''}</div>
          <div class="ch-meta"><span class="dot ${cls}"></span>${esc(t(ty.dir))} · ${esc(txt)}</div></div></div>
          <div class="ch-foot"><button type="button" class="m-btn ch-set">${esc(openId === ty.id ? t('mgr_collapse') : t('ch_setup'))}</button><button type="button" class="m-btn ch-del">${esc(t('ch_remove'))}</button></div>`;
        c.querySelector('.ch-set').addEventListener('click', () => show(ty.id));
        c.querySelector('.ch-del').addEventListener('click', () => {
          if (!ty.remove()) return;
          if (picked === ty.id) picked = null;
          if (openId === ty.id) { openId = null; forms[ty.id].hidden = true; }
          render();
        });
        grid.appendChild(c);
      }
      chans.forEach(chanCard);
      const w = document.createElement('div'); w.className = 'ch-add-wrap';
      w.innerHTML = `<button type="button" class="ch-add"><span class="plus">+</span><span>${esc(t('ch_add'))}</span></button><div class="ch-pick" hidden><div class="pk-title">${esc(t('ch_pick_title'))}</div></div>`;
      const pick = w.querySelector('.ch-pick');
      for (const ty of TYPES) {
        const done = ty.has() || picked === ty.id;
        if (!ty.own && !pick.querySelector('.pk-sep')) pick.insertAdjacentHTML('beforeend', `<div class="pk-sep"></div><div class="pk-title">${esc(t('ch_third_party'))}</div>`);
        const b = document.createElement('button'); b.type = 'button'; b.className = 'pk-item' + (ty.own ? ' own' : ''); b.disabled = done;
        b.innerHTML = `<span class="ch-icon">${ty.icon}</span><span class="pk-txt"><span class="pk-name">${esc(ty.name)}${ty.own ? `<span class="ch-own">${esc(t('ch_official'))}</span>` : ''}<span class="pk-tag">${esc(t(ty.dir))}</span>${done ? `<span class="pk-tag">${esc(ty.id === 'hub' && hubConnected() ? t('ch_connected') : t('ch_added'))}</span>` : ''}</span><span class="pk-desc">${esc(ty.desc)}</span></span>`;
        b.addEventListener('click', () => { pick.hidden = true; picked = ty.id; ty.open(); openId = null; show(ty.id); });
        pick.appendChild(b);
      }
      for (const [type, K] of Object.entries(KINDS)) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'pk-item';
        b.innerHTML = `<span class="ch-icon">${K.icon}</span><span class="pk-txt"><span class="pk-name">${esc(K.name)}<span class="pk-tag">${esc(t(K.dir))}</span></span><span class="pk-desc">${esc(t(K.desc))}</span></span>`;
        b.addEventListener('click', () => {
          pick.hidden = true;
          let n = 1; while (chans.some((c) => c.id === `${type}${n}`)) n++;
          const c = { id: `${type}${n}`, type, label: '' };
          chans.push(c); formOf(c); openId = null; show(c.id);
        });
        pick.appendChild(b);
      }
      w.querySelector('.ch-add').addEventListener('click', (e) => { e.stopPropagation(); pick.hidden = !pick.hidden; });
      grid.appendChild(w);
    }
    document.addEventListener('click', (e) => { const pk = grid.querySelector('.ch-pick'); if (pk && !pk.hidden && !e.target.closest('.ch-add-wrap')) pk.hidden = true; });
    // hub 块的申请状态是异步拿回来的(hub-panel.js renderForm/renderConnected), 它一换内容卡片跟着重画
    const hj = plug.querySelector('.hub-join');
    if (hj) new MutationObserver(() => render()).observe(hj, { childList: true });
    render();
  }

  // 保存时 manager.js 用它读回 plugins.channels; 面板没经过 apply 就原样交回
  const read = (panel, p) => (panel._chRead ? panel._chRead() : ((p && p.plugins && p.plugins.channels) || []));
  const readWake = (panel, p) => (panel._wakeRead ? panel._wakeRead() : (p && p.wakeOnMessage));
  window.ChannelCards = { apply, read, readWake };
})();
