// agent 内核的模块级工具: 纯函数 + 常量, 不依赖 Butler 实例。
// 由 agent.js 拆出(内核抽包第 1 步), 逐字搬运。
const { paths } = require('../host');

// 记忆工具的多值参数一律收字符串再在这里切: 带 z.array 的参数会让模型的 tool 入参整个丢成 {}
// (记忆 #1305, 88k 次调用普查 —— 只有 links/ids 这两个数组参数在丢, 纯标量工具全零)。
const memSplitIds = (s) => (s ? s.split(/[\s,、]+/).filter(Boolean) : undefined);

// SDK 默认去 ~/.claude/local 找 claude; 打包版那里没有 → 显式指向捆绑的二进制(或系统安装位)。
const CLAUDE_BIN = paths.resolveClaudeBin();
// 强制沉淀的"新知识信号": 只认从外部世界取回信息的工具。
// 刻意不含 Read/Grep —— 读自己项目的文件是干活常态, 拿它当信号会天天误挡。宁可漏挡, 不可天天卡人。
const FORCE_SEDIMENT_TOOLS = /WebSearch|WebFetch/i;

// 「这一轮到底存没存东西」的判据。🔴 只认真正写库的那两个 —— query/hot/section/touch 都是读,
// 而读是每轮必做的动作(硬规矩 1), 把它们算进来的话「连续几轮没存」永远数不到 1, 提醒一次都发不出来。
// 漏存真正的样子是【查了一堆、一条没存】, 不是【什么都没碰】。
const MEMORY_WRITE_TOOLS = /^mcp__butler__memory_(upsert|write)$/;

// 工具入参会整个丢成 {}。这时 MCP SDK 的 zod 逐字段报「expected string, received undefined」,
// 读起来像"你忘了传 id" —— AI 于是照字面去补参数重试, 而参数本来就没错, 补了再丢。
// 所以只把 zod 说不清的那个事实换成人话: 收到的是空对象, 不是缺某个字段。
//
// 2026-08-21 全量普查 86683 次调用(只算有必填字段的工具; memory_hot/plugin_find 那种全可选参数的
// 不算 —— 它们不传参时 input 本来就是 {}, 是合法调用, 按"input 空不空"筛会得出 7.7% 的假阳性):
//   memory_upsert 99/3601 2.75% · memory_write 2/256 0.78% · memory_touch 6/796 0.75% · Read 3/10209 0.03%
// 关键: 丢参**不是独立随机事件** —— 51.9% 成串发生, 串长分布 {2:12, 3:5, 4:6, 5:2, 6:1, 7:1, 8:1},
// 最长 2026-08-20 07:51→07:55 连丢 8 次。按 2.75% 独立算连丢 8 次是 3e-13, 不可能。
// 即某些 payload 会**必然**失败, 原样重发只是一遍遍撞同一堵墙 —— 所以才要报连击数(见下面 streak)。
// 🔴 病因和处方仍然一个字都不写: 触发条件是什么(长度?字符?)还没查清, 而"第几次"是确知的事实。
// 程序只报事实, 该换形态还是再试一次让 AI 自己判(那属于它的记忆, 不属于这里)。
function guardEmptyArgs(mcp, tools) {
  // 🔴 判据是「有没有【必填】字段」, 不是「schema 空不空」。
  // 2026-08-25 实测: `plugin_find` 只有一个**可选**的 keyword, 工具描述还明写着"留空 = 全列出来",
  // 结果不传参就被这道保护拒了, 人格得改成显式传 keyword="" 才走得通。
  // 讽刺的是上面那段注释早就写过同一个结论(「它们不传参时 input 本来就是 {}, 是合法调用,
  // 按 input 空不空筛会得出 7.7% 的假阳性」)—— 只是当时用在统计口径上, 这道运行时保护没跟着改。
  const hasRequired = (schema) => Object.values(schema || {}).some((f) => {
    try { return typeof f.isOptional === 'function' ? !f.isOptional() : true; }
    catch (_) { return true; }   // 认不出就当必填 —— 保护多罩一个, 好过漏掉真丢参
  });
  const needsArgs = new Set(tools.filter((t) => hasRequired(t.inputSchema)).map((t) => t.name));
  // 私有字段, 但这是 zod 校验之前唯一的落点(setRequestHandler 存进去的那个闭包里就直接 parse 了)。
  // SDK 换版本导致挂不上时不崩应用 —— 挂不上只是退回今天的行为, 不更坏; 真正兜底的是 test-mcp.js 里
  // 那条"钩子点还在吗"的断言, 升级 SDK 时门禁会红。
  const handlers = mcp && mcp.instance && mcp.instance.server && mcp.instance.server._requestHandlers;
  const orig = handlers && handlers.get('tools/call');
  if (!orig) { console.error('[ERROR] guardEmptyArgs 挂载失败: MCP SDK 的 tools/call 钩子点变了, 空参保护未生效'); return mcp; }
  // 连击计数也只是事实, 不是处方: 2026-08-21 普查 86683 次调用发现丢参 51.9% 成串发生, 最长连丢 8 次
  // (每 30 秒一发, 全是原样重发)。只报"第几次"是因为单看一次分不清偶发还是必然, AI 就会一直原样重试。
  const streak = new Map();
  const STREAK_WINDOW = 10 * 60 * 1000;
  handlers.set('tools/call', (request, extra) => {
    const p = request && request.params;
    const args = p && p.arguments;
    if (p && needsArgs.has(p.name) && (!args || !Object.keys(args).length)) {
      const prev = streak.get(p.name);
      const now = Date.now();
      const n = prev && now - prev.at < STREAK_WINDOW ? prev.n + 1 : 1;
      streak.set(p.name, { n, at: now });
      return Promise.resolve({ content: [{ type: 'text', text:
        `⚠️ ${p.name} 未执行: 收到的 arguments 是空对象 {} —— 不是缺某个字段, 是一个字段都没收到。没有任何写入。`
        + (n > 1 ? ` 这是连续第 ${n} 次。` : '') }] });
    }
    if (p) streak.delete(p.name);
    return orig(request, extra);
  });
  return mcp;
}

