// manager.js — 独立管理窗口: 人格列表(展开式编辑 name/wakePhrase, 指定管家, 删) + 建人格表单
const listEl = document.getElementById('list');
const toastEl = document.getElementById('toast');
const F = { name: document.getElementById('f-name'), dir: document.getElementById('f-dir'),
            wake: document.getElementById('f-wake'), butler: document.getElementById('f-butler'),
            choose: document.getElementById('f-choose'), create: document.getElementById('f-create') };

function toast(text) {
  toastEl.textContent = text; toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 1800);
}

// 记住哪些人格的编辑面板正展开(refresh 后保留), 由 id 索引
const expanded = new Set();

// HTML 转义(防 XSS 注入到编辑面板 innerHTML)
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- 头像选择器 ----
const isImgAvatar = (v) => typeof v === 'string' && /^(data:|file:|https?:|\/)/.test(v);
const COMMON_EMOJIS = ['🤖','🧑‍💻','👩‍💻','🧑‍🎨','🐱','🦊','🐼','🦉','🐧','🐷','🦁','🐰','🌸','🚀','💰','📊','📈','🎨','🎯','🧠','📚','☕','🔧','🛡️','⚡','🎭','🍜','🐉','🌟','🦄'];
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

function makeEditPanel(p) {
  const tg = (p.plugins && p.plugins.tg) || {};
  const bh = (p.plugins && p.plugins.bothub) || {};
  const bhList = Array.isArray(bh.endpoints) ? bh.endpoints : [];
  const st = p.pluginStatus || {};
  const box = document.createElement('div'); box.className = 'edit-box';
  box.innerHTML = `
    <div class="e-line"><label>名字</label><input class="e-name" value="${esc(p.name)}"/></div>
    <div class="e-line"><label>头像</label>
      <div class="avatar-picker">
        <div class="ap-preview"></div>
        <div class="ap-body">
          <div class="ap-tabs">
            <button type="button" class="ap-tab active" data-tab="emoji">Emoji</button>
            <button type="button" class="ap-tab" data-tab="photo">照片</button>
          </div>
          <div class="ap-pane ap-pane-emoji">
            <div class="ap-grid"></div>
            <input class="ap-emoji-input" placeholder="或粘贴一个 emoji" maxlength="4" />
          </div>
          <div class="ap-pane ap-pane-photo" hidden>
            <button type="button" class="m-btn ap-photo-btn">选择照片…</button>
            <input type="file" accept="image/*" class="ap-photo-file" hidden />
            <button type="button" class="m-btn ap-clear" title="清除, 回字母头像">清除</button>
            <div class="ap-photo-hint">自动裁成 128px 小方图</div>
          </div>
        </div>
        <input type="hidden" class="e-avatar-val" value="${esc(p.avatar)}" />
      </div>
    </div>
    <div class="e-line"><label>唤醒语</label><textarea class="e-wake" placeholder="留空 = 起床啦${esc(p.name)}, 载入记忆续线程">${esc(p.wakePhrase)}</textarea></div>
    <div class="e-line"><label>模型</label>
      <select class="e-model" title="切换后要等会话重启才生效(关标签重开/重启app/下次压缩); 空=跟随 Claude Code 默认">
        <option value="" ${!p.model?'selected':''}>跟随默认</option>
        <option value="sonnet" ${p.model==='sonnet'?'selected':''}>Sonnet(均衡, 日常首选)</option>
        <option value="opus" ${p.model==='opus'?'selected':''}>Opus(旗舰, 复杂/长文)</option>
        <option value="haiku" ${p.model==='haiku'?'selected':''}>Haiku(快省, 走量/简单)</option>
      </select>
    </div>
    <div class="e-line"><label>目录</label><div class="e-dir" title="切换目录暂不支持(需迁移记忆图/会话, 未来 P6 一起做)">${esc(p.homeDir)} <span class="e-dir-note">🔒 暂不可改</span></div></div>

    <div class="e-persona-md">
      <div class="e-plugin-head">🧬 身份档案 (persona.md, LLM 载入的 identity 真源)</div>
      <textarea class="e-pmd" placeholder="加载中…" spellcheck="false"></textarea>
      <div class="e-pmd-hint">编辑后点保存 · 已打开的标签立刻生效 · 顶部 frontmatter 里 name/type 别改</div>
    </div>

    <div class="e-plugin">
      <div class="e-plugin-head">📡 TG 插件 (butler 直连 Telegram, 无外部进程) ${st.tg && st.tg.running ? '<span class="pi-live">● 运行中 · offset='+st.tg.offset+' · 收='+(st.tg.msgCount||0)+' · '+(st.tg.lastError?'⚠'+st.tg.lastError:'ok')+'</span>' : (st.tg && st.tg.mode==='native' ? '<span class="pi-dead">○ 已启用未运行</span>' : '<span class="pi-off">— 未启用</span>')}</div>
      <div class="e-line"><label>模式</label>
        <select class="pt-mode">
          <option value="off"    ${(tg.mode||'off')==='off'?'selected':''}>off — 该人格不用 TG</option>
          <option value="native" ${(tg.mode||'')==='native'?'selected':''}>native — butler JS 直抓 (推荐)</option>
        </select>
      </div>
      <div class="e-line"><label>bot_token</label><input type="password" class="pt-token" placeholder="从 @BotFather /token 获取" value="${esc(tg.bot_token)}"/></div>
      <div class="e-line"><label>in_file</label><input class="pt-in" placeholder="留空 = 默认 memoryDir/tg_inbox.jsonl (v2 兜底副本, 收发已全走 butler JS)" value="${esc(tg.in_file)}"/></div>
      <div class="e-line"><label>chat_ids</label><input class="pt-chats" placeholder="TG user_id 或群 id, 逗号分隔, 空=全接受" value="${(tg.chat_ids||[]).join(',')}"/></div>

      <div class="e-plugin-head" style="margin-top:8px">🔌 bothub / agent-bus (butler 直连, 可多 endpoint) ${st.bothub && st.bothub.running ? '<span class="pi-live">● 运行中</span>' : (st.bothub && st.bothub.mode==='native' ? '<span class="pi-dead">○ 已启用未运行</span>' : '<span class="pi-off">— 未启用</span>')}</div>
      <div class="e-line"><label>模式</label>
        <select class="pb-mode">
          <option value="off"    ${(bh.mode||'off')==='off'?'selected':''}>off — 该人格不用 bothub</option>
          <option value="native" ${(bh.mode||'')==='native'?'selected':''}>native — butler JS 直抓</option>
        </select>
      </div>
      <div class="pb-endpoints"></div>
      <div class="e-line"><label></label><button class="m-btn pb-add" type="button">+ 加 endpoint</button></div>
    </div>

    <div class="e-actions"><button class="m-btn primary e-save">保存</button><button class="m-btn e-cancel">取消</button></div>`;

  // 动态渲染 bothub endpoints 列表(可加/删)
  const bhEl = box.querySelector('.pb-endpoints');
  function renderEndpoint(ep, idx) {
    const el = document.createElement('div'); el.className = 'pb-ep'; el.dataset.idx = idx;
    el.innerHTML = `
      <div class="e-line"><label>#${idx} url</label><input class="pbe-url" placeholder="https://your-agent-bus.example.com/api/v1/agent-bus" value="${esc(ep.url)}"/></div>
      <div class="e-line"><label>agent</label><input class="pbe-agent" placeholder="my_agent" value="${esc(ep.agent)}"/></div>
      <div class="e-line"><label>token</label><input type="password" class="pbe-token" placeholder="Bearer token" value="${esc(ep.token)}"/></div>
      <div class="e-line"><label></label><button class="m-btn danger pbe-del" type="button">删</button></div>`;
    el.querySelector('.pbe-del').addEventListener('click', () => { el.remove(); });
    return el;
  }
  bhList.forEach((ep, i) => bhEl.appendChild(renderEndpoint(ep, i)));
  const addBtn = box.querySelector('.pb-add');
  addBtn.addEventListener('click', () => {
    bhEl.appendChild(renderEndpoint({}, bhEl.children.length));
  });
  // bothub mode=off 时禁"加 endpoint" (启用了才能加)
  const bhModeSel = box.querySelector('.pb-mode');
  const syncBhAddState = () => {
    const off = bhModeSel.value === 'off';
    addBtn.disabled = off;
    addBtn.title = off ? '启用 bothub (mode=native) 后才能加 endpoint' : '';
  };
  syncBhAddState();
  bhModeSel.addEventListener('change', syncBhAddState);
  wireAvatarPicker(box);
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
  const endpoints = [...box.querySelectorAll('.pb-ep')].map((el) => ({
    url: el.querySelector('.pbe-url').value.trim(),
    agent: el.querySelector('.pbe-agent').value.trim(),
    token: el.querySelector('.pbe-token').value.trim(),
  })).filter((ep) => ep.url && ep.agent);
  const bothub = { mode: box.querySelector('.pb-mode').value, endpoints };
  return { tg, bothub };
}

