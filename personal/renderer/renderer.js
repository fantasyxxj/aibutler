// renderer.js — 渲染层(单窗口多标签/MDI): 每个标签=一个人格文档, 各自气泡流/附件/输入草稿。
// 顶栏(人格名·目录·usage 条)反映"活动标签"; 底部输入栏共享, 发到活动标签。后台标签流式照跑,
// 非活动标签来消息→标记未读小点。软插话模型不变: 发送/输入框永不禁用。
const stage = document.getElementById('stage');
const tabsEl = document.getElementById('tabs');
const newTabBtn = document.getElementById('newTabBtn');
const input = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const compactBtn = document.getElementById('compactBtn');
const attachBtn = document.getElementById('attachBtn');
const micBtn = document.getElementById('micBtn');
const fileInput = document.getElementById('fileInput');
const attachstrip = document.getElementById('attachstrip');
const ctxfill = document.getElementById('ctxfill');
const ctxlabel = document.getElementById('ctxlabel');
const personaName = document.getElementById('personaName');
const personaDir = document.getElementById('personaDir');
const personaAvatar = document.getElementById('personaAvatar');
const closeCurrentBtn = document.getElementById('closeCurrentBtn');
const settingsBtn = document.getElementById('settingsBtn');
const cancelBtn = document.getElementById('cancelBtn');
const langSel = document.getElementById('lang');

/* ── 界面语言 ──
   S = 当前语言的字典。字典本体在 i18n.js(主进程), 这边只拿快照。
   出厂值先给一份空对象 + `t()` 兜底: 主进程还没回话的那几十毫秒里, 界面用的是
   index.html 里写死的中文, 不能因为 S 还没到就抛异常把整个 renderer 打死。 */
let S = {};
// 当前是哪种语言。**不能从 S 里问** —— S 是字典本身(键全是界面文案), 没有"我是哪种语言"
// 这一项。沙箱要拿它告诉包该用哪种语言画, 拿错了不报错, 只是日语用户永远收到中文。
let curLocale = 'zh-CN';
const t = (k, vars) => {
  const v = S[k];
  if (v == null) return '';
  return vars ? String(v).replace(/\{(\w+)\}/g, (m, n) => (vars[n] != null ? String(vars[n]) : m)) : v;
};

// HTML 里打了 data-i18n* 的元素统一刷。属性名对应 i18n.js 的键。
function applyStrings(payload) {
  S = (payload && payload.strings) || S;
  if (payload && payload.locale) curLocale = payload.locale;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  cancelBtn.textContent = `⏹ ${t('cancel')}`;   // 图标+文字拼的, 不走 data-i18n
  window.MD_I18N = S;                           // md.js/widgets.js 的用户可见文案跟着界面语言走
  setStatus(_statusKey, _statusOverride);       // 状态条是拼出来的, 切完语言要重拼
}

function fillLocales(el, locales, current) {
  el.innerHTML = '';
  for (const l of locales || []) {
    const o = document.createElement('option');
    o.value = l.id; o.textContent = l.label;
    if (l.id === current) o.selected = true;
    el.appendChild(o);
  }
}

const tabs = new Map();     // sid -> Tab
let activeSid = null;

// ---- Tab 数据结构 ----
// { sid, persona, usage, panel, chat, tabEl, avatarEl, dotEl, activeBubble, attachments[], draft, loaded, unread }
const activeTab = () => tabs.get(activeSid);

// 粘底滚动: 只有用户本来就停在底部才跟随新内容自动滚; 往上翻看时不打扰。🔴 _autoTop 记的是"我自己滚到的位置" —— scroll 事件异步, 跑起来时流式常已追加新内容, 照 nearBottom 判会误判成用户往上翻, 而 stick 变 false 之后没有任何自动路径能复位。
const NEAR_BOTTOM_PX = 60;
function nearBottom(chat) { return chat.scrollHeight - chat.scrollTop - chat.clientHeight < NEAR_BOTTOM_PX; }
function maybeScroll(tab) { if (replayDepth) return; if (tab.sid === activeSid && tab.stick !== false) { tab.chat.scrollTop = tab.chat.scrollHeight; tab._autoTop = tab.chat.scrollTop; } }

// ts 语义: undefined→用当前时间(实时消息) ; null→不显示时间(系统分隔/无 ts 的历史) ; number/string→用该时刻
function fmtTime(ts) {
  let d;
  if (ts == null) d = new Date();
  else if (typeof ts === 'number') d = new Date(ts < 1e12 ? ts * 1000 : ts);  // 秒或毫秒都兼容
  else d = new Date(ts);
  if (isNaN(d.getTime())) d = new Date();
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// 气泡结构: <div.msg><div.msg-body>文本</div><time.msg-time>HH:MM</time></div>
// body 与 time 分离, 使流式 textContent 追加不会冲掉时间戳; body 收尾可整块 md 渲染。
function addMsgTo(tab, role, text, ts) {
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = text || '';
  el.appendChild(body);
  el._body = body;
  if (ts !== null) {
    const t = document.createElement('time');
    t.className = 'msg-time';
    t.textContent = fmtTime(ts);
    el.appendChild(t);
  }
  // dataset.h = "这条对应日志里的一条", 往上拉只认带它的当游标(工具条/"发送失败"不落盘, 拿去问日志会问空); 默认打上, 由不落盘那几处自己摘掉。
  // 🔴 dataset.ts 存原始时间戳: msg-time 里那个 "16:35" 解析不回绝对时间, 而翻页要拿它当游标去日志定位。少了它就只能退回数条数, 那正是丢消息的老病根。
  el.dataset.h = '1';
  if (ts != null) el.dataset.ts = String(new Date(ts).getTime() || '');
  if (tab._insertBefore) {                        // 往上拉: 插到顶部那批的前面, 而不是追加到底
    tab.chat.insertBefore(el, tab._insertBefore);
    tab.msgEls.splice(tab._insertAt++, 0, el);
  } else {
    tab.chat.appendChild(el);
    tab.msgEls.push(el);
  }
  trimChat(tab);
  maybeScroll(tab);
  return el;
}
const bodyOf = (el) => (el && el._body) || el;

// 流式输出的 CPU 代价与聊天区常驻的气泡条数成正比(实测线性: 每千条约 +10s CPU/回复),
// 与写法无关 —— appendData / rAF 合滚 / block 布局 / content-visibility 实测都只有 1.0~1.3x。
// 所以屏幕只留最近这些条, 更早的**销毁**, 内存里一个对象都不留(作者: "留着对象没用")。
// 要回看就滚到顶, 从磁盘日志重新读出来渲染 —— 90% 的时候没人往上翻, 不该为这 10% 常驻内存。
const SCREEN_MSG_CAP = 400;
const PAGE_MSGS = 100, HARD_MSG_CAP = 1200;   // 后者: 往上翻着不放也绝不越过, 防 DOM 无限堆
const NEAR_TOP_PX = 120; let replayDepth = 0;   // 后者 >0 = 正在回放历史: 下面两个动作全程跳过, 由 loadHistory 结束时统一补一次。每条都做等于每条强制一次同步布局(它们都要碰 scrollHeight), 400 条实测 2.5 秒, 跳过后 75 毫秒。用计数不用布尔: 多个标签可能同时回放, 布尔会被先结束的那个提前关掉。
function trimChat(tab) { if (replayDepth) return;
  // 往上翻时放宽到硬上限而不是完全不裁 —— 完全不裁的话 stick 一直 false(曾被流式竞态误置且永不复位)就 DOM 无限堆。
  // ⚠️ 正往顶上补老消息时一条都不裁: 补一批裁一批不但白干, 还会「到顶→补→被裁→仍在顶→再补」来回死循环。
  const list = tab.msgEls, h0 = tab.chat.scrollHeight, cap = tab._insertBefore ? Infinity : (tab.stick === false ? HARD_MSG_CAP : SCREEN_MSG_CAP);
  while (list.length > cap) {
    if (list[0] === tab.activeBubble) break;   // 正在流的那条永远不动
    list.shift().remove();
  }
  if (tab.stick === false) tab.chat.scrollTop -= (h0 - tab.chat.scrollHeight);   // 裁多少补多少, 正在读的位置不跳
}

// 滚到顶 → 从日志再要 PAGE_MSGS 条接到最前面。
// 🔴 游标是【屏幕上最早那条落盘消息的时间戳】, 不是"跳过 N 条"。老写法拿屏幕气泡数去数日志, 而屏幕是拿
// .session.json 快照画的 —— 两份不是同一个序列(日志 8-27 才上线, 之前快照攒的永远不补写; display:'' 的
// 进快照不进日志), 条数对不上就整段跳过, 表现为"上一条从今天早上跳到昨天下午"。详见 chat-store。
async function restoreOlder(tab) {
  if (tab._paging) return;
  const _f = tab.chat.querySelector('.msg[data-h][data-ts]');   // 屏幕上最早那条落盘消息; 没有 → 0 = 从最新取
  const before = _f ? Number(_f.dataset.ts) : 0;
  // 🔴 记的是"翻到哪个时间点问到过空", 不是"已到顶"的布尔 —— 布尔会把**当时**没得翻固化成永远没得翻:
  // 刚装上这版时日志还是空的, 随手往上滚一下就永久关掉了。时间点会自愈: 只有再次翻到同一个或更早的位置才短路。
  if (tab._emptyBefore != null && before && before <= tab._emptyBefore) return;
  tab._paging = true;
  try {
    const r = await window.butler.historyPage(tab.sid, before, PAGE_MSGS);
    const older = (r && r.messages) || [];
    if (!older.length) { tab._emptyBefore = before; return; }   // 这个时间点往前没有了
    // 先把整批的图都取回来 —— 取图要 await, 而下面那段描的过程中不能让出线程
    const imgs = [];
    for (const m of older) imgs.push(await fetchHistoryImgs(tab, m));

    const chat = tab.chat;
    const beforeH = chat.scrollHeight;   // 插入前的高度。🔴 别叫 before —— 会和上面的时间游标同名同块, 于是游标落进暂时性死区, 整个往上翻静默变哑
    // ↓↓ 从这里到 finally 是同步的, 中间不许出现 await ↓↓
    // _insertBefore 挂在 tab 上, 让出线程的话, 此刻正在流式输出的实时气泡也会被插到顶上去。
    tab._insertBefore = chat.firstChild;
    tab._insertAt = 0;
    if (tab.board && typeof tab.board.setReplaying === 'function') tab.board.setReplaying(true);
    try {
      older.forEach((m, i) => paintHistoryMsg(tab, m, imgs[i]));
    } finally {
      if (tab.board && typeof tab.board.setReplaying === 'function') tab.board.setReplaying(false);
      tab._insertBefore = null;
    }
    // 上方凭空多出一截高度, 不补 scrollTop 的话正在看的那行会当场往下窜走
    chat.scrollTop += chat.scrollHeight - beforeH;
  } catch (e) {   // 不弹错(不值得打断阅读)但必须留痕 —— 这里曾吞掉一个 ReferenceError, 往上翻整个静默变哑而门禁全绿
    console.error('[history] 往上翻失败:', e && e.message);
  } finally {
    tab._paging = false;
  }
}

// #9 图片消息: addMsgTo 上面盖一层图片网格. imgSources = [{src, alt?}] (src 可以是 dataURL / file: / 已 IPC 拿到 base64 转的 dataURL)
function renderImageMessage(tab, role, text, imgSources, ts) {
  const el = addMsgTo(tab, role, text || '', ts);
  if (imgSources && imgSources.length) {
    const grid = document.createElement('div');
    grid.className = 'msg-imgs';
    for (const s of imgSources) {
      const thumb = document.createElement('div');
      thumb.className = 'msg-thumb';
      const img = document.createElement('img');
      img.src = s.src; if (s.alt) img.alt = s.alt;
      thumb.appendChild(img);
      thumb.onclick = (e) => { e.stopPropagation(); openLightbox(s.src); };
      grid.appendChild(thumb);
    }
    el.insertBefore(grid, el._body);   // msg-imgs 排在 msg-body 之前, 保 msg-time 位置不变
  }
  return el;
}

// lightbox 单例 · 首次点击时按需创建
let _lightboxEl = null;
function openLightbox(src) {
  ensureLightbox();
  closeSvgZoom();
  const img = _lightboxEl.querySelector('img');
  img.style.display = '';
  img.src = src;
  _lightboxEl.querySelector('.lb-svg').style.display = 'none';
  _lightboxEl.style.display = 'flex';
}
// —— SVG 放大 ——
// 🔴 放大的是**原节点本身**, 不是克隆。两条理由, 都是踩过才知道:
//   ① id 会撞。md.js 给每张图的 id 做过作用域化(rid), 但克隆一份就等于把同一批 id 复制进同一个
//      文档 —— SMIL 的 begin="playBtn.click" 按文档顺序找第一个匹配, 于是点放大图里的按钮,
//      动的是缩略图那张。CSS 作用域挡不住这个, 引用型属性得跟着改名, 克隆就要再消毒一遍。
//   ② 事件监听器不跟着克隆走。data-btn 的点击是 widgets 层 addEventListener 接的,
//      cloneNode 只复制属性不复制监听, 放大后按钮变哑巴。
// 移动 DOM 节点则两样都保住: id 全程唯一, 监听器原样跟着走。关闭时按 placeholder 放回原位。
// 🔴 搬完必须重挂一次 SMIL 的事件触发, 放大和还原两头都要。
//    svg 一离开文档, Chromium 就把它的 SMIL 时间容器拆掉; 重新插入时容器会重建 ——
//    但 begin="按钮id.click" 这类**事件型**条件不跟着重新解析, 于是图里的播放/暂停按钮全哑。
//    只坏 SMIL: CSS keyframes 那套不依赖时间容器, 全程不受影响, 不用管。
// 🔴 重设 begin 同值不够, 必须整个元素克隆替换。一个**已经激活过**的 animate(用户在放大态点过
//    播放键)光重设属性恢复不了事件触发, 换回来就再也点不动 —— 这正是作者报的"点着点着就不灵",
//    触发条件是"放大态点过播放"而非放大本身。probe 路径 C 实测位移 -0.01(纹丝不动)。
// 🔴 只重建**事件型**(begin="按钮id.click")。时间型 begin="0s" 这类是自动播放, 克隆重建会让它
//    从头再播一遍 —— 用户翻看一张早就播完的图, 关掉放大后动画突然重新开演, 是新 bug 不是修复。
const SMIL_EVENT_BEGIN = /[A-Za-z_][\w-]*\.[A-Za-z]/;   // "playBtn.click" 命中; "1.5s" 因点号前是数字而不命中
function rebindSmil(svg) {
  svg.querySelectorAll('animate,animateTransform,animateMotion,set').forEach((a) => {
    if (SMIL_EVENT_BEGIN.test(a.getAttribute('begin') || '')) a.replaceWith(a.cloneNode(true));
  });
}
let _svgZoom = null;    // { svg, placeholder, w, h }
function openSvgLightbox(svg) {
  ensureLightbox();
  closeSvgZoom();
  const placeholder = document.createComment('svg-zoomed');
  // 放大尺寸在**搬走之前**按当前渲染大小算死, 直接写进 width/height 属性。
  // 不能交给 CSS 的 auto: 弹层里那个容器的宽度本身由内容定, svg 说"随便"就成了互相等 → 塌成 0,
  // 屏幕上只剩一片黑。原属性暂存, 放回原位时装回去(直接删的话缩略图会塌)。
  const rect = svg.getBoundingClientRect();
  _svgZoom = { svg, placeholder, w: svg.getAttribute('width'), h: svg.getAttribute('height'), mw: svg.style.maxWidth };
  svg.parentNode.insertBefore(placeholder, svg);
  const w0 = rect.width || 300, h0 = rect.height || 150;
  const k = Math.min(window.innerWidth * 0.9 / w0, window.innerHeight * 0.85 / h0);
  svg.setAttribute('width', Math.round(w0 * k));
  svg.setAttribute('height', Math.round(h0 * k));
  svg.style.maxWidth = 'none';   // mermaid 自己往 svg 上写 style="max-width:NNNpx", 不摘就放不大
  const holder = _lightboxEl.querySelector('.lb-svg');
  holder.appendChild(svg);
  rebindSmil(svg);
  holder.style.display = 'flex';
  _lightboxEl.querySelector('img').style.display = 'none';
  _lightboxEl.style.display = 'flex';
}
function closeSvgZoom() {
  if (!_svgZoom) return;
  const { svg, placeholder, w, h, mw } = _svgZoom;
  // 原本没有 width/height 的(比如 mermaid 那种靠 viewBox 自适应的)要**删掉**放大时加的,
  // 不能只在有原值时覆盖 —— 否则关掉之后缩略图一直顶着放大后的尺寸。
  if (w != null) svg.setAttribute('width', w); else svg.removeAttribute('width');
  if (h != null) svg.setAttribute('height', h); else svg.removeAttribute('height');
  svg.style.maxWidth = mw || '';
  if (placeholder.parentNode) placeholder.parentNode.replaceChild(svg, placeholder);
  rebindSmil(svg);   // 搬回来是第二次离开文档, 同样要重挂, 否则关掉放大后缩略图上的按钮反而哑了
  _svgZoom = null;
}
function closeLightbox() {
  closeSvgZoom();
  if (_lightboxEl) {
    _lightboxEl.style.display = 'none';
    const holder = _lightboxEl.querySelector('.lb-svg');
    if (holder) holder.style.display = 'none';
    _lightboxEl.querySelector('img').style.display = '';
  }
}
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && _lightboxEl && _lightboxEl.style.display !== 'none') closeLightbox(); });

