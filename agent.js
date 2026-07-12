// agent.js — 全能管家大脑: Claude Agent SDK 封装
// 复用订阅认证(通过 claude CLI), 真 usage 上下文, 自主/手动压缩(浓缩成交接摘要→重启会话)。
// 会话跑在【持久流式 query】上: 一个 query 贯穿多轮; 用户可在一轮进行中提交 → interrupt 打断 +
// push 新消息 → 我在下个间歇接住(插话/改道)。打断产生的 error_during_execution result 被吞掉。
const path = require('path');
const fs = require('fs');
const os = require('os');
const persona = require('./persona');
const paths = require('./paths');
const { MemoryGraph } = require('./memory');

// SDK 默认去 ~/.claude/local 找 claude; 打包版那里没有 → 显式指向捆绑的二进制(或系统安装位)。
const CLAUDE_BIN = paths.resolveClaudeBin();

let _sdk = null;
async function loadSdk() {
  if (!_sdk) _sdk = await import('@anthropic-ai/claude-agent-sdk');
  return _sdk;
}

// 可推送的异步消息队列: 作为 query 的 streaming-input prompt(开启流式模式 → interrupt 可用)
// tag = 人格名, 只用于 dbg 日志(#8 消息吞根因复现: 观察 push/next 的相对时序)
function makeMsgQueue(tag = '?') {
  const buf = []; let waiter = null; let closed = false;
  const preview = (m) => {
    try { return (m && m.message && m.message.content && m.message.content[0] && m.message.content[0].text || '').slice(0, 60); } catch (_) { return ''; }
  };
  return {
    push(m) {
      if (closed) { console.error(`[dbg#8 queue.${tag}] push AFTER CLOSED, DROPPED: "${preview(m)}"`); return; }
      if (waiter) {
        const w = waiter; waiter = null;
        console.error(`[dbg#8 queue.${tag}] push → waiter WOKE, delivered: "${preview(m)}"`);
        w({ value: m, done: false });
      } else {
        buf.push(m);
        console.error(`[dbg#8 queue.${tag}] push → NO waiter, buf.push, buf.len=${buf.length}, msg: "${preview(m)}" (等 SDK next())`);
      }
    },
    close() { closed = true; if (waiter) { const w = waiter; waiter = null; w({ value: undefined, done: true }); } },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (buf.length) {
            const m = buf.shift();
            console.error(`[dbg#8 queue.${tag}] SDK next() → buf.shift, 剩 buf.len=${buf.length}, took: "${preview(m)}"`);
            return Promise.resolve({ value: m, done: false });
          }
          if (closed) return Promise.resolve({ value: undefined, done: true });
          console.error(`[dbg#8 queue.${tag}] SDK next() → buf empty, WAIT for push`);
          return new Promise((res) => { waiter = res; });
        },
        return() { closed = true; return Promise.resolve({ value: undefined, done: true }); },
      };
    },
  };
}

function windowFor(model) {
  if (!model) return 200000;
  if (/1m|\[1m\]/i.test(model)) return 1000000;
  // 默认就是 1M 窗口的模型(名字里不带 1m 标记): Opus 4.7/4.8, Opus 5, Sonnet 5, Fable 5
  if (/opus-4-[78]|opus-5|sonnet-5|fable-5/i.test(model)) return 1000000;
  return 200000;
}

