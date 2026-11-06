// hub-panel.js — 人格编辑面板里「连公网 hub」那一块。
//
// 为什么单开一个文件: manager.js 和 i18n.js 都已经撞了行数闸, 新功能一律另起文件 ——
// 所以这里连三语文案也自带, 不往 i18n.js 里加。
//
// 它接管的是 bus 那一段的**呈现**: 主路径变成「留一句话申请」, 原来那张手填 base_url/token
// 的表被折进「高级」。表本身一个字没改 —— manager.js 的 readPluginsFromPanel 靠 .pb-ep
// 选择器读回, 节点只是换了个父容器, 照样读得到。
//
// 手填那条路不能删: 狂人和白白手上的 token 是 ssh 上去签的, 走不了申请流程; 以后连别人的
// bus、连自建的 bus, 也只有手填这一条路。
'use strict';

const HUB_T = {
  'zh-CN': {
    head: '🌐 连接 AIHUB', owner: '你的名字(对方靠它认出你, 别人也能按名字找到你)', ph: '想用来做什么(选填)', needowner: '请填上你自己的名字',
    apply: '申请连接', checking: '检查中…', check: '检查是否通过', advanced: '高级 · 手动填地址和 token',
    pending: '已提交, 等对方批准。批准后会自动连上, 想马上看结果可以点「检查」。',
    rejected: '这次申请没被通过。', notyet: '还没批下来, 批准后会自动连上。',
    expired: '这条申请的凭证已经领走了。重新点「申请连接」再走一遍。',
    connected: '已连接 · 你的身份是 {agent}', done: '连上了! 你的身份是 {agent}',
    needname: '先给这个人格起个名字', busy: '正在申请…',
  },
  'zh-TW': {
    head: '🌐 連線 AIHUB', owner: '你的名字(對方靠它認出你, 別人也能按名字找到你)', ph: '想用來做什麼(選填)', needowner: '請填上你自己的名字',
    apply: '申請連線', checking: '檢查中…', check: '檢查是否通過', advanced: '進階 · 手動填位址和 token',
    pending: '已送出，等對方核准。核准後會自動連上，想馬上看結果可以點「檢查」。',
    rejected: '這次申請沒被通過。', notyet: '還沒核准，核准後會自動連上。',
    expired: '這條申請的憑證已經領走了。重新點「申請連線」再走一遍。',
    connected: '已連線 · 你的身分是 {agent}', done: '連上了！你的身分是 {agent}',
    needname: '先給這個人格取個名字', busy: '正在申請…',
  },
  en: {
    head: '🌐 Connect to AIHUB', owner: 'Your name (how the approver recognizes you, and how others can find you)', ph: 'What you want to use it for (optional)', needowner: 'Please enter your own name',
    apply: 'Request access', checking: 'Checking…', check: 'Check if approved', advanced: 'Advanced · enter URL and token by hand',
    pending: 'Request sent, waiting for approval. It connects automatically once approved; hit Check to see right away.',
    rejected: 'This request was turned down.', notyet: 'Not approved yet. It connects automatically once approved.',
    expired: 'The credential for this request has already been collected. Hit Request access to start over.',
    connected: 'Connected · you are {agent}', done: 'Connected! You are {agent}',
    needname: 'Give this persona a name first', busy: 'Requesting…',
  },
  ja: {
    head: '🌐 AIHUB につなぐ', owner: 'お名前(承認時の確認と、他の方があなたを名前で探すのに使います)', ph: '何に使いたいか(任意)', needowner: 'ご自身のお名前を入力してください',
    apply: '接続を申請', checking: '確認中…', check: '承認されたか確認', advanced: '詳細 · URL と token を手入力',
    pending: '申請しました。承認されると自動でつながります。すぐ確かめたいときは「確認」を押してください。',
    rejected: '今回の申請は通りませんでした。', notyet: 'まだ承認されていません。承認されると自動でつながります。',
    expired: 'この申請の認証情報は取得済みです。「接続を申請」からやり直してください。',
    connected: '接続済み · あなたは {agent} です', done: 'つながりました! あなたは {agent} です',
    needname: 'まずこの人格に名前をつけてください', busy: '申請中…',
  },
};

