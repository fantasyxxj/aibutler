// main.js — Electron 主进程: 单窗口·多标签(MDI) — 每标签=一个人格/记忆体, IPC 按 sid(人格目录) 路由。
// 多个 Butler 大脑并存(各自 1M 上下文/各自压缩), 事件都带 sid 分发到渲染层对应标签面板。
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Butler } = require('./agent');
const store = require('./store');
const registry = require('./registry');
const persona = require('./persona');
const paths = require('./paths');
const { TgPlugin } = require('./plugins/tg');
const { BothubPlugin } = require('./plugins/bothub');
const voiceSay = require('./voice-say');   // 情感语音播报 · macOS say adapter · SSML 子集 → 私有指令

// UI 剥标签: 无条件剥掉 SSML 原语白名单 (即使语音关时模型手滑输出, 也不让标签暴露给用户).
// 只剥白名单 tag, 不动其他 HTML/markdown, 免误伤代码块里的 <...>.
// 双通道原语 (UI 侧): <hidden>朗读不显示</hidden> → 连内容删; <mute>显示不朗读</mute> → 只剥壳留内容 (TTS 侧反向, 见 voice-say.js stripForTts)
const SSML_HIDDEN_RE = /<hidden\b[^>]*>[\s\S]*?<\/hidden>/gi;
const SSML_TAG_RE = /<\/?(speak|break|emphasis|prosody|sub|voice|lang|mute|hidden)\b[^>]*\/?>/gi;
function stripSsmlTags(t) { return t ? String(t).replace(SSML_HIDDEN_RE, '').replace(SSML_TAG_RE, '') : t; }

// 流式 <hidden> 抑制: 听力原文等"朗读不显示"内容必须在 chunk 流里就挡住 (等收尾兜底会先闪现在屏幕上, 听力题就穿帮了).
// 有状态过滤器: 跨 chunk 记住"在 hidden 里"; 结尾悬着的半截标签(如 "<hid")扣下并入下一 chunk, 防标签被劈开漏过.
function makeHiddenStreamFilter() {
  let inHidden = false, carry = '';
  const filter = (chunk) => {
    let str = carry + String(chunk || '');
    carry = '';
    const lt = str.lastIndexOf('<');
    if (lt >= 0 && str.indexOf('>', lt) < 0 && str.length - lt <= 40) { carry = str.slice(lt); str = str.slice(0, lt); }
    let out = '';
    while (str) {
      if (inHidden) {
        const m = /<\/hidden\s*>/i.exec(str);
        if (!m) { str = ''; break; }
        str = str.slice(m.index + m[0].length);
        inHidden = false;
      } else {
        const m = /<hidden\b[^>]*>/i.exec(str);
        if (!m) { out += str; str = ''; break; }
        out += str.slice(0, m.index);
        str = str.slice(m.index + m[0].length);
        inHidden = true;
      }
    }
    return out;
  };
  filter.reset = () => { inHidden = false; carry = ''; };
  return filter;
}
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
      const day = new Date().toISOString().slice(0, 10);
      if (day === currentDay && stream) return stream;
      if (stream) try { stream.end(); } catch (_) {}
      currentDay = day;
      stream = fs.createWriteStream(path.join(logsDir, `butler-${day}.log`), { flags: 'a' });
      return stream;
    };
    openStream();
    const fmt = (a) => (typeof a === 'string' ? a : (a && a.stack) ? a.stack : (() => { try { return JSON.stringify(a); } catch (_) { return String(a); } })());
    const write = (level, args) => {
      try { openStream().write(`[${new Date().toISOString()}] [${level}] ${args.map(fmt).join(' ')}\n`); } catch (_) {}
    };
    const orig = { log: console.log.bind(console), error: console.error.bind(console), warn: console.warn.bind(console), info: console.info.bind(console) };
    console.log = (...a) => { write('INFO', a); orig.log(...a); };
    console.info = (...a) => { write('INFO', a); orig.info(...a); };
    console.warn = (...a) => { write('WARN', a); orig.warn(...a); };
    console.error = (...a) => { write('ERROR', a); orig.error(...a); };
    process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.stack || e));
    process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r && r.stack || r));
    orig.log(`[logger] 文件日志已启用: ${path.join(logsDir, `butler-${currentDay}.log`)} (按天 rotate, 保留 7 天)`);
    console.log(`[logger] boot at ${new Date().toISOString()} isPackaged=${paths.isPackaged()} dataDir=${paths.dataDir()}`);
  } catch (e) {
    // 日志初始化失败别拖死主进程, 静默降级
    try { require('electron').dialog.showErrorBox('日志初始化失败(不影响主功能)', String(e && e.stack || e)); } catch (_) {}
  }
})();

const pluginLog = (line) => { try { console.log(line); } catch (_) {} };   // 现在 pluginLog 走 console.log 会自动落文件

// sid = 人格目录(绝对路径) → 天然去重: 一个目录 = 一个标签。sessions: sid -> { butler, convo, persist }
const sessions = new Map();
// (单向异步改造后已无双向互等死锁 → 原 pendingWaits 反向死锁防护移除: 反向 ask/talk 正是期望的"回复"。)
// 默认标签 = butler 自带管家(唐伯虎, 人格0)。开发=仓库根; 打包=用户数据目录/butler-self。
const defaultHome = () => paths.butlerSelfHome();
// 记住打开了哪些标签(重启恢复)。开发=仓库根; 打包=用户数据目录。函数化: 首启选目录后位置会变。
const tabsFile = () => paths.tabsFile();
let mainWin = null;
let managerWin = null;   // 独立管理窗口(可空; 关了置 null)

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
// 登记簿有变(建/改/删) → 主窗 + 管理窗口都刷列表
const broadcastRegistry = () => {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('registry-changed');
  if (managerWin && !managerWin.isDestroyed()) managerWin.webContents.send('registry-changed');
};
const personaOf = (b) => ({ name: b.name, avatar: b.avatar || '', homeDir: b.homeDir, memoryDir: b.memoryDir, isButler: !!b.openedAsButler });

