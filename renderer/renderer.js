// renderer.js — 渲染层(单窗口多标签/MDI): 每个标签=一个人格文档, 各自气泡流/附件/输入草稿。
// 顶栏(人格名·目录·usage 条)反映"活动标签"; 底部输入栏共享, 发到活动标签。后台标签流式照跑,
// 非活动标签来消息→标记未读小点。软插话模型不变: 发送/输入框永不禁用。
const stage = document.getElementById('stage');
const tabsEl = document.getElementById('tabs');
const newTabBtn = document.getElementById('newTabBtn');
const input = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const compactBtn = document.getElementById('compactBtn');
const clearBtn = document.getElementById('clearBtn');
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const attachstrip = document.getElementById('attachstrip');
const ctxfill = document.getElementById('ctxfill');
const ctxlabel = document.getElementById('ctxlabel');
const personaName = document.getElementById('personaName');
const personaDir = document.getElementById('personaDir');
const personaAvatar = document.getElementById('personaAvatar');
const closeCurrentBtn = document.getElementById('closeCurrentBtn');
const cancelBtn = document.getElementById('cancelBtn');

const tabs = new Map();     // sid -> Tab
let activeSid = null;

// ---- Tab 数据结构 ----
// { sid, persona, usage, panel, chat, tabEl, avatarEl, dotEl, activeBubble, attachments[], draft, loaded, unread }
const activeTab = () => tabs.get(activeSid);

// 粘底滚动: 只有用户本来就停在底部才跟随新内容自动滚; 往上翻看时不打扰(别硬拽回底部)。
const NEAR_BOTTOM_PX = 60;
function nearBottom(chat) { return chat.scrollHeight - chat.scrollTop - chat.clientHeight < NEAR_BOTTOM_PX; }
function maybeScroll(tab) { if (tab.sid === activeSid && tab.stick !== false) tab.chat.scrollTop = tab.chat.scrollHeight; }

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
  tab.chat.appendChild(el);
  maybeScroll(tab);
  return el;
}
const bodyOf = (el) => (el && el._body) || el;

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
  if (!_lightboxEl) {
    _lightboxEl = document.createElement('div');
    _lightboxEl.id = 'lightbox';
    const img = document.createElement('img');
    const btn = document.createElement('button');
    btn.className = 'lb-close'; btn.textContent = '×';
    btn.onclick = (e) => { e.stopPropagation(); closeLightbox(); };
    _lightboxEl.appendChild(img);
    _lightboxEl.appendChild(btn);
    _lightboxEl.onclick = () => closeLightbox();   // 点背景关
    document.body.appendChild(_lightboxEl);
  }
  _lightboxEl.querySelector('img').src = src;
  _lightboxEl.style.display = 'flex';
}
function closeLightbox() { if (_lightboxEl) _lightboxEl.style.display = 'none'; }
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && _lightboxEl && _lightboxEl.style.display !== 'none') closeLightbox(); });