// 给一张内联 SVG 接上放大。
// 🔴 不整图绑点击: 图里可能有 data-btn 按钮和 SMIL 的启停按钮, 整图绑等于点按钮时顺带弹个放大层。
//    所以只认"非交互区域"的点击, 交互元素(data-btn / data-cmd / cursor=pointer)一律让给它们自己。
//    另外挂一个角标按钮兜底 —— 整张图都被按钮铺满时, 没有空白可点。
function attachSvgZoom(wrap) {
  const svg = wrap.querySelector('svg');
  if (!svg || wrap._zoomWired) return;
  wrap._zoomWired = true;
  wrap.classList.add('zoomable');
  svg.addEventListener('click', (e) => {
    if (_svgZoom) return;                                     // 已经在放大态里, 点了是要用图不是再放大
    if (e.target.closest('[data-btn],[data-cmd],[cursor="pointer"]')) return;
    e.stopPropagation();
    openSvgLightbox(svg);
  });
  const btn = document.createElement('button');
  btn.className = 'svg-zoom-btn';
  btn.type = 'button';
  btn.textContent = '⤢';
  btn.title = t('zoom_svg');
  btn.onclick = (e) => { e.stopPropagation(); openSvgLightbox(svg); };
  wrap.appendChild(btn);
}

function ensureLightbox() {
  if (_lightboxEl) return;
  _lightboxEl = document.createElement('div');
  _lightboxEl.id = 'lightbox';
  const img = document.createElement('img');
  const holder = document.createElement('div');
  holder.className = 'lb-svg';
  holder.style.display = 'none';
  holder.onclick = (e) => e.stopPropagation();   // 放大态下图还能点(按钮/动画照常), 别一点就关
  const btn = document.createElement('button');
  btn.className = 'lb-close'; btn.textContent = '×';
  btn.onclick = (e) => { e.stopPropagation(); closeLightbox(); };
  _lightboxEl.appendChild(img);
  _lightboxEl.appendChild(holder);
  _lightboxEl.appendChild(btn);
  _lightboxEl.onclick = () => closeLightbox();   // 点背景关
  document.body.appendChild(_lightboxEl);
}

/* ── 行内控件 ──
   建控件的本体在 widgets.js(设计判断和坑都写在那边), 这里只接线。
   个人版没有"我们的平台"这一侧, 所以命令目录是空的 —— {{cmd:…}} 一律走未知命令红字, 不静默吞。
   留着 in/sel/btn 这半边: 它们只在本机收集值, 按钮把值当一条普通用户消息发回给 AI。 */
// 控件报错文案的键名跟 i18n.js 里一致, 直接把整份字典给它 —— 中间再抄一层
// 只会多一个会忘记同步的地方。
// 气泡属于哪个标签: 从 tabs 反查(录音组件同一套做法), 查不到用当前活动标签兜底
function sidOfNode(node) {
  for (const [s, t] of tabs) { if (t.chat.contains(node)) return s; }
  return activeSid;
}
function tabOf(node) {
  for (const [s, t] of tabs) { if (t.chat.contains(node)) return t; }
  return activeTab();
}
// 命令目录: 开窗就取一次(根在 config/ 里, 不等任何启动步骤)。取到之前目录是空的,
// 那时的 {{cmd:}} 会红字说"未知命令" —— 宁可这样也不静默, 而且下一次渲染就正常了。
let cmdCatalog = {};
function refreshCommandCatalog() {
  return window.butler.commandCatalog()
    .then((r) => { cmdCatalog = (r && r.commands) || {}; })
    .catch(() => {});
}
refreshCommandCatalog();

// 界面包同理: 开窗取一次, 装了新包时主进程会重新 loadWorkflowPackages, 这边跟着再取一次。
let uiPkgs = {};
function refreshUiPackages() {
  return window.butler.uiPackages()
    .then((r) => {
      uiPkgs = {};
      for (const p of (r && r.packages) || []) uiPkgs[p.id] = p;
    })
    .catch(() => {});
}
refreshUiPackages();

/* 装包可以发生在开窗之后(bus 下发 / packages.local 落盘), 而上面两份都是缓存 ——
   不重取的话新装的包在这个窗口里永远是"没装这个界面包", 用户得重开 app 才看得见。
   命令目录必须一起刷: 包带的命令走的是同一份热更目录, 漏了它包里的 {{cmd:}} 按钮会犯同样的毛病。 */
window.butler.onPackagesChanged(() => { refreshUiPackages(); refreshCommandCatalog(); pluginErrSeen.clear(); });

// 包界面报过的错(重装包时清空, 修好的包再坏要能再报一次)
const pluginErrSeen = new Set();
// 包界面属于哪个标签: 常驻板不在 chat 里, 所以按整块 panel 反查
function sidOfPanelNode(node) {
  for (const [s, t] of tabs) { if (t.chat.parentElement && t.chat.parentElement.contains(node)) return s; }
  return null;
}
function pickTitle(title) {
  if (!title || typeof title === 'string') return title || '';
  return title[curLocale] || title['zh-CN'] || Object.values(title)[0] || '';
}

/* 沙箱。包的界面代码跑在里面, 出不来 —— 判断和命门全在 renderer/sandbox.js。
   这里只把它接到宿主的三样东西上: 跑命令 / 读状态 / 写状态。
   🔴 readState/writeState 的包 id 是**这边**按"是哪个包挂的这个沙箱"填的,
      不收沙箱在消息里自报的 id, 否则一个包能去写另一个包的抽屉。 */
// 状态在开窗时一次性取不到(不知道会用到哪些包), 所以按包 id 现取现缓存。
const uiStateCache = {};

