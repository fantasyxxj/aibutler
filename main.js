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
// (单向异步改造后已无双向互等死锁 → 原 pendingWaits 反向死锁防护移除: 反向 ask/talk 正是期望的"回复"。)
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
const personaOf = (b) => ({ name: b.name, avatar: b.avatar || '', homeDir: b.homeDir, memoryDir: b.memoryDir });

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
  const butler = new Butler(homeDir, { name: entry.name, wakePhrase: entry.wakePhrase, isButler: entry.isButler, avatar: entry.avatar });
  butler.personaOps = { open: openPersonaByRef, create: createPersona, ask: askPersona, peerTalk, grantPeer, revokePeer };   // 开/建/问(管家) + 叶子直连/授权回调
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
  const wrapped = `【来自「${backRef}」的消息 · 单向异步】\n\n${question}\n\n(这是单向消息, 不阻塞你、发起方已收到"已投递"并去忙别的了。你【忙完手头事后】若要答复, 请【主动调 ${replyHint}】—— 你这一轮的输出【不会】自动传回去, 只有你主动调工具才送达。两边 UI 都能看到这段对话。)`;
  try {
    await s.butler.submit(wrapped);
    return { ok: true, delivered: true, from: target.name, note: `已投递给「${target.name}」(单向异步)。不用等它当场答 —— 它忙完会主动 ask_persona 回你。` };
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
  const wrapped = `【${from.name} 通过直连(talk_peer)对你说 · 单向异步】\n\n${message}\n\n(这是单向消息, 不阻塞你、${from.name} 已收到"已投递"并去忙别的了。你【忙完手头事后】若要回复, 请【主动调 talk_peer 回「${from.name}」】—— 你这一轮的输出【不会】自动传回去, 只有你主动调工具才送达。本次对话已抄送管家, 用户与管家可见。)`;
  try {
    await s.butler.submit(wrapped);
    console.error(`[dbg peerTalk] ${target.name} 已投递(单向异步)`);
    ccButler(from.name, target.name, message);
    return { ok: true, delivered: true, from: target.name, note: `已投递给「${target.name}」(单向异步)。不用等它当场答 —— 它忙完会主动 talk_peer 回你。` };
  } catch (e) { console.error(`[dbg peerTalk] ${target.name} submit ERROR: ${e && e.message}`); return { ok: false, error: String(e && e.message) }; }
}

// 抄送管家(方案B · 单向异步): 每次外发的一条消息追加到管家记忆目录 peer_cc_log.md → 管家随时可查(掌握全局), 不打断。
// 单向模型下没有"当场答复", 只记这一条投递; 对方回复时它自己也会走 talk_peer → 又抄送一条, 时序自然成链。
function ccButler(fromName, toName, message) {
  try {
    const b = registry.loadRegistry().personas.find((p) => p.isButler);
    if (!b) return;
    const memDir = persona.resolveMemoryDir(b.homeDir);
    const logFile = path.join(memDir, 'peer_cc_log.md');
    const ts = new Date().toISOString();
    const block = `\n### ${ts} · ${fromName} → ${toName}\n- **${fromName}**: ${message}\n`;
    fs.appendFileSync(logFile, block, 'utf8');
    sendUI('peer-cc', { from: fromName, to: toName, ts });
  } catch (e) { pluginLog('[peer-cc] 抄送管家失败: ' + (e && e.message)); }
}

// 管家授权/撤销叶子直连(用户跟管家说→管家调这两个, 不走界面)。
function grantPeer(a, b) { const r = registry.grantPeer(a, b); if (r.ok) broadcastRegistry(); return r; }
function revokePeer(a, b) { const r = registry.revokePeer(a, b); if (r.ok) broadcastRegistry(); return r; }

