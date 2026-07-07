// main.js — Electron 主进程: 单窗口·多标签(MDI) — 每标签=一个人格/记忆体, IPC 按 sid(人格目录) 路由。
// 多个 Butler 大脑并存(各自 1M 上下文/各自压缩), 事件都带 sid 分发到渲染层对应标签面板。
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Butler } = require('./agent');
const store = require('./store');
const registry = require('./registry');
const persona = require('./persona');
const { TgPlugin } = require('./plugins/tg');
const { BothubPlugin } = require('./plugins/bothub');
const pluginLog = (line) => { try { console.log(line); } catch (_) {} };   // 子进程日志出 Electron 主进程 stdout(butler 窗口菜单 View→Toggle DevTools 看不到, 命令行 npm start 能看)

// sid = 人格目录(绝对路径) → 天然去重: 一个目录 = 一个标签。sessions: sid -> { butler, convo, persist }
const sessions = new Map();
const DEFAULT_HOME = __dirname;             // 默认标签 = butler 自己(人格0)
const TABS_FILE = path.join(__dirname, '.opentabs.json');  // 记住打开了哪些标签, 重启恢复
let mainWin = null;
let managerWin = null;   // 独立管理窗口(可空; 关了置 null)

const sidOf = (homeDir) => path.resolve(homeDir);
const sendUI = (ch, payload) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(ch, payload); };
// 登记簿有变(建/改/删) → 主窗 + 管理窗口都刷列表
const broadcastRegistry = () => {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('registry-changed');
  if (managerWin && !managerWin.isDestroyed()) managerWin.webContents.send('registry-changed');
};
const personaOf = (b) => ({ name: b.name, homeDir: b.homeDir, memoryDir: b.memoryDir });

// —— 打开标签列表持久化 ——
function loadOpenTabs() {
  try { const s = JSON.parse(fs.readFileSync(TABS_FILE, 'utf8')); return Array.isArray(s.dirs) ? s.dirs : []; }
  catch (_) { return []; }
}
function saveOpenTabs() {
  try { fs.writeFileSync(TABS_FILE, JSON.stringify({ dirs: [...sessions.keys()] }), 'utf8'); } catch (_) {}
}

// —— TG 通路 v2 (2026-07-07): 拉+落+发全 butler JS ——
// 老 v1 用 startTgWatch(4s 盯 in_file 水位线) + python tg_pending.py/send_tg.py, 已废。
// v2 由 tg-native.js onMessage 回调直接 submit + MCP send_tg 工具直接调 bot API。
// 详见 [[project_butler_tg_channel_v2_design]] 记忆节点。

// 会话读盘 + 旧路径兜底: 新路径(记忆目录旁)无有效会话时, 回退读旧的「人格目录根」.session.json 并迁移过来。
// 目的: 换 session 存储位置(如 根目录 → 记忆目录)升级后不丢历史; 迁移后把旧文件改名归档, 避免下次重复触发。
function loadSessionMigrating(butler) {
  const saved = store.load(butler.sessionPath);
  if (saved && saved.sessionId) return saved;                 // 新路径已有有效会话, 直接用
  const legacy = path.join(butler.homeDir, '.session.json');  // 旧位置: 人格目录根
  if (path.resolve(legacy) === path.resolve(butler.sessionPath)) return saved; // 新旧同址则不折腾
  const ls = store.load(legacy);
  if (ls && ls.sessionId) {
    store.save(butler.sessionPath, ls);                       // 迁移到新路径
    try { fs.renameSync(legacy, legacy + '.migrated'); } catch (_) {}  // 旧文件归档, 只迁一次
    return ls;
  }
  return saved;
}