const uiSandbox = window.UiSandbox.create({
  document,
  strings: () => S,
  locale: () => curLocale,
  commandNames: () => Object.keys(cmdCatalog),
  /* 包界面里的调用多半不是人点的(定时刷新、开面板自动取数), 所以和聊天里的按钮分开处理:
     🔴 发给面板所在的人格, 不是当前标签 —— 每个标签的常驻板各跑一份包, 按当前标签发会串台、成倍刷屏。
     🔴 屏幕上画成系统行「插件「X」…」, 不画成用户气泡 —— 这不是用户说的话。
     🔴 失败不看 notify_ai 一律告诉人格(不然它不知道自己的插件坏了), 但同一句报错到重装前只说一次:
        30 秒一刷的面板调一个不存在的命令, 每次都叫醒人格就是刷屏 + 白计费。 */
  runCommand: async (name, args, from) => {
    const r = await window.butler.runCommand(name, args);
    const sid = (from && from.node && sidOfPanelNode(from.node)) || activeSid;
    const tab = tabs.get(sid);
    if (!r || !tab) return r;
    const label = t('plugin_label', { title: pickTitle(from && from.title) || name });
    if (!r.ok) {
      const body = t('cmd_failed', { reason: r.message || t('cmd_failed_no_reason') });
      const key = `${sid}\n${name}\n${body}`;
      if (pluginErrSeen.has(key)) return r;
      pluginErrSeen.add(key);
      sysMsgTo(tab, `${label} ${body}`);
      window.emitUserMessage(sid, `[${name}] ${body}`, '');
    } else if (r.notifyAi) {
      if (r.message) sysMsgTo(tab, `${label} ${r.message}`);
      window.emitUserMessage(sid, `[${name}] ${r.message || ''}`.trim(), '');
    }
    return r;
  },
  readState: (id) => uiStateCache[id] || null,
  writeState: (id, state) => {
    uiStateCache[id] = state;
    window.butler.uiStateWrite(id, state).catch(() => {});
  },
});

/* 挂之前先把它上次存的东西取回来 —— 沙箱起来后第一件事就是收 init, 那时候
   状态得已经在手上。晚一步的话包会看到"我明明存过却是空的", 而且只在第一次出现。 */
function mountUi(node, pkg, openArgs) {
  window.butler.uiStateRead(pkg.id)
    .then((r) => { uiStateCache[pkg.id] = (r && r.state) || null; })
    .catch(() => {})
    .then(() => { uiSandbox.mount(node, pkg, openArgs); });
}

const widgets = window.MdWidgets.create({
  strings: () => S,
  catalog: () => cmdCatalog,
  /* 命令跑完要不要告诉 AI, 由目录说了算(翻屏的不告诉 —— 18 屏就是 18 次计费)。
     发给哪个人格用当前标签: 按钮得看得见才按得下去, 看得见的就是当前标签。 */
  runCommand: async (name, args) => {
    const r = await window.butler.runCommand(name, args);
    // 发给模型的带 [命令名] 前缀(它要知道是哪个包哪条命令触发的), 画在屏幕上的只留人话:
    // 那个前缀是机器标记, 用户刚点的按钮就在上面几行, 再回显一遍内部 id 是纯噪音。
    // 🔴 没人话就传空串 = 屏幕上一个气泡都不画(见 emitUserMessage)。别 fallback 成命令名:
    // 没得显示时退而求其次显示个内部 id, 比不显示更差 —— 用户看见自己刚点的按钮变成一句乱码。
    // 🔴 失败必须说明是失败: 只把 message 原样送过去, AI 分不出「写成功了」和「报错了」。
    if (r && r.notifyAi) {
      const body = r.ok ? (r.message || '') : t('cmd_failed', { reason: r.message || t('cmd_failed_no_reason') });
      window.emitUserMessage(activeSid, `[${name}] ${body}`.trim(), body);
    }
    return r;
  },
  sendToAI: (text, body) => window.emitUserMessage(sidOfNode(body), text),
  // 手顺的下一屏就地画出来。不过 AI, 所以翻页是免费且即时的。
  renderInto: (node, md) => { node.textContent = md; renderMd(node); },
  uiPackage: (id) => uiPkgs[id] || null,
  mountUi,
});

// 把气泡正文按 markdown 整块渲染(收尾时调用; 流式中仍用纯文本逐字, 避免半截 md 抖动)
function renderMd(body) {
  if (!body || typeof window.renderMarkdown !== 'function') return;
  const html = window.renderMarkdown(body.textContent);
  if (html) { body.innerHTML = html; body.classList.add('md'); decorateCode(body); widgets.paint(body);
    // {{pin:...}} 的印在 widgets.paint 之后还留在原地(它不认识 pin), 这里把它搬到本标签的常驻板。
    const _tab = tabOf(body);
    if (_tab && _tab.board) _tab.board.harvest(body);
    // md 图片点击走 lightbox (和附件图片一套)
    body.querySelectorAll('img.md-img').forEach(img => { img.onclick = (e) => { e.stopPropagation(); openLightbox(img.src); }; });
    // AI 画的内联 SVG: 点空白处或角标 ⤢ 放大 (交互元素让给它们自己, 见 attachSvgZoom)
    body.querySelectorAll('.md-svg-wrap').forEach(attachSvgZoom);
    // KaTeX 公式: 同步渲染 (md.js 已把 $$..$$ / $..$ 变成 .math-block / .math-inline data-tex)
    if (window.katex) {
      body.querySelectorAll('.math-inline, .math-block').forEach(n => {
        try { window.katex.render(n.dataset.tex || '', n, { displayMode: n.classList.contains('math-block'), throwOnError: false }); }
        catch (e) { n.textContent = '$' + (n.dataset.tex || '') + '$'; }
      });
    }
    // Mermaid 流程图: 异步渲染 (md.js 把 ```mermaid 块变成 .mermaid-block data-src)
    // 🔴 失败必须看得见。2026-08-26: 一张图永远停在"流程图渲染中…", 而且查不出为什么 ——
    // 原代码 `if (window.mermaid)` 没有 else(库没加载 = 占位符永驻且零报错), await 也没有超时
    // (渲染不返回 = 同样永驻)。两个洞的共同点: 坏了的样子和"还在渲染"长得一模一样。
    const mmdBlocks = body.querySelectorAll('.mermaid-block');
    const mmdFail = (n, why) => {
      const s = (n.dataset.src || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      n.innerHTML = '<pre class="mermaid-err">' + s + '\n\n// ' + t('render_failed') + ': ' + why + '</pre>';
      console.error('[md] mermaid 渲染失败: ' + why);
    };
    if (mmdBlocks.length && !window.mermaid) {
      mmdBlocks.forEach(n => mmdFail(n, t('mermaid_not_loaded')));
    } else if (window.mermaid) {
      mmdBlocks.forEach(async (n, idx) => {
        try {
          const id = 'mmd-' + performance.now().toString(36).replace('.', '') + '-' + idx;
          // 实测(2026-08-26 Electron 探针)正常图 20~330ms, 残缺图 5~22ms 就抛错; 8 秒还没动静就是卡住了。
          let timer;
          const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(t('render_timeout'))), 8000); });
          const { svg } = await Promise.race([window.mermaid.render(id, n.dataset.src || ''), guard]);
          clearTimeout(timer);
          n.innerHTML = svg;
          attachSvgZoom(n);   // 流程图往往最需要放大 —— 节点一多字就小得看不清
        } catch (e) {
          mmdFail(n, (e && e.message) ? e.message : String(e));
        }
      });
    }
    // ```record fence → RecordButton 状态机 (md.js 把 ```record 块变成 .record-block data-src)
    // sid 在此处不易获取 → 挂到 body 上最近的 msg 元素 → 由 msg 元素所在 tab 反查. 简化用 activeSid 兜底(录音场景基本都在当前 tab).
    if (window.recordWidget) {
      body.querySelectorAll('.record-block').forEach(n => {
        // 尝试从最近的 tab.chat 反查 sid; 拿不到就用 activeSid (对话流里 record fence 出现处就是当前活动 tab)
        let sid = activeSid;
        for (const [s, t] of tabs) { if (t.chat.contains(n)) { sid = s; break; } }
        window.recordWidget.upgrade(n, sid);
      });
    }
  }
}

// 给渲染后的代码块加"复制"按钮(VSCode 式: 右上角悬浮, 点一下复制代码原文)
function decorateCode(container) {
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.copy-btn')) return;              // 幂等, 别重复加
    const code = pre.querySelector('code');
    if (!code) return;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.type = 'button';
    btn.title = t('copy_code');
    btn.textContent = '📋';
    btn.onclick = async (e) => {
      e.stopPropagation();
      const text = code.textContent || '';
      try {
        await navigator.clipboard.writeText(text);
      } catch (_) {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (__) {}
        ta.remove();
      }
      btn.textContent = '✓'; btn.classList.add('copied');
      setTimeout(() => { btn.textContent = '📋'; btn.classList.remove('copied'); }, 1200);
    };
    pre.appendChild(btn);
  });
}

// 界面自己说的话(已恢复历史 / 发送失败 / 已清空…)不进日志, 所以摘掉 dataset.h —— 算进去
// 会让"屏幕上有几条来自日志"虚高, 往上拉就会跳过本该拉回来的那几条。
// 注意历史里的 system 消息(升级说明卡片等)走的是 addMsgTo 不是这里, 记号照打。
function sysMsgTo(tab, text, extra = '') {
  const el = addMsgTo(tab, 'system' + (extra ? ' ' + extra : ''), text, null);
  delete el.dataset.h;
  return el;
}

// SSML 剥标签: 后端 stripSsmlTags 每 chunk 内剥, 跨 chunk 边界(标签断在两 chunk 中间)漏出的靠这里收尾兜底剥.
const SSML_TAG_RE = /<\/?(speak|break|emphasis|prosody|sub|voice|lang|mute|hidden)\b[^>]*\/?>/gi;
const SSML_HIDDEN_RE = /<hidden\b[^>]*>[\s\S]*?<\/hidden>/gi;   // hidden=朗读不显示 → 内容也删

// 收尾当前 AI 文本气泡: 有正文→兜底剥 SSML + 整块 md 渲染; 空占位→撤掉不留空气泡。清 activeBubble。
// 用于: 文本块收尾(onTextDone, 最常走的一条) + 工具调用前 + 插话前(旧轮后续输出排到用户消息下方)。
// 🔴 判空必须在【剥完 SSML + trim】之后。原先顺序是反的: 先拿原文判非空、留下气泡, 再剥标签
// —— 于是"剥完才变空"的两种正文都会渲染成一个空气泡:
//   ① 只有换行/空格的文本块(模型在两次工具调用之间常吐一个空行)
//   ② 语音开着时跨 chunk 边界漏出来的裸 <speak>
// 为什么现象总跟工具连在一起: 每个文本块一收尾就走这里(onTextDone), 工具前后各断一次块,
// 于是那个空行自己占了完整一块 → 定稿成一个带时间戳的空气泡, 正文另起一个。
// 零宽字符(U+200B 等)看不见, trim 却去不掉: 只回一个零宽空格的回合也要算空(10-25 实撞空泡泡)
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
function strippedBubbleText(body) {
  return body.textContent.replace(SSML_HIDDEN_RE, '').replace(SSML_TAG_RE, '').replace(ZERO_WIDTH_RE, '');
}

// 渲染完的气泡里人能看见什么: 字, 或者图/表/控件/公式/流程图/插件框。标记被摘走(pin 搬去常驻板)、
// 只剩空段落的气泡算空 —— 空就是没东西, 不画。
const VISIBLE_SEL = '.md-widget,img,svg,iframe,canvas,video,audio,input,select,textarea,button,table,.math-inline,.math-block,.mermaid-block,.md-svg-wrap';
function bubbleIsEmpty(body) {
  const txt = strippedBubbleText(body).trim();
  return (!txt || txt === '…') && !body.querySelector(VISIBLE_SEL);
}
// 撤气泡必须同步出列: 留死引用 → 计数虚高 → trimChat 提前挤掉活着的消息
function dropBubble(tab, bub) {
  const i = tab.msgEls.indexOf(bub);
  if (i >= 0) tab.msgEls.splice(i, 1);
  bub.remove();
}
// 定稿一个 AI 气泡: 剥标签 → md 渲染 → 渲染后仍空就撤。留下了才算这个标签有新东西(markUnread)。
function settleBubble(tab, bub, text) {
  const body = bodyOf(bub);
  bub.classList.remove('thinking');
  const txt = text == null ? strippedBubbleText(body) : text;
  const seen = txt.replace(ZERO_WIDTH_RE, '').trim();
  if (!seen || seen === '…') { dropBubble(tab, bub); return false; }
  body.textContent = txt;   // 只去标签不 trim: 整段开头的缩进可能是 markdown 代码块的一部分
  renderMd(body);
  if (bubbleIsEmpty(body)) { dropBubble(tab, bub); return false; }
  markUnread(tab);
  return true;
}

