// agent.js — 全能管家大脑: Claude Agent SDK 封装
// 复用订阅认证(通过 claude CLI), 真 usage 上下文, 整理记忆·清空重启(轻沉淀→瞬间清空→唤醒引导加载器重建工作记忆)。
// 会话跑在【持久流式 query】上: 一个 query 贯穿多轮; 用户可在一轮进行中提交 → interrupt 打断 +
// push 新消息 → 我在下个间歇接住(插话/改道)。打断产生的 error_during_execution result 被吞掉。
// 2026-08-24 拆包: 本文件只剩类骨架与组装, 各方法族在 agent/ 下(见文件末尾的 mixin 调用)。
const path = require('path');
const fs = require('fs');
const persona = require('./persona');
const { paths } = require('./host');
const MemoryGraphV2 = require('./memory-v2').MemoryGraphV2;
const RedlineGuard = require('./redline-guard').RedlineGuard;

const IndexGuard = require('./index-guard').IndexGuard;
const { QueryFirstGuard } = require('./query-first-guard');
const CancelToken = require('./rate-gate').CancelToken;
const { BusRegistry } = require('./bus');
const { cfg } = require('./host');
const { nowStamp, windowFor, W_TIER, mixin } = require('./agent/util');
const { GATEWAY_MODEL_KEYS, GATEWAY_ENV_KEYS, accessConfig, applyAccessEnv, classifyAccessError } = require('./agent/env');

// 自言自语时要掐掉的事件。**onResult 必须在内** —— 气泡是它画的, 只掐流式那几种,
// 回合末照样会把整段独白补到屏幕上(而且还会朗读出来、进 convo、落盘)。
// onCompact / onUsage / onCtxSample 留着: 宿主拿它们收指示灯和记账, 掐了界面会一直转。
//
// 🔴 掐 onResult 的代价: 渲染层的 busy(转圈 + chip/清空键锁死)本来只在 onResult 里复位, 于是
//    静音期间那一轮结束后界面永远转圈 —— 2026-09-27 作者实撞, 哑了 16 分钟、连自救入口都没有。
//    修法不是把 onResult 放出来(独白会补上屏还会被朗读), 而是另发一个**不在本集合里**的
//    `onTurnEnd`: 一轮结束必发、只报"完了"不带正文。busy 这类流程状态一律挂它, 不挂 onResult。
//
// 🔴 onTasks 不在内: 任务清单是状态不是独白, 沉淀轮改了清单界面也得跟上, 掐了就和实际对不上。
const UI_EVENTS = new Set([
  'onText', 'onTextDone', 'onTool', 'onToolDone', 'onActivity', 'onResult',
]);

