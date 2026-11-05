// MCP 工具面的组装: buildMcp 主干 + 外部 MCP / bus MCP 入口解析。
// 由 agent.js 拆出(内核抽包第 1 步)。通道那一族在 mcp-channels.js, 经 this._channelTools 取回。
const path = require('path');
const fs = require('fs');
const os = require('os');
const persona = require('../persona');
const { paths } = require('../host');
const registry = require('../registry');
const registerMemoryToolsV2 = require('../memory-tools-v2').registerMemoryToolsV2;
const { cfg } = require('../host');
const { registerPluginTools } = require('./plugin-tools');
const { guardEmptyArgs, loadSdk, isSdkKind, withTimeout } = require('./util');
// 任务清单的参数表 —— 逻辑在 consume.js 的 taskOp 上, 这里只拿参数表拼 schema。
const { TASK_OPS } = require('./tasks');
const { looseShape, gather } = require('./flat-args');
const { OPS: REMINDER_OPS, reminderOp } = require('../reminders');

// 逐项账的排版。SDK 各组给的是无序全量, 这里一律按 tok 降序 —— 找的是"谁最胖", 不是名录。
// 超出 top 的合并成一行并写明条数: 静默截断会被读成"就这些", 那正是要避免的误判。
function billSection(title, list, label, top, sum = true) {
  if (!list || !list.length) return '';
  const s = [...list].sort((a, b) => b.tokens - a.tokens);
  const head = s.slice(0, top);
  const lines = head.map((x) => `  ${String(x.tokens).padStart(7)}  ${label(x)}`);
  const rest = s.length - head.length;
  if (rest > 0) {
    const tail = s.slice(top).reduce((a, x) => a + x.tokens, 0);
    lines.push(`  ${String(tail).padStart(7)}  …${rest} more`);
  }
  const total = sum ? ` · ${s.reduce((a, x) => a + x.tokens, 0)} tok` : '';
  return `\n${title} — ${s.length} items${total}\n${lines.join('\n')}\n`;
}

function formatContextBill(r) {
  const out = [`📊 per-item bill · ${r.totalTokens} / ${r.maxTokens} tok (${r.percentage}%) · model ${r.model}`];
  // categories 含 "Free space"(剩余空间, 不是成本项), 合计它会得出比窗口还大的数 → 这一组不打合计。
  out.push(billSection('CATEGORIES', r.categories, (x) => x.name + (x.isDeferred ? ' [deferred]' : ''), 20, false));
  out.push(billSection('SYSTEM PROMPT SECTIONS', r.systemPromptSections, (x) => x.name, 25));
  out.push(billSection('BUILT-IN TOOLS', r.systemTools, (x) => x.name, 30));
  out.push(billSection('DEFERRED BUILT-IN TOOLS', r.deferredBuiltinTools, (x) => x.name + (x.isLoaded ? ' [loaded]' : ''), 30));
  out.push(billSection('MCP TOOLS', r.mcpTools, (x) => `${x.serverName}__${x.name}${x.isLoaded === false ? ' [deferred]' : ''}`, 40));
  out.push(billSection('MEMORY FILES', r.memoryFiles, (x) => `${x.type} · ${x.path}`, 10));
  out.push(billSection('AGENTS', r.agents, (x) => `${x.agentType} (${x.source})`, 15));
  if (r.slashCommands) out.push(`\nSLASH COMMANDS — ${r.slashCommands.includedCommands}/${r.slashCommands.totalCommands} included · ${r.slashCommands.tokens} tok\n`);
  if (r.skills) out.push(`\nSKILLS — ${r.skills.includedSkills}/${r.skills.totalSkills} included · ${r.skills.tokens} tok\n`
    + billSection('  skill frontmatter', r.skills.skillFrontmatter, (x) => `${x.name} (${x.source})`, 20));
  const m = r.messageBreakdown;
  if (m) {
    out.push(`\nMESSAGES — toolCall ${m.toolCallTokens} · toolResult ${m.toolResultTokens} · attachment ${m.attachmentTokens}`
      + ` · assistant ${m.assistantMessageTokens} · user ${m.userMessageTokens} · redirected ${m.redirectedContextTokens}`
      + ` · unattributed ${m.unattributedTokens}\n`);
    out.push(billSection('  by tool (call+result)', (m.toolCallsByType || []).map(
      (t) => ({ name: t.name, tokens: t.callTokens + t.resultTokens, c: t.callTokens, rr: t.resultTokens })),
    (x) => `${x.name} (call ${x.c} / result ${x.rr})`, 25));
    out.push(billSection('  by attachment', m.attachmentsByType, (x) => x.name, 15));
  }
  if (r.apiUsage) out.push(`\nAPI USAGE — in ${r.apiUsage.input_tokens} · out ${r.apiUsage.output_tokens}`
    + ` · cache write ${r.apiUsage.cache_creation_input_tokens} · cache read ${r.apiUsage.cache_read_input_tokens}\n`);
  out.push(`\nauto-compact: ${r.isAutoCompactEnabled ? `on @ ${r.autoCompactThreshold ?? '?'}` : 'off'}`);
  return out.filter(Boolean).join('');
}