let _locale = 'zh-CN';
const ht = (k, vars) => {
  const d = HUB_T[_locale] || HUB_T['zh-CN'];
  const v = d[k] != null ? d[k] : HUB_T['zh-CN'][k];
  return vars ? String(v).replace(/\{(\w+)\}/g, (m, n) => (vars[n] != null ? String(vars[n]) : m)) : v;
};
try {
  window.butler.getLocale().then((r) => { if (r && r.locale) _locale = r.locale; });
} catch (_) { /* 拿不到就中文, 不值得为它挡住整块界面 */ }

// 样式跟着这块界面走, 不进 style.css —— 那个文件也撞了行数闸, 而且这几条只有这里用。
const HUB_CSS = `
.hub-join .hub-body { display:flex; flex-direction:column; gap:6px; align-items:flex-start; }
.hub-join .hub-msg { width:100%; resize:vertical; }
.hub-join .hub-owner { width:100%; box-sizing:border-box; }
.hub-join .hub-note { font-size:12px; opacity:.7; min-height:16px; }
.hub-join .hub-btns { display:flex; gap:8px; align-items:center; }
.hub-join .hub-ok { font-size:13px; }
details.hub-advanced > summary { cursor:pointer; font-size:12px; opacity:.7; margin:6px 0; }
`;
if (!document.getElementById('hub-panel-css')) {
  const st = document.createElement('style');
  st.id = 'hub-panel-css'; st.textContent = HUB_CSS;
  document.head.appendChild(st);
}

