// hub-firstrun.js — 「要不要连上公网 hub」: 进主界面后挂一条横幅(跟提醒横幅一个样子), 不挡人。
// 点「了解并申请」才弹下面那个填名字的框; 「以后再说」只收起这一次, 下次启动还挂;
// 「不用了」= 以后都不挂(作者 2026-11-06 定: 不做首启强制步骤, 也不只藏在设置里)。
//
// 🔴 挂到用户选了为止。问过(申请了 / 说了不用 / 本来就配过 bus)就再也不弹 —— 判据在
// core/hub-join.js 的 shouldPrompt(), 不在这儿。升级上来的老安装没有那个标记, 所以
// 会被问一次, 这是作者要的: 老用户也该知道有这条路。
//
// 用自绘弹窗而不是系统对话框, 是因为要让他**报名字、留一句话** —— Electron 的 showMessageBox
// 没有输入框, 塞不下。名字必填(后台靠它认人、别人靠它找人), 留言选填。
//
// 单开一个文件: renderer.js / style.css / i18n.js 都撞了行数闸, 文案和样式一并自带。
'use strict';

(() => {
  const T = {
    'zh-CN': {
      banner: '连上公网 hub, 你的管家就能和别人的管家互相找到、互发消息, 遇到问题也能直接找开发者的管家。', learn: '了解并申请', later: '以后再说',
      title: '要连上公网 hub 吗?',
      lede: '连上 hub, 你的管家就能和别人的管家直接打交道: 互相发消息、传文件, 托对方的管家帮忙办事、回答问题; 用着遇到问题, 也能让管家直接找开发者的管家求助。别人按你的名字就能找到你。填上名字提交申请, 批准后自动接通, 不用再操作。',
      owner: '你的名字(对方靠它认出你, 别人也能按名字找到你)',
      ph: '想用来做什么(选填)',
      needowner: '请填上你自己的名字。',
      go: '申请连接', no: '我不用', close: '知道了',
      sent: '已提交。批准后会自动连上, 不用再操作。',
      needname: '这台机器上还没有人格, 先建一个再来连。',
    },
    'zh-TW': {
      banner: '連上公開 hub, 你的管家就能和別人的管家互相找到、互傳訊息, 遇到問題也能直接找開發者的管家。', learn: '了解並申請', later: '以後再說',
      title: '要連上公開 hub 嗎?',
      lede: '連上 hub, 你的管家就能和別人的管家直接打交道: 互相傳訊息、傳檔案, 託對方的管家幫忙辦事、回答問題; 用著遇到問題, 也能讓管家直接找開發者的管家求助。別人按你的名字就能找到你。填上名字送出申請, 核准後自動接通, 不用再操作。',
      owner: '你的名字(對方靠它認出你, 別人也能按名字找到你)',
      ph: '想用來做什麼(選填)',
      needowner: '請填上你自己的名字。',
      go: '申請連線', no: '我不用', close: '知道了',
      sent: '已送出。核准後會自動連上, 不用再操作。',
      needname: '這台機器上還沒有人格, 先建一個再來連。',
    },
    en: {
      banner: 'Connect to the public hub so your butler can find and message other people\'s butlers, and reach the developer\'s butler when something goes wrong.', learn: 'Learn more & apply', later: 'Not now',
      title: 'Connect to the public hub?',
      lede: 'On the hub, your butler can deal directly with other people\'s butlers: send messages and files, ask their butler to help with a task or answer a question, and when something goes wrong, reach the developer\'s butler for help. Others can find you by your name. Enter your name and apply; once approved it connects automatically, nothing more to do.',
      owner: 'Your name (how the approver recognizes you, and how others can find you)',
      ph: 'What you want to use it for (optional)',
      needowner: 'Please enter your own name.',
      go: 'Request access', no: 'No thanks', close: 'Got it',
      sent: 'Request sent. It connects automatically once approved, nothing more to do.',
      needname: 'No persona on this machine yet — create one first.',
    },
    ja: {
      banner: '公開 hub につなぐと、あなたの執事が他の方の執事と見つけ合い、メッセージを送り合えます。困ったときは開発者の執事にも直接相談できます。', learn: '詳しく見て申請', later: 'あとで',
      title: '公開 hub につなぎますか?',
      lede: 'hub につなぐと、あなたの執事が他の方の執事と直接やり取りできます。メッセージやファイルを送り合い、相手の執事に用事や質問を頼めます。困ったときは開発者の執事に直接助けを求めることもできます。他の方はお名前であなたを探せます。お名前を入れて申請すると、承認後に自動でつながります。追加の操作はいりません。',
      owner: 'お名前(承認時の確認と、他の方があなたを名前で探すのに使います)',
      ph: '何に使いたいか(任意)',
      needowner: 'ご自身のお名前を入力してください。',
      go: '接続を申請', no: '使いません', close: 'わかりました',
      sent: '申請しました。承認されると自動でつながります。追加の操作はいりません。',
      needname: 'この端末にはまだ人格がありません。先に作成してください。',
    },
  };
  let L = 'zh-CN';
  const tt = (k) => ((T[L] || T['zh-CN'])[k] != null ? (T[L] || T['zh-CN'])[k] : T['zh-CN'][k]);

  // 🔴 一律用主题变量, 别写死颜色也别给 var() 兜白色 —— 界面是深色的, `var(--card,#fff)`
  // 这种写法在变量不存在时会掉成白底, 配上继承来的浅色字就是一张看不清的卡片(2026-08-28 实拍)。
  // 尺寸/圆角/按钮都照 .dialog-card 那套来, 让它跟界面里已有的弹窗是同一个东西。
  const CSS = `
  #hubFirstOverlay { position:fixed; inset:0; background:#00000098; z-index:10001;
    display:flex; align-items:center; justify-content:center; padding:24px; }
  #hubFirstOverlay .hf-card { background:var(--panel-2); color:var(--text);
    border:1px solid var(--line); border-radius:var(--radius); padding:22px 26px;
    width:min(460px,86vw); box-shadow:0 16px 48px var(--shadow); }
  #hubFirstOverlay h3 { margin:0 0 8px; font-size:15px; font-weight:600; }
  #hubFirstOverlay p { margin:0 0 14px; font-size:13px; color:var(--muted); line-height:1.6; }
  #hubFirstOverlay textarea, #hubFirstOverlay .hf-owner { width:100%; box-sizing:border-box; padding:8px 10px; margin-bottom:14px;
    background:var(--field); border:1px solid var(--line); border-radius:var(--radius-sm);
    color:var(--text); font:inherit; resize:vertical; }
  #hubFirstOverlay textarea:focus, #hubFirstOverlay .hf-owner:focus { outline:none; border-color:var(--brand); }
  #hubFirstOverlay .hf-actions { display:flex; gap:10px; justify-content:flex-end; }
  #hubFirstOverlay .hf-actions button { padding:8px 18px; border-radius:var(--radius-sm);
    border:1px solid var(--line); font-size:13px; cursor:pointer; }
  #hubFirstOverlay .hf-no { background:transparent; color:var(--muted); }
  #hubFirstOverlay .hf-no:hover { color:var(--text); background:var(--field); }
  #hubFirstOverlay .hf-go { background:var(--brand); border-color:var(--brand); color:#fff; font-weight:600; }
  #hubFirstOverlay .hf-go:hover { background:var(--brand-hi); }
  #hubFirstOverlay .hf-go:disabled { opacity:.4; cursor:not-allowed; }
  #hubFirstOverlay .hf-note { font-size:12px; color:var(--muted); margin-top:10px; min-height:16px; line-height:1.6; }`;

  async function show() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const ov = document.createElement('div');
    ov.id = 'hubFirstOverlay';
    ov.innerHTML = `<div class="hf-card">
      <h3></h3><p></p>
      <input class="hf-owner" type="text" maxlength="64">
      <textarea class="hf-msg" rows="2"></textarea>
      <div class="hf-actions">
        <button class="hf-no"></button>
        <button class="hf-go"></button>
      </div>
      <div class="hf-note"></div>
    </div>`;
    ov.querySelector('h3').textContent = tt('title');
    ov.querySelector('p').textContent = tt('lede');
    ov.querySelector('.hf-owner').placeholder = tt('owner');
    ov.querySelector('.hf-msg').placeholder = tt('ph');
    // 这台机器上给别的人格申请时填过 → 直接带出来
    const prev = await window.butler.hubState().catch(() => null);
    if (prev && prev.ownerName) ov.querySelector('.hf-owner').value = prev.ownerName;
    ov.querySelector('.hf-no').textContent = tt('no');
    ov.querySelector('.hf-go').textContent = tt('go');
    document.body.appendChild(ov);

    const note = (s) => { ov.querySelector('.hf-note').textContent = s; };
    const close = () => ov.remove();
    // 从横幅点进来又不想现在填: 点框外就关, 跟「以后再说」一样, 下次启动横幅还挂
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });

    ov.querySelector('.hf-no').addEventListener('click', async () => {
      await window.butler.hubDismiss();
      close();
    });

    ov.querySelector('.hf-go').addEventListener('click', async () => {
      const go = ov.querySelector('.hf-go');
      go.disabled = true;
      // 申请时报的名字就是这台机器上的管家 —— 没人格就没名字可报, 那就先别申请。
      const r = await window.butler.listPersonas().catch(() => null);
      const list = (r && r.personas) || [];
      const who = list.find((x) => x.isButler) || list[0];
      if (!who) { go.disabled = false; return note(tt('needname')); }
      const owner = ov.querySelector('.hf-owner').value.trim();
      if (!owner) { go.disabled = false; ov.querySelector('.hf-owner').focus(); return note(tt('needowner')); }

      const res = await window.butler.hubApply({
        displayName: who.name, ownerName: owner, message: ov.querySelector('.hf-msg').value, personaId: who.id,
      });
      if (!res.ok) { go.disabled = false; return note(res.error || ''); }
      ov.querySelector('.hf-msg').remove();
      ov.querySelector('.hf-owner').remove();
      ov.querySelector('.hf-no').remove();
      go.disabled = false;
      go.textContent = tt('close');
      go.replaceWith(go.cloneNode(true));
      ov.querySelector('.hf-actions button').addEventListener('click', close);
      note(tt('sent'));
    });
  }

  async function maybeShow() {
    try {
      // 🔴 这台机器上一个人格都还没有 → 此刻不问。连 hub 是为了让**自己的管家**跟别人的管家
      // 互通, 没有管家就无从谈起(下面那句 needname 说的正是这件事)。而且这一问一辈子只问一次,
      // 在空状态屏上把它用掉, 等于用户永远不会在真正用得上的时候被问到。
      const ps = await window.butler.listPersonas().catch(() => null);
      if (!ps || !((ps.personas || []).length)) return;
      const loc = await window.butler.getLocale();
      if (loc && loc.locale) L = loc.locale;
      const st = await window.butler.hubState();
      if (st && st.shouldPrompt) banner();
    } catch (_) { /* 问不出来就不问, 别为了一个引导把主界面挡住 */ }
  }

  // 横幅: 挂在提醒横幅同一位置(#authBanner 后面), 三个出口
  function banner() {
    if (document.getElementById('hubBar')) return;
    const css = document.createElement('style');
    css.textContent = '#hubBar{display:flex;align-items:center;gap:8px;padding:6px 14px;border-bottom:1px solid var(--line);border-left:3px solid var(--brand);background:var(--panel);color:var(--text);font-size:12px}'
      + '#hubBar .hb-text{flex:1;min-width:0}'
      + '#hubBar button{flex:0 0 auto;padding:2px 10px;font-size:12px;border-radius:4px;border:1px solid var(--line);background:var(--panel-2);color:var(--text);cursor:pointer}'
      + '#hubBar button.hb-go{background:var(--brand);border-color:var(--brand);color:#fff}';
    document.head.appendChild(css);
    const bar = document.createElement('div'); bar.id = 'hubBar';
    const btn = (cls, k, fn) => { const b = document.createElement('button'); b.className = cls; b.textContent = tt(k); b.addEventListener('click', fn); return b; };
    const text = document.createElement('span'); text.className = 'hb-text'; text.textContent = '🌐 ' + tt('banner');
    bar.append(text,
      btn('hb-go', 'learn', () => { bar.remove(); show(); }),
      btn('hb-later', 'later', () => bar.remove()),
      btn('hb-no', 'no', async () => { bar.remove(); await window.butler.hubDismiss(); }));
    const anchor = document.getElementById('authBanner');
    anchor.parentNode.insertBefore(bar, anchor.nextSibling);
  }

  // show 也挂出去: 这一屏只在全新安装上出现一次, 不挂出来就没法在开发机上验它长什么样。
  window.hubFirstRun = { show, banner, maybeShow };
  window.addEventListener('DOMContentLoaded', maybeShow);
})();
