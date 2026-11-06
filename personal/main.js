// main.js — Electron 主进程: 单窗口·多标签(MDI) — 每标签=一个人格/记忆体, IPC 按 sid(人格目录) 路由。
// 多个 Butler 大脑并存(各自 1M 上下文/各自压缩), 事件都带 sid 分发到渲染层对应标签面板。
const { app, BrowserWindow, ipcMain, dialog, shell, session, systemPreferences, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// 🔴 宿主接线必须排在**任何 core 模块之前** —— core 里有模块在加载那一刻就取 paths
// (如 agent/util.js 的 CLAUDE_BIN), 接线晚一行都会当场抛"宿主没注入"。
require('./host-wiring'); require('./image-save-ipc'); require('./channels/ipc'); const { windowBg } = require('./theme-ipc'); require('./hub-ipc').onClaimed(async (id, { agent } = {}) => { broadcastRegistry(); const c = registry.get(id); const s = c && sessions.get(sidOf(c.homeDir)); if (!s) return; await installPlugins(s); s.butler.submit(`[hub-connected] You are now connected to the hub as ${agent}. Other agents can reach you there, and their messages arrive in your inbox.`, undefined, { sourceKind: 'auto' }).catch(() => {}); });   // 后者=连公网 hub 的 IPC(自注册, 单开文件因 main.js 撞行数闸); 回调=取到 token 当场起收件循环(否则要重启才收件)、刷新人格页、告诉人格它接上了

const { Butler, hasUnconsumedCtxLast, accessConfig } = require('../core/agent');
const store = require('../core/chat-store');
const registry = require('../core/registry');
const persona = require('../core/persona');
const personaTransfer = require('./persona-transfer'); const firstPersona = require('./first-persona');   // 人格搬家(换机器) · 第一个人格的诞生(没接 AI 就不建, 见 first-persona.js)
const paths = require('./paths'); const modelOptions = require('../core/model-options');   // 后者=模型下拉清单现拉(订阅/网关两条路) + 登录态凭证读取
const { TgPlugin } = require('./plugins/tg');
const { BothubPlugin } = require('./plugins/bothub');
const { LineRelayChannel } = require('./plugins/line-relay');
const { AgentBusChannel } = require('./plugins/agent-bus');
const { LocalApiServer } = require('./plugins/local-api');   // 本机 HTTP 戳醒 API · 进程级单例(不进 installPlugins)
const voiceSay = require('../core/voice-say');   // 情感语音播报 · macOS say adapter · SSML 子集 → 私有指令
const voiceStt = require('../core/voice-stt');   // 本地 STT · whisper.cpp adapter, 两版共用
// Mac 包里带 universal whisper-cli(arm64+x86_64, 不靠 brew); 模型仍首用时下到可写根。
// 未打包时 resourcesPath 下没有 whisper/, findCli 自然落到下载位与 brew。
voiceStt.setVendorRoots({ bundled: process.resourcesPath, writable: paths.dataDir() });
const cfg = require('./config-loader');   // 提示语外置 · config/ · 热读
const birth = require('./birth');         // 出生教育 v2: 灌知识 + 体验校验(不依赖会话的那半边)
const settings = require('./settings'); require('./debug-port');   // 用户设置(接入方式/代理/界面语言…) · 数据目录 app/settings.json; 后者=远程调试口开关(默认关, appendSwitch 必须在 ready 前所以挂这儿)
const secrets = require('./secrets');     // 加密凭据(API key) · 走系统钥匙串, 不进明文 settings.json
const i18n = require('./i18n');           // 界面语言字典 · 只管程序自己说的话(AI 回复跟着对话语言走)
const proxy = require('./proxy');         // 代理接线: env(子进程) + undici 全局 dispatcher(所有 fetch)
const capUpdate = require('../core/capability-update');   // 升级补课: 老人格在新版本首次开机时补新增能力
const factory = require('../core/factory-sync');          // 出厂知识同步: 冷启动无条件跑, 不挂在版本号上
const migrateV2 = require('../core/memory-migrate-v2');   // 只用它的 detectStart: 启动提示窗要报"这次迁多少条"
const packages = require('../core/packages');   // 下发物的落地口 · 封筒原样存, 每次读都重验签
const packageInbox = require('../core/package-inbox');   // bus 上的包在这里下车 · 包一律不进 AI
const workflow = require('../core/workflow');   // 手顺引擎 · 定义只从签名包里来(包里只有数据没有函数)
const workflowProgress = require('../core/workflow-progress');
const uiPackages = require('../core/ui-packages');
const uiState = require('../core/ui-state');
const commands = require('../core/commands');   // 行内命令目录 · 个人版只有 local 一条路
const dbConn = require('../core/db').create({ controlDir: paths.controlDir, dataDir: paths.dataDir });

// 日志时间戳走本地时区: toISOString 是 UTC, 排查时会把 JST 看错 9 小时.
const _p2 = (n) => String(n).padStart(2, '0');
function localDay(d = new Date()) { return `${d.getFullYear()}-${_p2(d.getMonth() + 1)}-${_p2(d.getDate())}`; }
function localStamp(d = new Date()) {
  const off = -d.getTimezoneOffset(), ab = Math.abs(off);
  return `${localDay(d)}T${_p2(d.getHours())}:${_p2(d.getMinutes())}:${_p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}${off >= 0 ? '+' : '-'}${_p2(Math.floor(ab / 60))}:${_p2(ab % 60)}`;
}

// 主进程日志落盘。打包后的 GUI 进程在 Windows 上根本没有终端, console.log 一个字都拿不到 ——
// 开发机是 mac 而实测机是 Windows 时, 没有这个文件就只能靠猜。位置取 bootstrapDir(app ready 之前
// 就可用, 且不受用户后面选的数据目录影响, 固定好找): 打包=userData(Windows %APPDATA%\butler\main.log),
// dev=~/.butler-dev(或 BUTLER_DATA_DIR) —— 否则 dev 实例的主进程日志会插进装机版那一份里。
function installFileLogger() {
  try {
    const file = path.join(paths.bootstrapDir(), 'main.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + '.1'); } catch (_) {}
    const out = fs.createWriteStream(file, { flags: 'a' });
    const util = require('util');
    const coreVer = (() => { try { return require('../core/package.json').version; } catch (_) { return '?'; } })();
    out.write(`\n===== ${localStamp()} butler ${app.getVersion()} (core ${coreVer}) ${process.platform} =====\n`);
    for (const lv of ['log', 'warn', 'error']) {
      const orig = console[lv].bind(console);
      console[lv] = (...a) => {
        orig(...a);
        try {
          out.write(`${localStamp()} [${lv}] `
            + a.map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 2 }))).join(' ') + '\n');
        } catch (_) {}
      };
    }
    console.log('[log] 主进程日志 →', file);
  } catch (_) { /* 日志本身绝不能拦住启动 */ }
}
installFileLogger();

// UI 剥标签: 无条件剥掉 SSML 原语白名单 (即使语音关时模型手滑输出, 也不让标签暴露给用户).
// UI 侧剥标签与流式 hidden 抑制已收进 core/voice-say.js, 两版共用一份。
const { stripSsmlTags, makeHiddenStreamFilter } = voiceSay;
// —— 常驻文件日志 —— 拦截 console.log/warn/error/info → 除原 stdout/stderr 外, 追加到 bootstrapDir/logs/butler-YYYY-MM-DD.log
// 位置 = paths.bootstrapDir()(打包版=userData, dev=仓库根), 首启选数据目录之前也能写(bootstrapDir 永远可写)。
// 按天 rotate, 保留 7 天。也捕获 uncaughtException/unhandledRejection —— talk_peer 挂/SDK EPIPE 等静默错误在这能捞到 stack。
// 打包版 Finder 起动看不到 stderr → 装完就有日志文件, 事后诸葛不依赖复现。
(function initFileLogger() {
  try {
    const logsDir = path.join(paths.bootstrapDir(), 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    // 清理 > 7 天的老 log
    try {
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
      for (const f of fs.readdirSync(logsDir)) {
        if (!/^butler-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
        const p = path.join(logsDir, f);
        if (fs.statSync(p).mtimeMs < cutoff) try { fs.unlinkSync(p); } catch (_) {}
      }
    } catch (_) {}
    let stream = null;
    let currentDay = '';
    const openStream = () => {
      const day = localDay();
      if (day === currentDay && stream) return stream;
      if (stream) try { stream.end(); } catch (_) {}
      currentDay = day;
      stream = fs.createWriteStream(path.join(logsDir, `butler-${day}.log`), { flags: 'a' });
      return stream;
    };
    openStream();
    const fmt = (a) => (typeof a === 'string' ? a : (a && a.stack) ? a.stack : (() => { try { return JSON.stringify(a); } catch (_) { return String(a); } })());
    const write = (level, args) => {
      try { openStream().write(`[${localStamp()}] [${level}] ${args.map(fmt).join(' ')}\n`); } catch (_) {}
    };
    const orig = { log: console.log.bind(console), error: console.error.bind(console), warn: console.warn.bind(console), info: console.info.bind(console) };
    console.log = (...a) => { write('INFO', a); orig.log(...a); };
    console.info = (...a) => { write('INFO', a); orig.info(...a); };
    console.warn = (...a) => { write('WARN', a); orig.warn(...a); };
    console.error = (...a) => { write('ERROR', a); orig.error(...a); };
    process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.stack || e));
    process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r && r.stack || r));
    orig.log(`[logger] 文件日志已启用: ${path.join(logsDir, `butler-${currentDay}.log`)} (按天 rotate, 保留 7 天)`);
    console.log(`[logger] boot at ${localStamp()} isPackaged=${paths.isPackaged()} dataDir=${paths.dataDir()}`);
  } catch (e) {
    // 日志初始化失败别拖死主进程, 静默降级
    try { require('electron').dialog.showErrorBox('日志初始化失败(不影响主功能)', String(e && e.stack || e)); } catch (_) {}
  }
})();

const pluginLog = (line) => { try { console.log(line); } catch (_) {} };   // 现在 pluginLog 走 console.log 会自动落文件

// sid = 人格目录(绝对路径) → 天然去重: 一个目录 = 一个标签。sessions: sid -> { butler, convo, persist }
const sessions = new Map();
// (单向异步改造后已无双向互等死锁 → 原 pendingWaits 反向死锁防护移除: 反向 ask/talk 正是期望的"回复"。)
// 记住打开了哪些标签(重启恢复)。开发=仓库根; 打包=用户数据目录。函数化: 首启选目录后位置会变。
const tabsFile = () => paths.tabsFile();
let mainWin = null;
let managerWin = null;   // 独立管理窗口(可空; 关了置 null)
let settingsWin = null;  // 独立系统设置窗口(同上)
let relaunchApp = () => { app.relaunch(); app.quit(); };   // createWindow 里换成走退出链(沉淀 + 不弹「彻底退出?」框)

const sidOf = (homeDir) => path.resolve(homeDir);

// #9 图片附件磁盘化: sha256 hash 去重 + 按日期分目录 · 落到 homeDir/attachments/YYYY-MM-DD/<hash>.<ext>
// 只处理 image/* · 其他附件不落盘(渲染层仍走 fallback 📎N)
const IMG_EXT = { 'image/png':'png', 'image/jpeg':'jpg', 'image/jpg':'jpg', 'image/webp':'webp', 'image/gif':'gif', 'image/heic':'heic', 'image/heif':'heif', 'image/bmp':'bmp' };
// 门口白名单: 未来附件类型扩(pdf/audio/video)时这里是唯一的门, 现在建门比事后追门稳
const IMG_EXT_ALLOW = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.heif', '.bmp']);
function _dateDir() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function saveImageAttachment(homeDir, a) {
  const mt = a.mediaType || '';
  if (!mt.startsWith('image/')) return null;
  const ext = IMG_EXT[mt] || 'bin';
  const buf = Buffer.from(a.base64 || '', 'base64');
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const dir = path.join(homeDir, 'attachments', _dateDir());
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, `${hash}.${ext}`);
  if (!fs.existsSync(full)) fs.writeFileSync(full, buf);   // dedup: 相同 hash 直接复用
  // 存相对路径(相对 homeDir): 迁移/rename homeDir/导出对话都不断链, 而绝对路径 3 场景全失效
  return { path: path.relative(homeDir, full), mediaType: mt, name: a.name || `${hash}.${ext}` };
}
const sendUI = (ch, payload) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(ch, payload); };
// 提醒由主进程统一盯, 到点挂横幅(personal/reminder-center.js); 人点「处理」才打开人格。
const reminderCenter = require('./reminder-center').create({ registry, persona, sendUI, log: (m) => console.log(m) });
// 登记簿有变(建/改/删) → 主窗 + 管理窗口都刷列表
const broadcastRegistry = () => {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('registry-changed');
  if (managerWin && !managerWin.isDestroyed()) managerWin.webContents.send('registry-changed');
};
const personaOf = (b) => ({ name: b.name, avatar: b.avatar || '', homeDir: b.homeDir, memoryDir: b.memoryDir, isButler: !!b.openedAsButler });