async function refresh() {
  const r = await window.butler.listPersonas();
  const list = (r && r.personas) || [];
  listEl.innerHTML = '';
  for (const p of list) {
    const row = document.createElement('div'); row.className = 'row';
    const name = document.createElement('div'); name.className = 'm-name'; name.textContent = p.name;

    const dir = document.createElement('div'); dir.className = 'm-dir'; dir.textContent = p.homeDir; dir.title = p.homeDir;

    const tags = document.createElement('div'); tags.style.display = 'flex'; tags.style.gap = '4px';
    if (p.isButler) { const t = document.createElement('span'); t.className = 'm-tag butler'; t.textContent = '管家'; tags.appendChild(t); }
    if (p.open)     { const t = document.createElement('span'); t.className = 'm-tag open';   t.textContent = '已开'; tags.appendChild(t); }

    const editB = document.createElement('button'); editB.className = 'm-btn'; editB.textContent = '编辑';
    const setB = document.createElement('button'); setB.className = 'm-btn'; setB.textContent = '设为管家'; setB.disabled = !!p.isButler;
    setB.title = '把管家角色转给它(全局唯一, 旧管家自动卸任)';
    setB.addEventListener('click', async () => {
      // 只在该人格"当前正开着"时提示: 管家身份标记会立刻切, 但它正跑的会话工具是启动时定死的,
      // list/open/create 这些管家专属工具要等会话重建(关标签重开 / 下次压缩 / 重启 app)才长出来。
      // 没开的人格无需提示——下次打开就是全新会话, 自带管家能力。
      if (p.open) {
        const ok = window.confirm(
          `把「${p.name}」设为管家？\n\n它当前正开着 —— “管家”这个身份标记会立刻切换，但管家专属能力（查看/打开/新建人格等工具）不会马上生效，要等它的会话重启后才有：\n  · 关掉该标签重新打开，或\n  · 下次自动压缩，或\n  · 重启 app`
        );
        if (!ok) return;
      }
      const r2 = await window.butler.updatePersona(p.id, { isButler: true });
      if (r2.ok) toast(p.open ? `已设 ${p.name} 为管家 · 关标签重开后管家能力生效` : `已设 ${p.name} 为管家`);
    });

    const del = document.createElement('button'); del.className = 'm-btn danger'; del.textContent = '删除'; del.disabled = !!p.open;
    del.title = p.open ? '打开中的人格不能删, 请先关闭标签' : '从登记簿删除(不删磁盘目录/记忆)';
    del.addEventListener('click', async () => {
      if (!confirm(`确认从登记簿删除「${p.name}」? (不会删除磁盘上的目录和记忆)`)) return;
      const r2 = await window.butler.deletePersona(p.id);
      if (r2.ok) toast(`已删除: ${p.name}`); else toast('删除失败: ' + r2.error);
    });

    row.append(name, dir, tags, editB, setB, del);
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
      ta.value = r.ok ? r.content : ('# 加载失败: ' + (r.error || ''));
      ta.dataset.loaded = '1';
    }
    editB.addEventListener('click', async () => {
      const showing = panel.style.display !== 'none';
      panel.style.display = showing ? 'none' : 'block';
      if (showing) expanded.delete(p.id); else { expanded.add(p.id); await loadPersonaMdIfNeeded(); }
      editB.textContent = showing ? '编辑' : '收起';
      if (!showing) panel.querySelector('.e-name').focus();
    });
    if (expanded.has(p.id)) { editB.textContent = '收起'; loadPersonaMdIfNeeded(); }

    panel.querySelector('.e-save').addEventListener('click', async () => {
      const newName = panel.querySelector('.e-name').value.trim();
      const newWake = panel.querySelector('.e-wake').value;   // 允许留空 = 用默认
      const newAvatar = panel.querySelector('.e-avatar-val').value;
      if (!newName) { toast('名字不能空'); return; }
      const newModel = panel.querySelector('.e-model').value;   // '' = 跟随默认
      const patch = {};
      if (newName !== p.name) patch.name = newName;
      if (newAvatar !== (p.avatar || '')) patch.avatar = newAvatar;
      if (newWake !== (p.wakePhrase || '')) patch.wakePhrase = newWake;
      if (newModel !== (p.model || '')) {
        // 模型偏好改了 + 该人格当前开着 → 弹确认: 跟"设为管家"同构, 得等会话重启才生效
        if (p.open && !window.confirm(
          `把「${p.name}」的模型偏好切成「${newModel || '跟随默认'}」？\n\n` +
          `⚠️ 它当前正开着 —— 模型不会立刻切, 要等这个人格的会话重启后才生效:\n` +
          `  · 关掉该标签重新打开, 或\n  · 下次自动压缩, 或\n  · 重启 app\n\n` +
          `原因: SDK 会话启动时定死用哪个模型, 中途不能改。`)) return;
        patch.model = newModel;   // '' = 传空显式取消偏好
      }
      // 插件配置合并进 patch(不管有没有改, 一起提交; 后端 upsert 合并到位)
      const newPlugins = readPluginsFromPanel(panel);
      const oldPlugins = p.plugins || {};
      patch.plugins = { ...oldPlugins, tg: newPlugins.tg, bothub: newPlugins.bothub };
      const r2 = await window.butler.updatePersona(p.id, patch);
      if (!r2.ok) { toast('保存失败: ' + r2.error); return; }
      // 顺带保存 persona.md (如果面板载入过 → 用户可能改过)
      const ta = panel.querySelector('.e-pmd');
      let pmdMsg = '';
      if (ta.dataset.loaded === '1') {
        const r3 = await window.butler.writePersonaMd(p.id, ta.value);
        pmdMsg = r3.ok ? (r3.applied ? ' + persona.md 立刻生效' : ' + persona.md 已保存(标签重开生效)') : ' · persona.md 保存失败: ' + r3.error;
      }
      toast('已保存 · 插件热切换生效' + pmdMsg);
      expanded.delete(p.id);
    });
    panel.querySelector('.e-cancel').addEventListener('click', () => {
      panel.style.display = 'none'; expanded.delete(p.id); editB.textContent = '编辑';
    });
  }
  if (!list.length) { listEl.innerHTML = '<div class="row" style="color:#888">(登记簿为空)</div>'; }
}

F.choose.addEventListener('click', async () => {
  const r = await window.butler.chooseDirectory();
  if (r && r.ok) F.dir.value = r.path;
});

F.create.addEventListener('click', async () => {
  const name = F.name.value.trim();
  if (!name) { toast('请输入名字'); F.name.focus(); return; }
  F.create.disabled = true;
  const r = await window.butler.createPersonaUI({
    name, homeDir: F.dir.value.trim() || undefined,
    wakePhrase: F.wake.value.trim() || undefined, isButler: F.butler.checked,
    avatar: document.getElementById('f-avatar-val').value || undefined,
  });
  F.create.disabled = false;
  if (r.ok) {
    toast(`已创建并打开: ${r.name}`);
    F.name.value = ''; F.dir.value = ''; F.wake.value = ''; F.butler.checked = false; createSetAvatar('');
  } else { toast('创建失败: ' + r.error); }
});

window.butler.onRegistryChanged && window.butler.onRegistryChanged(refresh);
refresh();