class Butler {
  // homeDir = 这个人格的本体目录(cwd); opts.memoryDir 可覆盖记忆位置; opts.name 可指定人格名
  constructor(homeDir, opts = {}) {
    this.homeDir = path.resolve(homeDir || process.cwd());   // 归一化成绝对路径(SDK cwd/记忆解析都要绝对)
    this.memoryDir = persona.resolveMemoryDir(this.homeDir, opts.memoryDir);
    this.name = opts.name || persona.personaName(this.homeDir);
    // 自己写插件的地盘(packages.local)。要进系统提示的位置表 —— 人格目录/记忆目录/插件目录是
    // **并列的好几个**, 不存在"当前目录", 少给一个它就只能猜一个。宿主不传就不显示那一行。
    this.pluginDir = opts.pluginDir || '';
    persona.ensureMemory(this.memoryDir, this.name);   // 空目录=新人格→脚手架 MEMORY.md
    this.personaText = persona.loadPersona(this.homeDir, this.memoryDir);  // 人设(persona.md), 可 null
    this.voice = { enabled: false, voice: 'Tingting' };   // 语音配置 (main.js 从 registry 覆盖). 默认关.
    this.extMcpNames = persona.loadMcpServers(this.homeDir, this.memoryDir); // 该人格要放行的外部 MCP(如 dc-platform)
    this.wakePhrase = opts.wakePhrase || persona.defaultWakePhrase(this.name); // 压缩自愈唤醒语; 注册表唯一真源, 缺省=默认句
    this.isButler = !!opts.isButler;      // 是否星型中心管家(有 open/create_persona 工具)
    // 帽子(标签栏管家标识)专用: 打开这个会话时的管家身份, updatePersona 不改它 →
    // 设管家当下帽子不抢跳; 等这个人格的会话重开(重开标签/重启 app)以管家身份跑起来, 帽子才移过去。跟会话走。
    this.openedAsButler = !!opts.isButler;
    // 模型偏好(用户在编辑面板选的, 持久化到 registry.model)。空=跟随 Claude Code 默认。
    // 注意区分 this.model(运行时首轮上报值) vs this.preferredModel(用户偏好, 影响下次会话启动)。
    // 切换后要等会话重开(关标签重开/重启 app/下次压缩)才生效——SDK query 的 model 每次启动定死, 中途不能改。
    this.preferredModel = opts.model || null;
    // 接入方式(人格级, 持久化到 registry.accessMode): 'api' = 用系统设置里存的那把 key,
    // 其余(含缺省) = 用登录的订阅账号。系统设置只是凭据仓库, 启不启用由这里说了算。
    // 与 preferredModel 同命: env 在 spawn 那刻定死, 改完要重开这个人格才生效。
    this.accessMode = opts.accessMode === 'api' ? 'api' : 'subscription';
    // 凭据仓库里认领哪一条(registry.credentialId)。空 = 跟默认那条走 ——
    // 老人格没有这个字段, 空着照常能起, 这是"多把 key"不惊动存量的关键。
    this.credentialId = opts.credentialId || '';
    // 走 key 时用哪个 SDK(registry.sdk): 'claude-code' | 'butler' | '' = 装了 Claude Code 就用它。订阅恒走 claude-code。建流时由 resolveSdkKind 定
    this.sdk = require('./agent/util').isSdkKind(opts.sdk) ? opts.sdk : '';
    this.sdkKind = null;   // 当前这条流实际用的那个
    // 宿主直接给的网关 { base_url, token }。行业版由服务端随配置下发, 优先于本机凭据仓库。
    // 与 accessMode/preferredModel 同命: env 在 spawn 那刻定死, 换了要下一轮会话才生效。
    this.gateway = opts.gateway || null;
    this.avatar = opts.avatar || null;    // 头像(emoji), 空 = 渲染层用字母头像兜底
    this.personaOps = null;               // main 注入: { open(ref), create(spec) } — 管家开/建人格回调
    // v2 底座的存量迁移(.md 散文件 → v2 DB)。和下面 v1 那次迁移同一条道理: 必须发生在
    // 人格启动这一刻, 因为每个人格各有一张图, 装了新版就得自己就位 —— 不是谁在开发机上跑一遍脚本。
    // 幂等(v2 库在就跳过) · 对账不过自己回滚(留在 v1) · 失败不挡启动。
    // 建在【新文件】memory.v2.db 上, 老库原封不动躺在旁边, 所以回滚只是删掉一个文件。
    {
      try {
        const r = require('./memory-migrate-v2').migrate(this.memoryDir);
        if (r.ok && !r.skipped) {
          console.log(`[migrate] ${this.name} 迁入 v2: 节点 ${r.stat.nodes} · 边 ${r.stat.edges}`
            + `(悬空 ${r.stat.dangling} 未建) · 修订 ${r.stat.revRows} · 待 AI 复核 ${r.audit.pending}`);
        } else if (!r.ok) {
          console.error(`[migrate] ${this.name} 对账未过, 保持原样:`, (r.problems || [r.error]).join(' ; '));
        }
      } catch (e) { console.error(`[migrate] ${this.name} 迁移失败(不挡启动):`, e && e.message); }
    }
    // 人格原生图记忆(遗忘曲线+图扩散), 每人格一张图
    this.memory = new MemoryGraphV2(this.memoryDir);
    this.memory.actor = this.name;   // 修订历史要记是谁改的
    // 红线动作侧守卫。
    this.redlineGuard = new RedlineGuard(this.memory);
    // 4.2 索引类知识: 同一个 PreToolUse 口子, 但只附一眼不拦人。
    this.indexGuard = new IndexGuard(this.memory, { cfg, memoryDir: this.memoryDir });
    // 先查后办: 真人回合没查过记忆就动手, 打回一次(query-first-guard.js)。
    this.queryFirstGuard = new QueryFirstGuard(cfg, () => this._turnSourceKind);
    // 分发版源码锁: 只在 flavor=locked 的包里存在, 开发包里 null(我要在自己的包里改 butler)。
    // 构造失败(算不出受保护根)宁可不设防也不能挡住人格启动 —— 但要吼出来, 别静默。
    this.selfGuard = null;
    if (paths.isLockedBuild()) {
      try {
        // allow: 人格自己的家和记忆库永远放行 —— 它们可能就落在受保护根里面(用户把数据目录
        // 选进了安装目录), 不豁免的话人格连自己的 persona.md 都读不了。
        this.selfGuard = require('./host').selfGuard.create({
          roots: paths.selfGuardRoots(), cwd: this.homeDir, allow: [this.homeDir, this.memoryDir],
        });
      } catch (e) {
        console.error('[self-guard] 分发版源码锁装配失败, 本次未设防:', e.message);
      }
    }
    // 🔴 存储迁移(JSON 索引 → SQLite)必须在人格启动这一刻完成, 而不是等我在自己机器上跑一次脚本 ——
    // 每个人格各有一张图, 装了新版就得自己就位。幂等(库里盖章), 且整体在一个事务里, 中断可重来。
    // 失败不能挡住人格启动: 记忆坏了还能对话, 起不来就什么都没了。
    try {
      const r = this.memory.ensureReady();
      if (r && r.migrated) console.log(`[memory] ${this.name} 迁入 SQLite: ${r.nodes} 节点 / 热度史 ${r.heatRestored} 条`);
    } catch (e) { console.error(`[memory] ${this.name} 迁移失败(不挡启动):`, e && e.message); }
    // 语义检索的算子。embed-host 顶层不碰 electron(只在函数体内 require),
    // 所以纯 node 的门禁环境里 require 得到、调用时才优雅失败。
    // 🔴 接不上必须出声。以前这里是静默 catch, 于是"语义检索整个死掉"这么大的事一声不响:
    // 模型是运行时从 huggingface 下的(core/embed/model.js), 下不来就没向量, 检索退化成纯词面,
    // 中文短句一律趴在注入线以下 —— 而用户看到的只是"AI 想不起事", 永远查不到这一步。
    try { this.memory.setEmbedder(require('./host').embedder.embed); }
    catch (e) { console.error(`[memory] ${this.name} 语义算子没接上, 语义检索不可用:`, e && e.message); }
    // 模型已经在本机 = 这张图就该用语义检索, 不再另问用户一次(2026-08-13 默认开)。
    // 没有这一句, 模型装好之后新建/新开的人格会一直停在"没向量"状态, 而且不报错。
    try {
      if (require('./host').embedder.detect().ok) this.memory.markSemanticOptIn();
      else console.error(`[memory] ${this.name} 语义模型没落地, 语义检索不可用(退化成纯词面匹配) —— 到设置里下载模型, 或配好网络代理后重开。缺多少条看 memory_admin(op='doctor')`);
    } catch (e) { console.error(`[memory] ${this.name} 语义模型探测失败:`, e && e.message); }
    // 补算被关窗打断过就在这儿接上。747 条实测 11.5 分钟(2026-08-13 真机), 中途关掉是常态,
    // 不在启动时续上就只能等下一次写入才动 —— 那期间语义检索一直是残的。
    try { this.memory.kickEmbed({ limit: 0 }); }
    catch (e) { console.error(`[memory] ${this.name} 补算向量起不来:`, e && e.message); }
    this.sessionPath = path.join(this.memoryDir, '.session.json');         // 会话状态旁置记忆目录
    this.sessionId = null;
    // idle-watch 门: 清空后 → false (空闲期, 不再触发清空/保活, 保持姿势).
    //   用户真消息 / peer 投递 / TG-bothub 推入 → true (进入干活期, 按现有策略).
    //   heartbeat / sediment / wake 三种系统 push 不改此位 (它们本身不代表人格真干活).
    this.dirtySinceLastClear = false;
    // v6 keepalive 计数触发 (2026-07-22 · design/keepalive_v6_count_based.md):
    //   每次心跳 main.js 侧 ++, 真消息重置为 0, clear 后归零, 达 keepaliveMaxTimes 触发清空.
    //   替代 v5 的 idle 时钟 (keepaliveCutoffMin) — 保 N 次 ≈ 冷起 1 次 (cache_read 0.1× vs input 1× = 10:1),
    //   N=10 即盈亏平衡点; N < 10 净赚保温, N > 10 净亏.
    this.keepalive_count = 0;
    this.pendingHandoff = null;    // 压缩后待注入下一轮的交接摘要
    // 窗口 + 它的来源档位。**成对出现, 永远一起改** —— 只改数不改档, 下一个低档来源就能把它冲掉。
    // 赋值一律走 _setWindow / _applyModelWindow, 别直接写这两个字段(理由见 _setWindow)。
    this.window = 0;
    this._windowTier = null;
    this._applyModelWindow(null);
    this.model = null;
    this.lastInput = 0;            // 最近一次请求的上下文输入 token(=占用)
    // 成本采样 (2026-08-23): 每次 API 调用记一笔 ctx 与 delta。SDK 不把 tool_result 交给我们,
    // 所以构成拆不出来 —— 但 delta 几乎全由"上一批工具的返回"造成, 归因到那批工具名就够定位大头。
    this._ctxSeq = 0;
    this._lastBatchTools = [];
    this._pendChars = { out: 0, arg: 0 };
    // 苏醒完成时的稳态 ctx_tok(tool loop 出完首次 result 时写入 = 起床清单+初始化工具全部消耗后的基线).
    // 清空后置 null 下次苏醒重测; keepalive 动态门用 wakeCtxBase * ratio 判 "净涨够不够值得保 cache".
    this.wakeCtxBase = null;
    this.compactRequested = null;  // 模型调压缩工具时置为 reason
    this.sessionHits = new Set();  // §2.5 反思批 touch: 本轮 memory_query 命中过的 ids · 压缩前提示 AI 挑真用过的 touch
    this.sessionExpanded = new Map();  // memory_section 已展开过的 id → {chars, hash} · 防"顺 [[link]] 一路 section 绕圈"的 memory-storm 循环, 命中返精简, force=true 才重发全文
    this._gateCancelToken = new CancelToken();  // rate gate 排队 cancel · interrupt 时 cancel + renew
    // 任务清单: AI 用自家 `task` 工具管的那份(入口在 consume.js 的 taskOp)。
    // 所以这里顺着工具入参自己攒一份, 让宿主能把它画出来 —— 看不见的清单等于没有清单。
    // SDK 默认会把本机 `~/.claude` 的 skills / 斜杠命令 / 插件全读进来。个人版要这个(那是用户
    // 自己的东西), 行业版必须传 [] 掐掉 —— 客户机器上的 AI 不该继承**装机那个人**的能力。
    // 默认 null = 不传这个选项 = 个人版行为一个字不变。
    // ⚠️ 2026-08-27 试过把默认值改成 [] 来省掉那 35 个无关 skill(约 2500 token), 当天撤回:
    // settingSources 管的不止 skills —— settings.json 的 permissions / hooks / CLAUDE.md 全归它,
    // 一刀切成 [] 会把个人版真正依赖的那些一起掐掉。要省得另找只针对 skills 的办法。
    this.overlayPacks = [];        // 能力包(pack-loader.loadPack 产物)数组, setOverlayPack 注入
    this.settingSources = opts.settingSources || null;
    // 上面那条"要省得另找只针对 skills 的办法" —— 就是这个。SDK 的 skills 选项只管技能清单,
    // 不碰 permissions/hooks/CLAUDE.md。null=不传=CLI 默认全开(省略 ≠ 关闭); [] = 一条不留。
    // ⚠️ 建流那刻定死, 改完要重新建流才生效; 且 init 消息报的是"发现的"不是"启用的", 验它只能问模型本人。
    this.skills = Array.isArray(opts.skills) ? opts.skills : (opts.skills === 'all' ? 'all' : null);
    this._tasks = [];
    this._taskSeq = 0;
    try { this._loadTasks(); } catch (_) {}   // 盘上有未完成清单就接回来(压缩/重启都不该丢, 作者 2026-09-25)
    this._pendingTools = [];   // UI 反馈: tool_use 未收到 done 的名字队列 · 下次 assistant text/新 tool_use/result 出现时 flush → onToolDone
    // 自动压缩兜底阈值(占用百分比)。占用达此值即自动登记压缩, 不再全靠模型自觉调工具。
    // 按窗口比例算, 兼容 200k/1M 两档。0/负数=关闭自动压缩。
    // 优先级: opts > 环境变量 BUTLER_AUTO_COMPACT_PCT(实测调优免重打包) > 默认 80。
    const _envPct = Number(process.env.BUTLER_AUTO_COMPACT_PCT);
    this.autoCompactPct = (opts.autoCompactPct != null) ? opts.autoCompactPct
      : (Number.isFinite(_envPct) ? _envPct : 80);
    // v5.1 (2026-07-18 作者批): 绝对 token 硬顶抬到 800k = red_line, 交给 main.js idle-watch 做 "停手1min 就压"
    // 的软化路径 (hard_cap_softened). 病根: 老 150k 是"回合结束立即压", 视觉上像"话没说完就压"—— 因为 SDK 的
    // 回合边界是"模型不再产出即 result", 用户以为还有总结但模型没多嘴, 就被压了. 现在 150k~800k 走 idle-watch
    // 的 "停手 1min" 门, 用户还在讲/工具还在跑就不动. 环境变量仍可覆盖. 关闭传 0 或负数.
    const _envTok = Number(process.env.BUTLER_AUTO_COMPACT_TOK);
    this.autoCompactTok = (opts.autoCompactTok != null) ? opts.autoCompactTok
      : (Number.isFinite(_envTok) ? _envTok : 800_000);
    // 持久流式态
    this._q = null;                // 当前持久 query
    this._ensuring = null;         // ensureStream 单飞锁: 建流进行中的 promise (并发调用共享)
    this._queue = null;            // 其输入队列
    this._cb = null;               // 全局回调 { onText, onUsage, onResult }
    this._cur = '';                // 当前这段回复已累积文本
    this._deltaText = '';          // 当前 assistant 消息经 stream_event 已逐字发出的文本(判是否需补发)
    this._blockKinds = {};         // stream_event 里 content_block index → type, 用于判 content_block_stop 停的是不是文本块
    this._argFrags = new Map();    // tool_use block id → { name, raw, ... } 工具入参的原始分片(见 _dumpLostArgs)
    this._argIdx = {};             // stream_event index → tool_use block id (delta 只带 index, 不带 id)
    this._escVerdict = new Map();  // tool_use id → 原文里有没有中日文 \u 转义(consume.js 判, core/escape-guard.js 用)
    this._busy = false;            // 模型是否正在产出(首个 assistant→result 之间)
    this._pendingModel = null;     // { model } — 正在产出时收到的切模型请求, 回合结束才兑现(见 setModel)
    this._consumerDone = null;     // 消费循环 promise
    this._ac = null;               // 主持久 query 的 AbortController(teardown 超时强拆用)
    this._compacting = null;       // 压缩进行中的 promise(submit 需等它)
    this._askPending = [];         // askOnce 挂起的 resolver 列表, result 时 shift 一个 → 返回 finalText; 流拆时 _flushAskPending 清空
    this._turnSeq = 0;             // 已进队列的提交数(submit 时 ++) — 自言自语静音靠它认领轮号
    this._resultSeq = 0;           // 已消费的 result 数(consume 时 ++)
    this._turnMuted = false;       // 当前这一轮静音中(界面事件掐掉) — 按 CLI 回放判, 收尾清, 见 agent/turn-mute.js
    this._turnClaimed = false;     // 当前这一轮已收到过 CLI 回放(见 agent/turn-mute.js)
    this._pendingSubs = [];        // 已入队、CLI 还没回放的提交: [{ uuid, muted }]
    this._turnMemoryOps = 0;       // 本回合调过几次 memory_* (submit 归零, tool_use 累加) — 动态记忆提醒的判据
    this._turnMemoryWrites = 0;    // 其中真正写库的有几次(upsert/write) — 「连续几轮没存」只能用这个数, 读不算
    this._turnHadThinking = false; // 本回合是否出现过 thinking block (submit 归零) — 空回合兜底的判据之一
    this._emptyTurnRetried = false;// 本轮空回合补提是否已用掉; 限 1 次, 免"补提又空"打转
    this._turnUserText = null;     // 本回合的真人原话(auto 回合为 null); result 时据此判要不要提醒
    this._turnKnowledgeHits = [];  // 本回合拿到过哪些"新知识"(WebSearch/WebFetch 等, submit 归零) — 强制沉淀的判据
    // 🔴 跨回合累加, submit 时**不**归零 —— 归零的唯一条件是真调了 memory_*。
    // 平静的技术讨论既撞不上 memory_nudge 的情绪词表, 也够不着 force_sediment 的外部来源判据,
    // 没有这个计数就一条提醒都不会有。
    this._turnsSinceMemoryOp = 0;  // 连续几个真人回合零 memory_*
    this._memoryNudgeStreak = 0;   // >0 = 待注入的连续零沉提醒(注入时清零)
    this._forceSedimentRetried = false; // 本轮强制沉淀是否已用掉; 限 1 次, 免死循环
    this._redlineRetried = false;  // 本轮输出侧红线打回是否已用掉; 限 1 次, 免"打回又犯"打转
    this._lostToolRetried = false; // 本轮"工具调用漏成正文"打回是否已用掉; 限 1 次, 免打转
    this._knownToolNames = null;   // 本轮真实注册的工具名(buildMcp 建流时填) — 上面那条判定的硬事实
    this._authRetried = false;     // 本轮接入故障是否已重试过; 限 1 次 —— 抖动重试一次就好, 两次还同一个错就是真的
    this._authBlocked = false;     // 认证失效挂起中: 停止一切自动重试, 等用户点横幅重登 → replayAfterRelogin 解除
    this._lastSubmitPayload = null;// 最后一条真消息 {text, attachments, opts}, 供重登后原样重发(心跳/内部轮不留存)
    this._memoryNudge = null;      // 待注入的提醒理由(命中的词); 下一条真人消息 prepend 后清空
    this._dialogs = new Map();     // AskUserQuestion: dialogId → { resolve, cancel } — main 回填用户选择
    this._dialogSeq = 0;
    this.tgBotToken = null;        // v2: send_tg 工具用 (由 main.js installPlugins 后 setTgConfig 注入)
    // 这台机器能对话的所有 bus, 有序, 第一个是默认。取代原先 lineChannel / agentBus /
    // bothubEndpoints 三个各管一摊的字段 —— 它们本来就都是"往某条 bus 说话"。
    this.buses = new BusRegistry([]);
  }