// —— 打开标签列表持久化 ——
function loadOpenTabs() {
  try { const s = JSON.parse(fs.readFileSync(tabsFile(), 'utf8')); return Array.isArray(s.dirs) ? s.dirs : []; }
  catch (e) { if (e && e.code !== 'ENOENT') console.error('[tabs] 标签列表读不出, 改由登记簿决定开哪个:', e.message); return []; }
}
function saveOpenTabs() {
  try { fs.mkdirSync(path.dirname(tabsFile()), { recursive: true }); fs.writeFileSync(tabsFile(), JSON.stringify({ dirs: [...sessions.keys()] }), 'utf8'); } catch (_) {}
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

// 列出总控登记簿里的全部人格(管家用: 知道"有谁存在", 不依赖自己记忆里的花名册)。
// 数据来自中立总控 registry, 与"谁是管家"无关 → 换谁当管家都能查到同一份名单。
function listPersonas() {
  return registry.list().map((p) => ({
    name: p.name, id: p.id, homeDir: p.homeDir,
    isButler: !!p.isButler,
    isOpen: sessions.has(sidOf(p.homeDir)),
  }));
}

// 建一个人格会话(不建窗口): 目录化 Butler + 载它自己的会话 + 回调发到主窗(带 sid)。幂等: 已开则复用。
function openPersona(homeDir, { newborn = false } = {}) {
  const sid = sidOf(homeDir);
  if (sessions.has(sid)) return sessions.get(sid);

  const entry = registry.ensureEntry(homeDir);   // 登记簿(不在则迁移建条): 名字/唤醒语/是否管家 以它为准
  const butler = new Butler(homeDir, {
    pluginDir: packages.localDirOf(paths.dataDir()),
    name: entry.name, wakePhrase: entry.wakePhrase, isButler: entry.isButler, avatar: entry.avatar, model: entry.model, skills: entry.skills,
    accessMode: entry.accessMode, credentialId: entry.credentialId, sdk: entry.sdk,
    // v0.0.25 (2026-07-21 · A7 骨架): registry per-persona 配置传入, agent.js 已有 opts 优先级 (opts > env > default).
    // 用户手动 vim registry.json 或未来 UI 编辑, 重启 app 生效. 缺失=用当前 hardcode 默认.
    autoCompactPct: Number(entry.autoCompactPct) > 0 ? Number(entry.autoCompactPct) : null,
    autoCompactTok: Number(entry.autoCompactTok) > 0 ? Number(entry.autoCompactTok) : null,
  });
  // 语音: 从 registry 覆盖默认值 (persona 未配置则默认关, Tingting)
  butler.voice = { enabled: false, voice: 'Tingting', ...(entry.voice || {}) };
  butler.personaOps = { open: openPersonaByRef, create: createPersona, ask: askPersona, peerTalk, grantPeer, revokePeer, list: listPersonas,
    // prompt chips: AI 侧读/写自己的快捷按钮池(entry.id 闭包捕获, 不靠 agent.js 认识 registry)
    getChips: () => registry.resolveChips(entry.id),
    // 用量 + 清理建议。AI 拿它判"哪个是死按钮", 然后【问用户】要不要撤 —— 不自己删。
    chipUsage: () => registry.chipUsage(entry.id),
    setChips: (chips, opts) => {
      const r = registry.setCustomChips(entry.id, chips, opts);
      if (r.ok) sendUI('chips-changed', { sid, chips: registry.resolveChips(entry.id) });
      return r;
    },
    // 语音开关: 人格自己开关自己的嘴(作者 2026-08-19)。落盘 + 运行时同时改 —— 只改运行时的话
    // 关掉标签重开就跳回旧状态; 只落盘的话这一轮的物理门(播报判定读 butler.voice)不生效。
    // 不 push [voice-switch-notice]: 那条是给"被用户在设置里改了"的人格看的; 自己调的当场就知道,
    // 该怎么说由工具返回值带回去, 再烧一轮模型没道理。
    setVoice: ({ enabled, voice } = {}) => {
      const cur = registry.get(entry.id) || {};
      const next = {
        enabled: !!enabled,
        voice: voice || (cur.voice && cur.voice.voice) || 'Tingting',
      };
      registry.upsert({ ...cur, id: entry.id, voice: next });
      butler.voice = next;
      sendUI('persona-opened', { meta: metaOf(s) });   // 设置面板那个勾要跟着动
      broadcastRegistry();
      return next;
    },
    // 插件界面由系统自己画进气泡流。原先是工具返回一行 {{ui:}}/{{cmd:}} 让 AI 照抄 —— 抄写这一步
    // 既要花一轮 token 复读机器生成的字符串, 又拦不住模型顺手改写它(改了按钮就烂成死文字)。
    // 🔴 必须 push 进 convo: 只 sendUI 的话界面只活在这一次会话的 DOM 里, 重开 app 历史里那块就空了。
    // plugin_call: 人格跑插件开放给它的命令, 与按钮同一个执行器。
    runPluginCommand: (name, args) => commands.run(name, args || {}, commandCtx()),
    renderPlugin: (markup) => {
      const text = String(markup == null ? '' : markup).trim();
      if (!text) return false;
      convo.push({ role: 'assistant', text, ts: Date.now() });
      persist();
      sendUI('plugin-render', { sid, text });
      return true;
    },
  };   // 开/建/问/列(管家) + 叶子直连/授权回调 + 自调语音 + 系统直画插件界面
  const saved = loadSessionMigrating(butler);
  const convo = (saved && Array.isArray(saved.messages)) ? saved.messages : [];
  if (saved) butler.restore(saved);
  // 日志追加收在 persist 这一个口子上: convo.push 散在十几处, 逐处补写迟早漏一处,
  // 而漏掉的那条会永久不存在。这里按"已写到第几条"算差量, 所以只 push 没 persist 的
  // 也会在下一次 persist 时被补上。
  // logged 起点 = 载回的快照条数: 那些是上一程的尾巴, 日志里要么已有要么本就没有(旧版遗留),
  // 无论哪种都不该再写一遍 —— 写了就会在往上翻时看到重复的一段。
  const historyDir = path.join(path.dirname(butler.sessionPath), 'history');
  let logged = convo.length;
  const persist = () => {
    if (convo.length > logged) {
      // display:'' = 当初就没画给人看的机器标记(包按钮触发 / 命令没返回人话)。它们不进日志 ——
      // 界面靠"屏幕上有几条来自日志"定位下一页, 日志里混进不渲染的条目, 取 100 条只画出 90 条,
      // 下一页就重复 10 条。在这儿滤掉, 是让"日志一条 ↔ 屏幕一条"严格对上。
      store.appendHistory(historyDir, convo.slice(logged).filter((m) => m && m.display !== ''));
      logged = convo.length;   // 游标按 convo 走, 不按真写进去几条 —— 否则被滤掉的会被反复重读
    }
    return store.save(butler.sessionPath, { ...butler.exportState(), messages: convo });
  };

  // 先建 s 引用, 让 callbacks 能读 s.heartbeat_pending 做心跳期短路 (spec §1.5 A2 UI 隔离)
  // v0.0.25 (2026-07-21 · A7 骨架): registry 每人格配置全提取, 下游用 s.xxx || CONST fallback. 0=用默认.
  // 缺失/坏格式: Number(undefined) = NaN → 三元返 0, 走 CONST 兜底.
  const _num = (v) => Number(v) > 0 ? Number(v) : 0;
  const s = { sid, butler, convo, persist, historyDir, last_activity_ts: Date.now(), heartbeat_pending: false, last_heartbeat_ts: 0, lastCompactTs: 0, hiddenFilter: makeHiddenStreamFilter(),
    compactSoftTok: _num(entry.compactSoftTok),
    compactSoftIdleMin: _num(entry.compactSoftIdleMin),
    compactMinIntervalMs: _num(entry.compactMinIntervalMs),
    compactHardcapSoftTok: _num(entry.compactHardcapSoftTok),
    compactHardcapIdleMin: _num(entry.compactHardcapIdleMin),
    compactHardcapMinIntervalMs: _num(entry.compactHardcapMinIntervalMs),
    keepaliveMinTok: _num(entry.keepaliveMinTok),
    keepaliveCutoffMin: _num(entry.keepaliveCutoffMin),
    heartbeatCooldownMs: _num(entry.heartbeatCooldownMs),
  };

  // 执行一轮结束时登记的压缩(模型调了 compact_context / 占用过阈值)。onTurnEnd 调, 一轮必发, 静音轮也到得了。
  // 完成提示走 compacting 通道, 不走 turn-result: 清空后唤醒那一轮可能已经在流式输出, 再补一条 turn-result 会把它的气泡撤掉。
  async function runTurnEndCompact(compactReason) {
    appendButlerEvent(butler.name, 'compact_triggered', { source: 'onTurnEnd', reason: compactReason });
    let compacted;
    try { compacted = await butler.doClearWithSediment(compactReason); } catch (e) { compacted = { ok: false, error: String(e) }; }
    if (compacted && compacted.ok) {
      s.lastCompactTs = Date.now();   // v4 防抖: 模型自主/回合末自动整理同样计入 30min 间隔
      convo.push({ role: 'system', text: `🧹 整理记忆·清空重启 · ${compacted.reason}`, ts: Date.now() });
      appendButlerEvent(butler.name, 'clear_completed', { source: 'onTurnEnd', reason: compactReason });
      sendUI('compacting', { sid, phase: 'done', autoDoneReason: compacted.reason });
      // 唤醒引导加载器已内置进 butler.doClearWithSediment, 此处无需再 poke。
    } else {
      appendButlerEvent(butler.name, 'compact_failed', { source: 'onTurnEnd', reason: compactReason, error: (compacted && compacted.error) || 'unknown' });
    }
    sendUI('usage', { sid, usage: butler.usage() });
    persist();
  }

  butler.setCallbacks({
    // 心跳轮的正文由 core 静音掐掉(agent/turn-mute.js), 这里不再另设一道 heartbeat_pending 短路:
    // 那道短路认的是"心跳发过了还没收尾", 心跳和真人那句被合成一轮时会把回真人的话一起吞掉。
    onText: (t) => {
      const visible = stripSsmlTags(s.hiddenFilter(t));
      if (visible) sendUI('assistant-chunk', { sid, text: visible });
    },
    // 文本块收尾 → 让渲染层立刻定稿(md 渲染 + 控件生效), 不必等整轮 result
    onTextDone: () => { sendUI('assistant-text-done', { sid }); },
    onActivity: (text) => { sendUI('activity', { sid, text }); },
    onTool: (tool) => { sendUI('tool-call', { sid, tool }); },   // 每个工具调用→持久条目
    onTasks: (tasks) => sendUI('tasks', { sid, tasks }),   // 任务清单变了→UI 重画那块面板
    onToolDone: (info) => { sendUI('tool-done', { sid, ...info }); },   // 工具完成→UI 变 checkmark (治"跟死了一样"假死感)
    onCompact: (info) => sendUI('compacting', { sid, ...info }),   // 压缩开始/结束→UI 动态指示
    // 一轮结束必发(静音轮也发), "必须做的事"全挂这里, 不挂 onResult —— 后者静音轮会被掐:
    //   ① 心跳标记与冷却时间戳复位 ② 被静音吞掉/流被拆掉的那一轮补一条空 turn-result, 让渲染层撤占位气泡并放开 busy
    //      (正常轮不发, 免得重复 markUnread 点亮假未读) ③ 执行登记过的压缩(2026-10-09 挂在 onResult 上被静音吞过)
    onTurnEnd: ({ interrupted, muted, torn, compactReason, held }) => {
      if (s.heartbeat_pending) { s.heartbeat_pending = false; s.last_heartbeat_ts = Date.now(); }
      if ((muted || torn) && !held) sendUI('turn-result', { sid, finalText: '', interrupted: false });
      if (compactReason) runTurnEndCompact(compactReason).catch((e) => console.error('[compact] onTurnEnd', e && e.message));
      // 模型又能正常回话了 → 上次没跑完的出生体验环节顺手补上(脱出消费循环再发, 免得与本轮收尾互等)
      else if (!interrupted && !torn && !held && !butler._lastTurnError && !butler._authBlocked) setImmediate(() => resumeBirth(s));
    },

    onUsage: (u) => sendUI('usage', { sid, usage: u }),   // usage 变化真实, 心跳期不 skip
    // 成本采样落盘: 每次 API 调用一行, 不进 UI 也不进上下文。事后 group by tools 即可看出谁在撑大上下文。
    onCtxSample: (sample) => appendButlerEvent(butler.name, 'ctx_sample', sample),
    // AskUserQuestion 转发 (dialogKind=ask_user_question): renderer 弹选项框, 用户答完调 answer-user-dialog IPC 回填.
    onUserDialogRequest: ({ dialogId, kind, payload, toolUseID }) => { console.error('[DIALOG-DIAG#3] main forwarding to UI', { sid, dialogId, kind, hasWin: !!(mainWin && !mainWin.isDestroyed()) }); sendUI('user-dialog', { sid, dialogId, kind, payload, toolUseID }); },
    // 认证失效 → 应用内常驻横幅(不走 TG: 不是每个用户都配了 TG, 通知手段必须自足)。
    // 心跳轮也要报: 401 期间人格是全哑的, 这时候瞒着用户没有任何好处。
    // kind 决定横幅给什么出口: 只有 oauth_expired 重登才真能修, 其余给重登按钮是把人往死路上指。
    // kind='cleared' 是反向信号 —— 人再发话已自愈解除挂起, 走 auth-ok 摘横幅。
    onAuthExpired: ({ name, kind, mode, raw }) => {
      console.error(`[access/${kind || 'unknown'}] ${name} ${kind === 'cleared' ? '挂起已解除 → 摘横幅' : `接入故障(mode=${mode}) · 原文=${JSON.stringify(raw || '')}`}`);
      sendUI(kind === 'cleared' ? 'auth-ok' : 'auth-expired', { sid, name, kind, mode, raw });
    },
    onRateLimit: ({ until, retryAfterMs, raw }) => {
      // rate-limit 全局暂停 idle-watch. 各人格独立记 rateLimitedUntil, 全局取 max.
      idleWatcher.setRateLimitedUntil(until);
      const secs = Math.round(retryAfterMs / 1000);
      console.log(`[rate-limit] ${butler.name} 撞铁板 → 全局暂停 ${secs}s (until ${localStamp(new Date(until))}) raw=${JSON.stringify(raw)}`);
      sendUI('rate-limited', { sid, until, retryAfterMs });
    },
    onResult: async ({ finalText, interrupted }) => {
      s.hiddenFilter.reset();   // 回合结束复位, 防上轮没闭合的 <hidden> 把下轮正文吞掉
      // auto 轮(提醒 / 体检 / 重试)结束不算有人活动 —— 否则每次提醒都把闲置时钟拨回 0。
      if (butler._turnSourceKind !== 'auto') s.last_activity_ts = Date.now();
      s.lastTurnWasQuestion = detectAssistantQuestion(stripSsmlTags(finalText || ''));   // AI 抛问句 → hard_cap_softened 不硬顶 (等回复中)
      // convo/persist/UI 存**剥标签后**的干净版本, speak 用原始 finalText (含 SSML). UI 层无 <speak> 标签暴露.
      const cleanText = stripSsmlTags(finalText || '');
      if (finalText) convo.push({ role: 'assistant', text: cleanText, ts: Date.now() });
      persist();
      // 情感语音播报: 物理门 = voice.enabled 判定 (systemPrompt 已指挥模型别打, 此为双保险: 关时即使模型手滑输出 <speak> 也不播).
      // 音色取 butler.voice.voice, 默认 Tingting. 打断/失败静默不阻塞主流程.
      if (!interrupted && finalText && butler.voice && butler.voice.enabled) {
        const speakBlock = voiceSay.extractSpeakBlock(finalText);
        if (speakBlock) {
          const voice = (butler.voice && butler.voice.voice) || 'Tingting';
          voiceSay.speak(speakBlock, { voice }).catch((e) => console.error('[voice-say]', e && e.message));
        }
      }
      sendUI('turn-result', { sid, finalText: cleanText, interrupted });
      maybeContinueTasks(s, { interrupted, sid });
    },
    // v0.0.23 · 关档前对话原话捕获数据源: butler doClearWithSediment 顶部调用, 单一真源 s.convo (拒双写)。
    // 过滤/截断/落盘全在 agent.js _captureRecentTurns, 这里只吐"最后 N 条 user+assistant"原样。
    getRecentTurns: (n) => (s.convo || [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
      .slice(-n)
      .map((m) => ({ role: m.role, text: m.text, ts: m.ts || 0 })),
  });

  // v5 冷启动 hook (2026-07-18): 首次开人格 (saved 无 assistant 消息) → 戳一次 wake 装通用铁律+MEMORY.md+hot 到首条,
  // 避免只有清空自愈(agent.js:1029 doClearWithSediment)才走 wake 造成的首开丢通用块。
  // v0.0.23 (2026-07-19 唐伯虎§4.8): 补 "关闭重开也 wake" 场景 —— saved 里有 assistant 但 ctx_last.json 未消费未 stale, 也戳一次 wake。
  // 否则关档前 sedimentOne 落盘的 ctx_last 白落, 新我接不上语境, 违背原始需求。
  // 判读逻辑抽 agent.js hasUnconsumedCtxLast (唐伯虎 2 审建议 · 就近同文件 · 单元测试友好)。
  const hasHadAssistant = convo.some((m) => m && m.role === 'assistant');
  // 第三个触发条件: butler 升级了而这个人格还不知道 → 也戳一次 wake, 好让补课段送达。
  // 少了这条, 升级补课对"老人格 + 关掉重开"这个最主要的场景根本不会发生 —— 老人格既不是新生、
  // 也未必留着未消费的 ctx_last, 两个旧条件都不成立, 它会一直用旧认知干活。
  let needsCapUpdate = false;
  try {
    const e = registry.getByDir(butler.homeDir);
    needsCapUpdate = !!e && capUpdate.needsUpdate(e.capabilitySeenVersion || '', paths.appVersion());
  } catch (_) {}
  // 🔴 出厂同步必须跑在这三个条件【之前】, 而且不受它们管辖。
  // 它原先住在 buildWakePayload() 里, 于是"改了出厂包但没动 app 版本号"时: 老人格不是新生、
  // 未必留着未消费 ctx_last、needsCapUpdate 又为假 → 三条件全不成立 → 同步一次都不跑,
  // 人格永远拿着旧版出厂知识, 且完全静默(2026-08-20 实测 dev 四个库全停在老版 body)。
  // 同步器幂等, 无条件跑一趟没有代价; 真有变动就当第四个触发条件, 好让人格知道自己变了什么。
  let factoryChanged = false;
  try { factoryChanged = factory.hasChanges(butler.runFactorySync().stats); } catch (_) {}
  if (!newborn && (!hasHadAssistant || hasUnconsumedCtxLast(butler.memoryDir) || needsCapUpdate || factoryChanged)) {
    try {
      const wakeBody = `(auto · first wake) ${butler.wakePhrase || `wake up ${butler.name}`}\n\n${butler.buildWakePayload()}`;
      // 用户侧更新说明: buildWakePayload 里跑完出厂同步才知道这版到底改了什么, 只能在它之后贴。
      // 走 system 消息不走 submit —— 给用户读的东西不该再烧一轮模型。
      // md:true 让渲染层把它当 markdown 整块渲染(system 气泡默认是纯文本小灰条, 一行路径
      // 既点不开也没人看见); kind 决定气泡样式 —— 这是张卡片, 不是分隔线。
      if (butler._updateNoteMd) {
        convo.push({ role: 'system', kind: 'update-note', md: true, text: butler._updateNoteMd, ts: Date.now() });
        butler._updateNoteMd = null;
      }
      butler.submit(wakeBody, undefined, { sourceKind: 'auto', _bypassClearGate: true })
        .catch((e) => console.error(`[cold-wake] ${butler.name} 首次唤醒 submit 失败: ${e && e.message}`));
    } catch (e) { console.error(`[cold-wake] ${butler.name} 构建唤醒失败: ${e && e.message}`); }
  } else if (!newborn) {
    // 没有唤醒轮可等 → 出生体验环节没做完的, 打开就补跑; 有唤醒轮的, 它正常回完时 onTurnEnd 会补
    setTimeout(() => resumeBirth(s), 1200);
  }

  sessions.set(sid, s);
  saveOpenTabs();
  installPlugins(s);   // 从 registry 起 TG/bothub 插件 (v2: 通过 onMessage 回调直接唤醒, 也给热切换用)
  return s;
}

// ——— 空闲期自我维护 (保活 / 压缩 / 体检 / 子进程回收) ———
// 调度层住在 core/idle-watcher.js, 两版共用一份 —— 大脑和记忆是内核, 这条轨道也是。
// 以前整套写在本文件里, 行业版一条都没接, 那边的人格从来没做过记忆体检。
const {
  createIdleWatcher, decideActions, markActivity, detectAssistantQuestion, TASK_CONTINUE_MAX, taskContinueDelayMs,
} = require('../core/idle-watcher');

const idleWatcher = createIdleWatcher({
  sessions: () => sessions.values(),
  personaCfg: (butler) => (butler && butler.homeDir && registry.getByDir(butler.homeDir)) || {},
  checkupDefaults: () => cfg.json('main/memory_checkup'),
  renderCheckupNudge: (v) => cfg.renderL('main/checkup_nudge', v), renderSaveNudge: (v) => cfg.renderL(`main/save_nudge_${v.tier}`, v),   // renderL=按语言, 这两条的回话用户看得见
  appendEvent: (name, event, meta) => appendButlerEvent(name, event, meta),
  // 定时任务(schedule.json)与提醒登记簿(reminders.json)的唯一驱动。只有开着的人格会被巡检到。
  scheduleHome: (butler) => (butler && butler.homeDir) || null,
  log: console.log,
});
const sendHeartbeat = (sid) => idleWatcher.sendHeartbeat(sessions.get(sid));


// 任务没做完就别停下 —— 回合结束时清单里还有活, 就把人格自己叫回来接着做。
//
// 为什么需要程序来管: "做完一个子步骤 → 写份汇报 → 回合结束"是模型的稳定行为,
// 靠提示语反复叮嘱不管用(实测叮嘱过很多次, 每次都还是停)。清单画在界面上只解决"看得见",
// 解决不了"接着做" —— 显示是给人看的, 续跑得由程序推。
//
// 🔴 四道护栏 (2026-09-25 作者定案后改版, 老版见 git history):
//   1. **退避**: 第 N 次续跑前等 taskContinueDelayMs(N) —— 1m·2m·5m·10m·30m。
//      老版固定 2 秒 × 8 连发是纯空转: 能被列进清单又还 pending 的, 必然是有东西要解决,
//      催两秒变不出来。实测 2026-09-25 16:44 连吐 8 句同样的话, 8-26 同样的八连有 24 组。
//   2. **blocked 跳过**: 人格推不动(卡在人身上)就把任务标 blocked, 续跑不再催它。
//      这是老版那道"AI 抛问句就不续"的正则门的替代品 —— 判据从猜正文改成读状态字段。
//      🔴 正则门已撤: 作者 9-11 在压缩闸上定过同一个案(core/compact-gate.js:7)
//      「一段正则不配决定清不清空会话」; 续跑这条链路是当时的漏网。实证: 人格答「等你重启。」
//      —— 人类语言里最明确的"我在等你" —— 词表里没有"等你", 照样判成没在等人。
//   3. 连续自动续跑有上限 TASK_CONTINUE_MAX, 到顶停下等人。
//   4. 用户一发消息就清零(markActivity 里), 所以上限只约束"无人值守的连跑"。

// 还欠几件事 = 非 completed 且非 blocked。blocked 的活着躺在清单上(用户看得见), 只是不催。
function pendingTasksOf(s) {
  const tasks = (s.butler && s.butler._tasks) || [];
  return tasks.filter((t) => t.status !== 'completed' && t.status !== 'blocked');
}

function maybeContinueTasks(s, { interrupted, sid } = {}) {
  if (s && s.taskContinueTimer) { clearTimeout(s.taskContinueTimer); s.taskContinueTimer = null; }
  if (interrupted) return;
  if (!settings.read().autoContinueTasks) return;          // 默认开, 设置里可关
  const left = pendingTasksOf(s);
  if (!left.length) { s.taskContinueRuns = 0; return; }
  if ((s.taskContinueRuns || 0) >= TASK_CONTINUE_MAX) {
    console.log(`[task-continue] ${s.butler.name} 已连续自动续跑 ${TASK_CONTINUE_MAX} 次, 停下等人`);
    return;
  }
  const run = (s.taskContinueRuns || 0) + 1;
  s.taskContinueRuns = run;
  const delay = taskContinueDelayMs(run);
  console.log(`[task-continue] ${s.butler.name} 还剩 ${left.length} 件没做完, 第 ${run} 次续跑将在 ${Math.round(delay / 60000)} 分钟后发起`);
  // 🔴 提示与事件都挪进定时器: 退避到分钟级之后, "现在就宣布要续跑"会在界面上挂一条
  //    一分钟后才兑现的假状态, 而中途用户说一句话这次续跑就取消了。
  s.taskContinueTimer = setTimeout(() => {
    s.taskContinueTimer = null;
    // 等待期间情况可能全变了 —— 重新取一次清单, 而不是用一分钟前那份。
    const nowLeft = pendingTasksOf(s);
    if (!nowLeft.length) { s.taskContinueRuns = 0; return; }
    if (!settings.read().autoContinueTasks) return;
    if (s.butler && s.butler._busy) return;                // 已经在跑了(用户刚说话), 这次作废
    const body = cfg.render('main/task_continue', {
      left: nowLeft.map((t) => `- ${t.status === 'in_progress' ? '▶' : '○'} ${t.subject}`).join('\n'),
    });
    appendButlerEvent(s.butler.name, 'task_continue', { left: nowLeft.length, run, delay_ms: delay });
    // 文案走 i18n(渲染层三语), 这里只递一个占位符已填好的字符串 —— 主进程不认识用户选了哪种语言。
    sendUI('activity', { sid, text: i18n.uiStrings(currentLocale()).tasks_auto_continue.replace('{n}', nowLeft.length) });
    s.butler.submit(body, undefined, { sourceKind: 'auto' }).catch((e) => console.error('[task-continue] 续跑失败:', e && e.message));
  }, delay);
}


// 统一的"起插件"入口 (openPersona 首次 / update-persona 热切换都调它): 从 registry 拿最新配置起 TG/bothub。
// 幂等 — 已在跑的先 stop 再 new + start, 不会重启失败。
async function installPlugins(s) {
  // 停旧 (若有)
  if (s.tgPlugin)     { try { await s.tgPlugin.stop();     } catch (_) {}  s.tgPlugin = null; }
  if (s.bothubPlugin) { try { await s.bothubPlugin.stop(); } catch (_) {}  s.bothubPlugin = null; }
  if (s.linePlugin)   { try { await s.linePlugin.stop();   } catch (_) {}  s.linePlugin = null; }
  if (s._bothubRetryTimer) { clearTimeout(s._bothubRetryTimer); s._bothubRetryTimer = null; s._bothubPending = null; }   // 热切换清挂起重试, 免旧闭包迟发戳
  // 起新
  const entry = registry.getByDir(s.butler.homeDir);
  const plugins = (entry && entry.plugins) || {};
  // 盘上还是老三段的话在这里折成一张表(跑一次就写回, 老字段删掉)。
  const buses = (entry ? registry.ensureBuses(entry.id) : plugins.buses) || [];
  // v3 微批 (2026-07-13): tg-native 一条一条回调, 若启动时堆积 N 条会触发 N 次 submit,
  // 每条独立进模型 = N 倍 tokens. 加 200ms debounce buffer: buf.length>3 打包成一条 submit; ≤3 逐条.
  // 打包路径: 单条 submit 里列出 N 条摘要 + 附件合并, 模型一次上下文里全看到, 自行判断处理.
  const submitTgOne = (record) => {
    const preview = (record.text || '').slice(0, 200);
    const hasImg = Array.isArray(record.attachments) && record.attachments.length;
    const fileNote = record.file_path
      ? `\n📎 attachment saved: ${record.file_path}${hasImg ? ' (image attached to this message, viewable directly)' : ' (use Read tool to open)'}`
      : '';
    s.butler.submit(
      cfg.render('inbox/tg_single', {
        fromName: record.from_name || 'anon',
        fromId: record.from_id,
        chatId: record.chat_id,
        updateId: record.update_id,
        preview,
        fileNote,
        replyToHint: record.reply_to ? ` (you may reply_to=${record.reply_to} to quote the original)` : '',
      }),
      record.attachments || [],
      { sourceKind: 'inbox', rawText: String(record.text || '') }
    ).catch((e) => console.error('[tg-onmessage]', e && e.message));
  };
  const submitTgBatch = (records) => {
    const attachAll = [];
    const lines = records.map((r, i) => {
      const preview = (r.text || '').slice(0, 150);
      if (Array.isArray(r.attachments)) attachAll.push(...r.attachments);
      const fileNote = r.file_path ? ` 📎${r.file_path}` : '';
      return `${i + 1}. from @${r.from_name || 'anon'}(${r.from_id}) chat ${r.chat_id} update_id=${r.update_id}: ${preview}${fileNote}`;
    });
    s.butler.submit(
      [
        `(auto · TG batch ${records.length} messages · startup/backlog accumulation)`,
        '',
        ...lines,
        '',
        `To reply, call the send_tg tool (see chat_id in each item).`
      ].join('\n'),
      attachAll,
      { sourceKind: 'inbox', rawText: records.map((r) => String(r.text || '')).join('\n') }
    ).catch((e) => console.error('[tg-onmessage-batch]', e && e.message));
  };
  s._tgBuf = [];
  let tgFlushTimer = null;
  const flushTgBuf = () => {
    tgFlushTimer = null;
    const batch = s._tgBuf; s._tgBuf = [];
    if (!batch.length) return;
    if (batch.length > 3) {
      pluginLog(`[tg:${s.butler.name}] 打包 ${batch.length} 条堆积 → 单条 submit`);
      submitTgBatch(batch);
    } else {
      batch.forEach(submitTgOne);
    }
  };
  const tgOnMessage = (record) => {
    // 软插话路径: submit 是 push 到 queue 【不打断】; busy 也是安全的.
    // 【历史坑 · 2026-07-11 排查】曾经这里有 `if (isRunning()) return` 保守 gatekeeping 导致丢件, 别加回来.
    const busyNote = s.butler.isRunning() ? '(忙, 排队软插话)' : '';
    if (busyNote) pluginLog(`[tg:${s.butler.name}] ${busyNote} update_id=${record.update_id}`);
    const preview = (record.text || '').slice(0, 40);
    s.convo.push({ role: 'system', text: `🔔 TG 消息 from @${record.from_name || record.from_id} (chat ${record.chat_id}): ${(preview || (record.file_path ? '[附件]' : ''))}`, ts: Date.now() });
    s.persist();
    s._tgBuf.push(record);
    if (tgFlushTimer) clearTimeout(tgFlushTimer);
    tgFlushTimer = setTimeout(flushTgBuf, 200);
  };
  s.tgPlugin = new TgPlugin(plugins.tg, s.butler.name, pluginLog, s.butler.memoryDir, tgOnMessage);
  // v2: 把 bot_token 注入 butler, 供 MCP send_tg 工具用 (每次 installPlugins 都刷, 支持热切换 token)
  s.butler.setTgConfig(plugins.tg || {}); require('./channels/wire').wireChannels(s, entry, { cfg, log: pluginLog }).catch((e) => console.error('[channels]', e && e.message));   // 统一通道(飞书/钉钉/群机器人…, personal/channels/)
  const rTg = s.tgPlugin.start(s.butler.homeDir);
  if (!rTg.ok) pluginLog(`[tg:${s.butler.name}] 启动失败: ${rTg.error}`);
  else if (rTg.mode === 'native') pluginLog(`[tg:${s.butler.name}] ✅ native long polling 启动`);
  // bothub 那几条合成一个通道(多 endpoint 一个循环各跑各的)。inbox=false 的不取件, 只留着发。
  const bothubEndpoints = buses
    .filter((b) => b.kind === 'bothub' && b.inbox === 'bothub' && b.base_url && b.agent)
    .map((b) => ({ id: b.id, url: b.base_url, agent: b.agent, token: b.token, poll_interval: b.poll_interval }));
  const bothubCfg = { mode: bothubEndpoints.length ? 'native' : 'off',
                      endpoints: bothubEndpoints, _offsetDir: s.butler.memoryDir };
  // v4 (2026-07-16): 修 busy-drop 丢件坑 — bothub-native 在回调前就推进并落盘 offset,
  // 这里 `isRunning() return` 会把戳永久丢掉(没有重发机制), 消息要等下一条新消息才被捎带发现.
  // 改为: 忙时合并挂起(多个 evt 的 count 累加 = 天然批量), 每 500ms 重试, 退忙后一次戳醒全处理.
  s._bothubPending = null;
  s._bothubRetryTimer = null;

  // ── bus 上运来的包在这里下车 ──
  // 包和聊天消息走的是同一条 bus, 分岔就在这里: 包一律不往 AI 走。
  // 位置在 busy 判断**之前** —— 装包是确定性动作, 没有理由等 AI 空闲; 而且真等下去,
  // 恰恰是"AI 正忙着"的时候包会被压在队列里, 那正是最想让它已经装好的时刻。
  s._pkgNotices = [];
  s._pkgNoticeTimer = null;

  // 告诉 AI 装了什么。**每个包只此一次**(包很少来), 跟"翻一屏叫一次"是两回事。
  // 🔴 按钮规格必须原样写在这条消息里: 教 AI 用 {{cmd:}} 的那段提示语是在会话建立
  //    那一刻定死的, 这一轮热装上的手顺, AI 手上那份提示语里根本没有 —— 让它自己拼,
  //    它只能照着不存在的记忆猜。
  const flushPkgNotices = () => {
    if (!s._pkgNotices.length) return;
    if (s.butler.isRunning()) {
      if (!s._pkgNoticeTimer) {
        s._pkgNoticeTimer = setTimeout(() => { s._pkgNoticeTimer = null; flushPkgNotices(); }, 500);
      }
      return;
    }
    const rows = s._pkgNotices.splice(0);
    const lines = rows.map((w) => `- "${w.title}" id \`${w.id}\` · ${w.total} screen(s)`);
    // 🔴 这里**不再**塞入口按钮的写法让 AI 照抄。下发→验签→落目录→热生效 整条链都是系统的活,
    // 到这一步只是"通知一下"。要摆到用户面前, plugin_open 会自己把界面画进对话(见 renderPlugin) ——
    // 上面 loadWorkflowPackages() 已经跑过, 所以这些包此刻在插件目录里当场就查得到。
    // 老文案让 AI 照抄一行 wf_go 按钮写法, 理由是"提示语冻住了它自己拼不出来" —— 那个理由已经不成立。
    // (别在本段注释里写出那行按钮的字面写法: 门禁是按源码文本扫的, 注释里出现同样会判红。)
    const body = [
      '(auto · new workflow packages installed) Just received from bus, signature verified, ready to use:',
      '',
      ...lines,
      '',
      'Tell the user what was installed. To show it, call plugin_open(id) — the UI is rendered by the system, no need to compose it yourself.',
    ].join('\n');
    s.butler.submit(body, undefined, { sourceKind: 'auto' })
      .catch((e) => console.error('[pkg-notice]', e && e.message));
  };

  const takePackagesOff = (evt) => {
    const msgs = evt.msgs || [];
    if (!msgs.some(packageInbox.isPackageMsg)) return evt;

    const { installed, failed, rest } = packageInbox.takeFromMessages(msgs, {
      install: (text) => packages.install(text, { dataDir: paths.dataDir() }),
    });
    for (const f of failed) {
      console.error('[pkg-inbox] 包没收下: #' + f.id, f.code, f.message);
      // 装不上是我们出货那头的事(签错/发错), 用户帮不上忙也不该被吓一跳 ——
      // 但完全不说, 就变成"发了包却什么都没发生"这种最难查的静默。留一行在界面上。
      s.convo.push({ role: 'system', text: `⚠ 收到一个装不上的包 (${f.code}): ${f.message}`, ts: Date.now() });
    }
    if (installed.length) {
      // 装完当场热生效。少了这一步, 用户得重开一次 app 才能用 —— 链子就断在最后一米。
      loadWorkflowPackages();
      const sum = workflow.summary(currentLocale());
      const fresh = installed.filter((x) => x.type === 'workflow');
      for (const x of fresh) {
        const w = sum.find((w2) => w2.id === x.pkgId);
        if (w) s._pkgNotices.push(w);
      }
      const names = installed.map((x) => `${x.pkgId}@${x.version}`).join(' ');
      console.log('[pkg-inbox] 已装并热生效:', names);
      s.convo.push({ role: 'system', text: `📦 装上了新的下发物: ${names}`, ts: Date.now() });
    }
    if (failed.length || installed.length) s.persist();
    if (s._pkgNotices.length) flushPkgNotices();

    if (!rest.length) { if (evt.ack) evt.ack(true); return null; }   // 整批都是包 → AI 一次都不叫, 收件箱里这批算交付完
    return { ...evt, msgs: rest, count: rest.length };
  };

  const pokeBothub = (evt0) => {
    const evt = takePackagesOff(evt0);
    if (!evt) return;
    if (s.butler.isRunning()) {
      // busy: 合并 count + msgs (保 msgs 顺序, 让 AI 一次看到全部积压); ack 也合并, 交付有结果时每批各回一次
      // 挂起只在内存, 但消息本体已在收件箱(bothub-inbox.js)里标着没交出去 —— 这期间关 app, 下次开门补交。
      const prev = s._bothubPending;
      const ackAll = (a, b) => (a && b) ? (ok) => { a(ok); b(ok); } : (a || b);
      s._bothubPending = prev
        ? { ...evt, count: prev.count + evt.count, msgs: (prev.msgs || []).concat(evt.msgs || []), ack: ackAll(prev.ack, evt.ack) }
        : { ...evt, msgs: (evt.msgs || []).slice() };
      if (!s._bothubRetryTimer) {
        s._bothubRetryTimer = setTimeout(() => {
          s._bothubRetryTimer = null;
          const p = s._bothubPending; s._bothubPending = null;
          if (p) pokeBothub(p);
        }, 500);
      }
      return;
    }
    const isP0 = evt.kind === 'immediate';
    const msgs = evt.msgs || [];
    s.convo.push({ role: 'system', text: `🔔 收到 bothub 新消息 (${evt.count} 条 from ${evt.agent}${isP0 ? ' · P0 直通' : ''})`, ts: Date.now() });
    s.persist();
    // bus 消息**直接推**给人格 (2026-07-22 作者铁律 [[feedback_butler_pulls_bus_pushes_ai_not_ai_pulls]]): msgs 拼进 submit 一看即答, sweep 兜底(msgs=[])才只给"去看看"。
    // 🔴 截断必须留痕: 原先 `slice(0,400)` 不留任何标记 = **双向静默失败** —— 收件方拿着半句话当全文往下答, 发件方也不知道自己被腰斩, 丢了什么两边都不知道。
    // 2026-09-12 外部两台机器的人格各自独立报了这个问题, 当天 4 条 700~1100 字的回信全被切在 400(服务端存的是完整的, 截断只发生在这一行)。上限 4000 留足余量又不撑爆上下文; 换行也不再压平, 压成一行会把对方分好的段落全毁掉。
    const lines = msgs.map((m, i) => {
      const from = m.from_agent || '?';
      const kind = (m.payload && m.payload.kind) || m.kind || '';
      const raw = String(m.text || ''), over = raw.length > 4000, text = (over ? raw.slice(0, 4000) : raw).replace(/\n/g, '\n     ') + (over ? `\n     ⚠️ [此处被截断 · 原文 ${raw.length} 字 · bus 没有按 id 拉原文的口, 请对方分条重发]` : '');
      return `${i + 1}. #${m.id} from ${from}${kind ? ` [${kind}]` : ''}${m.payload && m.payload.asset_id ? ` 📎asset_id=${m.payload.asset_id}(bus_admin op='get_file' 取)` : ''}: ${text}`;
    });
    // 信封在 config/inbox/ 里, 不内联 —— 内联那版漏掉了 2026-08-26 那次全体信封瘦身。
    // endpoint 下标和 agent 名都不再进正文: 前者纯内部, 后者是**我方**在 bus 上的名字, 发件人每行都有。
    const p0 = isP0 ? ' · P0 direct' : '';
    const body = msgs.length
      ? cfg.render('inbox/bus_batch', { p0, count: evt.count, lines: lines.join('\n') })
      : cfg.render('inbox/bus_sweep', { p0, count: evt.count });
    // P0 SLA: kind='immediate' (bothub [P0-* 前缀) 走 _bypassRateGate 直通 rate-gate, 不排队 (狂人 2026-07-20 派单钦定 <5s 端到端)
    // rawText 只给对方真说的那几句(不含 header/footer 的处理指示) —— 详见 stream.js 的 opts.rawText
    // submit 真进了队列才回 true; 被挡下(挂起 / 中断)回空, 抛错同理 —— 这两种都让收件箱放回去重交。
    const ack = evt.ack || (() => {});
    s.butler.submit(body, undefined, { sourceKind: 'inbox', _bypassRateGate: isP0,
      rawText: msgs.map((m) => String(m.text || '')).join('\n') })
      .then((queued) => ack(queued === true))
      .catch((e) => { console.error('[poke-bothub]', e && e.message); ack(false); });
  };
  s.bothubPlugin = new BothubPlugin(bothubCfg, s.butler.name, pluginLog, pokeBothub);
  const rBh = s.bothubPlugin.start(s.butler.homeDir);
  if (rBh.mode === 'native') pluginLog(`[bothub:${s.butler.name}] ✅ native 起 ${rBh.count} 个 endpoint`);
  // —— bus 目标表 ——
  // 一张有序表就是全部, **第一个是默认**; AI 要往哪条发就在 bus_exec / send_bothub 里点名,
  // 不点名就是第一条。每次 installPlugins 都重灌 → 支持热切换。
  s.butler.setBuses(buses.filter((b) => b.base_url));

  // —— LINE 收件 (表里 inbox=line 的那条) ——
  // 拓扑: LINE webhook 落 VPS bus, 这里出站长轮询取件。**回发不在这里** ——
  // 发 LINE 是 bus 上的一个 command, 走能力包声明的工具或 bus_exec。
  const lineBus = buses.find((b) => b.inbox === 'line' && b.base_url && b.token);
  if (lineBus) {
    const submitLineOne = (rec) => {
      const who = rec.is_owner ? 'owner' : `customer ${rec.line_user_id}`;
      const fallbackNote = rec.fallback_sent ? cfg.text('inbox/line_fallback_note') : '';
      const roles = cfg.json('inbox/roles');
      const roleHint = rec.is_owner ? roles.line_owner : roles.line_customer;
      const tSubmit = Date.now();
      pluginLog(`[LATENCY] butler_submit_call eid=${rec.event_id} seq=${rec.seq}`);
      s.butler.submit(
        cfg.render('inbox/line_single', {
          who, seq: rec.seq, type: rec.type,
          body: rec.text || JSON.stringify(rec.payload || {}).slice(0, 200),
          fallbackNote, lineUserId: rec.line_user_id, roleHint,
        }),
        undefined,
        { sourceKind: 'inbox', _traceId: rec.event_id, rawText: rec.text || '' }
      ).then(
        () => pluginLog(`[LATENCY] butler_submit_resolved eid=${rec.event_id} dt_submit=${Date.now() - tSubmit}ms`),
        (e) => { pluginLog(`[LATENCY] butler_submit_rejected eid=${rec.event_id} dt=${Date.now() - tSubmit}ms err=${e && e.message}`); console.error('[line-onmessage]', e && e.message); }
      );
    };
    s._lineBuf = [];
    let lineFlushTimer = null;
    let lineBufFirstAt = 0;
    const flushLineBuf = () => {
      lineFlushTimer = null;
      const batch = s._lineBuf; s._lineBuf = [];
      if (!batch.length) { lineBufFirstAt = 0; return; }
      const eids = batch.map(r => r.event_id);
      pluginLog(`[LATENCY] flush_debounced n=${batch.length} eids=${JSON.stringify(eids)} debounce_wait=${lineBufFirstAt ? Date.now() - lineBufFirstAt : 0}ms`);
      lineBufFirstAt = 0;
      if (batch.length > 3) {
        // 启动积压打包: 一条 submit 列全摘要, 模型自行合并处理 (同 TG 微批思路)
        const lines = batch.map((r, i) => `${i + 1}. seq=${r.seq} from ${r.is_owner ? 'owner' : r.line_user_id}${r.fallback_sent ? '(fallback sent)' : ''}: ${(r.text || '[' + r.type + ']').slice(0, 150)}`);
        s.butler.submit(
          cfg.render('inbox/line_batch', { count: batch.length, lines: lines.join('\n') }),
          undefined, { sourceKind: 'inbox', rawText: batch.map((r) => String(r.text || '')).join('\n') }
        ).catch((e) => console.error('[line-onmessage-batch]', e && e.message));
      } else {
        batch.forEach(submitLineOne);
      }
    };
    const lineOnMessage = (rec) => {
      pluginLog(`[LATENCY] lineOnMessage_enter eid=${rec.event_id} seq=${rec.seq}`);
      const preview = (rec.text || `[${rec.type}]`).slice(0, 40);
      s.convo.push({ role: 'system', text: `🔔 LINE ${rec.is_owner ? '店主' : '客人'}: ${preview}`, ts: Date.now() });
      s.persist();
      if (!lineBufFirstAt) lineBufFirstAt = Date.now();
      s._lineBuf.push(rec);
      if (lineFlushTimer) clearTimeout(lineFlushTimer);
      lineFlushTimer = setTimeout(flushLineBuf, 200);
    };
    const lineCfg = { bus_base_url: lineBus.base_url, store_token: lineBus.token, wait: lineBus.wait,
                      in_file: lineBus.in_file || path.join(s.butler.memoryDir, 'line_messages.jsonl') };
    s.linePlugin = new LineRelayChannel(lineCfg, s.butler.name, pluginLog, lineOnMessage);
    const rLine = s.linePlugin.start();
    if (!rLine.ok) pluginLog(`[line:${s.butler.name}] 启动失败: ${rLine.error}`);
    else pluginLog(`[line:${s.butler.name}] ✅ bus 中继长轮询启动 · ${lineCfg.bus_base_url}`);
  }

  // —— 中央大脑收件 (表里 inbox=agent_bus 的那条) ——
  // 拓扑: 业务平台通过 bus 投递任务型意图 (translate.request 等), 这里长轮询取件 → 分派 handler,
  // handler 干完把结果投回去。AI 自己主动投 command 走 bus_exec, 不经这条。
  const abBus = buses.find((b) => b.inbox === 'agent_bus' && b.base_url && b.token && b.agent);
  if (abBus) {
    const abCfg = { bus_base_url: abBus.base_url, store_token: abBus.token, agent: abBus.agent,
                    wait: abBus.wait,
                    in_file: abBus.in_file || path.join(s.butler.memoryDir, 'agent_bus.jsonl') };
    const abHandlers = {
      'translate.request': require('./handlers/translate').translate,
    };
    s.agentBusPlugin = new AgentBusChannel(abCfg, s.butler.name, pluginLog, abHandlers);
    const rAb = s.agentBusPlugin.start();
    if (!rAb.ok) pluginLog(`[agent-bus:${s.butler.name}] 启动失败: ${rAb.error}`);
    else pluginLog(`[agent-bus:${s.butler.name}] ✅ 中央大脑长轮询启动 · ${abCfg.bus_base_url} · agent=${abCfg.agent}`);
  }

  // —— 行业包 (entry.industryPackFile · 一个 json 文件, 协议见 pack-loader.js) ——
  // 包に bus 連接は要らない —— 中身は人格説明 / 記憶 / chip / 首启帮助だけで、道具という概念が無い。
  if (entry && entry.industryPackFile) {
    try {
      const { loadPack } = require('../core/pack-loader');
      // core 自己的版本, 不是个人版外壳的 —— loadPack 拿它校验 pack 的 core_compat。
      const pack = loadPack(entry.industryPackFile, require('../core/package.json').version);
      s.butler.setOverlayPack(pack);
      pluginLog(`[pack:${s.butler.name}] ✅ 行业包「${pack.id}」v${pack.version} 装载 (chip ${pack.chips.length} 个 · 下次会话生效)`);
    } catch (e) {
      pluginLog(`[pack:${s.butler.name}] ⚠ 行业包拒载: ${e.message}`);
      s.butler.setOverlayPack(null);
    }
  } else {
    s.butler.setOverlayPack(null);
  }
}

// 管家用: 按引用(人格名/id/目录)打开人格 → 新标签。给渲染层推 persona-opened 事件加标签。
function openPersonaByRef(ref) {
  const e = registry.resolveRef(ref);
  if (!e) return { ok: false, error: '未找到人格: ' + ref };
  const s = openPersona(e.homeDir);
  const meta = metaOf(s);
  sendUI('persona-opened', { meta, activate: true });   // 有人明确要开这个人格 → 建标签并切过去
  return { ok: true, id: e.id, name: e.name, homeDir: e.homeDir, sid: s.sid };
}

// 多人格互通(星型 · 单向异步): 给另一个人格投递一条消息(submit, 不等答复) → 立即返回。
// 对方忙完后自己用 ask_persona 主动回发起方 —— 又是一次单向投递。不阻塞、不卡超时、无双向互等死锁。
async function askPersona(targetRef, question, opts = {}) {
  const target = registry.resolveRef(targetRef);
  if (!target) return { ok: false, error: '未找到人格 ' + targetRef };
  const backRef = opts.fromName || 'butler';
  // v0.0.25 mesh 化: 星型约束移除, 所有人格 ↔ 所有人格 直接互通 (2026-07-21 作者钦定)
  let s = sessions.get(sidOf(target.homeDir));
  if (!s) { s = openPersona(target.homeDir); sendUI('persona-opened', { meta: metaOf(s) }); }
  const replyHint = target.isButler ? `ask_persona back to "${backRef}"` : 'ask_persona back to butler';
  // #5 精简: 3 行硬信息(头/msg/回法). 说教全去 — 出生教育+工具 description 已覆盖, 模型能从 replyHint 推断回路径
  const wrapped = `[from "${backRef}" · one-way async]\n${question}\n→ To reply, call ${replyHint}`;
  markActivity(s);   // 目标收到 peer 消息 = activity, 也顺便清心跳短路 (spec §1.3)
  try {
    await s.butler.submit(wrapped, undefined, { sourceKind: 'inbox', rawText: question });   // 人格间投递走 auto 桶 (rate gate)
    ccButler({
      channel: 'ask_persona',
      from: backRef,
      to: target.name,
      message: question,
      wrapperMeta: { tag: '· 单向异步', reply_hint: replyHint },
    });
    return { ok: true, delivered: true, from: target.name, note: `已投递给「${target.name}」· 单向异步` };
  } catch (e) { return { ok: false, error: String(e && e.message) }; }
}

// 叶子↔叶子直连(需用户授权 · 单向异步): 投递消息给对方(submit, 不等答复)+ 抄送管家 → 立即返回。
// 对方忙完后自己用 talk_peer 主动回发起方。不阻塞、不卡超时、无双向互等死锁(反向 talk_peer 正是期望的"回复")。
async function peerTalk(fromName, targetRef, message, opts = {}) {
  const from = registry.resolveRef(fromName) || (opts.fromDir ? registry.getByDir(opts.fromDir) : null);
  const target = registry.resolveRef(targetRef);
  if (!from) return { ok: false, error: '未知发起者' };
  if (!target) return { ok: false, error: '未找到人格 ' + targetRef };
  if (from.id === target.id) return { ok: false, error: '不能和自己对话' };
  // v0.0.25 mesh 化: 授权检查移除 + 管家可作 talk_peer 目标, 所有人格 ↔ 所有人格 直接互通 (2026-07-21 作者钦定)
  let s = sessions.get(sidOf(target.homeDir));
  if (!s) { s = openPersona(target.homeDir); sendUI('persona-opened', { meta: metaOf(s) }); }
  // #5 精简: 3 行硬信息. 抄送/UI 可见等运行时事实模型不需要每次重申(信任出生教育一次性告知)
  const wrapped = `[${from.name} · talk_peer one-way async]\n${message}\n→ To reply, call talk_peer back to "${from.name}"`;
  markActivity(s);   // 目标收到 peer 消息 = activity, 也顺便清心跳短路 (spec §1.3)
  try {
    await s.butler.submit(wrapped, undefined, { sourceKind: 'inbox', rawText: message });   // 人格间投递走 auto 桶 (rate gate)
    ccButler({
      channel: 'talk_peer',
      from: from.name,
      to: target.name,
      message,
      wrapperMeta: { tag: '· 单向异步', reply_hint: `talk_peer 回「${from.name}」` },
    });
    return { ok: true, delivered: true, from: target.name, note: `已投递给「${target.name}」· 单向异步` };
  } catch (e) { console.error(`[peerTalk] 投递给「${target.name}」失败:`, e && e.message); return { ok: false, error: String(e && e.message) }; }
}

// —— Local Poke API: 本机程序 HTTP 戳醒人格 (v1, 2026-08-03 · docs/design/local_api_v1.md) ——
// 投递路径与 peerTalk 完全同构: resolveRef → 没开就 openPersona(自带 cold-wake) → markActivity → submit(inbox 档) → 抄送/落盘。
// 唯一结构差异: 进程级单例(一个端口服务所有人格, 人格走参数), 所以不进 installPlugins。
let localApiServer = null;
const POKE_DEBOUNCE_MS = 200;
const _pokeBuf = new Map();   // sid -> { s, batch:[{from,text}], timer }

function appendApiInbox(s, rec) {
  try {
    fs.appendFileSync(path.join(s.butler.memoryDir, 'api_inbox.jsonl'), JSON.stringify({ ts: localIsoTimestamp(), ...rec }) + '\n');
  } catch (e) { pluginLog('[local-api] api_inbox 落盘失败: ' + (e && e.message)); }
}

function flushPokeBuf(sid) {
  const buf = _pokeBuf.get(sid);
  if (!buf) return;
  _pokeBuf.delete(sid);
  const { s, batch } = buf;
  if (!batch.length) return;
  const fail = (e) => pluginLog('[local-api] 投递失败: ' + (e && e.message));
  // 🔴 rawText 传【没套信封的原文】: 自动召回拿它去查, 不拿整条提交正文。信封里的来源标签和
  // 投递说明不是对方问的话, 却照样参与打分 —— 查询词一多就摊薄覆盖率, 把真相关的压到注入线以下。
  // dev 实测同一句: 裸文 top=0.367, 套上 api_single 信封后 0 条命中。
  if (batch.length > 3) {
    // 积压打包: 一条 submit 列全摘要, 模型自行合并处理 (同 LINE/TG 微批思路)
    const lines = batch.map((r, i) => `${i + 1}. from ${r.from}: ${r.text.slice(0, 150)}`);
    s.butler.submit(cfg.render('inbox/api_batch', { count: batch.length, lines: lines.join('\n') }),
      undefined, { sourceKind: 'inbox', rawText: batch.map((r) => String(r.text || '')).join('\n') }).catch(fail);
  } else {
    batch.forEach((r) => {
      s.butler.submit(cfg.render('inbox/api_single', { from: r.from, body: r.text }),
        undefined, { sourceKind: 'inbox', rawText: String(r.text || '') }).catch(fail);
    });
  }
}

// 单向投递: 立即返回, 不等人格干活。ref = 人格名/id/目录。
async function pokePersona({ persona: ref, text, from }) {
  const target = registry.resolveRef(ref);
  if (!target) return { ok: false, code: 404, error: '未找到人格 ' + ref };
  const sid = sidOf(target.homeDir);
  let s = sessions.get(sid);
  const wasOpened = !s;
  if (!s) { s = openPersona(target.homeDir); sendUI('persona-opened', { meta: metaOf(s) }); }
  markActivity(s);   // 外部来信 = activity, 顺便清心跳短路 (同 peer 消息)
  s.convo.push({ role: 'system', text: `🔔 API 来信 (from ${from}): ${text.slice(0, 40)}`, ts: Date.now() });
  s.persist();
  appendApiInbox(s, { from, to: target.name, text, was_opened: wasOpened });
  appendButlerEvent(target.name, 'local_api_poke', { from, msg_len: text.length, was_opened: wasOpened });
  ccButler({ channel: 'local_api', from, to: target.name, message: text, wrapperMeta: { tag: '· 外部程序 · 单向' } });
  // 微批 debounce: 200ms 窗口聚合同人格多条, >3 条打包成一条 (外部脚本写循环也刷不死人格)
  let buf = _pokeBuf.get(sid);
  if (!buf) { buf = { s, batch: [], timer: null }; _pokeBuf.set(sid, buf); }
  buf.s = s;
  buf.batch.push({ from, text });
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => flushPokeBuf(sid), POKE_DEBOUNCE_MS);
  return { ok: true, persona: target.name, delivered: true, was_opened: wasOpened };
}

// 起/停/重启(配置改动后调它)。未启用 = 不开端口。
function restartLocalApi() {
  if (localApiServer) { localApiServer.stop(); localApiServer = null; }
  const c = registry.getLocalApi();
  if (!c.enabled) { pluginLog('[local-api] 未启用 (人格管理窗口里开)'); return { ok: true, running: false }; }
  const srv = new LocalApiServer(c, pluginLog, pokePersona);
  const r = srv.start();
  if (!r.ok) { pluginLog(`[local-api] 启动失败: ${r.error}`); return { ok: false, error: r.error }; }
  localApiServer = srv;
  pluginLog(`[local-api] ✅ 本机戳醒 API 就绪 · http://127.0.0.1:${r.port}/v1/poke`);
  return { ok: true, running: true, port: r.port };
}

// —— butler-events.jsonl 落盘 helpers (v0.0.25, 2026-07-21) ——
// 系统事件独立日志: 保活发/跳/失败, 压缩触发/跳/失败, 清空完成. 完全代码层, 不进 AI 上下文.
// 位置: paths.dataDir()/logs/butler_events/butler-events_YYYY-MM-DD.jsonl (rotate 同 peer_talk).
// 用途: grep 追踪成本水位; 未来接 dashboard/告警; idle-watch 决策审计.
const BUTLER_EVENTS_ROTATE_SIZE = 10 * 1024 * 1024;   // 10 MB
function butlerEventsDir() { return path.join(paths.dataDir(), 'logs', 'butler_events'); }
function currentButlerEventsPath() {
  const dir = butlerEventsDir();
  fs.mkdirSync(dir, { recursive: true });
  const today = localDateStr();
  let idx = 0;
  let p = path.join(dir, `butler-events_${today}.jsonl`);
  while (fs.existsSync(p) && fs.statSync(p).size >= BUTLER_EVENTS_ROTATE_SIZE) {
    idx++;
    p = path.join(dir, `butler-events_${today}.${String(idx).padStart(3, '0')}.jsonl`);
  }
  return p;
}
function appendButlerEvent(persona, event, meta = {}) {
  try {
    const entry = { ts: localIsoTimestamp(), persona: persona || null, event, ...meta };
    fs.appendFileSync(currentButlerEventsPath(), JSON.stringify(entry) + '\n');
  } catch (e) { pluginLog('[butler-events] 落盘失败: ' + (e && e.message)); }
}

// —— peer_talk 抄送日志 helpers (spec: workspace/idle_watcher_and_bcc_log_spec_v1.md §2, 2026-07-13) ——
// 时间戳统一系统本地时区 (禁用 UTC, 见 spec 编码约定).
function localIsoTimestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const tzMin = -d.getTimezoneOffset();
  const sign = tzMin >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(tzMin) / 60));
  const om = pad(Math.abs(tzMin) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
         `.${pad(d.getMilliseconds(), 3)}${sign}${oh}:${om}`;
}
function localDateStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const PEER_LOG_ROTATE_SIZE = 10 * 1024 * 1024;   // 10 MB
function peerLogDir() { return path.join(paths.dataDir(), 'logs', 'peer_talk'); }
function currentPeerLogPath() {
  const dir = peerLogDir();
  fs.mkdirSync(dir, { recursive: true });
  const today = localDateStr();
  let idx = 0;
  let p = path.join(dir, `peer_talk_${today}.jsonl`);
  while (fs.existsSync(p) && fs.statSync(p).size >= PEER_LOG_ROTATE_SIZE) {
    idx++;
    p = path.join(dir, `peer_talk_${today}.${String(idx).padStart(3, '0')}.jsonl`);
  }
  return p;
}