// 这一轮有没有【外部文本】—— 决定要不要给它配记忆(强制召回 / 知识碎片 / 插件提示 / 沉淀提醒)。
// 🔴 与 rate gate 的分桶是两件事, 别再合用一个字段: 分桶问的是"这次 API 调用算谁的配额",
// 配记忆问的是"这轮有没有一段外面来的话值得去查"。2026-08-20 之前两件事挤在 sourceKind 上,
// 于是 bus/TG/LINE/人格间/Local API 的消息全被归进 auto, 跟心跳同档 —— 狂人从 bus 派的活、
// 店主在 LINE 上问的话, 人格一律空着脑子作答, 且不报错。dev 实测: 注入的检索块是空的。
// 'inbox' 就是为此新开的一档: 对 rate-gate 它仍不等于 'user'(照样走 auto 桶, 见 rate-gate.js:157),
// 对记忆它和 'user' 同权。
const HAS_EXTERNAL_TEXT = (kind) => kind === 'user' || kind === 'inbox';

// 每条消息头上盖一个本机时刻(带时分和星期)。
// 为什么不写进 systemPrompt: 它在持久流创建那刻定死(见 appendSystemPrompt 注释), 会话跑一整天就变成一个
// 越走越错的假时间, 比没有更坏。消息正文本来每轮都变, 盖在这儿既准, 又不动 systemPrompt 的 prompt cache。
// harness 只给到"今天是哪天", 到不了小时 —— 而"现在几点"是判断该不该打扰人、离打烊还有多久这类事的前提。
// 🔴 英文: 这一行只有模型读得到, 用户在窗口里看不见 —— 内部文本一律英文, 不跟界面语言。
// (它每一轮都盖一次, 是全仓出现频率最高的那段引擎文本。)
// 第二行要求日期、星期、天数一律调 sys 算: 模型自己往后数会系统性错一天, 由程序算才对。
const WEEK_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function nowStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `(Now ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${WEEK_EN[d.getDay()]})\n`
    + `(Every date, weekday and day count — "来週の火曜", "3 days later", "what day is the 25th" — compute it with sys(op='date') before you say it or write it.)\n`;
}