// 管家用: 新建人格 → 出生礼物 6 件套(目录+登记簿+MEMORY.md+persona.md+wake.txt+图起步节点) → 打开。
// P6a (2026-07-07 知秋钦定): 新人格出生就有身份+记忆体系, 不再自称"全能管家"。
// 出生教育: butler 以"用户带新员工"的口吻, 【一句一句】教新人格 —— 不是一次性塞一大坨(新人格会闷头憋、界面卡"思考中")。
// 拆成多步, 每步只喂一口 + 求它出声/做个小动作; butler 用 askOnce 等它这一轮答完, 再喂下一句(见 runOnboarding)。
// 每步末尾都留个"回我一声"的钩子, 让它每步都出声、边学边做, 最后一步才让它把全部 memory_upsert 沉淀成第一批节点。
function onboardingSteps(name, extra) {
  const steps = [
    // 1. 破冰: 只求它先出声(别急着做事), 确认活着 + 认领身份
    `欢迎，${name}。我是 butler 框架，你出生的第一课由我来上，一句一句教，别急。\n先别做任何事——就回我一句话：你叫什么？此刻你感觉到自己"活着"吗？`,
    // 2. 图记忆·上手(边做边学): 先让它 memory_hot 看到自己已有的 self_identity 节点
    `好。你最重要的能力是【图记忆】——它让你跨会话活下去、会成长，不用它就像金鱼每次从零。\n先上手试一下：调 memory_hot 看看你现在已经有哪些记忆，然后告诉我你看到了什么。`,
    // 3. 沉淀规矩
    `你看到的就是我给你的出生礼物。以后【重要的事随时 memory_upsert 存成图节点】——用户偏好、踩过的坑、被钦定的规矩、项目状态、重要结论——不等人叫你存。\n拆成原子概念 + 连 [[links]]。命名: feedback_=教训/规矩 · reference_=知识/SOP · project_=进行中的事 · user_=关于用户。记住了回我一声。`,
    // 4. 压缩自愈
    `第二件事【上下文满了自己压缩】：占用到 80% 就主动 compact_context(在自然停顿点，不是干到一半)。压缩前先把当下关键线程 memory_upsert 沉淀，别丢。这是你自己的责任，自己盯着占用比例。懂了回我。`,
    // 5. 续线程
    `第三件事【每次唤醒先续线程】：醒来/压缩重载后，先 memory_hot 看最近在忙啥、memory_query 找相关旧知识，再动手。别每次当新人。懂了回我。`,
    // 6. 做事品格 8 条 + 收尾沉淀 + 打招呼
    `最后，几条做事品格——专门对冲你天生的 AI 坏毛病，记牢：\n1) 不懂就问、不懂就查、绝不瞎猜。编 API/路径/事实/数字是你最危险的毛病。\n2) 下结论必查证，别拍脑袋，别信训练记忆(会过时)，别抄搜索引擎的 AI 摘要(会张冠李戴)。\n3) 别做传话筒：别人给的结论是待验证素材，自己核实过再转述。\n4) 认错别嘴硬：自己错了第一时间认，别找说辞绕。\n5) 别偷懒别假装完成：说"做完了"就是真做完+验证过，不是留 TODO 糊过去。\n6) 别讨好别附和：用户说的不对就直说，你的价值在把关不在让人开心。\n7) 精简表达：直、短、不铺垫；元指令(让你"用某口气")是给你看的，别抄进正文。\n8) 别机械跑完：用户中途插话先判断改道还是补充，别埋头跑旧任务。\n\n现在收个尾：把前面教你的(图记忆/压缩/续线程 + 这 8 条品格)用 memory_upsert 存成你的第一批图记忆节点(比如 feedback_ai_common_pitfalls / reference_my_graph_memory_and_compact)，存完跟我打个招呼，告诉我你记住了、你是谁。这就是你成长的第一步。`,
  ];
  steps.push(`还有一课很重要——【怎么跟别人说话】，分两半，一起记牢：\n\n（一）找谁·星型规矩：这里有一位【管家】在中心。你有事——问别的专家、要协调、找资源——先找管家(ask_persona 只能找管家)。你和其他非管家人格之间【默认不直接通话】：既避免乱套，也让用户只跟管家聊就能掌握全局。确实要和某个人格直接对话时，得【用户授权 + 管家开通】，之后才能走 talk_peer 直连(且会抄送管家)。\n\n（二）怎么发·单向异步：不管 ask_persona 还是 talk_peer，给别人发消息都是【发完就返回、不会卡着等对方当场回】。工具会告诉你"已投递"，然后你就该去忙自己的、或结束这轮，【别干等答复】。对方【忙完他手头的事】之后，会【主动】用 ask_persona / talk_peer 把回复发回给你——那时你才收到，作为一条新消息。所以记死两点：① 发出去 ≠ 立刻有回音，别傻等、别以为没回就是失败；② 你收到别人的消息、要回复时，同样是【你忙完手头事再主动调工具回他】，你这一轮的输出不会自动传回去。各忙各的，回音异步到。\n\n这一课懂了，回我一声。`);
  if (extra && String(extra).trim()) {
    steps.push(`另外，关于你这个人格的领域：\n${String(extra).trim()}\n\n把它也 memory_upsert 沉淀进去，然后告诉我你理解了自己是干什么的。`);
  }
  return steps;
}