// 建一个人格会话(不建窗口): 目录化 Butler + 载它自己的会话 + 回调发到主窗(带 sid)。幂等: 已开则复用。
function openPersona(homeDir) {
  const sid = sidOf(homeDir);
  if (sessions.has(sid)) return sessions.get(sid);

  const entry = registry.ensureEntry(homeDir);   // 登记簿(不在则迁移建条): 名字/唤醒语/是否管家 以它为准
  const butler = new Butler(homeDir, { name: entry.name, wakePhrase: entry.wakePhrase, isButler: entry.isButler });
  butler.personaOps = { open: openPersonaByRef, create: createPersona, ask: askPersona };   // 管家开/建/问其他人格回调(仅 isButler 的会用到)
  const saved = loadSessionMigrating(butler);
  const convo = (saved && Array.isArray(saved.messages)) ? saved.messages : [];
  if (saved) butler.restore(saved);
  const persist = () => store.save(butler.sessionPath, { ...butler.exportState(), messages: convo });

  butler.setCallbacks({
    onText: (t) => sendUI('assistant-chunk', { sid, text: t }),
    onActivity: (text) => sendUI('activity', { sid, text }),
    onTool: (tool) => sendUI('tool-call', { sid, tool }),   // 每个工具调用→持久条目
    onCompact: (s) => sendUI('compacting', { sid, ...s }),  // 压缩开始/结束→UI 动态指示

    onUsage: (u) => sendUI('usage', { sid, usage: u }),
    onResult: async ({ finalText, interrupted, compactReason }) => {
      if (finalText) convo.push({ role: 'assistant', text: finalText, ts: Date.now() });
      persist();
      let compacted = null;
      if (compactReason) {
        try { compacted = await butler.doCompact(compactReason); } catch (e) { compacted = { ok: false, error: String(e) }; }
        if (compacted && compacted.ok) {
          convo.push({ role: 'system', text: `🗜 自主压缩 · ${compacted.reason}`, ts: Date.now() });
          // 压缩自愈(取代 SessionStart hook): butler 内在程序自己戳一个 turn 唤醒续线程——不依赖 TG、不依赖用户输入。
          // 唤醒语按人格取(butler.wakePhrase, 来自各人格 wake.txt): 数据专家=加载数据专家续线程, 通用人格=喊名字载记忆。不再硬编码"加载数据专家"。
          butler.submit(`（系统自动·压缩后自愈）你刚完成上下文压缩并重启会话。${butler.wakePhrase}`)
            .catch((e) => console.error('[poke-compact]', e && e.message));
        }
        sendUI('usage', { sid, usage: butler.usage() });
        persist();
      }
      sendUI('turn-result', { sid, finalText, interrupted, compacted });
    },
  });

  const s = { sid, butler, convo, persist };
  sessions.set(sid, s);
  saveOpenTabs();
  installPlugins(s);   // 从 registry 起 TG/bothub 插件 (v2: 通过 onMessage 回调直接唤醒, 也给热切换用)
  return s;
}