  // 注册全局回调(main 在启动时调一次): onText(chunk) / onTextDone() / onUsage(u) / onResult({finalText, interrupted}) / onTurnEnd({interrupted, muted, torn, compactReason})
  setCallbacks(cb) { this._cb = cb; }

  // v2 TG 通路: 给 send_tg 工具供 bot_token; 支持热切换 (installPlugins 每次调用会重新 set)
  // TG 不走 bus —— 它是直接打 Telegram Bot API, 跟"我们自己的服务端"不是一回事。
  setTgConfig(cfg) { this.tgBotToken = (cfg && cfg.bot_token) || null; }
  // 这台机器对话的 bus 目标表(有序, 第一个是默认)。宿主启动/热切换时调一次。
  // specs = [{ id, kind:'v1'|'bothub', base_url, token, agent?, label? }]
  setBuses(specs) { this.buses = new BusRegistry(specs || []); }
  // 能力包(overlay)注入 —— 中身は知識 / chip / 首启帮助。収数組是行业版长出来的口径:
  // 一台机器可以同时装行业底座 + 店铺包, 个人版历史上只传单个, 这里统一成数组, 传单个也照收。
  // 🔴 **包は工具を一つも持ち込まない**(道具という概念そのものが無い) ので、ここに bus 連接は
  //    要らない。AI が端点を叩くのは bus_exec、画面が叩くのは插件自身の宣言に書いた端点。
  setOverlayPack(packs) {
    this.overlayPacks = (Array.isArray(packs) ? packs : [packs]).filter(Boolean);
  }