class McpToolsMixin {
  async buildMcp() {
    const { tool, createSdkMcpServer } = await loadSdk(this.sdkKind);
    const { z } = await import('zod');
    const D = cfg.json('tools/descriptions');   // 19 tool desc 外置 · 热读 · 改 config/tools/descriptions.json 即生效
    const compact = tool(
      'compact_context',
      D.compact_context,
      { reason: z.string().describe('reason for compacting now (e.g. usage is at X%, just finished Y)') },
      async ({ reason }) => {
        this.compactRequested = reason || 'model-initiated request';
        // §2.5 反思批 touch: 本轮 memory_query 命中的 ids 呈现给 AI, 让它挑真用过的批 memory_touch.
        // 注意 memory_touch 语义收紧: 只在"真依赖某条节点做了决策/给了答案"后调; 打开/扫过 ≠ 用了.
        let hint = '';
        if (this.sessionHits && this.sessionHits.size > 0) {
          const ids = [...this.sessionHits];
          hint = `\n\n📋 This session's memory_query returned ${ids.length} hits:\n${ids.map((id) => `  - ${id}`).join('\n')}\n\nBefore compacting, reflect: call memory_touch([id1, id2, ...]) to batch-bump any node you genuinely relied on for a decision or answer. Do **not** touch nodes you merely scanned or opened without actually using (semantics tightened: opened ≠ used).`;
        }
        // 交接便条只有"起来读"是代码保证的(唤醒正文硬装), "清空前写"一直靠自觉 —— 一半硬一半软。
        // 提醒放在调用那一刻而不是只写在工具描述里: 描述说的是"该做什么", 这里说的是"现在就做"。
        const noteHint = `\n\n📝 One more thing before clearing: **update the MEMORY.md handoff note to the current state** (what is unfinished / who you are waiting on / where you are stuck).`
          + ` The memory graph requires a query to retrieve; MEMORY.md is the first thing hard-loaded on wake — skipping this update means the next session starts from stale information.`;
        return { content: [{ type: 'text', text: `✅ Registered — will compact at end of this session.${noteHint}${hint}` }] };
      }
      // 刻意**不**加 alwaysLoad: 压缩是低频动作, 触发时机是"上下文已经肥了", 那时多一跳搜索无所谓。
      // 常驻名额只留给"多一跳就会导致我少做"的那四件记忆工具(见 memory-tools-v2.js)。
    );
    const ctxUsage = tool(
      'context_usage',
      D.context_usage,
      { detail: z.boolean().optional().describe('true = per-item token bill (which tool / prompt section / memory file costs what). Default false = total only.') },
      async ({ detail }) => {
        const u = this.usage();
        const line = `Current context usage: ${u.pct}% (${u.inTok} / ${u.window} tokens, model ${u.model || 'unknown'})`;
        if (!detail) return { content: [{ type: 'text', text: line }] };
        // 逐项账只有 SDK 算得出(它才知道每段 schema 序列化后多大), 拿不到就说拿不到, 不估。
        if (!this._q) return { content: [{ type: 'text', text: `${line}\n\n(no per-item bill: no live stream)` }] };
        let r;
        try { r = await withTimeout(this._q.getContextUsage(), 15000, `getContextUsage(${this.name})`); }
        catch (e) { return { content: [{ type: 'text', text: `${line}\n\n(per-item bill failed: ${e.message})` }] }; }
        return { content: [{ type: 'text', text: `${line}\n\n${formatContextBill(r)}` }] };
      }
    );
    // —— 聊天记录检索: 记忆存的是"结论", 这里给的是"原话" ——
    // 压缩/重启后模型手里只剩最近 3 轮(compact.js 的 getRecent(6)), 而实测回指的落点中位在 44 条
    // 消息之前、p90 到 941 条 —— 任何固定窗口都覆盖不了这种分布, 只能按词现捞。
    // 🔴 纯按需: 不预加载、不在压缩时自动触发。查不查、拿什么词查, 由模型自己判断。
    const chatLog = tool(
      'chat_log',
      D.chat_log,
      { keywords: z.string().describe('space-separated keywords; all must appear (falls back to any-match if that yields nothing)'),
        limit: z.number().optional().describe('how many hits to return, newest first. Default 10, max 50'),
        before: z.number().optional().describe('epoch ms cursor — only look at messages older than this. Use the ts of the oldest hit to page further back') },
      async ({ keywords, limit, before }) => {
        const dir = path.join(path.dirname(this.sessionPath), 'history');
        const terms = String(keywords || '').split(/\s+/).filter(Boolean);
        if (!terms.length) return { content: [{ type: 'text', text: '⚠️ chat_log needs at least one keyword.' }] };
        let r;
        try { r = require('../chat-store').searchHistory(dir, { terms, limit, before }); }
        catch (e) { return { content: [{ type: 'text', text: `⚠️ chat_log failed: ${e.message}` }] }; }
        if (!r.total) return { content: [{ type: 'text', text: `🔎 "${terms.join(' ')}" — no hit in this persona's chat log.` }] };
        const when = (ts) => { const d = new Date(ts || 0); const p2 = (n) => String(n).padStart(2, '0');
          return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
        // 🔴 total 必须报出去: 拿到 10 条却以为"总共就聊过这 10 次"会直接导致错误判断。
        const head = `🔎 "${terms.join(' ')}" — ${r.total} hit(s)`
          + (r.truncated ? `, showing the newest ${r.returned}` : '')
          + (r.matched === 'any' ? ' · no message contained all keywords, so this is an ANY-match' : '')
          + (r.scanTruncated ? ' · ⚠️ log too long to scan fully, older entries were not searched' : '');
        const body = r.hits.map((h) => {
          const L = [`[${when(h.ts)}] ${h.role}: ${h.text}`];
          if (h.prev) L.unshift(`   ↑ ${h.prev.role}: ${h.prev.text}`);
          if (h.next) L.push(`   ↓ ${h.next.role}: ${h.next.text}`);
          return L.join('\n');
        }).join('\n\n');
        const tail = r.truncated ? `\n\n(page further back with before=${r.hits[0].ts})` : '';
        return { content: [{ type: 'text', text: `${head}\n\n${body}${tail}` }] };
      }
    );
    // —— 原生图记忆工具(每人格自带; 遗忘曲线热度 + 图扩散关联检索) ——
    const G = () => this.memory;
    const { sendTg, busExec, busAdmin } = this._channelTools({ tool, z, D });
    // 记忆工具集中在 memory-tools-v2.js。
    const memTools = registerMemoryToolsV2({ tool, z, graph: G, descriptions: D,
      onHit: (id) => this.sessionHits.add(id), agent: this });
    const { pluginFind, pluginOpen, pluginCall } = registerPluginTools(this, { tool, z, D });
    const tools = [compact, ctxUsage, chatLog, pluginFind, pluginOpen, ...(pluginCall ? [pluginCall] : []), ...memTools, sendTg, busExec, busAdmin];
    // —— ask_persona 已删(2026-09-08)。它与 talk_peer 语义等价, 当年留双工具是为了兼容既有习惯;
    //    6149 份 transcript 实测 ask_persona 24 次 / talk_peer 260 次, 习惯早已归一。
    //    投递路径 personaOps.ask 仍留着(wakeloop 等处在用), 只是不再作为工具暴露。
    // —— talk_peer: mesh 全放开 (v0.0.25, 2026-07-21). 所有人格都有, 任意点对点直连 ——
    const talkP = tool(
      'talk_peer',
      D.talk_peer,
      { target: z.string().describe('target persona name / id / directory'),
        message: z.string().describe('the message to send to it') },
      async ({ target, message }) => {
        if (!this.personaOps || !this.personaOps.peerTalk) return { content: [{ type: 'text', text: '⚠️ Peer-talk capability not ready' }] };
        // 投递限时: 同 ask_persona, 目标卡死不许连坐本方
        const r = await withTimeout(this.personaOps.peerTalk(this.name, target, message, { fromDir: this.homeDir }), 60000, `talk_peer投递(${this.name}→${target})`)
          .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        return { content: [{ type: 'text', text: r && r.ok ? `✅ ${r.note || `Delivered to "${r.from}" · one-way async`}` : `⚠️ ${(r && r.error) || 'delivery failed'}` }] };
      }
    );
    tools.push(talkP);
    // —— voice_switch (2026-08-19 作者): 人格自己开关自己的语音. 原来只有用户在设置面板里能改.
    // 系统提示里那段语音铁律是【建流那刻冻结】的, 本轮不会因为开关而重刷 —— 所以返回值必须把
    // "从现在起该怎么输出"当场讲清, 人格照着改这一轮的口径, 下一轮系统提示才会是新的。
    const voiceSw = tool(
      'voice_switch',
      D.voice_switch,
      { on: z.boolean().describe('true=enable voice · false=disable'),
        voice: z.string().optional().describe('optional voice name (e.g. Tingting / Kyoko / Samantha); default=keep current') },
      async ({ on, voice }) => {
        if (!this.personaOps || !this.personaOps.setVoice) return { content: [{ type: 'text', text: '⚠️ Voice toggle capability not ready' }] };
        const was = !!(this.voice && this.voice.enabled);
        let next;
        try { next = this.personaOps.setVoice({ enabled: on, voice }); }
        catch (e) { return { content: [{ type: 'text', text: `⚠️ Switch failed: ${(e && e.message) || e}` }] }; }
        const same = was === !!next.enabled;
        const how = next.enabled
          ? 'From now on wrap every reply in <speak>...</speak>, using break/emphasis/prosody/sub as needed. For tagging guidance run memory_query "voice tagging SSML" — do not rely on memory.'
          : 'From now on reply in plain text only. Do not write <speak>/<break>/<emphasis>/<prosody>/<sub> tags — the "voice on" hard rule in the system prompt no longer applies.';
        return { content: [{ type: 'text', text:
          `✅ Voice ${next.enabled ? 'enabled' : 'disabled'} (voice: ${next.voice})${same ? ' · already in this state' : ''}\n${how}` }] };
      }
    );
    tools.push(voiceSw);
    // —— run_script: 不常用的活儿一律走脚本, 一个口全包。清单与执行在 core/agent/scripts.js ——
    // 🔴 每多注册一个工具, 它的 schema 每一轮都在付钱, 而这类活儿几天才用一次 —— 为不常用功能
    // 占常驻上下文是最亏的。加新功能 = 往 core/scripts/ 丢一个 .js, 这里一个字都不用改。
    const runScript = tool(
      'run_script',
      D.run_script,
      looseShape(z, { name: z.string().optional().describe('脚本名; 不填就列出这台机器上有哪些能跑。脚本的参数直接写在后面, 如 run_script(name=…, x=…)') }),
      async (input) => ({ content: [{ type: 'text', text:
        await require('./scripts.js').runScript(input.name, gather(input, ['name']), { homeDir: this.homeDir }) }] })
    );
    tools.push(runScript);
    // —— persona_tune (v6 keepalive · 2026-07-22): 让人格调 keepalive/compact 参数. 任何人格都可调自己或他人.
    // 白名单校验 field 免撞坏其它 registry 字段. 下轮 decideActions (≤30s) 从 registry live 读 → 立即生效, 无需重启.
    const TUNABLE_FIELDS = new Set([
      'keepaliveMaxTimes',        // v6 保活次数熔断 (默认 10 = 盈亏平衡; 值班紧点可下调, 长空闲可上调)
      'keepaliveMinTok',          // v7 兜底 · ctx <此值不保活 (仅在 wakeCtxBase 尚未写入时用, 默认 20k)
      'keepaliveRatio',           // v7 动态门倍率 · 门 = wakeCtxBase × ratio (默认 1.2 · 净涨 20% 才保)
      'compactHardcapSoftTok',    // 硬顶软化下限 (默认 150k · 到此紧一档"停手1min就压")
      'compactHardcapIdleMin',    // 硬顶软化 idle 门 (默认 1min)
      'skills',                   // 技能白名单(字符串数组; [] = 一条不留)。⚠️ 与上面几个不同: 建流那刻定死, 要重新建流才生效
      'sdk',                      // 走 key 时用哪个引擎: "claude-code" | "butler"; null = 装了 Claude Code 就用它。同 skills, 重新建流才生效
    ]);
    // 技能分档取自 registry —— 界面建人格那条路(create-persona-ui)也读同一份, 定义两处必然漂开。
    const { BASE_SKILLS, DEV_SKILLS } = registry;
    // —— persona_admin: 人格管理四件并成一个口(list / open / create / tune) ——
    // 分法依据是真实频次(6149 份 transcript): list 6 · open 0 · create 3 · tune 5, 四件合计 14 次,
    // 而 talk_peer 260 次留独立 —— 冷路径并起来省的是每轮都在付的常驻工具位。
    //
    // 🔴 权限语义原样保留: list/open/create 原先只在 isButler 时注册(星型中心), tune 所有人格都有。
    //    并进来之后靠 butlerOnly 标记在 op 层挡, **不是悄悄把权限放开** —— 非管家调那三个会被
    //    明确拒绝, 而不是假装没有这回事。
    // 🔴 四个 op 必须在说明里逐个点名, 名字本身就是触发信号(见 memory_admin 那次的教训)。
    const PERSONA_OPS = {
      list: { butlerOnly: true, req: [], opt: [], hint: '列出登记簿里所有人格。',
        run: async () => {
          if (!this.personaOps || !this.personaOps.list) return '⚠️ List-persona capability not ready';
          const rows = (await this.personaOps.list()) || [];
          if (!rows.length) return '(registry is empty)';
          return `${rows.length} persona(s):\n` + rows.map((p) =>
            `- ${p.name}${p.isButler ? ' [butler]' : ''}${p.isOpen ? ' (open)' : ''}  id=${p.id}  ${p.homeDir}`).join('\n');
        } },
      open: { butlerOnly: true, req: ['ref'], opt: [], hint: 'ref 收人格名 / id / 目录路径。',
        run: async (a) => {
          if (!this.personaOps || !this.personaOps.open) return '⚠️ Open-persona capability not ready';
          const r = await this.personaOps.open(a.ref);
          return r && r.ok ? `✅ Opened persona "${r.name}" (${r.homeDir})` : `⚠️ Open failed: ${(r && r.error) || 'persona not found: ' + a.ref}`;
        } },
      create: { butlerOnly: true, req: ['name'], opt: ['homeDir', 'wakePhrase', 'isButler', 'dev', 'accessMode', 'credentialId', 'model', 'sdk'],
        hint: `homeDir 缺省=数据目录/personas/<slug>; isButler=true 会顶替当前管家。\ndev=true 给写代码那批技能; 缺省只给 ${BASE_SKILLS.join('/')} —— 建人格时问一句用户要不要开发能力。\naccessMode / credentialId / model / sdk 缺省沿用你自己的。`,
        run: async (a) => {
          if (!this.personaOps || !this.personaOps.create) return '⚠️ Create-persona capability not ready';
          // 接入方式 / 凭据 / 模型 / 引擎缺省沿用创建者: 不给的话新人格落成「订阅 + 空模型」,
          // 没有订阅的机器(开源包)上它第一句话就起不来。建完再改要重开, 出生教育已经烧掉了, 所以在这一刻定。
          const own = { accessMode: this.accessMode, credentialId: this.credentialId || undefined,
            model: this.preferredModel || (this.accessMode === 'api' && this.model) || undefined,
            sdk: (this.accessMode === 'api' && this.sdkKind) || this.sdk || undefined };   // 引擎与模型都取自己此刻实际在跑的那个
          const r = await this.personaOps.create({ ...own, ...a, skills: a.dev ? DEV_SKILLS : BASE_SKILLS });
          return r && r.ok ? `✅ Created and opened persona "${r.name}"\nDir: ${r.homeDir}\nid: ${r.id}` : `⚠️ Create failed: ${(r && r.error) || 'unknown'}`;
        } },
      tune: { req: ['field', 'value'], opt: ['persona'],
        hint: `persona 缺省=自己。value 传 null 表示删掉该字段恢复默认。field 白名单: ${[...TUNABLE_FIELDS].join(' / ')}\nskills 收字符串数组, 或直接传字面量 "dev"(写代码那批: ${registry.DEV_SKILLS.length} 条) / "base"(只留 ${registry.BASE_SKILLS.join('/')}); [] = 一条不留。⚠️ 要开发能力就传 "dev", 别传 null —— null 是恢复默认全开, 会把跟你无关的技能一起塞回来。`,
        run: async (a) => {
          const { field } = a;
          if (!TUNABLE_FIELDS.has(field)) return `⚠️ Invalid field: ${field}\nAllowlist: ${[...TUNABLE_FIELDS].join(' / ')}`;
          const isSkills = field === 'skills';
          // 默认调自己 — 用当前 butler 的 homeDir 定位 registry entry
          let entry;
          if (a.persona) {
            // 数值参数谁都能替别人调; skills 收归管家 —— 关掉的清单从对方系统提示里整个消失,
            // 他无从察觉自己少了什么, 所以这权限跟 list/open/create 同档, 只给星型中心。
            if (isSkills && !this.isButler) return `⚠️ field='skills' 只有管家能替别人改; 你可以改自己(不传 persona)。`;
            entry = registry.resolveRef(a.persona);
            if (!entry) return `⚠️ Persona not found: ${a.persona}`;
          } else {
            entry = registry.getByDir(this.homeDir);
            if (!entry) return `⚠️ Current persona not registered in registry (homeDir=${this.homeDir})`;
          }
          // 'dev'/'base' 两个字面量: 不给这条捷径的话, 「把开发技能开起来」就得手抄 11 个名字,
          // 而人格会选更省事的那条 —— 传 null 恢复默认(=全开), 白名单省下的那点又全吐回去了。实测撞过。
          let value = a.value;
          if (isSkills && value === 'dev') value = registry.DEV_SKILLS;
          if (isSkills && value === 'base') value = registry.BASE_SKILLS;
          const isSdk = field === 'sdk';
          const bad = isSkills
            ? !(value === null || (Array.isArray(value) && value.every((s) => typeof s === 'string')))
            : isSdk ? !(value === null || isSdkKind(value))
              : !(value === null || (Number.isFinite(value) && value >= 0));
          if (bad) return `⚠️ ${isSkills ? 'skills 收字符串数组, 或字面量 "dev"(写代码那批) / "base"(只留定时轮询查资料); [] = 一条不留' : isSdk ? 'sdk 只收 "claude-code" / "butler" / null' : 'value must be a number ≥0'}, got: ${JSON.stringify(value)}`;
          const before = entry[field];
          registry.upsert({ id: entry.id, homeDir: entry.homeDir, [field]: value });
          // upsert 用 Object.assign — 传 undefined/null 都会覆盖; 明确 null 时删掉
          if (value === null) {
            const reg = registry.loadRegistry();
            const cur = reg.personas.find((p) => p.id === entry.id);
            if (cur) { delete cur[field]; registry.saveRegistry(reg); }
          }
          const show = (v) => (v == null ? '(default)' : JSON.stringify(v));
          return `✅ persona_admin(op='tune') "${entry.name}" ${field}: ${show(before)} → ${show(value)}\n${isSkills || isSdk
            ? '⚠️ 建流那刻定死 —— 本次会话仍是旧清单, 要重新建流(关掉重开 / 拆流重建)才换上新的。'
            : 'Takes effect on next decideActions cycle (≤30s)'}`;
        } },
    };
    const personaAdmin = tool(
      'persona_admin',
      D.persona_admin,
      looseShape(z, { op: z.enum(Object.keys(PERSONA_OPS)) }),
      async (input) => {
        const { op } = input;
        const args = gather(input, ['op']);
        const spec = PERSONA_OPS[op];
        if (spec.butlerOnly && !this.isButler) {
          return { content: [{ type: 'text', text: `⚠️ op='${op}' 只有管家(星型中心)能用; 这个人格只能用 op='tune'。` }] };
        }
        const a = args || {};
        const missing = spec.req.filter((k) => a[k] === undefined);
        if (spec.req.length && (!args || missing.length)) {
          return { content: [{ type: 'text', text:
            `op='${op}' 需要 ${spec.req.map((k) => `${k}=…`).join(', ')}${spec.opt.length ? ` · 可选 ${spec.opt.join(', ')}` : ''}`
            + `${missing.length && args ? `\n缺: ${missing.join(', ')}` : ''}\n${spec.hint}` }] };
        }
        return { content: [{ type: 'text', text: String(await spec.run(a)) }] };
      }
    );
    tools.push(personaAdmin);
    // —— task: 任务清单四件并成一个口(list / create / update / get) ——
    // 🔴 这里**只有壳**: 逻辑在 consume.js 的 `taskOp` 上。写进这个闭包就不可测 ——
    //    persona_admin 那套 PERSONA_OPS 至今测不到, 别再添一个。
    // 🔴 四个 op 必须在说明里逐个点名, 名字本身就是触发信号(见 memory_admin 那次的教训)。
    // 这份清单以前是借 harness 的 TaskCreate/TaskUpdate 维护的(靠偷看消息流里的入参), 于是
    // id 两边各自发号、同号不同事 —— 面板清不掉/盘上删不掉/Task not found 三个 bug 都从那来。
    const taskTool = tool(
      'task',
      D.task,
      looseShape(z, { op: z.enum(Object.keys(TASK_OPS)) }),
      async (input) => ({ content: [{ type: 'text', text: String(this.taskOp(input.op, gather(input, ['op']))) }] })
    );
    tools.push(taskTool);
    // —— reminder: 到点提醒的登记簿。AI 只登记, 到点由巡检(idle-watcher)叫醒它去说 ——
    // 逻辑全在 core/reminders.js(纯函数, 可测), 这里同 task 只有壳。
    const reminderTool = tool(
      'reminder',
      D.reminder,
      looseShape(z, { op: z.enum(Object.keys(REMINDER_OPS)) }),
      async (input) => ({ content: [{ type: 'text', text: String(reminderOp(this.memoryDir, input.op, gather(input, ['op']), new Date(), this.homeDir)) }] })
    );
    tools.push(reminderTool);
    tools.push(require('../sys-tool').mcpTool(tool, z, D.sys));   // 系统工具: 模型易错的事交给程序, 按 op 分
    // —— get_chip_usage: 哪些按钮真在被用, 哪些是死按钮。判断依据是事实不是猜测 ——
    // 🔴 2026-08-17 作者统一个人版/行业版口径: 出厂模板各不同, **更新机制只有一套**。
    //    「从来没用过的, 一段时间之后提醒用户去掉; 用的多的功能可以总结加上去」
    // 提醒 ≠ 自动删: 按钮是用户屏幕上看得见的东西, 动它之前必须他点头。
    const chipUsage = tool(
      'get_chip_usage',
      D.get_chip_usage,
      {},
      async () => {
        if (!this.personaOps || !this.personaOps.chipUsage) {
          return { content: [{ type: 'text', text: '⚠️ Chip capability not ready (this persona has no UI attached)' }] };
        }
        const { rows, stale } = this.personaOps.chipUsage();
        if (!rows.length) return { content: [{ type: 'text', text: '(no prompt chips yet)' }] };
        // 🔴 回完整定义, 不只是 id+label: 要改一颗按钮就得先看得见其余几颗原样长什么样,
        //    否则只能凭印象重编 —— 那正是"加一个却把别的改坏"的成因。
        const body = rows.map((r) => {
          const tag = r.lifetime === 'once' ? ` [note${r.group ? '·' + r.group : ''}]`
            : r.lifetime === 'until_done' ? ' [temp]' : '';
          const kind = r.kind && r.kind !== 'prompt' ? ` (${r.kind}, no prompt)` : '';
          return `${r.id} · ${r.icon || '💡'} ${r.label}${tag} · ${r.source}${kind}`
            + ` — pressed ${r.count} times · shown for ${r.days} days`
            + (r.prompt ? `\n    prompt: ${r.prompt}` : '');
        }).join('\n');
        const tip = stale.length
          ? `\n\n💡 These have been shown for a long time but never pressed — ask the user if they want to replace them (do not delete on your own):\n`
            + stale.map((r) => `   ${r.id} · ${r.label}(${r.days} days)`).join('\n')
          : '';
        return { content: [{ type: 'text', text: body + tip }] };
      }
    );
    tools.push(chipUsage);
    // —— update_prompt_chips: 让人格自己换输入框上方的快捷按钮(每人格独立) ——
    // 出厂那批是【安装时下发的模板】, 一律永久档 —— 点过不消失。自定义那批档位自己挑(registry.CHIP_LIFETIMES):
    // 便签(lifetime:once + group)点完整组自动撤走, 这是 2026-08-21 作者提的"chip 当便签用"。
    // 默认仍是整套替换(清空要靠它); mode:'merge' + remove 提供按 id 的增量 —— 原先只有整套替换,
    // 而 get_chip_usage 又只回 id+label, 于是"加一颗"等于凭印象把其余几颗重编一遍, 必然改坏。
    // 什么时候该换属判断力, 不在这里复述; 手法在工具描述 D.update_prompt_chips 里。
    const updChips = tool(
      'update_prompt_chips',
      D.update_prompt_chips,
      { chips: z.array(z.object({
          id: z.string().describe('stable short id, lowercase ASCII (e.g. daily_report)'),
          icon: z.string().optional().describe('single emoji, default 💡'),
          label: z.string().describe('text on the button, ≤10 chars preferred. The user may not press it for hours — include which project it refers to'),
          prompt: z.string().describe('the complete sentence sent on behalf of the user when pressed (first-person, from the user\'s perspective). Must be self-contained: you may have been restarted by then, so reading this one sentence must be enough to know which project and what is being asked'),
          lifetime: z.enum(['permanent', 'once', 'until_done']).optional()
            .describe('default permanent (persists after press). once=note chip, auto-dismissed after press, whole group dismissed together. until_done=temporary but not auto-dismissed, you remove it yourself'),
          group: z.string().optional()
            .describe('mutually exclusive options for the same question share a group; used with lifetime:once — when the user presses one, the whole group disappears'),
        })).optional().describe('the chips to write. In replace mode (default) this is the FULL set — anything omitted disappears; empty array = clear every chip on screen including factory ones. In merge mode it is only the ones you are adding or changing'),
        mode: z.enum(['replace', 'merge']).optional()
          .describe("default replace (full set, and empty array clears everything). Use merge to add or edit a few by id without resending the rest — read get_chip_usage first only if you need the current text; merge leaves untouched ids exactly as they are"),
        remove: z.array(z.string()).optional()
          .describe('ids to drop from the custom set; works with merge (can be used alone, with no chips)') },
      async ({ chips, mode, remove }) => {
        if (!this.personaOps || !this.personaOps.setChips) return { content: [{ type: 'text', text: '⚠️ Chip capability not ready (this persona has no UI attached)' }] };
        const merging = mode === 'merge';
        // 传空 = 用户要"没有按钮", 出厂那批也得退休 —— 否则他看着屏幕原样, 以为你没照做。
        // 🔴 增量模式除外: merge 传空是"这次没有要改的", 不是"清空屏幕"。
        const clearAll = !merging && (!Array.isArray(chips) || chips.length === 0);
        const r = this.personaOps.setChips(chips || [], { retireFactory: clearAll, mode, remove });
        if (!r || !r.ok) return { content: [{ type: 'text', text: `⚠️ Update failed: ${(r && r.error) || 'unknown'}` }] };
        if (clearAll) return { content: [{ type: 'text', text: '✅ All chips cleared (custom + factory-shipped both retired, will not reappear). UI refreshed in place.' }] };
        // 把每个按钮真正落库的档位回显出来 —— 档位拼错会被退回 permanent(见 registry.setCustomChips),
        // 不回显的话"便签没设成便签"要等到他点了不消失才发现。
        const names = r.chips.map((c) => {
          const tag = c.lifetime === 'once' ? `[note${c.group ? '·' + c.group : ''}]`
            : c.lifetime === 'until_done' ? '[temp·self-dismiss]' : '';
          return `${c.icon} ${c.label}${tag}`;
        }).join(' · ');
        const dropped = Array.isArray(remove) && remove.length ? `\nRemoved: ${remove.join(', ')}` : '';
        const how = merging ? 'merged — ids you did not mention are untouched' : 'replaced as a whole set';
        return { content: [{ type: 'text', text: `✅ Custom chips ${how}, now ${r.chips.length}: ${names}${dropped}\n(UI refreshed in place; factory-shipped chips remain — they are permanent, pressing them does not dismiss them, explicit clear is required to remove them)` }] };
      }
    );
    tools.push(updChips);
    // 管家专属那三件(list / open / create)已并进上面的 persona_admin, 按 op 的 butlerOnly 标记
    // 在运行时挡 —— 不再靠"只给管家注册"来区分, 但拒绝语义完全一致。
    // v0.0.25 mesh 化后 grant_peer/revoke_peer 工具已下线 (无需授权, 所有人格默认直连).
    // main.js personaOps.grantPeer/revokePeer + registry.peerLinks 保留为幽灵, 不影响运行, 后续可清理.
    // core 自带的这批到此为止。宿主点名不要的先摘掉, 再让能力包/子类补自己那份 ——
    // 顺序反过来的话, 同名工具会两份一起进 SDK, 而 SDK 见到重名直接抛。
    const dropped = new Set(this._droppedCoreTools());
    const kept = dropped.size ? tools.filter((t) => !dropped.has(t.name)) : tools;
    // 🔴 能力包はここに一つも工具を足さない。**包に「道具」という概念は無い** ——
    //    業種ごとの端点は bus_exec + 出荷時知識で届き、画面の按钮は插件自身の宣言に書いた
    //    端点を叩く。ここに足していた頃は、押されもしない宣言を毎ターン全量課金していた。
    kept.push(...(await this._extraMcpTools({ tool, z })));
    // 本轮真实注册的工具名 —— 「工具调用漏成正文」的判定要拿它当硬事实(见 lost-toolcall.js),
    // 光看正文长得像不像调用是分不开"真出事"和"正在讨论这件事"的。
    // 外部 MCP(dc-platform 那几十个)不在这份里, 它们的泄漏就漏检 —— 宁漏勿误。
    this._knownToolNames = new Set([
      ...kept.map((t) => `mcp__butler__${t.name}`),
      'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch',
    ]);
    return guardEmptyArgs(createSdkMcpServer({ name: 'butler', version: '0.0.1', tools: kept }), kept);
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
        // env 同 _buildBusMcpEntry: MCP stdio 只继承 PATH/HOME/USER 等白名单, 代理键会被剥掉 → 显式补
        if (s && s.command) out[name] = { command: s.command, args: s.args || [], env: { ...require('../host').proxy.envForChild(), ...(s.env || {}) } };
      }
    } catch (e) { this._emit('onActivity', `⚠️ 读外部 MCP 配置失败: ${e.message}`); }
    return out;
  }

  // 🔴 _buildBusMcpEntry 已删除(2026-08-24 bus 统一)。
  // 它当年为了 mcp__bus__exec 单独起一个 agent-bus-mcp 子进程, 于是 /bus/v1/agent/exec
  // 在个人版里有了**两份出向实现且信封不一致**(那份多带 from_agent/ts)。
  // 现在 exec 由 core 内置的 bus_exec 工具直接走 core/bus.js 发, 不再需要子进程。
}

module.exports = McpToolsMixin;