// 冲突候选对渲染。只给 id/摘要/路径 + 圈中理由 —— **不替 AI 摘正文**:
// 2026-08-09 实测的根因就是"摘要层判不出冲突"(description 按设计不含具体主张), 引擎再摘一次等于把同一个坑
// 换个地方再踩。要判就得去读那两个文件, 路径给全, 剩下的是它的活。
// 🔴 两种形状都要认: v1 的 a/b 是字符串 id, v2 换成了 {id, slug, claim} 对象且不再给 *_path。
// 只按 v1 写就会端出 "[object Object] ↔ [object Object]" 加两行 undefined 路径 —— 不报错, 但人格
// 拿到手根本不知道该 Read 哪两条, 整段体检等于白端。同 memory-v2.js:600 那次 conflictScanDue 形状漂移。
function renderConflictPairs(rows) {
  const nameOf = (x) => (typeof x === 'string' ? x : (x && (x.slug || x.id)) || '(未知节点)');
  return rows.map((p, i) => {
    const side = (tag, who, desc, where) =>
      `   ${tag}: ${desc || (typeof who === 'object' && who ? who.claim : '') || ''}` + (where ? `\n      ${where}` : '');
    return `${i + 1}. ${nameOf(p.a)}  ↔  ${nameOf(p.b)}\n` +
      `   圈中理由: ${p.why}${p.revisited ? ' · (冷却期过了, 再看一次)' : ''}\n` +
      side('A', p.a, p.a_desc, p.a_path) + '\n' +
      side('B', p.b, p.b_desc, p.b_path);
  }).join('\n\n');
}

// 两个 SDK, 接口同名同签名(query / tool / createSdkMcpServer), 可以同时加载、按人格各用各的:
//   claude-code = @anthropic-ai/claude-agent-sdk(要带 claude 二进制; 安装包不带, 用户在系统设置里自己下载)
//   butler      = @butler/agent-sdk(仓内 agent-sdk/, 多模型, 不依赖 CLI)
// 每个人格用哪个由 resolveSdkKind 定: 环境变量 BUTLER_AGENT_SDK=claude-code|butler 整台强制(测试用) →
// 订阅只有 claude-code 能跑 → 走 key 的看人格的 sdk 字段 → 没填就有 claude-code 用它。
// butler 那份在这里补上桌面内置工具和外部 MCP 的 transport —— 核心层不碰 Node API, 这两样由宿主给。
const SDK_CLAUDE_CODE = 'claude-code';
const SDK_BUTLER = 'butler';
const isSdkKind = (v) => v === SDK_CLAUDE_CODE || v === SDK_BUTLER;
const _sdks = {};
let _ccAvail = null;
function sdkChoice() {
  const v = String(process.env.BUTLER_AGENT_SDK || '').trim().toLowerCase();
  return isSdkKind(v) ? v : '';
}
// 这次启动能不能用 Claude Agent SDK。没开启「Claude 订阅」时界面只留「配 key」一条路。
async function ccAvailable() {
  if (_ccAvail !== null) return _ccAvail;
  try { await loadSdk(SDK_CLAUDE_CODE); _ccAvail = true; } catch (_) { _ccAvail = false; }
  return _ccAvail;
}
async function resolveSdkKind({ accessMode, sdk } = {}) {
  const forced = sdkChoice();
  if (forced) return forced;
  const hasCc = await ccAvailable();
  const fallback = hasCc ? SDK_CLAUDE_CODE : SDK_BUTLER;
  if (accessMode !== 'api') return fallback;   // 没装时订阅本就跑不了, butler 会如实报认证失败
  if (sdk === SDK_BUTLER || (sdk === SDK_CLAUDE_CODE && hasCc)) return sdk;
  return fallback;
}
// 新建 key 人格时把引擎写死成这一刻会用的那个(作者 11-05: 建人格不许留空)。空着的话装上 Claude SDK
// 后它会悄悄从 butler 换成 claude-code。只认已探过的结果, 没探过按没有算。
function sdkForNewPersona(accessMode) {
  // 引擎跟着接入方式定死, 不让用户选(作者 11-07): 用 key = Butler 引擎, 订阅 = Claude Code(不用写)
  if (accessMode !== 'api') return '';
  return SDK_BUTLER;
}
// 开发机用 node_modules 那份; 安装包不带, 用用户在系统设置里自己下载的那份(core/cc-sdk-install.js)
async function importClaudeSdk() {
  const inst = require('../cc-sdk-install');
  if (inst.bundled()) return import('@anthropic-ai/claude-agent-sdk');
  const entry = inst.sdkEntry();
  if (!entry) throw new Error('Claude Agent SDK not installed');
  return import(require('url').pathToFileURL(entry).href);
}
async function loadButlerSdk() {
  const core = await import('@butler/agent-sdk');
  const node = await import('@butler/agent-sdk/node');
  return {
    kind: SDK_BUTLER,
    tool: core.tool,
    createSdkMcpServer: core.createSdkMcpServer,
    query: (args) => core.query({ ...args, options: { builtinTools: node.nodeTools(), mcpTransport: node.nodeMcpTransport, ...(args && args.options) } }),
  };
}
// kind 不给 = 不属于哪个人格的调用(如翻译): 环境变量 → 有 claude-code 用它 → butler
async function loadSdk(kind) {
  if (!kind) kind = sdkChoice() || ((await ccAvailable()) ? SDK_CLAUDE_CODE : SDK_BUTLER);
  if (_sdks[kind]) return _sdks[kind];
  if (kind === SDK_CLAUDE_CODE) {
    const m = await importClaudeSdk();
    _sdks[kind] = { kind, query: m.query, tool: m.tool, createSdkMcpServer: m.createSdkMcpServer };
  } else {
    _sdks[kind] = await loadButlerSdk();
    console.log('[sdk] 已加载 Butler 引擎 (@butler/agent-sdk)');
  }
  return _sdks[kind];
}