  // ── 版本扩展钩子 ──────────────────────────────────────────────
  // core 是两版共用的大脑, 差异由子类挂在这几个点上, 而不是往 core 里塞 if(行业版)。
  // 默认全空 = 个人版行为一个字不变; 行业版(IndustryAgent extends Butler)覆写自己那几个。
  // 🔴 加新差异时先问: 它是不是真的只有一版要? 是就挂钩子, 不是就直接进 core。
  _extraSystemBlocks(_slot) { return []; }        // slot: 'afterRuntimeEnv' | 'atEnd'
  async _extraMcpTools(_ctx) { return []; }       // ctx: { tool, z }
  _extraAllowedTools() { return []; }
  _extraMcpServers() { return {}; }
  _extraWakeParts(_slot) { return []; }           // slot: 'atEnd'
  // 排在 core 三个守卫之前 —— 行业版的源码闸是分发版的硬边界, 拦下就不必再算后面的。
  _extraPreToolUseHooks() { return []; }
  // core 自带里这一版不要的(裸名, 不带 mcp__butler__ 前缀)。
  // 🔴 只用来解「同名但**确实是两回事**」。拿它去挡「同一功能的两份复制品」等于把分叉焊死 ——
  // 那种情况该做的是让 core 那份接上这一版的数据源, 然后把副本删掉。
  // (2026-08-24 起这里是空的: 曾经唯一的用例 send_line 已经不存在 —— 发 LINE 是 bus 上的
  //  一个 command, 不是一个工具。)
  _droppedCoreTools() { return []; }