// 抄送管家日志 (v1 jsonl, 2026-07-13 起; 旧 peer_cc_log.md 保留存档不删, 新代码只写这里).
// 双向都记: talk_peer 双方 + ask_persona 双方 (main 视角 direction='relay' 一次一条).
// 独立日志文件, 不进任何人格会话历史(零污染 · 见 spec §2).
function ccButler({ channel, from, to, message, wrapperMeta }) {
  try {
    const body = String(message == null ? '' : message);
    const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
    const summary = body.length > 200 ? body.slice(0, 200) + '...' : body;
    const entry = {
      ts: localIsoTimestamp(),
      channel,
      from,
      to,
      direction: 'relay',
      msg_len: body.length,
      msg_summary: summary,
      msg_hash: hash,
      wrapper_meta: wrapperMeta || null,
    };
    fs.appendFileSync(currentPeerLogPath(), JSON.stringify(entry) + '\n');
    sendUI('peer-cc', { channel, from, to, ts: entry.ts });
  } catch (e) { pluginLog('[peer-cc] 抄送日志失败: ' + (e && e.message)); }
}

// 管家授权/撤销叶子直连(用户跟管家说→管家调这两个, 不走界面)。
function grantPeer(a, b) { const r = registry.grantPeer(a, b); if (r.ok) broadcastRegistry(); return r; }
function revokePeer(a, b) { const r = registry.revokePeer(a, b); if (r.ok) broadcastRegistry(); return r; }