// 把气泡正文按 markdown 整块渲染(收尾时调用; 流式中仍用纯文本逐字, 避免半截 md 抖动)
function renderMd(body) {
  if (!body || typeof window.renderMarkdown !== 'function') return;
  const html = window.renderMarkdown(body.textContent);
  if (html) { body.innerHTML = html; body.classList.add('md'); decorateCode(body); }
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
    btn.title = '复制代码';
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

function sysMsgTo(tab, text, extra = '') { return addMsgTo(tab, 'system' + (extra ? ' ' + extra : ''), text, null); }

// 收尾当前 AI 文本气泡: 有正文→整块 md 渲染; 空占位→撤掉不留空气泡。清 activeBubble。
// 用于: 工具调用前(顺序:文本→工具→后续文本) + 插话前(旧轮后续输出排到用户消息下方)。
function finalizeAssistantBubble(tab) {
  const bub = tab.activeBubble;
  if (!bub) return;
  const body = bodyOf(bub);
  bub.classList.remove('thinking');
  const txt = body.textContent;
  if (!txt || txt === '…') bub.remove();
  else renderMd(body);
  tab.activeBubble = null;
}

// 工具调用 → 一条持久简洁条目(读文件/写文件/跑命令…), 排进消息流不清除
function addToolMsgTo(tab, tool) {
  const el = document.createElement('div');
  el.className = 'msg tool';
  el.textContent = (tool && tool.desc) || String(tool || '');
  tab.chat.appendChild(el);
  if (tab.activityEl) tab.chat.appendChild(tab.activityEl);   // "进行中"状态行始终吊在底部
  maybeScroll(tab);
  return el;
}

// ---- 活着信号: 气泡下方一行实时状态(转圈 + 当前在干嘛), 出正文/出结果即清 ----
function setActivity(tab, text) {
  if (!tab.activityEl) {
    tab.activityEl = document.createElement('div');
    tab.activityEl.className = 'activity';
    tab.activityEl.innerHTML = '<span class="spinner"></span><span class="atext"></span>';
  }
  tab.activityEl.querySelector('.atext').textContent = text || '思考中';
  tab.chat.appendChild(tab.activityEl);   // 始终吊在最底
  maybeScroll(tab);
}
function clearActivity(tab) {
  if (tab && tab.activityEl) { tab.activityEl.remove(); tab.activityEl = null; }
}

// ---- 压缩上下文: 动态指示(spinner + 脉动文字), 别让压缩的几秒看起来像假死 ----
function showCompacting(tab, reason) {
  clearCompacting(tab);
  const el = document.createElement('div');
  el.className = 'compacting';
  el.innerHTML = '<span class="spinner"></span><span class="ctext"></span>';
  el.querySelector('.ctext').textContent =
    '正在压缩上下文…（浓缩成交接摘要 → 重启会话，约数秒）' + (reason && reason !== '手动' ? ' · ' + reason : '');
  tab.compactingEl = el;
  tab.chat.appendChild(el);
  maybeScroll(tab);
}
function clearCompacting(tab) {
  if (tab && tab.compactingEl) { tab.compactingEl.remove(); tab.compactingEl = null; }
}

// ---- usage 条(只画活动标签) ----
function renderUsage(u) {
  if (!u) { ctxfill.style.width = '0%'; ctxlabel.textContent = '— %'; return; }
  const pct = Math.min(u.pct || 0, 100);
  ctxfill.style.width = pct + '%';
  let g = 'linear-gradient(90deg,#4ade80,#22c55e)';
  if (pct >= 80) g = 'linear-gradient(90deg,#f87171,#ef4444)';
  else if (pct >= 60) g = 'linear-gradient(90deg,#fbbf24,#f59e0b)';
  ctxfill.style.background = g;
  const k = (n) => (n >= 1000 ? Math.round(n / 100) / 10 + 'k' : n);
  ctxlabel.textContent = `${u.pct}%  ·  ${k(u.inTok)}/${k(u.window)}`;
}

// 压缩键: 活动标签有活动回复时禁用(压缩需干净停顿点)
function refreshBusy() {
  const t = activeTab();
  compactBtn.disabled = !t || t.busy;
  clearBtn.disabled = !t || t.busy;   // 清空同压缩: 需干净停顿点
  // 取消按钮: 只在当前标签 busy 时显示——用户按了发送、正在跑, 才能救援
  if (cancelBtn) cancelBtn.style.display = (t && t.busy) ? '' : 'none';
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
    crown.title = '管家';
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
  const chat = document.createElement('div');
  chat.className = 'chat';
  panel.appendChild(chat);
  stage.appendChild(panel);

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.title = meta.persona ? meta.persona.name : '人格';
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
    panel, chat, tabEl, avatarEl, dotEl,
    activeBubble: null, busy: false, stick: true, attachments: [], draft: '', loaded: false, unread: false,
  };
  tabs.set(meta.sid, tab);
  // 用户滚动 → 记录是否贴底; 贴底才让新内容自动跟随(见 maybeScroll)
  chat.addEventListener('scroll', () => { tab.stick = nearBottom(chat); });

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

  if (!tab.loaded) await loadHistory(tab);
  tab.stick = true; tab.chat.scrollTop = tab.chat.scrollHeight;   // 切到本标签 → 回底并恢复粘底
  input.focus();
}