// 统一的"起插件"入口 (openPersona 首次 / update-persona 热切换都调它): 从 registry 拿最新配置起 TG/bothub。
// 幂等 — 已在跑的先 stop 再 new + start, 不会重启失败。
async function installPlugins(s) {
  // 停旧 (若有)
  if (s.tgPlugin)     { try { await s.tgPlugin.stop();     } catch (_) {}  s.tgPlugin = null; }
  if (s.bothubPlugin) { try { await s.bothubPlugin.stop(); } catch (_) {}  s.bothubPlugin = null; }
  // 起新
  const entry = registry.getByDir(s.butler.homeDir);
  const plugins = (entry && entry.plugins) || {};
  const tgOnMessage = (record) => {
    if (s.butler.isRunning()) {
      // 忙就跳: 消息已落 in_file 兜底, butler 空闲后可自查 tail
      pluginLog(`[tg:${s.butler.name}] 忙, 收到消息暂不唤醒 (已落 in_file, update_id=${record.update_id})`);
      return;
    }
    const preview = (record.text || '').slice(0, 200);
    s.convo.push({ role: 'system', text: `🔔 TG 消息 from @${record.from_name || record.from_id} (chat ${record.chat_id}): ${preview.slice(0, 40)}`, ts: Date.now() });
    s.persist();
    s.butler.submit(
      [
        `（系统自动·TG 消息）from @${record.from_name || 'anon'}(${record.from_id}) 在 chat ${record.chat_id} · update_id=${record.update_id}`,
        '',
        preview,
        '',
        `回复请调 send_tg 工具: chat_id=${record.chat_id}${record.reply_to ? ` (可 reply_to=${record.reply_to} 引用原消息)` : ''}。`,
        '按正常判断处理, 回不回、回什么由你决定。'
      ].join('\n')
    ).catch((e) => console.error('[tg-onmessage]', e && e.message));
  };
  s.tgPlugin = new TgPlugin(plugins.tg, s.butler.name, pluginLog, s.butler.memoryDir, tgOnMessage);
  // v2: 把 bot_token 注入 butler, 供 MCP send_tg 工具用 (每次 installPlugins 都刷, 支持热切换 token)
  s.butler.setTgConfig(plugins.tg || {});
  const rTg = s.tgPlugin.start(s.butler.homeDir);
  if (!rTg.ok) pluginLog(`[tg:${s.butler.name}] 启动失败: ${rTg.error}`);
  else if (rTg.mode === 'native') pluginLog(`[tg:${s.butler.name}] ✅ native long polling 启动`);
  const bothubCfg = { ...(plugins.bothub || {}), _offsetDir: s.butler.memoryDir };
  s.bothubPlugin = new BothubPlugin(bothubCfg, s.butler.name, pluginLog, (evt) => {
    if (s.butler.isRunning()) return;
    s.convo.push({ role: 'system', text: `🔔 收到 bothub 新消息 (${evt.count} 条 from ${evt.agent})`, ts: Date.now() });
    s.persist();
    s.butler.submit(`（系统自动·bothub 唤醒）agent-bus 收到 ${evt.count} 条新消息 (endpoint ${evt.endpoint}, agent=${evt.agent})。请按 agent-bus 通道协议查阅并处理。`)
      .catch((e) => console.error('[poke-bothub]', e && e.message));
  });
  const rBh = s.bothubPlugin.start(s.butler.homeDir);
  if (rBh.mode === 'native') pluginLog(`[bothub:${s.butler.name}] ✅ native 起 ${rBh.count} 个 endpoint`);
}

// 管家用: 按引用(人格名/id/目录)打开人格 → 新标签。给渲染层推 persona-opened 事件加标签。
function openPersonaByRef(ref) {
  const e = registry.resolveRef(ref);
  if (!e) return { ok: false, error: '未找到人格: ' + ref };
  const s = openPersona(e.homeDir);
  const meta = metaOf(s);
  sendUI('persona-opened', { meta });   // 渲染层收到 → makeTab 激活
  return { ok: true, id: e.id, name: e.name, homeDir: e.homeDir, sid: s.sid };
}

// 多人格互通(星型): 管家问另一个人格一个问题 → 目标 Butler.askOnce → 返回 finalText。
// depth 上限 3 防环 (专家又反问回管家再回专家...)。目标未开则先开。
async function askPersona(targetRef, question, opts = {}) {
  const target = registry.resolveRef(targetRef);
  if (!target) return { ok: false, error: '未找到人格 ' + targetRef };
  const depth = (opts.depth || 0) + 1;
  if (depth > 3) return { ok: false, error: '防环: depth > 3, 当前调用链太深' };
  let s = sessions.get(sidOf(target.homeDir));
  if (!s) { s = openPersona(target.homeDir); sendUI('persona-opened', { meta: metaOf(s) }); }
  const wrapped = `【来自「${opts.fromName || '管家'}」的询问 (多人格互通 · depth=${depth})】\n\n${question}\n\n(请直接答, 你的答复会作为工具返回值给发起方; 用户也会在两边 UI 里看到这段对话)`;
  try {
    const answer = await s.butler.askOnce(wrapped);
    return { ok: true, answer, from: target.name };
  } catch (e) { return { ok: false, error: String(e && e.message) }; }
}