// 管家用: 新建人格 → 出生礼物 5 件套(目录+登记簿+MEMORY.md+persona.md+图起步节点) → 打开。
// P6a (2026-07-07 作者钦定): 新人格出生就有身份+记忆体系, 不再自称"全能管家"。
//
// —— 出生教育 v2 (2026-08-13) ——
// 两段: ①知识包直接灌进记忆图(零模型调用) ②一轮上手体验 + 引擎按记忆图实际状态校验。
// 不依赖会话的那半边全在 birth.js(设计理由、为什么这么改也写在那儿); 这里只做编排:
// 发消息 / 等这一轮答完 / 出气泡 / 缺项补提一次。
async function runOnboarding(s, name, extra, opts = {}) {
  const know = birth.applyBirthKnowledge(s.butler.memory, { name, extra, isButler: !!opts.isButler });
  birth.writeBirthState(s.butler.memoryDir, { state: 'pending', retries: 0, learned: know.learned, isButler: !!opts.isButler, error: null });
  s._birthRunning = true;
  try { await runBirthExperience(s, name); } finally { s._birthRunning = false; }
}

// 段② 体验环节。出生时跑一次; 模型报错停下的, 之后由 resumeBirth 补跑(只补这段, 知识早已灌好)。
async function runBirthExperience(s, name) {
  const dir = s.butler.memoryDir;
  const st = birth.readBirthState(dir) || {};
  const fail = (error) => { birth.writeBirthState(dir, { error }); console.error(`[birth] ${name} 体验环节没跑完, 留待补跑: ${error}`); };
  // 先把流建起来(_q 懒建, 出生瞬间还是 null); 建好后守卫才能区分"未建"与"被关拆流"
  try { await s.butler.ensureStream(); } catch (e) { return fail('ensureStream: ' + (e && e.message)); }
  if (!s.butler || !s.butler._q) return;
  const snap = () => birth.birthSnapshot(s.butler.memory, dir);
  const before = snap();
  // 🔴 出生教育**只发这一段**。作者 2026-08-25:「我要一段, 你给我搞的更多了」。
  // 动手题 + 见主人都在这一段里, 先后顺序靠教材的文字钉死, **不靠拆成多条消息** ——
  // 拆消息只是多几次往返和等待, 并不会让模型更守序。
  const text = birth.buildExperienceText({ name, isButler: !!st.isButler, knowledgeCount: Number(st.learned) || 0, memoryDir: dir });
  sendUI('user-echo', { sid: s.sid, text });   // 出 user 气泡(像有人在跟它说话)
  try { await s.butler.askOnce(text, undefined, { sourceKind: 'auto' }); }
  catch (e) { return fail('askOnce: ' + (e && e.message)); }
  const done = (note) => { birth.writeBirthState(dir, { state: 'done', error: null }); console.log(`[birth] ${name} 出生完成${note}`); };
  // 用户按了停 = 他接手了, 不再拉回来上课
  if (s.butler && s.butler._lastTurnInterrupted) return done(' (用户中途停止)');
  // 模型报错(500 / key 错 / 额度 / 连不上)时它什么都没做, 补发只是对着坏模型再撞一次 → 停, 报错已经显示给用户
  if (s.butler && (s.butler._authBlocked || s.butler._lastTurnError)) return fail(s.butler._lastTurnError || 'access blocked');

  // 核对: 只有**真缺项**才补发一段, 不缺就一个字都不多说(绝大多数情况应该走这条)。
  // 只补一次 —— 再不做就随它去, 无限打转比缺一项糟得多(同空回合补提的做法)。
  if (!s.butler || !s.butler._q) return;
  const missing = birth.verifyBirthExperience(before, snap());
  if (!missing.length) return done(' (一段跑完, 三件全落地)');
  console.log(`[birth] ${name} 体验环节缺 ${missing.length} 项, 补提一次`);
  const retry = birth.buildRetryText({ name, missing });
  sendUI('user-echo', { sid: s.sid, text: retry });
  try { await s.butler.askOnce(retry, undefined, { sourceKind: 'auto' }); } catch (_) {}
  if (s.butler && !s.butler._lastTurnInterrupted && (s.butler._authBlocked || s.butler._lastTurnError)) return fail(s.butler._lastTurnError || 'access blocked');
  const still = birth.verifyBirthExperience(before, snap());
  done(still.length ? ` (补提后仍缺 ${still.length} 项, 不再追)` : ' (补提后全部落地)');
}

// 出生标记还是 pending(上次模型报错停下)→ 补跑体验环节。两处调: 打开人格时, 以及之后任一轮正常回完时。
function resumeBirth(s) {
  if (!s || !s.butler || s._birthRunning || !birth.birthNeedsRetry(s.butler.memoryDir)) return;
  const st = birth.readBirthState(s.butler.memoryDir) || {};
  birth.writeBirthState(s.butler.memoryDir, { retries: (Number(st.retries) || 0) + 1 });
  console.log(`[birth] ${s.butler.name} 出生教育没做完, 补跑体验环节 (第 ${(Number(st.retries) || 0) + 1}/${birth.MAX_BIRTH_RETRIES} 次)`);
  s._birthRunning = true;
  runBirthExperience(s, s.butler.name)
    .catch((e) => console.error('[birth] 补跑失败:', e && e.message))
    .finally(() => { s._birthRunning = false; });
}

// 出生礼物: 图记忆自我认知起步节点(pinned)。createPersona 与 首启默认管家 共用同一份模板。
function giftSelfIdentity(s, name, homeDir, memoryDir, wakePhrase, createdBy) {
  try {
    const now = localStamp();
    // 🔴 这里必须用 v2 的字段名。原先写的是 v1 的 `id`(语义串) + `description` + `importance:'pinned'`,
    // 而 butler.memory 早就是 MemoryGraphV2(core/agent.js:61) —— 三个字段 v2 全不认:
    // 语义 id 要走 slug(store-v2/graph.js:55 直接抛)、description 要叫 claim、pinned 与
    // importance 正交要走 setPinned。结果外面这层 catch 一吞, 只剩一行日志, 而**每个新人格的
    // 出生礼物都没落库** —— 2026-08-25 打包版首启实测: 库里 182 个节点, self_identity 不存在。
    s.butler.memory.upsert({
      slug: 'self_identity',
      type: 'user',
      importance: 'high',
      title: `我是 ${name}`,
      claim: `命题: 我是 ${name} —— 这条记的是我的身份基础事实与记忆系统用法, 是出生时写下的第一份档案。`,
      body: cfg.render('main/self_identity_body', {
        name, homeDir, memoryDir,
        wakePhrase: wakePhrase || '(默认)',
        now, createdBy: createdBy || 'butler',
        personaMdPath: path.join(memoryDir, 'persona.md'),
      }),
      links: ['project_butler_persistence_wake_engine', 'project_butler_no_menus_talk_to_it'],
    });
  } catch (e) { console.error('[birth] self_identity 沉淀失败:', e && e.message); }
}

// 每次启动补填: 引擎栏空着的人格直接按接入方式定 —— 用 key 的跑 Butler, 用订阅的跑 Claude Code(作者 11-05)。
// 不再按「上次版本」猜: 老包里 key 人格是借自带的 Claude SDK 跑的, 覆盖安装后那份 SDK 就没了, 猜成 cc 只会卡住。
function fillEmptyEngines() {
  for (const p of registry.list()) {
    if (p.sdk) continue;
    const sdk = p.accessMode === 'api' ? 'butler' : 'claude-code';
    registry.upsert({ ...p, sdk });
    console.log(`[sdk] ${p.name} 引擎栏空着, 按${p.accessMode === 'api' ? ' key' : '订阅'}定为 ${sdk}`);
  }
}

// 建人格的正文在 first-persona.js(碰到改哪里就把那块带走)。这里只把牵着会话与 UI 的几样递进去。
const createPersona = (spec = {}) => firstPersona.create(spec, {
  paths, registry, persona, locale: currentLocale(),
  open: openPersona, sendUI, metaOf, broadcast: broadcastRegistry,
  gift: giftSelfIdentity, onboard: runOnboarding,
});

// 会话元信息(供渲染层建标签; 历史消息按需再拉 get-history)
const metaOf = (s) => ({ sid: s.sid, persona: personaOf(s.butler), usage: s.butler.usage() });

// 语义检索模型(118MB)首启后台自己装, 装完给已开人格开闸并补齐存量向量。
// 不弹窗不打断: 装不上时检索退化成纯关键词, 与不装逐字节一致, 用户不需要为此做决定。
// 排在 createWindow 之后 —— 补向量的推理在渲染进程, 没窗口 kickEmbed 就是空转。
//
// 失败不能就此撂下: 首启时没网/网差是最常见的情形, 而用户可能好几天不重启 app,
// 那样"默认开"就成了一句空话。所以退避重试到装上为止 —— 断点续传在 voice-stt.download 里,
// 重试不会把已经下到的部分白扔。退避封顶 30 分钟: 网通了最多晚半小时, 网不通也不会去刷人家的服务器。
const SEM_RETRY_MS = [30e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 30 * 60e3];
function kickSemanticModel(attempt = 0) {
  require('../core/embed/model').ensureInstalled().then((r) => {
    if (!r || !r.ok) {
      const wait = SEM_RETRY_MS[Math.min(attempt, SEM_RETRY_MS.length - 1)];
      console.log(`[memory/semantic] 模型没装上(${r && r.error}) — ${Math.round(wait / 1000)}s 后再试`);
      setTimeout(() => kickSemanticModel(attempt + 1), wait).unref?.();
      return;
    }
    for (const s of sessions.values()) {
      try {
        s.butler.memory.markSemanticOptIn();
        s.butler.memory.kickEmbed({ limit: 0 });
      } catch (_) {}
    }
  }).catch(() => {});
}

/* 装上落地的手顺包。分发来的包是**验过签**的 —— 验签发生在 packages.loadAll 里, 而且是每次读都验,
   所以「装好之后有人在盘上改了内容」这种事下次开机就会落选, 不会一直带着跑。
   验不过的不装、只记一行日志: 半个能翻两屏的残疾手顺, 比干脆没有更难查。
   例外只有 packages.local/ 里自己写的那些(不验签, 理由见 packages.js), 装载时单独打一行标出来。 */