  // 自言自语的那几轮(沉淀/唤醒补注入)不该出现在屏幕上 —— 它们是机器对自己说的话,
  // 用户看到的是一段没头没尾的独白, 而"nothing to save"这类协议口令更是彻底的噪音。
  // 🔴 只掐**给界面看的**那几种事件(含 onResult, 见上面 UI_EVENTS 那段); onCompact / onTurnEnd
  // 照发, 宿主要靠它们收指示灯、记时间戳、判沉淀成没成 —— 一起掐掉的话界面会永远转圈。
  _emit(kind, payload) {
    if (this._turnMuted && UI_EVENTS.has(kind)) return;
    if (this._cb && typeof this._cb[kind] === 'function') this._cb[kind](payload);
  }

  // 自言自语怎么静音: 在那一次 submit 的 opts 里带 `_mute: true`(沉淀轮见 compact.js 的 askOpts),
  // 心跳靠 [[HEARTBEAT]] 前缀自带。哪一轮静音由 agent/turn-mute.js 按 CLI 回放对账 ——
  // 别再退回任何"猜哪条提交归哪一轮"的判法, 错过四次, 病史在那个文件头。

  // 工具入参丢成 {} 时把原始分片留下来。SDK 只把【拼装后】的 input 交给我们, 拼失败就静默回落成 {},
  // 于是模型真正吐出的那几百 token 谁也没见过 —— 无从判断是生成侧吐了非法 JSON, 还是传输侧没拼上。
  // input_json_delta 本来就从 stream_event 流过(includePartialMessages 早就开着), 这里只是接住它。
  // 能正常解析的一律丢弃不落盘, 只有出事的才留 —— 否则每次调用的全部参数都要写一遍盘。
  _dumpLostArgs(entry, reason) {
    if (!entry || entry.dumped) return;
    entry.dumped = true;
    try {
      const dir = path.join(paths.dataDir(), 'logs', 'lost_args');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rec = { at: new Date().toISOString(), persona: this.name, tool: entry.name,
                    block_id: entry.id, reason, raw_len: entry.raw.length,
                    parse_error: entry.parseError || null, raw: entry.raw };
      fs.writeFileSync(path.join(dir, `${stamp}-${entry.name}-${entry.id}.json`),
                       JSON.stringify(rec, null, 2));
      console.log(`[lost-args] ${this.name} ${entry.name} ${reason} raw=${entry.raw.length}B → logs/lost_args/`);
    } catch (e) { console.log(`[lost-args] 落盘失败: ${e.message}`); }
  }

