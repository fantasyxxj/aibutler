// hub-firstrun.js — 装完第一次运行时问一句「要不要连上公网 hub」。
//
// 🔴 只问这一次。问过(申请了 / 说了不用 / 本来就配过 bus)就再也不弹 —— 判据在
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
      title: '要连上公网 hub 吗?',
      lede: '连上之后你的管家就能跟别人的管家互相发消息、传文件。报上你的名字, 对方批准后就开通了。',
      owner: '你的名字(对方靠它认出你, 别人也能按名字找到你)',
      ph: '想用来做什么(选填)',
      needowner: '请填上你自己的名字。',
      go: '申请连接', no: '我不用', close: '知道了',
      sent: '已提交。对方批准之后, 到「人格管理 → 连公网 hub」点一下「检查」就连上了。',
      needname: '这台机器上还没有人格, 先建一个再来连。',
    },
    'zh-TW': {
      title: '要連上公開 hub 嗎?',
      lede: '連上之後你的管家就能跟別人的管家互相傳訊息、傳檔案。報上你的名字, 對方核准後就開通了。',
      owner: '你的名字(對方靠它認出你, 別人也能按名字找到你)',
      ph: '想用來做什麼(選填)',
      needowner: '請填上你自己的名字。',
      go: '申請連線', no: '我不用', close: '知道了',
      sent: '已送出。對方核准之後, 到「人格管理 → 連公開 hub」點一下「檢查」就連上了。',
      needname: '這台機器上還沒有人格, 先建一個再來連。',
    },
    en: {
      title: 'Connect to the public hub?',
      lede: 'Once connected, your butler can exchange messages and files with other people\'s butlers. Tell us your name and it will be enabled once approved.',
      owner: 'Your name (how the approver recognizes you, and how others can find you)',
      ph: 'What you want to use it for (optional)',
      needowner: 'Please enter your own name.',
      go: 'Request access', no: 'No thanks', close: 'Got it',
      sent: 'Request sent. Once approved, open Personas → Connect to the public hub and hit Check.',
      needname: 'No persona on this machine yet — create one first.',
    },
    ja: {
      title: '公開 hub につなぎますか?',
      lede: 'つなぐと、あなたの執事が他の方の執事とメッセージやファイルをやり取りできます。お名前を入れていただければ、承認後に開通します。',
      owner: 'お名前(承認時の確認と、他の方があなたを名前で探すのに使います)',
      ph: '何に使いたいか(任意)',
      needowner: 'ご自身のお名前を入力してください。',
      go: '接続を申請', no: '使いません', close: 'わかりました',
      sent: '申請しました。承認されたら「人格管理 → 公開 hub につなぐ」で「確認」を押してください。',
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
    width:min(460px,86vw); box-shadow:0 16px 48px #000c; }
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
      if (st && st.shouldPrompt) show();
    } catch (_) { /* 问不出来就不问, 别为了一个引导把主界面挡住 */ }
  }

  // show 也挂出去: 这一屏只在全新安装上出现一次, 不挂出来就没法在开发机上验它长什么样。
  window.hubFirstRun = { show, maybeShow };
  window.addEventListener('DOMContentLoaded', maybeShow);
})();
