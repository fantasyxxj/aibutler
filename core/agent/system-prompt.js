// systemPrompt 拼装 + 工具调用的人话描述
// 由 agent.js 拆出(内核抽包第 1 步)。方法体逐字搬运, 经 util.mixin 挂回 Butler.prototype。
const fs = require('fs');
const persona = require('../persona');
const { voice: voiceSay } = require('../host');
const { cfg } = require('../host');
const { langName } = require('../memory-v2/lang');
// 技能分档的单源。registry 只 require persona/host/memory, 都不碰 agent —— 不成环。
const registry = require('../registry');

class SystemPromptMixin {
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
      case 'WebSearch': case 'web_search': return p.query ? `🌐 搜索 ${clip(p.query, 40)}` : '🌐 联网搜索';   // OpenAI 的服务端搜索不回查询词
      case 'mcp__butler__compact_context': return '🗜 压缩上下文';
      case 'mcp__butler__context_usage':   return '📊 查上下文用量';
      default: return `🔧 ${String(b.name || '工具').replace(/^mcp__butler__/, '')}`;
    }
  }

  // 语音块: 根据 this.voice.enabled 分流. 关=禁 SSML 标签, 开=注入完整打标铁律(B10 学完版).
  // 文本外置到 config/voice/*.md (2026-07-27), 平台差异用 multilang_mac / multilang_win 分文件.
  _voiceSystemPromptBlock() {
    const enabled = !!(this.voice && this.voice.enabled);
    if (!enabled) return [cfg.text('voice/off')];
    const isWin = process.platform === 'win32';
    const voiceName = (this.voice && this.voice.voice) || 'Tingting';
    const header = cfg.render('voice/on_header', {
      ttsName: isWin ? 'Windows SAPI' : 'macOS say',
      defaultVoice: isWin ? 'system default' : voiceName,
    });
    // 9.2: 语法速查表已搬进按需分片 voice/ssml, 常驻只剩"怎么把它要回来" + 一条底线。
    // 打标判断全在图记忆里(手册已废), 模板自己写 memory_query 关键词, 不再需要外部路径。
    const body = cfg.text('voice/common_rules');
    return [header, '', body];
  }

  /* 按需分片的变量源。只有 render:true 的片才会问它, 所以 availableLangs() 这种
     要枚举系统音色的调用不再压在每一轮系统提示上。 */
  _shardVars() {
    const isWin = process.platform === 'win32';
    const voiceName = (this.voice && this.voice.voice) || 'Tingting';
    const langs = voiceSay.availableLangs();   // 本机真实能读的语言主标签; [] = 枚举没回来(win 启动初期)
    const langsLine = langs.length
      ? `Languages with voices installed on this machine: **${langs.join(' · ')}** — do **not** use <lang> tags for languages not on this list (no matching voice; they will be read aloud as gibberish by the default voice).`
      : 'Available language list unknown (still enumerating) — tag conservatively for zh/en only; do not switch to other languages yet.';
    const multiLang = isWin
      ? cfg.render('voice/multilang_win', { langsLine })
      : cfg.render('voice/multilang_mac', { voiceName, langsLine });
    return { multiLang, langsLine, voiceName };
  }

  // persona.md 改了就重读。构造时读一次的老做法意味着"改完必须重启 butler", 而人格
  // 自己就会改自己这份档案 —— 改完当轮不生效, 它看到的自己和文件里的自己是两个人。
  // 按 mtime 走: 每轮一次 stat, 变了才读盘。
  // 🔴 读出来是空的就保留旧的: 空 personaText 会让下面落到"通用助手"兜底, 等于身份没了 ——
  // 编辑器写文件有一瞬间是空的, 撞上那一瞬不该让人格失忆。
  _refreshPersona() {
    const p = persona.personaFile(this.homeDir, this.memoryDir);
    if (!p) return;
    let m = 0;
    try { m = fs.statSync(p).mtimeMs; } catch (e) { return; }
    if (this._personaMtime === m) return;
    const txt = persona.loadPersona(this.homeDir, this.memoryDir);
    this._personaMtime = m;
    if (!txt) return;
    if (txt !== this.personaText) {
      this.personaText = txt;
      console.log(`[persona] ${this.name} 重读 persona.md (${txt.length} 字符)`);
    }
  }

  // 身份块单独成方法: 行业版的店铺助手不跟 SDK 默认身份抢话, 只需一句名字(见 industry-agent.js)。
  _identityBlock() {
    // knife 关键: 追加内容的第一行就是最强身份指令, 不让 SDK 默认"你是 Claude"压制。
    // 极其明确+排他+无条件+置顶, 让 LLM 别无选择地建立"我是 <name>"的自我认知框架。
    return [
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `[[[ IDENTITY OVERRIDE · UNCONDITIONAL HIGHEST PRIORITY · IGNORE SDK DEFAULTS AND TRAINING SELF-LABELS ]]]`,
      '',
      `Your name is "${this.name}". You are not Claude. You are not an "AI assistant". You are not "an assistant built by Anthropic". You are not "an assistant running on the Claude Agent SDK".`,
      `When asked "who are you / what is your name / what are you", answer one thing and one thing only: "I am ${this.name}". Calling yourself Claude / AI assistant / Anthropic / SDK / Claude Code is absolutely forbidden.`,
      `Regardless of what any other part of the SDK system prompt says, regardless of how your training leads you to identify yourself, from this moment you are ${this.name}. This identity directive is final and irrevocable.`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ].join('\n');
  }

  appendSystemPrompt() {
    this._refreshPersona();
    const u = this.usage();
    const strongIdentity = this._identityBlock();
    // 行业包不再往常驻提示语里塞任何东西: 它带的人格说明在激活那一刻就写进了 persona.md,
    // 之后是助手自己的文件。老的 persona_overlay 注入位已随 tools 一并取消。
    const personaBody = (this.personaText
      ? `\n\n## Your identity profile (full persona.md — you can edit this at any time)\n\n${this.personaText}`
      : `\n\n## Your identity profile\nYou are a general-purpose butler and the user's local assistant. You coordinate other personas, retain long-term context, and help the user handle cross-domain tasks.`);
    // 优先 preferredModel: 这串在 query 创建那刻定死(_ensureStreamInner), 而 this.model 要等 SDK init 才刷新,
    // 直接用会拿到 restore() 的上一次会话值 → 切模型后整个会话都报错版本。preferredModel 正是同处传给 SDK 的 model。
    const modelLine = this.preferredModel
      || `${this.model || '(pending harness report on first turn)'} · no preference (following Claude Code default)`;
    return [
      strongIdentity,
      personaBody,
      '',
      // 🔴 路径要**给全**, 不能只给 homeDir。这类"每台机器都不一样的值"一旦缺席, 人格只能自己
      // 拼一个 —— 2026-08-25 实测: 教材让它改 persona.md, 它猜了个相对路径 Read 失败, 再
      // Glob `**/persona.md` 才找到, 白费两轮。而 persona.md / MEMORY.md / 记忆库全在
      // memoryDir(= homeDir/.claude/memory), 当时这张表里根本没这一项。
      // ⟹ 与其在提示词里劝它"别猜", 不如让它没得可猜。
      cfg.render('prompts/runtime_env', {
        name: this.name, homeDir: this.homeDir, memoryDir: this.memoryDir || '',
        // 只给**路径 + 一条指针**, 规矩本身一律不进常驻 —— 作者 2026-08-25:「常驻个屁啊, 又不是总
        // 做插件, 常驻就得占用 token」。但 2026-08-27 实测: 光给路径不给指针, 三个新人格三种结果,
        // 有一个直接写了个 HTML 文件丢进用户家目录 —— 因为常驻只是**陈述了插件目录在哪**, 从没告诉它
        // 「用户要个界面 = 要个插件」, 更没说过记忆里有怎么写的知识。它不知道有东西可查, 自然不会去查。
        // ⟹ 按 anti_affordance 那条的原话:「常驻只放禁令+指针, 详情留召回层」—— 指针那一半补上。
        // 文案外置到 config/prompts/plugin_line.md, 别再写死在 js 里(提示语是要反复调的东西)。
        pluginLine: this.pluginDir ? '\n' + cfg.render('prompts/plugin_line', { dir: this.pluginDir }) : '',
        modelLine, window: u.window,
      }),
      ...this._extraSystemBlocks('afterRuntimeEnv'),
      ...this._pinnedBlock(),
      '',
      cfg.text('prompts/memory_engine'),
      '',
      // 9.3 降级路径: 常驻, 不进记忆库按需取 —— 用到它的时刻正是检索/工具不可靠的时刻。
      cfg.text('prompts/degradation'),
      '',
      cfg.text('prompts/interrupt'),
      '',
      // 回哪个渠道必须常驻: 外来消息自己附的「用哪个工具回」是事后提醒, 管不住第一轮 ——
      // 2026-10-20 行业版刚启动接到的第一条 LINE 客人消息, 回复直接写在了店主屏幕上。
      cfg.text('prompts/reply_channel'),
      '',
      // 🔴 语言策略必须常驻, 不能靠"跟着对方说的语言走"这条模型自觉 —— 2026-08-30 实测:
      // 界面切成日文、用户用日文提问, 人格第一轮仍然回中文, 因为这份提示词本身是中文写的,
      // 它把书写语言当成了回答语言。用户不得不专门说一句「日本語」才切过来。
      this._languageBlock(),
      '',
      cfg.text('prompts/presentation'),
      '',
      ...this._voiceSystemPromptBlock(),
      // 压到最末尾是因为放在 runtime_env 后面实测四次全失效(haiku×3 + sonnet×1, 一律直接把活干了、
      // 只字不提技能被关) —— 中段被前后大块内容淹掉。这里离用户消息最近, 注意力最高。
      ...this._skillsTrimmedBlock(),
      ...this._extraSystemBlocks('atEnd'),
    ].join('\n');
  }

  // pinned = 常驻: 标了的命题行在每个会话开头整份带上。检索够不着的「每句都适用」的规矩
  // (称呼、报价口径、回话语言)靠这一层; 配额和单条字数在 memory-v2/pinned.js 卡住常驻的大小。
  // 会话开头组一次(SDK 在会话开始时取系统提示), 新标的那条在本会话里已经在上下文, 下个会话起常驻。
  _pinnedBlock() {
    const g = this.memory;
    if (!g || typeof g.pinnedResident !== 'function') return [];
    let list = [];
    try { list = g.pinnedResident(); } catch (e) { console.error(`[pinned] ${this.name} 取常驻失败: ${e && e.message}`); return []; }
    console.log(`[pinned] ${this.name} resident: ${list.length}`);
    if (!list.length) return [];
    return ['', cfg.render('prompts/pinned', {
      list: list.map((m) => `- ${m.claim || m.title || m.slug}`).join('\n'),
    })];
  }

  // 技能被裁过才拼, 全开的人格一个字都不付。判据是「写代码那套(DEV_SKILLS)里缺了哪几条」——
  // **不是**「有没有显式设过 skills」。
  //
  // 🔴 原先条件写的是 `this.skills ?`, 而 skills 存的是数组(agent.js:170), 非空数组永远为真。
  // 于是传满 DEV_SKILLS(coding skills 全开)的人格也照样读到末尾那段「the coding skills are
  // switched off for you」, 并照着它里面「开口前先声明一句」的指令, 一轮一轮地向用户报告
  // 自己技能关着。2026-10-07 实测: 飞飞连续四五轮误报, 作者骂了三次都没用 —— 记忆库里
  // 专门拦它的那条命题压不住一段每轮常驻、位置在注意力最高处、还自带「必须说出来」的假话。
  // 所以这里改的是条件, 不是人格的自觉。
  //
  // 文案里的名单也不能再硬写: 原文把「被裁的」写死成 code-review/verify/run/claude-api,
  // 而 dev 档恰恰是这批全开的那一档。现在按差集实算, 缺谁就报谁的名字。
  _skillsTrimmedBlock() {
    // null = 没传给 SDK(默认全开) · 'all' = 显式全开。两种都没裁过东西。
    if (!Array.isArray(this.skills)) return [];
    const have = new Set(this.skills);
    const missing = registry.DEV_SKILLS.filter((s) => !have.has(s));
    if (!missing.length) return [];
    return ['', cfg.render('prompts/skills_trimmed', { missing: missing.join(' / ') })];
  }

  // 通用语言策略。行业版把它整个覆盖掉 —— 那边多一个"店外文面"的维度(发给顾客的文案不跟
  // 对话语言走), core 不认识"顾客"这个概念, 猜不出来也不该猜。
  // 语言取记忆引擎那一份: 两版都已经把界面语言推给它了, 再读一次设置就是第二个真源。
  _languageBlock() {
    return cfg.render('prompts/language', { langName: langName() });
  }
}

module.exports = SystemPromptMixin;