// 管家用: 新建人格 → 出生礼物 6 件套(目录+登记簿+MEMORY.md+persona.md+wake.txt+图起步节点) → 打开。
// P6a (2026-07-07 知秋钦定): 新人格出生就有身份+记忆体系, 不再自称"全能管家"。
function createPersona(spec = {}) {
  try {
    const name = String(spec.name || '').trim();
    if (!name) return { ok: false, error: '缺人格名' };
    let homeDir = spec.homeDir && String(spec.homeDir).trim();
    if (!homeDir) homeDir = path.join(__dirname, 'personas', registry.slug(name));
    homeDir = path.resolve(homeDir);
    fs.mkdirSync(homeDir, { recursive: true });
    // 登记簿(内存元数据)
    const entry = registry.upsert({
      id: registry.slug(name), name, homeDir,
      wakePhrase: spec.wakePhrase || undefined,
      isButler: !!spec.isButler,
    });
    // 出生礼物落磁盘: MEMORY.md 骨架 + persona.md 身份骨架 + wake.txt(若配置)
    const memoryDir = persona.resolveMemoryDir(homeDir);
    persona.ensureMemory(memoryDir, name);
    persona.ensurePersonaFile(homeDir, memoryDir, name, spec.wakePhrase);
    persona.ensureWakeFile(homeDir, memoryDir, spec.wakePhrase);
    // P6c: 自动软链人格记忆到 CC 项目条目 (~/.claude/projects/<slug>/memory) → CC 会话共享同一份图记忆
    const ccLink = persona.ensureCcSymlink(homeDir, memoryDir);
    if (!ccLink.ok) console.log('[createPersona] CC 软链跳过:', ccLink.error);
    else if (ccLink.link) console.log('[createPersona] CC 软链 →', ccLink.link);
    // 开人格(实例化 Butler → 载好 memory 图引擎)
    const s = openPersona(homeDir);
    // 出生礼物最后一件: 图记忆自我认知起步节点(pinned, 每次 memory_hot 都会出现)
    try {
      const now = new Date().toISOString();
      s.butler.memory.upsert({
        id: 'self_identity',
        type: 'user',
        importance: 'pinned',
        title: `我是 ${name}`,
        description: `${name} 的身份基础事实 + 记忆系统使用指南 (出生礼物)`,
        body: `## 基础事实\n- 名字: ${name}\n- 目录: ${homeDir}\n- 记忆目录: ${memoryDir}\n- 唤醒语: ${spec.wakePhrase || '(默认)'}\n- 建于: ${now}\n- 创建者: ${spec.created_by || 'butler'}\n\n## 记忆系统使用姿势\n- **续线程 / 找旧知识**: \`memory_query "关键词"\` (图扩散检索, top-K + 路径, 再 Read)\n- **最近在忙啥**: \`memory_hot\` (遗忘曲线排序)\n- **沉淀新知识**: \`memory_upsert\` (拆原子节点 + [[links]] 连相关, 别写日期日志)\n- **用到某条**: \`memory_touch <id>\` (强化热度)\n- **图健康**: \`memory_doctor\` (孤儿/悬空/命名漂移)\n\n## 身份宣言在哪\n\`persona.md\` (${path.join(memoryDir, 'persona.md')}) 是我的身份档案, butler 每次会话加载时把它作为 identity 注入系统提示。空着 = 通用管家, 填满 = 独立灵魂 ${name}。\n\n## 关联\n[[project_butler_persistence_wake_engine]] · [[project_butler_no_menus_talk_to_it]]`,
        links: ['project_butler_persistence_wake_engine', 'project_butler_no_menus_talk_to_it'],
      });
    } catch (e) { console.error('[createPersona] self_identity 沉淀失败:', e && e.message); }
    const meta = metaOf(s);
    sendUI('persona-opened', { meta });
    broadcastRegistry();
    return { ok: true, id: entry.id, name: entry.name, homeDir: entry.homeDir, sid: s.sid };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// 会话元信息(供渲染层建标签; 历史消息按需再拉 get-history)
const metaOf = (s) => ({ sid: s.sid, persona: personaOf(s.butler), usage: s.butler.usage() });

function createWindow() {
  mainWin = new BrowserWindow({
    width: 980, height: 780, title: '全能管家', backgroundColor: '#1e1e28',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  // 关闭主窗口前确认 (防手滑; 会话已落盘重启可续, 但确认防意外)
  let _confirmedQuit = false;
  mainWin.on('close', (e) => {
    if (_confirmedQuit) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWin, {
      type: 'question', buttons: ['关闭', '取消'], defaultId: 1, cancelId: 1,
      title: '关闭 butler',
      message: '关闭 butler 主窗口?',
      detail: '所有人格会话已落盘, 重启后可续。',
    });
    if (choice === 0) { _confirmedQuit = true; mainWin.close(); }
  });
  mainWin.on('closed', () => { mainWin = null; });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  // 恢复上次打开的标签(至少有默认人格)
  const dirs = loadOpenTabs().filter((d) => { try { return fs.existsSync(d); } catch (_) { return false; } });
  const toOpen = dirs.length ? dirs : [DEFAULT_HOME];
  // 登记簿迁移: 确保每个要开的目录都有条目; 没有管家则把第一个打开的设为管家(open/create 工具才可用, 知秋可后续在 UI 改指定)
  for (const d of toOpen) registry.ensureEntry(d);
  registry.ensureButler(toOpen[0]);
  for (const d of toOpen) openPersona(d);
  createWindow();
});
// app 退出前: 收所有人格的托管子进程(TG+bothub), 根治孤儿。同步 kill(before-quit 不 await, 用 SIGTERM 兜底)。
app.on('before-quit', () => {
  for (const s of sessions.values()) {
    try { s.tgPlugin && s.tgPlugin.stop(); } catch (_) {}
    try { s.bothubPlugin && s.bothubPlugin.stop(); } catch (_) {}
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// —— IPC: 全部按 payload.sid 找到对应人格 ——
const sessionFor = (sid) => sessions.get(sid);

// 渲染层启动: 拿到所有已开标签(含默认活动标签)
ipcMain.handle('list-sessions', async () => ({
  sessions: [...sessions.values()].map(metaOf),
  active: sessions.size ? [...sessions.keys()][0] : null,
}));

// 登记簿里所有人格(供 ＋号 picker / 管理窗口用); 标记哪些已打开
ipcMain.handle('list-personas', async () => ({
  personas: registry.list().map((p) => ({
    id: p.id, name: p.name, homeDir: p.homeDir, isButler: !!p.isButler,
    wakePhrase: p.wakePhrase || '', plugins: p.plugins || {}, open: sessions.has(sidOf(p.homeDir)),
    // 状态: 已开人格的托管子进程实况(pid/exit); 未开=null
    pluginStatus: (() => {
      const s = sessions.get(sidOf(p.homeDir));
      return s ? { tg: s.tgPlugin && s.tgPlugin.status(), bothub: s.bothubPlugin && s.bothubPlugin.status() } : null;
    })(),
  })),
}));
// 按引用打开已登记人格(＋号 picker 选中 → 开标签)
ipcMain.handle('open-persona-ref', async (_e, { ref } = {}) => openPersonaByRef(ref));

ipcMain.handle('get-history', async (_e, { sid } = {}) => {
  const s = sessionFor(sid);
  if (!s) return { messages: [], usage: null, persona: null };
  return { messages: s.convo, usage: s.butler.usage(), persona: personaOf(s.butler) };
});

ipcMain.handle('send-message', async (_e, payload = {}) => {
  const s = sessionFor(payload.sid);
  if (!s) return { ok: false, error: '标签无会话' };
  const text = payload.text || '';
  const attachments = payload.attachments || [];
  s.convo.push({ role: 'user', text, img: attachments.length, ts: Date.now() });
  try { await s.butler.submit(text, attachments); return { ok: true }; }
  catch (e) { return { ok: false, error: String((e && e.stack) || e) }; }
});

ipcMain.handle('compact', async (_e, { sid } = {}) => {
  const s = sessionFor(sid);
  if (!s) return { ok: false, error: '标签无会话' };
  try {
    const r = await s.butler.doCompact('手动');
    s.convo.push({ role: 'system', text: `🗜 已压缩 · 交接摘要 ${r.summary ? r.summary.length : 0} 字`, ts: Date.now() });
    s.persist();
    sendUI('usage', { sid, usage: s.butler.usage() });
    return { ok: true, ...r };
  } catch (e) { return { ok: false, error: String((e && e.stack) || e) }; }
});

// 新建/打开人格标签: 选一个目录(空=新建, 已有=续上) → 建会话, 返回元信息给渲染层加标签
ipcMain.handle('open-persona', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择人格目录(空目录=新建人格, 已有目录=续上)',
  });
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false };
  const s = openPersona(r.filePaths[0]);
  return { ok: true, meta: metaOf(s) };
});

// 点击打开文件: 渲染层点路径链接 → 默认程序打开(reveal=true 则 Finder 定位)。只放行本机真实存在的路径。
ipcMain.handle('open-path', async (_e, { path: p, reveal } = {}) => {
  try {
    if (!p || typeof p !== 'string') return { ok: false, error: '空路径' };
    let abs = p.startsWith('~/') ? path.join(require('os').homedir(), p.slice(2)) : p;
    abs = path.resolve(abs);
    if (!fs.existsSync(abs)) return { ok: false, error: '路径不存在' };
    if (reveal) { shell.showItemInFolder(abs); return { ok: true }; }
    const err = await shell.openPath(abs);   // 返回空串=成功, 非空=错误信息
    return err ? { ok: false, error: err } : { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

// 管理 UI: 建人格(独立入口, 不经管家工具) → 同 createPersona 但广播登记簿变更
ipcMain.handle('create-persona-ui', async (_e, spec = {}) => {
  const r = createPersona(spec);
  if (r.ok) broadcastRegistry();
  return r;
});

// 管理 UI: 改人格(name / wakePhrase / isButler); 已打开的标签同步刷新元信息
ipcMain.handle('update-persona', async (_e, { id, patch } = {}) => {
  const cur = registry.get(id);
  if (!cur) return { ok: false, error: '无此人格' };
  // plugins 深合并(前端提交只带 tg/bothub, mcp 名单从 cur 保留)。
  // 关键防呆: 剔除 patch 里 undefined 字段, 不然 { ...cur, ...patch } 会用 undefined 覆盖 cur 的有效值 (blame: 血泪 lost plugins)。
  const cleanPatch = {};
  for (const k of Object.keys(patch || {})) if (patch[k] !== undefined) cleanPatch[k] = patch[k];
  const next = { ...cur, ...cleanPatch, id };
  if (cleanPatch.plugins) next.plugins = { ...(cur.plugins || {}), ...cleanPatch.plugins };
  registry.upsert(next);
  // 已打开的 Butler 也同步(wakePhrase 影响下次压缩自愈; name 影响标签显示)
  const sid = sidOf(cur.homeDir);
  const s = sessions.get(sid);
  if (s) {
    if (cleanPatch.name) s.butler.name = cleanPatch.name;
    if (cleanPatch.wakePhrase !== undefined) s.butler.wakePhrase = cleanPatch.wakePhrase;
    if (cleanPatch.isButler !== undefined) s.butler.isButler = !!cleanPatch.isButler;
    sendUI('persona-opened', { meta: metaOf(s) });   // 让渲染层刷标签名字
    // 热切换 TG/bothub 插件: 保存新配置后立刻 stop 旧的、new 起新的, 不用关标签重开
    if (cleanPatch.plugins) {
      installPlugins(s).catch((e) => console.error('[hot-reload plugins]', e && e.message));
    }
  }
  broadcastRegistry();
  return { ok: true };
});

// 管理 UI: 删除登记簿条目(不删磁盘上的目录/记忆, 只是不再列在 picker; 目录仍可手动打开)
ipcMain.handle('delete-persona', async (_e, { id } = {}) => {
  const cur = registry.get(id);
  if (!cur) return { ok: false, error: '无此人格' };
  // 已打开的标签: 拒绝删(先关标签再删)
  if (sessions.has(sidOf(cur.homeDir))) return { ok: false, error: '该人格标签在打开中, 请先关闭' };
  const ok = registry.remove(id);
  if (ok) broadcastRegistry();
  return { ok };
});

// 管理 UI: 读某人格的 persona.md 全文 (供编辑面板显示; 首次没有则用当前骨架生成)
ipcMain.handle('read-persona-md', async (_e, { id } = {}) => {
  const p = registry.get(id);
  if (!p) return { ok: false, error: '无此人格' };
  const memoryDir = persona.resolveMemoryDir(p.homeDir);
  persona.ensurePersonaFile(p.homeDir, memoryDir, p.name, p.wakePhrase);
  const mdPath = path.join(memoryDir, 'persona.md');
  try { return { ok: true, path: mdPath, content: fs.readFileSync(mdPath, 'utf8') }; }
  catch (e) { return { ok: false, error: String(e && e.message) }; }
});
// 管理 UI: 写回 persona.md; 若人格已开, 同步刷新 Butler.personaText → 下条消息立刻生效
ipcMain.handle('write-persona-md', async (_e, { id, content } = {}) => {
  const p = registry.get(id);
  if (!p) return { ok: false, error: '无此人格' };
  const memoryDir = persona.resolveMemoryDir(p.homeDir);
  const mdPath = path.join(memoryDir, 'persona.md');
  try { fs.writeFileSync(mdPath, content, 'utf8'); } catch (e) { return { ok: false, error: String(e && e.message) }; }
  const sid = sidOf(p.homeDir);
  const s = sessions.get(sid);
  if (s) { s.butler.personaText = content; sendUI('persona-opened', { meta: metaOf(s) }); }   // 已开人格立刻生效, 下条消息就是新身份
  broadcastRegistry();
  return { ok: true, applied: !!s };
});

// 管理 UI: 建人格时选目录
ipcMain.handle('choose-directory', async () => {
  const r = await dialog.showOpenDialog(mainWin || managerWin, {
    properties: ['openDirectory', 'createDirectory'], title: '选择人格目录',
  });
  return (r.canceled || !r.filePaths || !r.filePaths.length) ? { ok: false } : { ok: true, path: r.filePaths[0] };
});

// 开独立管理窗口(单例; 再点=前置)
ipcMain.handle('open-manager-window', async () => {
  if (managerWin && !managerWin.isDestroyed()) { managerWin.focus(); return { ok: true }; }
  managerWin = new BrowserWindow({
    width: 720, height: 560, title: '人格管理', backgroundColor: '#1e1e28', parent: mainWin,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  managerWin.on('closed', () => { managerWin = null; });
  managerWin.loadFile(path.join(__dirname, 'renderer', 'manager.html'));
  return { ok: true };
});

// 关闭标签: 停掉大脑释放资源(会话文件留盘, 下次可续)。不许关到一个不剩。
ipcMain.handle('close-session', async (_e, { sid } = {}) => {
  const s = sessionFor(sid);
  if (!s) return { ok: false, error: '无此标签' };
  if (sessions.size <= 1) return { ok: false, error: '至少保留一个标签' };
  if (s.tgPlugin)     { try { await s.tgPlugin.stop();     } catch (_) {} }
  if (s.bothubPlugin) { try { await s.bothubPlugin.stop(); } catch (_) {} }
  try { await s.butler.dispose(); } catch (_) {}
  sessions.delete(sid);
  saveOpenTabs();
  return { ok: true, remaining: [...sessions.keys()] };
});