  // AskUserQuestion: SDK 通过 onUserDialog 派发 request_user_dialog. renderer 弹选项框, 用户选完调 resolveDialog 回填.
  // 未接 renderer / signal abort / 无人应答 → 返回 cancelled, SDK 自动兜底.
  _handleUserDialog(req, signal) {
    const dialogId = `dlg_${Date.now()}_${++this._dialogSeq}`;
    console.error('[DIALOG-DIAG#1] SDK dispatched request_user_dialog', { dialogKind: req.dialogKind, hasPayload: !!req.payload, payloadKeys: req.payload ? Object.keys(req.payload) : [], payloadJSON: JSON.stringify(req.payload).slice(0, 800), toolUseID: req.toolUseID });
    return new Promise((resolve) => {
      let settled = false;
      const done = (result) => { if (settled) return; settled = true; this._dialogs.delete(dialogId); resolve(result); };
      this._dialogs.set(dialogId, { resolve: (payload) => done({ behavior: 'completed', result: payload }), cancel: () => done({ behavior: 'cancelled' }) });
      if (signal && !signal.aborted) signal.addEventListener('abort', () => done({ behavior: 'cancelled' }), { once: true });
      // 推给 UI (main.js 挂 onUserDialogRequest 回调 → sendUI). 没接 = 直接 cancel 兜底, 别把 SDK 挂死.
      if (typeof this._cb?.onUserDialogRequest === 'function') {
        try {
          this._cb.onUserDialogRequest({ dialogId, kind: req.dialogKind, payload: req.payload, toolUseID: req.toolUseID });
          console.error('[DIALOG-DIAG#2] emitted onUserDialogRequest', { dialogId });
        }
        catch (e) { console.error('[dialog] request emit failed:', e && e.message); done({ behavior: 'cancelled' }); }
      } else {
        console.error('[dialog] no onUserDialogRequest cb wired → auto cancel'); done({ behavior: 'cancelled' });
      }
    });
  }
  // main 调: 用户在 UI 上选完/取消后回填. answer 有值 = completed; null/undef = cancelled.
  resolveDialog(dialogId, answer) {
    const slot = this._dialogs.get(dialogId);
    if (!slot) return false;
    if (answer == null) slot.cancel(); else slot.resolve(answer);
    return true;
  }