function finalizeAssistantBubble(tab) {
  const bub = tab.activeBubble;
  if (!bub) return;
  settleBubble(tab, bub);
  tab.activeBubble = null;
}

// 工具调用 → 一条持久简洁条目(读文件/写文件/跑命令…), 排进消息流不清除
function addToolMsgTo(tab, tool) {
  const el = document.createElement('div');
  el.className = 'msg tool pending';   // 起手 pending (⋯), onToolDone 时 flip 成 done (✔)
  el.dataset.toolName = (tool && tool.name) || '';
  el.innerHTML = `<span class="tool-mark">⋯</span> <span class="tool-desc"></span>`;
  el.querySelector('.tool-desc').textContent = (tool && tool.desc) || String(tool || '');
  tab.chat.appendChild(el);
  tab.msgEls.push(el);   // 工具条也是 .msg, 不登记就永远不会被修剪 —— 上限会被它们悄悄架空
  trimChat(tab);
  tab.pendingToolEls = tab.pendingToolEls || [];
  tab.pendingToolEls.push(el);
  if (tab.activityEl) tab.chat.appendChild(tab.activityEl);   // "进行中"状态行始终吊在底部
  maybeScroll(tab);
  return el;
}

// 会话 status bar 状态机: 让用户一眼看出"AI 能不能被打断/发消息"
// 当前状态记在模块级: 切语言时要按这个重拼一遍, 否则状态条会一直停在旧语言上,
// 直到下一次状态变化 —— 而 idle 状态可以停留几小时。
const statusEl = document.getElementById('statusbar');
let _statusKey = 'idle';
let _statusOverride = null;   // 工具名等实时文本(AI 生成的, 不翻译)
function setStatus(state, text) {
  _statusKey = state || 'idle';
  _statusOverride = text || null;
  if (!statusEl) return;
  const map = { idle: t('status_idle'), thinking: t('status_thinking'), tool: t('status_tool') };
  statusEl.textContent = text || map[_statusKey] || map.idle;
  statusEl.dataset.state = _statusKey;
}

// ---- 活着信号: 气泡下方一行实时状态(转圈 + 当前在干嘛), 出正文/出结果即清 ----
function setActivity(tab, text) {
  if (!tab.activityEl) {
    tab.activityEl = document.createElement('div');
    tab.activityEl.className = 'activity';
    tab.activityEl.innerHTML = '<span class="spinner"></span><span class="atext"></span>';
  }
  tab.activityEl.querySelector('.atext').textContent = text || t('thinking');
  tab.chat.appendChild(tab.activityEl);   // 始终吊在最底
  maybeScroll(tab);
}
function clearActivity(tab) {
  if (tab && tab.activityEl) { tab.activityEl.remove(); tab.activityEl = null; }
}

// ---- 清空整理: 动态指示(spinner + 脉动文字), 别让清空的几秒看起来像假死 ----
function showCompacting(tab, reason) {
  clearCompacting(tab);
  const el = document.createElement('div');
  el.className = 'compacting';
  el.innerHTML = '<span class="spinner"></span><span class="ctext"></span>';
  el.querySelector('.ctext').textContent =
    t('compacting') + (reason && reason !== t('compact_manual') ? ' · ' + reason : '');
  tab.compactingEl = el;
  tab.chat.appendChild(el);
  maybeScroll(tab);
}
function clearCompacting(tab) {
  if (tab && tab.compactingEl) { tab.compactingEl.remove(); tab.compactingEl = null; }
}

// ---- usage 条(只画活动标签) ----
function renderUsage(u) {
  if (!u) { ctxfill.style.width = '0%'; ctxlabel.textContent = t('ctx_empty'); return; }
  const pct = Math.min(u.pct || 0, 100);
  ctxfill.style.width = pct + '%';
  let g = 'linear-gradient(90deg,#4ade80,#22c55e)';
  if (pct >= 80) g = 'linear-gradient(90deg,#f87171,#ef4444)';
  else if (pct >= 60) g = 'linear-gradient(90deg,#fbbf24,#f59e0b)';
  ctxfill.style.background = g;
  const k = (n) => (n >= 1000 ? Math.round(n / 100) / 10 + 'k' : n);
  ctxlabel.textContent = `${u.pct}%  ·  ${k(u.inTok)}/${k(u.window)}`;
}

// 清空键: 活动标签有活动回复时禁用(清空需干净停顿点)
function refreshBusy() {
  const t = activeTab();
  compactBtn.disabled = !t || t.busy;
  // 取消按钮: 只在当前标签 busy 时显示——用户按了发送、正在跑, 才能救援
  if (cancelBtn) cancelBtn.style.display = (t && t.busy) ? '' : 'none';
  // statusbar 兜底: !busy = 一定 idle. busy 时不覆盖(让 onActivity/onTool 自己驱到 thinking/tool).
  // 治两个漏点: ① MCP tool 挂死拿不到 result → 状态永卡 🟡 (切 tab 或 refreshBusy 时就地兜底) ② 切 tab 时状态残留
  if (!t || !t.busy) setStatus('idle');
  if (window.chipsUI) window.chipsUI.setDisabled(!t || t.busy);   // chip 跟 sendBtn 同状态, 防流式中途手滑再塞一条
}

// ---- 头像: emoji 或 字母(名字首字 + 按名字 hash 的稳定背景色) ----
const AVATAR_COLORS = ['#e0567a', '#e08a56', '#c9a227', '#5cae5c', '#4aa3c7', '#6b7ae0', '#a15ce0', '#c74a9e'];
// avatar 字段: 图片(data:/file:/http/绝对路径) → 照片头像; 否则 emoji; 空 → 字母头像
function isImgAvatar(v) { return typeof v === 'string' && /^(data:|file:|https?:|\/)/.test(v); }
function avatarOf(persona) {
  const name = (persona && persona.name) || '?';
  const av = persona && persona.avatar;
  if (av && isImgAvatar(av)) return { img: av };
  if (av) return { emoji: av };
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { letter: [...name][0] || '?', bg: AVATAR_COLORS[h % AVATAR_COLORS.length] };
}
// 标签栏管家帽子: 在标签上叠一个 👑, 一眼看出谁是管家。跟"打开时的管家身份"(openedAsButler)走。
function paintCrown(tabEl, persona) {
  if (!tabEl) return;
  let crown = tabEl.querySelector('.crown');
  const isB = !!(persona && persona.isButler);
  if (isB && !crown) {
    crown = document.createElement('span');
    crown.className = 'crown';
    crown.textContent = '👑';
    crown.title = t('butler');
    tabEl.appendChild(crown);
  } else if (!isB && crown) {
    crown.remove();
  }
}

function paintAvatar(el, persona) {
  if (!el) return;
  const a = avatarOf(persona);
  el.classList.toggle('is-emoji', !!a.emoji);
  el.classList.toggle('is-photo', !!a.img);
  if (a.img) {
    el.textContent = '';
    el.style.backgroundImage = `url("${a.img}")`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
    el.style.backgroundColor = 'transparent';
  } else {
    el.style.backgroundImage = '';
    el.textContent = a.emoji || a.letter;
    el.style.background = a.emoji ? 'transparent' : a.bg;
  }
}

// ---- 建标签 ----
function makeTab(meta, { activate = false } = {}) {
  if (tabs.has(meta.sid)) { if (activate) switchTab(meta.sid); return tabs.get(meta.sid); }

  const panel = document.createElement('section');
  panel.className = 'panel';
  // 常驻板: 每人格一块, 钉上去的界面不随对话滚走。板在 chat 之上, 空的时候整块隐藏。
  const boardEl = document.createElement('div');
  boardEl.className = 'board';
  panel.appendChild(boardEl);
  const chat = document.createElement('div');
  chat.className = 'chat';
  panel.appendChild(chat);
  stage.appendChild(panel);

  const board = window.Board.create({
    document,
    strings: () => S,
    host: () => boardEl, locale: () => curLocale,
    uiPackage: (id) => uiPkgs[id] || null,
    mountUi,
    // 撤下/钉上的黑名单持久化(写在 board.js 里, 读在 loadHistory 渲染前用 setRemoved 补一次)。
    persistRemoved: (removed) => { window.butler.boardStateWrite(meta.sid, removed).catch(() => {}); },
  });

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.title = meta.persona ? meta.persona.name : t('persona');
  const avatarEl = document.createElement('span');
  avatarEl.className = 'avatar';
  paintAvatar(avatarEl, meta.persona);
  const dotEl = document.createElement('span');
  dotEl.className = 'dot';
  tabEl.append(avatarEl, dotEl);
  paintCrown(tabEl, meta.persona);
  tabsEl.appendChild(tabEl);

  const tab = {
    sid: meta.sid, persona: meta.persona, usage: meta.usage,
    panel, chat, board, boardEl, tabEl, avatarEl, dotEl,
    activeBubble: null, busy: false, stick: true, attachments: [], draft: '', loaded: false, unread: false,
    msgEls: [],
  };
  tabs.set(meta.sid, tab);
  // 用户滚动 → 记录是否贴底; 贴底才让新内容自动跟随(见 maybeScroll)
  chat.addEventListener('scroll', () => { if (replayDepth) return;   // 🔴 回放期间一律不响应: 那时不再每条滚到底, 位置一直停在 0, 下面那句会把它当成"用户翻到顶了"一路补页, 同时每次都读 scrollHeight 强制布局 —— 主线程会被占死
    if (tab._autoTop == null || Math.abs(chat.scrollTop - tab._autoTop) > 1) tab.stick = nearBottom(chat);   // 位置没被人动过就不是用户意图
    if (chat.scrollTop < NEAR_TOP_PX) restoreOlder(tab);   // 滚到顶 → 从日志再补一页
  });

  tabEl.addEventListener('click', () => switchTab(meta.sid));

  if (activate) switchTab(meta.sid);
  return tab;
}

// ---- 切标签 ----
async function switchTab(sid) {
  const tab = tabs.get(sid);
  if (!tab || sid === activeSid) { if (tab) tab.panel.classList.add('show'); return; }

  // 存下当前标签的输入草稿
  const prev = activeTab();
  if (prev) { prev.draft = input.value; prev.tabEl.classList.remove('active'); prev.panel.classList.remove('show'); }

  activeSid = sid;
  tab.panel.classList.add('show');
  tab.tabEl.classList.add('active');
  tab.unread = false; tab.tabEl.classList.remove('unread');

  // 顶栏 + 输入草稿 + 附件条切到本标签
  showPersona(tab.persona);
  renderUsage(tab.usage);
  input.value = tab.draft || '';
  input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  renderAttachStrip();
  refreshBusy();
  renderTasks(tab);                                  // 任务清单每人格一份, 切标签换一份
  if (window.chipsUI) window.chipsUI.refresh(sid);   // chip 每人格一套, 切标签换一套

  if (!tab.loaded) await loadHistory(tab);
  tab.stick = true; tab.chat.scrollTop = tab.chat.scrollHeight;   // 切到本标签 → 回底并恢复粘底
  input.focus();
}

async function closeTab(sid) {
  if (tabs.size <= 1) return;   // 至少留一个
  const tab = tabs.get(sid);
  const nm = (tab && tab.persona && tab.persona.name) || t('persona');
  if (!window.confirm(t('close_tab_confirm', { name: nm }))) return;
  const r = await window.butler.closeSession(sid);
  if (!r || !r.ok) return;
  const order = [...tabs.keys()];
  const idx = order.indexOf(sid);
  tab.panel.remove(); tab.tabEl.remove();
  tabs.delete(sid);
  if (activeSid === sid) {
    activeSid = null;
    const next = order[idx + 1] || order[idx - 1];
    if (next) switchTab(next);
  }
}