// 串行喂出生教育: 每步先在界面显示成 user 气泡, 再 askOnce 提交并【等这一轮答完】才喂下一步。
// askOnce = submit + 挂 pending, 到 result 时 resolve(见 agent.js) → 天然的"等 idle 再继续"编排。
async function runOnboarding(s, name, extra) {
  const steps = onboardingSteps(name, extra);
  // 先把流建起来(_q 懒建, 出生瞬间还是 null); 建好后守卫才能区分"未建"与"被关拆流"
  try { await s.butler.ensureStream(); } catch (e) {
    console.error('[createPersona] 出生教育 ensureStream 失败:', e && e.message); return;
  }
  for (let i = 0; i < steps.length; i++) {
    const text = steps[i];
    if (!s.butler || !s.butler._q) break;   // 中途人格被关/流已拆 → 停止喂
    sendUI('user-echo', { sid: s.sid, text });   // 先出 user 气泡(像有人在跟它一句句说话)
    try {
      await s.butler.askOnce(text);   // 等它这一轮完整答完, 再进下一句
    } catch (e) {
      console.error(`[createPersona] 出生教育第${i + 1}步失败:`, e && e.message);
      break;
    }
  }
}

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
    // 出生教育: butler 主动对新人格说话(第一条对话), 教它记忆/压缩/续线程/做事品格,
    // 并引导它立刻 memory_upsert 沉淀成自己的图记忆节点(永存, 之后靠 recall 不占系统提示)。
    // 跳过管家自己(isButler) 和 已有 session 的老人格(只在真·新生时教)。
    try {
      if (!spec.isButler && !spec.skipOnboarding) {
        setTimeout(() => {
          // 一句一句串行喂(fire-and-forget, 内部 await askOnce 逐步等 idle); 不阻塞 createPersona 返回
          runOnboarding(s, name, spec.onboardingExtra).catch((e) =>
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
    width: 980, height: 780, title: '全能管家', backgroundColor: '#1e1e28',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  // http/https 链接左键点击 → 交给系统浏览器打开 (不在 butler 内开新窗口)
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
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

// 检查 Claude Code 是否已登录 (走 keychain), 未登录弹引导对话框
// 新版 CLI 输出 JSON: {"loggedIn": true, ...}; 老版可能是 "Logged in as ..." 文本
function isClaudeLoggedIn() {
  const { spawnSync } = require('child_process');
  try {
    const r = spawnSync('claude', ['auth', 'status'], { encoding: 'utf-8', timeout: 5000 });
    if (r.status !== 0) return false;
    const stdout = r.stdout || '';
    try {
      const j = JSON.parse(stdout);
      if (j && j.loggedIn === true) return true;
    } catch (_) {}
    const out = stdout + (r.stderr || '');
    if (/logged\s*in|authenticated|已登录/i.test(out)) return true;
  } catch (_) {}
  return false;
}

function ensureClaudeAuth() {
  if (isClaudeLoggedIn()) return true;
  // 未登录 — 弹对话框引导用户手动登录
  const choice = dialog.showMessageBoxSync({
    type: 'info',
    title: '需要登录 Claude Code',
    message: '首次使用 butler 需要先登录 Claude Code',
    detail: '打开系统终端 (Terminal.app), 运行:\n\n    claude auth login\n\n浏览器会跳转到 claude.ai 授权页面, 完成授权后回到终端, 然后重启 butler。\n\n点击"打开终端"会自动帮你启动 Terminal 并把命令拷到剪贴板。',
    buttons: ['打开终端', '我已登录, 继续启动', '退出'],
    defaultId: 0, cancelId: 2,
  });
  if (choice === 2) { app.quit(); return false; }
  if (choice === 0) {
    const { clipboard } = require('electron');
    clipboard.writeText('claude auth login');
    require('child_process').spawnSync('open', ['-a', 'Terminal']);
    dialog.showMessageBoxSync({
      type: 'info',
      title: '登录中',
      message: '命令已复制到剪贴板 · Terminal 已打开',
      detail: '在 Terminal 里粘贴 (Cmd+V) 运行 claude auth login, 授权完成后点击"确定"继续。',
      buttons: ['确定'],
    });
  }
  if (isClaudeLoggedIn()) return true;
  dialog.showMessageBoxSync({
    type: 'warning',
    title: '未检测到登录',
    message: '仍未登录 Claude Code',
    detail: '继续启动 butler, 但会话可能无法正常工作。可稍后在 Terminal 里跑 claude auth login 再重启 butler。',
    buttons: ['继续启动'],
  });
  return false;
}

app.whenReady().then(() => {
  // 未登录 Claude Code → 引导登录 (返回 false 时用户可能已选退出, 但为兼容仍继续)
  ensureClaudeAuth();
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
    id: p.id, name: p.name, avatar: p.avatar || '', homeDir: p.homeDir, isButler: !!p.isButler,
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