  // 运行时切模型 —— 不必关标签重开, 下一轮就用新模型。
  // SDK 的 setModel 只在 streaming input 模式可用(sdk.d.ts: "Change the model used for
  // subsequent responses"), 而我们正是这个模式。
  //
  // 🔴 必须自己更新 model/window: 运行时切换【不会重发 system/init】, 那是会话启动才有的消息。
  //    不更新的话界面上的模型名还是旧的, 更要命的是 window 停在旧模型的值 —— 1M 换 200k 之后
  //    占用只显示实际的 1/5, 自动压缩永远够不着阈值, 一路撞上真实上限。
  async setModel(model) {
    const next = model || null;
    this.preferredModel = next;
    // 说到一半不换。下面那句 _applyModelWindow(next) 一执行, 本轮的占用就改按新模型的
    // 窗口算 —— 1M 换到 200k 时占用率当场翻五倍, 可能直接撞上压缩阈值, 把正在说的话截断。
    // 回合结束(consume.js 的 result 分支)再兑现, 那时切进去的正好是下一轮。
    if (this._busy) {
      this._pendingModel = { model: next };
      return { applied: false, reason: 'deferred_busy', model: next };
    }
    const access = accessConfig(this.accessMode === 'api', this.gateway, this.credentialId);
    // 走网关时 _q.setModel 只切得动主对话。那几个分档模型变量(标题生成这类小活走 haiku 档)在
    // env 里, env 在 spawn 那刻定死 —— 切一半(主对话新模型 + 内部小活仍打旧模型名)会等到某次
    // 生成标题或压缩时才炸。所以不切主对话, 改成把流叠掉: 下一句话 ensureStream 自动重建,
    // buildEnv 带的是新模型名, 全套一致。park 保留会话对象与 LINE/TG 通路, 还会补一次唤醒 ——
    // 对店主是无感的, app 不用退。
    if (access && access.base_url) {
      if (next) { this.model = next; this._applyModelWindow(next); }
      const parked = await this.park();
      // 刻意不发 model-switch-notice: submit 会把刚叠掉的流又建起来, park 就白做了;
      // 而重建后 systemPrompt 里那行"运行模型"本来就是新的, 没有过期可纠正。
      return { applied: true, model: next, window: this.window, via: 'restream', parked };
    }
    if (!this._q || typeof this._q.setModel !== 'function') return { applied: false, reason: 'no_stream' };
    try {
      await this._q.setModel(next || undefined);
    } catch (e) {
      return { applied: false, reason: 'sdk_refused', error: String((e && e.message) || e) };
    }
    if (next) { this.model = next; this._applyModelWindow(next); }
    // systemPrompt 里那行"运行模型"是建 query 那刻定死的, 切完不会自己刷新 —— 不纠正的话
    // 它被问到"你现在什么模型"会照着旧的答。同 voice 热切换那条的处理。
    const note = `(System · model switched · not a user message) The running model is now ${next || '(default)'}. `
      + `The "running model" line in your system prompt was fixed when this session started and is now stale — `
      + `go by this message, do not use that line to deny the current fact.`;
    this.submit(note, undefined, { sourceKind: 'auto' })
      .catch((e) => console.error('[model-switch-notice]', e && e.message));
    return { applied: true, model: next, window: this.window };
  }