// #9: 带 imgs 元数据的历史消息要先跟主进程要 base64。这一步是唯一需要 await 的,
// 所以单拎出来 —— 往上翻时要先把整批的图都取完, 再同步描, 见 restoreOlder。
async function fetchHistoryImgs(tab, m) {
  if (!(m && m.role === 'user' && Array.isArray(m.imgs) && m.imgs.length)) return null;
  const srcs = [];
  for (const im of m.imgs) {
    try {
      const r = await window.butler.getAttachment(tab.sid, im.path);
      if (r && r.ok) srcs.push({ src: `data:${im.mediaType};base64,${r.base64}`, alt: im.name });
    } catch (_) { /* 单张失败不阻塞其他 */ }
  }
  return srcs.length ? srcs : null;
}

// 描一条来自历史的消息。**同步**, 中途不许有 await —— 往上翻时靠 tab._insertBefore 把气泡插到
// 顶部, 那个开关挂在 tab 上, 一旦中途让出线程, 此刻正在流式输出的实时气泡也会被插到顶上去。
function paintHistoryMsg(tab, m, srcs) {
  // display:'' = 当初就没画给人看的(包按钮触发、命令没返回人话)。重绘也不该画,
  // 否则关一次窗口再开, 那些机器标记就全冒出来了。
  if (!m || m.display === '') return null;
  let el;
  if (srcs) el = renderImageMessage(tab, m.role, m.text, srcs, m.ts != null ? m.ts : null);
  else if (m.role === 'user' && Array.isArray(m.imgs) && m.imgs.length) {
    el = addMsgTo(tab, m.role, m.text + (m.img ? `  🖼×${m.img}` : ''), m.ts != null ? m.ts : null);
  } else {
    // kind 走进 class: 有些系统消息是卡片(升级说明)而不是居中小灰条, 样式差别在 CSS 里分。
    el = addMsgTo(tab, m.role + (m.kind ? ' ' + m.kind : ''),
      (m.display || m.text) + (m.img ? `  🖼×${m.img}` : ''), m.ts != null ? m.ts : null);
  }
  // md:true 让非 AI 的消息也走 markdown 管线 —— 引擎自己生成给用户看的内容(升级说明)
  // 跟 AI 说的话一样需要排版, 纯文本一坨没人会读。
  if (m.role === 'assistant' || m.md) {
    renderMd(bodyOf(el));
    if (m.role === 'assistant' && !srcs && bubbleIsEmpty(bodyOf(el))) { dropBubble(tab, el); return null; }
  }
  return el;
}

// 开标签走这条(追加到底, 边取边描无所谓); 往上翻走 restoreOlder 里那条。
async function renderHistoryMsg(tab, m) {
  return paintHistoryMsg(tab, m, await fetchHistoryImgs(tab, m));
}

// ---- 载某标签的历史(懒加载, 只一次) ----
async function loadHistory(tab) {
  tab.loaded = true;
  // 「已撤下的槽位」黑名单: 板现在起手就是空的(见下面 setReplaying), 它对开窗口这一刻不再起作用,
  // 但仍是用户"撤下过什么"的唯一记录, 留着不动。
  if (tab.board && typeof tab.board.setRemoved === 'function') {
    try {
      const r = await window.butler.boardStateRead(tab.sid);
      tab.board.setRemoved((r && r.removed) || []);
    } catch (_) {}
  }
  const h = await window.butler.getHistory(tab.sid, SCREEN_MSG_CAP);
  if (h && h.persona) { tab.persona = h.persona; if (tab.sid === activeSid) showPersona(h.persona); }
  if (h && h.usage) { tab.usage = h.usage; if (tab.sid === activeSid) renderUsage(h.usage); }
  if (h && h.messages && h.messages.length) {
    // 🔴 重开窗口不恢复板(作者 2026-08-27): 历史里的 {{pin:...}} 印一律只摘不钉, 板起手是空的,
    //    要用户重新钉才出来。开关就是 replaying —— 印的处理在 renderMd → board.harvest 那条路上。
    const _bd = tab.board && typeof tab.board.setReplaying === 'function' ? tab.board : null;
    if (_bd) _bd.setReplaying(true); replayDepth++;
    try { for (const m of h.messages) await renderHistoryMsg(tab, m); } finally { replayDepth--; if (_bd) _bd.setReplaying(false); trimChat(tab); maybeScroll(tab); }
    sysMsgTo(tab, t('history_resumed'));
  } else {
    sysMsgTo(tab, t('ready'));
  }
}

// ---- 附件(活动标签的) ----
function renderAttachStrip() {
  const tab = activeTab();
  const list = tab ? tab.attachments : [];
  attachstrip.innerHTML = '';
  attachstrip.style.display = list.length ? 'flex' : 'none';
  list.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'thumb';
    if ((a.mediaType || '').startsWith('image/')) {
      const src = `data:${a.mediaType};base64,${a.base64}`;
      const img = document.createElement('img');
      img.src = src; img.alt = a.name || '';
      img.onclick = () => openLightbox(src);   // × 在 img 之外, 删除不会误触发放大
      const x = document.createElement('span'); x.className = 'x'; x.textContent = '×';
      x.onclick = () => { list.splice(i, 1); renderAttachStrip(); };
      chip.append(img, x);
    } else {
      chip.classList.add('file');
      const ico = document.createElement('span'); ico.className = 'fico'; ico.textContent = '📄';
      const nm = document.createElement('span'); nm.className = 'fname'; nm.textContent = a.name || 'file';
      const x = document.createElement('span'); x.className = 'x'; x.textContent = '×';
      x.onclick = () => { list.splice(i, 1); renderAttachStrip(); };
      chip.append(ico, nm, x);
    }
    attachstrip.appendChild(chip);
  });
}
function fileToAttachment(file) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => {
      const b64 = String(r.result).split(',')[1] || '';
      resolve({ mediaType: file.type || 'application/octet-stream', base64: b64, name: file.name || 'file' });
    };
    r.readAsDataURL(file);
  });
}
async function addFiles(files) {
  const tab = activeTab();
  if (!tab) return;
  for (const f of files) {
    if (f) tab.attachments.push(await fileToAttachment(f));   // 任意文件, 不再限图片
  }
  renderAttachStrip();
}

// ---- 发送(发到活动标签; 跑动中=软插话) ----
async function send() {
  const tab = activeTab();
  if (!tab) return;
  const text = input.value.trim();
  if (!text && !tab.attachments.length) return;
  tab.stick = true;   // 用户主动发言 → 跳回底部跟随
  const toSend = tab.attachments.slice();
  tab.lastSubmittedText = text;   // 暂存原文, 用于取消后回填草稿(不丢用户已打的字)
  input.value = ''; input.style.height = 'auto'; tab.draft = '';
  // 插话(软插话): 上一轮还在流式 → 先收尾当前 AI 气泡, 使旧轮后续输出排到本条用户消息之下(不再在上方旧气泡里长)
  const interjecting = !!tab.activeBubble;
  if (interjecting) finalizeAssistantBubble(tab);
  // #9 图片附件: 用手里已有 dataURL 立即渲缩略图; 非图片仍显 📎×N (本轮 #9 精简范围: 非图片下载能力不做)
  const imgSrcs = toSend.filter(a => (a.mediaType || '').startsWith('image/'))
    .map(a => ({ src: `data:${a.mediaType};base64,${a.base64}`, alt: a.name }));
  const nonImgN = toSend.length - imgSrcs.length;
  const suffix = nonImgN > 0 ? `  📎×${nonImgN}` : '';
  if (imgSrcs.length) renderImageMessage(tab, 'user', text + suffix, imgSrcs);
  else addMsgTo(tab, 'user', text + suffix);
  // #8 A: 治感知层 — tool 循环中 push 的 msg 得等本轮 SDK 读队列(数据未丢, 只是延迟). 立刻给用户一行明示, 避免以为被吞
  if (interjecting) sysMsgTo(tab, t('queued'));
  tab.attachments = []; renderAttachStrip();
  tab.busy = true;
  // 新一轮才起占位思考气泡; 插话时不起(旧轮后续 onChunk 会在用户消息下方自建气泡, 避免 finalText 兜底重复正文)
  if (!interjecting) { tab.activeBubble = addMsgTo(tab, 'assistant', '…'); tab.activeBubble.classList.add('thinking'); }
  refreshBusy();
  setActivity(tab, t('thinking'));
  if (tab.sid === activeSid) setStatus('thinking');   // 显式切: 免依赖 onActivity 到达前的小空窗残留 idle
  try {
    const r = await window.butler.send(tab.sid, { text, attachments: toSend });
    if (r && !r.ok) sysMsgTo(tab, t('send_error') + r.error);
  } catch (e) { sysMsgTo(tab, t('send_error') + e); }
  input.focus();
}

async function doCompact() {
  const tab = activeTab();
  if (!tab) return;
  compactBtn.disabled = true;
  // 进行中提示改由 onCompacting 动态指示接管(spinner), 这里不再塞静态文字
  const r = await window.butler.compact(tab.sid);
  if (r.ok) sysMsgTo(tab, t('compact_done'), 'compact');
  else sysMsgTo(tab, t('compact_failed') + (r.error || r.note), 'compact');
  refreshBusy();
}

// ---- 事件(按 sid 分发到对应标签) ----
function markUnread(tab) {
  if (tab.sid !== activeSid) { tab.unread = true; tab.tabEl.classList.add('unread'); }
}
window.butler.onUserEcho((sid, text) => {   // 程序注入的消息(如 butler 出生教育)显示成 user 气泡
  const tab = tabs.get(sid);
  if (!tab || !String(text || '').trim()) return;
  addMsgTo(tab, 'user', text);
  maybeScroll(tab);
  markUnread(tab);
});
window.butler.onChunk((sid, t) => {
  const tab = tabs.get(sid);
  if (!tab) return;
  if (!tab.activeBubble) { tab.activeBubble = addMsgTo(tab, 'assistant', ''); if (tab.sid === activeSid) refreshBusy(); }
  const body = bodyOf(tab.activeBubble);
  if (body.textContent === '…') body.textContent = '';
  tab.activeBubble.classList.remove('thinking');   // 开始出正文 → 撤脉动占位
  clearActivity(tab);                              // 出字了, 状态行让位给正文
  body.textContent += t;                           // 流式逐字进 body(纯文本), 收尾再 md 渲染
  maybeScroll(tab);
});
// 文本块一收尾就定稿, 不等整轮 result: 我说完话转去调工具时, 工具参数(写文件/长 prompt)可能还要生成几十秒,
// 那期间正文若不渲染就是一坨生 markdown, {{btn}} 也还没变成能点的 DOM。
window.butler.onTextDone((sid) => {
  const tab = tabs.get(sid);
  if (!tab) return;
  finalizeAssistantBubble(tab);
  maybeScroll(tab);
});
window.butler.onResult((sid, { finalText, interrupted }) => {
  const tab = tabs.get(sid);
  if (!tab) return;
  clearActivity(tab);   // 一段回复收尾, 撤活动状态行
  if (tab.activeBubble) {
    const body = bodyOf(tab.activeBubble);
    tab.activeBubble.classList.remove('thinking');
    // 用同一套"剥完再判"的判据。拿原文判的话, 只剩空白/只剩标签的气泡会被当成有正文,
    // 于是既不走 finalText 兜底、也不撤掉 —— 这是另一份独立实现, 上面修了这里不修就白修。
    const txt = strippedBubbleText(body).trim();
    if (!txt || txt === '…') {
      // 本气泡没收到流式正文: 有 finalText 兜底填(md 渲染, 渲染后仍空照撤); 否则撤空气泡(被打断/只调了工具)
      if (interrupted && !(finalText && finalText.trim())) { body.textContent = '⏸'; }
      else settleBubble(tab, tab.activeBubble, finalText || '');
    } else finalizeAssistantBubble(tab);   // 正常收尾(剥 SSML + md 渲染) —— 多数情况已被 onTextDone 提前做掉
    tab.activeBubble = null;
  }
  tab.busy = false;
  if (tab.sid === activeSid) { refreshBusy(); setStatus('idle'); }
});
window.butler.onActivity((sid, text) => {
  const tab = tabs.get(sid);
  if (!tab) return;
  setActivity(tab, text);   // 实时显示"正在读文件/跑命令/搜索…" → 静默期也知道我活着
  if (sid === activeSid) setStatus('thinking', text ? `🔵 ${text}` : null);
});
// 工具完成: flip 对应 pending tool 气泡 → done (⋯ → ✔). FIFO shift (agent.js 里 pendingTools 也是 FIFO).
window.butler.onToolDone((sid, info) => {
  const tab = tabs.get(sid);
  if (!tab || !tab.pendingToolEls || !tab.pendingToolEls.length) return;
  const el = tab.pendingToolEls.shift();
  if (!el) return;
  el.classList.remove('pending');
  el.classList.add('done');
  const mark = el.querySelector('.tool-mark');
  if (mark) mark.textContent = '✔';
});
window.butler.onTool((sid, tool) => {
  const tab = tabs.get(sid);
  if (!tab) return;
  if (sid === activeSid) setStatus('tool', tool && tool.desc ? `🟡 ${tool.desc}` : null);
  finalizeAssistantBubble(tab);   // 工具前收尾当前文本气泡 → 顺序: 文本→工具→后续文本
  addToolMsgTo(tab, tool);        // 持久条目, 不清除
  markUnread(tab);
});
// AI 自己那份任务清单。它一直存在于 SDK 那层, 但从来没画出来过 ——
// 看不见的清单等于没有清单: 人不知道 AI 认为自己还欠几件事, AI 也少了一处"没做完"的提醒。
window.butler.onTasks((sid, tasks) => {
  const tab = tabs.get(sid);
  if (!tab) return;
  tab.tasks = tasks || [];
  if (sid === activeSid) renderTasks(tab);
});