// send_tg 出口物理门: TG 永不朗读, 出现 SSML 100% 是脏字符串, 无条件剥掉。
// 与朗读端 main.js:194 物理门同思路 —— 信不过模型完全服从 systemPrompt。
// 保留 <sub alias="X">原文</sub> 中的"原文" (alias 是给 TTS 读的, TG 该看原文)。
function stripSsmlForPlainText(text) {
  if (!text) return text;
  let t = text;
  t = t.replace(/<hidden\b[^>]*>[\s\S]*?<\/hidden>/gi, '');   // hidden=只朗读 → 文字通道连内容删
  t = t.replace(/<sub\b[^>]*>([\s\S]*?)<\/sub>/gi, '$1');
  t = t.replace(/<\/?(speak|emphasis|prosody|voice|lang|mute|hidden)\b[^>]*>/gi, '');
  t = t.replace(/<\/?break\b[^>]*\/?>/gi, '');
  return t;
}

// 可推送的异步消息队列: 作为 query 的 streaming-input prompt(开启流式模式 → interrupt 可用)
function makeMsgQueue() {
  const buf = []; let waiter = null; let closed = false;
  return {
    push(m) {
      if (closed) return;
      if (waiter) {
        const w = waiter; waiter = null;
        w({ value: m, done: false });
      } else {
        buf.push(m);
      }
    },
    close() { closed = true; if (waiter) { const w = waiter; waiter = null; w({ value: undefined, done: true }); } },
    pendingCount() { return buf.length },   // #8 clear buf drop: 拆流前扫 buf 里未消费 user msg 数
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (buf.length) return Promise.resolve({ value: buf.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((res) => { waiter = res; });
        },
        return() { closed = true; return Promise.resolve({ value: undefined, done: true }); },
      };
    },
  };
}

// —— 上下文窗口(= 占用百分比的分母)的来源档位 ——
//
// 数字越小越权威, **低档不许覆盖高档**(闸在 agent.js 的 _setWindow)。
//
// 🔴 这套档位替代的是原先"谁后到谁算": 启动先猜一个、result 到了再覆盖。那个写法只在
//    「来源恰好两个, 且后到的那个恰好更准」时才成立 —— 一旦有第三个来源(我们自己查准的值),
//    时间顺序就和可信度脱钩了, 结果是确知值被猜测冲掉。
//
// 🔴 cli 档**不是"服务端真值"**。2026-10-01 读 CLI 二进制查穿: 它是 Claude Code 本地的七档
//    瀑布算出来的, 主要靠对 model id 做字符串匹配 + 写死常量 —— 认不出的 id 一律给 200000,
//    id 里有 `[1m]` 就给 1000000。服务端那份模型目录确实在按小时刷新, 但实测 11 个模型全部
//    不带 context_window / max_input_tokens, 窗口值一个都没下发。所以它只是"表比我们全"
//    (认得 `anthropic/xxx`、`us.anthropic.xxx`、`@日期` 这些拼法), 不是权威。
//    细节见记忆 [[reference_claude_code_window_resolution_order_decoded]]。
const W_TIER = {
  certain: 1,   // 我们查准了写进数据目录 models/windows.json 的 —— 谁都别想覆盖
  server: 2,    // 服务端 /v1/models 的 max_input_tokens(留位: 网关实测不给, 暂无调用点)
  cli: 3,       // CLI 在 result.modelUsage 里给的(见上, 它也是算的)
  guess: 4,     // 出厂 windowRules 正则猜
  default: 5,   // defaultWindow 兜底
};
const W_TIER_NAME = Object.fromEntries(Object.entries(W_TIER).map(([k, v]) => [v, k]));
const tierName = (t) => W_TIER_NAME[t] || String(t);