async function closeTab(sid) {
  if (tabs.size <= 1) return;   // 至少留一个
  const tab = tabs.get(sid);
  const nm = (tab && tab.persona && tab.persona.name) || '人格';
  if (!window.confirm(`关闭「${nm}」标签?\n\n会话记忆已落盘, 重新打开时可续。`)) return;
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

// ---- 载某标签的历史(懒加载, 只一次) ----
async function loadHistory(tab) {
  tab.loaded = true;
  const h = await window.butler.getHistory(tab.sid);
  if (h && h.persona) { tab.persona = h.persona; if (tab.sid === activeSid) showPersona(h.persona); }
  if (h && h.usage) { tab.usage = h.usage; if (tab.sid === activeSid) renderUsage(h.usage); }
  if (h && h.messages && h.messages.length) {
    for (const m of h.messages) {
      let el;
      // #9: 新消息带 imgs 元数据 → IPC 拿 base64 渲缩略图; 拿失败或老消息只有 img:N → fallback 🖼×N
      if (m.role === 'user' && Array.isArray(m.imgs) && m.imgs.length) {
        const srcs = [];
        for (const im of m.imgs) {
          try {
            const r = await window.butler.getAttachment(tab.sid, im.path);
            if (r && r.ok) srcs.push({ src: `data:${im.mediaType};base64,${r.base64}`, alt: im.name });
          } catch (_) { /* 单张失败不阻塞其他 */ }
        }
        if (srcs.length) el = renderImageMessage(tab, m.role, m.text, srcs, m.ts != null ? m.ts : null);
        else el = addMsgTo(tab, m.role, m.text + (m.img ? `  🖼×${m.img}` : ''), m.ts != null ? m.ts : null);
      } else {
        el = addMsgTo(tab, m.role, m.text + (m.img ? `  🖼×${m.img}` : ''), m.ts != null ? m.ts : null);
      }
      if (m.role === 'assistant') renderMd(bodyOf(el));   // 历史 AI 消息也 md 渲染
    }
    sysMsgTo(tab, '—— 以上为上次会话，已接续 ——');
  } else {
    sysMsgTo(tab, '🤵 全能管家已就绪 — 复用你的 Claude 订阅认证。跑动中也能提交=软插话(我做完手头再读)。');
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
      chip.innerHTML = `<img src="data:${a.mediaType};base64,${a.base64}"/><span class="x">×</span>`;
      chip.querySelector('.x').onclick = () => { list.splice(i, 1); renderAttachStrip(); };
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
  if (interjecting) sysMsgTo(tab, '📮 已入队 · 当前工具循环结束后处理');
  tab.attachments = []; renderAttachStrip();
  tab.busy = true;
  // 新一轮才起占位思考气泡; 插话时不起(旧轮后续 onChunk 会在用户消息下方自建气泡, 避免 finalText 兜底重复正文)
  if (!interjecting) { tab.activeBubble = addMsgTo(tab, 'assistant', '…'); tab.activeBubble.classList.add('thinking'); }
  refreshBusy();
  setActivity(tab, '思考中');
  try {
    const r = await window.butler.send(tab.sid, { text, attachments: toSend });
    if (r && !r.ok) sysMsgTo(tab, '⚠️ 发送出错: ' + r.error);
  } catch (e) { sysMsgTo(tab, '⚠️ 发送出错: ' + e); }
  input.focus();
}

async function doCompact() {
  const tab = activeTab();
  if (!tab) return;
  compactBtn.disabled = true;
  // 进行中提示改由 onCompacting 动态指示接管(spinner), 这里不再塞静态文字
  const r = await window.butler.compact(tab.sid);
  if (r.ok) sysMsgTo(tab, `✅ 已压缩 · 摘要 ${r.summary ? r.summary.length : 0} 字 · 会话已重启`, 'compact');
  else sysMsgTo(tab, '⚠️ 压缩失败: ' + (r.error || r.note), 'compact');
  refreshBusy();
}

async function doClear() {
  const tab = activeTab();
  if (!tab) return;
  if (!confirm('清空上下文？\n\n将丢弃当前会话的全部历史, 开一个全新空白会话(不生成交接摘要、不续线程)。此操作不可撤销。')) return;
  clearBtn.disabled = true;
  const r = await window.butler.clear(tab.sid);
  if (r.ok) {
    // 关键: 后端已清 s.convo/sessionId, 但 DOM 里的旧气泡不会自己消失 → 手动清空容器, 撤活跃气泡引用
    tab.chat.innerHTML = '';
    tab.activeBubble = null;
    clearActivity(tab);
    // #8 clear buf drop 明示: 后端 r.droppedUsrMsgs 有 N > 0 → 用户知道"放弃了 N 条待处理", 避免默默吞
    const clearMsg = (r.droppedUsrMsgs > 0) ? `🧹 已清空 · 放弃了 ${r.droppedUsrMsgs} 条待处理消息` : '🧹 已清空';
    sysMsgTo(tab, clearMsg, 'compact');
  } else sysMsgTo(tab, '⚠️ 清空失败: ' + (r.error || r.note), 'compact');
  refreshBusy();
}

// ---- 事件(按 sid 分发到对应标签) ----
function markUnread(tab) {
  if (tab.sid !== activeSid) { tab.unread = true; tab.tabEl.classList.add('unread'); }
}
window.butler.onUserEcho((sid, text) => {   // 程序注入的消息(如 butler 出生教育)显示成 user 气泡
  const tab = tabs.get(sid);
  if (!tab) return;
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
  markUnread(tab);
});
window.butler.onResult((sid, { finalText, interrupted, compacted }) => {
  const tab = tabs.get(sid);
  if (!tab) return;
  clearActivity(tab);   // 一段回复收尾, 撤活动状态行
  if (tab.activeBubble) {
    const body = bodyOf(tab.activeBubble);
    tab.activeBubble.classList.remove('thinking');
    const txt = body.textContent;
    if (!txt || txt === '…') {
      // 本气泡没收到流式正文: 有 finalText 兜底填(md 渲染); 否则撤空气泡(被打断/只调了工具)
      if (finalText) { body.textContent = finalText; renderMd(body); }
      else if (interrupted) { body.textContent = '⏸'; }
      else { tab.activeBubble.remove(); }
    } else {
      renderMd(body);   // 收尾: 正文整块 markdown 渲染(表格/代码/粗体/列表)
    }
    tab.activeBubble = null;
  }
  tab.busy = false;
  if (tab.sid === activeSid) refreshBusy();
  if (compacted && compacted.ok) {
    sysMsgTo(tab, `🗜 已自主压缩上下文 · 理由: ${compacted.reason} · 摘要 ${compacted.summary.length} 字, 会话已重启`, 'compact');
  }
  markUnread(tab);
});
window.butler.onActivity((sid, text) => {
  const tab = tabs.get(sid);
  if (!tab) return;
  setActivity(tab, text);   // 实时显示"正在读文件/跑命令/搜索…" → 静默期也知道我活着
  markUnread(tab);
});
window.butler.onTool((sid, tool) => {
  const tab = tabs.get(sid);
  if (!tab) return;
  finalizeAssistantBubble(tab);   // 工具前收尾当前文本气泡 → 顺序: 文本→工具→后续文本
  addToolMsgTo(tab, tool);        // 持久条目, 不清除
  markUnread(tab);
});
window.butler.onCompacting((sid, s) => {
  const tab = tabs.get(sid);
  if (!tab) return;
  if (s.phase === 'start') showCompacting(tab, s.reason);   // 动态"正在压缩"指示
  else clearCompacting(tab);                                // 压缩结束撤指示(done 消息另有)
  markUnread(tab);
});
window.butler.onUsage((sid, u) => {
  const tab = tabs.get(sid);
  if (!tab) return;
  tab.usage = u;
  if (tab.sid === activeSid) renderUsage(u);
});
// 管家在窗口里开/建了别的人格 → 主进程推来 → 加标签并激活
window.butler.onPersonaOpened((meta) => {
  if (!meta || !meta.sid) return;
  const existing = tabs.get(meta.sid);
  if (existing && meta.persona) {
    // 已有标签: 编辑人格(改名/换头像)后会重发 persona-opened → 用新 meta 刷新标签头像/名字, 别早退浪费掉
    existing.persona = meta.persona;
    existing.tabEl.title = meta.persona.name || '人格';
    paintAvatar(existing.avatarEl, meta.persona);
    paintCrown(existing.tabEl, meta.persona);
    if (meta.sid === activeSid) showPersona(meta.persona);
    switchTab(meta.sid);
    return;
  }
  makeTab(meta, { activate: true });
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
clearBtn.addEventListener('click', doClear);
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
      (opts.butler ? '<span class="p-tag butler">管家</span>' : '') +
      (opts.open ? '<span class="p-tag">已开</span>' : '');
    if (!opts.open && opts.onClick) it.addEventListener('click', () => { mask.remove(); opts.onClick(); });
    pop.appendChild(it);
  };
  for (const p of list) {
    addItem({ label: p.name, butler: p.isButler, open: p.open,
      onClick: async () => { await window.butler.openPersonaRef(p.id); } });
  }
  if (list.length) { const sep = document.createElement('div'); sep.className = 'p-sep'; pop.appendChild(sep); }
  addItem({ label: '＋ 新建人格…', action: true, onClick: () => window.butler.openManagerWindow() });
  addItem({ label: '⚙ 管理人格…', action: true, onClick: () => window.butler.openManagerWindow() });
  document.body.appendChild(mask);
}
newTabBtn.addEventListener('click', showPicker);
closeCurrentBtn.addEventListener('click', () => { if (activeSid) closeTab(activeSid); });

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

// 点击消息里的文件路径链接 → 默认程序打开; Cmd/Ctrl+点 → Finder 里定位
function openFilepath(e, reveal) {
  const a = e.target.closest && e.target.closest('a.filepath');
  if (!a) return;
  e.preventDefault();
  const p = a.dataset.path;
  if (p && window.butler.openPath) window.butler.openPath(p, reveal);
}
stage.addEventListener('click', (e) => openFilepath(e, e.metaKey || e.ctrlKey));

// 右键 → 弹自定义菜单让用户选打开方式(绕开系统关联乱套 / CC 拦截)
function showPathContextMenu(e, p) {
  document.querySelectorAll('.filepath-menu').forEach((el) => el.remove());   // 清老菜单
  const ext = (p.split('.').pop() || '').toLowerCase();
  // 按后缀智能排序 · html 优先 Chrome, 代码/md 优先 VSCode
  const isHtml = ext === 'html' || ext === 'htm';
  const items = isHtml ? [
    { label: '🌐 用 Chrome 打开',       act: () => window.butler.openWithApp(p, 'Google Chrome') },
    { label: '📝 用 VSCode 打开',       act: () => window.butler.openWithApp(p, 'Visual Studio Code') },
    { label: '📂 在 Finder 中显示',     act: () => window.butler.openPath(p, true) },
    { label: '📎 复制路径',             act: () => navigator.clipboard.writeText(p) },
    { label: '⚙️ 用系统默认程序打开',   act: () => window.butler.openPath(p, false) },
  ] : [
    { label: '📝 用 VSCode 打开',       act: () => window.butler.openWithApp(p, 'Visual Studio Code') },
    { label: '🌐 用 Chrome 打开',       act: () => window.butler.openWithApp(p, 'Google Chrome') },
    { label: '📂 在 Finder 中显示',     act: () => window.butler.openPath(p, true) },
    { label: '📎 复制路径',             act: () => navigator.clipboard.writeText(p) },
    { label: '⚙️ 用系统默认程序打开',   act: () => window.butler.openPath(p, false) },
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
      if (href.startsWith('file://')) p = decodeURIComponent(href.replace(/^file:\/\//, ''));
      else if (href.startsWith('/')) p = href;
    }
    // 兜底: text 本身像绝对路径 (含 / 且大概率是路径)
    if (!p) {
      const txt = (a.textContent || '').trim();
      if (txt.startsWith('/')) p = txt;
    }
  }
  // 用户选中的文本本身就是路径
  if (!p) {
    const sel = String(window.getSelection() || '').trim();
    if (sel.startsWith('/') && sel.length < 500) p = sel;
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
  personaName.textContent = p.name || '人格';
  personaDir.textContent = p.homeDir || '';
  personaDir.title = `目录: ${p.homeDir}\n记忆: ${p.memoryDir}`;
  document.title = `全能管家 v${window.butler.version} · ${p.name || ''}`;
}

// ---- 启动: 拉所有已开标签, 激活默认标签 ----
(async () => {
  const r = await window.butler.listSessions();
  const list = (r && r.sessions) || [];
  const active = (r && r.active) || (list[0] && list[0].sid);
  for (const meta of list) makeTab(meta, { activate: meta.sid === active });
  if (!list.length) return;
  await refreshTabsFromRegistry();   // 启动时从登记簿再同步一次名字/头像(重启后 meta 可能是旧的)
  input.focus();
})();