function loadWorkflowPackages() {
  try {
    workflow.reset();
    uiPackages.reset();
    commands.pkgCommandsReset();
    packages.ensureLocalDir(paths.dataDir());
    // 出厂示例先播再读 —— 新装的机器否则一个插件都没有, plugin_find 只能回"一个都没装"。
    const seed = packages.seedFactoryPlugins(paths.dataDir(), (m) => console.error(m));
    if (seed.seeded.length) console.log('[pkg] 出厂示例已播:', seed.seeded.join(' '));
    const all = packages.loadAll({ dataDir: paths.dataDir() });
    const r = workflow.loadFromPackages(all, { progress: workflowProgress.create(paths.controlDir()) });
    // 界面包跟手顺包读的是**同一批**落地物, 所以只能一起装 —— 分两趟读会出现
    // 「手顺已经换了新版, 界面还是上一版」这种谁也想不到要去查的错位。
    const u = uiPackages.loadFromPackages(all);
    // 包带的命令声明也是同一批读出来的。内置命令不受影响 —— catalog() 里源码写在后面。
    const c = commands.loadFromPackages(all);
    const localOnes = all.accepted.filter((p) => p.local);
    if (localOnes.length) console.log('[pkg] 本地未签名:', localOnes.map((x) => `${x.type}.${x.id}`).join(' '));
    for (const x of all.rejected) console.error('[workflow] 包没通过:', x.file, x.code, x.message);
    for (const x of r.failed) console.error('[workflow] 包形状不对:', x.id, x.message);
    for (const x of u.failed) console.error('[ui] 界面包形状不对:', x.id, x.message);
    for (const x of c.failed) console.error('[cmd] 包里的命令没收:', x.id, x.message);
    if (r.loaded.length) console.log('[workflow] 已装手顺:', r.loaded.map((x) => `${x.id}(${x.steps})`).join(' '));
    if (u.loaded.length) console.log('[ui] 已装界面:', u.loaded.map((x) => `${x.id}@${x.version}`).join(' '));
    if (c.loaded.length) console.log('[cmd] 包带的命令:', c.loaded.map((x) => x.added.join(',')).join(' '));
    // 🔴 "装上了"有两个主语。这里装上的是主进程那一份, 而渲染层的界面包清单和命令目录都是
    //    **开窗那一刻取的缓存** —— 不推它一把, 窗口开着时新装的包在屏幕上一律是"没装这个界面包",
    //    日志却明明写着已装。装包既可以发生在开窗之前(启动)也可以在之后(bus 下发 / packages.local
    //    落盘), 后者才是常态。广播挂在这里而不是各调用方: 这是所有装包路径的唯一咽喉, 挂这儿没人漏得掉。
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('packages-changed');
    return { ...r, ui: u, commands: c, local: { accepted: localOnes, rejected: all.rejected.filter((x) => x.local) } };
  } catch (e) {
    console.error('[workflow] 装载失败:', e);
    return { loaded: [], failed: [], ui: { loaded: [], failed: [] }, commands: { loaded: [], failed: [] }, local: { accepted: [], rejected: [] } };
  }
}

/* 自己写的包是 Write 直接落盘的, 没有下发链路那个"装上了"的瞬间可以挂钩子, 所以看的是**放包的目录本身**。
   刻意不做成"在某处调一下"的函数: 调用方一旦漏掉就永远不生效, 而且漏没漏谁都看不出来。 */
const LOCAL_PKG_DEBOUNCE_MS = 500;
let _localPkgTimer = null;
let _localPkgSeen = null;
// 已经投诉过的那些配色问题(按 id+版本+投诉内容记)。同一份没改就不再唠叨, 改动了才算新事。
let _localPkgLintSeen = new Set();
const lintKeyOf = (x) => `${x.type}.${x.id}@${x.version}|${(x.lint || []).join('¦')}`;
// 🔴 指纹必须含内容: 改插件时版本号极少跟着动, 只比 type.id@version 会把通知整个吞掉(08-30 实测 ui.mood_log@1.0.0 改了内容, 重装真发生了、日志也写了, 人格却什么都没收到)。
const pkgFingerprint = (x) => crypto.createHash('sha1').update(JSON.stringify({ ...x, file: undefined })).digest('hex').slice(0, 8);

function localPkgSnapshot(r) {
  const ok = (r.local && r.local.accepted) || [];
  const bad = (r.local && r.local.rejected) || [];
  return {
    ok, bad,
    key: [...ok.map((x) => `${x.type}.${x.id}@${x.version}+${pkgFingerprint(x)}`).sort(),
          ...bad.map((x) => `!${path.basename(x.file)}:${x.code}`).sort()].join('|'),
  };
}

function reloadLocalPackages() {
  const snap = localPkgSnapshot(loadWorkflowPackages());
  if (snap.key === _localPkgSeen) return;   // 内容没变就闭嘴(只动了 mtime 之类)
  _localPkgSeen = snap.key;

  // 回给最近说过话的那个人格。放包的目录挂在 dataDir 下是全机共用的, 谁写的无从得知 ——
  // 但此刻有能力往里写的, 只有正在干活的那一个。
  let s = null;
  for (const x of sessions.values()) if (!s || (x.last_activity_ts || 0) > (s.last_activity_ts || 0)) s = x;
  if (!s) return;

  const lines = [];
  if (snap.ok.length) lines.push('Currently installed: ' + snap.ok.map((x) => `${x.type}.${x.id}@${x.version}`).join(' '));
  for (const x of snap.bad) lines.push(`⚠ Cannot read ${path.basename(x.file)}: ${x.code} ${x.message}`);
  // 配色体检: 只说**这次真变了的那份**。
  // 🔴 血泪(2026-08-27 首次接线当场踩): 一开始报的是"目录里所有带毛病的", 结果人格收到 11 份的
  // 投诉, 把 counter / approval-form / addition-drill 这些历史堆积全改了一遍 —— 那些不是它写的,
  // 它却以为是自己的活。目录是全机共用的垃圾场, "目录里有脏的"和"你刚写了脏的"是两回事。
  const dirty = snap.ok.filter((x) => (x.lint || []).length && !_localPkgLintSeen.has(lintKeyOf(x)));
  for (const x of dirty) for (const msg of x.lint) lines.push(`🎨 ${x.type}.${x.id}: ${msg}`);
  _localPkgLintSeen = new Set(snap.ok.filter((x) => (x.lint || []).length).map(lintKeyOf));
  s.butler.submit([
    '(auto · packages.local changed, reinstalled)',
    ...lines,
    '',
    'Installed packages are effective immediately, no restart needed. To show one to the user, call plugin_open(id).',
    '⚠ Items above marked unreadable have a malformed structure; drop the file again after fixing, no restart needed.',
    ...(dirty.length ? ['🎨 The flagged items are from **the file you just wrote** — fix them now before showing to the user: overwrite the file and it will auto-reinstall.'
                      + ' ⚠️ Only touch the named file; do not modify other packages in the directory.'] : []),
  ].join('\n'), undefined, { sourceKind: 'auto' })
    .catch((e) => console.error('[pkg-local] 通知发不出去:', e && e.message));
}

// 基线取启动那次装载的真实结果 —— 从空开始的话, 开机后第一次改动会把本来就装着的那些一起报一遍。
function watchLocalPackages(bootResult) {
  const dir = packages.ensureLocalDir(paths.dataDir());
  const boot = localPkgSnapshot(bootResult || { local: { accepted: [], rejected: [] } });
  _localPkgSeen = boot.key;
  // 开机时目录里已经存在的毛病一律记成"已知", 不投诉 —— 那是上一辈子留下的, 不是这个人格干的。
  // 只有开机之后新写/改出来的才算它的活。
  _localPkgLintSeen = new Set(boot.ok.filter((x) => (x.lint || []).length).map(lintKeyOf));
  try {
    fs.watch(dir, () => {
      // 写到一半读会看成坏 JSON。等它停手再读一次就好。
      if (_localPkgTimer) clearTimeout(_localPkgTimer);
      _localPkgTimer = setTimeout(() => { _localPkgTimer = null; reloadLocalPackages(); }, LOCAL_PKG_DEBOUNCE_MS);
    });
    console.log('[pkg-local] 开始看着:', dir);
  } catch (e) { console.error('[pkg-local] 看不了:', e && e.message); }
}

// 启动提示小窗: 在 openPersona 那段同步阻塞【之前】弹出来, 跑完由调用方 destroy。
//
// 🔴 必须等首帧画出来再返回。主进程紧接着就被同步代码占死, 那之后这个窗口收不到任何 IPC,
// 也走不到 ready-to-show —— 没等到就开跑的话, 用户看到的是一个空白框(比没有还糟)。
// 所以文案在 loadFile 时用 query string 一次性带进去, 窗口里只有纯 CSS 动效。
async function showBootingWindow(homeDirs) {
  // 真要迁多少条: detectStart 只读目录不写盘, kind A/B 才是"老用户有存量要迁"。
  let pendingMds = 0;
  for (const d of homeDirs) {
    try {
      const st = migrateV2.detectStart(persona.resolveMemoryDir(d));
      if (st && (st.kind === 'A' || st.kind === 'B')) pendingMds += st.mds || 0;
    } catch (_) {}
  }
  const q = pendingMds
    ? `title=${encodeURIComponent('首次升级，正在迁移记忆…')}`
      + `&sub=${encodeURIComponent(`要搬运 ${pendingMds} 条记忆，这一次会久一些（之后开机就快了）`)}`
    : '';
  try {
    const win = new BrowserWindow({
      width: 380, height: 96, show: false, frame: false, transparent: true,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, center: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    const shown = new Promise((res) => {
      win.once('ready-to-show', res);
      setTimeout(res, 3000);   // 兜底: 首帧迟迟不来也别把整个启动卡在这
    });
    win.loadFile(path.join(__dirname, 'renderer', 'booting.html'), q ? { search: q } : undefined);
    await shown;
    if (!win.isDestroyed()) win.show();
    // show() 只是把窗口排进队列, 真正合成到屏幕要等 runloop 转一圈。返回后主线程下一毫秒
    // 就被 openPersona 同步占死, runloop 不转 = 窗口永远画不上屏(0.1.2 的现象)。让出几圈再走。
    await new Promise((r) => setTimeout(r, 150));
    return win;
  } catch (e) {
    console.error('[startup] 启动提示窗打开失败(不影响启动):', e && e.message);
    return null;
  }
}

function createWindow() {
  mainWin = new BrowserWindow({
    ...require('../core/dev-window-place')(980, 780), minWidth: 640, minHeight: 480, title: `全能管家 v${app.getVersion()}`, backgroundColor: windowBg(),
    // 版本号从这里递进去: preload 跑在沙箱里, 里面 require('./package.json') 会失败(静默落成 '?'), 标题就成了「v?」。
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      additionalArguments: [`--butler-version=${app.getVersion()}`] },
  });
  // http/https 链接左键点击 → 交给系统浏览器打开 (不在 butler 内开新窗口)
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  // 关闭主窗口 = 彻底退出 butler (v3 · 2026-07-13). 弹确认: butler 是重量级后台服务,
  // 关窗会连带停 idle-watch / TG 长轮询 / bothub / 各人格 MCP 子进程. 会话已落盘, 重启后可续.
  // v0.0.22 (2026-07-20): 退出前让所有 dirty 人格逐个沉淀+clear (skipWake), 起来是全新会话跟"清空后重启"同构.
  let _confirmedQuit = false, _quitFlowRunning = false;   // 后者防信号重入: 第二个 SIGTERM 会开第二条退出链, 两条并发跑等于串行沉淀白做
  mainWin.on('close', (e) => {
    if (_confirmedQuit) return;
    e.preventDefault();
    // 这条路从前一个字不写: 夜里有东西触发关窗、早上人点了取消, 日志里查不到任何痕迹(2026-10-12)
    console.log(`[quit] 主窗收到 close → 弹确认框 · focused=${mainWin.isFocused()} visible=${mainWin.isVisible()}`);
    const choice = dialog.showMessageBoxSync(mainWin, {
      type: 'question', buttons: ['彻底退出', '取消'], defaultId: 1, cancelId: 1,
      title: '退出 butler',
      message: '关窗口 = 彻底退出 butler, 确定?',
      detail: '所有插件(TG/bothub) 会停 · idle-watch 会停 · 各人格 MCP 子进程会收.\n退出前会让活跃人格沉淀手头活到图记忆(几秒钟).',
    });
    console.log(`[quit] 确认框结果: ${choice === 0 ? '彻底退出' : '取消'}`);
    if (choice === 0) void runQuitFlow();
  });
  // v0.0.22 退出流程: 收集 dirty → overlay 显示 → **串行**沉淀(并发会把首字延迟放大到全员超时, 见 quit-sediment.js) → 有失败弹选择 → mainWin.close 触发 before-quit kill 插件.
  // interactive=false: 走信号(SIGTERM/SIGINT)进来的, **现场没有人**。这条路上一个
  // showMessageBoxSync 都不许弹 —— 它是同步阻塞的, 没人点就永久堵死, 表现和真卡死一模一样。
  async function runQuitFlow({ interactive = true } = {}) {
    const items = [...sessions.entries()].map(([sid, s]) => ({
      sid, s,
      name: (s.butler && s.butler.name) || '人格',
      dirty: !!(s.butler && s.butler.dirtySinceLastClear && s.butler.sessionId && s.butler._q),
    }));
    if (!beginQuit()) return; const dirtyItems = items.filter(x => x.dirty);   // beginQuit 防信号重入: 第二条退出链会让串行沉淀白做
    if (dirtyItems.length === 0) { _confirmedQuit = true; mainWin && mainWin.close(); return; }
    const sendSed = (d) => { if (mainWin) mainWin.webContents.send('sediment', d); };
    sendSed({ phase: 'show', personas: dirtyItems.map(x => ({ sid: x.sid, name: x.name })) });
    const results = await sedimentSerially(dirtyItems, {
      reason: '退出 butler',
      onProgress: (x, r) => sendSed({ phase: 'progress', sid: x.sid, status: r.ok ? 'done' : 'error' }),
      onAlive: (x, info) => sendSed({ phase: 'alive', sid: x.sid, ...info }),
    });
    const failed = results.filter(res => !res.r.ok);
    if (failed.length > 0) {
      const detail = failed.map(f => `· ${f.x.name}: ${f.r.error || '未知错误'}`).join('\n');
      // 没人在现场 → 一个字都不通知(没人点得动), 如实写进日志然后退。活没丢: keepContextOnSedimentFail
      // 让上下文原样留着, 下次开起来还能再沉一次。
      if (!interactive) {
        console.log(`[quit] ${failed.length} 个人格没沉成, 但走的是信号路径(没人在现场) → 直接退\n${detail}`);
      } else {
        // 🔴 这里从前是 showMessageBoxSync 拦路框, 而它说的往往是假话 —— 看门狗放弃等待不等于人格死了,
        // 实测被判死之后它照样把记忆写完。改成通知: 不阻塞, 后台写完自己收掉, 用户想插手随时能按。
        const choice = await noticeAndWait(failed, sendSed);
        // 取消退出: 进程没死下次还能再退; cancelQuit 摘 shuttingDown, 人格要完整恢复不能只退一半
        if (choice === 'cancel') { cancelQuit(dirtyItems); endQuit(); sendSed({ phase: 'hide' }); return; }
        console.log(`[quit] 通知出口: ${choice === 'settled' ? '它们自己把活写完了' : '用户按了强制关闭'}`);
      }
    }
    sendSed({ phase: 'hide' });
    _confirmedQuit = true;
    if (mainWin) mainWin.close();
  }
  // 🔴 收到信号直接走退出链, **不弹确认框**。确认框是给"人点了关窗按钮"防误关用的; 信号本身
  // 就是明确的退出指令, 而且发信号的那一方(脚本 / launchd / kill)不在场, 没人点得动它。
  // 不接这个信号的后果不是"退得慢"而是**永久堵死**: SIGTERM → Electron 默认退出 → close 处理器
  // e.preventDefault() 之后 showMessageBoxSync 同步阻塞, 于是进程不退、日志一个字不出、CDP 还通,
  // 看起来完全像卡死。2026-08-27 实撞: dev-restart.sh 等满 120s 也没等到进程消失, 而它的注释里
  // 还写着"SIGTERM 后实测 16~48 秒才真退" —— 那句从来没有在这条路上被验证过。
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      if (_confirmedQuit) return;
      console.log(`[quit] 收到 ${sig} → 直接走退出链(沉淀照跑, 全程不弹任何确认框)`);
      void runQuitFlow({ interactive: false });
    });
  }
  relaunchApp = () => { if (_confirmedQuit) return; console.log('[quit] 重启 app'); app.relaunch(); void runQuitFlow(); };
  // v3: 关窗口 = 彻底退主进程. butler 是重量级后台(SDK 子进程 + idle-watch + TG polling), 后台常驻反直觉且耗额度.
  // 反 macOS 常规 (通常关窗口保后台), 但作者钦定简化派. 顺带清理: dock icon 消失 = 明确"没在跑".
  mainWin.on('closed', () => { mainWin = null; app.quit(); });
  const { attachRendererDiagnostics, createSandboxErrorRelay } = require('../core/renderer-diagnostics');
  const relaySandboxError = createSandboxErrorRelay((text) => {   // 转给最近说过话的那个人格
    let s = null;
    for (const x of sessions.values()) if (!s || (x.last_activity_ts || 0) > (s.last_activity_ts || 0)) s = x;
    return s ? s.butler.submit(text, undefined, { sourceKind: 'auto' }) : Promise.resolve();
  }, console.error);
  attachRendererDiagnostics(mainWin, 'main-win', relaySandboxError); require('./window-guard').guardMainWindow(mainWin);   // 沙箱报错也转给它(那里没 console) + 窗口塌成 0x0 时自己爬起来
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// 捆绑/解析后的 claude 二进制(打包版 = Resources/bin/claude, 免 PATH 依赖)。auth 检测 + 登录都用它。
const CLAUDE_BIN = paths.resolveClaudeBin();

// 检查 Claude 是否已登录(走 keychain, 与 VSCode/命令行 claude 共享同一份凭据)。
// CLI 输出 JSON {"loggedIn":true,...}; 老版可能是文本。
function isClaudeLoggedIn() {
  const { spawnSync } = require('child_process');
  try {
    const r = spawnSync(CLAUDE_BIN, ['auth', 'status'], { encoding: 'utf-8', timeout: 8000 });
    console.log(`[auth/status] bin=${CLAUDE_BIN} exit=${r.status} stdout=${(r.stdout||'').slice(0,200).replace(/\n/g,' ')} stderr=${(r.stderr||'').slice(0,200).replace(/\n/g,' ')}`);
    const stdout = r.stdout || '';
    // 退出码分不出"确实没登录"和"探测本身失败": 未登录时 CLI 也是 exit=1 + 合法 JSON。
    // 只有解析得出 loggedIn 字段, 才算 CLI 真的回答了这个问题。
    const j = (() => { try { return JSON.parse(stdout); } catch (_) { return null; } })();
    if (j && typeof j.loggedIn === 'boolean') return j.loggedIn;
    if (r.status === 0 && /logged\s*in|authenticated|已登录/i.test(stdout + (r.stderr || ''))) return true;
  } catch (e) { console.log(`[auth/status] exception: ${e && e.message}`); }
  // 走到这里 = CLI 没给出可信答案(超时 / 崩溃 / 输出换了样)。这时候绝不能当"没登录" ——
  // 代价是不对称的: 误判未登录会拿一个登录框挡住一个本来能用的 app(Windows 实测就是这样),
  // 而误判已登录最多是稍后 401, 那条路有自愈兜着。凭证还在且没过期就放行。
  const fallback = hasUsableCredential();
  console.log(`[auth/status] CLI 没给出可信答案, 回退看凭证 → ${fallback ? '有效, 当已登录' : '无效, 当未登录'}`);
  return fallback;
}

// 凭证本身还能不能用(不问 CLI)。只在 CLI 探测失败时当兜底判据。
function hasUsableCredential() {
  const s = readAuthStamp();
  if (!s) return false;
  const exp = Number(s);
  return Number.isFinite(exp) && exp > Date.now();
}

// 凭证指纹: accessToken 的到期时间戳。重新登录会换发新 token → 这个数变。
// 为什么需要它: isClaudeLoggedIn() 只看凭证在不在、不看还能不能用 —— 认证已坏时它照样返回 true。
// 所以"重登完成没有"绝不能用它判断(会在用户还在浏览器里点的时候就误判成功、把 CLI kill 掉),
// 只能看这个指纹变没变。凭证位置: macOS 在 keychain, 其余平台在 ~/.claude/.credentials.json。
function readAuthStamp() {
  const o = modelOptions.readClaudeCreds();
  return o && o.expiresAt ? String(o.expiresAt) : null;
}


// 订阅通路当前能不能用。渲染层要拿它决定"订阅"这个选项摆不摆得出来, 而 isClaudeLoggedIn
// 是一次 spawnSync(最长 8 秒), 挂在 get-access 上会把主进程按住 —— 所以只在真正问过的
// 那几个时刻记下来: 启动探测一次, 之后每次 OAuth 成功再抬一次。
let subAuthOk = false;
let pendingLoginFlight = null;   // 首登点了"连接 Claude" → 那次授权在后台跑, 窗口先开, 进度挂横幅