const escH = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 🔴 认的是 kind 不是 id: 已经在用的那几台是手填的, id 叫 `bus` 不叫 `hub`(2026-08-28 在
// 作者的开发机上实拍到 —— 只认 id 的话, 明明连着的人格还在劝他「申请连接」)。
// 个人版就一条 bothub, 所以「有 bothub 且有 token」= 已连上。
// 🔴 token 必须一起看: 只看 base_url 的话, token 被抹掉或被后台撤销之后这条空壳还在,
// 面板就一直显示「已连接」、一个按钮都不给, 用户既连不上也没法重新申请。
function hubBusOf(p) {
  const buses = (p && p.plugins && p.plugins.buses) || [];
  return buses.find((b) => b && b.kind === 'bothub' && b.base_url && b.token) || null;
}

// 手填那张表折进 <details>: 主路径让位给「申请」, 但它一行都没少。
function foldManualTable(box) {
  const epBox = box.querySelector('.pb-endpoints');
  const addBtn = box.querySelector('.pb-add');
  if (!epBox || !addBtn) return;
  const addLine = addBtn.closest('.e-line') || addBtn;
  const det = document.createElement('details');
  det.className = 'hub-advanced';
  const sum = document.createElement('summary');
  sum.textContent = ht('advanced');
  det.appendChild(sum);
  epBox.parentNode.insertBefore(det, epBox);
  det.appendChild(epBox);
  det.appendChild(addLine);
  // 已经手配过的直接摊开 —— 折起来会让人以为配置没了。
  if (epBox.children.length) det.open = true;
}

function mount(box, p, renderEndpoint) {
  const anchor = box.querySelector('.pb-endpoints');
  if (!anchor) return;
  foldManualTable(box);

  const wrap = document.createElement('div');
  wrap.className = 'hub-join';
  box.querySelector('.hub-advanced').parentNode.insertBefore(wrap, box.querySelector('.hub-advanced'));

  const note = (msg) => { wrap.querySelector('.hub-note').textContent = msg; };

  // 用整行的小标题而不是左边那根 label 栏 —— 「🌐 连公网 hub」在窄栏里会折成两行,
  // 而且下面是一整块内容, 挂在垂直居中的 label 上看着像飘着的。
  const headHtml = `<div class="e-plugin-head">${escH(ht('head'))}</div>`;

  function renderConnected(agent) {
    wrap.innerHTML = `${headHtml}<div class="hub-ok">${escH(ht('connected', { agent }))}</div>`;
  }

  // 🔴 只要这个人格还没真连上(hubBusOf 为空), **申请按钮一直在**。等批准期间额外多一个
  // 「检查」, 但不能只剩检查 —— 后台撤了 token 或那条申请走不下去时, 用户会被锁死在一个
  // 永远拿不到结果的按钮上, 连重新申请的入口都没有。连上之后这块整个换成「已连接」。
  // 本人名字按机器记(core/hub-join.js 的 owner_name): 这台机器上给别的人格申请过就直接带出来
  let ownerName = '';
  function renderForm(state) {
    const waiting = state.status === 'pending' || state.status === 'approved';
    if (state.ownerName) ownerName = state.ownerName;
    wrap.innerHTML = `${headHtml}
      <div class="hub-body">
        <input class="hub-owner" type="text" maxlength="64" placeholder="${escH(ht('owner'))}" value="${escH(ownerName)}">
        <textarea class="hub-msg" rows="2" placeholder="${escH(ht('ph'))}"></textarea>
        <div class="hub-btns">
          ${waiting ? `<button type="button" class="m-btn primary hub-check">${escH(ht('check'))}</button>` : ''}
          <button type="button" class="m-btn${waiting ? '' : ' primary'} hub-go">${escH(ht('apply'))}</button>
        </div>
        <div class="hub-note">${escH(waiting ? ht('pending') : '')}</div>
      </div>`;
    wrap.querySelector('.hub-go').addEventListener('click', doApply);
    const chk = wrap.querySelector('.hub-check');
    if (chk) chk.addEventListener('click', doClaim);
  }

  async function doApply() {
    const name = (box.querySelector('.e-name').value || '').trim();
    if (!name) return note(ht('needname'));
    const owner = (wrap.querySelector('.hub-owner').value || '').trim();
    if (!owner) { wrap.querySelector('.hub-owner').focus(); return note(ht('needowner')); }
    ownerName = owner;
    const btn = wrap.querySelector('.hub-go');
    btn.disabled = true; note(ht('busy'));
    const r = await window.butler.hubApply({
      displayName: name, ownerName: owner, message: wrap.querySelector('.hub-msg').value, personaId: p.id,
    });
    btn.disabled = false;
    if (!r.ok) return note(r.error || '');
    renderForm({ status: r.status });
  }

  // 🔴 取到 token 之后必须往手填表里补这一行, 哪怕它是折起来的。
  // 保存人格时 buses 是 manager.js 的 readPluginsFromPanel 从 .pb-ep 节点读回来的, 表里没有
  // 这一行就读成空数组, 而 registry.upsert 是整个替换 plugins —— 于是「点检查连上了, 再点保存
  // 就断了, 重开还劝你申请」(2026-09-07 老师 agent-8696 实撞, token 一次性签发, 抹掉就再没有)。
  function addManualRow(bus) {
    const epBox = box.querySelector('.pb-endpoints');
    if (!bus || !epBox || !renderEndpoint) return;
    const at = [...epBox.querySelectorAll('.pb-ep')]
      .find((el) => (el.querySelector('.pbe-id').value || '').trim() === bus.id);
    if (at) at.remove();
    epBox.appendChild(renderEndpoint(bus, epBox.children.length));
  }

  async function doClaim() {
    const btn = wrap.querySelector('.hub-go');
    btn.disabled = true; note(ht('checking'));
    const r = await window.butler.hubClaim(p.id);
    btn.disabled = false;
    if (!r.ok) return note(r.error || '');
    if (r.granted) { addManualRow(r.bus); return renderConnected(r.agent); }
    if (r.status === 'rejected') return note(ht('rejected'));
    // expired = 凭证已被领走且过了重签窗口, 再点多少次都不会变 —— 得说实话让他重新申请。
    if (r.status === 'expired') return note(ht('expired'));
    note(ht('notyet'));
  }

  const bus = hubBusOf(p);
  if (bus) { renderConnected(bus.agent); return; }
  renderForm({ status: '' });
  window.butler.hubState(p.id).then((st) => { if (st && !hubBusOf(p)) renderForm(st); }).catch(() => {});
}

window.hubPanel = { mount };