function renderTasks(tab) {
  let box = document.getElementById('taskpanel');
  if (!box) {
    box = document.createElement('div');
    box.id = 'taskpanel';
    const strip = document.getElementById('attachstrip');
    strip.parentNode.insertBefore(box, strip);
  }
  const list = tab.tasks || [];
  const left = list.filter((t) => t.status !== 'completed').length;
  if (!list.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  // blocked = 卡在别人身上(task 的 blocked 参数派生的第五态), 不标出来就跟没开始的 ○ 混在一起
  const MARK = { completed: '✔', in_progress: '▶', pending: '○', blocked: '⏸' };
  box.innerHTML = `<div class="tp-head">${t('tasks_left').replace('{n}', left).replace('{total}', list.length)}</div>`
    + list.map((t) => `<div class="tp-row ${t.status}"><span class="tp-mark">${MARK[t.status] || '○'}</span>`
        + `<span class="tp-txt"></span></div>`).join('');
  // 文本用 textContent 落, 不拼进 HTML —— 任务标题是模型写的, 拼字符串就是一个 XSS 口子
  box.querySelectorAll('.tp-txt').forEach((el, i) => {
    el.textContent = list[i].subject || '';
    if (list[i].blockedReason) el.title = list[i].blockedReason;   // 悬停看在等什么
  });
}

window.butler.onCompacting((sid, s) => {
  const tab = tabs.get(sid);
  if (!tab) return;
  if (s.phase === 'start') showCompacting(tab, s.reason);   // 动态"正在清空整理"指示
  else clearCompacting(tab);                                // 清空结束撤指示(done 消息另有)
  if (s.autoDoneReason) { sysMsgTo(tab, t('auto_compact_done', { reason: s.autoDoneReason }), 'compact'); markUnread(tab); }   // 回合末自动整理完成
});
window.butler.onUsage((sid, u) => {
  const tab = tabs.get(sid);
  if (!tab) return;
  tab.usage = u;
  if (tab.sid === activeSid) renderUsage(u);
});
// ---- 认证失效横幅 ----
// 凭证是所有人格共用的, 一个坏必然全坏 → 横幅是全局一条, 不按 sid 分。
// 点重新登录会开浏览器; main 那边登完自动重建所有人格子进程 + 回放暂存消息, 不用重启 app。
const authBanner = document.getElementById('authBanner');
const authBannerText = document.getElementById('authBannerText');
const authReloginBtn = document.getElementById('authReloginBtn');

// 🔴 重登按钮只给 oauth_expired —— 那是唯一一类重登真能修的。其余三类给按钮等于把人往死路上指:
// 额度满、key 写错、403 组织校验, 重登一万次也是同一个结果。它们改为显示报错原文, 让用户
// 看得见真因(2026-08-26 之前全部被说成"登录失效", 于是有人反复重登, 永远修不好)。
const ACCESS_BANNER_TEXT = {
  oauth_expired: 'auth_expired_named',
  quota: 'access_quota_named',
  org_forbidden: 'access_org_forbidden_named',
  key_bad: 'access_key_bad_named',
  no_model: 'access_no_model_named',
};
window.butler.onAuthExpired((d) => {
  const kind = (d && d.kind) || 'oauth_expired';
  const name = (d && d.name) ? d.name : 'AI';
  let msg = t(ACCESS_BANNER_TEXT[kind] || 'auth_expired_named', { name });
  // 认不出来的那类连文案都不该编 —— 原样显示, 别给结论。
  if (d && d.raw && kind !== 'oauth_expired') msg += ' · ' + t('access_raw_detail', { raw: d.raw });
  authBannerText.textContent = msg;
  authBanner.classList.remove('hidden');
  if (kind === 'oauth_expired') {
    authReloginBtn.classList.remove('hidden');
    authReloginBtn.disabled = false;
    authReloginBtn.textContent = t('relogin');
  } else {
    authReloginBtn.classList.add('hidden');
  }
});
window.butler.onAuthOk(() => authBanner.classList.add('hidden'));

// 首登点了"连接 Claude": 授权在后台跑, 启动不再等它 → 这条横幅就是它唯一的进度显示。
// 等待期间把按钮收起来: 那次授权已经在飞, 再点一次只会跟上同一个单飞, 白点。
window.butler.onAuthPending((d) => {
  if (d && d.done) {
    authBannerText.textContent = t('relogin_failed', { err: d.error || t('unknown_error') });
    authReloginBtn.classList.remove('hidden');
    authReloginBtn.disabled = false;
    authReloginBtn.textContent = t('relogin_retry');
  } else {
    authBannerText.textContent = t('auth_waiting_browser');
    authReloginBtn.classList.add('hidden');
  }
  authBanner.classList.remove('hidden');
});

authReloginBtn.addEventListener('click', async () => {
  authReloginBtn.disabled = true;
  authReloginBtn.textContent = t('relogin_ing');
  authBannerText.textContent = t('relogin_browser');
  const r = await window.butler.relogin();
  if (r && r.ok) {
    authBanner.classList.add('hidden');
  } else {
    authBannerText.textContent = t('relogin_failed', { err: (r && r.error) || t('unknown_error') });
    authReloginBtn.disabled = false;
    authReloginBtn.textContent = t('relogin_retry');
  }
});

// AskUserQuestion 模态框: SDK 派 request_user_dialog → main 转发到这里 → 弹卡片让用户选 → answerUserDialog 回填.
// SDK 期望的 result shape (AskUserQuestionOutput): { questions, answers:{qText:optLabel|"a, b"}, response?, annotations? }
// 用户按取消/关闭 → answer=null → SDK 收 cancelled 兜底.
window.butler.onUserDialog(({ sid, dialogId, kind, payload }) => {
  console.log('[DIALOG-DIAG#4] renderer got user-dialog', { sid, dialogId, kind, payload });
  const questions = (payload && Array.isArray(payload.questions)) ? payload.questions : [];
  if (!questions.length) { console.warn('[DIALOG-DIAG#4b] questions empty → auto cancel', { payloadKeys: payload ? Object.keys(payload) : [] }); window.butler.answerUserDialog(sid, dialogId, null); return; }
  console.log('[DIALOG-DIAG#4c] opening modal with', questions.length, 'questions');
  showDialogModal({ sid, dialogId, kind, questions });
});

// 只允许一个 modal 同时存在: 后来的自动 cancel 前一个 (SDK 一次只应挂一个 dialog, 稳妥防呆).
let _activeDialog = null;
function showDialogModal({ sid, dialogId, kind, questions }) {
  if (_activeDialog) { try { _activeDialog.cancel(); } catch {} _activeDialog = null; }

  const overlay = document.createElement('div');
  overlay.id = 'dialogOverlay';
  const card = document.createElement('div');
  card.className = 'dialog-card';
  overlay.appendChild(card);

  // header: 来源人格名, 便于多人格并发时看清是谁在问
  const tab = tabs.get(sid);
  const from = (tab && tab.persona && tab.persona.name) || '?';
  const header = document.createElement('div');
  header.className = 'dialog-header';
  header.innerHTML = `<span class="badge">${escapeHtml(from)}</span><span>${escapeHtml(t('ask_label'))} · ${escapeHtml(kind || 'question')}</span>`;
  card.appendChild(header);

  // 每题的当前选择状态: state[qIdx] = Set<optIdx> (单选 size≤1, 多选 size≥0)
  const state = questions.map(() => new Set());
  const otherInputs = questions.map(() => '');   // 每题的 "其他" 自由输入

  questions.forEach((q, qIdx) => {
    const qBox = document.createElement('div');
    qBox.className = 'dialog-q';

    const qHdr = document.createElement('div');
    qHdr.className = 'dialog-q-header';
    if (q.header) qHdr.innerHTML = `<span class="dialog-q-chip">${escapeHtml(q.header)}</span>`;
    qHdr.insertAdjacentHTML('beforeend', `<span class="dialog-q-title">${escapeHtml(q.question || '')}</span>`);
    qBox.appendChild(qHdr);
    if (q.multiSelect) qBox.insertAdjacentHTML('beforeend', `<div class="dialog-q-sub">${escapeHtml(t('multi_select'))}</div>`);

    const optsBox = document.createElement('div');
    optsBox.className = 'dialog-opts';
    (q.options || []).forEach((opt, oIdx) => {
      const optEl = document.createElement('label');
      optEl.className = 'dialog-opt';
      const input = document.createElement('input');
      input.type = q.multiSelect ? 'checkbox' : 'radio';
      input.name = `dlg-${qIdx}`;
      input.addEventListener('change', () => {
        if (q.multiSelect) {
          if (input.checked) state[qIdx].add(oIdx); else state[qIdx].delete(oIdx);
        } else {
          state[qIdx].clear(); state[qIdx].add(oIdx);
        }
        optsBox.querySelectorAll('.dialog-opt').forEach((el, i) => el.classList.toggle('selected', state[qIdx].has(i)));
        refreshSubmit();
      });
      optEl.appendChild(input);
      const body = document.createElement('div');
      body.className = 'dialog-opt-body';
      body.innerHTML = `<div class="dialog-opt-label">${escapeHtml(opt.label || '')}</div>`
        + (opt.description ? `<div class="dialog-opt-desc">${escapeHtml(opt.description)}</div>` : '')
        + (opt.preview ? `<div class="dialog-opt-preview">${escapeHtml(opt.preview)}</div>` : '');
      optEl.appendChild(body);
      optsBox.appendChild(optEl);
    });
    qBox.appendChild(optsBox);

    // "其他" 自由输入 — SDK 承诺自动提供 Other 通道, 我们做输入框收集. 有值时也算已答.
    const other = document.createElement('input');
    other.className = 'dialog-other-input';
    other.placeholder = t('other_ph');
    other.addEventListener('input', () => { otherInputs[qIdx] = other.value.trim(); refreshSubmit(); });
    qBox.appendChild(other);

    card.appendChild(qBox);
  });

  const footer = document.createElement('div');
  footer.className = 'dialog-footer';
  const btnCancel = document.createElement('button');
  btnCancel.className = 'dialog-btn-cancel';
  btnCancel.textContent = t('cancel');
  const btnSubmit = document.createElement('button');
  btnSubmit.className = 'dialog-btn-submit';
  btnSubmit.textContent = t('submit');
  footer.appendChild(btnCancel);
  footer.appendChild(btnSubmit);
  card.appendChild(footer);

  function refreshSubmit() {
    // 每问必须有答案(选项 or 其他文本)才允许提交
    const allAnswered = questions.every((q, i) => state[i].size > 0 || otherInputs[i].length > 0);
    btnSubmit.disabled = !allAnswered;
  }
  refreshSubmit();

  const cleanup = () => { overlay.remove(); _activeDialog = null; document.removeEventListener('keydown', onKey); };
  const cancel = () => { cleanup(); window.butler.answerUserDialog(sid, dialogId, null); };
  const submit = () => {
    if (btnSubmit.disabled) return;
    const answers = {};
    const annotations = {};
    const responseParts = [];
    questions.forEach((q, i) => {
      const picked = [...state[i]].map((oi) => q.options[oi]?.label).filter(Boolean);
      if (picked.length) answers[q.question] = picked.join(', ');
      // preview 有内容且选中了 → 塞 annotations, 忠实 SDK 语义
      const previews = [...state[i]].map((oi) => q.options[oi]?.preview).filter(Boolean);
      if (previews.length) annotations[q.question] = { preview: previews.join('\n---\n') };
      if (otherInputs[i]) {
        // "其他" 也算 answer (SDK: response 字段合并所有 freeform)
        if (!answers[q.question]) answers[q.question] = otherInputs[i];
        responseParts.push(`${q.header || q.question}: ${otherInputs[i]}`);
      }
    });
    const payloadOut = { questions, answers };
    if (responseParts.length) payloadOut.response = responseParts.join('\n');
    if (Object.keys(annotations).length) payloadOut.annotations = annotations;
    cleanup();
    window.butler.answerUserDialog(sid, dialogId, payloadOut);
  };
  btnCancel.addEventListener('click', cancel);
  btnSubmit.addEventListener('click', submit);

  const onKey = (e) => { if (e.key === 'Escape') cancel(); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) cancel(); });

  _activeDialog = { cancel };
  document.body.appendChild(overlay);
}

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// plugin_open → 主进程直接把界面标记推来, 这里当成一条 AI 气泡渲染(renderMd 内部会 widgets.paint 建成真控件)。
// 工具调用早于模型吐字, 所以界面落在它那句话上方 —— 先出东西再出解说, 顺序正好。
window.butler.onPluginRender((sid, text) => {
  const tab = tabs.get(sid);
  if (!tab || !text) return;
  settleBubble(tab, addMsgTo(tab, 'assistant', text, Date.now()), text);
});