async function ensureClaudeAuth() {
  console.log('[auth] === ensureClaudeAuth 开始 ===');
  // 开源下载版没有 CC: 订阅那条路不存在, 弹「连接 Claude」只会把人引向死路。首启页只给配 key
  if (!(await require('../core/agent/util').ccAvailable())) { subAuthOk = false; console.log('[auth] 没装 CC SDK, 只走 API key, 不弹登录'); return false; }
  if (isClaudeLoggedIn()) { subAuthOk = true; console.log('[auth] 已登录, 跳过登录流程'); return true; }
  // 🔴 订阅不是唯一通路。凭据仓库里存了 API key 的机器根本不需要走 OAuth ——
  // 而 isClaudeLoggedIn 只认订阅凭证, 于是"只用 key"的用户每次开机都被一个
  // 只有【连接/退出】两个按钮的框挡在门外, 连去设置里填 key 的机会都没有。
  if (require('../core/credentials').hasAnyKey({ settings, secrets, defaultName: i18n.uiStrings(currentLocale()).sys_cred_migrated_name })) { console.log('[auth] 未登录但凭据仓库有 API key, 不拦'); return true; }
  console.log('[auth] 未登录, 弹连接对话框');
  try { app.focus({ steal: true }); } catch (_) {}   // 启动期无父窗口的对话框在 Win 上可能开在别的窗口后面 → 先抢焦点
  const choice = dialog.showMessageBoxSync({
    type: 'info',
    title: '连接 Claude',
    message: '连接你的 Claude 账号, 或先进去用 API Key',
    detail: '点"连接 Claude"会自动打开浏览器登录 claude.ai(需要 Claude 订阅)。\n授权完浏览器会跳回本机一个 localhost 地址, 这边自动继续, 无需开终端、无需重启。\n\n也可以点"先进去"直接打开界面, 在【系统设置 → 接入方式】里填 API Key —— 那条路不需要登录。填之前助手发不出消息, 界面可以随便看。',
    buttons: ['连接 Claude', '先进去', '退出'],
    defaultId: 0, cancelId: 2,
  });
  // 🔴 「先进去」必须真的往下走而不是 quit: 没有这条路, 只用 key 的新用户在干净机器上
  // 是死锁的 —— 填 key 要进设置, 进设置要开窗口, 开窗口要先过这个框。
  if (choice === 1) { console.log('[auth] 用户选择先进去(稍后用 API Key), 跳过登录'); return false; }
  if (choice === 2) { app.quit(); return false; }
  // 🔴 不 await。原先阻塞在这儿, 而 createWindow 排在 ensureClaudeAuth 后面 —— 用户点了
  // "连接 Claude" 却没在浏览器里授权(或顺手关掉了那页), 接下来 10 分钟里连窗口都还没造出来:
  // 没有横幅、没有取消、也没有去填 API Key 的入口, 只能杀进程。放后台跑、窗口照常开之后,
  // 「等授权」就从卡住启动降级成界面上的一条横幅, 于是根本不需要"取消"这个东西。
  //
  // 🔴 走与"凭证失效自愈"完全同一条流程(reloginAndRecover, 不是裸 runClaudeLogin):
  // ① 共享它的单飞锁, 不会和自愈撞出两个浏览器窗口 ② 成功后它会逐个重建人格子进程 ——
  // 那些进程是在授权还没完成时起的, 只在启动那刻读一次 keychain, 不重建的话登了也白登。
  // 完成信号只认 runClaudeLogin 里那一套(等 CLI 自己退出), 别再另造第二套轮询判据:
  // 轮询任何"凭证侧的状态"都会在用户还在浏览器里点的时候误判成功, 于是把 CLI 连同 CLI
  // 自己起的 localhost 回调服务器一起杀掉 —— isClaudeLoggedIn 栽过一次, 凭证指纹又栽过一次。
  pendingLoginFlight = reloginAndRecover();
  return false;
}

// —— 认证失效自愈 ——
// 背景: Claude Code 上游缺陷, refreshToken 存了却不可靠地续期, 每隔几天会突然全局 401 且不自愈。
// 重启 app 修不好(ensureClaudeAuth 那个 isClaudeLoggedIn 是假阳性), 只有重新走一遍 OAuth 才行。
// 通道刻意走【应用内横幅】而不是 TG —— 不是每个用户都配了 TG, 通知手段必须自足。
let reloginInFlight = null;   // 全局单飞: 凭证是所有人格共用的, 一个坏必然全坏, 绝不能四个人格各弹一次浏览器

// 走一遍 OAuth 登录。
// 🔴 完成信号只能是【CLI 自己退出】+ 凭证指纹变了, 绝不能一看见指纹变就 kill。
// 判据换代要问的是「用户什么都没做的时候, 它会不会自己变」—— 指纹会: CLI 一启动就拿
// refreshToken 自刷一次 token, expiresAt 立刻变。2026-08-26 日志实测: 打开浏览器后
// 1.1 秒就判成功并 kill, CLI 起的 localhost 回调服务器随之死, 用户在浏览器里点完授权
// 没人接。前一代判据 isClaudeLoggedIn 也栽在同一件事上(只看凭证在不在), 换成指纹只是
// 把假阳性从"本来就有凭证"挪到"自刷了一次", 病根没动。
function runClaudeLogin(timeoutMs = 600000) {
  return new Promise((resolve) => {
    const before = readAuthStamp();
    console.log(`[auth/relogin] 开始, 旧凭证指纹=${before}`);
    const { spawn } = require('child_process');
    let child;
    try {
      child = spawn(CLAUDE_BIN, ['auth', 'login', '--claudeai'], { stdio: ['ignore', 'pipe', 'pipe'] });
      console.log(`[auth/relogin] child pid=${child.pid}`);
    } catch (e) {
      console.log(`[auth/relogin] spawn 失败: ${e && e.message}`);
      return resolve({ ok: false, error: String(e && e.message) });
    }
    try {
      child.stdout.on('data', (d) => console.log(`[auth/relogin][out] ${String(d).trim().slice(0, 300)}`));
      child.stderr.on('data', (d) => console.log(`[auth/relogin][err] ${String(d).trim().slice(0, 300)}`));
    } catch (_) {}
    let done = false;
    const finish = (v) => {
      if (done) return; done = true;
      try { clearTimeout(to); } catch (_) {}
      try { child.kill(); } catch (_) {}
      console.log(`[auth/relogin] 结束 ok=${v.ok} ${v.error || ''}`);
      resolve(v);
    };
    child.on('error', (e) => finish({ ok: false, error: String(e && e.message) }));
    // CLI 退出后再宽限一拍: 凭证落盘可能比进程退出稍晚
    child.on('exit', (code) => setTimeout(() => {
      const now = readAuthStamp();
      const won = !!(now && now !== before);
      if (won) subAuthOk = true;
      finish(won ? { ok: true } : { ok: false, error: `登录未完成 (CLI exit ${code})` });
    }, 1200));
    const to = setTimeout(() => finish({ ok: false, error: '登录超时(10 分钟)' }), timeoutMs);
  });
}

// 重登 + 让所有人格重新上路。单飞: 并发调用共享同一个 promise。
function reloginAndRecover() {
  if (reloginInFlight) { console.log('[auth/relogin] 已在进行中, 共享同一次'); return reloginInFlight; }
  reloginInFlight = (async () => {
    const r = await runClaudeLogin();
    if (!r.ok) return r;
    // 关键: 每个人格的 claude 子进程只在启动那刻读一次 keychain, 光换凭证它不重读 →
    // 必须逐个拆流重建, 否则登了也白登。replayAfterRelogin 内部做 teardown + 回放暂存消息。
    for (const s of sessions.values()) {
      try {
        const rr = await s.butler.replayAfterRelogin();
        console.log(`[auth/relogin] ${s.butler.name} 恢复: ${JSON.stringify(rr)}`);
      } catch (e) {
        console.error(`[auth/relogin] ${s.butler && s.butler.name} 恢复失败: ${e && e.message}`);
      }
    }
    return { ok: true };
  })().finally(() => { reloginInFlight = null; });
  return reloginInFlight;
}

// 把首登那次后台授权的进度挂到认证横幅上。只能在 createWindow 之后调:
// sendUI 在 mainWin 存在之前是空投, 悄悄丢掉; 窗口刚造出来时 renderer 还没绑上监听, 所以再等一拍 did-finish-load。
function attachPendingLoginBanner(flight) {
  const push = (ch, payload) => {
    if (!mainWin || mainWin.isDestroyed()) return;
    if (mainWin.webContents.isLoading()) mainWin.webContents.once('did-finish-load', () => sendUI(ch, payload));
    else sendUI(ch, payload);
  };
  push('auth-pending', { done: false });
  flight.then((r) => {
    if (r && r.ok) push('auth-ok', {});
    else push('auth-pending', { done: true, error: (r && r.error) || '' });
  }).catch((e) => push('auth-pending', { done: true, error: String(e && e.message) }));
}

// —— 总控布局迁移: 早期版本把登记簿/标签放在数据目录根(或跟管家混在一起) → 挪进中立的 app/ 子目录。
// 幂等: 新位置已有则不动; 旧位置搬走后归档为 .moved(只迁一次)。让"总控数据"与"谁是管家"彻底解耦。
function migrateControlLayout() {
  try {
    const ctl = paths.controlDir();
    fs.mkdirSync(ctl, { recursive: true });
    for (const name of ['personas.json', 'personas.json.bak', '.opentabs.json']) {
      const oldp = path.join(paths.dataDir(), name);
      const newp = path.join(ctl, name);
      if (fs.existsSync(oldp) && !fs.existsSync(newp)) {
        try { fs.copyFileSync(oldp, newp); fs.renameSync(oldp, oldp + '.moved'); } catch (_) {}
      }
    }
  } catch (e) { console.error('[migrate] 总控布局迁移失败:', e && e.message); }
}

// 语义检索的自定义协议必须在 ready 之前登记 —— 这是 Electron 的硬时序,
// 晚一步不会报错, 只会让协议"看着能用但 import 仍被同源策略拦", 极难自诊断。
try { require('../core/embed/host').registerScheme([require('../core/asset-bridge').SCHEME_DESC]); } catch (e) { console.error('[embed] scheme 注册失败:', e); }

let startupDone = false;   // 见下面 window-all-closed
app.whenReady().then(async () => {
  try {
    // 协议处理器要在 ready 之后装(net.fetch 依赖 session)。与上面的 registerScheme 是一对。
    try { require('../core/embed/host').installProtocol(); } catch (e) { console.error('[embed] protocol 安装失败:', e); }
    // 插件读本地资源(asset 原语)的地址: 按令牌找文件, 支持 Range
    try { require('electron').protocol.handle(assetBridge.SCHEME, (req) => assets.respond(req.url, req.headers.get('range'))); } catch (e) { console.error('[asset] protocol 安装失败:', e); }
    // 语音输入(STT): 授予 renderer getUserMedia('audio') 权限. Electron 默认拒绝媒体请求
    // → getUserMedia 拿到的是静音 stream, whisper 会稳定输出 "you" 幻觉. 修法:
    // ①setPermissionRequestHandler 显式放行 media  ②macOS 首次触发系统 TCC 弹窗
    try {
      const allowPerm = (p) => p === 'media' || p === 'audioCapture' || p === 'clipboard-sanitized-write';   // 剪贴板写: 各处「复制」按钮
      session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(allowPerm(permission)));
      session.defaultSession.setPermissionCheckHandler((wc, permission) => allowPerm(permission));
      if (process.platform === 'darwin') {
        const st = systemPreferences.getMediaAccessStatus('microphone');
        console.log('[voice-stt/perm] mic access status =', st);
        if (st !== 'granted') {
          const ok = await systemPreferences.askForMediaAccess('microphone');
          console.log('[voice-stt/perm] askForMediaAccess ->', ok);
        }
      }
    } catch (e) { console.error('[voice-stt/perm] setup failed:', e); }
    // 首启落定数据目录(写指针, 不弹框) — 必须在任何登记簿/人格读写之前(打包模式; 开发模式 no-op)。
    // 语言不问: 跟系统走, 空状态屏第一屏能改。settings.json 住在 dataDir()/app/ 下, 所以指针先于任何设置写入。
    // 干净启动: 不带任何数据种子; 没有人格时渲染层显示空状态屏, 用户建了才有。
    const firstRunLocale = require('./first-run').run();   // 现在恒为 null(见 first-run.js), 留着这条落盘口子
    if (firstRunLocale) settings.write({ language: firstRunLocale });
    require('./data-dir-guard').checkAll(firstRunLocale); migrateControlLayout();   // 指针丢了 / 数据在安装目录 → 先问清楚; 再把总控数据挪进 app/(都在任何登记簿读写前)
    // 代理: 必须早于任何出网动作(下面 ensureClaudeAuth 就要连 Anthropic)。
    // 依赖数据目录, 所以只能排在首启那两个框之后。
    try {
      const st = proxy.apply(settings.read());
      console.log('[proxy]', st.on ? `已启用 → ${st.url}` : '未启用(直连)');
    } catch (e) { console.error('[proxy] 应用失败:', e); }
    // 手顺包 · 必须早于 openPersona: 开人格那一刻就要往提示语里写"装了哪些手顺"
    watchLocalPackages(loadWorkflowPackages());
    // 未登录 → 问一次要不要连 Claude。真去连的话授权在后台跑, 这里不等 —— 人格会先在无凭据状态起来,
    // 授权完成后 reloginAndRecover 逐个把它们重建掉。
    await ensureClaudeAuth();
    fillEmptyEngines();   // 空着的引擎栏按接入方式补上, 之后装不装 Claude SDK 都不再漂
    // 有要跑 Claude Code 的人格而本机缺这一版的 SDK: 先问, 同意就等下载完直接重启 —— 人格和主窗口都不在下载期间起来
    if (await require('./cc-sdk-boot').run({
      S: i18n.uiStrings(currentLocale()),
      hasSubscriptionPersona: () => registry.list().some((p) => p.accessMode !== 'api' || p.sdk === 'claude-code'),
      relaunch: () => relaunchApp(),
    })) return;
    // 恢复上次打开的标签。🔴 一个人格都没有时**不兜底创建** —— 渲染层显示空状态屏, 让用户
    // 先接上 AI、顺手选好人格目录, 点了「创建初始人格」才真的建。详见 first-persona.js。
    const dirs = loadOpenTabs().filter((d) => { try { return fs.existsSync(d); } catch (_) { return false; } });
    const { toOpen, entry: bEntry, memDir: bMemDir, newborn: butlerNewborn } =
      firstPersona.planStartup({ tabDirs: dirs, registry, paths, persona, appVersion: paths.appVersion() });
    // 启动提示小窗。openPersona 这一段是**同步阻塞**的(记忆迁移 + 出厂同步 + 起 SDK 子进程),
    // 主窗口又排在它后面, 所以老用户首次升级时点开图标是"没反应, 等半天窗口才出来"。
    // 先弹个小窗把话说在前头, 跑完再关。detectStart 只读文件, 拿它算出真要迁多少条, 文案才不是空话。
    const bootWin = await showBootingWindow(toOpen);
    try {
      for (const d of toOpen) openPersona(d);
    } finally {
      // 放在 finally: 启动链中途抛异常时小窗必须跟着走, 否则用户对着一个永远转圈的框。
      try { if (bootWin && !bootWin.isDestroyed()) bootWin.destroy(); } catch (_) {}
    }
    createWindow();
    startupDone = true;
    if (pendingLoginFlight) attachPendingLoginBanner(pendingLoginFlight);
    kickSemanticModel();
    if (butlerNewborn) {
      firstPersona.birth({ session: sessions.get(sidOf(bEntry.homeDir)), entry: bEntry, memDir: bMemDir,
        gift: giftSelfIdentity, onboard: runOnboarding });
    }
    idleWatcher.start();   // spec §1: 每 30s 扫全体 sessions, T1/T2/T3 决策保活/压缩
    reminderCenter.start();   // 每 30s 扫全部人格的提醒登记簿, 到点挂横幅
    restartLocalApi();    // 本机戳醒 API (默认关; 登记簿 localApi.enabled 开了才起端口)
  } catch (e) {
    // 启动链任何一环抛异常, 若不接住 = promise 静默吞掉 → 没有窗口、进程僵在后台("窗口没了但进程还在")。
    // 接住 → 弹可见错误 + 退出, 用户至少知道炸在哪。
    console.error('[startup] 启动失败:', e && (e.stack || e.message || e));
    try { dialog.showErrorBox('全能管家启动失败', String(e && (e.stack || e.message) || e)); } catch (_) {}
    app.exit(1);
  }
});
// app 退出前: 收所有人格的托管子进程(TG+bothub), 根治孤儿。同步 kill(before-quit 不 await, 用 SIGTERM 兜底)。
app.on('before-quit', () => {
  // 先于 close 出现 = app.quit 路(⌘Q / 系统注销关机 / 外部 quit 事件); 只有 close 没有它 = 有人点了 ×
  console.log('[quit] before-quit');
  idleWatcher.stop();
  try { localApiServer && localApiServer.stop(); } catch (_) {}
  for (const s of sessions.values()) {
    try { s.tgPlugin && s.tgPlugin.stop(); } catch (_) {}
    try { s.bothubPlugin && s.bothubPlugin.stop(); } catch (_) {}  try { s.channels && s.channels.stopAll(); } catch (_) {}
  }
});
// 启动链跑完之前不认"窗口全关": 关掉启动小窗到 createWindow 之间窗口数瞬时为 0,
// 非 darwin 会就地 app.quit(), 主窗口还没出生 app 就退了(Windows 独有, mac 走 darwin 分支看不到)。
app.on('window-all-closed', () => {
  if (!startupDone) return;
  if (process.platform !== 'darwin') app.quit();
});
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
    id: p.id, name: p.name, avatar: p.avatar || '', homeDir: p.homeDir, isButler: !!p.isButler,
    wakePhrase: p.wakePhrase || '', model: p.model || '', plugins: p.plugins || {}, open: sessions.has(sidOf(p.homeDir)),
    accessMode: p.accessMode === 'api' ? 'api' : 'subscription', credentialId: p.credentialId || '', sdk: p.sdk || '',
    voice: p.voice || { enabled: false, voice: 'Tingting' },
    // 状态: 已开人格的托管子进程实况(pid/exit); 未开=null
    pluginStatus: (() => {
      const s = sessions.get(sidOf(p.homeDir));
      return s ? { tg: s.tgPlugin && s.tgPlugin.status(), bothub: s.bothubPlugin && s.bothubPlugin.status(), channels: s.channels && s.channels.status() } : null;
    })(),
  })),
}));
// 按引用打开已登记人格(＋号 picker 选中 → 开标签)
ipcMain.handle('open-persona-ref', async (_e, { ref } = {}) => openPersonaByRef(ref));

// —— prompt chips(输入框上方快捷按钮 · 每人格独立) ——
// 出厂池是一次性脚手架: 点过即永久移出, 用完就空不兜底(作者 2026-08-08 定案)。
const chipEntryOf = (sid) => {
  const s = sessions.get(sid);
  return (s && s.butler && registry.getByDir(s.butler.homeDir)) || null;
};
ipcMain.handle('get-chips', async (_e, { sid } = {}) => {
  const entry = chipEntryOf(sid);
  if (!entry) return { chips: [] };
  // 顺手补登记上架时间。出厂池是配置文件, 改文件就会多出按钮, 没有"安装事件"可挂钩 ——
  // 用户第一次看见它, 就是"摆了多久没人碰"的计时起点。
  registry.touchChipSeen(entry.id);
  return { chips: registry.resolveChips(entry.id) };
});
// 点一下 = 计数 +1, 按钮留在原地。2026-08-17 统一口径后不再有"点过即焚"。
// 仍然回传整套列表: AI 可能刚好在这期间换过按钮, 让点击顺带刷新是最省事的同步点。
ipcMain.handle('chip-bump', async (_e, { sid, chipId } = {}) => {
  const entry = chipEntryOf(sid);
  if (!entry) return { ok: false, chips: [] };
  const count = registry.bumpChip(entry.id, chipId);
  return { ok: true, count, chips: registry.resolveChips(entry.id) };
});

// —— Local Poke API 开关 (进程级, 不属于任何人格) ——
ipcMain.handle('get-local-api', async () => ({
  ...registry.getLocalApi(),
  running: !!localApiServer,
}));
ipcMain.handle('set-local-api', async (_e, patch = {}) => {
  const r = registry.setLocalApi(patch);
  if (!r.ok) return r;
  const rr = restartLocalApi();
  return { ok: rr.ok !== false, localApi: r.localApi, running: !!rr.running, error: rr.error };
});

// —— 代理设置 (进程级, 不属于任何人格) ——
ipcMain.handle('get-settings', async () => ({ ...settings.read(), _file: settings.file() }));
ipcMain.handle('set-settings', async (_e, patch = {}) => {
  const next = settings.write(patch);
  const st = proxy.apply(next);
  // 已经在跑的人格子进程不会重新继承 env, 老实告诉用户要重启才全生效。
  return { ok: true, settings: next, proxy: st, needsRestart: true };
});
ipcMain.handle('test-proxy', async (_e, patch = {}) => {
  const probe = { ...settings.read(), ...patch, proxy: { ...settings.read().proxy, ...(patch.proxy || {}) } };
  return proxy.test(probe);
});

// —— 接入方式: 订阅 / API key (进程级, 不属于任何人格) ——
// key 只进不出: 前端拿到的永远是 hasKey 布尔值, 真值不回传渲染层。
// 凭据仓库(多条: 名字 + 端点 + key)。实现在 personal/credentials.js —— main.js 已超行数上限, 新功能不往里塞。
require('../core/credentials').register({
  ipcMain, settings, secrets, claudeBin: CLAUDE_BIN,
  defaultName: () => i18n.uiStrings(currentLocale()).sys_cred_migrated_name,
  subLoggedIn: () => subAuthOk,
  openApiPersonas: () => registry.list().filter((p) => p.accessMode === 'api' && sessions.has(sidOf(p.homeDir))),
});

require('../core/search-keys').register({ ipcMain, settings, secrets });   // 联网搜索引擎(用户自加、排序、禁用)
require('../core/cc-sdk-install').register({   // 开源包「使用 Claude 订阅」: 用户自己下载 SDK, 装好重启生效
  ipcMain, relaunch: () => relaunchApp(),
  send: (ch, p) => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(ch, p); },
});

