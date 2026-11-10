// tips.js — 打开 app 时在主窗口里弹一张「小贴士」: 一张小图 + 一条用法 + 一句可以直接问的话。
// 每页底下都有同一句「有疑问、不会用, 别犹豫, 直接问你的人格」—— 这是整个产品的入口, 别的条目只是举例
// (作者 2026-11-10 定)。第一次固定出第 1 条, 之后每次随机一条; 下一条 / 关闭 / 以后不再显示。
// 「以后不再显示」存 settings.json 的 hideTips, 系统设置「通用」里能再打开, 也能当场叫出一张(tips-show)。
//
// 🔴 没人格不弹: 那时显示的是空状态屏, 背后没东西可看。空状态屏建完人格会整页 reload, 这里自然再跑一遍。
// 🔴 纯界面, 不碰人格: 「试试」只把那句话填进输入框, 发不发由用户决定, 一个 token 都不花。
//
// 单开一个文件: renderer.js / style.css / i18n.js 都撞了行数闸, 文案、样式、插画一并自带。
'use strict';

(() => {
  // 插画: 线条用主题主色、点缀用 --accent、色块用主色淡底, 深浅主题自动跟着变(class 见 CSS)
  const ART = [
    '<rect class="s" x="12" y="12" width="58" height="36" rx="10"/><path class="s" d="M24 48l-6 10 14-10"/><path class="a" d="M34 24q7-7 14 0q4 6-4 10q-3 2-3 5"/><circle class="t" cx="41" cy="43" r="2.2"/><rect class="s" x="52" y="40" width="56" height="32" rx="10"/><path class="s" d="M96 72l6 9-14-9"/><path class="m" d="M63 52h34M63 61h22"/>',
    '<rect class="s" x="16" y="14" width="72" height="58" rx="8"/><path class="s" d="M16 28h72"/><circle class="t" cx="24" cy="21" r="2"/><circle class="t" cx="31" cy="21" r="2"/><rect class="f" x="24" y="36" width="22" height="13" rx="3"/><rect class="f" x="52" y="36" width="28" height="13" rx="3"/><rect class="f" x="24" y="54" width="56" height="10" rx="3"/><path class="a" d="M102 14v16M94 22h16"/>',
    '<rect class="s" x="38" y="8" width="42" height="74" rx="8"/><path class="s" d="M52 16h14"/><circle class="t" cx="59" cy="74" r="2.5"/><rect class="f" x="44" y="26" width="26" height="11" rx="4"/><rect class="f" x="48" y="43" width="26" height="11" rx="4"/><path class="a" d="M88 30q8 11 0 22M97 24q14 17 0 34"/>',
    '<circle class="s" cx="60" cy="47" r="30"/><path class="s" d="M60 47V28M60 47l14 8"/><path class="a" d="M86 18q8-8 15 0M34 18q-8-8-15 0"/><circle class="t" cx="60" cy="47" r="3"/>',
    '<rect class="s" x="30" y="12" width="56" height="68" rx="6"/><path class="s" d="M42 12v68"/><path class="m" d="M50 30h26M50 42h26M50 54h16"/><path class="a" d="M82 62l7 7 14-16"/>',
    '<circle class="s" cx="30" cy="34" r="10"/><path class="s" d="M14 72q16-24 32 0"/><circle class="a" cx="60" cy="28" r="11"/><path class="a" d="M42 70q18-26 36 0"/><circle class="s" cx="90" cy="34" r="10"/><path class="s" d="M74 72q16-24 32 0"/><path class="m" d="M42 32h6M72 32h6"/>',
    '<rect class="s" x="12" y="22" width="40" height="40" rx="8"/><rect class="f" x="20" y="30" width="24" height="24" rx="4"/><rect class="s" x="68" y="30" width="40" height="40" rx="8"/><rect class="f" x="76" y="38" width="24" height="24" rx="4"/><path class="a" d="M56 36h10l-4-4M64 58H54l4 4"/>',
    '<path class="s" d="M12 74h58"/><rect class="f" x="18" y="46" width="11" height="28"/><rect class="f" x="35" y="30" width="11" height="44"/><rect class="f" x="52" y="54" width="11" height="20"/><path class="s" d="M18 74V46h11v28M35 74V30h11v44M52 74V54h11v20"/><circle class="s" cx="92" cy="46" r="19"/><path class="a" d="M92 46V27M92 46l17 8"/>',
  ];

  const T = {
    'zh-CN': {
      tips: [
        ['随时都能问', '怎么用某个功能、哪里出了错、想做件事不知道从哪下手, 都可以直接跟它说, 它会一步步带你。', '你能帮我做些什么?'],
        ['让它给你做个小工具', '说一句需求, 它就能做个插件装进管家, 以后打开就能用。', '给我做个记账的小工具'],
        ['手机上也能找它', '接上 Telegram、飞书、钉钉、Discord 或 Slack, 人不在电脑前也能跟它聊。', '帮我把你接到 Telegram 上'],
        ['到点提醒你', '说好时间, 到点它会主动来找你。', '明天早上 9 点提醒我交报告'],
        ['它会记住你', '你说过的偏好和事情它都记着, 换个对话也不会忘。', '记住, 我不吃香菜'],
        ['多建几个人格', '各管一摊, 还能互相帮忙; 人格也可以导出送给别人。', '怎么再建一个人格?'],
        ['换个模型用', '在系统设置里存好 Key, 每个人格都能选自己的模型。', '你现在用的是什么模型?'],
        ['不只是文字', '表格、图表、流程图、表单按钮, 它都能直接画在聊天里。', '画一张流程图, 讲讲怎么泡一杯手冲咖啡'],
      ],
      ask: '有疑问、不会用, 别犹豫, 直接问你的人格。', tryIt: '试试: ', next: '下一条', close: '关闭', never: '以后不再显示',
    },
    'zh-TW': {
      tips: [
        ['隨時都能問', '怎麼用某個功能、哪裡出了錯、想做件事不知道從哪下手, 都可以直接跟它說, 它會一步步帶你。', '你能幫我做些什麼?'],
        ['讓它幫你做個小工具', '說一句需求, 它就能做個外掛裝進管家, 以後打開就能用。', '幫我做個記帳的小工具'],
        ['手機上也能找它', '接上 Telegram、飛書、釘釘、Discord 或 Slack, 人不在電腦前也能跟它聊。', '幫我把你接到 Telegram 上'],
        ['到點提醒你', '說好時間, 到點它會主動來找你。', '明天早上 9 點提醒我交報告'],
        ['它會記住你', '你說過的偏好和事情它都記著, 換個對話也不會忘。', '記住, 我不吃香菜'],
        ['多建幾個人格', '各管一攤, 還能互相幫忙; 人格也可以匯出送給別人。', '怎麼再建一個人格?'],
        ['換個模型用', '在系統設定裡存好 Key, 每個人格都能選自己的模型。', '你現在用的是什麼模型?'],
        ['不只是文字', '表格、圖表、流程圖、表單按鈕, 它都能直接畫在聊天裡。', '畫一張流程圖, 講講怎麼沖一杯手沖咖啡'],
      ],
      ask: '有疑問、不會用, 別猶豫, 直接問你的人格。', tryIt: '試試: ', next: '下一則', close: '關閉', never: '以後不再顯示',
    },
    en: {
      tips: [
        ['Ask it anything, anytime', 'How a feature works, what went wrong, where to start on something new: just tell it, and it will walk you through.', 'What can you help me with?'],
        ['Have it build you a tool', 'Describe what you need and it builds a plugin that stays in your butler for next time.', 'Build me a simple expense tracker'],
        ['Reach it from your phone', 'Connect Telegram, Feishu, DingTalk, Discord or Slack and keep talking when you are away from the computer.', 'Help me connect you to Telegram'],
        ['Reminders on time', 'Tell it when, and it will come to you at that moment.', 'Remind me to send the report at 9 tomorrow morning'],
        ['It remembers you', 'Your preferences and the things you tell it stay with it, even in a new conversation.', 'Remember: I don\'t eat cilantro'],
        ['More than one persona', 'Give each one its own job; they can help each other, and you can export one to share.', 'How do I create another persona?'],
        ['Switch models', 'Save a key in System Settings and each persona can use its own model.', 'Which model are you running on?'],
        ['More than text', 'Tables, charts, flowcharts, forms and buttons: it draws them right in the chat.', 'Draw a flowchart of how to make pour-over coffee'],
      ],
      ask: 'Stuck or unsure how something works? Don\'t hesitate, just ask your persona.', tryIt: 'Try: ', next: 'Next tip', close: 'Close', never: 'Don\'t show again',
    },
    ja: {
      tips: [
        ['いつでも聞けます', '機能の使い方、うまくいかない理由、何から始めればいいか。そのまま話しかければ、一歩ずつ案内します。', '何を手伝ってもらえる?'],
        ['小さなツールを作ってもらう', 'やりたいことを一言伝えるだけで、プラグインを作って執事に入れてくれます。次からすぐ使えます。', '家計簿の小さなツールを作って'],
        ['スマホからも話せます', 'Telegram、Feishu、DingTalk、Discord、Slack につなげば、パソコンの前にいなくても話せます。', 'Telegram につないで'],
        ['時間になったら知らせます', '時間を伝えておけば、その時刻に向こうから声をかけます。', '明日の朝 9 時にレポート提出をリマインドして'],
        ['あなたのことを覚えます', '好みや話したことは覚えていて、新しい会話になっても忘れません。', '覚えておいて、パクチーは食べない'],
        ['人格を何人か作る', 'それぞれに役割を任せられ、互いに助け合えます。人格は書き出して人に渡すこともできます。', '人格をもう一人作るにはどうする?'],
        ['モデルを切り替える', 'システム設定でキーを保存すれば、人格ごとに好きなモデルを選べます。', '今どのモデルで動いてる?'],
        ['文字だけではありません', '表、グラフ、フローチャート、フォームやボタンも、チャットの中に直接描けます。', 'ハンドドリップコーヒーの淹れ方をフローチャートで描いて'],
      ],
      ask: 'わからないこと、困ったことがあれば、遠慮なくあなたの人格に聞いてください。', tryIt: '試す: ', next: '次のヒント', close: '閉じる', never: '今後表示しない',
    },
  };
  let L = 'zh-CN';
  const pack = () => T[L] || T[String(L).startsWith('zh') ? 'zh-CN' : 'en'];

  // 一律用主题变量, 深浅两套自动跟着换; 彩色底的按钮自己写字色(test-theme-tokens 查这条)
  const CSS = `
  #tipsOverlay { position:fixed; inset:0; background:var(--scrim); z-index:10000;
    display:flex; align-items:center; justify-content:center; padding:24px; }
  #tipsOverlay .tp-card { position:relative; background:var(--panel-2); color:var(--text);
    border:1px solid var(--line); border-radius:var(--radius); padding:22px 26px 18px;
    width:min(440px,88vw); box-shadow:0 16px 48px var(--shadow); text-align:center; }
  #tipsOverlay .tp-x { position:absolute; top:10px; right:12px; background:transparent; border:0;
    color:var(--muted); font-size:18px; cursor:pointer; line-height:1; }
  #tipsOverlay .tp-x:hover { color:var(--text); }
  #tipsOverlay .tp-art { width:120px; height:90px; margin:4px auto 10px; display:block; }
  #tipsOverlay .tp-art .s { fill:none; stroke:var(--brand); stroke-width:3; stroke-linecap:round; stroke-linejoin:round; }
  #tipsOverlay .tp-art .a { fill:none; stroke:var(--accent); stroke-width:3; stroke-linecap:round; stroke-linejoin:round; }
  #tipsOverlay .tp-art .m { fill:none; stroke:var(--muted); stroke-width:3; stroke-linecap:round; }
  #tipsOverlay .tp-art .f { fill:var(--brand); opacity:.2; }
  #tipsOverlay .tp-art .t { fill:var(--brand); }
  #tipsOverlay h3 { margin:0 0 8px; font-size:16px; font-weight:600; }
  #tipsOverlay .tp-body { margin:0 0 14px; font-size:13px; color:var(--text-2); line-height:1.7; }
  #tipsOverlay .tp-try { display:inline-block; max-width:100%; padding:6px 14px; border-radius:999px; cursor:pointer;
    border:1px solid var(--brand); background:var(--tint); color:var(--brand-hi); font-size:13px; line-height:1.5; }
  #tipsOverlay .tp-try:hover { background:var(--hover); }
  #tipsOverlay .tp-ask { margin:16px 0 0; padding-top:12px; border-top:1px solid var(--line);
    font-size:13px; color:var(--accent); line-height:1.6; }
  #tipsOverlay .tp-foot { display:flex; align-items:center; gap:10px; margin-top:14px; font-size:12px; color:var(--muted); }
  #tipsOverlay .tp-foot label { display:flex; align-items:center; gap:6px; cursor:pointer; }
  #tipsOverlay .tp-n { flex:1; }
  #tipsOverlay .tp-foot button { padding:6px 14px; border-radius:var(--radius-sm); border:1px solid var(--line);
    font-size:12px; cursor:pointer; background:transparent; color:var(--text); }
  #tipsOverlay .tp-foot button:hover { background:var(--field); }
  #tipsOverlay .tp-foot .tp-next { background:var(--brand); border-color:var(--brand); color:#fff; font-weight:600; }
  #tipsOverlay .tp-foot .tp-next:hover { background:var(--brand-hi); }`;

  let idx = 0;

  function paint(ov) {
    const P = pack();
    const [title, body, sample] = P.tips[idx];
    ov.querySelector('.tp-art').innerHTML = ART[idx];
    ov.querySelector('h3').textContent = title;
    ov.querySelector('.tp-body').textContent = body;
    ov.querySelector('.tp-try').textContent = P.tryIt + sample;
    ov.querySelector('.tp-n').textContent = `${idx + 1} / ${P.tips.length}`;
  }

  // 「试试」: 填进输入框交给用户, 不替他发
  function tryIt(text) {
    const box = document.getElementById('input');
    if (!box) return;
    box.value = text;
    box.dispatchEvent(new Event('input', { bubbles: true }));   // 输入框按内容长高
    box.focus();
  }

  function show(at) {
    if (document.getElementById('tipsOverlay')) return;
    if (!document.getElementById('tipsCss')) {
      const st = document.createElement('style'); st.id = 'tipsCss'; st.textContent = CSS; document.head.appendChild(st);
    }
    const P = pack();
    idx = Number.isInteger(at) ? at : Math.floor(Math.random() * P.tips.length);
    const ov = document.createElement('div');
    ov.id = 'tipsOverlay';
    ov.innerHTML = `<div class="tp-card" role="dialog">
      <button type="button" class="tp-x">×</button>
      <svg class="tp-art" viewBox="0 0 120 90" aria-hidden="true"></svg>
      <h3></h3><p class="tp-body"></p>
      <button type="button" class="tp-try"></button>
      <p class="tp-ask"></p>
      <div class="tp-foot">
        <label><input type="checkbox" class="tp-never"><span></span></label>
        <span class="tp-n"></span>
        <button type="button" class="tp-close"></button>
        <button type="button" class="tp-next"></button>
      </div>
    </div>`;
    ov.querySelector('.tp-x').title = P.close;
    ov.querySelector('.tp-ask').textContent = P.ask;
    ov.querySelector('.tp-foot label span').textContent = P.never;
    ov.querySelector('.tp-close').textContent = P.close;
    ov.querySelector('.tp-next').textContent = P.next;
    paint(ov);
    document.body.appendChild(ov);

    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    ov.querySelector('.tp-x').addEventListener('click', close);
    ov.querySelector('.tp-close').addEventListener('click', close);
    ov.querySelector('.tp-next').addEventListener('click', () => { idx = (idx + 1) % pack().tips.length; paint(ov); });
    ov.querySelector('.tp-try').addEventListener('click', () => { tryIt(pack().tips[idx][2]); close(); });
    ov.querySelector('.tp-never').addEventListener('change', (e) => { window.butler.setTips({ on: !e.target.checked }).catch(() => {}); });
  }

  async function loadLocale() {
    try { const loc = await window.butler.getLocale(); if (loc && loc.locale) L = loc.locale; } catch (_) { /* 用默认语言 */ }
  }

  async function maybeShow() {
    try {
      const ps = await window.butler.listPersonas().catch(() => null);
      if (!ps || !((ps.personas || []).length)) return;
      const st = await window.butler.getTips();
      if (!st || !st.on) return;
      await loadLocale();
      show(st.seen ? undefined : 0);
      if (!st.seen) window.butler.setTips({ seen: true }).catch(() => {});
    } catch (_) { /* 弹不出来就算了, 别为一张贴士挡住主界面 */ }
  }

  // 系统设置「通用」里点「现在看一条」→ 主进程广播 tips-show
  if (window.butler && window.butler.onTipsShow) window.butler.onTipsShow(async () => { await loadLocale(); show(); });

  window.tips = { show, maybeShow, T, ART };   // T / ART 挂出来给 test-tips.js 查四语条数
  window.addEventListener('DOMContentLoaded', maybeShow);
})();