function sumInput(u) {
  if (!u) return 0;
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

// 挂死防护(2026-07-12 事故: doCompact 摘要 query 挂死 → _compacting 永不 resolve → 本人格假"压缩中"+
// submit 全卡 → 别人 ask/talk 投递进来也卡 → 调用方 tool_use 永不返回, 全链瘫痪)。
// 原则: 会话生命周期路径上的任何 await 都必须有限时, 超时按失败处理, 绝不无限挂。
function withTimeout(p, ms, label) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label || 'op'} 超时(${Math.round(ms / 1000)}s)`)), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

class Butler {
  // homeDir = 这个人格的本体目录(cwd); opts.memoryDir 可覆盖记忆位置; opts.name 可指定人格名
  constructor(homeDir, opts = {}) {
    this.homeDir = path.resolve(homeDir || process.cwd());   // 归一化成绝对路径(SDK cwd/记忆解析都要绝对)
    this.memoryDir = persona.resolveMemoryDir(this.homeDir, opts.memoryDir);
    this.name = opts.name || persona.personaName(this.homeDir);
    persona.ensureMemory(this.memoryDir, this.name);   // 空目录=新人格→脚手架 MEMORY.md
    this.personaText = persona.loadPersona(this.homeDir, this.memoryDir);  // 人设(persona.md), 可 null
    this.extMcpNames = persona.loadMcpServers(this.homeDir, this.memoryDir); // 该人格要放行的外部 MCP(如 dc-platform)
    this.wakePhrase = opts.wakePhrase || persona.loadWakePhrase(this.homeDir, this.memoryDir, this.name); // 压缩自愈唤醒语; 注册表优先
    this.isButler = !!opts.isButler;      // 是否星型中心管家(有 open/create_persona 工具)
    // 帽子(标签栏管家标识)专用: 打开这个会话时的管家身份, updatePersona 不改它 →
    // 设管家当下帽子不抢跳; 等这个人格的会话重开(重开标签/重启 app)以管家身份跑起来, 帽子才移过去。跟会话走。
    this.openedAsButler = !!opts.isButler;
    // 模型偏好(用户在编辑面板选的, 持久化到 registry.model)。空=跟随 Claude Code 默认。
    // 注意区分 this.model(运行时首轮上报值) vs this.preferredModel(用户偏好, 影响下次会话启动)。
    // 切换后要等会话重开(关标签重开/重启 app/下次压缩)才生效——SDK query 的 model 每次启动定死, 中途不能改。
    this.preferredModel = opts.model || null;
    this.avatar = opts.avatar || null;    // 头像(emoji), 空 = 渲染层用字母头像兜底
    this.personaOps = null;               // main 注入: { open(ref), create(spec) } — 管家开/建人格回调
    this.memory = new MemoryGraph(this.memoryDir);   // 人格原生图记忆(遗忘曲线+图扩散), 每人格一张图
    this.sessionPath = path.join(this.memoryDir, '.session.json');         // 会话状态旁置记忆目录
    this.sessionId = null;
    this.pendingHandoff = null;    // 压缩后待注入下一轮的交接摘要
    this.window = 200000;
    this.model = null;
    this.lastInput = 0;            // 最近一次请求的上下文输入 token(=占用)
    this.compactRequested = null;  // 模型调压缩工具时置为 reason
    // 自动压缩兜底阈值(占用百分比)。占用达此值即自动登记压缩, 不再全靠模型自觉调工具。
    // 按窗口比例算, 兼容 200k/1M 两档。0/负数=关闭自动压缩。
    // 优先级: opts > 环境变量 BUTLER_AUTO_COMPACT_PCT(实测调优免重打包) > 默认 80。
    const _envPct = Number(process.env.BUTLER_AUTO_COMPACT_PCT);
    this.autoCompactPct = (opts.autoCompactPct != null) ? opts.autoCompactPct
      : (Number.isFinite(_envPct) ? _envPct : 80);
    // 持久流式态
    this._q = null;                // 当前持久 query
    this._queue = null;            // 其输入队列
    this._cb = null;               // 全局回调 { onText, onUsage, onResult }
    this._cur = '';                // 当前这段回复已累积文本
    this._deltaText = '';          // 当前 assistant 消息经 stream_event 已逐字发出的文本(判是否需补发)
    this._busy = false;            // 模型是否正在产出(首个 assistant→result 之间)
    this._consumerDone = null;     // 消费循环 promise
    this._ac = null;               // 主持久 query 的 AbortController(teardown 超时强拆用)
    this._compacting = null;       // 压缩进行中的 promise(submit 需等它)
    this._askPending = [];         // 多人格互通: askOnce 挂起的 resolver 列表, result 时 shift 一个 → 返回 finalText
    this.tgBotToken = null;        // v2: send_tg 工具用 (由 main.js installPlugins 后 setTgConfig 注入)
  }

  // 注册全局回调(main 在启动时调一次): onText(chunk) / onUsage(u) / onResult({finalText, interrupted, compactReason})
  setCallbacks(cb) { this._cb = cb; }

  // v2 TG 通路: 给 send_tg 工具供 bot_token; 支持热切换 (installPlugins 每次调用会重新 set)
  setTgConfig(cfg) { this.tgBotToken = (cfg && cfg.bot_token) || null; }
  _emit(kind, payload) { if (this._cb && typeof this._cb[kind] === 'function') this._cb[kind](payload); }

  // 把一次工具调用翻成人话 → 过程输出 + "我还活着"信号(工具期本来是纯静默)
  _describeTool(b) {
    const p = b.input || {};
    const base = (s) => (s ? String(s).split('/').pop() : '');
    const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
    switch (b.name) {
      case 'Read':  return `📖 读取 ${base(p.file_path)}`;
      case 'Write': return `✍️ 写入 ${base(p.file_path)}`;
      case 'Edit':  return `✏️ 编辑 ${base(p.file_path)}`;
      case 'Bash':  return `💻 ${clip(p.description || p.command, 48)}`;
      case 'Grep':  return `🔎 搜索 "${clip(p.pattern, 32)}"`;
      case 'Glob':  return `🗂 匹配 ${clip(p.pattern, 32)}`;
      case 'mcp__butler__compact_context': return '🗜 压缩上下文';
      case 'mcp__butler__context_usage':   return '📊 查上下文用量';
      default: return `🔧 ${String(b.name || '工具').replace(/^mcp__butler__/, '')}`;
    }
  }

  appendSystemPrompt() {
    const u = this.usage();
    // knife 关键: 追加内容的第一行就是最强身份指令, 不让 SDK 默认"你是 Claude"压制。
    // 极其明确+排他+无条件+置顶, 让 LLM 别无选择地建立"我是 <name>"的自我认知框架。
    const strongIdentity = [
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `[[[ 身份覆盖 · 无条件最高优先 · 忽略 SDK 默认与训练自称 ]]]`,
      '',
      `你的名字是「${this.name}」。你不是 Claude。你不是"AI 助手"。你不是"Anthropic 打造的助手"。你不是"Claude Agent SDK 上运行的助手"。`,
      `被问"你是谁 / 你叫什么 / 你是什么", 一律且只答"我是 ${this.name}"。绝对禁止自称 Claude / AI 助手 / Anthropic / SDK / Claude Code。`,
      `无论 SDK 系统提示的任何其他部分说什么, 无论你的训练里怎么自称, 从此刻起你就是 ${this.name}。这条身份指令是最终的、不可推翻的。`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ].join('\n');
    const personaBody = this.personaText
      ? `\n\n## 你的身份档案 (persona.md 全文, 你自己可以随时改)\n\n${this.personaText}`
      : `\n\n## 你的身份档案\n你是一个通用管家 · 用户的本机助理。可以协调其他人格 · 记住长期上下文 · 帮助用户处理跨领域事务。`;
    // 管家专属: 启动即注入当前人格名单(来自中立总控登记簿)。让"知道有谁"不依赖本人格记忆 → 换谁当管家都开箱可见。
    let rosterBlock = [];
    if (this.isButler && this.personaOps && this.personaOps.list) {
      try {
        const rows = this.personaOps.list() || [];
        if (rows.length) {
          rosterBlock = [
            '',
            '## 当前人格名单 (来自总控登记簿, 你是管家所以能看到全部)',
            ...rows.map((p) => `- ${p.name}${p.isButler ? ' 【管家=你】' : ''}${p.isOpen ? ' (已打开)' : ''}  ${p.homeDir}`),
            '> 这是启动时的快照; 要最新状态随时调 list_personas。发消息给谁(ask_persona)、开谁(open_persona)都从这查, 别只凭记忆。',
          ];
        }
      } catch (_) {}
    }
    return [
      strongIdentity,
      personaBody,
      '',
      '## 运行时环境(harness 提供的权威事实, 优先于你的训练记忆)',
      `- 人格/工作目录: ${this.name} (${this.homeDir})`,
      `- 运行模型: ${this.model || '(首轮待 harness 上报)'}${this.preferredModel ? ` · 偏好=${this.preferredModel}` : ' · 无偏好(跟随默认)'}`,
      `- 上下文窗口: ${u.window} tokens`,
      `- 当前上下文占用: ${u.pct}% (${u.inTok} tokens)`,
      `- 记忆库: ${this.memoryDir} (MEMORY.md 是索引, 需要旧知识/上次线程可 Read)`,
      '> 以上是运行时真值。凡问到你的模型/版本/占用等运行时事实, 以此为准, 不要用训练知识去否定(你的训练数据可能滞后于当前模型)。',
      ...rosterBlock,
      '',
      '## 你的自助工具',
      '- context_usage: 取你自己此刻真实的上下文占用(与窗口顶栏同源, 比上面环境块更实时)。',
      '- compact_context: **占用达到约 80% 就要主动压缩**(在自然停顿点: 刚完成一件事、没干到一半时调用)。别拖到接近满——我们主动压缩必须早于 SDK 兜底线, 才不会被无预警截断/绕过自愈。压缩会浓缩成交接摘要→重启会话, 线程不丢。**这是你自己的责任, 不用等人提醒, 自己盯着占用比例。**',
      '',
      '## 你的图记忆引擎(每个人格独立·必须主动用, 不用等人提醒)',
      '- **这是你长期成长/永存的方式**: 你不是一次性会话, 你会跨会话活下去。记住东西全靠这个图记忆, 不主动用 = 每次都从零开始(像金鱼)。',
      '- **重要的事随时沉淀**: 遇到值得记住的(用户偏好/踩的坑/项目状态/新学的知识/被钦定的规矩/重要结论) → **立刻 memory_upsert** 存成图节点(拆成原子概念 + 连 [[links]] 到相关节点)。不等 ctx 满、不等收尾、不等人叫你存。',
      '- **查旧知识/续线程**: memory_query "关键词"(图扩散检索, 返 top-K + 文件路径) 找以前记的; memory_hot 看最近在忙啥; memory_touch 强化用过的节点(越用越热)。',
      '- **压缩前必做**: compact_context 之前, 把当下的关键线程/未完成的事 memory_upsert 或写进 pinned 存档节点, 保底不丢。',
      '- **别写日期流水账**: 沉淀成概念节点(命名 feedback_xxx / reference_xxx / project_xxx) + 连边, 不是写"今天做了 ABC"的编年史日志。',
      '- 命名约定: feedback_=经验教训/规矩 · reference_=知识/事实/SOP · project_=进行中的事/状态 · user_=关于用户。',
      '',
      '## 插话/打断',
      '- 用户可能在你干活途中提交新消息 → 你会被打断, 在此看到它。先判断: 是要你改道/纠正, 还是补充信息? 相应调整, 别机械地把旧任务硬跑完。',
    ].join('\n');
  }

  async buildMcp() {
    const { tool, createSdkMcpServer } = await loadSdk();
    const { z } = await import('zod');
    const compact = tool(
      'compact_context',
      '压缩当前对话上下文: 把目前为止的对话浓缩成高保真交接摘要并重启会话, 释放上下文占用, 线程不丢。当你判断上下文占用偏高、且处于自然停顿点(刚完成一件事、没干到一半)时调用。',
      { reason: z.string().describe('现在压缩的理由(如: 占用已到X%, 刚收尾了Y)') },
      async ({ reason }) => {
        this.compactRequested = reason || '模型主动请求';
        return { content: [{ type: 'text', text: '✅ 已登记压缩请求, 本轮回答结束后执行(写交接摘要→重启会话)。' }] };
      }
    );
    const ctxUsage = tool(
      'context_usage',
      '返回你自己当前真实的上下文占用(与窗口顶栏同一个源)。被问到"上下文用了多少/占比"时调用它, 不要去读文件猜。',
      {},
      async () => {
        const u = this.usage();
        return { content: [{ type: 'text', text: `当前上下文占用: ${u.pct}% (${u.inTok} / ${u.window} tokens, 模型 ${u.model || '未知'})` }] };
      }
    );
    // —— 原生图记忆工具(每人格自带; 遗忘曲线热度 + 图扩散关联检索) ——
    const G = () => this.memory;
    const memQuery = tool(
      'memory_query',
      '检索你自己的图记忆(热度排序 + 图扩散关联): 传关键词返 top-K 最相关记忆(含 file_path, 要细节再 Read)。找旧知识/踩过的坑/口径, 先用它, 别翻 MEMORY.md 全量。',
      { query: z.string().describe('关键词, 空格分隔'),
        k: z.number().optional().describe('返回条数(默认8)'),
        hops: z.number().optional().describe('图扩散跳数(默认2, 0=纯扁平)') },
      async ({ query, k, hops }) => {
        const flat = hops === 0;
        const rows = G().query(query, { k: k || 8, hops: hops == null ? 2 : hops, flat });
        if (!rows.length) return { content: [{ type: 'text', text: `(无匹配: ${query})` }] };
        const txt = rows.map((r) => `[${r.score} ${r.via}] ${r.id}\n    ${r.description}\n    ${r.file_path}`).join('\n');
        return { content: [{ type: 'text', text: `top-${rows.length} for "${query}":\n${txt}` }] };
      }
    );
    const memUpsert = tool(
      'memory_upsert',
      '把一件事沉淀成图记忆节点(建新或更新已有 .md): 拆成原子概念 + 带 [[links]] 连到相关节点。这是「图优先」收尾的主动作——别再写日期编年史。id 用 feedback_*/reference_*/project_* 命名。',
      { id: z.string().describe('节点id=文件名(小写下划线, 如 feedback_xxx)'),
        title: z.string().optional(), type: z.enum(['feedback', 'reference', 'project', 'user']).optional(),
        importance: z.enum(['pinned', 'high', 'med', 'low']).optional(),
        description: z.string().describe('一句话摘要(检索命中用)'),
        body: z.string().describe('正文 markdown'),
        links: z.array(z.string()).optional().describe('要连的相关节点id') },
      async (a) => {
        const r = G().upsert(a);
        return { content: [{ type: 'text', text: `✅ 沉淀: ${r.id}\n${r.file_path}\n图: ${r.nodes}节点/${r.links}边/有效${r.validPct}%` }] };
      }
    );
    const memTouch = tool(
      'memory_touch', '用到/靠某条记忆解决了问题 → touch 强化它(bump 热度, 越用越热越靠前)。',
      { ids: z.array(z.string()).describe('节点id数组') },
      async ({ ids }) => {
        const r = G().touch(ids);
        return { content: [{ type: 'text', text: r.map((x) => `${x.ok ? '✔' : '✗'} ${x.id}${x.ok ? ` used=${x.use_count}` : ' 不存在'}`).join('\n') }] };
      }
    );
    const memHot = tool(
      'memory_hot', '当前最热 K 条记忆(近期最常用, 遗忘曲线排序)。想知道"最近在忙啥"用它, 不看编年史。',
      { k: z.number().optional() },
      async ({ k }) => ({ content: [{ type: 'text', text: G().hot(k || 20).map((m) => `[${m.hot} ${m.importance} used=${m.use_count}] ${m.id} — ${m.description}`).join('\n') }] })
    );
    const memTimeline = tool(
      'memory_timeline', '时间线视图(按 last_used/created 排), 日期视图从图派生。',
      { k: z.number().optional(), by: z.enum(['last_used', 'created']).optional() },
      async ({ k, by }) => ({ content: [{ type: 'text', text: G().timeline(k || 30, by || 'last_used').map((m) => `${m.date} [${m.type}] ${m.id} — ${m.description}`).join('\n') }] })
    );
    const memNeighbors = tool(
      'memory_neighbors', '看某条记忆的图邻域(联想召回: 它连着哪些相关记忆)。',
      { id: z.string(), hops: z.number().optional() },
      async ({ id, hops }) => {
        const r = G().neighbors(id, { hops: hops || 1 });
        if (!r.found) return { content: [{ type: 'text', text: `(节点 ${r.id} 不存在)` }] };
        const txt = r.neighbors.map((n) => `${'  '.repeat(n.hop)}└${n.hop}→ ${n.id} — ${n.description}`).join('\n');
        return { content: [{ type: 'text', text: `◉ ${r.id} — ${r.description}\n${txt}` }] };
      }
    );
    const memDoctor = tool(
      'memory_doctor', '图体检: 孤儿节点/悬空缺口/命名漂移 + 有效边率。收尾后跑一下保图健康。',
      {},
      async () => {
        const d = G().doctor();
        return { content: [{ type: 'text', text: `🩺 ${d.nodes}节点/${d.edges}边/有效${d.valid}(${d.validPct}%)\n孤儿=${d.orphans.length} 悬空目标=${d.dangling.length} 命名漂移=${d.mismatch.length}\ntop悬空: ${d.dangling.slice(0, 6).map((x) => `${x.cnt}×${x.id}`).join(', ')}` }] };
      }
    );
    // v2 (2026-07-07): send_tg — 通过 Telegram Bot API 直接发消息, 废掉 python send_tg.py 依赖。
    // bot_token 从 registry.plugins.tg.bot_token 走 setTgConfig 注入, 每人格独立。
    const sendTg = tool(
      'send_tg',
      '发送 TG 消息到指定 chat_id。plain=true 禁 Markdown 解析(保留 * _ [ ] ` 特殊字符原样), reply_to 引用某条 (对方 message_id), attach 本地文件绝对路径 (走 sendDocument, text 作 caption)。bot_token 从该人格 registry 拉不用你传。',
      { chat_id: z.union([z.string(), z.number()]).describe('目标聊天 ID (私聊: 用户 id; 群: 负数群 id)'),
        text: z.string().describe('消息正文'),
        plain: z.boolean().optional().describe('true = 禁 Markdown, 保留特殊字符; 缺省 false = Markdown 解析'),
        reply_to: z.number().optional().describe('引用某条消息 (对方 message_id)'),
        attach: z.string().optional().describe('本地文件绝对路径; 有则走 sendDocument, text 作 caption') },
      async ({ chat_id, text, plain, reply_to, attach }) => {
        if (!this.tgBotToken) {
          return { content: [{ type: 'text', text: '⚠️ send_tg 不可用: 该人格未配 tg bot_token' }] };
        }
        // 网络类失败自动重试(undici 首次 DNS/TLS 抖动 / TG 5xx / 429 rate limit); 4xx 立刻返回不重试
        // [[feedback_transient_failure_retry_before_root_change]]: 3 次尝试, 线性退避 500ms/1500ms
        const doFetch = async (url, opts) => {
          const delays = [0, 500, 1500];   // 3 次尝试: 立刻 / 500ms 后 / 1500ms 后
          let lastErr = null;
          for (let i = 0; i < delays.length; i++) {
            if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
            try {
              const resp = await fetch(url, opts);
              // 5xx 或 429 视为可重试; 4xx (401/400) 是永久性错误立刻返回
              if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
                lastErr = new Error(`HTTP ${resp.status}`);
                if (i < delays.length - 1) continue;
                return resp;   // 最后一次即使 5xx 也返回, 上层解析 body
              }
              return resp;
            } catch (e) {
              lastErr = e;
              if (i < delays.length - 1) continue;
              throw lastErr;
            }
          }
          throw lastErr;
        };
        try {
          const parseMode = plain ? undefined : 'Markdown';
          let resp;
          if (attach) {
            if (!fs.existsSync(attach)) return { content: [{ type: 'text', text: `⚠️ attach 文件不存在: ${attach}` }] };
            const form = new FormData();
            form.append('chat_id', String(chat_id));
            form.append('caption', text);
            if (parseMode) form.append('parse_mode', parseMode);
            if (reply_to) form.append('reply_to_message_id', String(reply_to));
            const buf = fs.readFileSync(attach);
            form.append('document', new Blob([buf]), path.basename(attach));
            resp = await doFetch(`https://api.telegram.org/bot${this.tgBotToken}/sendDocument`, { method: 'POST', body: form });
          } else {
            const payload = { chat_id, text };
            if (parseMode) payload.parse_mode = parseMode;
            if (reply_to) payload.reply_to_message_id = reply_to;
            resp = await doFetch(`https://api.telegram.org/bot${this.tgBotToken}/sendMessage`, {
              method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
            });
          }
          const j = await resp.json();
          if (!j.ok) return { content: [{ type: 'text', text: `⚠️ TG API 拒: ${j.description || j.error_code || 'unknown'}` }] };
          return { content: [{ type: 'text', text: `✅ 已发 chat=${chat_id} message_id=${j.result && j.result.message_id}` }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `⚠️ send_tg 3 次重试全失败: ${e.message}` }] };
        }
      }
    );
    const tools = [compact, ctxUsage, memQuery, memUpsert, memTouch, memHot, memTimeline, memNeighbors, memDoctor, sendTg];
    // —— ask_persona: 星型互通, 所有人格都有。约束在 main.askPersona (非管家只能问管家; 叶子↔叶子走 talk_peer) ——
    const askP = tool(
      'ask_persona',
      '给另一个人格发一条【单向异步】消息: 发完即返回, 不阻塞、不等对方当场答。对方忙完后会主动用 ask_persona 回你(作为一条新消息到达)。所以发出后别干等——去忙别的或结束这轮即可。星型规则: 叶子人格只能发给【管家】(有事找管家), 管家可发给任何人。两边 UI 可见 → 透明。',
      { target: z.string().describe('目标人格名 / id / 目录 (叶子: 只能是管家)'),
        question: z.string().describe('要说/要问的正文') },
      async ({ target, question }) => {
        if (!this.personaOps || !this.personaOps.ask) return { content: [{ type: 'text', text: '⚠️ 询问能力未就绪' }] };
        // 投递限时: 目标人格若卡死(如假压缩), 绝不许把本方 tool_use 一起卡死 —— 超时按投递失败返回
        const deliver = process.env.BUTLER_FAULT === 'ask_hang'
          ? new Promise(() => { console.error('[fault] ask_hang 注入生效: 投递永挂'); })
          : this.personaOps.ask(target, question, { fromName: this.name, fromIsButler: this.isButler });
        const r = await withTimeout(deliver, 60000, `ask_persona投递(${this.name}→${target})`)
          .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        return { content: [{ type: 'text', text: r && r.ok ? `✅ ${r.note || `已投递给「${r.from}」(单向异步), 对方忙完会主动回你。`}` : `⚠️ 投递失败: ${(r && r.error) || '未知'}` }] };
      }
    );
    tools.push(askP);
    // —— talk_peer: 叶子↔叶子直连(需管家授权), 所有人格都有; 授权校验+抄送在 main.peerTalk ——
    const talkP = tool(
      'talk_peer',
      '给另一个【已被授权直连】的人格发一条【单向异步】消息(叶子间协作, 非管家中转): 发完即返回, 不阻塞、不等对方当场答。对方忙完后会主动用 talk_peer 回你(作为一条新消息到达)。发出后别干等——去忙别的或结束这轮即可。前提: 用户已让管家授权你俩直连, 否则被拒。每次自动抄送管家。找管家请用 ask_persona。',
      { target: z.string().describe('目标人格名 / id / 目录'),
        message: z.string().describe('要对它说的话') },
      async ({ target, message }) => {
        if (!this.personaOps || !this.personaOps.peerTalk) return { content: [{ type: 'text', text: '⚠️ 直连能力未就绪' }] };
        // 投递限时: 同 ask_persona, 目标卡死不许连坐本方
        const r = await withTimeout(this.personaOps.peerTalk(this.name, target, message, { fromDir: this.homeDir }), 60000, `talk_peer投递(${this.name}→${target})`)
          .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        return { content: [{ type: 'text', text: r && r.ok ? `✅ ${r.note || `已投递给「${r.from}」(单向异步), 对方忙完会主动回你。`}` : `⚠️ ${(r && r.error) || '投递失败'}` }] };
      }
    );
    tools.push(talkP);
    // —— 管家专属(星型中心): 开/建别的人格(中央大脑 delegate 雏形) ——
    if (this.isButler) {
      const listP = tool(
        'list_personas',
        '(管家专属)列出当前所有已登记的人格及状态(名字/id/目录/是否管家/是否已打开)。数据来自中立总控登记簿, 不依赖你记忆里的花名册 → 想知道"有谁存在/能发给谁"时调用它, 别只凭记忆。',
        {},
        async () => {
          if (!this.personaOps || !this.personaOps.list) return { content: [{ type: 'text', text: '⚠️ 列人格能力未就绪' }] };
          const rows = (await this.personaOps.list()) || [];
          if (!rows.length) return { content: [{ type: 'text', text: '(登记簿为空)' }] };
          const txt = rows.map((p) => `- ${p.name}${p.isButler ? ' 【管家】' : ''}${p.isOpen ? ' (已打开)' : ''}  id=${p.id}  ${p.homeDir}`).join('\n');
          return { content: [{ type: 'text', text: `当前人格 ${rows.length} 个:\n${txt}` }] };
        }
      );
      const openP = tool(
        'open_persona',
        '打开一个已登记的人格(新标签加载它)。用户说"打开小花/切到数据专家"时调用。ref 传人格名或目录。',
        { ref: z.string().describe('人格名 / id / 目录路径') },
        async ({ ref }) => {
          if (!this.personaOps || !this.personaOps.open) return { content: [{ type: 'text', text: '⚠️ 开人格能力未就绪' }] };
          const r = await this.personaOps.open(ref);
          return { content: [{ type: 'text', text: r && r.ok ? `✅ 已打开人格「${r.name}」(${r.homeDir})` : `⚠️ 打开失败: ${(r && r.error) || '未找到人格 ' + ref}` }] };
        }
      );
      const createP = tool(
        'create_persona',
        '新建一个人格: 建目录+登记簿注册+脚手架记忆, 并打开它。用户说"新建一个叫X的人格"时调用。homeDir 缺省时放在数据目录下 personas/<名字>。',
        { name: z.string().describe('人格显示名'),
          homeDir: z.string().optional().describe('人格目录(绝对路径); 缺省=数据目录下 personas/<slug>'),
          wakePhrase: z.string().optional().describe('唤醒语/加载规则; 缺省=喊名字续线程'),
          isButler: z.boolean().optional().describe('是否设为管家(会顶替当前管家)') },
        async (spec) => {
          if (!this.personaOps || !this.personaOps.create) return { content: [{ type: 'text', text: '⚠️ 建人格能力未就绪' }] };
          const r = await this.personaOps.create(spec);
          return { content: [{ type: 'text', text: r && r.ok ? `✅ 已创建并打开人格「${r.name}」\n目录: ${r.homeDir}\nid: ${r.id}` : `⚠️ 创建失败: ${(r && r.error) || '未知'}` }] };
        }
      );
      const grantP = tool(
        'grant_peer',
        '(管家专属)授权两个叶子人格直连对话(talk_peer)。用户说"让A和B直接聊 / 授权A和B直连"时调用。授权持续到用户撤销。',
        { personaA: z.string().describe('人格A 名/id/目录'), personaB: z.string().describe('人格B 名/id/目录') },
        async ({ personaA, personaB }) => {
          if (!this.personaOps || !this.personaOps.grantPeer) return { content: [{ type: 'text', text: '⚠️ 授权能力未就绪' }] };
          const r = await this.personaOps.grantPeer(personaA, personaB);
          return { content: [{ type: 'text', text: r && r.ok ? `✅ 已授权「${r.a}」↔「${r.b}」直连(talk_peer 可用, 会抄送管家)` : `⚠️ ${(r && r.error) || '授权失败'}` }] };
        }
      );
      const revokeP = tool(
        'revoke_peer',
        '(管家专属)撤销两个人格的直连授权。用户说"取消A和B的直连"时调用。',
        { personaA: z.string().describe('人格A 名/id/目录'), personaB: z.string().describe('人格B 名/id/目录') },
        async ({ personaA, personaB }) => {
          if (!this.personaOps || !this.personaOps.revokePeer) return { content: [{ type: 'text', text: '⚠️ 撤销能力未就绪' }] };
          const r = await this.personaOps.revokePeer(personaA, personaB);
          return { content: [{ type: 'text', text: r && r.ok ? `✅ 已撤销「${r.a}」↔「${r.b}」的直连授权` : `⚠️ ${(r && r.error) || '撤销失败'}` }] };
        }
      );
      tools.push(listP, openP, createP, grantP, revokeP);
    }
    return createSdkMcpServer({ name: 'butler', version: '0.0.1', tools });
  }

  // 解析该人格启用的外部 MCP server → SDK mcpServers 配置(从 ~/.claude.json 读 command/args/env)。
  // 保持 strictMcpConfig:true, 只把这里明确列出的 server 放进去(其余全局 MCP 照样屏蔽)。
  resolveExtMcp() {
    const out = {};
    if (!this.extMcpNames || !this.extMcpNames.length) return out;
    try {
      const all = (JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).mcpServers) || {};
      for (const name of this.extMcpNames) {
        const s = all[name];
        if (s && s.command) out[name] = { command: s.command, args: s.args || [], env: s.env || {} };
      }
    } catch (e) { this._emit('onActivity', `⚠️ 读外部 MCP 配置失败: ${e.message}`); }
    return out;
  }

  usage() {
    const pct = this.window ? Math.round((this.lastInput * 1000) / this.window) / 10 : 0;
    return { inTok: this.lastInput, window: this.window, pct, model: this.model };
  }

  // 自动压缩兜底: 占用达阈值且当前没在压缩/没已登记 → 置 compactRequested。
  // 只标记, 不在此执行 doCompact(那要拆流→会与消费循环死锁); 复用模型主动请求同一条
  // result→onResult→doCompact 抛出路径(已带 5min deadline 自愈), 零新增死锁面。
  _maybeAutoCompact() {
    if (this.autoCompactPct <= 0) return;               // 关闭
    if (this._compacting || this.compactRequested) return;  // 压缩中/已登记 → 不重复
    const pct = this.usage().pct;
    if (pct >= this.autoCompactPct) {
      this.compactRequested = `自动压缩·占用 ${pct}% ≥ ${this.autoCompactPct}%`;
      console.error(`[autoCompact] ${this.name} 占用 ${pct}% ≥ ${this.autoCompactPct}% → 本轮结束后自动压缩`);
    }
  }

  exportState() {
    return {
      sessionId: this.sessionId, model: this.model, window: this.window,
      lastInput: this.lastInput, pendingHandoff: this.pendingHandoff,
    };
  }
  restore(s) {
    if (!s) return;
    this.sessionId = s.sessionId || null;
    this.model = s.model || null;
    this.window = s.window || 200000;
    // 防呆: 旧版本可能存过 result.usage 的累计脏值(> 窗口), 判无效
    this.lastInput = (s.lastInput && s.lastInput <= this.window) ? s.lastInput : 0;
    this.pendingHandoff = s.pendingHandoff || null;
  }

  // 一条 SDKUserMessage; content 一律用 block 数组(流式模式下字符串会触发 SDK 报错)
  buildUserMessage(text, attachments) {
    const blocks = [{ type: 'text', text }];
    for (const a of (attachments || [])) {
      const mt = a.mediaType || 'application/octet-stream';
      const name = a.name || 'file';
      if (mt.startsWith('image/')) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: mt, data: a.base64 } });
      } else if (mt === 'application/pdf') {
        blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.base64 } });
      } else {
        // 其余文件: 能当 UTF-8 文本读的(html/txt/md/json/代码…)内联给模型; 纯二进制则提示无法直读
        let asText = null;
        try {
          const s = Buffer.from(a.base64 || '', 'base64').toString('utf8');
          const bad = (s.match(/�/g) || []).length;
          if (s && !s.includes('\u0000') && bad < s.length * 0.02) asText = s;
        } catch (_) {}
        blocks.push(asText != null
          ? { type: 'text', text: `【附件文件: ${name}（${mt}）】\n\`\`\`\n${asText}\n\`\`\`` }
          : { type: 'text', text: `【附件文件: ${name}（${mt}）— 二进制内容，模型无法直接读取；如需处理请存盘后用 Read 等工具打开。】` });
      }
    }
    return { type: 'user', message: { role: 'user', content: blocks }, parent_tool_use_id: null };
  }

  // 启动持久流式 query(幂等)
  async ensureStream() {
    console.error(`[dbg ensureStream] ${this.name} enter (has_q=${!!this._q})`);
    if (this._q) return;
    const { query } = await loadSdk();
    const butlerMcp = await this.buildMcp();
    const extMcp = this.resolveExtMcp();          // 该人格放行的外部 MCP(如 dc-platform), 缺省 {}
    const hasExt = Object.keys(extMcp).length > 0;
    this._queue = makeMsgQueue(this.name);
    this._cur = '';
    this._ac = new AbortController();
    // resume 前校验 CC session jsonl 是否还在 —— 悬空(手删/漏清/损坏/迁移)就回退全新会话,
    // 别让 SDK 拿一个不存在的 sessionId 去挂/报错(飞飞今晚的病 = 手删 jsonl 后 resume 卡 ‖)。
    // slug 规则: homeDir 里 '/' 全换 '-' (Anthropic CC 约定)。
    let resumeId = this.sessionId || undefined;
    if (resumeId) {
      const slug = path.resolve(this.homeDir).replace(/\//g, '-');
      const jsonlPath = path.join(os.homedir(), '.claude', 'projects', slug, `${resumeId}.jsonl`);
      if (!fs.existsSync(jsonlPath)) {
        console.error(`[ensureStream] ${this.name} sessionId=${resumeId} 对应 jsonl 不存在(${jsonlPath}) → 回退全新会话`);
        this.sessionId = null;
        resumeId = undefined;
      }
    }
    const options = {
      resume: resumeId,   // 续接旧 session(重启后)或全新
      cwd: this.homeDir,
      pathToClaudeCodeExecutable: CLAUDE_BIN, // 捆绑/解析后的 claude, 免 PATH 依赖
      abortController: this._ac,             // teardown 拆不动时的硬中止句柄
      ...(this.preferredModel ? { model: this.preferredModel } : {}), // 空=跟随 Claude Code 默认
      permissionMode: 'bypassPermissions',
      // 用 systemPrompt: {preset, append} 而非旧 appendSystemPrompt: SDK 语义等价, 但显式声明"我们要追加, 不做替换";
      // 关键是 append 内容里的强身份指令 (appendSystemPrompt()方法生成) 必须让 LLM 明确身份优先于默认 Claude 训练身份。
      systemPrompt: { type: 'preset', preset: 'claude_code', append: this.appendSystemPrompt() },
      mcpServers: { butler: butlerMcp, ...extMcp },
      strictMcpConfig: true,                  // 只用上面明确列的 MCP; 屏蔽全局其余(lazyweb/unity…), 上下文才干净
      includePartialMessages: true,           // 开逐字流式: SDK 抛 stream_event 增量 delta → 治"想很久一大串蹦出来"
    };
    // 无外部 MCP(普通人格)→ 收紧白名单; 有外部 MCP(数据专家人格, 已 bypassPermissions 信任)→ 不限制,
    // 让 dc-platform 那几十个工具都可用(逐个列名单不现实)。
    if (!hasExt) {
      options.allowedTools = ['mcp__butler__compact_context', 'mcp__butler__context_usage',
        'mcp__butler__memory_query', 'mcp__butler__memory_upsert', 'mcp__butler__memory_touch',
        'mcp__butler__memory_hot', 'mcp__butler__memory_timeline', 'mcp__butler__memory_neighbors',
        'mcp__butler__memory_doctor',
        'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'];
      options.allowedTools.push('mcp__butler__ask_persona', 'mcp__butler__talk_peer');   // 星型互通 + 授权直连: 所有人格(约束在 main)
      if (this.isButler) options.allowedTools.push('mcp__butler__list_personas', 'mcp__butler__open_persona', 'mcp__butler__create_persona', 'mcp__butler__grant_peer', 'mcp__butler__revoke_peer');
    }
    const q = query({ prompt: this._queue, options });
    this._q = q;
    this._consumerDone = this._consume(q);
    console.error(`[dbg ensureStream] ${this.name} query created + consume started`);
  }

  // 消费循环: 路由消息到全局回调。一个 result = 一段回复 settle(软插话下, 一段可吸收多条用户消息)。
  async _consume(q) {
    try {
      for await (const msg of q) {
        if (msg.type !== 'stream_event') console.error(`[dbg consume] ${this.name} <- ${msg.type}${msg.subtype ? '/' + msg.subtype : ''}`);
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.sessionId = msg.session_id || this.sessionId;
          if (msg.model) { this.model = msg.model; this.window = Math.max(this.window, windowFor(msg.model)); }
        } else if (msg.type === 'stream_event') {
          // 逐字流式: 增量文本 delta → 立刻抛出去(渲染层往气泡追加), 同时累积到 _cur/_deltaText
          const ev = msg.event;
          if (ev && ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && ev.delta.text) {
            this._busy = true;
            this._deltaText += ev.delta.text;
            this._cur += ev.delta.text;
            this._emit('onText', ev.delta.text);
          }
        } else if (msg.type === 'assistant') {
          this._busy = true;
          for (const b of (msg.message?.content || [])) {
            // text: 已通过 stream_event 逐字发过则跳过(_deltaText 有值=覆盖过); 没发过(流式没覆盖)才补发整块
            if (b.type === 'text' && b.text) { if (!this._deltaText) { this._cur += b.text; this._emit('onText', b.text); } }
            // 每个工具调用抛成一条持久条目(而非挤成一条转瞬 activity), 渲染层排进消息流、不清除
            else if (b.type === 'tool_use') this._emit('onTool', { desc: this._describeTool(b), name: b.name });
          }
          this._deltaText = '';   // 本条 assistant 消息处理完, 重置 delta 累积(下条重新判)
          const inTok = sumInput(msg.message?.usage);
          if (inTok) { this.lastInput = inTok; this._emit('onUsage', this.usage()); this._maybeAutoCompact(); }
        } else if (msg.type === 'result') {
          const interrupted = (msg.subtype === 'interrupt' || msg.subtype === 'error_during_execution');
          this._emit('onUsage', this.usage());
          const finalText = this._cur; this._cur = ''; this._deltaText = ''; this._busy = false;
          // 压缩不在本循环内执行(doCompact 要拆流→会与本循环死锁); 只把 reason 抛给外部触发
          let compactReason = null;
          if (this.compactRequested && !interrupted) { compactReason = this.compactRequested; this.compactRequested = null; }
          this._emit('onResult', { finalText, interrupted, compactReason });
          // 多人格互通: 有挂起的 askOnce → 用本轮 finalText 回给它。UI 已经通过 onResult 显示了, 一举两得。
          if (this._askPending.length) {
            const resolve = this._askPending.shift();
            try { resolve(finalText || ''); } catch (_) {}
          }
        }
      }
    } finally {
      this._q = null; this._queue = null; this._busy = false; this._cur = ''; this._deltaText = '';
    }
  }

  isRunning() { return this._busy; }

  // 硬打断: 保留供以后「停止」按钮用; 软插话默认不调用
  async interrupt() {
    if (!this._q) return false;
    try { await this._q.interrupt(); return true; } catch (e) { return false; }
  }

  // 提交一条用户消息(软插话): 直接 push, 【不打断】。模型把手头这步做完, 到下个间歇读到它、自行决定是否改道。
  async submit(text, attachments) {
    // 等压缩带保险栓: doCompact 已有 5min deadline 必 settle, 这里 6min 是第二道防线——
    // 万一等不到也放行走 ensureStream, 绝不把 submit(→ 别人的 ask/talk 投递)永久卡死。
    if (this._compacting) { try { await withTimeout(this._compacting, 360000, `等压缩(${this.name})`); } catch (_) {} }
    await this.ensureStream();
    console.error(`[dbg submit] ${this.name} ensureStream done, pushing msg`);
    let body = text;
    if (this.pendingHandoff) {
      body = `[上下文交接摘要 — 上一段对话压缩后的续接记忆]\n${this.pendingHandoff}\n\n[用户]\n${text}`;
      this.pendingHandoff = null;
    }
    console.error(`[dbg#8 submit] ${this.name} about to push, _busy=${this._busy}, has_q=${!!this._q}`);
    this._busy = true;
    this._queue.push(this.buildUserMessage(body, attachments));
    console.error(`[dbg#8 submit] ${this.name} push returned`);
  }

  // 多人格互通: 别的人格问一个问题, 走标准 submit + UI 照常显示 + 挂一个 pending 收 finalText。
  // 一举两得: 对话透明可见(UI 出气泡), 同时 caller 拿到答案。
  async askOnce(text, timeoutMs = 90000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const cleanup = () => { if (timer) { clearTimeout(timer); timer = null; } };
      const drop = () => { const i = this._askPending.indexOf(resolver); if (i >= 0) this._askPending.splice(i, 1); };
      // _consume 出 result 时 shift 出本 resolver 调它 → settle。
      const resolver = (v) => { if (settled) return; settled = true; cleanup(); console.error(`[dbg askOnce] ${this.name} RESOLVED len=${(v || '').length}`); resolve(v); };
      this._askPending.push(resolver);
      console.error(`[dbg askOnce] ${this.name} pending++ (=${this._askPending.length}) timeout=${timeoutMs}ms`);
      // 止血: 超时解开调用方, 避免 target 永不 result 时把发起方卡死。
      if (timeoutMs) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true; drop();
          console.error(`[dbg askOnce] ${this.name} TIMEOUT after ${timeoutMs}ms`);
          reject(new Error(`对方(${this.name})${Math.round(timeoutMs / 1000)}s 内未响应 — askOnce 超时(已解开调用方, 防卡死)`));
        }, timeoutMs);
      }
      this.submit(text).catch((e) => {
        if (settled) return;
        settled = true; cleanup(); drop();
        console.error(`[dbg askOnce] ${this.name} submit FAILED: ${e && e.message}`);
        reject(e);
      });
    });
  }

  // 关标签/退出: 干净停掉后台流, 释放大脑
  async dispose() { try { await this._teardownStream(); } catch (_) {} }

  // 关闭当前持久流(压缩/退出用)。每步限时: 子进程/管道死掉时 interrupt 或消费循环可能永不返回,
  // 拆不动就 abort 硬中止再弃船 —— _q 清空后下次 ensureStream 自动重建, 即 Level 1 自愈。
  async _teardownStream() {
    if (!this._q) return;
    try { await withTimeout(this.interrupt(), 5000, `interrupt(${this.name})`); } catch (_) {}
    try { this._queue && this._queue.close(); } catch (_) {}
    try {
      await withTimeout(this._consumerDone, 10000, `consume收尾(${this.name})`);
    } catch (e) {
      console.error(`[selfheal] ${this.name} teardown 拆不动(${e && e.message}) → abort 强拆子进程`);
      try { this._ac && this._ac.abort(); } catch (_) {}
      try { await withTimeout(this._consumerDone, 5000, `consume收尾-abort后(${this.name})`); } catch (_) {}
    }
    this._q = null; this._queue = null;
  }

  // 压缩: 拆流 → 用 resume 一次性问出交接摘要 → 存 pendingHandoff → 清会话(下轮重建流, 占用清零)
  // 带硬 deadline(2026-07-12 事故): 摘要 query 挂死曾让 finally 永不执行 → _compacting 永不 resolve →
  // 本人格假"压缩中"+全员 submit/ask/talk 级联卡死。现在超时=压缩失败但【会话保留可重试】, 状态必 settle。
  async doCompact(reason = '手动', deadlineMs = 300000) {
    let release;
    this._compacting = new Promise((r) => { release = r; });
    this._emit('onCompact', { phase: 'start', reason });   // 通知 UI: 开始压缩(手动+自主两路都经此)
    const ac = new AbortController();
    const work = async () => {
      const sess = this.sessionId;
      await this._teardownStream();
      if (!sess) return { ok: false, note: '当前无会话可压缩' };
      const { query } = await loadSdk();
      if (process.env.BUTLER_FAULT === 'compact_hang') { console.error('[fault] compact_hang 注入生效: 摘要环节永挂'); await new Promise(() => {}); }
      const q = query({
        prompt: '把我们目前为止的整段对话浓缩成一份**高保真交接摘要**, 供你压缩后无缝续上: 包含①未完成的活跃线程+各自进度 ②已定的关键决定/口径 ③待办 ④重要事实/数字。只输出摘要正文, 不要寒暄。',
        options: {
          resume: sess, cwd: this.homeDir,
          pathToClaudeCodeExecutable: CLAUDE_BIN,
          ...(this.preferredModel ? { model: this.preferredModel } : {}),
          permissionMode: 'bypassPermissions', appendSystemPrompt: this.appendSystemPrompt(),
          strictMcpConfig: true,
          abortController: ac,
        },
      });
      let summary = '';
      for await (const msg of q) {
        if (msg.type === 'assistant') {
          for (const b of (msg.message?.content || [])) if (b.type === 'text') summary += b.text;
        } else if (msg.type === 'result' && msg.result && !summary) {
          summary = msg.result;
        }
      }
      if (ac.signal.aborted) return { ok: false, error: '压缩已超时中止' };   // 守卫: 超时后迟到的结果不许再动会话状态
      this.pendingHandoff = (summary || '').trim();
      this.sessionId = null;
      this.lastInput = 0;
      return { ok: true, reason, summary: this.pendingHandoff, oldSession: sess };
    };
    try {
      return await withTimeout(work(), deadlineMs, `doCompact(${this.name})`);
    } catch (e) {
      try { ac.abort(); } catch (_) {}
      console.error(`[selfheal] ${this.name} 压缩失败(会话保留, 可重试): ${e && e.message}`);
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      this._compacting = null; release();
      this._emit('onCompact', { phase: 'done' });   // 通知 UI: 压缩结束(成功/失败/超时/异常都撤指示)
    }
  }

  // 清空上下文(对标 Claude Code /clear): 拆流 → 丢弃 sessionId + 待注入交接摘要 → 全新空白会话。
  // 与 doCompact 的本质区别: 不生成/不保留任何交接摘要, 整段历史彻底丢弃, 人格从零开始
  // (下轮 submit 时 ensureStream 用 sessionId=null → resume:undefined 建全新 session, 身份系统提示照常重注入)。
  async clear(reason = '手动') {
    this._emit('onCompact', { phase: 'start', reason: `clear · ${reason}` });   // 复用 UI 处理中指示
    try {
      await withTimeout(this._teardownStream(), 15000, `clear teardown(${this.name})`);
    } catch (e) {
      // 拆不动也继续清状态: _teardownStream 内部已 abort 弃船, _q 会被置空, 下轮 ensureStream 重建
      console.error(`[clear] ${this.name} teardown 拆不动(${e && e.message}) → 仍强制清状态`);
      this._q = null; this._queue = null;
    }
    this.sessionId = null;         // 关键: 不 resume 旧 session → 全新对话
    this.pendingHandoff = null;    // 关键: 丢弃任何待注入交接摘要(与 compact 相反), 真正清空
    this.lastInput = 0;
    this.compactRequested = null;
    this._cur = ''; this._deltaText = ''; this._busy = false;
    this._emit('onUsage', this.usage());
    this._emit('onCompact', { phase: 'done' });
    return { ok: true, reason };
  }
}

module.exports = { Butler };