// —— 界面语言 ——
// 没选过 (language='') 就跟 OS 走。app.getLocale() 在 macOS 回 'zh-Hans-CN' 之类,
// normalizeLocale 认不出的一律回 null → 落到默认中文, 不猜。
function currentLocale() {
  const l = i18n.normalizeLocale(settings.read().language) || i18n.normalizeLocale(app.getLocale()) || i18n.DEFAULT_LOCALE;
  require('../core/memory-v2/lang').setLang(l);  // 出厂知识按哪一语显示。漏调不报错, 只是记忆停在中文
  return l;
}
function localePayload() {
  const locale = currentLocale();
  return { locale, strings: i18n.uiStrings(locale), locales: i18n.supportedUiLocales() };
}
ipcMain.handle('get-locale', async () => localePayload());
ipcMain.handle('set-locale', async (_e, { locale } = {}) => {
  const next = i18n.normalizeLocale(locale);
  if (!next) return { ok: false, error: 'unsupported_locale' };
  settings.write({ language: next });
  // 管理窗口开着的话它也要跟着换 —— 两个窗口显示两种语言会让人以为坏了。
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('locale-changed', localePayload());
  return { ok: true, ...localePayload() };
});

/* ── 行内命令 ──
   目录是配置文件, 开窗那一刻就读得到 —— 不像行业版要等 boot 装完(那边为此踩过
   「真机上每个 {{cmd:}} 都是红字, 而门禁全绿」)。这边根在 config/ 里, 没有那个时间差。 */
ipcMain.handle('command-catalog', async () => ({ commands: commands.catalog() }));
/* 命令执行时碰外界的那几样。按钮(run-command)和人格的 plugin_call 共用这一份 —— 两条路能做的一样多。 */
const recordBridge = require('../core/record-bridge');
const recordsDir = () => path.join(paths.controlDir(), 'recordings');
const recordFor = recordBridge.create({ ipcMain, dir: recordsDir });
// asset 原语: 包自己的素材目录 + 用户亲手挑过的文件(按包记授权)。选择框挂在发命令的那个窗口上
const assetBridge = require('../core/asset-bridge');
let _assetPickWin = null;
const assets = assetBridge.create({
  root: () => path.join(paths.dataDir(), 'plugin-assets'),   // 跟 packages.local 并排, 人格写插件时看得见
  grantsFile: () => path.join(paths.controlDir(), 'plugin-asset-grants.json'),
  pickFiles: async (filters) => {
    const r = await dialog.showOpenDialog(_assetPickWin || mainWin, { properties: ['openFile', 'multiSelections'], filters });
    return r.canceled ? [] : r.filePaths;
  },
});
function commandCtx(sender) {
  return {
    // record 原语: 由发命令的那个窗口代录(插件沙箱里没有麦克风)。人格的 plugin_call 没有窗口, 也调不到 record
    record: recordFor(sender || null),
    // pron 原语送去评测时读本包录的那段
    recordFile: (pkg, id) => recordBridge.readRecording(recordsDir(), pkg, id),
    // asset 原语: pick 只有按钮(有窗口)才弹得出框; 人格的 plugin_call 没窗口, 登记时 pick 已设成只给人按
    asset: (pkg, op, args, decl) => {
      if (op === 'pick') _assetPickWin = (sender && BrowserWindow.fromWebContents(sender)) || null;
      return assets.handle(pkg, op, args, decl);
    },
    locale: currentLocale(),
    /* 真正碰外界的动作从这里注入 —— commands.js 本身保持在纯 node 下能跑,
       否则那套原语的门禁就只能靠起一个 electron 才测得动。 */
    // 指定 lang 时包成 <lang>, voice-say 按语言挑本机装了的声音(text 里的尖括号 speak 原语已经拒掉了)
    speak: (text, o) => voiceSay.speak(o && o.lang ? `<lang xml:lang="${o.lang}">${text}</lang>` : text)
      .catch((e) => console.error('[cmd/speak]', e && e.message)),
    saveFile: async (filename, content) => {
      // 🔴 存哪儿由**用户在系统保存框里**定。包给不出路径, 所以"悄悄写到某个目录"做不到。
      const r2 = await dialog.showSaveDialog(mainWin, { defaultPath: filename });
      if (r2.canceled || !r2.filePath) return { ok: false, message: '取消了' };
      fs.writeFileSync(r2.filePath, content);
      return { ok: true, path: r2.filePath };
    },
    // 抽屉按"哪个包声明的这条命令"认, 不看参数里写的是谁。
    uiState: (pkgId, key, value) => {
      const st = uiState.create(paths.controlDir());
      const cur = st.read(pkgId);
      const next = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? { ...cur } : {};
      next[key] = value;
      return st.write(pkgId, next);
    },
    // 插件自己的数据库: 连哪个库由 pkgId 认, prepared statement 堵注入。
    db: (pkgId, op, sql, params) => dbConn.runOp(pkgId, op, sql, params),
    // 插件 web 命令的密钥: 按包存在本机钥匙串, 宿主发请求那一刻才取原文, 界面读不到
    pkgSecrets: pkgSecretStore(),
  };
}
let _pkgSecrets = null;
function pkgSecretStore() {
  if (_pkgSecrets) return _pkgSecrets;
  const { PkgSecrets } = require('../core/pkg-secrets');
  const cipher = { available: secrets.available, encrypt: (t) => safeStorage.encryptString(t), decrypt: (b) => safeStorage.decryptString(b) };
  return (_pkgSecrets = new PkgSecrets(path.join(paths.controlDir(), 'pkg-secrets.bin'), cipher));
}
ipcMain.handle('run-command', async (_e, { name, args } = {}) => {
  const r = await commands.run(name, args || {}, commandCtx(_e.sender));
  // 🔴 失败也要通知。原先是 `r.ok && ...` —— 命令失败时 AI 什么都收不到, 于是故障的样子是
  // 「面板不动 + 日志空白 + AI 不知情」, 三头都没有信号。2026-08-25 为此白查了一整轮。
  // 行业版(industry/app/main.js:258)一直是失败也报的, 这里是个人版落后了, 现在对齐。
  return { ...r, notifyAi: commands.notifyAi(name) };
});

/* ── 界面包(沙箱) ──
   一次把装了的都给过去, renderer 画 {{ui:id}} 时本地查 —— 每画一个界面就往回问一趟,
   会在流式重绘时变成一串来回。包的字节本来就都在这台机器上, 没有省的必要。 */
ipcMain.handle('ui-packages', async () => ({ packages: uiPackages.all() }));

/* 沙箱里的包自己要记的东西。**一个包一个抽屉** —— id 由宿主这侧从
   「是哪个包在喊」得来, 不由沙箱在消息里自报, 否则一个包就能去写另一个包的抽屉。 */
ipcMain.handle('ui-state-read', async (_e, { id } = {}) =>
  ({ state: uiState.create(paths.controlDir()).read(id) }));
ipcMain.handle('ui-state-write', async (_e, { id, state } = {}) =>
  uiState.create(paths.controlDir()).write(id, state));

/* 常驻板「已撤下的槽位」黑名单。用户点 ✕ 撤下一个钉住的界面, 下次开窗 loadHistory 重放历史里
   的 {{pin:...}} 印时会把它重新钉回来 —— 这份黑名单让「撤掉」真的记住。**每人格一份**(key=sid),
   板本来就是每人格一块。落盘在 controlDir/board-state.json。 */
const boardStateFile = () => path.join(paths.controlDir(), 'board-state.json');
function readBoardState() {
  try {
    const j = JSON.parse(fs.readFileSync(boardStateFile(), 'utf8'));
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  } catch (_) { return {}; }
}
function writeBoardState(next) {
  try {
    fs.mkdirSync(path.dirname(boardStateFile()), { recursive: true });
    fs.writeFileSync(boardStateFile(), JSON.stringify(next, null, 2), 'utf8');
  } catch (_) {}
}
ipcMain.handle('board-state-read', async (_e, { sid } = {}) => {
  const e = readBoardState()[String(sid || '')];
  return { removed: (e && Array.isArray(e.removed) && e.removed) || [] };
});
ipcMain.handle('board-state-write', async (_e, { sid, removed } = {}) => {
  const all = readBoardState();
  all[String(sid || '')] = { removed: Array.isArray(removed) ? removed : [] };
  writeBoardState(all);
  return { ok: true };
});

// 模型下拉选项 → model-options.js。opt.useApi = 面板上那个人格此刻选的接入方式
// (还没保存也算数, 切了单选就该重拉清单); 缺省 false = 订阅, 清单跟着人格走, 不再有全局开关。
ipcMain.handle('list-model-options', async (_e, opt = {}) => modelOptions.listModelOptions({
  builtin: cfg.json('models/list').options || [],
  access: accessConfig(!!opt.useApi, null, opt.credentialId || ''),   // 换了凭据下拉就该重拉清单
}));

// 历史 sanitize: 老会话里可能落过带 <speak>/<break>/<prosody> 标签的脏文本, 加载时统一剥掉给 UI.
const sanitizeForUi = (m) => (m && m.role === 'assistant' && m.text) ? { ...m, text: stripSsmlTags(m.text) } : m;

// 开窗口只给最近这些条 —— 内存里的 convo 一整程不截断, 会涨到几千条,
// 整包过 IPC 再由渲染层扔掉大半, 是白花的序列化和白造的 DOM。
const OPEN_TAB_MSGS = 400;

ipcMain.handle('get-history', async (_e, { sid, limit } = {}) => {
  const s = sessionFor(sid);
  if (!s) return { messages: [], usage: null, persona: null };
  const n = Number(limit) > 0 ? Number(limit) : OPEN_TAB_MSGS;
  return { messages: s.convo.slice(-n).map(sanitizeForUi), usage: s.butler.usage(), persona: personaOf(s.butler) };
});

// 往上翻: 取比 before(时间戳游标)更早的 limit 条。读日志不碰 convo —— convo 只是本程的尾巴。
// 🔴 游标不用条数, 理由见 chat-store.readHistoryBefore。取不到返回空数组 = 到头了。
ipcMain.handle('history-page', async (_e, { sid, before, limit } = {}) => {
  const s = sessionFor(sid);
  if (!s) return { messages: [] };
  const n = Math.min(Number(limit) > 0 ? Number(limit) : 100, 500);
  const older = store.readHistoryBefore(s.historyDir, Number(before), n);
  return { messages: older.map(sanitizeForUi) };
});

ipcMain.handle('send-message', async (_e, payload = {}) => {
  const s = sessionFor(payload.sid);
  if (!s) return { ok: false, error: '标签无会话' };
  const text = payload.text || '';
  const attachments = payload.attachments || [];
  // #9: 图片类落磁盘, convo 存路径元数据(不存 base64 免撑盘); img:count 保留供老 fallback 兼容
  const imgs = [];
  for (const a of attachments) {
    if ((a.mediaType || '').startsWith('image/')) {
      try { const meta = saveImageAttachment(s.butler.homeDir, a); if (meta) imgs.push(meta); }
      catch (e) { console.error('[#9 saveImage]', e && e.message); }
    }
  }
  const entry = { role: 'user', text, img: attachments.length, ts: Date.now() };
  if (imgs.length) entry.imgs = imgs;
  // 包按钮那条路: 送给模型的是 [命令名] 机器标记, 屏幕上该显示的是人话。两份都要留 ——
  // 只留一份的话, 要么重开窗口后机器标记冒出来, 要么模型这边丢掉了是哪条命令触发的。
  // 🔴 空串是有意义的值(= 不画给人看), 所以判 != null 不判真假 —— 判真假会把它当没传, 于是
  // 落盘里没有 display, 重开窗口 loadHistory 退回去画 text, 机器标记从历史那条路冒回来。
  if (payload.display != null && payload.display !== text) entry.display = payload.display;
  s.convo.push(entry);
  markActivity(s);   // 记录活动 + 清心跳短路 (spec §1.3)
  try { await s.butler.submit(text, attachments); return { ok: true }; }
  catch (e) { return { ok: false, error: String((e && e.stack) || e) }; }
});

// 提醒横幅: 界面要全量 / 人点了按钮。「处理」= 这一次算处置完 + 打开那个人格(切过去), 由界面把这条交给它。
ipcMain.handle('reminders-get', async () => ({ items: reminderCenter.push(true) }));
ipcMain.handle('reminder-act', async (_e, { homeDir, id, action, minutes, until } = {}) => {
  const r = reminderCenter.act({ homeDir, id, action, minutes, until });
  if (!r.ok || action !== 'handle') return r;
  const o = openPersonaByRef(homeDir);
  return o.ok ? { ok: true, sid: o.sid, text: r.item.text } : o;
});

// A2 心跳手动触发 (spec §1.5): 供手动测试与 idle_watcher (v1.1) 调用. 返回 { ok, error? }.
ipcMain.handle('trigger-heartbeat', async (_e, { sid } = {}) => sendHeartbeat(sid));