// 主进程推来 → 加标签或刷标签。⚠️ 焦点只跟 activate 走: 这个事件也被拿来纯刷状态(人格自己调
// voice_switch / 改名换头像), 无条件切标签会把用户正在看的窗口拽走。没带 activate 的留在原地。
window.butler.onPersonaOpened((meta, activate) => {
  if (!meta || !meta.sid) return;
  const existing = tabs.get(meta.sid);
  if (existing && meta.persona) {
    existing.persona = meta.persona;
    existing.tabEl.title = meta.persona.name || t('persona');
    paintAvatar(existing.avatarEl, meta.persona);
    paintCrown(existing.tabEl, meta.persona);
    if (meta.sid === activeSid) showPersona(meta.persona);
    if (activate) switchTab(meta.sid);
    return;
  }
  makeTab(meta, { activate: !!activate });
});

// ---- 输入交互 ----
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
});
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; });
input.addEventListener('paste', (e) => {
  const items = (e.clipboardData || {}).items || [];
  const imgs = [];
  for (const it of items) if (it.kind === 'file' && it.type.startsWith('image/')) imgs.push(it.getAsFile());
  if (imgs.length) { e.preventDefault(); addFiles(imgs); }
});
document.body.addEventListener('dragover', (e) => e.preventDefault());
document.body.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files.length) addFiles(fileInput.files); fileInput.value = ''; });
sendBtn.addEventListener('click', send);

// ---- 语音输入 (STT): 点开始录 · 再点结束转文字 · whisper.cpp 本地 ----
// 引擎/模型不打包: 首次录音探测不到就问一声代下代装 (Mac 需用户先有 brew), 装不了才给提示, 不阻塞主功能.
let _voiceStatus = null;
async function ensureVoiceStatus() {
  if (_voiceStatus !== null) return _voiceStatus;
  _voiceStatus = await window.butler.voiceStatus();
  return _voiceStatus;
}

// 安装进度只注册一次监听, 由当前那次安装认领, 免得每点一次麦克风就多挂一个 handler
let _voiceProgressSink = null;
window.butler.onVoiceSetupProgress((p) => { if (_voiceProgressSink) _voiceProgressSink(p); });

// 缺引擎/模型 → 问一声就代下代装 (别让用户自己去敲命令). 返回: 现在能不能录
async function ensureVoiceReady(tab, st) {
  if (!st.canAutoInstall) {
    sysMsgTo(tab, t('voice_unavailable') + `${st.error}${st.hintCode ? `\n\n${t(st.hintCode)}` : ''}`);
    return false;
  }
  const what = st.error === 'no_model' ? t('voice_model_only') : t('voice_engine_and_model');
  // wrong_cli 的用户机器上已经有个"whisper", 只是版本不对 —— 跟他说"首次使用"会让他一头雾水
  const why = st.error === 'wrong_cli'
    ? t('voice_wrong_cli', { cli: st.cli, what })
    : t('voice_first_time', { what });
  if (!window.confirm(t('voice_confirm', { why }))) return false;
  const bub = sysMsgTo(tab, t('voice_preparing'));
  _voiceProgressSink = (p) => { bodyOf(bub).textContent = `⏬ ${t(p.noteCode) || p.noteCode}${p.pct ? ` · ${p.pct}%` : ''}`; };
  try {
    const r = await window.butler.voiceSetup();
    if (!r || !r.ok) {
      bodyOf(bub).textContent = t('voice_install_failed') + ((r && ((r.hintCode && t(r.hintCode)) || r.error)) || t('unknown_error'));
      return false;
    }
    bodyOf(bub).textContent = t('voice_ready');
    _voiceStatus = r;   // 覆盖掉之前缓存的失败结果
    return true;
  } catch (e) {
    bodyOf(bub).textContent = t('voice_install_failed') + (e && e.message || e);
    return false;
  } finally {
    _voiceProgressSink = null;
  }
}
async function toggleMic() {
  const tab = activeTab(); if (!tab) return;
  if (window.audioRecorder && window.audioRecorder.active) {
    // 结束录音 → 转文字
    micBtn.classList.remove('recording');
    micBtn.disabled = true;
    micBtn.textContent = '⏳';
    try {
      const wav = await window.audioRecorder.stop();
      if (!wav || wav.byteLength < 2000) {   // <~0.06s: 太短当没录
        sysMsgTo(tab, t('rec_too_short'));
        return;
      }
      const r = await window.butler.transcribeAudio(wav, 'auto');
      if (r && r.ok) {
        const t = (r.text || '').replace(/^\s+/, '');
        // 追加到已有草稿末尾(不覆盖用户已打的字), 前后加空格
        const cur = input.value;
        input.value = cur ? (cur.replace(/\s+$/, '') + ' ' + t) : t;
        input.dispatchEvent(new Event('input'));   // 触发 auto-resize
        tab.draft = input.value;
        input.focus();
      } else {
        const hint = r && r.hintCode ? ` · ${t(r.hintCode)}` : '';
        sysMsgTo(tab, t('transcribe_failed') + `${(r && r.error) || t('unknown_error')}${hint}`);
      }
    } catch (e) {
      sysMsgTo(tab, t('transcribe_failed') + (e && e.message || e));
    } finally {
      micBtn.disabled = false;
      micBtn.textContent = '🎤';
    }
  } else {
    // 开始录音: 先探 whisper 装了没, 没装就问一声代装
    const st = await ensureVoiceStatus();
    if (!st.ok && !(await ensureVoiceReady(tab, st))) return;
    try {
      await window.audioRecorder.start();
      micBtn.classList.add('recording');
      micBtn.textContent = '⏹';
      micBtn.title = t('mic_stop_hint');
    } catch (e) {
      sysMsgTo(tab, t('mic_denied') + (e && e.message || e));
    }
  }
}
if (micBtn) micBtn.addEventListener('click', toggleMic);

// ---- record fence widget 提交入口: 把 [audio:...] 当 user 消息发到指定 tab ----
// 走 send 的核心副作用 (气泡 + busy + IPC), 不经 input DOM.
// display: 屏幕上画什么。不传就跟 text 一样 —— 只有包按钮那条路两者不同(见 runCommand),
// 它发给模型的是带 [命令名] 的机器标记, 给人看的是命令返回的人话。
// 🔴 display 传空串 = 这条消息给模型不给人, 屏幕上一个气泡都不画。所以判据是 == null(没传)
// 而不是真假 —— 用真假的话空串会退回去画 text, 那正是要躲的机器标记。
window.emitUserMessage = function (sid, text, display) {
  const tab = tabs.get(sid); if (!tab) return;
  const shown = (display == null) ? text : display;
  const interjecting = !!tab.activeBubble;
  if (interjecting) finalizeAssistantBubble(tab);
  if (shown) addMsgTo(tab, 'user', shown);
  if (interjecting) sysMsgTo(tab, t('queued'));
  tab.busy = true;
  if (!interjecting) { tab.activeBubble = addMsgTo(tab, 'assistant', '…'); tab.activeBubble.classList.add('thinking'); }
  refreshBusy();
  setActivity(tab, t('thinking'));
  if (tab.sid === activeSid) setStatus('thinking');
  // display 也要落盘: 只在发出那一刻不画机器标记是治标的, 重开窗口 loadHistory 会把它原样重画。
  window.butler.send(sid, { text, display: (display != null && display !== text) ? display : undefined })
    .catch((e) => sysMsgTo(tab, t('send_error') + e));
};
if (cancelBtn) cancelBtn.addEventListener('click', async () => {
  const tab = activeTab();
  if (!tab || !tab.busy) return;
  cancelBtn.disabled = true;
  try {
    await window.butler.cancelCurrent(tab.sid);
    // 草稿回填: 只在 input 空的时候, 把用户上次发的原文放回去 → 方便修改后重发, 别覆盖用户已经在打的新字
    if (!input.value && tab.lastSubmittedText) {
      input.value = tab.lastSubmittedText;
      tab.draft = tab.lastSubmittedText;
      input.focus();
      // auto-resize 让文本框展开到能看全
      input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 300) + 'px';
    }
    // busy 由 onResult(interrupted=true) 路径清; 这里只清按钮 disabled
  } finally { cancelBtn.disabled = false; }
});
compactBtn.addEventListener('click', doCompact);
// ＋号 = 弹已登记人格 picker; 底部两条 "新建人格…"/"管理人格…" 打开管理窗口。已开的置灰。
async function showPicker() {
  const existing = document.querySelector('.picker-mask');
  if (existing) { existing.remove(); return; }
  const r = await window.butler.listPersonas();
  const list = (r && r.personas) || [];
  const mask = document.createElement('div'); mask.className = 'picker-mask';
  const pop = document.createElement('div'); pop.className = 'picker';
  mask.appendChild(pop);
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
  const addItem = (opts) => {
    const it = document.createElement('div');
    it.className = 'p-item' + (opts.open ? ' open' : '') + (opts.action ? ' p-action' : '');
    it.innerHTML = `<span class="p-name">${opts.label}</span>` +
      (opts.butler ? `<span class="p-tag butler">${escapeHtml(t('butler'))}</span>` : '') +
      (opts.open ? `<span class="p-tag">${escapeHtml(t('opened'))}</span>` : '');
    if (!opts.open && opts.onClick) it.addEventListener('click', () => { mask.remove(); opts.onClick(); });
    pop.appendChild(it);
  };
  for (const p of list) {
    addItem({ label: p.name, butler: p.isButler, open: p.open,
      onClick: async () => { await window.butler.openPersonaRef(p.id); } });
  }
  if (list.length) { const sep = document.createElement('div'); sep.className = 'p-sep'; pop.appendChild(sep); }
  addItem({ label: t('new_persona_menu'), action: true, onClick: () => window.butler.openManagerWindow() });
  addItem({ label: t('manage_persona_menu'), action: true, onClick: () => window.butler.openManagerWindow() });
  document.body.appendChild(mask);
}
newTabBtn.addEventListener('click', showPicker);
closeCurrentBtn.addEventListener('click', () => { if (activeSid) closeTab(activeSid); });
settingsBtn.addEventListener('click', () => window.butler.openSettingsWindow());