  // 自动压缩兜底: 占用达阈值且当前没在压缩/没已登记 → 置 compactRequested。
  // 只标记, 不在此执行 doCompact(那要拆流→会与消费循环死锁); 复用模型主动请求同一条
  // result→onResult→doCompact 抛出路径(已带 5min deadline 自愈), 零新增死锁面。
  _maybeAutoCompact() {
    if (this._compacting || this.compactRequested) return;  // 压缩中/已登记 → 不重复
    const u = this.usage();
    if (this.autoCompactPct > 0 && u.pct >= this.autoCompactPct) {
      this.compactRequested = `自动压缩·占用 ${u.pct}% ≥ ${this.autoCompactPct}%`;
      console.error(`[autoCompact] ${this.name} 占用 ${u.pct}% ≥ ${this.autoCompactPct}% → 本轮结束后自动压缩`);
    } else if (this.autoCompactTok > 0 && u.inTok >= this.autoCompactTok) {
      // v4 硬顶: 绝对 token 数, 回合结束触发 — 不看 idle, 消息再密也压得到.
      this.compactRequested = `自动压缩·ctx ${u.inTok}tok ≥ 硬顶 ${this.autoCompactTok}tok`;
      console.error(`[autoCompact] ${this.name} ctx ${u.inTok}tok ≥ ${this.autoCompactTok}tok → 本轮结束后自动压缩`);
    }
  }

  exportState() {
    return {
      sessionId: this.sessionId, model: this.model, window: this.window,
      // 档位存下来**只为诊断**(事后看这个数当时从哪来的), restore 刻意不读回它 —— 理由见那边。
      windowTier: this._windowTier,
      lastInput: this.lastInput, pendingHandoff: this.pendingHandoff,
    };
  }
  restore(s) {
    if (!s) return;
    this.sessionId = s.sessionId || null;
    this.model = s.model || null;
    // 存的 window 只在没有模型名时才用: 有模型名就按它现算。否则上一版存下的脏值
    // (比如切模型前那个 1M)会被原样读回来, 于是"关标签重开"也修不好分母。
    // 🔴 存下来的**档位刻意不恢复**: 档位是"这个数当下从哪来的", 不是人格的属性。读回一份
    // 过期的 certain 会把这次启动该走的决议整个挡住, 而重算的成本是零。
    this.window = 0; this._windowTier = null;
    if (s.model) this._applyModelWindow(s.model);
    else this._setWindow(s.window || windowFor(null).value, W_TIER.default, 'restore·无模型名');
    // 防呆: 旧版本可能存过 result.usage 的累计脏值(> 窗口), 判无效
    this.lastInput = (s.lastInput && s.lastInput <= this.window) ? s.lastInput : 0;
    this.pendingHandoff = s.pendingHandoff || null;
  }
}

// 方法族按职责分文件, 逐字搬运后挂回 Butler.prototype。顺序无关(方法名不重叠)。
mixin(Butler,
  require('./agent/system-prompt'),
  require('./agent/mcp-tools'),
  require('./agent/mcp-channels'),
  require('./agent/stream'),
  require('./agent/window'),
  require('./agent/consume'),
  require('./agent/tasks'),
  require('./agent/wake'),
  require('./agent/compact'),
);

// 判 <memoryDir>/ctx_last.json 是否可注入 · v0.0.23 唐伯虎 2 审后抽 (main.js 冷启动 hook 就近调用, 单元测试友好, 未来其他地方也可复用)。
// 三态: 无文件/parse 失败/无 turns 都返 false · consumed_at 已打戳 → false · 超 48h stale → false · 其它 → true.
// 只判读, 不做副作用 (打戳仍在 buildWakePayload 消费瞬间完成, 保持单点)。
function hasUnconsumedCtxLast(memoryDir) {
  try {
    const ctxPath = path.join(memoryDir, 'ctx_last.json');
    if (!fs.existsSync(ctxPath)) return false;
    const raw = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));
    if (!raw || !Array.isArray(raw.turns) || !raw.turns.length) return false;
    if (raw.consumed_at) return false;
    const CTX_STALE_MS = 48 * 3600 * 1000;
    if (Date.now() - (raw.captured_at || 0) >= CTX_STALE_MS) return false;
    return true;
  } catch (_) { return false; }
}

module.exports = { Butler, hasUnconsumedCtxLast, nowStamp, applyAccessEnv, accessConfig, classifyAccessError, GATEWAY_MODEL_KEYS, GATEWAY_ENV_KEYS };
