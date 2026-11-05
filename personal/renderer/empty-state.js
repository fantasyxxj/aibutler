// empty-state.js — 一个人格都没有时的那一屏。
//
// 从前这里是没有界面的: 启动链发现没人格就兜底造一个"管家"塞进去, 哪怕还没接 AI ——
// 于是新用户第一眼看到的是一个不会说话的管家, 而且它的目录已经默默定死了, 想换想迁都不行。
// 作者 2026-09-20 报的后两个问题都长在这上面。现在改成: 没接 AI 就一个都不建, 显示这一屏,
// 让人先把 AI 接上、顺手挑好人格资料放哪, 点了「创建初始人格」才真的建。
//
// 🔴 所有路径都走这一屏, 有没有 AI 只决定那个按钮灰不灰 —— 不给"已登录"开捷径, 否则
// 订阅用户又选不了目录, 那正是要修的第三个问题。
//
// 🔴 它不是浮层而是整屏: 没有人格的时候背后没有任何可看的东西, 给关闭按钮等于让人对着空白。
//
// 单开一个文件: renderer.js / style.css / i18n.js 都撞了行数闸, 所以文案和样式一并自带
// (同 hub-firstrun.js 的做法)。
'use strict';

(() => {
  const T = {
    'zh-CN': {
      title: '还没有人格',
      lede: '人格是替你干活的那个助手。它需要先接上 AI 才能说话。',
      aiOk: '● AI 已就绪',
      aiNo: '○ 还没接上 AI',
      login: '登录 Claude Code', setkey: '在设置里配 Key',
      dirLabel: '人格资料放在', pick: '换个位置',
      create: '创建初始人格', creating: '创建中…',
      hintNo: '接上 AI 之后这个按钮就会亮起来。',
      hintTakeover: '这个目录里已经有人格资料了 —— 点创建就是把它接过来接着用, 不会重新开始。',
      hintInstallRoot: '这个位置在程序的安装目录里, 不能放人格: 每次升级重装都会把它清空, 人格和记忆一起没。换一个位置。',
      failed: '创建失败: ',
      access: '怎么接 AI', accSub: '订阅', accApi: 'API Key',
      credLabel: '用哪把 Key', modelLabel: '模型', modelInherit: '跟随默认',
      modelCustom: '其它(手填)', modelPh: '模型 id', modelLoading: '正在拉清单…', needModel: '用 API Key 要选一个模型 —— 没有能直接用的默认模型。',
      srcLive: '{n} 个 · 刚从 {from} 拉到', srcBuiltin: '{n} 个 · 内置清单',
      needSub: '要先登录', needKey: '要先配 Key',
      whyNow: '这两样在人格出生那一刻就定死了, 建完改要重开标签, 而且它出生时那一整套学习已经用掉了。',
    },
    'zh-TW': {
      title: '還沒有人格',
      lede: '人格是替你做事的那個助理。它需要先接上 AI 才能說話。',
      aiOk: '● AI 已就緒',
      aiNo: '○ 還沒接上 AI',
      login: '登入 Claude Code', setkey: '在設定裡配 Key',
      dirLabel: '人格資料放在', pick: '換個位置',
      create: '建立初始人格', creating: '建立中…',
      hintNo: '接上 AI 之後這個按鈕就會亮起來。',
      hintTakeover: '這個目錄裡已經有人格資料了 —— 點建立就是把它接過來繼續用, 不會重新開始。',
      hintInstallRoot: '這個位置在程式的安裝目錄裡, 不能放人格: 每次升級重裝都會把它清空, 人格和記憶一起不見。換一個位置。',
      failed: '建立失敗: ',
      access: '怎麼接 AI', accSub: '訂閱', accApi: 'API Key',
      credLabel: '用哪把 Key', modelLabel: '模型', modelInherit: '跟隨預設',
      modelCustom: '其他(手填)', modelPh: '模型 id', modelLoading: '正在拉清單…', needModel: '用 API Key 要選一個模型 —— 沒有能直接用的預設模型。',
      srcLive: '{n} 個 · 剛從 {from} 拉到', srcBuiltin: '{n} 個 · 內建清單',
      needSub: '要先登入', needKey: '要先配 Key',
      whyNow: '這兩樣在人格出生那一刻就定死了, 建完再改要重開分頁, 而且它出生時那一整套學習已經用掉了。',
    },
    ja: {
      title: 'まだ人格がありません',
      lede: '人格はあなたの代わりに動くアシスタントです。話すにはまず AI につなぐ必要があります。',
      aiOk: '● AI 準備完了',
      aiNo: '○ AI 未接続',
      login: 'Claude Code にログイン', setkey: '設定で Key を入れる',
      dirLabel: '人格データの保存先', pick: '場所を変える',
      create: '最初の人格を作る', creating: '作成中…',
      hintNo: 'AI につながるとこのボタンが有効になります。',
      hintTakeover: 'このフォルダには既に人格データがあります —— 作成を押すとそれを引き継ぎます。最初からにはなりません。',
      hintInstallRoot: 'この場所はアプリのインストール先の中にあるため、人格を置けません。アップデートのたびに消去され、人格も記憶も一緒に失われます。別の場所を選んでください。',
      failed: '作成に失敗: ',
      access: 'AI への接続方法', accSub: 'サブスク', accApi: 'API Key',
      credLabel: 'どの Key を使うか', modelLabel: 'モデル', modelInherit: '既定に従う',
      modelCustom: 'その他(手入力)', modelPh: 'モデル id', modelLoading: 'リスト取得中…', needModel: 'API Key を使う場合はモデルを選んでください —— そのまま使える既定モデルはありません。',
      srcLive: '{n} 件 · {from} から取得', srcBuiltin: '{n} 件 · 内蔵リスト',
      needSub: '先にログインが必要', needKey: '先に Key の設定が必要',
      whyNow: 'この 2 つは人格が生まれる瞬間に確定します。後から変えるにはタブを開き直す必要があり, 誕生時の学習は既に消費されています。',
    },
    en: {
      title: 'No persona yet',
      lede: 'A persona is the assistant that works for you. It needs an AI connection before it can talk.',
      aiOk: '● AI ready',
      aiNo: '○ AI not connected',
      login: 'Log in to Claude Code', setkey: 'Set a key in Settings',
      dirLabel: 'Persona files go in', pick: 'Change location',
      create: 'Create the first persona', creating: 'Creating…',
      hintNo: 'This button lights up once the AI is connected.',
      hintTakeover: 'This folder already holds persona data — creating will take it over and continue, not start fresh.',
      hintInstallRoot: "This location is inside the app's install folder, so a persona can't live there: every update wipes it and the persona and its memories go with it. Pick another place.",
      failed: 'Create failed: ',
      access: 'How to reach the AI', accSub: 'Subscription', accApi: 'API Key',
      credLabel: 'Which key', modelLabel: 'Model', modelInherit: 'Use default',
      modelCustom: 'Other (type it)', modelPh: 'model id', modelLoading: 'fetching list…', needModel: 'With an API key you need to pick a model — there is no default that works everywhere.',
      srcLive: '{n} · fetched from {from}', srcBuiltin: '{n} · built-in list',
      needSub: 'log in first', needKey: 'set a key first',
      whyNow: 'Both are fixed the moment the persona is born. Changing them later needs a tab reopen, and its one big round of birth learning is already spent.',
    },
  };

  // 颜色一律走主题 token(这 15 个名字之外不自己编色值), 圆角同理。
  // 🔴 给了 background 就必须同时给 color, 否则文字会继承外面的主题色。
  const CSS = `
#emptyState{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;
  background:var(--bg);color:var(--text);padding:24px}
#emptyState .es-card{width:min(520px,92vw);background:var(--panel-2);color:var(--text);
  border:1px solid var(--line);border-radius:var(--radius);padding:26px 28px}
#emptyState h3{margin:0 0 8px;font-size:18px}
#emptyState .es-lede{margin:0 0 20px;color:var(--muted);font-size:13px;line-height:1.6}
#emptyState .es-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
#emptyState .es-ai{font-size:13px;margin-right:4px}
#emptyState .es-ai.ok{color:var(--ok)}
#emptyState .es-ai.no{color:var(--muted)}
#emptyState .es-dir{margin:18px 0 6px;font-size:12px;color:var(--muted)}
#emptyState .es-path{font-size:12px;word-break:break-all;background:var(--field);color:var(--text);
  border:1px solid var(--line);border-radius:var(--radius-sm);padding:7px 9px;flex:1;min-width:200px}
#emptyState button{background:var(--panel);color:var(--text);border:1px solid var(--line);
  border-radius:var(--radius-sm);padding:6px 12px;font-size:12px;cursor:pointer}
#emptyState button:hover:not(:disabled){border-color:var(--brand)}
#emptyState .es-create{width:100%;margin-top:18px;padding:10px;font-size:14px;
  background:var(--brand);border-color:var(--brand);color:var(--text)}
#emptyState button:disabled{opacity:.45;cursor:not-allowed}
#emptyState .es-note{margin-top:10px;font-size:12px;color:var(--muted);line-height:1.5;min-height:1em}
#emptyState .es-field{margin:14px 0 6px;font-size:12px;color:var(--muted)}
#emptyState select,#emptyState input[type=text]{background:var(--field);color:var(--text);
  border:1px solid var(--line);border-radius:var(--radius-sm);padding:6px 8px;font-size:12px;flex:1;min-width:0}
#emptyState label.es-radio{display:inline-flex;align-items:center;gap:5px;font-size:12px;cursor:pointer}
#emptyState label.es-radio.off{opacity:.5;cursor:not-allowed}
#emptyState .es-why{margin-top:14px;font-size:11px;color:var(--muted);line-height:1.5}
#emptyState .es-dir-note{font-size:11px;line-height:1.5;margin:-4px 0 10px;color:var(--muted)}
#emptyState .es-dir-note.bad{color:var(--danger)}
`;

  let lang = 'zh-CN';
  const tt = (k) => (T[lang] || T['zh-CN'])[k] || (T['zh-CN'][k] || '');
  // 「Claude 订阅」那一栏照搬系统设置的区块(cc-sdk-ui.js), 文案也用它那份(i18n-ccsdk.js, 随 getLocale 下发)
  let S = {};
  const st = (k, vars) => String(S[k] || '').replace(/\{(\w+)\}/g, (_, n) => (vars && vars[n] != null ? vars[n] : ''));

  // 有没有 AI: 订阅登录了, 或者凭据仓库里有一把能用的 key。两条通路缺一不可 ——
  // 只认订阅会把"只用 key"的用户永远卡在灰按钮上。
  // 🔴 回的是两条通路各自的状态, 不是一个合并的布尔 —— 要让人在订阅和 key 之间选, 就必须
  //    分别知道哪条能用: 合并成"能不能用"之后, 界面画不出"这条可以、那条要先登录"。
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
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let _opts = [], _src = null;
  async function loadModels(useApi, credentialId) {
    try {
      const r = await window.butler.listModelOptions({ useApi: !!useApi, credentialId: credentialId || '' });
      _opts = (r && r.options) || []; _src = r || null;
    } catch (_) { _opts = []; _src = null; }
  }
  // 末尾必须留「其它」手输: 第三方网关的模型名千奇百怪, 清单拉不回来也得能建人格。
  // ⚠️ 清单自己可能就带一条空 id 的「跟随默认」(订阅走内置清单时就是), 再补一条会出现两个一模一样的选项。
  //    它带的那条 label 是主进程给的中文, 这里统一换成本地化文案, 否则日/英界面上会冒出一行中文。
  // 🔴 用 API key 时没有「跟随默认」(作者 2026-11-05): 只有订阅走 Claude Code 才有它自带的默认模型,
  //    key 人格留空, Butler 引擎第一句就报 no model configured。这时默认选中清单第一个。
  function modelHtml(cur, needModel) {
    const text = (o) => (!o.id || String(o.label || '').includes(o.id)) ? (o.label || o.id) : `${o.label || o.id} — ${o.id}`;
    const opts = needModel ? _opts.filter((o) => o.id) : _opts;
    if (needModel && !cur && opts.length) cur = opts[0].id;
    const rows = needModel || opts.some((o) => !o.id) ? []
      : [`<option value=""${cur ? '' : ' selected'}>${esc(tt('modelInherit'))}</option>`];
    rows.push(...opts.map((o) => `<option value="${esc(o.id)}"${o.id === cur ? ' selected' : ''}>${esc(o.id ? text(o) : tt('modelInherit'))}</option>`));
    rows.push(`<option value="${MODEL_CUSTOM}">${esc(tt('modelCustom'))}</option>`);
    return rows.join('');
  }
  const srcNote = () => (!_src ? ''
    : tt(_src.source === 'live' ? 'srcLive' : 'srcBuiltin').replace('{n}', _opts.length).replace('{from}', _src.from || ''));

  async function show() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    let dir = '';
    try { dir = (await window.butler.defaultPersonaDir()) || ''; } catch (_) {}

    const ov = document.createElement('div');
    ov.id = 'emptyState';
    ov.innerHTML = `<div class="es-card">
      <h3></h3>
      <p class="es-lede"></p>
      <div class="es-row">
        <span class="es-ai"></span>
        <span style="flex:1"></span>
        <button class="es-login"></button>
        <button class="es-setkey"></button>
      </div>
      <div class="es-cc" style="display:none">
        <div class="es-field es-cc-label"></div>
        <div class="es-row"><span class="es-cc-state" style="flex:1;font-size:12px"></span>
          <button class="es-cc-on"></button><button class="es-cc-relaunch"></button></div>
        <div class="es-cc-hint" style="font-size:11px;color:var(--muted);line-height:1.5"></div>
      </div>
      <div class="es-field es-acc-label"></div>
      <div class="es-row es-acc-row">
        <label class="es-radio"><input type="radio" name="es-acc" value="subscription"><span class="es-acc-sub"></span></label>
        <label class="es-radio"><input type="radio" name="es-acc" value="api"><span class="es-acc-api"></span></label>
      </div>
      <div class="es-row es-cred-row" style="display:none"><select class="es-cred"></select><select class="es-sdk"></select></div>
      <div class="es-field es-model-label"></div>
      <div class="es-row"><select class="es-model"></select></div>
      <div class="es-row es-model-manual" style="display:none"><input type="text" class="es-model-custom"></div>
      <div class="es-note es-model-src"></div>
      <div class="es-dir"></div>
      <div class="es-row">
        <span class="es-path"></span>
        <button class="es-pick"></button>
      </div>
      <div class="es-dir-note"></div>
      <button class="es-create"></button>
      <div class="es-note"></div>
      <div class="es-why"></div>
    </div>`;
    const q = (s) => ov.querySelector(s);
    q('h3').textContent = tt('title');
    q('.es-lede').textContent = tt('lede');
    q('.es-login').textContent = tt('login');
    q('.es-setkey').textContent = tt('setkey');
    q('.es-dir').textContent = tt('dirLabel');
    q('.es-pick').textContent = tt('pick');
    q('.es-create').textContent = tt('create');
    q('.es-path').textContent = dir;
    q('.es-acc-label').textContent = tt('access');
    q('.es-model-label').textContent = tt('modelLabel');
    q('.es-model-custom').placeholder = tt('modelPh');
    q('.es-why').textContent = tt('whyNow');
    q('.es-cc-label').textContent = st('sys_cc');
    q('.es-cc-hint').textContent = st('sys_cc_hint');
    q('.es-cc-on').textContent = st('sys_cc_on');
    q('.es-cc-relaunch').textContent = st('sys_cc_relaunch');
    document.body.appendChild(ov);

    // 目录一落定就探一次(打开这一屏也算): 登记簿丢了而人格目录还在时, 默认那个路径本身
    // 就已经住着人 —— 不探的话用户看到的仍是一句"创建", 心里以为要从零开始。
    const applyDir = async () => {
      q('.es-path').textContent = dir;
      let r = null;
      try { r = await window.butler.probePersonaDir(dir); } catch (_) {}
      dirUnsafe = !!(r && r.unsafe);
      const n = q('.es-dir-note');
      n.textContent = dirUnsafe ? tt('hintInstallRoot') : (r && r.inhabited ? tt('hintTakeover') : '');
      n.classList.toggle('bad', dirUnsafe);
      await refresh();
    };

    const accRadios = () => [...ov.querySelectorAll('input[name=es-acc]')];
    const pickedAcc = () => (accRadios().find((r) => r.checked) || {}).value || '';
    const useApi = () => pickedAcc() === 'api';

    // 接入方式或凭据一变, 模型清单就得重拉 —— 两个网关能开的模型根本不是一回事,
    // 不重拉的话下拉里留着上一条的清单, 选出来的模型在新端点上根本不存在。
    // 🔴 拉清单要走网络, 这中间下拉里摆着的还是**上一个端点**的清单。不锁住的话人就会选中
    //    一个新端点根本不认识的模型, 建出来的人格第一句话就是 400 unknown provider。
    //    序号是防连切: 快速换两次凭据时先发的可能后回, 拿它的结果覆盖会让清单和凭据对不上。
    let modelsSeq = 0;
    async function refreshModels() {
      const seq = ++modelsSeq;
      const sel = q('.es-model');
      sel.disabled = true;
      sel.innerHTML = `<option value="">${esc(tt('modelLoading'))}</option>`;
      q('.es-model-src').textContent = '';
      await loadModels(useApi(), q('.es-cred').value);
      if (seq !== modelsSeq) return;            // 已经有更新的一次在跑, 这次的结果作废
      sel.innerHTML = modelHtml('', useApi());
      sel.disabled = false;
      q('.es-model-src').textContent = srcNote();
      // 清单空着(拉不到)而又必须选: 直接落到手填
      const manual = sel.value === MODEL_CUSTOM;
      q('.es-model-manual').style.display = manual ? '' : 'none';
      q('.es-model-custom').value = '';
    }

    let ready = false, acc = null, lastKey = '', lastCredSig = '', dirUnsafe = false, ccProg = null;
    // 开源包这次启动没加载 Claude SDK: 跟系统设置一样, 开启 → 下载 → 重启; 重启后上面的登录按钮接手
    async function renderCc() {
      let s = null;
      try { s = await window.butler.ccSdkStatus(); } catch (_) {}
      const show = !!(s && s.applicable) && !acc.cc;
      q('.es-cc').style.display = show ? '' : 'none';
      if (!show) return;
      let key = null, btn = null;
      if (!(s.installing || ccProg)) {
        if (s.enabled) { key = 'sys_cc_need_relaunch'; btn = '.es-cc-relaunch'; }
        else { key = s.installed ? 'sys_cc_state_off_kept' : 'sys_cc_state_off'; btn = '.es-cc-on'; }
      }
      q('.es-cc-state').textContent = key ? st(key, { version: s.version }) : (ccProg || st('sys_cc_downloading', { pct: 0 }));
      for (const b of ['.es-cc-on', '.es-cc-relaunch']) q(b).style.display = b === btn ? '' : 'none';
      q('.es-cc-on').dataset.installed = s.installed ? '1' : '';
    }
    async function refresh() {
      acc = await probeAccess();
      await renderCc();
      ready = acc.sub || acc.creds.length > 0;
      const ai = q('.es-ai');
      ai.textContent = ready ? tt('aiOk') : tt('aiNo');
      ai.className = 'es-ai ' + (ready ? 'ok' : 'no');
      // 🔴 就绪了也不藏这两个入口: 有 key 不等于不想走订阅, 藏掉就等于替人做了选择。
      // 没装 CC(开源下载版): 订阅这条路根本不存在, 登录按钮和订阅单选都不出现, 只剩配 key
      q('.es-login').style.display = acc.sub || !acc.cc ? 'none' : '';
      q('.es-setkey').style.display = '';
      q('.es-create').disabled = !ready || dirUnsafe;
      if (!ready) q('.es-note').textContent = tt('hintNo');
      else if (q('.es-note').textContent === tt('hintNo')) q('.es-note').textContent = '';

      const [rSub, rApi] = accRadios();
      rSub.disabled = !acc.sub; rApi.disabled = !acc.creds.length;
      rSub.closest('label').classList.toggle('off', !acc.sub);
      rSub.closest('label').style.display = acc.cc ? '' : 'none';
      rApi.closest('label').classList.toggle('off', !acc.creds.length);
      q('.es-acc-sub').textContent = tt('accSub') + (acc.sub ? '' : ` (${tt('needSub')})`);
      q('.es-acc-api').textContent = tt('accApi') + (acc.creds.length ? '' : ` (${tt('needKey')})`);
      if (!pickedAcc() || (useApi() && !acc.creds.length) || (!useApi() && !acc.sub)) {
        if (acc.sub) rSub.checked = true; else if (acc.creds.length) rApi.checked = true;
      }
      // 🔴 只在凭据名单真的变了才重建下拉。无条件重建的话, 这个 2 秒一次的轮询会把人刚选的
      //    那条冲回默认 —— 表现就是"选了也没用, 一直是默认"。重建时也要把当前选中的那条保住。
      const sig = acc.creds.map((c) => c.id).join(',') + '|' + acc.defCred;
      if (sig !== lastCredSig) {
        lastCredSig = sig;
        const keep = q('.es-cred').value;
        q('.es-cred').innerHTML = acc.creds.map((c) =>
          `<option value="${esc(c.id)}"${c.id === acc.defCred ? ' selected' : ''}>${esc(c.name || c.id)}</option>`).join('');
        if (keep && acc.creds.some((c) => c.id === keep)) q('.es-cred').value = keep;
      }
      q('.es-cred-row').style.display = useApi() && acc.creds.length ? '' : 'none';
      // 引擎: 装了 Claude SDK 才有得选, 建人格时写死(没装就只有 Butler 引擎)
      const engines = acc.cc ? ['claude-code', 'butler'] : ['butler'];
      if (q('.es-sdk').dataset.list !== engines.join()) {
        q('.es-sdk').dataset.list = engines.join();
        q('.es-sdk').innerHTML = engines.map((k) => `<option value="${k}">${esc(S[k === 'butler' ? 'mgr_sdk_butler' : 'mgr_sdk_claude_code'] || k)}</option>`).join('');
      }
      q('.es-sdk').style.display = acc.cc ? '' : 'none';
      q('.es-acc-row').style.display = ready ? '' : 'none';
      q('.es-model-label').style.display = ready ? '' : 'none';
      q('.es-model').parentElement.style.display = ready ? '' : 'none';
      // 只在"接入方式/凭据"真的变了才重拉, 否则 2 秒一次的轮询会把下拉一直重置, 选完就被冲掉。
      const key = ready ? `${pickedAcc()}:${q('.es-cred').value}` : '';
      if (key !== lastKey) { lastKey = key; if (ready) await refreshModels(); }
    }
    await applyDir();   // 它自己会调 refresh —— 默认目录也要探, 那正是登记簿丢了的场景
    accRadios().forEach((r) => r.addEventListener('change', refresh));
    q('.es-cred').addEventListener('change', refresh);
    q('.es-model').addEventListener('change', () => {
      const on = q('.es-model').value === MODEL_CUSTOM;
      q('.es-model-manual').style.display = on ? '' : 'none';
      if (on) q('.es-model-custom').focus();
    });
    // 配 key 发生在另一个窗口里, 这边收不到通知 —— 轮询是这里唯一靠得住的办法。
    const timer = setInterval(refresh, 2000);

    q('.es-login').addEventListener('click', async () => {
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
      if (!r || !r.ok) q('.es-note').textContent = st('sys_cc_failed', { err: (r && r.error) || '' });
      refresh();
    });
    q('.es-cc-relaunch').addEventListener('click', () => window.butler.ccSdkRelaunch());
    q('.es-setkey').addEventListener('click', () => {
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
      // 「跟随默认」和「其它但没填」都算没选: 订阅交给主进程用默认值, key 不许空着
      const mv = q('.es-model').value;
      const model = mv === MODEL_CUSTOM ? (q('.es-model-custom').value.trim() || undefined) : (mv || undefined);
      if (useApi() && !model) { q('.es-note').textContent = tt('needModel'); return; }
      btn.disabled = true;
      btn.textContent = tt('creating');
      try {
        const r = await window.butler.createPersonaUI({
          name: '管家', homeDir: dir || undefined, isButler: true,
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
        q('.es-note').textContent = tt('failed') + String((e && e.message) || e);
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
      } catch (_) {}
      await show();
    },
  };
})();