// v0.0.25 (2026-07-21 · 1M bug 止血): 默认 window 从 200k → 1M.
// 理由: 当前所有活跃人格都跑 Opus 4.7 [1m] / Fable 5, 全是 1M 变体; 200k fallback 只在 model 探测彻底失败的极端场景触发, 那时 1M 也比 200k 更贴近事实, 且更保守 (pct 分母越小越易误触压缩).
// ⚠️ 2026-08-17 更正: 这里原本写着"init 分支用 Math.max 保证只增不减"。那条已撤 ——
// 只增不减在【切模型】时会出事: 1M 换 200k, 分母停在 1M, 自动压缩永远够不着阈值 → 撞真实上限。
//
// 返回 `{ value, tier, why }` —— 不是裸数字。三个来源按这个顺序:
//   ① 数据目录 `models/windows.json` 的确知表(出厂不带, 不存在是正常状态)
//   ② 出厂 `config/models/list.json` 的 windowRules 正则(数组按顺序匹配, 首命中为准)
//      条目可标 `"certain": true` 表示那不是猜而是确知事实, 于是不接受 cli 档覆盖。
//      ⚠️ 别轻易标: `haiku|sonnet-4 → 200000` 这条就**不能**标 —— Sonnet 4.6 实际是 1M 窗口,
//      CLI 那边还有个远程开关专门把它从 200k 抬上去, 标了 certain 就把正确值挡在外面了。
//   ③ defaultWindow 兜底
// 🔴 确知表用**精确模型名**匹配, 不用正则 —— 用正则就又变成猜了。
// 确知表两种写法(作者 2026-11-05 定): `"模型名": 数` 对所有凭据生效; `"凭据名": { "模型名": 数 }`
// 只对走那条凭据的人格生效, 且优先 —— 中转站可能把同一个模型限得比官方小, 只能按凭据分开记。
function windowFor(model, credName) {
  const { cfg } = require('../host');
  const list = cfg.json('models/list');
  const DEFAULT_WINDOW = list.defaultWindow || 1000000;
  if (!model) return { value: DEFAULT_WINDOW, tier: W_TIER.default, why: 'no-model' };
  const known = cfg.jsonOptional('models/windows', {}) || {};
  const byCred = credName && known[credName];
  const credHit = byCred && typeof byCred === 'object' ? byCred[model] : undefined;
  if (Number.isFinite(credHit) && credHit > 0) return { value: credHit, tier: W_TIER.certain, why: `windows.json·${credName}` };
  const hit = known[model];
  if (Number.isFinite(hit) && hit > 0) return { value: hit, tier: W_TIER.certain, why: 'windows.json' };
  for (const rule of (list.windowRules || [])) {
    if (new RegExp(rule.pattern, 'i').test(model)) {
      return {
        value: rule.window,
        tier: rule.certain ? W_TIER.certain : W_TIER.guess,
        why: `rule /${rule.pattern}/`,
      };
    }
  }
  return { value: DEFAULT_WINDOW, tier: W_TIER.default, why: 'defaultWindow' };
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

// 交接便条(MEMORY.md)注入上限。它每轮都随上下文重读, 所以是"每轮乘一次"的成本, 不是一次性的。
// 8KB ≈ 2.4k tok, 够写 40 条「一句话 + [[指针]]」的在办事项; 再多说明细节没挪进图节点。
// 环境变量可覆盖(实测调优免重打包), 与 BUTLER_AUTO_COMPACT_TOK 同惯例。
const WAKE_MEMORY_INDEX_MAX_BYTES = Number(process.env.BUTLER_WAKE_INDEX_MAX_BYTES) || 8192;

// 把一个"类片段"的方法原样挂到目标类的 prototype 上。
// 用 defineProperty 而不是 Object.assign: class 方法是不可枚举的, assign 会一个都拷不过去。
function mixin(target, ...fragments) {
  for (const F of fragments) {
    for (const k of Object.getOwnPropertyNames(F.prototype)) {
      if (k === 'constructor') continue;
      Object.defineProperty(target.prototype, k, Object.getOwnPropertyDescriptor(F.prototype, k));
    }
  }
  return target;
}

module.exports = { memSplitIds, CLAUDE_BIN, FORCE_SEDIMENT_TOOLS, MEMORY_WRITE_TOOLS, guardEmptyArgs, HAS_EXTERNAL_TEXT, WEEK_EN, nowStamp, renderConflictPairs, loadSdk, ccAvailable, resolveSdkKind, sdkForNewPersona, isSdkKind, SDK_CLAUDE_CODE, SDK_BUTLER, stripSsmlForPlainText, makeMsgQueue, windowFor, W_TIER, tierName, sumInput, withTimeout, WAKE_MEMORY_INDEX_MAX_BYTES, mixin };
