// 持久流式会话: 建流 · 提交 · 打断 · 拆流
// 由 agent.js 拆出(内核抽包第 1 步)。方法体逐字搬运, 经 util.mixin 挂回 Butler.prototype。
const gateSubmit = require('../rate-gate').gateSubmit;
const CancelToken = require('../rate-gate').CancelToken;
const { CLAUDE_BIN, HAS_EXTERNAL_TEXT, nowStamp, loadSdk, resolveSdkKind, makeMsgQueue, withTimeout } = require('./util');
const { takeDayOpener } = require('./day-opener');
const { buildEnv } = require('./env');
const crypto = require('crypto');
const turnMute = require('./turn-mute');
const { cfg } = require('../host');

class StreamMixin {
  /* SDK 的 systemPrompt 选项。默认接在 claude_code 预设后面 —— 那份预设讲的是写代码、跑 git、
     开 PR、用 skills, 对个人版的开发帮手成立。传纯字符串则是**整份替换**(sdk.d.ts:2094),
     预设一个字都不进。行业版走后者: 店里那台机器上的人格不写代码, 预设那 ~8950 字符每轮都白付。 */
  _systemPromptOption() {
    return { type: 'preset', preset: 'claude_code', append: this.appendSystemPrompt() };
  }

  /* SDK に載せる**内蔵道具**の絞り込み(sdk.d.ts:1455)。undefined = 触らない(Claude Code の既定一式)。
     道具の schema は名前も説明も引数定義も**毎ターン一緒に送られる**ので、使わない道具を載せたままに
     すると常駐プロンプトと同じだけ課金される —— しかもプロンプトと違って目に見えない。
     名簿を config に置くのは、外した道具を戻すのに再パッケージを要らなくするため
     (config-loader の上書き層が効く)。allowedTools では代われない: bypassPermissions 下では
     内蔵道具を止められず、そもそも「載せるかどうか」を決めるのはこちらだけ。 */
  _toolsOption() { return cfg.json('main/builtin_tools') || undefined; }

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
    // 图已经是 image block 摆在模型眼前了, 但模型不知道 —— 2026-08-27 实录: 测测 thinking 里已描述出图的内容
    // (「两个白色药丸形按钮」), 嘴上却答「我看不到图片文件路径」并去 find /tmp 找文件。它默认图这种东西要去磁盘取。
    const _imgN = blocks.filter((b) => b.type === 'image').length;
    if (_imgN) blocks.push({ type: 'text', text: `（本条消息随附 ${_imgN} 张图，已直接在你眼前，看就是了；不要去磁盘或 /tmp 找图片文件。）` });
    return { type: 'user', message: { role: 'user', content: blocks }, parent_tool_use_id: null, uuid: crypto.randomUUID() };
  }

  // 启动持久流式 query(幂等 + 单飞)。
  // 🔴 2026-07-17 双分身事故: doCompact 重启瞬间两条消息隔 1ms 并发投递, 旧版 check-then-create
  // 之间隔着多个 await(loadSdk/buildMcp), 两条都穿过 !this._q 检查 → 建出两个同名会话各自消费。
  // 单飞锁: 建流进行中的并发调用共享同一个 promise, 只有第一个真建。
  async ensureStream() {
    if (this._q) return;
    if (this._ensuring) {
      return this._ensuring;
    }
    this._ensuring = this._ensureStreamInner().finally(() => { this._ensuring = null; });
    return this._ensuring;
  }

  async _ensureStreamInner() {
    // 用哪个 SDK 每次建流现算(接入方式 / sdk 字段改了, 重开时就换); buildMcp 跟着用同一个 ——
    // 两个 SDK 的 createSdkMcpServer 产物互不认。
    const kind = await resolveSdkKind({ accessMode: this.accessMode, sdk: this.sdk });
    if (kind !== this.sdkKind) console.log(`[sdk] ${this.name} → ${kind}`);
    this.sdkKind = kind;
    const { query } = await loadSdk(kind);
    const butlerMcp = await this.buildMcp();
    const extMcp = this.resolveExtMcp();          // 该人格放行的外部 MCP(如 dc-platform), 缺省 {}
    const hasExt = Object.keys(extMcp).length > 0;
    this._queue = makeMsgQueue();
    // _deltaText 一并清: 认证失效判据靠它区分"模型逐字说的"和"CLI 整块塞的"。
    // 上一轮没走到 result 就断流的话它会留值, 残留会让下一轮的真 401 漏判。
    this._cur = ''; this._deltaText = '';
    this._ac = new AbortController();
    // v3 改造 (2026-07-13): 停用 SDK resume — butler 重启后**不再**续接旧 session,
    // 一律新建空白 session. 老策略靠 resume:sessionId 让 SDK 从 jsonl 全量塞回历史,
    // 码上飞 jsonl 已到 2.36MB, 一次冷读 30-40 万 tokens ≈ 20% 会话额度, 直接撞铁板.
    // 界面用户历史走 butler 自己的 s.convo (get-history 走本地), 完全不依赖 jsonl.
    // 模型端"续线程"改靠 systemPrompt (persona.md + MEMORY.md 索引) + memory_hot/query 工具.
    // 注: doCompact 仍需 resume 旧 session (那次是刻意 resume 生成摘要), 不受此改动影响.
    const model = this.preferredModel;       // 模型只由人格自己定, 接入方式不参与
    const options = {
      resume: undefined,   // v3: 恒空. sessionId 只用于 doCompact 那次刻意续接.
      cwd: this.homeDir,
      pathToClaudeCodeExecutable: CLAUDE_BIN, // 捆绑/解析后的 claude, 免 PATH 依赖
      abortController: this._ac,             // teardown 拆不动时的硬中止句柄
      env: buildEnv(model, this.accessMode === 'api', this.gateway, this.credentialId),   // 恒传: 订阅模式靠它显式清掉外部 ANTHROPIC_* 防劫持
      ...(model ? { model } : {}),           // 空=跟随 Claude Code 默认
      permissionMode: 'bypassPermissions',
      // 关掉 SDK auto-memory: 它会在 ~/.claude/projects/<cwd>/memory/ 自建一份 MEMORY.md 并把**它的**
      // 绝对路径注进 claudeMd, 而唤醒读的是人格 memoryDir 那份 —— 模型改便条时眼前只有前者的路径,
      // 必然写错文件, 下一程就从过期状态起步(2026-08-21 实撞)。人格记忆一律走图记忆, CC 侧不留副本。
      settings: { autoMemoryEnabled: false },
      // 用 systemPrompt: {preset, append} 而非旧 appendSystemPrompt: SDK 语义等价, 但显式声明"我们要追加, 不做替换";
      // 关键是 append 内容里的强身份指令 (appendSystemPrompt()方法生成) 必须让 LLM 明确身份优先于默认 Claude 训练身份。
      systemPrompt: this._systemPromptOption(),
      ...(this._toolsOption() ? { tools: this._toolsOption() } : {}),
      ...(this.settingSources ? { settingSources: this.settingSources } : {}),
      ...(this.skills ? { skills: this.skills } : {}),
      mcpServers: { butler: butlerMcp, ...extMcp, ...this._extraMcpServers() },
      strictMcpConfig: true,                  // 只用上面明确列的 MCP; 屏蔽全局其余(lazyweb/unity…), 上下文才干净
      extraArgs: { 'replay-user-messages': null },   // CLI 开始处理某条用户消息时带原 uuid 回发 —— 静音按它对账(agent/turn-mute.js)
      includePartialMessages: true,           // 开逐字流式: SDK 抛 stream_event 增量 delta → 治"想很久一大串蹦出来"
      // AskUserQuestion 接入: SDK 派 request_user_dialog control_request → 转 renderer 弹选项框.
      // AskUserQuestion 禁用: v0.0.38 尝试接线但根因是 CLI 二进制里 checkPermissions 强制走 canUseTool 路径,
      // 与 bypassPermissions 冲突 → 直接把 message "Answer questions?" 当 error 返给 AI. 放弃接线, 显式黑名单撵走.
      disallowedTools: ['AskUserQuestion'],
      // 红线硬闸。挂 PreToolUse 而不是靠提示词, 因为提示词是模型可以选择不听的东西;
      // 也不能靠过输出 —— 等 tool_use 出现在 butler 代码里时 Bash 已经跑完了。
      // sdk.d.ts 明写 PreToolUse 的 deny 绕开 canUseTool, 与 bypassPermissions 不冲突
      // (行业版 fs-guard 已真会话验证过同一条通路)。
      // 三个守卫共用 PreToolUse: 源码锁在最前(分发版里它是硬边界, 拦下就不必再算后面两个),
      // 红线次之(它可能 deny, 早拦早省), 索引最后(只附一眼)。
      ...(() => {
        const pre = [...this._extraPreToolUseHooks()];
        if (this.selfGuard) pre.push(this.selfGuard.hook);
        pre.push(require('../escape-guard').hook(this));   // 中日文写成 \u 转义 → 打回重写
        if (this.redlineGuard.enabled) pre.push(this.redlineGuard.hook());
        if (this.queryFirstGuard) pre.push(this.queryFirstGuard.hook());
        if (this.indexGuard.enabled) pre.push(this.indexGuard.hook());
        return pre.length ? { hooks: { PreToolUse: [{ hooks: pre }] } } : {};
      })(),
    };
    // 白名单收在 buildAllowedTools 里 —— 行业版要在个人版这份的基础上加自己那几个,
    // 逻辑内联在这儿它就没法 super 调用, 只能整段抄一份(那正是两版漂开的老路)。
    const allow = this.buildAllowedTools(hasExt);
    if (allow) options.allowedTools = allow;
    const q = query({ prompt: this._queue, options });
    this._q = q;
    // _consumerDone 平时没人 await(只有 teardown 会), 所以子进程自己死掉时 _consume 抛出的错
    // 会冒成 unhandledRejection 走全局兜底。就地接住: 错误照样落日志, 但 teardown 能正常 await 到它
    // (此时子进程已经死了, 原先那条 catch 里的 abort 强拆本来就是空操作)。
    this._consumerDone = this._consume(q).catch((e) => {
      console.error(`[stream] ${this.name} 消费循环异常结束: ${e && e.message}`);
    });
  }

  isRunning() { return this._busy; }

  // 硬打断: 界面「⏹ 取消」按的就是这里; 软插话默认不调用。
  //
  // 🔴 这是**救援**路径, 它必须比它要救的那条路更结实 —— 而 2026-09-24 之前它反而更脆:
  // 光一句 await q.interrupt(), 没超时、没兜底、连一行日志都不打。于是最该救的那种场合
  // (子进程还活着但这一轮收不了尾)按下去石沉大海, 事后连"他按没按过"都查不出来。
  // 按 teardown 那条路的样子办: 限时 → 拆流(ensureStream 会用 sessionId 原地重建, 上下文不丢)。
  async interrupt() {
    // 顺便 cancel rate gate 里正在排队等桶的 acquire (waiter 立即返 cancelled=true), 免占坑.
    try { this._gateCancelToken.cancel(); this._gateCancelToken = new CancelToken(); } catch (_) {}
    if (!this._q) { console.log(`[interrupt] ${this.name} 没有在跑的流, 无事可打断`); return false; }
    try {
      await withTimeout(this._q.interrupt(), 5000, `interrupt(${this.name})`);
      console.log(`[interrupt] ${this.name} 已打断当前回合`);
      return true;
    } catch (e) {
      console.error(`[interrupt] ${this.name} 打断不动(${e && e.message}) → 拆流强救`);
      try { await this._teardownStream(); } catch (e2) { console.error(`[interrupt] ${this.name} 拆流也失败: ${e2 && e2.message}`); }
      this._busy = false;
      this._emit('onResult', { finalText: '', interrupted: true });
      return true;
    }
  }

  // 提交一条用户消息(软插话): 直接 push, 【不打断】。模型把手头这步做完, 到下个间歇读到它、自行决定是否改道。
  // opts.sourceKind 三档:
  //   'user'  用户在本机窗口里打的字
  //   'inbox' 外面来的真实文本(agent-bus / TG / LINE / 人格间 talk_peer / Local API poke)
  //   'auto'  本人格自己生出来的回合(唤醒 / 心跳 / 沉淀 / 压缩自愈 / 出生教育 / 各类重试)
  // rate gate 只分 user 与非 user 两桶, 所以 inbox 与 auto 在配额上同档(rate-gate.js:157);
  // 差别在【配不配记忆】—— 见 HAS_EXTERNAL_TEXT。别再把带外部文本的通路写成 'auto'。
  async submit(text, attachments, opts = {}) {
    const _traceId = opts._traceId || '';
    const _tSubmit0 = Date.now();
    console.log(`[LATENCY] submit_enter agent=${this.name} trace=${_traceId} sourceKind=${opts.sourceKind || 'user'} compacting=${!!this._compacting} clearing=${!!this._clearing}`);
    // 新会话的唤醒先单独跑完一轮, 这一条才进队(compact.js startWake)。唤醒轮自己和心跳不等。
    if (!opts._bypassClearGate && !opts._alone && !(typeof text === 'string' && text.startsWith('[[HEARTBEAT]]'))) await this._awaitWake();
    // 等压缩带保险栓: doCompact 已有 5min deadline 必 settle, 这里 6min 是第二道防线——
    // 万一等不到也放行走 ensureStream, 绝不把 submit(→ 别人的 ask/talk 投递)永久卡死。
    if (this._compacting) { try { await withTimeout(this._compacting, 360000, `等压缩(${this.name})`); } catch (_) {} }
    // 清空(整理记忆)进行中: 外部 submit 等它完成再走, 免撞半拆的流。内部沉淀轮带 _bypassClearGate 跳过(否则自锁)。
    if (this._clearing && !opts._bypassClearGate) {
      try { await withTimeout(this._clearing, 180000, `等清空(${this.name})`); } catch (_) {}
      // 闲时清空(idleClear)是清完才挂唤醒标记的, 撞在清空中途进来的这条, 上面那次 _awaitWake 看不到它。
      if (!opts._alone && !(typeof text === 'string' && text.startsWith('[[HEARTBEAT]]'))) await this._awaitWake();
    }
    const _tAfterGate1 = Date.now();
    if (_tAfterGate1 - _tSubmit0 > 50) console.log(`[LATENCY] submit_gate_compact_clear agent=${this.name} trace=${_traceId} dt=${_tAfterGate1 - _tSubmit0}ms`);
    // idle-watch 门 dirtySinceLastClear: 只有真"干活"消息才把它拉起来 —— `_bypassClearGate` 的
    //   sediment/wake(清空自愈, 人格没被叫)与 [[HEARTBEAT]](纯 cache 续命)不算, 其余一切都算。
    const isHeartbeatPing = typeof text === 'string' && text.startsWith('[[HEARTBEAT]]');
    // 🔴 心跳轮要静音(那句 "ok" 不该写进会话), 但静音**只在下面入队处绑自己那一轮** —— 在这儿
    //    先开一个全局待认领的静音位, 会被随后入队的真人提交抢走, 掐死他那一整轮的界面事件。
    // 值得重发的 = 真消息(用户/peer/TG), 不含心跳与各种内部自愈轮 —— 重登后回放这条。
    // 🔴 `_authRetry` 必须在排除列表里: 它是 _retryAfterTransientFault 自己发起的自动轮, 没有真人在场。
    // 漏了它的后果是下面那道挂起闸把它当成"真人又发话了"→ 解除挂起 + 清 _authRetried + 摘横幅,
    // 于是「撞上→定罪挂起→重试轮自己解除」每 3.5 秒一圈无限转(实测连转近 4 小时), 横幅只活 1 毫秒,
    // 用户永远点不到那个重登按钮。
    const _replayable = !isHeartbeatPing && !opts._authRetry && !opts._emptyTurnRetry && !opts._forceSediment && !opts._redlineRetry && !opts._bypassClearGate;
    if (_replayable) this._lastSubmitPayload = { text, attachments, opts };
    // 接入故障挂起中。这道闸只挡【没人在场的自动轮】—— 心跳/自愈轮撞上确定性故障会无限空转烧钱。
    // 🔴 真人/peer 又发话了就必须放行: 他按下回车本身就是重试意愿, 且判定可能一开始就是误判
    //    (分类只认正文特征, 人格正常谈到那几个词就会被判死)。挡住的代价是人格永久哑掉 —— 解除
    //    挂起的唯一入口 replayAfterRelogin 挂在横幅的重登按钮上, 而配额那类根本不给按钮, 于是
    //    误判即等于只能重启 app。放行的代价只是再吃一次报错, 两者不对称。
    if (this._authBlocked) {
      if (!_replayable) {
        console.error(`[access] ${this.name} 挂起中, 自动轮不提交`);
        return;
      }
      // 流多半已经死了(凭证类故障子进程自己退), 不拆等于白试 —— 拆完下面 ensureStream 会重建。
      console.error(`[access] ${this.name} 挂起中收到真消息 → 解除挂起, 重建流再试一次`);
      this._authBlocked = false;
      this._authRetried = false;
      try { await this._teardownStream(); } catch (e) {
        console.error(`[access] ${this.name} 拆流失败(继续): ${e && e.message}`);
      }
      // 横幅必须跟着摘: 挂着"用不了"却又能对话, 用户没法判断当前到底是什么状态。
      this._emit('onAuthExpired', { name: this.name, kind: 'cleared' });
    }
    if (!opts._bypassClearGate && !isHeartbeatPing) {
      this.dirtySinceLastClear = true;
      // v6 (2026-07-22): 真消息进来重置保活计数. 心跳 / sediment / wake 不算真消息, 不重置.
      // 🔴 auto 轮(存记忆提醒 · 体检 · 各类重试)也不重置: 保活攒满是「人确实走了」的唯一短程证据,
      //    30 分钟一次的 SAVE_NUDGE 每次都清零它, 闲置人格就永远走不到 keepalive_maxed 压缩(10-09 实测)。
      //    → memory reference_save_nudge_turn_erases_person_away_evidence
      if ((opts.sourceKind || 'user') !== 'auto') this.keepalive_count = 0;
    }
    // 回合结束时宿主据此决定要不要把它记成"有人活动"(personal/main.js onResult)。
    this._turnSourceKind = opts.sourceKind || 'user';
    // 防幻觉 rate gate (spec §16.3.1): submit-time only, 只在真正打 API 那一瞬扣桶.
    // Opus 4.x 走双桶 (user 30 RPM / auto 20 RPM), 非 Opus 直通不 gate. 干净 cancel: interrupt → cancelToken.cancel().
    // P0 特权: opts._bypassRateGate=true 直通不 gate (bothub [P0-* 等 SLA 敏感消息 · 狂人 2026-07-20 派单钦定 <5s 端到端).
    const gate = opts._bypassRateGate
      ? { ok: true, cancelled: false, waitedMs: 0, gated: false, bypass: true }
      : await gateSubmit({
          model: this.model || this.preferredModel,
          sourceKind: opts.sourceKind || 'user',
          cancelToken: this._gateCancelToken,
        });
    if (gate.cancelled) { console.error(`[rate-gate] ${this.name} submit cancelled (interrupt during wait)`); return; }
    if (gate.gated && gate.waitedMs > 500) {
      console.log(`[rate-gate] ${this.name} bucket=${gate.bucketName} waited=${gate.waitedMs}ms`);
    }
    const _tBeforeEnsure = Date.now();
    if (_tBeforeEnsure - _tAfterGate1 > 50) console.log(`[LATENCY] submit_rate_gate agent=${this.name} trace=${_traceId} dt=${_tBeforeEnsure - _tAfterGate1}ms bucket=${gate.bucketName || '-'} waited=${gate.waitedMs || 0}`);
    const _hadStream = !!this._q;
    await this.ensureStream();
    const _tAfterEnsure = Date.now();
    console.log(`[LATENCY] submit_ensure_stream agent=${this.name} trace=${_traceId} had_stream=${_hadStream} dt=${_tAfterEnsure - _tBeforeEnsure}ms`);
    // pendingHandoff 已废弃(旧满仓 resume 交接摘要的产物)。续线程改由"唤醒引导加载器"(buildWakePayload)承担,
    // 不再往 submit 正文注入交接摘要。字段仅为兼容旧持久态保留, 恒不注入。
    // 新回合开始: memory_* 计数归零; 记下真人原话供 result 时判"该沉没沉"(auto 轮置 null 不判)。
    const _srcKind = opts.sourceKind || 'user';
    // 原话流水(底片): 存【裸原话】—— 在拼时间戳和 nudge 之前。加工过的不是底片。
    // 心跳不存(它不是话, 是个空转信号, 存了只会把流水淹掉)。
    if (!isHeartbeatPing) this._logUtterance('user', text, _srcKind);
    this._turnMemoryOps = 0;
    this._turnMemoryWrites = 0;
    this._turnHadThinking = false;
    // 打回上限是"这一轮别无限打回", 不是"这条红线一辈子只拦两次"
    try { this.redlineGuard.resetTurn(); } catch (_) {}
    try { this.indexGuard.resetTurn(); } catch (_) {}
    try { if (this.queryFirstGuard) this.queryFirstGuard.resetTurn(); } catch (_) {}
    this._turnKnowledgeHits = [];
    if (!opts._forceSediment) this._forceSedimentRetried = false;
    // 补提轮不清 retried 标记, 否则"空→补提→又空→再补提"会无限打转
    if (!opts._emptyTurnRetry) this._emptyTurnRetried = false;
    // 这一轮允不允许"只思考不出声"。默认不允许(空回合几乎总是模型卡住), 只有内务轮显式开:
    // 体检那种活干完了本来就无话可说, 逼它说一句反而正是我们要消掉的噪音。
    this._allowEmptyTurn = !!opts._allowEmptyTurn;
    if (!opts._redlineRetry) this._redlineRetried = false;
    if (!opts._lostToolRetry) this._lostToolRetried = false;
    if (!opts._authRetry) this._authRetried = false;
    // 判「该沉没沉」用的也必须是原文。信封里「它不接收回复」这种句子中间就藏着触发词(「收回」),
    // 于是每条 Local API 消息都在误触发记忆提醒 —— 跟消息内容毫无关系, 纯粹是子串撞上了。
    const _userText = opts.rawText !== undefined ? opts.rawText : text;
    this._turnUserText = (HAS_EXTERNAL_TEXT(_srcKind) && !isHeartbeatPing && typeof _userText === 'string') ? _userText : null;
    const _nudge = this._takeMemoryNudge(_srcKind);
    // 每轮查一次: 够得上高档的把【主键 + 命题行】拼进来, 够不上的只留流水不注入。详见 _auditRecall。
    //
    // 🔴 查的是 `opts.rawText`(没套信封的原文), 不是即将提交的 text。bus/TG/LINE/Local API
    // 那几条通路的正文外面裹着一层信封(来源标签 · 投递说明 · 处理指示), 那些词不是对方问的话,
    // 却照样参与打分 —— 查询词一多, 每条记忆的覆盖率被摊薄, 真正相关的会被压到注入线以下。
    // dev 实测同一句话: 裸文 top=0.367, 套上 api_single 信封后直接 0 条命中。
    // 不传就退回 text(真人回合本来就是裸的), 所以新增通路忘了传只是回到旧行为, 不会炸。
    // 🔴 用 !== undefined 不用 ||: 图片/贴图/文件这类消息**没有文字**, 原文就是空串。空串是
    // falsy, 拿 || 会退回整条信封, 于是 payload 的 JSON、文件路径、base64 提示全被当成查询词
    // 丢进检索 —— 那正是这次改动要躲的东西, 而且在最没意义的场合(没话可查)代价最大。
    // 空串的正确含义是"这条没东西可查", 让 min_query_len 那道门把它挡掉。
    const _raw = opts.rawText !== undefined ? opts.rawText : text;
    const _recall = (await this._auditRecallAsync(_raw, _srcKind, isHeartbeatPing)) || '';
    // 碎片触发同理: 一片就是整份细则, 被信封里的词撞出来一次就白付一大段
    const _shard = this._takeKnowledgeShards(_raw, _srcKind, isHeartbeatPing);
    // 空提醒不拼, 免把非字符串 text 隐式转成字符串
    const _stamped = typeof text === 'string' ? nowStamp() + text : text;
    // 当天第一条真人消息才有, 一天一次(见 day-opener.js)
    const _opener = takeDayOpener(this, _srcKind, isHeartbeatPing);
    const _pre = `${_recall}${_shard}${_nudge}${_opener}`;
    const body = _pre ? _pre + _stamped : _stamped;
    this._busy = true;
    const _msg = this.buildUserMessage(body, attachments);
    this._queue.push(_msg);
    // 轮号在【真进队列】这一刻才定 —— 上面那几道闸会 await, 早编号会与实际入队次序错开。
    ++this._turnSeq;
    // 静音登记: 心跳与沉淀轮(opts._mute)是静音提交; 补提轮沿用被扣住那一轮。哪一轮静音按 CLI 回放对账(见 turn-mute.js)。
    const _continuation = !!(opts._emptyTurnRetry || opts._forceSediment || opts._redlineRetry || opts._lostToolRetry);
    turnMute.noteSubmit(this, _msg.uuid, _continuation ? this._turnMuted : !!(opts._mute || isHeartbeatPing), opts.turnMeta);
    this._lastSubmitTraceId = _traceId;
    this._lastSubmitAt = Date.now();
    this._firstDeltaSeenForSubmit = false;
    this._firstOutputAt = 0;   // 本轮第一个产出(文字或工具调用)的时刻, 看门狗据此把"排队等首字"和"正在干活"分成两段计时
    this._lastOutputAt = 0;    // 本轮最近一个产出的时刻 — 干活那段的活体信号, 看门狗只据此判死(见 compact.js 的 _askUntilDoneOrDead)
    this._lastToolName = '';   // 本轮最近调用的工具名 — 退出遮罩拿它告诉用户"它正在干什么"
    console.log(`[LATENCY] submit_queue_pushed agent=${this.name} trace=${_traceId} total_dt=${Date.now() - _tSubmit0}ms`);
    // 真进了队列才回 true; 上面被挡下的几条路(挂起中的自动轮 / 等配额时被中断)回 undefined。
    // 收件方(bothub 收件箱)据此决定这批算不算交付 —— 没进队列的要留着重交。
    return true;
  }

  // 提交一句并等这一轮答完, 拿 finalText。走标准 submit + UI 照常显示 + 挂一个 pending 收结果。
  // 现存调用方只有"后台自己喂自己"两处: 出生教育串行喂(main.js) / 清空前沉淀。
  // 跨人格 ask_persona / talk_peer 已改单向异步(投递即返回, 不用本函数), 故默认不设超时——
  // 没有"发起方被卡住"这回事, 超时只会把认真干活(多轮工具调用)的一步误判成死。
  // 真正的死亡信号是流被拆: _teardownStream 会 flush 掉挂起的 pending, 调用方据此收尾。
  // 有真 deadline 的调用方(清空前沉淀)显式传 timeoutMs。
  // 🔴 _askPending 是靠**先进先出**跟 result 对齐的, 队列里一个位置对应一轮。所以放弃等待的调用方
  // **不许**把自己的 resolver 摘掉 —— 那一轮还活着, 它迟早吐出自己的 result, 已 settled 的 resolver
  // 正是吸收它的墓碑; 摘了墓碑, 迟到的回复就串给下一个提问的人。下面 drop() 只用在"这一轮压根没发出去"
  // (submit 抛了)和调用方显式传了 timeoutMs 的两处 —— 前者队列里本就不该有它的位置。
  async askOnce(text, timeoutMs = 0, opts = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const cleanup = () => { if (timer) { clearTimeout(timer); timer = null; } };
      const drop = () => { const i = this._askPending.indexOf(resolver); if (i >= 0) this._askPending.splice(i, 1); };
      // _consume 出 result 时 shift 出本 resolver 调它 → settle。
      const resolver = (v) => { if (settled) return; settled = true; cleanup(); resolve(v); };
      this._askPending.push(resolver);
      // 止血: 传了超时才挂计时器(0/缺省 = 不超时)。给有真 deadline 的调用方用。
      if (timeoutMs) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true; drop();
          reject(new Error(`对方(${this.name})${Math.round(timeoutMs / 1000)}s 内未响应 — askOnce 超时(已解开调用方, 防卡死)`));
        }, timeoutMs);
      }
      this.submit(text, undefined, opts).catch((e) => {
        if (settled) return;
        settled = true; cleanup(); drop();
        reject(e);
      });
    });
  }

  // 关标签/退出: 干净停掉后台流, 释放大脑
  async dispose() { try { await this._teardownStream(); } catch (_) {} }

  hasStream() { return !!this._q; }

  // 闲置回收: 拆掉子进程但**会话对象留着** —— 插件(TG/LINE/bothub)挂在会话上不在流上, 所以拆完
  // 外部通路照样收得到信; 下一条消息进来时 submit 里的 ensureStream 自己把流建回来(与重登自愈同一条路)。
  //
  // 之所以不丢东西: 建流恒 `resume: undefined`(v3 起), 本来就不续接旧 SDK 会话, 连续性一直靠
  // systemPrompt + 记忆工具。所以「拆掉再建」与「关掉重开」是同一件事, 而后者每天都在发生。
  //
  // 🔴 但必须补一次唤醒。唤醒正文是 `openPersona` 投的, **不在 ensureStream 里** —— 只拆流的话
  // 复活后人格会冷着答话: 身份还在(systemPrompt), 但起床清单 / 热记忆 / 上次说到哪全没有。
  // 所以这里立一个旗, 下一轮 submit 先单独跑一轮唤醒再放原话进来(compact.js startWake)。
  async park() {
    if (!this._q) return false;
    await this._teardownStream();
    this._parkedNeedsWake = true;
    return true;
  }

  // 重登成功后的自愈: 拆掉攥着旧凭证的子进程 → 解除挂起 → 回放暂存的那条消息。
  // 【必须拆流】子进程只在启动那刻读一次 keychain, 光把新凭证写进去它不会重读 —— 不拆等于白登。
  // 拆完 _q=null, 下面 submit 内的 ensureStream 会自动重建(即现成的 Level 1 自愈路径)。
  async replayAfterRelogin() {
    if (!this._authBlocked) return { ok: true, replayed: false, reason: 'not_blocked' };
    try { await this._teardownStream(); } catch (e) {
      console.error(`[auth-expired] ${this.name} 重登后拆流失败(继续): ${e && e.message}`);
    }
    this._authBlocked = false;   // 必须先解除, 否则下面 submit 会被自己的挂起门挡回去
    const p = this._lastSubmitPayload;
    this._lastSubmitPayload = null;
    // 🔴 没东西可回放也必须把流建回来: 上面已经把流拆了, 直接 return 会留下"横幅已摘、看着正常、
    // 其实人格是哑的"这个状态, 用户只能关掉 app 重开。建回来才算重登真的生效。
    if (!p) {
      try { await this.ensureStream(); } catch (e) {
        console.error(`[auth-expired] ${this.name} 重登后重建流失败: ${e && e.message}`);
      }
      return { ok: true, replayed: false, reason: 'nothing_pending' };
    }
    this._emit('onActivity', '✅ 已重新登录 — 正在重发刚才那条消息');
    await this.submit(p.text, p.attachments, p.opts || {});
    return { ok: true, replayed: true };
  }

  // 服务抖动的重试: 跟 replayAfterRelogin 同一套动作(拆流 → 重发暂存的那条), 差别只在
  // **没挂起过、也不用等人重登**。拆流是必须的 —— 这一条流已经吃过一个错, 而且子进程只在
  // 启动那刻读一次 keychain, 不拆就还是同一个坏进程在答。拆完 _q=null, submit 里的
  // ensureStream 会自动重建(现成的 Level 1 自愈路径)。
  // 🔴 不清 _lastSubmitPayload: 万一这次重试又撞同一个错, 那条消息还得留着给重登后回放。
  async _retryAfterTransientFault() {
    try { await this._teardownStream(); } catch (e) {
      console.error(`[access] ${this.name} 重试前拆流失败(继续): ${e && e.message}`);
    }
    const p = this._lastSubmitPayload;
    if (!p) return { ok: true, replayed: false, reason: 'nothing_pending' };
    await this.submit(p.text, p.attachments, { ...(p.opts || {}), _authRetry: true });
    return { ok: true, replayed: true };
  }

  // 关闭当前持久流(压缩/退出用)。每步限时: 子进程/管道死掉时 interrupt 或消费循环可能永不返回,
  // 拆不动就 abort 硬中止再弃船 —— _q 清空后下次 ensureStream 自动重建, 即 Level 1 自愈。
  //
  // 🔴 2026-08-25 双会话事故: 本函数最慢要 20s, 而 clear() 只等它 15s 就宣告拆完并放行建新流。
  // 老版本全程读写 this._q / this._queue / this._ac / this._consumerDone 这些**会易主**的字段,
  // 于是超时后仍在跑的那半截拿到的已是【新流】的句柄: abort 掐死刚建的新流、又把新流的 _q 置空,
  // 而老子进程的 _ac 早被覆盖、永远没人 abort → 老会话活着继续自己喂自己(task-notification)并
  // 往同一个窗口吐字。表现就是两个会话轮流说话、上下文百分比在两个值之间跳。
  // 修法: 进门先把本代句柄全部**捕获成局部量**并当场摘牌(_q/_queue 置空), 之后一律只碰局部量。
  async _teardownStream() {
    // 流要没了 = 正在跑的那一轮收不到 result(放在 !q 早退之前) → 补一条 onTurnEnd, 否则界面的 busy 永远转圈。
    const _wasMuted = turnMute.dropTurn(this); if (this._busy) this._emit('onTurnEnd', { interrupted: true, muted: _wasMuted, torn: true });
    const q = this._q;
    if (!q) return;
    const queue = this._queue;
    const ac = this._ac;
    const consumerDone = this._consumerDone;
    // 摘牌要在任何 await 之前: 从这一刻起本代流不再是"当前流", 消费循环下一条消息就看见易主并退出,
    // 后面拆得再慢也碰不到别人的流。
    this._q = null; this._queue = null;
    try { this._gateCancelToken.cancel(); this._gateCancelToken = new CancelToken(); } catch (_) {}
    try { await withTimeout(q.interrupt(), 5000, `interrupt(${this.name})`); } catch (_) {}
    try { queue && queue.close(); } catch (_) {}
    try {
      await withTimeout(consumerDone, 10000, `consume收尾(${this.name})`);
    } catch (e) {
      console.error(`[selfheal] ${this.name} teardown 拆不动(${e && e.message}) → abort 强拆子进程`);
      try { ac && ac.abort(); } catch (_) {}
      try { await withTimeout(consumerDone, 5000, `consume收尾-abort后(${this.name})`); } catch (_) {}
    }
    // 兜底再 abort 一次: 上面正常收尾时它是空操作, 但调用方(clear)那层超时弃等时, 这是老子进程
    // 唯一的死刑执行点 —— 漏掉它就是一个没人管、还在往界面说话的孤儿会话。
    try { ac && ac.abort(); } catch (_) {}
    // 流拆了 = 上下文没了。"这条已经给过"的账必须跟着清零, 否则重建流之后我会以为
    // 那几条还在上文里而不再给 —— 变成永久漏给, 且不会有任何报错。
    this._shardSeen = null;
    this._flushAskPending();
  }

  // 流拆了 = 挂起的 askOnce 永远等不到 result → 用空串放行, 让调用方回到自己的循环顶部撞流守卫收尾。
  // (askOnce 默认不超时, 这里是它唯一的解开点: 按"死"解, 不按"慢"解)
  _flushAskPending() {
    const pend = this._askPending.splice(0);
    if (!pend.length) return;
    for (const r of pend) { try { r(''); } catch (_) {} }
  }

  // 该人格允许调哪些工具。返回 null = 不限制(有外部 MCP 的人格已 bypassPermissions 信任,
  // 逐个列 dc-platform 那几十个工具不现实)。
  // 🔴 单独成方法是为了让行业版能 `super.buildAllowedTools(hasExt)` 拿到这份再往上加 ——
  // 内联在建流那段里, 子类就只能整段抄一份, 而抄一份就是两版漂开的起点。
  buildAllowedTools(hasExt) {
    if (hasExt) return null;
    // 无外部 MCP(普通人格)→ 收紧白名单; 有外部 MCP(数据专家人格, 已 bypassPermissions 信任)→ 不限制,
    // 让 dc-platform 那几十个工具都可用(逐个列名单不现实)。
    // 🔴 注册进 buildMcp 还不够, 名字必须同时出现在这份白名单里, 否则模型看得见、调不动 ——
    //    bus_put_file / bus_get_file / persona_tune 都栽在这一步。新加工具时两处一起改。
    const out = ['mcp__butler__compact_context', 'mcp__butler__context_usage',
        // 任务清单(自家那套 opTool)。以前这一格是 harness 的 TaskCreate/TaskUpdate, 走 builtin_tools.json。
        'mcp__butler__task',
        'mcp__butler__reminder',   // 到点提醒登记簿(core/reminders.js), 巡检到点叫醒
        'mcp__butler__sys',        // 系统工具(core/sys-tool.js): 日期 / 算术等, 按 op 分
        'mcp__butler__chat_log',
        'mcp__butler__memory_query', 'mcp__butler__memory_upsert', 'mcp__butler__memory_touch',
        'mcp__butler__memory_hot',
        // 正文读写。段的概念已撤掉, memory_supersede_section 随之删除。
        'mcp__butler__memory_section', 'mcp__butler__memory_write',
        // 冷门那十七件(体检/置顶/红线/仲裁/考古/走图/拆节点/自检任务)已并成一个 op 口。
        'mcp__butler__memory_admin',
        'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash',
        'WebSearch', 'WebFetch'];   // 模型自带, 不依赖任何外部 MCP: 所有人格默认放行
    // 插件开放给人格的命令: 宿主给了执行器才有这个工具(个人版), 白名单跟着走。
    if (this.personaOps && typeof this.personaOps.runPluginCommand === 'function') out.push('mcp__butler__plugin_call');
    out.push('mcp__butler__talk_peer');   // 点对点直连: 所有人格(约束在 main)。ask_persona 已删, 语义等价的重复工具
    // 人格管理四件(list/open/create/tune)。前三个原先只给管家注册, 现在统一放行、由 persona_admin
    // 的 butlerOnly 标记在 op 层挡; tune 所有人格都能用 —— 它原先压根没进过这张白名单, 于是
    // 注册了却调不动(实测 6149 份 transcript 只 5 次, 全来自有外部 MCP 因而不受白名单约束的人格)。
    out.push('mcp__butler__persona_admin');
    out.push('mcp__butler__voice_switch');          // 自己开关自己的语音: 所有人格
    out.push('mcp__butler__update_prompt_chips');   // 自己维护输入框上方快捷按钮: 所有人格
    out.push('mcp__butler__get_chip_usage');        // 换之前先看哪个真在被用, 别凭印象换
    if (this.tgBotToken) out.push('mcp__butler__send_tg');             // 已配 TG 才放行 send_tg
    if (this.channelHost && this.channelHost.list().length) out.push('mcp__butler__send_message');   // 配了统一通道才放行
    // 配了 bus 才放行往 bus 说话的两个。send_line 那族已删 —— 发 LINE 是 bus 上的 command(能力包声明或 bus_exec)。
    // bus_admin = 往 bothub 那条 bus 发消息/发文件/取文件三个 op。原先只放行了 send_bothub,
    // bus_put_file / bus_get_file 从来没进过白名单 —— 注册了却调不动, 与 persona_tune 同一种漏。
    if (this.buses.all().some((b) => b.kind === 'bothub')) out.push('mcp__butler__bus_admin');
    if (this.buses.all().some((b) => b.kind === 'v1')) out.push('mcp__butler__bus_exec');
    // 摘掉的 core 工具也要从白名单里消失, 否则名单上留着一个根本不存在的工具名。
    const dropped = new Set(this._droppedCoreTools().map((n) => `mcp__butler__${n}`));
    const kept = dropped.size ? out.filter((n) => !dropped.has(n)) : out;
    kept.push(...this._extraAllowedTools());
    return kept;
  }
}

module.exports = StreamMixin;