// ---- 聊天检索 (Cmd/Ctrl+F): 当前对话内文本高亮 + 上/下跳转 ----
const searchbar = document.getElementById('searchbar');
const searchInput = document.getElementById('searchInput');
const searchCount = document.getElementById('searchCount');
let searchHits = [], searchIdx = -1;
function clearSearchHl(root) {
  if (!root) return;
  root.querySelectorAll('mark.search-hit').forEach((m) => {
    const t = document.createTextNode(m.textContent); m.parentNode.replaceChild(t, m);
  });
  root.normalize();
}
function runSearch(q) {
  const tab = activeTab(); if (!tab) return;
  clearSearchHl(tab.chat);
  searchHits = []; searchIdx = -1;
  if (q) {
    const ql = q.toLowerCase();
    const nodes = [];
    const w = document.createTreeWalker(tab.chat, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { const n = w.currentNode; if (n.nodeValue && n.parentNode && n.parentNode.nodeName !== 'MARK') nodes.push(n); }
    for (const node of nodes) {
      const text = node.nodeValue, lower = text.toLowerCase();
      let idx = lower.indexOf(ql); if (idx < 0) continue;
      const frag = document.createDocumentFragment(); let last = 0;
      while (idx >= 0) {
        if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
        const mk = document.createElement('mark'); mk.className = 'search-hit'; mk.textContent = text.slice(idx, idx + q.length);
        frag.appendChild(mk); searchHits.push(mk);
        last = idx + q.length; idx = lower.indexOf(ql, last);
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }
  if (searchHits.length) gotoHit(0);
  updateSearchCount();
}
function gotoHit(i) {
  if (!searchHits.length) { updateSearchCount(); return; }
  if (searchIdx >= 0 && searchHits[searchIdx]) searchHits[searchIdx].classList.remove('current');
  searchIdx = (i + searchHits.length) % searchHits.length;
  const m = searchHits[searchIdx];
  m.classList.add('current');
  m.scrollIntoView({ block: 'center', behavior: 'smooth' });
  updateSearchCount();
}
function updateSearchCount() {
  searchCount.textContent = searchHits.length ? `${searchIdx + 1}/${searchHits.length}` : '0/0';
}
function openSearch() {
  searchbar.classList.remove('hidden');
  searchInput.focus(); searchInput.select();
  if (searchInput.value) runSearch(searchInput.value);
}
function closeSearch() {
  const tab = activeTab(); if (tab) clearSearchHl(tab.chat);
  searchHits = []; searchIdx = -1;
  searchbar.classList.add('hidden');
  input.focus();
}
searchInput.addEventListener('input', () => runSearch(searchInput.value));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); gotoHit(searchIdx + (e.shiftKey ? -1 : 1)); }
  else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
});
document.getElementById('searchNext').addEventListener('click', () => gotoHit(searchIdx + 1));
document.getElementById('searchPrev').addEventListener('click', () => gotoHit(searchIdx - 1));
document.getElementById('searchClose').addEventListener('click', closeSearch);
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openSearch(); }
});
// 登记簿变了(改名/删/头像) → 同步已开标签的名字/头像/顶栏。也在启动时调一次(重启后 meta 可能是旧的, 头像不刷)。
async function refreshTabsFromRegistry() {
  const r = await window.butler.listPersonas();
  const map = new Map(((r && r.personas) || []).map((p) => [p.homeDir, p]));
  for (const [sid, tab] of tabs) {
    const p = map.get(sid);
    if (p && tab.persona && (p.name !== tab.persona.name || p.avatar !== tab.persona.avatar)) {
      tab.persona.name = p.name; tab.persona.avatar = p.avatar;
      tab.tabEl.title = p.name;
      paintAvatar(tab.avatarEl, tab.persona);
      if (sid === activeSid) showPersona(tab.persona);
    }
  }
}
window.butler.onRegistryChanged && window.butler.onRegistryChanged(refreshTabsFromRegistry);
// AI 调 update_prompt_chips 换了自己的快捷按钮 → 就地重渲(只动对应标签)
window.butler.onChipsChanged && window.butler.onChipsChanged((sid, chips) => {
  if (window.chipsUI) window.chipsUI.paintFor(sid, chips);
});

// 点击消息里的文件路径链接 → 默认程序打开; Cmd/Ctrl+点 → Finder 里定位
function openFilepath(e, reveal) {
  const a = e.target.closest && e.target.closest('a.filepath');
  if (!a) return;
  e.preventDefault();
  const p = a.dataset.path;
  if (p && window.butler.openPath) window.butler.openPath(p, reveal);
}
stage.addEventListener('click', (e) => openFilepath(e, e.metaKey || e.ctrlKey));

// 绝对路径形状判定: Unix(/…) · Windows 盘符(C:\ 或 C:/) · UNC(\\server\…)
const looksAbsPath = (s) => /^(?:\/|[A-Za-z]:[\\\/]|\\\\)/.test(s);
const IS_WIN = (window.butler && window.butler.platform) === 'win32';
const revealLabel = () => (IS_WIN ? t('reveal_explorer') : t('reveal_finder'));

// 本机装了哪些可选打开方式 (Mac/Win 都问主进程, 没装的不进菜单 → 不留点了没反应的死按钮)
let _openers = [];
window.butler.listOpeners().then((r) => { _openers = r || []; });

// 右键 → 弹自定义菜单让用户选打开方式(绕开系统关联乱套 / CC 拦截)
function showPathContextMenu(e, p) {
  document.querySelectorAll('.filepath-menu').forEach((el) => el.remove());   // 清老菜单
  const ext = (p.split('.').pop() || '').toLowerCase();
  // 按后缀排序: html 优先 Chrome, 其余(代码/md)优先 VSCode
  const prefer = (ext === 'html' || ext === 'htm') ? 'chrome' : 'vscode';
  const items = [
    ..._openers
      .slice()
      .sort((a, b) => (b.key === prefer) - (a.key === prefer))
      .map((o) => ({ label: o.label, act: () => window.butler.openWithApp(p, o.key) })),
    { label: revealLabel(),        act: () => window.butler.openPath(p, true) },
    { label: t('copy_path'),       act: () => navigator.clipboard.writeText(p) },
    { label: t('open_default'),    act: () => window.butler.openPath(p, false) },
    ...(/^(png|jpe?g|gif|webp|svg)$/.test(ext) ? [{ label: t('save_image_as'), act: () => window.butler.saveImage({ src: p, name: p.split(/[\\/]/).pop() }) }] : []),
  ];
  const menu = document.createElement('div');
  menu.className = 'filepath-menu';
  Object.assign(menu.style, {
    position: 'fixed', left: e.clientX + 'px', top: e.clientY + 'px',
    background: '#2b2b36', border: '1px solid #444', borderRadius: '6px',
    padding: '4px 0', minWidth: '200px', zIndex: 99999,
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)', fontSize: '13px', color: '#e0e0e0',
    userSelect: 'none',
  });
  items.forEach((it) => {
    const row = document.createElement('div');
    row.textContent = it.label;
    Object.assign(row.style, { padding: '6px 14px', cursor: 'pointer' });
    row.addEventListener('mouseenter', () => row.style.background = '#3a3a48');
    row.addEventListener('mouseleave', () => row.style.background = 'transparent');
    row.addEventListener('click', () => { it.act(); menu.remove(); });
    menu.appendChild(row);
  });
  // 分隔线 + 路径提示
  const sep = document.createElement('div');
  Object.assign(sep.style, { borderTop: '1px solid #444', margin: '4px 0' });
  menu.appendChild(sep);
  const info = document.createElement('div');
  info.textContent = p;
  Object.assign(info.style, {
    padding: '4px 14px 6px', fontSize: '11px', color: '#888',
    wordBreak: 'break-all', maxWidth: '400px',
  });
  menu.appendChild(info);
  document.body.appendChild(menu);
  // 点别处关掉菜单
  const close = (ev) => {
    if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close); }
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}
// 全局 contextmenu (capture) — md.js 里 href=#, 真路径在 title 或 dataset 里
document.body.addEventListener('contextmenu', (e) => {
  const a = e.target.closest && e.target.closest('a');
  if (a) {
    // http/https URL 让 Electron 默认右键菜单接管 (复制链接/新标签打开)
    const href = a.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) return;
    // 打印所有 dataset + 关键属性 dbg
    console.log('[ctxmenu] a.dataset=', Object.assign({}, a.dataset), 'title=', a.title, 'text=', a.textContent);
  }
  let p = null;
  if (a) {
    // 尝试多种源提取路径
    p = a.dataset && (a.dataset.path || a.dataset.href || a.dataset.url);
    if (!p) p = a.title;   // md.js 常把真链接放 title
    if (!p) {
      let href = a.getAttribute('href') || '';
      // file:///C:/… (Windows) 去掉三道斜杠里的头一道, 否则 path.resolve 拿到 /C:/… 打不开
      if (href.startsWith('file://')) p = decodeURIComponent(href.replace(/^file:\/\/\/?([A-Za-z]:)/, '$1').replace(/^file:\/\//, ''));
      else if (looksAbsPath(href)) p = href;
    }
    // 兜底: text 本身像绝对路径
    if (!p) {
      const txt = (a.textContent || '').trim();
      if (looksAbsPath(txt)) p = txt;
    }
  }
  // 用户选中的文本本身就是路径
  if (!p) {
    const sel = String(window.getSelection() || '').trim();
    if (looksAbsPath(sel) && sel.length < 500) p = sel;
  }
  console.log('[ctxmenu] extracted path=', p);
  if (!p) return;
  e.preventDefault();
  e.stopPropagation();
  showPathContextMenu(e, p);
}, true);

// 顶栏显示活动标签的人格 + 目录
function showPersona(p) {
  if (!p) return;
  paintAvatar(personaAvatar, p);
  personaName.textContent = p.name || t('persona');
  personaDir.textContent = p.homeDir || '';
  personaDir.title = `${t('dir_label')}: ${p.homeDir}\n${t('mem_label')}: ${p.memoryDir}`;
  document.title = `${t('title')} v${window.butler.version} · ${p.name || ''}`;
}

// Mermaid 一次性初始化 (securityLevel:'strict' 禁止图内 <script> / 点击回调; startOnLoad:false 由 renderMd 手动 render)
if (window.mermaid) {
  try { window.mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' }); }
  catch (e) { console.warn('mermaid init 失败', e); }
}

// 切语言不重启 app: 存盘 → 主进程广播 → 每个窗口自己重刷。
// 要求重启才生效的话, 用户会以为没选上, 再点一遍。
langSel.addEventListener('change', async () => {
  const r = await window.butler.setLocale(langSel.value);
  if (r && r.ok) applyStrings(r);
});
window.butler.onLocaleChanged((payload) => {
  applyStrings(payload);
  fillLocales(langSel, payload.locales, payload.locale);
});

// ---- 启动: 拉所有已开标签, 激活默认标签 ----
(async () => {
  // 语言排在会话前面: 免得先闪一帧 index.html 里的中文再跳成用户选的语言。
  const loc = await window.butler.getLocale();
  applyStrings(loc);
  fillLocales(langSel, loc.locales, loc.locale);

  const r = await window.butler.listSessions();
  const list = (r && r.sessions) || [];
  const active = (r && r.active) || (list[0] && list[0].sid);
  for (const meta of list) makeTab(meta, { activate: meta.sid === active });
  if (!list.length) { await window.emptyState.maybeShow(); return; }   // 没人格 → 空状态屏(接 AI + 选目录 + 点了才建)
  await refreshTabsFromRegistry();   // 启动时从登记簿再同步一次名字/头像(重启后 meta 可能是旧的)
  input.focus();
})();

// 关闭前沉淀 overlay 整块搬到 sediment-overlay.js(renderer.js 已过 500 行上限, 不许再长)。
// 它在 renderer.js **之后**加载, 因为要用这里的 t()。