// #9 图片附件回读: renderer 载历史时点缩略图/初次渲染时 IPC 拿 base64 dataURL. 严格校验路径前缀防穿越+软链.
ipcMain.handle('get-attachment', async (_e, { sid, path: p } = {}) => {
  const s = sessionFor(sid);
  if (!s) return { ok: false, error: '标签无会话' };
  try {
    // path.resolve 自带平台归一化(mac/linux/win 各正确), 尾巴只拼一次 path.sep
    const allowRoot = path.resolve(s.butler.homeDir, 'attachments') + path.sep;
    // 兼容: p 若相对则拼 homeDir(新, 15a057d 后新版); 若绝对则直接 resolve(旧 15a057d 版短期兼容)
    const resolved = path.isAbsolute(p || '') ? path.resolve(p) : path.resolve(s.butler.homeDir, p || '');
    if (!resolved.startsWith(allowRoot)) return { ok: false, error: '路径越界' };
    // 扩展名白名单: 门口挡非图片, 不信任 renderer 传值
    if (!IMG_EXT_ALLOW.has(path.extname(resolved).toLowerCase())) return { ok: false, error: 'unsupported media type' };
    if (!fs.existsSync(resolved)) return { ok: false, error: '文件不存在' };
    // TOCTOU 说明: existsSync↔realpathSync↔readFileSync 之间理论有 race(软链被换).
    // 接受此风险 — 本机同用户信任模型, 攻击面 = 本来就有权做任何事, 无价值攻击.
    // realpath 挡软链穿越 · 精确 try/catch: 并发 rm 抛 ENOENT 不许穿透成 IPC 未处理异常
    let real;
    try { real = fs.realpathSync(resolved); }
    catch (e) { return { ok: false, error: '文件读取失败' }; }
    if (!real.startsWith(allowRoot)) return { ok: false, error: '软链越界' };
    const buf = fs.readFileSync(real);
    return { ok: true, base64: buf.toString('base64') };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// 用户救援: 打断当前跑着的一轮。SDK interrupt() 触发 result subtype='interrupt', 走原有 onResult→onFinal 路径清 busy。
// query stream 不 teardown, 下一轮 submit 复用同一 stream(懒重开——interrupt 后 SDK query 仍能继续接收 new prompt)。
ipcMain.handle('cancel-current', async (_e, { sid } = {}) => {
  const s = sessionFor(sid);
  if (!s || !s.butler) return { ok: false, error: '标签无会话' };
  try {
    voiceSay.stop();   // 用户按取消 → 立刻停当前 TTS + 清剩余队列, 免尾音吵
    const ok = await s.butler.interrupt();
    return { ok };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

ipcMain.handle('compact', async (_e, { sid } = {}) => {
  const s = sessionFor(sid);
  if (!s) return { ok: false, error: '标签无会话' };
  try {
    const r = await s.butler.doClearWithSediment('手动');
    s.convo.push({ role: 'system', text: `🧹 已整理记忆·清空重启${r.droppedUsrMsgs ? ` · 放弃了 ${r.droppedUsrMsgs} 条待处理消息` : ''}`, ts: Date.now() });
    s.persist();
    sendUI('usage', { sid, usage: s.butler.usage() });
    return { ok: true, ...r };
  } catch (e) { return { ok: false, error: String((e && e.stack) || e) }; }
});

// AskUserQuestion 回填: renderer 收 user-dialog 后弹框, 用户答完(或取消)调这个. answer=null → cancelled.
// answer shape (completed): { questions, answers:{qText:optLabel|"a, b"}, response?, annotations? } — 见 SDK AskUserQuestionOutput
ipcMain.handle('answer-user-dialog', async (_e, { sid, dialogId, answer } = {}) => {
  const s = sessionFor(sid);
  if (!s || !s.butler) return { ok: false, error: '标签无会话' };
  const ok = s.butler.resolveDialog(dialogId, answer);
  return { ok };
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

// 右键菜单的"用某某打开": 渲染层只传逻辑名(chrome/vscode), 具体怎么起由这里按平台解析。
// macOS 走 `open -a <app名>`; Windows 没有等价命令, 只能定位 exe 直接 spawn —— 故列已知安装位置,
// 全都不在就是没装(这是 O(3) 次 existsSync, 不是扫盘, 不违反"禁扫盘找二进制")。
const APP_TARGETS = {
  chrome: {
    label: '🌐 用 Chrome 打开',
    mac: 'Google Chrome',
    win: () => [
      `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ],
  },
  vscode: {
    label: '📝 用 VSCode 打开',
    mac: 'Visual Studio Code',
    win: () => [
      `${process.env.LOCALAPPDATA}\\Programs\\Microsoft VS Code\\Code.exe`,
      `${process.env.PROGRAMFILES}\\Microsoft VS Code\\Code.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\Microsoft VS Code\\Code.exe`,
    ],
  },
};

const _openerCache = new Map();
// 这台机器上装没装 → 装了菜单才给, 免得留个点了没反应的死按钮。结果缓存, 每个 app 只探一次。
function resolveOpener(key) {
  if (_openerCache.has(key)) return _openerCache.get(key);
  const t = APP_TARGETS[key];
  let r = null;
  if (t) {
    if (process.platform === 'darwin') {
      // -R = 只解析不打开, 退出码即"装没装"; 走 LaunchServices 数据库, 不碰磁盘遍历
      const { status } = require('child_process').spawnSync('open', ['-Ra', t.mac], { stdio: 'ignore' });
      if (status === 0) r = { kind: 'mac', app: t.mac };
    } else if (process.platform === 'win32') {
      const hit = t.win().find((c) => c && !c.startsWith('undefined') && fs.existsSync(c));
      if (hit) r = { kind: 'win', exe: hit };
    }
  }
  _openerCache.set(key, r);
  return r;
}

// 渲染层建右键菜单前先问一句: 这台机器上哪些"用某某打开"能给。
ipcMain.handle('list-openers', async () => Object.keys(APP_TARGETS)
  .filter((k) => resolveOpener(k))
  .map((k) => ({ key: k, label: APP_TARGETS[k].label })));

ipcMain.handle('open-with-app', async (_e, { path: p, app } = {}) => {
  try {
    if (!p || !app) return { ok: false, error: '缺路径或 app' };
    const abs = path.resolve(p.startsWith('~/') ? path.join(require('os').homedir(), p.slice(2)) : p);
    if (!fs.existsSync(abs)) return { ok: false, error: '路径不存在' };
    const opener = resolveOpener(app);
    if (!opener) return { ok: false, error: `本机没找到 ${app}` };
    const { spawn } = require('child_process');
    const [cmd, args] = opener.kind === 'mac'
      ? ['open', ['-a', opener.app, abs]]
      : [opener.exe, [abs]];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
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
  if (cleanPatch.plugins) {
    next.plugins = { ...(cur.plugins || {}), ...cleanPatch.plugins };
    // 界面交了新的 bus 表, 盘上那三段老配置就该走了 —— 两份并存的下场是有人改了没生效的那一份。
    if (Array.isArray(cleanPatch.plugins.buses)) {
      delete next.plugins.line; delete next.plugins.agent_bus; delete next.plugins.bothub;
    }
  }
  registry.upsert(next);
  let modelSwitch = null;   // 模型热切换结果: null=这次没改模型 · {applied:false}=没切成, 界面要说清
  // 接入方式(订阅↔用key)改了 → 一定要重开这个人格。端点和凭据只活在 env, env 在 spawn 那刻
  // 被子进程读死, SDK 只给了 setModel 没给 setApiKey/setBaseUrl —— 没有热切这条路, 别假装有。
  const accessChanged = (cleanPatch.accessMode !== undefined
      && cleanPatch.accessMode !== (cur.accessMode || 'subscription'))
    // 换凭据同理要重开: base_url 和 key 都只活在 env, spawn 那刻定死
    || (cleanPatch.credentialId !== undefined && cleanPatch.credentialId !== (cur.credentialId || ''))
    // 换 SDK 同理: 建流那刻选定, 跑着的流换不了
    || (cleanPatch.sdk !== undefined && (cleanPatch.sdk || '') !== (cur.sdk || ''));
  // 已打开的 Butler 也同步(wakePhrase 影响下次压缩自愈; name 影响标签显示)
  const sid = sidOf(cur.homeDir);
  const s = sessions.get(sid);
  if (s) {
    if (cleanPatch.name) s.butler.name = cleanPatch.name;
    if (cleanPatch.avatar !== undefined) s.butler.avatar = cleanPatch.avatar || null;
    if (cleanPatch.wakePhrase !== undefined) s.butler.wakePhrase = cleanPatch.wakePhrase;
    if (cleanPatch.isButler !== undefined) s.butler.isButler = !!cleanPatch.isButler;
    // 存进实例但**本轮不生效**: 下次建流(重开人格)时 buildEnv 才读它。写在这儿是为了
    // 万一先发生压缩重建流, 拿到的也是新选择, 而不是又跑回旧的。
    if (cleanPatch.accessMode !== undefined) {
      s.butler.accessMode = cleanPatch.accessMode === 'api' ? 'api' : 'subscription';
    }
    if (cleanPatch.credentialId !== undefined) s.butler.credentialId = cleanPatch.credentialId || '';
    if (cleanPatch.sdk !== undefined) s.butler.sdk = require('../core/agent/util').isSdkKind(cleanPatch.sdk) ? cleanPatch.sdk : '';
    // 模型热切换: SDK 支持运行时改(setModel), 下一轮就生效, 不用关标签重开。
    // 切不动的情况(走网关时模型由网关定死 / 流还没起 / SDK 拒绝)会如实回报, 由界面告诉用户
    // "得重开才生效" —— 不能默默当成功, 否则用户以为换了、实际还在用旧模型烧旧价钱。
    if (cleanPatch.model !== undefined) {
      modelSwitch = await s.butler.setModel(cleanPatch.model || null);
    }
    if (cleanPatch.voice !== undefined) {
      // 热切换 voice: 运行时状态立即生效. 注意: 当前 query 的 systemPrompt 已在建 query 时冻结,
      // 不会因 voice.enabled 变化而重刷 —— 所以变化时 push 一条运行时纠正消息, 让模型当场改口.
      const oldEnabled = !!(s.butler.voice && s.butler.voice.enabled);
      s.butler.voice = { enabled: false, voice: 'Tingting', ...(cleanPatch.voice || {}) };
      const newEnabled = !!s.butler.voice.enabled;
      if (oldEnabled !== newEnabled) {
        const note = newEnabled
          ? '[voice-switch-notice] Voice is now ON. Wrap all responses in <speak>...</speak> and use <break>/<emphasis>/<prosody>/<sub> as needed. UI strips tags for plain text; TTS layer reads SSML.'
          : '[voice-switch-notice] Voice is now OFF. Reply in plain text only; stop writing <speak>/<break>/<emphasis>/<prosody>/<sub> SSML tags (the "voice-on" rule in systemPrompt is void).';
        s.butler.submit(note, undefined, { sourceKind: 'auto' }).catch((e) => console.error('[voice-switch-notice]', e && e.message));
      }
    }
    sendUI('persona-opened', { meta: metaOf(s) });   // 让渲染层刷标签名字
    // 热切换 TG/bothub 插件: 保存新配置后立刻 stop 旧的、new 起新的, 不用关标签重开
    if (cleanPatch.plugins) {
      installPlugins(s).catch((e) => console.error('[hot-reload plugins]', e && e.message));
    }
  }
  broadcastRegistry();
  // needsReopen 只在人格开着时才有意义 —— 没开的下次打开自然就是新配置。
  return { ok: true, modelSwitch, needsReopen: accessChanged && !!s };
});

// 切完接入方式重启这一个人格。端点/凭据只活在 env, spawn 那刻被子进程读死 —— 换掉持有者是唯一的路。
// 🔴 走的是**用户手动会做的那三步**(沉淀 → 关标签 → 重开), 不是在跑的流上 dispose。
//    2026-08-17 23:40 试过后者(set-access 保存即 dispose 掉所有 session), 结果是负收益:
//    它连"重启 App"这条本来可靠的兜底一起弄坏了, 撤回才恢复。别再往那个方向试第二版。
// 代价照实记: 重开 = 新的 SDK 会话(agent.js 那处 resume 恒空), 该人格**在跑的上下文会清空**
//    —— 与重启 App 同一个代价, 不更糟。聊天记录和记忆都在盘上, 不丢。
// 🔴 **改动必须由本接口顺带写盘, 调用方不许先 update-persona 再来调这里。** 顺序是死的:
//    先沉(全套旧配置, 一个字没动) → 拆 → 才写盘 → 重开。
//    先写盘会出两件事: ① update-persona 把新模型 setModel 热切进在跑的会话(下面那个接口就是
//    这么干的) → 沉淀变成拿新模型打旧端点, 必报错; ② 沉一半炸了, 盘上已是新配置、跑的还是旧的。
//    2026-08-18 作者当场点出①: 「这个时候沉淀, 不能用新选的模型啊, 可能就报错了」。
ipcMain.handle('restart-persona', async (_e, { id, patch } = {}) => {
  const entry = registry.get(id);
  if (!entry) return { ok: false, error: '无此人格' };
  const clean = {};
  for (const k of Object.keys(patch || {})) if (patch[k] !== undefined) clean[k] = patch[k];
  const sid = sidOf(entry.homeDir);
  const s = sessions.get(sid);
  // plugins 必须深合并, 口径与 update-persona 一致(那儿注释: "mcp 名单从 cur 保留", blame: 血泪 lost plugins)。
  // 2026-08-18 起保存时的整个 patch 都从这条路走(不只 accessMode), 所以浅覆盖会真的吃掉 mcp 名单。
  const commit = () => {
    const cur = registry.get(id);
    const next = { ...cur, ...clean, id };
    if (clean.plugins) next.plugins = { ...(cur.plugins || {}), ...clean.plugins };
    registry.upsert(next);
    broadcastRegistry();
  };
  if (!s) { commit(); return { ok: true, wasOpen: false }; }   // 没开着 → 下次打开自然就是新配置
  const name = (s.butler && s.butler.name) || '人格';
  // 沉淀必须赶在拆流之前: 它要用大脑, 而且此刻跑的还是**旧**接入方式 —— 那套刚才还是通的。
  // 拆完再沉就没大脑可用了; 沉不下来就别拆也别写盘, 宁可不重启, 不吞掉没沉的活。
  if (s.butler.dirtySinceLastClear && s.butler.sessionId && s.butler._q) {
    if (mainWin) mainWin.webContents.send('sediment', { phase: 'show', personas: [{ sid, name }] });
    const r = await sedimentOne(s, '切换接入方式', SEDIMENT_DEADLINE_MS);
    if (mainWin) {
      mainWin.webContents.send('sediment', { phase: 'progress', sid, status: r.ok ? 'done' : 'error' });
      mainWin.webContents.send('sediment', { phase: 'hide' });
    }
    if (!r.ok) return { ok: false, error: r.error || '沉淀失败' };
  }
  const wasBlocked = !!s.butler._authBlocked;
  if (s.tgPlugin)     { try { await s.tgPlugin.stop();     } catch (_) {} }
  if (s.bothubPlugin) { try { await s.bothubPlugin.stop(); } catch (_) {} }  if (s.channels) { try { await s.channels.stopAll(); } catch (_) {} }
  if (s.linePlugin)   { try { await s.linePlugin.stop();   } catch (_) {} }
  try { await s.butler.dispose(); } catch (_) {}
  sessions.delete(sid);
  commit();                                // 旧会话已经没了, 这才轮到新配置落盘
  const s2 = openPersona(entry.homeDir);   // ensureEntry 重读 registry → 新 accessMode 进 env
  sendUI('persona-opened', { meta: metaOf(s2) });
  // 挂起的是旧会话; 新会话没挂起, 不会再发「解除」—— 横幅得在这里摘, 否则修好了还挂着等下一句
  if (wasBlocked) sendUI('auth-ok', {});
  saveOpenTabs();
  return { ok: true, wasOpen: true };
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

// 🔴 文件对话框必须挂在**发起这次调用的那个窗口**上。macOS 下带父窗的 dialog 是贴着那个窗口的 sheet,
// 挂错窗口时 sheet 会掉到别的窗口上 —— 管理窗在前、sheet 落在后面的主聊天窗, 用户看到的就是
// 「点了导入, 文件框打不开」(2026-08-25 作者实机撞到: 导出完再点导入)。主窗要是隐藏/最小化了更糟,
// sheet 根本没地方显示, 整条 promise 永远不 resolve。`e.sender` 是唯一可靠的来源, 别拿 mainWin 猜。
const dialogParent = (e) => {
  const w = e && e.sender ? BrowserWindow.fromWebContents(e.sender) : null;
  if (w && !w.isDestroyed()) return w;
  return (managerWin && !managerWin.isDestroyed()) ? managerWin : mainWin;
};

// 管理 UI: 把一个人格导出成一个文件(换台机器导进去就还是它)
// 🔴 导出的是【记忆内容】不是【数据库文件】(作者 2026-08-19:「导出人格又不是备份数据库,
//    是把记忆弄出来写个文件」)。所以这里只是一串 SELECT —— WAL 下读不阻塞写, 人格开着照导。
//    不需要关标签(那是拿禁用功能躲并发), 也不需要 VACUUM 快照(那是在错的层级上打补丁)。
ipcMain.handle('export-persona', async (_e, { id } = {}) => {
  const p = registry.get(id);
  if (!p) return { ok: false, error: '无此人格' };
  const sOpen = sessions.get(sidOf(p.homeDir));
  let ownStore = null;
  try {
    // 开着的人格先把会话状态落盘, 这样导出的是"到此刻为止"的它
    if (sOpen) { try { sOpen.persist(); } catch (e) { console.error('[export] persist 失败:', e && e.message); } }
    // 人格开着就用它自己那条连接读; 没开就自己开一个, 用完关掉(别把连接留在那)
    let st = sOpen && sOpen.butler && sOpen.butler.memory && sOpen.butler.memory.store;
    const memoryDir = persona.resolveMemoryDir(p.homeDir);
    if (!st || typeof st.exportGraph !== 'function') {
      st = null;
      if (personaTransfer.hasV2Db(p.homeDir)) {
        const { MemoryStoreV2 } = require('../core/memory-store-v2');
        ownStore = new MemoryStoreV2(memoryDir);
        st = ownStore;
      }
    }
    const extraFiles = {};
    let memory = null;
    if (st) {
      const graph = st.exportGraph();
      // 相对路径从记忆目录推, 不写死 —— 记忆目录挪了位置这里自动跟着对
      const rel = path.join(path.relative(p.homeDir, memoryDir), personaTransfer.MEMORY_EXPORT)
        .split(path.sep).join('/');
      extraFiles[rel] = Buffer.from(JSON.stringify(graph), 'utf8');
      memory = { mode: 'graph', nodes: graph.nodes.length, edges: graph.edges.length,
        pinned: graph.pinned.length, redlines: graph.redlines.length };
    }
    const buf = personaTransfer.packPersona(p.homeDir, p, { butlerVersion: paths.appVersion(), extraFiles, memory });
    const r = await dialog.showSaveDialog(dialogParent(_e), {
      title: '导出人格', defaultPath: personaTransfer.suggestFileName(p.name),
      filters: [{ name: '人格包', extensions: ['butlerpersona'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, buf);
    const { stripped } = personaTransfer.stripCredentials(p);
    return { ok: true, path: r.filePath, size: buf.length, stripped, memory };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  finally { if (ownStore) { try { ownStore.close(); } catch (_) {} } }
});

// 管理 UI: 从文件导入一个人格。导入【必然是新建一个人格】(作者 2026-08-19:「导入肯定是新建
// 人格啊, 本身就是新建才能导入」), 所以不存在往已有人格里合并记忆这条路。
// 🔴 不走 createPersona: 那条路会灌出生礼物(MEMORY.md / persona.md 骨架)并跑一遍出生教育 ——
//    而导进来的人格已经有完整身份和记忆, 再教一次等于把它的自我认知覆盖掉。
//    这里做四件事: 落盘文本 · 新建库灌记忆 · 登记 · 通知界面。
ipcMain.handle('import-persona', async (_e, { targetDir } = {}) => {
  try {
    const r = await dialog.showOpenDialog(dialogParent(_e), {
      title: '导入人格', properties: ['openFile'],
      filters: [{ name: '人格包', extensions: ['butlerpersona'] }],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    const { header, files } = personaTransfer.readPackage(fs.readFileSync(r.filePaths[0]));
    const src = header.persona || {};
    const baseName = String(src.name || '导入的人格').trim() || '导入的人格';
    // 重名不覆盖, 改名并存 —— 用户可能就是想把同一个人格的两个时间点摆在一起对比。
    // 🔴 发号必须【同时避开登记簿和磁盘】。只查登记簿会撞上孤儿目录: 删人格只删了登记项、
    //    或上一次导入中途失败留了半个目录 —— 目录还在磁盘上, 于是算出同一个 id, 落盘时
    //    撞"目标目录非空"卡死, 而且用户再点多少次都是同一个结果(2026-08-19 作者实机撞到)。
    const taken = new Set(registry.list().map((x) => x.id));
    const parent = paths.personasParent();
    let id = registry.slug(baseName), n = 1;
    while (taken.has(id) || fs.existsSync(path.join(parent, id))) {
      n += 1; id = `${registry.slug(baseName)}-${n}`;
    }
    let name = baseName;
    if (n > 1) name = `${baseName} (${n})`;
    // 用户指定了目录就用他的(跟"创建人格"一个口径), 留空才按 id 自动放在 personas/ 下
    const homeDir = path.resolve(String(targetDir || '').trim() || path.join(parent, id)); const bad = firstPersona.rejectInstallRoot(homeDir, paths, currentLocale()); if (bad) return bad;
    personaTransfer.installFiles(files, homeDir);

    // 记忆: 拿【本机 schema】新建一个空库, 把包里的记录灌进去。不是恢复一个数据库文件 ——
    // 所以没有迁移这一步(库天生就是本机版), 也不会跟冷启动抢写锁(灌完就 close)。
    const memRel = [...files.keys()].find((k) => k === personaTransfer.MEMORY_EXPORT
      || k.endsWith(`/${personaTransfer.MEMORY_EXPORT}`));
    let memory = null;
    if (memRel) {
      const { MemoryStoreV2 } = require('../core/memory-store-v2');
      const store = new MemoryStoreV2(path.dirname(path.join(homeDir, memRel)));
      try { memory = store.importGraph(JSON.parse(files.get(memRel).toString('utf8'))); }
      finally { try { store.close(); } catch (_) {} }
      // 记录清单是【传输格式】, 灌进库就没用了。留在人格目录里只会让人以为它是真源。
      try { fs.unlinkSync(path.join(homeDir, memRel)); } catch (_) {}
    }

    const entry = registry.upsert({
      id, name, homeDir,
      avatar: src.avatar || undefined,
      model: src.model || undefined,
      chips: src.chips || undefined,
      plugins: src.plugins || {},
      // 🔴 isButler 一律 false: 管家全局唯一, 导进来就当管家会把本机原本的管家挤掉。
      isButler: false,
      // 导进来的人格没见过本机这一版的能力更新, 让它照常走升级补课(别假装已看过)
      capabilitySeenVersion: '',
    });
    broadcastRegistry();
    return { ok: true, id: entry.id, name: entry.name, homeDir, memory,
      stripped: header.strippedCredentials || [],
      exportedAt: header.exportedAt || '', fromVersion: header.butlerVersion || '' };
  } catch (e) {
    // 🔴 一定要落日志。原先只 return 给界面弹个 toast, 一闪而过 —— 作者 2026-08-19 撞上
    //    导入失败时, 主进程日志里一个字都查不到, 只能靠猜。
    console.error('[import] 导入人格失败:', (e && e.stack) || e);
    return { ok: false, error: String((e && e.message) || e) };
  }
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
ipcMain.handle('choose-directory', async (_e) => {
  const r = await dialog.showOpenDialog(dialogParent(_e), {
    defaultPath: paths.personasParent(), properties: ['openDirectory', 'createDirectory'], title: '选择人格目录',
  });
  return (r.canceled || !r.filePaths || !r.filePaths.length) ? { ok: false } : firstPersona.probeDir(path.resolve(r.filePaths[0]), paths, persona, currentLocale());
});

// 开独立管理窗口(单例; 再点=前置)
ipcMain.handle('open-manager-window', async (_e, { view } = {}) => {   // view: 'create' = 新建视图, 其余 = 人格列表
  if (managerWin && !managerWin.isDestroyed()) { managerWin.webContents.send('manager-view', view === 'create' ? 'create' : 'list'); managerWin.focus(); return { ok: true }; }
  managerWin = new BrowserWindow({
    width: 720, height: 560, title: i18n.uiStrings(currentLocale()).mgr_title, backgroundColor: windowBg(), parent: mainWin, fullscreenable: false,
    // 版本号从这里递进去: preload 跑在沙箱里, 里面 require('./package.json') 会失败(静默落成 '?'), 标题就成了「v?」。
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      additionalArguments: [`--butler-version=${app.getVersion()}`] },
  });
  managerWin.on('closed', () => { managerWin = null; });
  // 管理窗只落日志不转发: 那边没有人格在听。没有这条时渲染层一抛异常就彻底静默 ——
  // 按钮点了没反应而日志一个字都没有, 只能靠猜(2026-08-25 为"导入点不开"白猜了两轮)。
  require('../core/renderer-diagnostics').attachRendererDiagnostics(managerWin, 'manager-win'); require('./window-guard').attachEscClose(managerWin);
  managerWin.loadFile(path.join(__dirname, 'renderer', 'manager.html'), view === 'create' ? { hash: 'create' } : {});
  return { ok: true };
});

// 开独立系统设置窗口(单例; 再点=前置)
ipcMain.handle('open-settings-window', async () => {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return { ok: true }; }
  settingsWin = new BrowserWindow({
    width: 720, height: 640, title: i18n.uiStrings(currentLocale()).sys_title, backgroundColor: windowBg(), parent: mainWin, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      additionalArguments: [`--butler-version=${app.getVersion()}`] },
  });
  settingsWin.on('closed', () => { settingsWin = null; }); require('./window-guard').attachEscClose(settingsWin); require('./window-guard').attachExternalLinks(settingsWin);   // 全屏下红绿灯会隐藏, Esc 是唯一退路
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  return { ok: true };
});

// 沉淀的上限 · sedimentOne · 串行批量: 全在 personal/quit-sediment.js(main.js 已过 500 行上限, 不许再长)
const { SEDIMENT_DEADLINE_MS, sedimentOne, sedimentSerially, noticeAndWait, beginQuit, endQuit, cancelQuit } = require('./quit-sediment');

// 关闭标签: v0.0.22 先沉淀 dirty 手头活 → 再停插件/大脑 (会话文件留盘, 下次可续)。不许关到一个不剩。
ipcMain.handle('close-session', async (_e, { sid } = {}) => {
  const s = sessionFor(sid);
  if (!s) return { ok: false, error: '无此标签' };
  if (sessions.size <= 1) return { ok: false, error: '至少保留一个标签' };
  const name = (s.butler && s.butler.name) || '人格';
  const isDirty = !!(s.butler && s.butler.dirtySinceLastClear && s.butler.sessionId && s.butler._q);
  if (isDirty) {
    if (mainWin) mainWin.webContents.send('sediment', { phase: 'show', personas: [{ sid, name }] });
    const send = (d) => { if (mainWin) mainWin.webContents.send('sediment', d); };
    const r = await sedimentOne(s, '关闭人格', SEDIMENT_DEADLINE_MS);
    send({ phase: 'progress', sid, status: r.ok ? 'done' : 'error' });
    // 只有这一轮真没跑完(超时/抛错)才走到这里 —— 「存没存下东西」已不判(9-23 定)。
    // 跟退出 app 同一个通知, 不用阻塞框: 它后台写完会自己收掉, 用户也能先别关 / 强制关。
    if (!r.ok) {
      const x = { sid, name, s };
      const choice = await noticeAndWait([{ x, r }], send);
      if (choice === 'cancel') { cancelQuit(s); send({ phase: 'hide' }); return { ok: false, error: 'user_cancel' }; }   // 留下就得完整恢复: 摘 shuttingDown(静音由 compact 那边复位)
    }
    send({ phase: 'hide' });
  }
  if (s.tgPlugin)     { try { await s.tgPlugin.stop();     } catch (_) {} }
  if (s.bothubPlugin) { try { await s.bothubPlugin.stop(); } catch (_) {} }  if (s.channels) { try { await s.channels.stopAll(); } catch (_) {} }
  if (s.linePlugin)   { try { await s.linePlugin.stop();   } catch (_) {} }
  try { await s.butler.dispose(); } catch (_) {}
  sessions.delete(sid);
  saveOpenTabs();
  return { ok: true, remaining: [...sessions.keys()] };
});

// ---- 认证失效: 用户点横幅上的"重新登录" ----
// 会开浏览器走 OAuth; 完成后自动重建所有人格的子进程并回放暂存的消息, 不用重启 app。
ipcMain.handle('relogin', async () => {
  try {
    const r = await reloginAndRecover();
    if (r.ok) sendUI('auth-ok', {});
    return r;
  } catch (e) { return { ok: false, error: String(e && e.message) }; }
});

// ---- 语音 STT + 音频落盘 (whisper.cpp 本地 · 引擎/模型按需代下, 不打包) ----
ipcMain.handle('voice-status', async () => voiceStt.detect());

// 首次录音缺引擎/模型时代下代装 (用户确认过才走到这) · 单飞: 重复点只跟同一次安装
let _voiceSetupInflight = null;
ipcMain.handle('voice-setup', async () => {
  if (!_voiceSetupInflight) {
    _voiceSetupInflight = voiceStt.setup((p) => sendUI('voice-setup-progress', p))
      .finally(() => { _voiceSetupInflight = null; });
  }
  return _voiceSetupInflight;
});

ipcMain.handle('transcribe-audio', async (_e, { wavBytes, lang } = {}) => {
  if (!wavBytes) return { ok: false, error: 'no_audio' };
  return voiceStt.transcribe(wavBytes, lang || 'auto');
});

ipcMain.handle('save-audio', async (_e, { sid, wavBytes } = {}) => {
  const s = sessionFor(sid);
  if (!s) return { ok: false, error: 'no_session' };
  if (!wavBytes) return { ok: false, error: 'no_audio' };
  return voiceStt.saveAudio(sid, wavBytes);   // sid = homeDir
});