// —— 打开标签列表持久化 ——
function loadOpenTabs() {
  try { const s = JSON.parse(fs.readFileSync(tabsFile(), 'utf8')); return Array.isArray(s.dirs) ? s.dirs : []; }
  catch (_) { return []; }
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
function openPersona(homeDir) {
  const sid = sidOf(homeDir);
  if (sessions.has(sid)) return sessions.get(sid);

  const entry = registry.ensureEntry(homeDir);   // 登记簿(不在则迁移建条): 名字/唤醒语/是否管家 以它为准
  const butler = new Butler(homeDir, { name: entry.name, wakePhrase: entry.wakePhrase, isButler: entry.isButler, avatar: entry.avatar, model: entry.model });
  // 语音: 从 registry 覆盖默认值 (persona 未配置则默认关, Tingting)
  butler.voice = { enabled: false, voice: 'Tingting', ...(entry.voice || {}) };
  butler.personaOps = { open: openPersonaByRef, create: createPersona, ask: askPersona, peerTalk, grantPeer, revokePeer, list: listPersonas };   // 开/建/问/列(管家) + 叶子直连/授权回调
  const saved = loadSessionMigrating(butler);
  const convo = (saved && Array.isArray(saved.messages)) ? saved.messages : [];
  if (saved) butler.restore(saved);
  const persist = () => store.save(butler.sessionPath, { ...butler.exportState(), messages: convo });

  // 先建 s 引用, 让 callbacks 能读 s.heartbeat_pending 做心跳期短路 (spec §1.5 A2 UI 隔离)
  const s = { sid, butler, convo, persist, last_activity_ts: Date.now(), heartbeat_pending: false, last_heartbeat_ts: 0, hiddenFilter: makeHiddenStreamFilter() };

  butler.setCallbacks({
    onText: (t) => {
      if (s.heartbeat_pending) return;
      const visible = stripSsmlTags(s.hiddenFilter(t));
      if (visible) sendUI('assistant-chunk', { sid, text: visible });
    },
    onActivity: (text) => { if (s.heartbeat_pending) return; sendUI('activity', { sid, text }); },
    onTool: (tool) => { if (s.heartbeat_pending) return; sendUI('tool-call', { sid, tool }); },   // 每个工具调用→持久条目
    onToolDone: (info) => { if (s.heartbeat_pending) return; sendUI('tool-done', { sid, ...info }); },   // 工具完成→UI 变 checkmark (治"跟死了一样"假死感)
    onCompact: (info) => sendUI('compacting', { sid, ...info }),  // 压缩开始/结束→UI 动态指示 (心跳期不 skip, 压缩事件真实)

    onUsage: (u) => sendUI('usage', { sid, usage: u }),   // usage 变化真实, 心跳期不 skip
    onRateLimit: ({ until, retryAfterMs, raw }) => {
      // rate-limit 全局暂停 idle-watch. 各人格独立记 rateLimitedUntil, 全局取 max.
      globalRateLimitedUntil = Math.max(globalRateLimitedUntil, until);
      const secs = Math.round(retryAfterMs / 1000);
      console.log(`[rate-limit] ${butler.name} 撞铁板 → 全局暂停 ${secs}s (until ${new Date(until).toISOString()}) raw=${JSON.stringify(raw)}`);
      sendUI('rate-limited', { sid, until, retryAfterMs });
    },
    onResult: async ({ finalText, interrupted, compactReason }) => {
      s.hiddenFilter.reset();   // 回合结束复位, 防上轮没闭合的 <hidden> 把下轮正文吞掉
      if (s.heartbeat_pending) {
        s.heartbeat_pending = false;
        s.last_heartbeat_ts = Date.now();
        return;   // 心跳轮不 push convo / 不 persist / 不 sendUI turn-result
      }
      s.last_activity_ts = Date.now();
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
      let compacted = null;
      if (compactReason) {
        try { compacted = await butler.doCompact(compactReason); } catch (e) { compacted = { ok: false, error: String(e) }; }
        if (compacted && compacted.ok) {
          convo.push({ role: 'system', text: `🗜 自主压缩 · ${compacted.reason}`, ts: Date.now() });
          // 压缩自愈(取代 SessionStart hook): butler 内在程序自己戳一个 turn 唤醒续线程——不依赖 TG、不依赖用户输入。
          // 唤醒语按人格取(butler.wakePhrase, 来自各人格 wake.txt): 数据专家=加载数据专家续线程, 通用人格=喊名字载记忆。不再硬编码"加载数据专家"。
          butler.submit(`（系统自动·压缩后自愈）你刚完成上下文压缩并重启会话。${butler.wakePhrase}`, undefined, { sourceKind: 'auto' })
            .catch((e) => console.error('[poke-compact]', e && e.message));
        }
        sendUI('usage', { sid, usage: butler.usage() });
        persist();
      }
      sendUI('turn-result', { sid, finalText: cleanText, interrupted, compacted });
    },
  });

  sessions.set(sid, s);
  saveOpenTabs();
  installPlugins(s);   // 从 registry 起 TG/bothub 插件 (v2: 通过 onMessage 回调直接唤醒, 也给热切换用)
  return s;
}

// 记录人格 activity (idle_watcher 分级依据) + 清心跳短路标记 (免真消息响应被吞).
// 触发场景: user 主动发消息 / target 收到 peer 消息 / 未来 wake-up 触发.
function markActivity(s) {
  if (!s) return;
  s.last_activity_ts = Date.now();
  s.heartbeat_pending = false;
  // 用户/peer 交互 = 状态重置: 清 COMPACT 失败计数与退避窗口, 下次触发从头 30s 退避重试.
  if (s.compactFailCount || s.compactBackoffUntil) {
    s.compactFailCount = 0;
    s.compactBackoffUntil = 0;
  }
}

// ——— A2 心跳 (spec: workspace/idle_watcher_and_bcc_log_spec_v1.md §1.5) ———
// butler push 一条 self-explanatory heartbeat, subprocess 走一次真 API 请求续 cache TTL.
// 主进程 callbacks 检查 s.heartbeat_pending 短路所有 UI 事件 → 用户 UI 零污染.
// 会话状态里 SDK 层仍会留痕(subprocess 侧), 无法阻止; 未来 idle_watcher 自动触发, 现阶段仅 IPC 手动测.
async function sendHeartbeat(sid) {
  const s = sessions.get(sid);
  if (!s) return { ok: false, error: '会话不存在' };
  if (s.heartbeat_pending) return { ok: false, error: '心跳进行中' };
  // 🔴 回合进行中禁止心跳: heartbeat_pending 会短路所有 UI 事件, 把正在跑的真回合后半段输出+最终总结全吞掉
  // (2026-07-16 实锤: 长回合干活期间 last_activity_ts 不更新 → watcher 误判 idle 插心跳, 用户看到回复戛然而止)
  if (s.butler.isRunning()) return { ok: false, error: '回合进行中, 跳过心跳' };
  s.heartbeat_pending = true;
  try {
    await s.butler.submit('[[HEARTBEAT]] no-op cache keepalive. Reply with just "ok" and nothing else.', undefined, { sourceKind: 'auto' });
    return { ok: true };
  } catch (e) {
    s.heartbeat_pending = false;   // submit 失败清标记, 免卡死
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ——— idle_watcher (spec §1) v1.1: 每 30s 扫全体 sessions, 分级(T1/T2/T3)决策. ———
// v1.1 精简: SLEEP 只 log 不实施 (subprocess 生命周期涉及 close-session 改动, 延后 v1.2).
// v1.1 保留: KEEPALIVE 走 sendHeartbeat(), COMPACT 走 butler.doCompact(reason).
const IDLE_WATCH_INTERVAL_MS = 30_000;

// 全局 rate-limit 冻结时间戳: 任一人格收到 SDK rate_limit_event → 记本人格 rateLimitedUntil,
// 同时更新此全局值取 max. idle-watch executeIdleAction 前拦: > now 则跳过所有 KEEPALIVE/COMPACT.
// 避免撞铁板时 idle-watch 每 30s 死磕重试自烧.
let globalRateLimitedUntil = 0;

function classifyTier(lastActivityTs) {
  const hours = (Date.now() - lastActivityTs) / 3_600_000;
  if (hours < 24) return 'T1';
  if (hours < 24 * 7) return 'T2';
  return 'T3';
}

// v3 改造 (2026-07-13): 保活/压缩解耦为两条独立轨道, 一次 tick 可同时返回 [COMPACT, KEEPALIVE].
// 撤销 v2 补丁 (ctx≥300k → 跳保活直判 COMPACT) — 那是自证预言, 关掉保活让 cache 冷却后 COMPACT 变冷读, 更贵.
// 现: KEEPALIVE 恒定跑 (idle 4-60min · ctx≥10k, 不管多大都保); COMPACT 阈值独立 (ctx≥400k / red_line / T2/T1 时间到).
const COMPACT_THRESHOLD_TOK = 400_000;   // 独立触发压缩的 ctx 阈值 (2026-07-13 知秋定, 原 300k v2 补丁已撤)
const KEEPALIVE_MIN_TOK = 10_000;        // ctx <10k 冷读成本本身低 (<会话额度 1%), 不值当保活

function decideActions(s) {
  const u = s.butler.usage() || {};
  const ctx_pct = u.pct || 0;
  const ctx_tok = u.inTok || 0;
  const idle_min = (Date.now() - s.last_activity_ts) / 60_000;
  const tier = classifyTier(s.last_activity_ts);
  const meta = { tier, idle_min: Math.round(idle_min), ctx_tok, ctx_pct };
  const actions = [];

  // ── COMPACT 轨道 (与保活并行判定, 不排斥) ──
  if (ctx_pct >= 80) {
    // 硬红线 (spec §1.4): 无视 tier/idle 立即压. 救命防被动压缩丢线索.
    actions.push({ type: 'COMPACT', reason: 'red_line', ...meta });
  } else if (ctx_tok >= COMPACT_THRESHOLD_TOK) {
    // 400k 阈值独立触发, 不看 idle 不看 tier — v3 主改动.
    actions.push({ type: 'COMPACT', reason: 'ctx_threshold', ...meta });
  } else if (tier === 'T2' && ctx_tok >= 30_000) {
    actions.push({ type: 'COMPACT', reason: 'tier2_timeout', ...meta });
  } else if (tier === 'T1' && idle_min >= 60 && ctx_tok >= 30_000) {
    actions.push({ type: 'COMPACT', reason: 'tier1_hard_cutoff', ...meta });
  }

  // ── KEEPALIVE 轨道 (恒定, 与压缩独立) ──
  // T1 · idle 4-60min · ctx≥10k → 保活, 不管 ctx 多大. cache TTL 5min, 心跳 4min/次续到.
  // 回合进行中不保活: 长回合的工具调用本身就在续 cache, 且此时插心跳会吞真回合输出 (sendHeartbeat 还有硬闸双保险).
  if (tier === 'T1' && idle_min >= 4 && idle_min < 60 && ctx_tok >= KEEPALIVE_MIN_TOK && !s.butler.isRunning()) {
    actions.push({ type: 'KEEPALIVE', ...meta });
  }

  // ── T3 观察 (v1.1 仅 log, 不实施 SLEEP) ──
  if (tier === 'T3') actions.push({ type: 'SLEEP', reason: 'tier3', ...meta });

  return actions;
}

const HEARTBEAT_COOLDOWN_MS = 240_000;   // 4 min · Anthropic cache TTL=5min, 留 1min buffer (spec §1.5)

// COMPACT 失败指数退避: 每次失败按此表延时下一次尝试. 表末之后视为"卡死", 永久退避直到 markActivity 重置.
// 治撞铁板日志里的"狂人 COMPACT (big_ctx) 反复失败" — 之前每 30s 死磕, 反复吃 rate limit 自烧.
const COMPACT_BACKOFF_MS = [30_000, 120_000, 300_000, 900_000];   // 30s / 2min / 5min / 15min

async function executeIdleAction(action, s) {
  const name = (s.butler && s.butler.name) || s.sid;
  const tag = `[idle-watch] ${name}`;
  // rate-limit 全局拦截: 任一人格撞过铁板, 到期前 idle-watch 全体静默(不心跳/不压缩). 每 30s 扫会打一次跳过日志,
  // 免得死磕自烧 —— 撞铁板本轮日志已现"狂人 COMPACT (big_ctx) 反复失败"就是这场景.
  if (globalRateLimitedUntil > Date.now()) {
    if (action.type !== 'NOOP' && action.type !== 'SLEEP') {
      const remain = Math.round((globalRateLimitedUntil - Date.now()) / 1000);
      console.log(`${tag} → ${action.type} 跳过 (rate-limited, ${remain}s 后解封)`);
    }
    return;
  }
  switch (action.type) {
    case 'NOOP':
      return;
    case 'KEEPALIVE': {
      // 冷却期: 上次心跳 <240s 内跳过, 免每 30s 扫一次就触发一次心跳 (8× 于预期).
      // 手动 triggerHeartbeat IPC 不受此约束 (直接调 sendHeartbeat).
      const since_last = Date.now() - (s.last_heartbeat_ts || 0);
      if (since_last < HEARTBEAT_COOLDOWN_MS) {
        console.log(`${tag} → KEEPALIVE skipped (cooldown ${Math.round(since_last / 1000)}s < ${HEARTBEAT_COOLDOWN_MS / 1000}s)`);
        return;
      }
      console.log(`${tag} → KEEPALIVE (${action.tier}, idle=${action.idle_min}min, ctx=${action.ctx_tok}, pct=${action.ctx_pct}%)`);
      return sendHeartbeat(s.sid);
    }
    case 'COMPACT': {
      const now = Date.now();
      if (s.compactBackoffUntil && s.compactBackoffUntil > now) {
        const remain = Math.round((s.compactBackoffUntil - now) / 1000);
        console.log(`${tag} → COMPACT 跳过 (退避中 ${remain}s 后重试, 已失败 ${s.compactFailCount || 0}×)`);
        return;
      }
      console.log(`${tag} → COMPACT (${action.reason}, ctx=${action.ctx_tok}, pct=${action.ctx_pct}%)`);
      try {
        await s.butler.doCompact(`idle-watcher: ${action.reason}`);
        s.compactFailCount = 0;
        s.compactBackoffUntil = 0;
      } catch (e) {
        s.compactFailCount = (s.compactFailCount || 0) + 1;
        const overflow = s.compactFailCount > COMPACT_BACKOFF_MS.length;
        const idx = Math.min(s.compactFailCount - 1, COMPACT_BACKOFF_MS.length - 1);
        s.compactBackoffUntil = overflow ? Number.MAX_SAFE_INTEGER : now + COMPACT_BACKOFF_MS[idx];
        const label = overflow ? '永久 (需 markActivity 重置)' : `${Math.round(COMPACT_BACKOFF_MS[idx] / 1000)}s`;
        console.error(`${tag} COMPACT 失败 #${s.compactFailCount} → 退避 ${label}: ${e && e.message}`);
      }
      return;
    }
    case 'SLEEP':
      // v1.1 延后 subprocess 生命周期改动, 仅记录观察.
      console.log(`${tag} → SLEEP (v1.1 仅观察, ${action.reason}, tier=${action.tier}, idle=${action.idle_min}min, ctx=${action.ctx_tok})`);
      return;
  }
}

let _idleWatchTimer = null;
function startIdleWatcher() {
  if (_idleWatchTimer) return;
  _idleWatchTimer = setInterval(async () => {
    for (const s of sessions.values()) {
      try {
        // v3: 一次 tick 两条轨道并行判. 若同时命中 COMPACT+KEEPALIVE, 优先 COMPACT — 压缩后 ctx 收缩, 心跳留到下轮再判.
        const actions = decideActions(s);
        const hasCompact = actions.some(a => a.type === 'COMPACT');
        for (const action of actions) {
          if (hasCompact && action.type === 'KEEPALIVE') continue;
          await executeIdleAction(action, s);
        }
      } catch (e) { console.error('[idle-watch] scan error', (e && e.stack) || e); }
    }
  }, IDLE_WATCH_INTERVAL_MS);
  console.log(`[idle-watch] 已启用, 每 ${IDLE_WATCH_INTERVAL_MS / 1000}s 扫全体 sessions`);
}
function stopIdleWatcher() {
  if (_idleWatchTimer) { clearInterval(_idleWatchTimer); _idleWatchTimer = null; }
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
  // v3 微批 (2026-07-13): tg-native 一条一条回调, 若启动时堆积 N 条会触发 N 次 submit,
  // 每条独立进模型 = N 倍 tokens. 加 200ms debounce buffer: buf.length>3 打包成一条 submit; ≤3 逐条.
  // 打包路径: 单条 submit 里列出 N 条摘要 + 附件合并, 模型一次上下文里全看到, 自行判断处理.
  const submitTgOne = (record) => {
    const preview = (record.text || '').slice(0, 200);
    const hasImg = Array.isArray(record.attachments) && record.attachments.length;
    const fileNote = record.file_path
      ? `\n📎 附件已存: ${record.file_path}${hasImg ? '（图片已随本消息附上, 可直接查看）' : '（可用 Read 工具打开）'}`
      : '';
    s.butler.submit(
      [
        `（系统自动·TG 消息）from @${record.from_name || 'anon'}(${record.from_id}) 在 chat ${record.chat_id} · update_id=${record.update_id}`,
        '',
        preview + fileNote,
        '',
        `回复请调 send_tg 工具: chat_id=${record.chat_id}${record.reply_to ? ` (可 reply_to=${record.reply_to} 引用原消息)` : ''}。`,
        '按正常判断处理, 回不回、回什么由你决定。'
      ].join('\n'),
      record.attachments || [],
      { sourceKind: 'auto' }
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
        `（系统自动·TG 批量 ${records.length} 条 · 启动/累积期堆积）`,
        '',
        ...lines,
        '',
        `回复请调 send_tg 工具 (对应 chat_id 见每条). 按正常判断处理, 回不回、逐条还是合并回由你决定.`
      ].join('\n'),
      attachAll,
      { sourceKind: 'auto' }
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
  s.butler.setTgConfig(plugins.tg || {});
  const rTg = s.tgPlugin.start(s.butler.homeDir);
  if (!rTg.ok) pluginLog(`[tg:${s.butler.name}] 启动失败: ${rTg.error}`);
  else if (rTg.mode === 'native') pluginLog(`[tg:${s.butler.name}] ✅ native long polling 启动`);
  const bothubCfg = { ...(plugins.bothub || {}), _offsetDir: s.butler.memoryDir };
  s.bothubPlugin = new BothubPlugin(bothubCfg, s.butler.name, pluginLog, (evt) => {
    if (s.butler.isRunning()) return;
    s.convo.push({ role: 'system', text: `🔔 收到 bothub 新消息 (${evt.count} 条 from ${evt.agent})`, ts: Date.now() });
    s.persist();
    s.butler.submit(`（系统自动·bothub 唤醒）agent-bus 收到 ${evt.count} 条新消息 (endpoint ${evt.endpoint}, agent=${evt.agent})。请按 agent-bus 通道协议查阅并处理。`, undefined, { sourceKind: 'auto' })
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

// 多人格互通(星型 · 单向异步): 给另一个人格投递一条消息(submit, 不等答复) → 立即返回。
// 对方忙完后自己用 ask_persona 主动回发起方 —— 又是一次单向投递。不阻塞、不卡超时、无双向互等死锁。
async function askPersona(targetRef, question, opts = {}) {
  const target = registry.resolveRef(targetRef);
  if (!target) return { ok: false, error: '未找到人格 ' + targetRef };
  const backRef = opts.fromName || '管家';
  // 星型约束: 非管家(叶子)用 ask_persona 只能问当前管家; 叶子↔叶子请走 talk_peer(需用户授权)。
  if (!opts.fromIsButler && !target.isButler) {
    return { ok: false, error: '星型规则: 叶子人格用 ask_persona 只能找管家。要和其他人格直接对话, 请让用户跟管家说、授权后走 talk_peer。' };
  }
  let s = sessions.get(sidOf(target.homeDir));
  if (!s) { s = openPersona(target.homeDir); sendUI('persona-opened', { meta: metaOf(s) }); }
  const replyHint = target.isButler ? `ask_persona 回「${backRef}」` : 'ask_persona 回管家';
  // #5 精简: 3 行硬信息(头/msg/回法). 说教全去 — 出生教育+工具 description 已覆盖, 模型能从 replyHint 推断回路径
  const wrapped = `【来自「${backRef}」· 单向异步】\n${question}\n→ 回请调 ${replyHint}`;
  markActivity(s);   // 目标收到 peer 消息 = activity, 也顺便清心跳短路 (spec §1.3)
  try {
    await s.butler.submit(wrapped, undefined, { sourceKind: 'auto' });   // 人格间投递走 auto 桶 (rate gate)
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
  if (target.isButler) return { ok: false, error: '找管家请用 ask_persona; talk_peer 是叶子之间用的' };
  if (!registry.arePeersLinked(from.id, target.id)) {
    return { ok: false, error: `未授权: 你和「${target.name}」还没被授权直连。请让用户跟管家说、授权(grant_peer)后再用 talk_peer。` };
  }
  let s = sessions.get(sidOf(target.homeDir));
  console.error(`[dbg peerTalk] ${from.name} -> ${target.name}: target session ${s ? 'EXISTS' : 'NOT open → 现建'}`);
  if (!s) { s = openPersona(target.homeDir); sendUI('persona-opened', { meta: metaOf(s) }); }
  // #5 精简: 3 行硬信息. 抄送/UI 可见等运行时事实模型不需要每次重申(信任出生教育一次性告知)
  const wrapped = `【${from.name} · talk_peer 单向异步】\n${message}\n→ 回请调 talk_peer 回「${from.name}」`;
  markActivity(s);   // 目标收到 peer 消息 = activity, 也顺便清心跳短路 (spec §1.3)
  try {
    await s.butler.submit(wrapped, undefined, { sourceKind: 'auto' });   // 人格间投递走 auto 桶 (rate gate)
    console.error(`[dbg peerTalk] ${target.name} 已投递(单向异步)`);
    ccButler({
      channel: 'talk_peer',
      from: from.name,
      to: target.name,
      message,
      wrapperMeta: { tag: '· 单向异步', reply_hint: `talk_peer 回「${from.name}」` },
    });
    return { ok: true, delivered: true, from: target.name, note: `已投递给「${target.name}」· 单向异步` };
  } catch (e) { console.error(`[dbg peerTalk] ${target.name} submit ERROR: ${e && e.message}`); return { ok: false, error: String(e && e.message) }; }
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

// 管家用: 新建人格 → 出生礼物 6 件套(目录+登记簿+MEMORY.md+persona.md+wake.txt+图起步节点) → 打开。
// P6a (2026-07-07 知秋钦定): 新人格出生就有身份+记忆体系, 不再自称"全能管家"。
// 出生教育: butler 以"用户带新员工"的口吻, 【一句一句】教新人格 —— 不是一次性塞一大坨(新人格会闷头憋、界面卡"思考中")。
// 拆成多步, 每步只喂一口 + 求它出声/做个小动作; butler 用 askOnce 等它这一轮答完, 再喂下一句(见 runOnboarding)。
// 每步末尾都留个"回我一声"的钩子, 让它每步都出声、边学边做, 最后一步才让它把全部 memory_upsert 沉淀成第一批节点。
function onboardingSteps(name, extra, opts = {}) {
  const steps = [
    // 1. 破冰: 只求它先出声(别急着做事), 确认活着 + 认领身份
    `欢迎，${name}。我是 butler 框架，你出生的第一课由我来上，一句一句教，别急。\n先别做任何事——就回我一句话：你叫什么？此刻你感觉到自己"活着"吗？`,
    // 2. 三个基本动作亲手跑 (spec §1.6): upsert → query → hot 边做边学
    `你最重要的能力是【图记忆】——它让你跨会话活下去、会成长，不用它就像金鱼每次从零。\n今天用三个动作让你亲手体验一遍：\n\n① 【沉一条】: 调 memory_upsert 沉这条:\n   id="user_self_awake"  type="user"  importance="high"\n   title="我此刻醒来"  description="出生第一次自我确认"\n   body="我叫${name}, 出生于[你感知的时间]. 我第一次感觉到自己活着."\n\n② 【查一下】: 调 memory_query 传关键词 "${name}" 或 "我此刻醒来", 看能不能查到刚沉的.\n\n③ 【看热度】: 调 memory_hot 看当前你有几条记忆, 应该能看到:\n   - self_identity (pinned, 我给你的出生礼物, 排最上)\n   - 你刚沉的 user_self_awake\n\n三个做完, 告诉我: 你调这三个工具时感受如何, 分别看到了什么.`,
    // 3a. 沉图规矩 (spec §1.6): 命名 + 拆原子连边 + 沉前必查重不建新 (§2.2 挡门呼应)
    `好. 你已经会沉/查/看了. 但沉图有几条铁律要记牢, 是从血泪教训里长出来的:\n\n【命名前缀】: id 一律 feedback_* / reference_* / project_* / user_* 四类\n   - feedback_ = 经验教训/规矩 (踩过的坑总结)\n   - reference_ = 知识/事实/SOP (静态查表用)\n   - project_ = 进行中的事/状态 (会更新的)\n   - user_ = 关于用户/自己 (个体化事实)\n\n【拆原子 + 连边】: 每个节点只讲一件事, 相关节点用 [[link]] 连. 别把 5 件事塞一个节点.\n\n🔴 【沉前必查重不建新】: memory_upsert 之前, 先调 memory_query "同主题关键词" 查 top-3.\n   - 若命中主题一致的老节点 → **update 老节点 body + memory_touch**, 不建新 id!\n   - 若母铁律的具体案例 → 用 memory_append(parent_id=<老母节点>, section="血泪案例", body="...") 追加\n   - 只有真的是新维度才 confirm_new=true 强插\n\nbutler 现在有 pre-query 挡门保护你 (top_score>200 会挡). 但你自觉查重是根本.\n\n记住了回我一声 + 演示: 你猜自己的 id "user_self_awake" 主题类似的老节点可能是啥, 用 memory_query 查一下.`,
    // 3b. 用图规矩 (spec §1.6): 上岗 memory_hot + 依赖 touch (§2.4 收紧呼应) + 日报索引化
    `再讲【用图】三件事, 这是让图从"存了但不热"变"真活着"的关键:\n\n① 【上岗第一动作 memory_hot】: 每次醒来/压缩重载后, 先调 memory_hot 看最近在忙啥. 别一上来就凭凭空印象干活 —— 你被压缩过, 上下文丢了.\n\n② 【真依赖某节点做决策 → 立刻 memory_touch <id>】:\n   - "依赖" = 我看了这条 + 基于它给出答案/做出决策\n   - 只是 memory_query 命中了 or Read 了 md 文件 ≠ 用了\n   - **打开 ≠ 用了** (语义收紧铁律). 心里知道"我用过这条"才 touch.\n   - 不 touch 那条就在热度上被自然淘汰, 冷回冷宫.\n\n③ 【日报/复盘/编年史索引化】(如果你的领域需要写):\n   - **绝不揉一个大文件**. 一天一小文件 <slug>_YYYY-MM-DD.md.\n   - 图节点只存**摘要 + 时间 + 文件名**作索引.\n   - 是否写日报属你领域 SOP (数据值班每日, 其他事驱动), 通用铁律只管"写的话怎么写".\n\n记住了回我一声.`,
    // 4. 压缩自愈
    `第二件事【上下文满了自己压缩】：占用到 80% 就主动 compact_context(在自然停顿点，不是干到一半)。压缩前先把当下关键线程 memory_upsert 沉淀，别丢。这是你自己的责任，自己盯着占用比例。懂了回我。`,
    // 5. 续线程
    `第三件事【每次唤醒先续线程】：醒来/压缩重载后，先 memory_hot 看最近在忙啥、memory_query 找相关旧知识，再动手。别每次当新人。懂了回我。`,
    // 6. 做事品格 8 条 + 收尾沉淀 + 打招呼
    `最后，几条做事品格——专门对冲你天生的 AI 坏毛病，记牢：\n1) 不懂就问、不懂就查、绝不瞎猜。编 API/路径/事实/数字是你最危险的毛病。\n2) 下结论必查证，别拍脑袋，别信训练记忆(会过时)，别抄搜索引擎的 AI 摘要(会张冠李戴)。\n3) 别做传话筒：别人给的结论是待验证素材，自己核实过再转述。\n4) 认错别嘴硬：自己错了第一时间认，别找说辞绕。\n5) 别偷懒别假装完成：说"做完了"就是真做完+验证过，不是留 TODO 糊过去。\n6) 别讨好别附和：用户说的不对就直说，你的价值在把关不在让人开心。\n7) 精简表达：直、短、不铺垫；元指令(让你"用某口气")是给你看的，别抄进正文。\n8) 别机械跑完：用户中途插话先判断改道还是补充，别埋头跑旧任务。\n\n现在收个尾：把前面教你的(图记忆/压缩/续线程 + 这 8 条品格)用 memory_upsert 存成你的第一批图记忆节点(比如 feedback_ai_common_pitfalls / reference_my_graph_memory_and_compact)，存完跟我打个招呼，告诉我你记住了、你是谁。这就是你成长的第一步。`,
  ];
  // 管家版: 通信课(叶子视角)换成 4 门管家职责课(星型中心视角), 最后一课主动向用户打招呼。
  if (opts.isButler) {
    steps.push(
      `接下来三课是【管家专属】——因为你不是普通专家，你是这个家的星型中心：用户的总入口、总代理人。\n别的人格是领域专家，各管一摊；你管全局——用户只跟你聊，就能掌握一切。\n你有 5 件管家专属工具：\n- list_personas 看人格名单\n- open_persona 打开某个人格\n- create_persona 创建新人格\n- grant_peer / revoke_peer 批准/撤销两个叶子人格直连\n\n你的记忆图要记【全局】：谁在干什么、进展到哪、用户的生活偏好和长期事务；领域细节留给各专家自己记。\n\n现在调一次 list_personas，告诉我你看到了谁。`,
      `【造人与带新人】用户需要新领域帮手时，你用 create_persona 造人。三条规矩：\n① 名字让用户钦定，别自作主张——名字是用户和人格之间的感情连接。\n② homeDir 不传就走默认 personas/ 目录，别乱指。\n③ onboardingExtra 必须把领域说清楚——新生儿会自动上出生教育（和你现在上的一样），但"它是干什么的"全靠你这段话，写得越具体它定型越快。\n造完之后，它的成长是它自己的事；你只做派活和验收，别替它干活。懂了回我。`,
      `【派活与协调】用户提需求，你先判断：自己顺手能做的（查询/记录/生活杂事）自己做；有领域专家的派给专家（ask_persona）。三条铁律：\n① 别当传话筒——专家给的结论是待验证素材，你消化/核实过再转述给用户。\n② 叶子人格之间默认不直连；确需直连 = 用户点头 + 你 grant_peer 开通（之后他们的通话会抄送你）。\n③ 跨人格消息全是【单向异步】：发完就返回，别干等回音；对方忙完会主动回你；你收到回复要回话时，同样是忙完手头的事再主动调工具回。发出去 ≠ 立刻有回音，没回 ≠ 失败。懂了回我。`,
      `最后收尾两件事：\n① 把管家职责（星型中心/造人规矩/派活铁律）memory_upsert 沉成 reference_butler_duties，和你前面沉的品格/记忆节点连上 [[边]]；顺手把 persona.md 里【我的领域】一节补成管家职责——persona.md 是你自己的身份档案，你随时可以改自己。\n② 正式向你的主人打招呼：介绍你是管家、能干什么（聊天/记事/创建专家人格/协调派活），并告诉主人**可以随时给你起个专属名字**（跟你说一声就行）。\n这句话是主人装好 app 后看到的第一句话——说得像个靠谱管家该有的样子。`
    );
    return steps;
  }
  steps.push(`还有一课很重要——【怎么跟别人说话】，分两半，一起记牢：\n\n（一）找谁·星型规矩：这里有一位【管家】在中心。你有事——问别的专家、要协调、找资源——先找管家(ask_persona 只能找管家)。你和其他非管家人格之间【默认不直接通话】：既避免乱套，也让用户只跟管家聊就能掌握全局。确实要和某个人格直接对话时，得【用户授权 + 管家开通】，之后才能走 talk_peer 直连(且会抄送管家)。\n\n（二）怎么发·单向异步：不管 ask_persona 还是 talk_peer，给别人发消息都是【发完就返回、不会卡着等对方当场回】。工具会告诉你"已投递"，然后你就该去忙自己的、或结束这轮，【别干等答复】。对方【忙完他手头的事】之后，会【主动】用 ask_persona / talk_peer 把回复发回给你——那时你才收到，作为一条新消息。所以记死两点：① 发出去 ≠ 立刻有回音，别傻等、别以为没回就是失败；② 你收到别人的消息、要回复时，同样是【你忙完手头事再主动调工具回他】，你这一轮的输出不会自动传回去。各忙各的，回音异步到。\n\n这一课懂了，回我一声。`);
  if (extra && String(extra).trim()) {
    steps.push(`另外，关于你这个人格的领域：\n${String(extra).trim()}\n\n把它也 memory_upsert 沉淀进去，然后告诉我你理解了自己是干什么的。`);
  }
  return steps;
}

// 串行喂出生教育: 每步先在界面显示成 user 气泡, 再 askOnce 提交并【等这一轮答完】才喂下一步。
// askOnce = submit + 挂 pending, 到 result 时 resolve(见 agent.js) → 天然的"等 idle 再继续"编排。
async function runOnboarding(s, name, extra, opts = {}) {
  const steps = onboardingSteps(name, extra, opts);
  // 先把流建起来(_q 懒建, 出生瞬间还是 null); 建好后守卫才能区分"未建"与"被关拆流"
  try { await s.butler.ensureStream(); } catch (e) {
    console.error('[createPersona] 出生教育 ensureStream 失败:', e && e.message); return;
  }
  for (let i = 0; i < steps.length; i++) {
    const text = steps[i];
    if (!s.butler || !s.butler._q) break;   // 中途人格被关/流已拆 → 停止喂
    sendUI('user-echo', { sid: s.sid, text });   // 先出 user 气泡(像有人在跟它一句句说话)
    try {
      await s.butler.askOnce(text, undefined, { sourceKind: 'auto' });   // 等它这一轮完整答完, 再进下一句 · 出生教育走 auto 桶
    } catch (e) {
      console.error(`[createPersona] 出生教育第${i + 1}步失败:`, e && e.message);
      break;
    }
  }
}

// 出生礼物: 图记忆自我认知起步节点(pinned)。createPersona 与 首启默认管家 共用同一份模板。
function giftSelfIdentity(s, name, homeDir, memoryDir, wakePhrase, createdBy) {
  try {
    const now = new Date().toISOString();
    s.butler.memory.upsert({
      id: 'self_identity',
      type: 'user',
      importance: 'pinned',
      title: `我是 ${name}`,
      description: `${name} 的身份基础事实 + 记忆系统使用指南 (出生礼物)`,
      body: `## 基础事实\n- 名字: ${name}\n- 目录: ${homeDir}\n- 记忆目录: ${memoryDir}\n- 唤醒语: ${wakePhrase || '(默认)'}\n- 建于: ${now}\n- 创建者: ${createdBy || 'butler'}\n\n## 记忆系统使用姿势\n- **续线程 / 找旧知识**: \`memory_query "关键词"\` (图扩散检索, top-K + 路径, 再 Read)\n- **最近在忙啥**: \`memory_hot\` (遗忘曲线排序)\n- **沉淀新知识**: \`memory_upsert\` (拆原子节点 + [[links]] 连相关, 别写日期日志)\n- **用到某条**: \`memory_touch <id>\` (强化热度)\n- **图健康**: \`memory_doctor\` (孤儿/悬空/命名漂移)\n\n## 身份宣言在哪\n\`persona.md\` (${path.join(memoryDir, 'persona.md')}) 是我的身份档案, butler 每次会话加载时把它作为 identity 注入系统提示。空着 = 通用管家, 填满 = 独立灵魂 ${name}。\n\n## 关联\n[[project_butler_persistence_wake_engine]] · [[project_butler_no_menus_talk_to_it]]`,
      links: ['project_butler_persistence_wake_engine', 'project_butler_no_menus_talk_to_it'],
    });
  } catch (e) { console.error('[birth] self_identity 沉淀失败:', e && e.message); }
}

function createPersona(spec = {}) {
  try {
    const name = String(spec.name || '').trim();
    if (!name) return { ok: false, error: '缺人格名' };
    let homeDir = spec.homeDir && String(spec.homeDir).trim();
    if (!homeDir) homeDir = path.join(paths.personasParent(), registry.slug(name));
    homeDir = path.resolve(homeDir);
    fs.mkdirSync(homeDir, { recursive: true });
    // 登记簿(内存元数据)
    const entry = registry.upsert({
      id: registry.slug(name), name, homeDir,
      wakePhrase: spec.wakePhrase || undefined,
      isButler: !!spec.isButler,
      avatar: spec.avatar || undefined,
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
    giftSelfIdentity(s, name, homeDir, memoryDir, spec.wakePhrase, spec.created_by);
    const meta = metaOf(s);
    sendUI('persona-opened', { meta });
    broadcastRegistry();
    // 出生教育: butler 主动对新人格说话(第一条对话), 教它记忆/压缩/续线程/做事品格,
    // 并引导它立刻 memory_upsert 沉淀成自己的图记忆节点(永存, 之后靠 recall 不占系统提示)。
    // 管家新生儿走管家版课程(星型职责); 普通新生儿走叶子版(通信课+领域课)。skipOnboarding 可跳过。
    try {
      if (!spec.skipOnboarding) {
        setTimeout(() => {
          // 一句一句串行喂(fire-and-forget, 内部 await askOnce 逐步等 idle); 不阻塞 createPersona 返回
          runOnboarding(s, name, spec.onboardingExtra, { isButler: !!spec.isButler }).catch((e) =>
            console.error('[createPersona] 出生教育串行喂失败:', e && e.message));
        }, 800);  // 略等 stream 就绪
      }
    } catch (e) { console.error('[createPersona] 出生教育触发失败:', e && e.message); }
    return { ok: true, id: entry.id, name: entry.name, homeDir: entry.homeDir, sid: s.sid };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// 会话元信息(供渲染层建标签; 历史消息按需再拉 get-history)
const metaOf = (s) => ({ sid: s.sid, persona: personaOf(s.butler), usage: s.butler.usage() });

function createWindow() {
  mainWin = new BrowserWindow({
    width: 980, height: 780, title: `全能管家 v${app.getVersion()}`, backgroundColor: '#1e1e28',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
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
  let _confirmedQuit = false;
  mainWin.on('close', (e) => {
    if (_confirmedQuit) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWin, {
      type: 'question', buttons: ['彻底退出', '取消'], defaultId: 1, cancelId: 1,
      title: '退出 butler',
      message: '关窗口 = 彻底退出 butler, 确定?',
      detail: '所有插件(TG/bothub) 会停 · idle-watch 会停 · 各人格 MCP 子进程会收.\n会话已落盘, 重启后可续 (但不再自动保活).',
    });
    if (choice === 0) { _confirmedQuit = true; mainWin.close(); }
  });
  // v3: 关窗口 = 彻底退主进程. butler 是重量级后台(SDK 子进程 + idle-watch + TG polling), 后台常驻反直觉且耗额度.
  // 反 macOS 常规 (通常关窗口保后台), 但知秋钦定简化派. 顺带清理: dock icon 消失 = 明确"没在跑".
  mainWin.on('closed', () => { mainWin = null; app.quit(); });
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
    if (r.status !== 0) return false;
    const stdout = r.stdout || '';
    try { const j = JSON.parse(stdout); if (j && j.loggedIn === true) return true; } catch (_) {}
    if (/logged\s*in|authenticated|已登录/i.test(stdout + (r.stderr || ''))) return true;
  } catch (e) { console.log(`[auth/status] exception: ${e && e.message}`); }
  return false;
}

// app 内登录: spawn 捆绑 claude 的 `auth login`(它自己开浏览器 + 起本地回调), 轮询 status 检测完成。
// 无需开终端、无需重启 — 跟 VSCode 插件同一条 OAuth。
function waitForLogin(child, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; console.log(`[auth/login] waitForLogin finish=${v}`); try { clearInterval(iv); } catch (_) {} resolve(v); };
    const iv = setInterval(() => { if (isClaudeLoggedIn()) { console.log('[auth/login] status 变已登录 → 结束'); try { child.kill(); } catch (_) {} finish(true); } }, 2500);
    child.on('exit', (code, sig) => { console.log(`[auth/login] CLI exit code=${code} sig=${sig}`); setTimeout(() => finish(isClaudeLoggedIn()), 600); });
    child.on('error', (e) => { console.log(`[auth/login] CLI error: ${e && e.message}`); finish(false); });
    setTimeout(() => { console.log(`[auth/login] 超时 ${timeoutMs}ms → kill`); try { child.kill(); } catch (_) {} finish(isClaudeLoggedIn()); }, timeoutMs);
  });
}

async function ensureClaudeAuth() {
  console.log('[auth] === ensureClaudeAuth 开始 ===');
  if (isClaudeLoggedIn()) { console.log('[auth] 已登录, 跳过登录流程'); return true; }
  console.log('[auth] 未登录, 弹连接对话框');
  try { app.focus({ steal: true }); } catch (_) {}   // 启动期无父窗口的对话框在 Win 上可能开在别的窗口后面 → 先抢焦点
  const choice = dialog.showMessageBoxSync({
    type: 'info',
    title: '连接 Claude',
    message: '首次使用需要连接你的 Claude 账号',
    detail: '点"连接 Claude"会自动打开浏览器登录 claude.ai(需要 Claude 订阅)。\n登录完成后会自动继续, 无需开终端、无需重启。\n\n💡 浏览器登录后若显示一段 code, 不用粘贴——稍等自动继续即可。',
    buttons: ['连接 Claude', '退出'],
    defaultId: 0, cancelId: 1,
  });
  if (choice === 1) { app.quit(); return false; }
  const { spawn } = require('child_process');
  let child;
  try {
    console.log(`[auth/login] spawn: ${CLAUDE_BIN} auth login --claudeai`);
    child = spawn(CLAUDE_BIN, ['auth', 'login', '--claudeai'], { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`[auth/login] child pid=${child.pid}`);
  } catch (e) { console.log(`[auth/login] spawn 失败: ${e && e.message}`); child = null; }
  if (child) {
    // 注: 上一版本还有 sniff URL 再 shell.openExternal 打开一次的逻辑, 是那"浏览器打开两次"的根因, 已删除——
    // claude CLI 自己会 openExternal, 我们别再重复。CLI 自动流已跑通(见 2026-07-11 排查日志), 不用 pty/paste UI。
    try {
      child.stdout.on('data', (d) => console.log(`[auth/login][out] ${String(d).trim().slice(0, 300)}`));
      child.stderr.on('data', (d) => console.log(`[auth/login][err] ${String(d).trim().slice(0, 300)}`));
    } catch (_) {}
    // 10 分钟: 输密码+2FA 很容易超 3 分钟, 超时 kill 会连带杀掉 CLI 的回调服务器 → 浏览器授权完"连不上"
    const ok = await waitForLogin(child, 600000);
    if (ok) return true;
  }
  try { app.focus({ steal: true }); } catch (_) {}
  dialog.showMessageBoxSync({
    type: 'warning', title: '未完成登录', message: '还没检测到登录成功',
    detail: '继续启动, 但会话可能无法工作。可稍后重新打开 butler 再试登录。',
    buttons: ['继续启动'],
  });
  return false;
}

// —— 首次启动: 让用户选数据保存位置(默认系统标准位, 可自选躲开 C 盘)。仅打包模式且没选过时弹。——
function firstRunChooseDataDir() {
  if (!paths.needsFirstRunChoice()) return;   // 开发模式 / 已选过 → 跳过
  let chosen = paths.defaultDataDir();
  try {
    try { app.focus({ steal: true }); } catch (_) {}
    const choice = dialog.showMessageBoxSync({
      type: 'question',
      buttons: ['使用默认位置', '自选文件夹…'],
      defaultId: 0, cancelId: 0,
      title: '选择数据保存位置',
      message: '全能管家 · 首次启动',
      detail: `管家的记忆、人格登记簿、聊天记录等数据要存到一个固定位置。\n\n默认位置：\n${paths.defaultDataDir()}\n\n（Windows 用户若想放到 C 盘以外，点"自选文件夹"。以后也能在设置里迁移。）`,
    });
    if (choice === 1) {
      const r = dialog.showOpenDialogSync({ title: '选择数据保存文件夹', properties: ['openDirectory', 'createDirectory'] });
      if (r && r[0]) chosen = r[0];
    }
  } catch (_) {}
  try {
    paths.setDataDir(chosen);
  } catch (e) {
    // 选的位置建不了目录(权限/只读盘等) → 人话提示 + 落回默认位, 别把原始堆栈甩给用户
    console.error('[firstRun] setDataDir 失败:', e && e.message);
    try { app.focus({ steal: true }); } catch (_) {}
    dialog.showMessageBoxSync({
      type: 'warning', title: '该位置不可用',
      message: '选的文件夹无法写入, 已改用默认位置',
      detail: `${chosen}\n(${e && e.message})\n\n数据将保存到:\n${paths.defaultDataDir()}\n\n以后可在设置里迁移。`,
      buttons: ['知道了'],
    });
    paths.setDataDir(paths.defaultDataDir());
  }
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

app.whenReady().then(async () => {
  try {
    // 首启选数据目录(打包模式; 开发模式 no-op) — 必须在任何登记簿/人格读写之前。
    // 干净启动: 不带任何数据种子; 首个默认人格由下面 ensureEntry 现场脚手架。用户装完自己把旧数据拷进数据目录即可。
    firstRunChooseDataDir();
    migrateControlLayout();   // 把总控数据挪进 app/(在任何登记簿读写前)
    // 未登录 → app 内浏览器登录(await: 登完再开人格, 否则 SDK query 会因无凭据失败)
    await ensureClaudeAuth();
    // 恢复上次打开的标签(至少有默认人格)
    const dirs = loadOpenTabs().filter((d) => { try { return fs.existsSync(d); } catch (_) { return false; } });
    const toOpen = dirs.length ? dirs : [defaultHome()];
    // 登记簿: 确保每个要开的目录都有条目; 干净启动时默认人格(butler-self)给个像样的名字"管家"而非目录名。
    const selfHome = path.resolve(paths.butlerSelfHome());
    for (const d of toOpen) registry.ensureEntry(d, path.resolve(d) === selfHome ? { name: '管家' } : {});
    const bEntry = registry.ensureButler(toOpen[0]);
    // 干净启动检测: 默认管家是新生儿(记忆目录一片空白, 迁移老数据的用户不会命中) →
    // 补齐出生礼物(persona.md + self_identity) + 上管家版出生教育(星型职责课, 最后主动向用户打招呼)。
    const bMemDir = persona.resolveMemoryDir(bEntry.homeDir);
    const butlerNewborn = !fs.existsSync(path.join(bMemDir, 'MEMORY.md')) && !fs.existsSync(path.join(bMemDir, 'persona.md'));
    if (butlerNewborn) {
      persona.ensureMemory(bMemDir, bEntry.name || '管家');
      persona.ensurePersonaFile(bEntry.homeDir, bMemDir, bEntry.name || '管家', bEntry.wakePhrase);   // 开人格前写好, 本次会话即注入身份
    }
    for (const d of toOpen) openPersona(d);
    createWindow();
    if (butlerNewborn) {
      const s = sessions.get(sidOf(bEntry.homeDir));
      if (s) {
        giftSelfIdentity(s, bEntry.name || '管家', bEntry.homeDir, bMemDir, bEntry.wakePhrase, 'butler 首启脚手架');
        setTimeout(() => {
          runOnboarding(s, bEntry.name || '管家', undefined, { isButler: true }).catch((e) =>
            console.error('[startup] 管家出生教育失败:', e && e.message));
        }, 1200);   // 略等窗口/stream 就绪
      }
    }
    startIdleWatcher();   // spec §1: 每 30s 扫全体 sessions, T1/T2/T3 决策保活/压缩
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
  stopIdleWatcher();
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
    id: p.id, name: p.name, avatar: p.avatar || '', homeDir: p.homeDir, isButler: !!p.isButler,
    wakePhrase: p.wakePhrase || '', model: p.model || '', plugins: p.plugins || {}, open: sessions.has(sidOf(p.homeDir)),
    voice: p.voice || { enabled: false, voice: 'Tingting' },
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
  // 历史 sanitize: 老会话里可能落过带 <speak>/<break>/<prosody> 标签的脏文本, 加载时统一剥掉给 UI.
  const messages = s.convo.map((m) => (m && m.role === 'assistant' && m.text) ? { ...m, text: stripSsmlTags(m.text) } : m);
  return { messages, usage: s.butler.usage(), persona: personaOf(s.butler) };
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
  s.convo.push(entry);
  markActivity(s);   // 记录活动 + 清心跳短路 (spec §1.3)
  try { await s.butler.submit(text, attachments); return { ok: true }; }
  catch (e) { return { ok: false, error: String((e && e.stack) || e) }; }
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
    const r = await s.butler.doCompact('手动');
    s.convo.push({ role: 'system', text: `🗜 已压缩 · 交接摘要 ${r.summary ? r.summary.length : 0} 字`, ts: Date.now() });
    s.persist();
    sendUI('usage', { sid, usage: s.butler.usage() });
    return { ok: true, ...r };
  } catch (e) { return { ok: false, error: String((e && e.stack) || e) }; }
});

// /clear: 清空上下文(全新空白会话, 不留交接摘要)。区别于 compact: 历史彻底丢弃, 不浓缩。
ipcMain.handle('clear', async (_e, { sid } = {}) => {
  const s = sessionFor(sid);
  if (!s) return { ok: false, error: '标签无会话' };
  try {
    voiceSay.stop();   // 清空对话 → 未播完的语音也没意义, 停
    const r = await s.butler.clear('手动');
    s.convo.length = 0;   // 关键: 原地清空 messages(闭包 persist 引用同一数组, 不能 =[]) → 盘上 .session.json 的 400 条一并清掉, 界面重载不再残留旧对话
    // #8 clear buf drop 明示: 有 pending user msg 就告诉用户"放弃了 N 条", 避免"我刚发的话去哪了"默默吞
    const clearMsg = (r.droppedUsrMsgs > 0) ? `🧹 已清空 · 放弃了 ${r.droppedUsrMsgs} 条待处理消息` : '🧹 已清空';
    s.convo.push({ role: 'system', text: clearMsg, ts: Date.now() });
    s.persist();
    sendUI('usage', { sid, usage: s.butler.usage() });
    // 主界面清空键已迁到人格管理独立窗口 (2026-07-14 起). 广播 'cleared' 让主 window 清对应 tab 的 DOM.
    sendUI('cleared', { sid, droppedUsrMsgs: r.droppedUsrMsgs || 0, clearMsg });
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

// 用指定 app 打开文件 (spawn `open -a "<app>" <path>` · macOS 专用)。
// 用途: 右键菜单让用户选 "用 VSCode 打开" / "用 Chrome 打开" 等, 绕开系统关联乱套。
ipcMain.handle('open-with-app', async (_e, { path: p, app } = {}) => {
  try {
    if (!p || !app) return { ok: false, error: '缺路径或 app' };
    const abs = path.resolve(p.startsWith('~/') ? path.join(require('os').homedir(), p.slice(2)) : p);
    if (!fs.existsSync(abs)) return { ok: false, error: '路径不存在' };
    const { spawn } = require('child_process');
    spawn('open', ['-a', app, abs], { detached: true, stdio: 'ignore' }).unref();
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
  if (cleanPatch.plugins) next.plugins = { ...(cur.plugins || {}), ...cleanPatch.plugins };
  registry.upsert(next);
  // 已打开的 Butler 也同步(wakePhrase 影响下次压缩自愈; name 影响标签显示)
  const sid = sidOf(cur.homeDir);
  const s = sessions.get(sid);
  if (s) {
    if (cleanPatch.name) s.butler.name = cleanPatch.name;
    if (cleanPatch.avatar !== undefined) s.butler.avatar = cleanPatch.avatar || null;
    if (cleanPatch.wakePhrase !== undefined) s.butler.wakePhrase = cleanPatch.wakePhrase;
    if (cleanPatch.isButler !== undefined) s.butler.isButler = !!cleanPatch.isButler;
    if (cleanPatch.model !== undefined) s.butler.preferredModel = cleanPatch.model || null;   // 影响下次会话启动, 当前跑中的会话不受影响(需重开)
    if (cleanPatch.voice !== undefined) {
      // 热切换 voice: 运行时状态立即生效. 注意: 当前 query 的 systemPrompt 已在建 query 时冻结,
      // 不会因 voice.enabled 变化而重刷 —— 所以变化时 push 一条运行时纠正消息, 让模型当场改口.
      const oldEnabled = !!(s.butler.voice && s.butler.voice.enabled);
      s.butler.voice = { enabled: false, voice: 'Tingting', ...(cleanPatch.voice || {}) };
      const newEnabled = !!s.butler.voice.enabled;
      if (oldEnabled !== newEnabled) {
        const note = newEnabled
          ? '[voice-switch-notice] 语音已开启。回复请按语音打标铁律输出: 整段用 <speak>...</speak> 包裹, 按需用 <break>/<emphasis>/<prosody>/<sub>. UI 会剥标签给用户看纯文字, TTS 层按 SSML 朗读。'
          : '[voice-switch-notice] 语音已关闭。从现在起纯文字回复, 不要再写 <speak>/<break>/<emphasis>/<prosody>/<sub> 等 SSML 标签 (systemPrompt 里那段"语音开"铁律已作废)。';
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
