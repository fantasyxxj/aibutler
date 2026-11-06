// empty-state.js — 一个人格都没有时的那一屏: 两步建出第一个人格。
//
// ① 接上 AI: 两张卡片「用 Claude 订阅」/「用 API Key」, 右上角能改界面语言(首启不再弹框问语言,
//    出生教育读的是建人格那一刻的语言, 在这里改就来得及)。
// ② 起名字: 名字(默认「管家」)+ 可选头像 + 模型(有推荐默认值); 引擎、人格目录收进「高级」。
// 作者 2026-11-06 定: 首启压到两屏, 技术决策不压在用户说第一句话之前。
//
// 🔴 没接 AI 就一个都不建: 启动链发现没人格不兜底造一个不会说话的管家, 显示这一屏。
// 🔴 它不是浮层而是整屏: 没有人格的时候背后没有任何可看的东西, 给关闭按钮等于让人对着空白。
//
// 单开一个文件: renderer.js / style.css / i18n.js 都撞了行数闸, 所以文案和样式一并自带。
'use strict';

(() => {
  const T = {
    'zh-CN': {
      s1Title: '先接上 AI', s1Lede: '助手要接上 AI 才能说话。选一种你手上有的:',
      subTitle: '用 Claude 订阅', subDesc: '有 Claude Pro / Max 订阅就用它, 登录一次即可。',
      apiTitle: '用 API Key', apiDesc: 'Anthropic、OpenAI 兼容网关、国内大模型的 Key 都行。',
      loggedIn: '✓ 已登录', login: '登录 Claude', keysOk: '✓ 已存 {n} 把 Key', addKey: '去添加 Key', manageKey: '管理 Key',
      next: '下一步', back: '← 上一步',
      s2Title: '给它起个名字', s2Lede: '这是你的第一个助手, 以后随时可以再建。', defName: '管家', needName: '起个名字吧。',
      modelLabel: '模型', modelInherit: '跟随默认(推荐)',
      modelCustom: '其它(手填)', modelPh: '模型 id', modelLoading: '正在拉清单…', needModel: '用 API Key 要选一个模型。',
      srcLive: '{n} 个 · 刚从 {from} 拉到', srcBuiltin: '{n} 个 · 内置清单',
      adv: '高级', engineLabel: '引擎', dirLabel: '人格资料放在', pick: '换个位置',
      hintTakeover: '这个目录里已经有人格资料了 —— 创建就是把它接过来接着用, 不会重新开始。',
      hintInstallRoot: '这个位置在程序的安装目录里, 不能放人格: 每次升级重装都会把它清空。换一个位置。',
      whyNow: '引擎和目录在人格出生那一刻就定了, 之后改要重开。',
      create: '创建并开始', creating: '创建中…', failed: '创建失败: ',
    },
    'zh-TW': {
      s1Title: '先接上 AI', s1Lede: '助理要接上 AI 才能說話。選一種你手上有的:',
      subTitle: '用 Claude 訂閱', subDesc: '有 Claude Pro / Max 訂閱就用它, 登入一次即可。',
      apiTitle: '用 API Key', apiDesc: 'Anthropic、OpenAI 相容閘道、各家大模型的 Key 都行。',
      loggedIn: '✓ 已登入', login: '登入 Claude', keysOk: '✓ 已存 {n} 把 Key', addKey: '去新增 Key', manageKey: '管理 Key',
      next: '下一步', back: '← 上一步',
      s2Title: '幫它取個名字', s2Lede: '這是你的第一個助理, 之後隨時可以再建。', defName: '管家', needName: '取個名字吧。',
      modelLabel: '模型', modelInherit: '跟隨預設(建議)',
      modelCustom: '其他(手填)', modelPh: '模型 id', modelLoading: '正在拉清單…', needModel: '用 API Key 要選一個模型。',
      srcLive: '{n} 個 · 剛從 {from} 拉到', srcBuiltin: '{n} 個 · 內建清單',
      adv: '進階', engineLabel: '引擎', dirLabel: '人格資料放在', pick: '換個位置',
      hintTakeover: '這個目錄裡已經有人格資料了 —— 建立就是把它接過來繼續用, 不會重新開始。',
      hintInstallRoot: '這個位置在程式的安裝目錄裡, 不能放人格: 每次升級重裝都會把它清空。換一個位置。',
      whyNow: '引擎和目錄在人格出生那一刻就定了, 之後改要重開。',
      create: '建立並開始', creating: '建立中…', failed: '建立失敗: ',
    },
    ja: {
      s1Title: 'まず AI につなぐ', s1Lede: 'アシスタントが話すには AI への接続が必要です。お持ちのものを選んでください:',
      subTitle: 'Claude のサブスクで', subDesc: 'Claude Pro / Max をお持ちならこちら。ログインは一度だけ。',
      apiTitle: 'API キーで', apiDesc: 'Anthropic、OpenAI 互換ゲートウェイ、各社モデルのキーが使えます。',
      loggedIn: '✓ ログイン済み', login: 'Claude にログイン', keysOk: '✓ キー {n} 件保存済み', addKey: 'キーを追加', manageKey: 'キーを管理',
      next: '次へ', back: '← 戻る',
      s2Title: '名前をつける', s2Lede: '最初のアシスタントです。あとからいつでも増やせます。', defName: '執事', needName: '名前を入れてください。',
      modelLabel: 'モデル', modelInherit: '既定に従う(おすすめ)',
      modelCustom: 'その他(手入力)', modelPh: 'モデル id', modelLoading: 'リスト取得中…', needModel: 'API キーを使う場合はモデルを選んでください。',
      srcLive: '{n} 件 · {from} から取得', srcBuiltin: '{n} 件 · 内蔵リスト',
      adv: '詳細設定', engineLabel: 'エンジン', dirLabel: '人格データの保存先', pick: '場所を変える',
      hintTakeover: 'このフォルダには既に人格データがあります —— 作成するとそれを引き継ぎます。最初からにはなりません。',
      hintInstallRoot: 'この場所はアプリのインストール先の中なので人格を置けません。アップデートのたびに消えます。別の場所を選んでください。',
      whyNow: 'エンジンと保存先は人格が生まれた時点で決まり、あとから変えるには開き直しが必要です。',
      create: '作成して始める', creating: '作成中…', failed: '作成に失敗: ',
    },
    en: {
      s1Title: 'Connect an AI first', s1Lede: 'Your assistant needs an AI connection to talk. Pick one you have:',
      subTitle: 'Claude subscription', subDesc: 'Have Claude Pro / Max? Log in once and you are set.',
      apiTitle: 'API key', apiDesc: 'Anthropic, OpenAI-compatible gateways and other providers all work.',
      loggedIn: '✓ Logged in', login: 'Log in to Claude', keysOk: '✓ {n} key(s) saved', addKey: 'Add a key', manageKey: 'Manage keys',
      next: 'Next', back: '← Back',
      s2Title: 'Give it a name', s2Lede: 'This is your first assistant. You can add more any time.', defName: 'Butler', needName: 'Give it a name.',
      modelLabel: 'Model', modelInherit: 'Default (recommended)',
      modelCustom: 'Other (type it)', modelPh: 'model id', modelLoading: 'fetching list…', needModel: 'With an API key you need to pick a model.',
      srcLive: '{n} · fetched from {from}', srcBuiltin: '{n} · built-in list',
      adv: 'Advanced', engineLabel: 'Engine', dirLabel: 'Persona files go in', pick: 'Change location',
      hintTakeover: 'This folder already holds persona data — creating takes it over and continues, not a fresh start.',
      hintInstallRoot: "This location is inside the app's install folder and gets wiped on every update. Pick another place.",
      whyNow: 'Engine and folder are fixed when the persona is born; changing them later needs a reopen.',
      create: 'Create and start', creating: 'Creating…', failed: 'Create failed: ',
    },
  };

  // 颜色一律走主题 token; 🔴 给了 background 就必须同时给 color, 否则文字会继承外面的主题色。
  const CSS = `
#emptyState{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;
  background:var(--bg);color:var(--text);padding:24px;overflow:auto}
#emptyState .es-card{width:min(560px,94vw);background:var(--panel);color:var(--text);
  border:1px solid var(--line);border-radius:var(--radius);padding:24px 28px;box-shadow:0 10px 30px var(--shadow)}
#emptyState .es-top{display:flex;align-items:center;margin-bottom:6px;font-size:12px;color:var(--muted)}
#emptyState .es-top .es-step{flex:1}
#emptyState h3{margin:0 0 6px;font-size:19px}
#emptyState .es-lede{margin:0 0 18px;color:var(--muted);font-size:13px;line-height:1.6}
#emptyState .es-opts{display:grid;grid-template-columns:1fr 1fr;gap:12px}
#emptyState .es-opt{border:1.5px solid var(--line);border-radius:var(--radius);padding:14px;cursor:pointer;background:var(--panel-2);color:var(--text);display:flex;flex-direction:column;gap:6px}
#emptyState .es-opt:hover{border-color:var(--btn-line)}
#emptyState .es-opt.on{border-color:var(--brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 22%,transparent)}
#emptyState .es-opt-h{font-weight:600;font-size:14px}
#emptyState .es-opt-d{font-size:12px;color:var(--muted);line-height:1.5;flex:1}
#emptyState .es-opt-s{font-size:12px;display:flex;flex-direction:column;gap:6px;align-items:flex-start}
#emptyState .es-ok{color:var(--ok)}
#emptyState button{background:var(--btn);color:var(--text);border:1px solid var(--btn-line);
  border-radius:var(--radius-sm);padding:6px 12px;font-size:12px;cursor:pointer}
#emptyState button:hover:not(:disabled){background:var(--btn-hi)}
#emptyState button.es-primary{background:var(--brand);border-color:var(--brand);color:#fff;padding:9px 18px;font-size:14px}
#emptyState button.es-primary:hover:not(:disabled){background:var(--brand-hi)}
#emptyState button:disabled{opacity:.45;cursor:not-allowed}
#emptyState .es-actions{display:flex;justify-content:space-between;align-items:center;margin-top:20px}
#emptyState .es-note{margin-top:10px;font-size:12px;color:var(--muted);line-height:1.5;min-height:1em}
#emptyState .es-field{margin:16px 0 6px;font-size:12px;color:var(--muted)}
#emptyState select,#emptyState input[type=text]{background:var(--field);color:var(--text);
  border:1px solid var(--line);border-radius:var(--radius-sm);padding:7px 9px;font-size:13px;width:100%;min-width:0}
#emptyState .es-top select{width:auto;font-size:12px;padding:3px 6px}
#emptyState .es-opt-s select{font-size:12px;padding:4px 6px}
#emptyState .es-name-row{display:flex;gap:12px;align-items:center}
#emptyState .es-av{width:48px;height:48px;font-size:22px}
#emptyState .es-av.is-emoji{font-size:32px}
#emptyState .es-name{font-size:15px!important;padding:9px 11px!important}
#emptyState .es-emojis{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
#emptyState .es-emojis button{background:transparent;border:1px solid transparent;font-size:18px;padding:2px 5px;line-height:1.2}
#emptyState .es-emojis button.on{border-color:var(--brand);background:var(--hover)}
#emptyState details.es-adv{margin-top:16px;font-size:12px;color:var(--muted)}
#emptyState details.es-adv summary{cursor:pointer;user-select:none}
#emptyState .es-row{display:flex;gap:8px;align-items:center}
#emptyState .es-path{font-size:12px;word-break:break-all;background:var(--field);color:var(--text);
  border:1px solid var(--line);border-radius:var(--radius-sm);padding:7px 9px;flex:1;min-width:0}
#emptyState .es-dir-note{font-size:11px;line-height:1.5;margin-top:6px;color:var(--muted)}
#emptyState .es-dir-note.bad{color:var(--danger)}
`;

  let lang = 'zh-CN', S = {}, locales = [];
  const tt = (k, vars) => String((T[lang] || T['zh-CN'])[k] || T['zh-CN'][k] || '').replace(/\{(\w+)\}/g, (_, n) => (vars && vars[n] != null ? vars[n] : ''));
  // 「Claude 订阅」卡片里的下载那段照搬系统设置的区块(cc-sdk-ui.js), 文案也用它那份(i18n-ccsdk.js)
  const st = (k, vars) => String(S[k] || '').replace(/\{(\w+)\}/g, (_, n) => (vars && vars[n] != null ? vars[n] : ''));
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const EMOJIS = ['🤖', '🦉', '🐱', '🦊', '🐼', '🌸', '🚀', '⭐', '🧠', '☕', '🎨', '📚'];

  // 两条通路各自的状态, 不是一个合并的布尔 —— 要让人在订阅和 key 之间选, 就必须分别知道哪条能用。
  async function probeAccess() {
    try {
      const d = await window.butler.listCredentials();
      return { sub: !!(d && d.subLoggedIn), cc: !(d && d.ccAvailable === false),
        creds: ((d && d.credentials) || []).filter((c) => c.keyState === 'ok'),
        defCred: (d && d.defaultCredentialId) || '' };
    } catch (_) { return { sub: false, cc: true, creds: [], defCred: '' }; }
  }

  // 模型清单跟着【接入方式 + 哪条凭据】走: 订阅问 SDK, 走 key 问那个端点, 都拉不到才回落内置清单。
  const MODEL_CUSTOM = '__custom__';
  let _opts = [], _src = null;
  async function loadModels(useApi, credentialId) {
    try {
      const r = await window.butler.listModelOptions({ useApi: !!useApi, credentialId: credentialId || '' });
      _opts = (r && r.options) || []; _src = r || null;
    } catch (_) { _opts = []; _src = null; }
  }
  // 末尾留「其它」手输: 第三方网关的模型名千奇百怪, 清单拉不回来也得能建人格。
  // 🔴 用 API key 时没有「跟随默认」: 只有订阅走 Claude Code 才有它自带的默认模型, key 人格留空,
  //    Butler 引擎第一句就报 no model configured。这时默认选中清单第一个(就是推荐值)。
  function modelHtml(needModel) {
    const text = (o) => (!o.id || String(o.label || '').includes(o.id)) ? (o.label || o.id) : `${o.label || o.id} — ${o.id}`;
    const opts = needModel ? _opts.filter((o) => o.id) : _opts.filter((o) => o.id);
    const rows = needModel ? [] : [`<option value="" selected>${esc(tt('modelInherit'))}</option>`];
    rows.push(...opts.map((o, i) => `<option value="${esc(o.id)}"${needModel && i === 0 ? ' selected' : ''}>${esc(text(o))}</option>`));
    rows.push(`<option value="${MODEL_CUSTOM}">${esc(tt('modelCustom'))}</option>`);
    return rows.join('');
  }
  const srcNote = () => (!_src ? '' : tt(_src.source === 'live' ? 'srcLive' : 'srcBuiltin', { n: _opts.filter((o) => o.id).length, from: _src.from || '' }));

  async function show() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    let dir = '';
    try { dir = (await window.butler.defaultPersonaDir()) || ''; } catch (_) {}

    const ov = document.createElement('div');
    ov.id = 'emptyState';
    ov.innerHTML = `<div class="es-card">
      <div class="es-top"><span class="es-step"></span><select class="es-lang"></select></div>
      <section class="es-s1">
        <h3 data-t="s1Title"></h3><p class="es-lede" data-t="s1Lede"></p>
        <div class="es-opts">
          <div class="es-opt" data-acc="subscription">
            <div class="es-opt-h" data-t="subTitle"></div><div class="es-opt-d" data-t="subDesc"></div>
            <div class="es-opt-s">
              <span class="es-sub-ok es-ok" data-t="loggedIn"></span>
              <button class="es-login" data-t="login"></button>
              <span class="es-cc-state"></span>
              <button class="es-cc-on"></button><button class="es-cc-relaunch"></button>
            </div>
          </div>
          <div class="es-opt" data-acc="api">
            <div class="es-opt-h" data-t="apiTitle"></div><div class="es-opt-d" data-t="apiDesc"></div>
            <div class="es-opt-s">
              <span class="es-keys-ok es-ok"></span>
              <select class="es-cred"></select>
              <button class="es-setkey"></button>
            </div>
          </div>
        </div>
        <div class="es-actions"><span></span><button class="es-next es-primary" data-t="next"></button></div>
        <div class="es-note es-note1"></div>
      </section>
      <section class="es-s2" hidden>
        <h3 data-t="s2Title"></h3><p class="es-lede" data-t="s2Lede"></p>
        <div class="es-name-row"><span class="pc-avatar es-av"></span><input type="text" class="es-name" maxlength="40"></div>
        <div class="es-emojis"></div>
        <div class="es-field" data-t="modelLabel"></div>
        <select class="es-model"></select>
        <div class="es-model-manual" style="display:none;margin-top:6px"><input type="text" class="es-model-custom"></div>
        <div class="es-note es-model-src"></div>
        <details class="es-adv"><summary data-t="adv"></summary>
          <div class="es-engine-wrap"><div class="es-field" data-t="engineLabel"></div><select class="es-sdk"></select></div>
          <div class="es-field" data-t="dirLabel"></div>
          <div class="es-row"><span class="es-path"></span><button class="es-pick" data-t="pick"></button></div>
          <div class="es-dir-note"></div>
          <div class="es-dir-note" data-t="whyNow"></div>
        </details>
        <div class="es-actions"><button class="es-back" data-t="back"></button><button class="es-create es-primary" data-t="create"></button></div>
        <div class="es-note es-note2"></div>
      </section>
    </div>`;
    const q = (s) => ov.querySelector(s);
    document.body.appendChild(ov);

    let acc = null, chosen = '', avatar = '', step = 1, dirUnsafe = false, ccProg = null, lastKey = '', lastCredSig = '', nameTouched = false;
    const paint = () => {   // 换语言后整屏重刷一遍文字
      ov.querySelectorAll('[data-t]').forEach((e) => { e.textContent = tt(e.dataset.t); });
      q('.es-step').textContent = `${step} / 2`;
      q('.es-model-custom').placeholder = tt('modelPh');
      if (!nameTouched) q('.es-name').value = tt('defName');
      paintAvatar();
    };
    const paintAvatar = () => window.PersonaCard.paintAvatar(q('.es-av'), { name: q('.es-name').value.trim() || '?', avatar });
    q('.es-lang').innerHTML = locales.map((l) => `<option value="${esc(l.id)}"${l.id === lang ? ' selected' : ''}>${esc(l.label)}</option>`).join('');
    q('.es-lang').addEventListener('change', async () => {
      try {
        const r = await window.butler.setLocale(q('.es-lang').value);
        if (r && r.ok) {
          lang = T[r.locale] ? r.locale : lang; S = r.strings || S; paint();
          const sel = q('.es-model'), keep = sel.value;   // 清单是拼好的文字, 换语言要重拼, 选中的那项保住
          if (!sel.disabled && _src) { sel.innerHTML = modelHtml(useApi()); sel.value = keep; q('.es-model-src').textContent = srcNote(); }
          await refresh();
        }
      } catch (_) {}
    });
    q('.es-emojis').innerHTML = EMOJIS.map((e) => `<button data-e="${e}">${e}</button>`).join('');
    q('.es-emojis').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-e]'); if (!b) return;
      avatar = avatar === b.dataset.e ? '' : b.dataset.e;   // 再点一下取消, 回到名字首字
      q('.es-emojis').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.e === avatar));
      paintAvatar();
    });
    q('.es-name').addEventListener('input', () => { nameTouched = true; paintAvatar(); });

    // 目录一落定就探一次: 登记簿丢了而人格目录还在时, 默认那个路径本身就已经住着人。
    const applyDir = async () => {
      q('.es-path').textContent = dir;
      let r = null;
      try { r = await window.butler.probePersonaDir(dir); } catch (_) {}
      dirUnsafe = !!(r && r.unsafe);
      const n = q('.es-dir-note');
      n.textContent = dirUnsafe ? tt('hintInstallRoot') : (r && r.inhabited ? tt('hintTakeover') : '');
      n.classList.toggle('bad', dirUnsafe);
      if (dirUnsafe || (r && r.inhabited)) q('.es-adv').open = true;   // 有话要说就别藏着
      q('.es-create').disabled = dirUnsafe;
    };

    const useApi = () => chosen === 'api';
    const usable = (a) => (a === 'api' ? acc.creds.length > 0 : acc.sub);

    // 🔴 拉清单要走网络, 这中间下拉里摆着的还是上一个端点的清单 —— 锁住, 否则会选中新端点不认识的模型。
    //    序号防连切: 快速换两次凭据时先发的可能后回。
    let modelsSeq = 0;
    async function refreshModels() {
      const seq = ++modelsSeq;
      const sel = q('.es-model');
      sel.disabled = true;
      sel.innerHTML = `<option value="">${esc(tt('modelLoading'))}</option>`;
      q('.es-model-src').textContent = '';
      await loadModels(useApi(), q('.es-cred').value);
      if (seq !== modelsSeq) return;
      sel.innerHTML = modelHtml(useApi());
      sel.disabled = false;
      q('.es-model-src').textContent = srcNote();
      const manual = sel.value === MODEL_CUSTOM;   // 清单空着(拉不到)而又必须选: 直接落到手填
      q('.es-model-manual').style.display = manual ? '' : 'none';
      q('.es-model-custom').value = '';
    }

    // 开源包这次启动没加载 Claude SDK: 跟系统设置一样, 开启 → 下载 → 重启; 重启后登录按钮接手
    async function renderCc() {
      let s = null;
      if (!acc.cc) { try { s = await window.butler.ccSdkStatus(); } catch (_) {} }
      const show = !acc.cc && !!(s && s.applicable);
      let key = null, btn = null;
      if (show && !(s.installing || ccProg)) {
        if (s.enabled) { key = 'sys_cc_need_relaunch'; btn = '.es-cc-relaunch'; }
        else { key = s.installed ? 'sys_cc_state_off_kept' : 'sys_cc_state_off'; btn = '.es-cc-on'; }
      }
      q('.es-cc-state').style.display = show ? '' : 'none';
      q('.es-cc-state').textContent = !show ? '' : key ? st(key, { version: s.version }) : (ccProg || st('sys_cc_downloading', { pct: 0 }));
      for (const b of ['.es-cc-on', '.es-cc-relaunch']) q(b).style.display = show && b === btn ? '' : 'none';
      q('.es-cc-on').textContent = st('sys_cc_on'); q('.es-cc-relaunch').textContent = st('sys_cc_relaunch');
      q('.es-cc-on').dataset.installed = s && s.installed ? '1' : '';
      return show;
    }
    async function refresh() {
      acc = await probeAccess();
      const ccBlock = await renderCc();
      // 没装 CC 也没法现下(开发机之外不会出现): 订阅这条路不存在, 整张卡片不出现
      q('.es-opt[data-acc=subscription]').style.display = acc.cc || ccBlock ? '' : 'none';
      q('.es-sub-ok').style.display = acc.sub ? '' : 'none';
      q('.es-login').style.display = acc.cc && !acc.sub ? '' : 'none';
      q('.es-keys-ok').style.display = acc.creds.length ? '' : 'none';
      q('.es-keys-ok').textContent = tt('keysOk', { n: acc.creds.length });
      q('.es-setkey').textContent = tt(acc.creds.length ? 'manageKey' : 'addKey');
      // 🔴 只在凭据名单真的变了才重建下拉。这个 2 秒一次的轮询会把人刚选的那条冲回默认。
      const sig = acc.creds.map((c) => c.id).join(',') + '|' + acc.defCred;
      if (sig !== lastCredSig) {
        lastCredSig = sig;
        const keep = q('.es-cred').value;
        q('.es-cred').innerHTML = acc.creds.map((c) =>
          `<option value="${esc(c.id)}"${c.id === acc.defCred ? ' selected' : ''}>${esc(c.name || c.id)}</option>`).join('');
        if (keep && acc.creds.some((c) => c.id === keep)) q('.es-cred').value = keep;
      }
      q('.es-cred').style.display = acc.creds.length > 1 ? '' : 'none';
      // 还没选: 哪条能用就先替他选上(两条都能用时优先订阅); 选了的那条不能用了也换过去
      if (!chosen || !usable(chosen)) chosen = acc.sub ? 'subscription' : acc.creds.length ? 'api' : chosen;
      ov.querySelectorAll('.es-opt').forEach((o) => o.classList.toggle('on', o.dataset.acc === chosen));
      q('.es-next').disabled = !chosen || !usable(chosen);
      // 引擎: 装了 Claude SDK 才有得选, 只在用 key 时出现(订阅固定走 Claude Code)
      const engines = acc.cc ? ['butler', 'claude-code'] : ['butler'];
      if (q('.es-sdk').dataset.list !== engines.join()) {
        q('.es-sdk').dataset.list = engines.join();
        q('.es-sdk').innerHTML = engines.map((k) => `<option value="${k}">${esc(S[k === 'butler' ? 'mgr_sdk_butler' : 'mgr_sdk_claude_code'] || k)}</option>`).join('');
      }
      q('.es-engine-wrap').style.display = useApi() && acc.cc ? '' : 'none';
      // 只在"接入方式/凭据"真的变了才重拉, 否则轮询会把下拉一直重置
      const key = step === 2 ? `${chosen}:${q('.es-cred').value}` : '';
      if (key && key !== lastKey) { lastKey = key; await refreshModels(); }
    }
    const goStep = async (n) => {
      step = n;
      q('.es-s1').hidden = n !== 1; q('.es-s2').hidden = n !== 2;
      q('.es-step').textContent = `${n} / 2`;
      if (n === 2) { await refresh(); q('.es-name').focus(); q('.es-name').select(); }
    };

    paint();
    await applyDir();
    await refresh();
    ov.querySelectorAll('.es-opt').forEach((o) => o.addEventListener('click', (e) => {
      if (e.target.closest('button,select')) return;
      chosen = o.dataset.acc; refresh();
    }));
    q('.es-cred').addEventListener('change', refresh);
    q('.es-next').addEventListener('click', () => goStep(2));
    q('.es-back').addEventListener('click', () => goStep(1));
    q('.es-model').addEventListener('change', () => {
      const on = q('.es-model').value === MODEL_CUSTOM;
      q('.es-model-manual').style.display = on ? '' : 'none';
      if (on) q('.es-model-custom').focus();
    });
    // 配 key 发生在另一个窗口里, 这边收不到通知 —— 轮询是这里唯一靠得住的办法。
    const timer = setInterval(refresh, 2000);

    q('.es-login').addEventListener('click', async () => {
      chosen = 'subscription';
      q('.es-login').disabled = true;
      try { await window.butler.relogin(); } catch (_) {}
      q('.es-login').disabled = false;
      refresh();
    });
    window.butler.onCcSdkProgress((p) => {
      ccProg = p.step === 'extract' ? st('sys_cc_extracting')
        : st('sys_cc_downloading', { pct: p.step === 'bin' ? 10 + Math.floor(p.pct * 0.9) : Math.floor(p.pct * 0.1) });
      q('.es-cc-state').textContent = ccProg;
    });
    q('.es-cc-on').addEventListener('click', async () => {
      // 文件还留着(之前关过没删)就不用再下载, 也不用再弹条款
      if (!q('.es-cc-on').dataset.installed && !confirm(st('sys_cc_confirm'))) return;
      ccProg = st('sys_cc_downloading', { pct: 0 }); await renderCc();
      const r = await window.butler.ccSdkInstall();
      ccProg = null;
      if (!r || !r.ok) q('.es-note1').textContent = st('sys_cc_failed', { err: (r && r.error) || '' });
      refresh();
    });
    q('.es-cc-relaunch').addEventListener('click', () => window.butler.ccSdkRelaunch());
    q('.es-setkey').addEventListener('click', () => {
      chosen = 'api';
      try { window.butler.openSettingsWindow(); } catch (_) {}
    });
    q('.es-pick').addEventListener('click', async () => {
      try {
        const r = await window.butler.chooseDirectory();
        if (r && r.ok && r.path) { dir = r.path; await applyDir(); }
      } catch (_) {}
    });
    q('.es-create').addEventListener('click', async () => {
      const btn = q('.es-create');
      const name = q('.es-name').value.trim();
      if (!name) { q('.es-note2').textContent = tt('needName'); q('.es-name').focus(); return; }
      // 「跟随默认」和「其它但没填」都算没选: 订阅交给主进程用默认值, key 不许空着
      const mv = q('.es-model').value;
      const model = mv === MODEL_CUSTOM ? (q('.es-model-custom').value.trim() || undefined) : (mv || undefined);
      if (useApi() && !model) { q('.es-note2').textContent = tt('needModel'); return; }
      btn.disabled = true;
      btn.textContent = tt('creating');
      try {
        const r = await window.butler.createPersonaUI({
          name, avatar: avatar || undefined, homeDir: dir || undefined, isButler: true,
          accessMode: useApi() ? 'api' : 'subscription',
          credentialId: useApi() ? (q('.es-cred').value || undefined) : undefined,
          sdk: useApi() ? (q('.es-sdk').value || 'butler') : undefined,
          model,
        });
        if (r && r.ok === false) throw new Error(r.error || '');
        clearInterval(timer);
        location.reload();   // 人格有了, 整个窗口按正常流程重来一遍最省事
        return;
      } catch (e) {
        q('.es-note2').textContent = tt('failed') + String((e && e.message) || e);
      }
      btn.disabled = false;
      btn.textContent = tt('create');
    });
  }

  // renderer.js 在"会话列表为空"那一支调这里。
  window.emptyState = {
    async maybeShow() {
      try {
        const loc = await window.butler.getLocale();
        if (loc && loc.locale && T[loc.locale]) lang = loc.locale;
        S = (loc && loc.strings) || {};
        locales = (loc && loc.locales) || [];
      } catch (_) {}
      await show();
    },
  };
})();
