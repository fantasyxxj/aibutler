// SDK 消息流的消费循环
// 由 agent.js 拆出(内核抽包第 1 步)。方法体逐字搬运, 经 util.mixin 挂回 Butler.prototype。
const { cfg } = require('../host');
const { hasCjkEscape } = require('../escape-guard');
const { FORCE_SEDIMENT_TOOLS, MEMORY_WRITE_TOOLS, sumInput, deliveredText } = require('./util');
const { classifyAccessError, classifySdkError, dropSubscriptionToken } = require('./env');
const { detectLostToolCall } = require('./lost-toolcall');
// 界面命令目录的名字: 用来分开合法按钮 `{{cmd:biz_do|…}}` 和写成按钮的工具调用。取不到就不判那种漏法。
const commandNameSet = () => { try { return new Set(Object.keys(require('../commands').catalog() || {})); } catch (_) { return null; } };
const { retryOrReleaseTurn } = require('./turn-release');
const turnMute = require('./turn-mute');
const toolLog = require('./tool-log');
const { onSubagentMsg } = require('./subagent-feed');
const bgJobs = require('./bg-jobs');

class ConsumeMixin {
  // 消费循环: 路由消息到全局回调。一个 result = 一段回复 settle(软插话下, 一段可吸收多条用户消息)。
  async _consume(q) {
    let died = false;   // 流是异常死的还是正常收尾 —— 决定 finally 里放不放行挂起的 askOnce
    // 本轮消费开始时它是不是"当前流"。真实路径恒为 true(ensureStream 先 this._q=q 再开消费),
    // 只有测试会拿一个没挂上去的 async iterable 直接喂 _consume —— 那种流不归任何人, 不判易主。
    const owned = (this._q === q);
    try {
      for await (const msg of q) {
        // 易主 = 本代流已被拆掉(_teardownStream 进门就摘牌), 立刻停嘴退出。
        // 少了这道闸, 一条拆到一半、子进程还没死透的老流会继续 _emit 到同一个窗口 ——
        // 用户看到的就是两个会话轮流说话、互相不认识对方说过什么(2026-08-25 实撞)。
        // break 会触发 for-await 的 return() → SDK 收掉迭代器并终止子进程, 顺带把孤儿也清了。
        if (owned && this._q !== q) {
          console.error(`[stream] ${this.name} 消费循环发现流已易主 → 停止消费(防孤儿会话抢麦)`);
          break;
        }
        // CLI 回放 = 这条提交进了当前这一轮 → 静音按它对账(见 turn-mute.js)。回放不是工具结果, 别往下走。
        if (msg.type === 'user' && msg.isReplay) { turnMute.onReplay(this, msg.uuid); continue; }
        // 子代理的过程(cc 引擎带 parent_tool_use_id)不算主代理的话 / 工具 / 占用, 只露一行动态
        if (msg.parent_tool_use_id) { onSubagentMsg(this, msg); continue; }
        // 后台作业(task_*)由程序列进任务面板, 见 bg-jobs.js
        if (msg.type === 'system' && bgJobs.onSystemMsg(this, msg)) continue;
        // 工具结果回来了 → 配上它的 tool_use 落一行 logs/tool_calls(两种引擎都走这里, 见 tool-log.js)
        if (msg.type === 'user' && Array.isArray(msg.message?.content)) for (const b of msg.message.content) if (b && b.type === 'tool_result') toolLog.finish(b);
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.sessionId = msg.session_id || this.sessionId;
          // 🔴 window 是 model 的函数, 不是一个自己累积的状态。病史两次, 形式不同根子一样
          //    (都是拿到达顺序当可信度), 全写在 agent/window.js 的文件头。
          // 🔴 只在 model 真变了才重算: SDK 每个 user submit 前都发一次 init, 若无脑覆盖就会把
          //    _adoptRealWindow 刚仲裁好的 this.window 一次次冲回猜的兜底, 下一个 result 又修回来
          //    + 补发通知, 通知又是新 submit → 新 init → 死循环("疯狂吐泡泡" 2026-09-04 现场)。
          //    档位机制挡不住这个 —— _applyModelWindow 会清零档位, 正是它让低档重新写得进来。
          if (msg.model && msg.model !== this.model) {
            this.model = msg.model;
            this._applyModelWindow(msg.model);   // 换模型 → 档位清零后重走决议(见 agent/window.js)
          }
          // SDK 每次 submit 前都发一次 init, 打 error 级 + 2500 字 raw 会把当天真错误埋掉
          // (2026-09-13 实测: 94 条 ERROR 里 93 条是这一行)。只留 keys, 走 info 级。
          console.log(`[TOOLS-DIAG] ${this.name} init keys=${JSON.stringify(Object.keys(msg))}`);
        } else if (msg.type === 'system' && msg.subtype === 'api_retry') {
          // CLI 从 HTTP 响应里读出来的事实: error_status 是状态码, error 是 SDK 分好的枚举。
          // 在 result 之前到达, 于是 result 那里判故障时可以直接用它, 不必再拿正文猜。
          // 只记不判 —— 重试可能成功, 此刻还不是故障。
          this._lastApiFault = { sdkErr: msg.error || null, status: msg.error_status != null ? msg.error_status : null, at: Date.now(), seq: this._turnSeq, attempt: msg.attempt, max: msg.max_retries,
            // Butler 引擎: 服务商因内容拒收(超长 / 图太大); final = 引擎已经改过、不再自己重发了
            rejected: msg.rejected || null, final: !(msg.retry_delay_ms > 0) };
          console.error(`[api-retry] ${this.name} ${msg.attempt}/${msg.max_retries} status=${this._lastApiFault.status} err=${this._lastApiFault.sdkErr} delay=${msg.retry_delay_ms || 0}`);
          // retry_delay_ms > 0 = 引擎真的要重发这一步。这一步已经流出去的半截字要撤掉, 不然重发后同一句话出现两遍
          if (msg.retry_delay_ms > 0 && this._stepText) {
            const n = this._stepText.length;
            if (this._cur.endsWith(this._stepText)) this._cur = this._cur.slice(0, -n);
            if (this._deltaText.endsWith(this._stepText)) this._deltaText = this._deltaText.slice(0, -n);
            this._stepText = '';
            this._emit('onTextDiscard');
          }
        } else if (msg.type === 'stream_event') {
          // 逐字流式: 增量文本 delta → 立刻抛出去(渲染层往气泡追加), 同时累积到 _cur/_deltaText
          const ev = msg.event;
          // 文本块收尾 → 立刻让渲染层把气泡定稿(md 渲染 + 控件生效)。
          // 不能等下面 assistant 分支的 onTool: 那条消息要等整条 message 含 tool_use 参数 JSON 全部生成完才到,
          // 工具参数一长(写文件/长 prompt)就是几十秒, 这期间正文一直是没排版的生文本、{{btn}} 也点不了。
          // 🔴 只能在新消息开头清, 不能在 assistant 消息到达时清 —— SDK 的 assistant 消息插在
          //    content_block_start 和 content_block_stop 中间, 在那儿清会把本条消息的块类型抹掉,
          //    等文本块真收尾时 _blockKinds[index] 已是 undefined, onTextDone 永远发不出去。
          //    2026-08-20 查实: 这条路一直是死的, 正文渲染全靠"调工具"和"整轮收尾"兜底 ——
          //    表现就是模型写完话去思考的那几十秒里, 正文一直是没排版的生 markdown。
          if (ev && ev.type === 'message_start') {
            this._blockKinds = {}; this._argIdx = {};
            this._stepText = '';
            this._emit('onStepStart');   // 界面记下这一步从气泡哪儿开始, 重试时撤回到这里
            // 没走到判定就没人删的残条(流被打断/拆掉)会一直攒着, 每条都拖着几百 token 的正文
            for (const [k, v] of this._argFrags) if (Date.now() - v.at > 300_000) this._argFrags.delete(k);
          }
          if (ev && ev.type === 'content_block_start') {
            this._blockKinds[ev.index] = ev.content_block && ev.content_block.type;
            const cb = ev.content_block;
            if (cb && cb.type === 'tool_use' && cb.id) {
              this._argIdx[ev.index] = cb.id;
              this._argFrags.set(cb.id, { id: cb.id, name: cb.name, raw: '', at: Date.now() });
            }
          } else if (ev && ev.type === 'content_block_stop') {
            // 只认文本块: thinking 块结束时正文气泡可能还是"…"占位, 封口会把脉动占位删掉
            if (this._blockKinds[ev.index] === 'text') this._emit('onTextDone');
            delete this._blockKinds[ev.index];
            const fid = this._argIdx[ev.index];
            if (fid) {
              const en = this._argFrags.get(fid);
              delete this._argIdx[ev.index];
              if (en) en.stopped = true;
              // 分片自己就拼不成合法 JSON = 当场坐实, 不必等 assistant 消息(它可能先于本事件到达)。
              if (en && en.raw) {
                try { JSON.parse(en.raw); } catch (e) { en.parseError = e.message; this._dumpLostArgs(en, 'parse_failed'); }
              }
              // 原文里中日文写成 \uXXXX 的, 交给 PreToolUse 打回(core/escape-guard.js)。解析后就认不出了, 只能在这儿判。
              if (this._escVerdict.size > 200) this._escVerdict.clear();
              this._escVerdict.set(fid, !!(en && hasCjkEscape(en.raw)));
              if (en && en.inputOk) this._argFrags.delete(fid);
              if (en && en.emptyInput) this._dumpLostArgs(en, en.raw ? 'assembled_but_dropped' : 'no_fragments');
            }
          }
          if (ev && ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'input_json_delta') {
            const en = this._argFrags.get(this._argIdx[ev.index]);
            if (en) en.raw += ev.delta.partial_json || '';
          }
          if (ev && ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && ev.delta.text) {
            if (!this._firstDeltaSeenForSubmit && this._lastSubmitAt) {
              this._firstDeltaSeenForSubmit = true;
              console.log(`[LATENCY] first_text_delta agent=${this.name} trace=${this._lastSubmitTraceId || '-'} dt_from_submit=${Date.now() - this._lastSubmitAt}ms`);
            }
            if (!this._firstOutputAt) this._firstOutputAt = Date.now();
            this._lastOutputAt = Date.now();
            this._busy = true;
            this._deltaText += ev.delta.text;
            this._turnStreamed = true;
            this._cur += ev.delta.text;
            this._stepText = (this._stepText || '') + ev.delta.text;
            this._emit('onText', ev.delta.text);
          }
        } else if (msg.type === 'assistant') {
          // 这里也记一次: 人格可能一个字不说直接调工具(沉淀轮就常这样), 只盯 text_delta 会把它当成"还没开口"
          if (!this._firstOutputAt) this._firstOutputAt = Date.now();
          this._lastOutputAt = Date.now();
          this._busy = true;
          // 收到新 assistant 消息 (含 text 或新 tool_use) = 上一批 tool_use 已经 done. flush pendingTools 让 UI 变 checkmark.
          if (this._pendingTools.length) {
            this._lastBatchTools = this._pendingTools.slice();   // 本次 ctx 增量的归因对象
            for (const name of this._pendingTools) this._emit('onToolDone', { name });
            this._pendingTools = [];
          }
          let outChars = 0, argChars = 0;   // 成本采样: 本条消息我方产出的量(下一轮起按缓存价重复付)
          const f = this._lastApiFault;
          const cutOut = !!msg.error && f && f.seq === this._turnSeq && f.status == null && f.attempt >= f.max;
          // 内容被拒、引擎自己改了几次还是不行: 不贴原始报错。超长还能压缩上下文再发一次(见 result 那段), 先说一声
          const rejOut = !!msg.error && f && f.seq === this._turnSeq && f.rejected && f.final;
          const rejText = rejOut ? cfg.renderL(f.rejected === 'prompt' && !this._rejectRetried ? 'main/content_rejected_retry' : `main/content_rejected_${f.rejected}`).trim() : '';
          if (rejOut) console.error(`[api] ${this.name} 内容被拒(${f.rejected}) 引擎改过仍不行 · 原文=${JSON.stringify(String((msg.message?.content || [])[0]?.text || '').slice(0, 300))}`);
          if (cutOut) console.error(`[api] ${this.name} 断流重试 ${f.attempt} 次用尽 · 原文=${JSON.stringify(String((msg.message?.content || [])[0]?.text || '').slice(0, 300))}`);
          for (const b0 of (msg.message?.content || [])) {
            const b = cutOut && b0.type === 'text' ? { ...b0, text: cfg.renderL('main/stream_cut_failed', { n: f.attempt }).trim() }
              : rejOut && b0.type === 'text' ? { ...b0, text: rejText } : b0;
            // 报错消息(msg.error)不管这一步流出过多少半截字都要显示出来, 不然最后只剩半句话
            // text: 已通过 stream_event 逐字发过则跳过(_deltaText 有值=覆盖过); 没发过(流式没覆盖)才补发整块
            if (b.type === 'text' && b.text) { outChars += b.text.length; if (!this._deltaText || msg.error) { this._cur += b.text; this._emit('onText', b.text); } }
            // 每个工具调用抛成一条持久条目(而非挤成一条转瞬 activity), 渲染层排进消息流、不清除
            else if (b.type === 'tool_use') {
              // 段落边界: 到这里为止说的话是过程, 交出去的回复从下一段算起(deliveredText)
              if (this._cur.length > (this._segStart || 0)) { this._prevSegStart = this._segStart || 0; this._segStart = this._cur.length; }
              argChars += JSON.stringify(b.input || {}).length;
              // 入参空不空只有这条组装后的消息说了算。SDK 的 assistant 消息可能先于 content_block_stop 到达,
              // 那时分片还没收全, 落盘会存下一截假的半成品 —— 所以没 stop 就只打标记, 交给 stop 那边落。
              const frag = this._argFrags.get(b.id);
              if (frag) {
                // 没 stop 就先别删: 原文还没收全, stop 那边还要拿它判 \u 转义(core/escape-guard.js)。
                if (b.input && Object.keys(b.input).length) { if (frag.stopped) this._argFrags.delete(b.id); else frag.inputOk = true; }
                else { frag.emptyInput = true; if (frag.stopped) this._dumpLostArgs(frag, frag.raw ? 'assembled_but_dropped' : 'no_fragments'); }
              }
              toolLog.start(this.name, b);
              this._emit('onTool', { desc: this._describeTool(b), name: b.name });
              // 🔴 存在实例上而不是走事件: 沉淀轮是自言自语, `onTool` 在 UI_EVENTS 里被静音掐掉,
              // 退出遮罩靠事件永远收不到"它正在干什么"。这里记的是状态, 静音管不着。
              // 写了几条记忆**不在这里另记** —— 下面已有 `_turnMemoryWrites`, 再加一个必然漂。
              this._lastToolName = b.name;
              this._pendingTools.push(b.name);
              // 后台任务开跑 → 记一笔时间戳, idle-watch 据此在一段时间内不压 (main.js decideActions)。
              // 2026-08-21 事故: 打包跑在后台, 回合正常结束 → isRunning() 为假 → 被判 idle 压缩 → 构建被一起杀掉。
              // 只记开跑不记结束: SDK 的任务回执走 user 消息, 这里根本收不到, 所以是"到期自动放行"而非计数归零。
              // 🔴 不限 Bash: Agent(子代理) 和别的工具同样能挂后台。原先写死 `b.name === 'Bash'`,
              // 于是用 Agent 挂活的人格照压不误 —— 判据是"这次调用要不要在后台跑", 跟哪个工具无关。
              if ((b.input && b.input.run_in_background === true) || b.name === 'Workflow') {   // 工作流一律在后台跑
                this.lastBgLaunchTs = Date.now();
                console.log(`[bg-hold] ${this.name} 后台任务开跑(${b.name}), 暂缓压缩`);
              }
              if (typeof b.name === 'string' && b.name.startsWith('mcp__butler__memory_')) {
                this._turnMemoryOps++;
                // 🔴 写入单独计一笔: 「连续几轮没存东西」只能用写入判, 用 memory_* 总数判永远是 0 轮 ——
                // 查记忆是每轮必做的动作(硬规矩 1), 所以总数几乎轮轮非零, 而漏掉的恰恰是【查了一堆、一条没存】
                // 这个组合(2026-09-12 活样本: 一整程十几次 query、零 upsert, 直到挨骂才发现)。
                if (MEMORY_WRITE_TOOLS.test(b.name)) this._turnMemoryWrites++;
                // 用户报"一直查记忆一直吐泡泡"(2026-09-04) 时没有具体重现, 加个刻度: 一轮内
                // memory_* 超 20 次几乎肯定是循环, log 一行让下次现场能被一眼捕到。阈值宽松
                // (设计出的多查 8-12 次是常态: 4 门必查 + degradation 教的换词重试), 20 次绝
                // 不是正常一轮该有的。
                if (this._turnMemoryOps === 20) {
                  console.warn(`[memory-storm] ${this.name} 单轮内已 20 次 memory_*, 疑似循环 — 后续每次调用继续计数, 达阈值不再重复报警`);
                }
              }
              // 新知识信号: 本轮从外部世界拿到了原来不知道的东西 → 回合结束前必须沉一条。
              // 只认 WebSearch/WebFetch 这类**明确**的外部获取; 不认 Read —— 读自己项目的文件是干活常态,
              // 拿它当信号会天天误挡(宁可漏挡也不能天天卡人, 见配套②行为类能力的风险)。
              else if (typeof b.name === 'string' && FORCE_SEDIMENT_TOOLS.test(b.name)) this._turnKnowledgeHits.push(b.name);
            }
            // 服务端工具(web_search 由模型端代搜): 不归我们执行, 但照样露给用户看, 也算从外部拿到了新东西
            else if (b.type === 'server_tool_use') {
              this._emit('onTool', { desc: this._describeTool(b), name: b.name });
              this._lastToolName = b.name;
              this._turnKnowledgeHits.push(b.name);
            }
            // thinking 不渲染(加密块, 正文本就不落盘), 只记一笔: 有思考却零正文 = 空回合特征
            else if (b.type === 'thinking' || b.type === 'redacted_thinking') this._turnHadThinking = true;
          }
          this._deltaText = '';   // 本条 assistant 消息处理完, 重置 delta 累积(下条重新判)
          // Butler 引擎随 usage 带来按请求体的自估(ctx_estimate): 网关回报偶发虚高, 占用取两者小的
          const u0 = msg.message?.usage;
          const inTok = u0 && u0.ctx_estimate > 0 ? Math.min(sumInput(u0) || u0.ctx_estimate, u0.ctx_estimate) : sumInput(u0);
          this._pendChars.out += outChars;
          this._pendChars.arg += argChars;
          if (inTok) {
            const prevTok = this.lastInput;
            this.lastInput = inTok;
            this._emit('onUsage', this.usage());
            // 一次 API 调用只记一笔: SDK 会把同一次响应拆成多条 assistant 消息(每个 content block 一条),
            // 每条都带同一份 usage。不去重的话 3~5 行里只有第一行 delta 非零, 其余全是噪声。
            if (inTok !== prevTok) {
              const u = msg.message?.usage || {};
              this._emit('onCtxSample', {
                seq: ++this._ctxSeq,
                ctx: inTok,
                delta: prevTok ? inTok - prevTok : null,   // 首次为 null: 那是起床基线不是增量
                base: this.wakeCtxBase,
                tools: this._lastBatchTools,               // delta 主要由这批工具的返回造成
                out_chars: this._pendChars.out,
                arg_chars: this._pendChars.arg,
                fresh: u.input_tokens || 0,
                cache_read: u.cache_read_input_tokens || 0,
                cache_write: u.cache_creation_input_tokens || 0,
                model: this.model,
              });
              this._lastBatchTools = [];
              this._pendChars = { out: 0, arg: 0 };
            }
            this._maybeAutoCompact();
          }
        } else if (msg.type === 'rate_limit_event') {
          // SDK 在限流"信息变化"时就发此事件(含 status=allowed 的状态通报, 启流必发一次);
          // 只有 rate_limit_info.status === 'rejected' 才是真撞铁板, 其余只记录不暂停.
          const info = msg.rate_limit_info || {};
          if (info.status === 'rejected') {
            const now = Date.now();
            let retryAfterMs = 300_000;
            if (info.resetsAt) {
              // resetsAt 可能是秒级或毫秒级 unix 时间戳, 按量级判断
              const t = info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt;
              if (t > now) retryAfterMs = t - now;
            }
            const until = now + Math.max(retryAfterMs, 60_000);
            this.rateLimitedUntil = until;
            this._emit('onRateLimit', { until, retryAfterMs, raw: { status: info.status, rateLimitType: info.rateLimitType, resetsAt: info.resetsAt, utilization: info.utilization } });
          } else if (info.status === 'allowed_warning') {
            console.log(`[rate-limit] ${this.name} 接近限额 (type=${info.rateLimitType} util=${info.utilization})`);
          }
        } else if (msg.type === 'result') {
          // 第几个 result —— 只作诊断计数。静音不再靠它(见 turn-mute.js 文件头)。
          ++this._resultSeq;
          this._adoptRealWindow(msg.modelUsage);
          // 本轮结束: 兜底 flush 剩余 pendingTools (若最后一个 tool_use 后没 assistant 消息就到了 result)
          if (this._pendingTools.length) {
            for (const name of this._pendingTools) this._emit('onToolDone', { name });
            this._pendingTools = [];
          }
          const interrupted = (msg.subtype === 'interrupt' || msg.subtype === 'error_during_execution');
          // 苏醒基数: tool loop 出完的首次 result = 起床全过程稳态 (含 memory_hot / Read 等初始化产物).
          // 只在首次 (wakeCtxBase 尚为 null) 写入 · 之后 result 不再覆盖 · 清空流程末尾清 null 重测.
          if (this.wakeCtxBase == null && this.lastInput > 0 && !interrupted) {
            this.wakeCtxBase = this.lastInput;
            console.log(`[wake-base] ${this.name} wakeCtxBase=${this.wakeCtxBase} (下轮 idle-watch KEEPALIVE 门 = ${this.wakeCtxBase} × ratio)`);
            // 每次苏醒付一遍的固定成本 —— 开发时一天重启几百次, 这笔账要单独看得见
            this._emit('onCtxSample', { kind: 'wake_base', seq: this._ctxSeq, ctx: this.lastInput, base: this.wakeCtxBase, delta: null, tools: [], model: this.model });
          }
          this._emit('onUsage', this.usage());
          const finalText = deliveredText(this._cur, this._segStart, this._prevSegStart);
          this._segStart = 0; this._prevSegStart = 0;
          // 🔴 这段文本是模型逐字产出的, 还是 CLI 整块塞进来的 —— 判认证失效只认后者。
          // 模型开口必然走 stream_event/text_delta(_deltaText 累积); CLI 注入的 401 不经过模型、
          // 没有 token 流, _deltaText 必空。这是结构性事实, 比"文本长得像不像报错"可靠:
          // 靠文本特征的话, 模型简短引用一句 "Not logged in" 就会把自己挂起(长度门只是在赌讨论必是长文)。
          // 🔴 用回合级的 _turnStreamed, 不能用 _deltaText —— 后者在【每条】assistant 消息处理完就被
          // 清空(见上面那行注释「本条 assistant 消息处理完, 重置 delta 累积」), 而这里读它的时机在
          // result, 也就是最后一条 assistant 消息之后, 于是它恒为空、streamed 恒为 false。
          // 结果是这道结构闸从来没真正拦过一次, 判故障的其实一直是下面那条正则 —— 正是本段注释
          // 反复强调不能单独采信的东西。2026-08-28 实撞: 店小二讲 LINE 手顺时正常输出里带
          // 「Channel Access Token」, 命中 /access token/i 就被当成 401 挂起, 每轮必挂。
          const streamed = !!this._turnStreamed;
          this._cur = ''; this._deltaText = ''; this._turnStreamed = false; this._busy = false;
          // 接入类故障(凭证/额度/权限): 报错正文会被 CLI 当成正常回复塞进 assistant 消息体
          // (result 仍报 subtype:"success"), 不截住就会把一坨英文报错当 AI 回复推给用户。
          // 走 empty-turn 那条通道: 【不】emit onResult, 这一轮对用户是折叠的。
          //
          // 🔴 判「是不是故障」只用结构信号, 不看文本长相 —— 上面的 streamed, 外加 `msg.is_error`
          // (CLI 自己标的; 2026-08-21 就实测到未登录时它是 true, 但代码一直没读过这个字段,
          // 白白靠正则硬猜了那么久)。两条并联兜底, 免得哪个 CLI 版本不给 is_error。
          // 判「是哪一类」才用正文分类 —— 因为**同一句"请重新登录"在四类里有三类是错的**。
          const cliFault = msg.is_error === true || !streamed;
          this._lastTurnError = msg.is_error === true ? String(finalText || 'error').slice(0, 200) : null;   // 出生教育据此停, 不对着坏模型补发
          this._lastTurnInterrupted = interrupted;   // 出生教育: 用户按停 = 他接手了, 算完成
          // 🔴 SDK 说过话就只听 SDK: system/api_retry 带的 error/error_status 是 CLI 从 HTTP 响应
          // 里读出来的事实, 而正则原理上分不开"请求真的返回了 401"和"模型正在谈论 401"。
          // 本回合有过 api_retry 就走枚举 —— 它认不出(overloaded/server_error 这些不是接入故障)
          // 也【不】回落正则: SDK 已经给了结论, 再拿正文猜一遍只会把正常回答判死。
          const fault = this._lastApiFault;
          const access = (fault && fault.seq === this._turnSeq)
            ? classifySdkError(fault.sdkErr, this.accessMode, fault.status)
            : (cliFault ? classifyAccessError(finalText, this.accessMode) : null);
          this._lastApiFault = null;
          // 超长且引擎截不动: 照 Claude Code 的 reactive compaction —— 沉淀后清空, 再把那条消息重发一次; 只试一次
          if (!access && fault && fault.seq === this._turnSeq && fault.rejected === 'prompt' && fault.final && !this._rejectRetried && this._lastSubmitPayload) {
            this._rejectRetried = true;
            const p = this._lastSubmitPayload;
            console.error(`[api] ${this.name} 提交超长 → 沉淀后清空, 重发那条消息一次`);
            setTimeout(() => {
              (async () => {
                await this.doClearWithSediment('提交超长');
                await this.submit(p.text, p.attachments, { ...(p.opts || {}), _rejectRetry: true });
              })().catch((e) => console.error(`[api] ${this.name} 超长重发失败:`, e && e.message));
            }, 0);
          }
          if (access) {
            // 原文必须落盘: 只记人格名的话, 事后分不出这次是真 401 还是误判(2026-08-25 排查实际卡在这)。
            const raw = String(finalText).slice(0, 200);
            // 抖动的定义就是偶发 —— 那么先重试一次: 通了就是抖动, 用户全程无感, 还顺带把这轮救回来。
            // 只有 oauth_expired 走这条: 额度满重试必然再撞(还白烧一次额度), key 写错和 403 组织
            // 校验是确定性错误, 重试一万次也是同一个结果。
            if (access.retryable && !this._authRetried) {
              this._authRetried = true;
              console.error(`[access/${access.kind}] ${this.name} 首次撞上 → 先当服务抖动重试一次(不挂横幅) · 原文=${JSON.stringify(raw)}`);
              this._emit('onActivity', '(连接异常, 正在重试一次)');
              // 脱出本消费循环再重发: _retryAfterTransientFault 里要拆流, 同步调用会与本循环互等
              setTimeout(() => {
                this._retryAfterTransientFault()
                  .catch((e) => console.error(`[access/${access.kind}] ${this.name} 重试失败:`, e && e.message));
              }, 3000);
              continue;
            }
            // 重试过还是同一类, 或本来就不该重试 → 定罪: 挂起人格 + 抛 onAuthExpired 让 UI 挂横幅。
            // 刻意【不】自动重登: OAuth 要弹浏览器、要人在电脑前点, 无人时自动弹只会空转。
            // kind/raw 必须带出去 —— UI 据此决定给什么出口。给错的行动指引比不给更坏(2026-08-26
            // 坐实: 403 组织校验被当成"登录失效", 狂人照着提示反复重登, 永远修不好)。
            this._authBlocked = true;
            // 🔴 长效 token 过期时必须就地丢掉它, 否则「重新登录」这条路会变成死路:
            // CLI 取凭证的顺序是"有 CLAUDE_CODE_OAUTH_TOKEN 就用它, 没有才读 keychain",
            // 于是 OAuth 重登把新凭证写进 keychain 也白搭 —— 子进程重建时又被这张过期的盖住,
            // 表现为"点多少次重新登录都没用", 且界面上看不出原因。丢掉它就回落到 keychain。
            if (access.kind === 'oauth_expired') dropSubscriptionToken(this.name);
            console.error(`[access/${access.kind}] ${this.name} 判定为真故障(mode=${access.mode}) → 挂起 · 原文=${JSON.stringify(raw)}`);
            this._emit('onAuthExpired', { name: this.name, kind: access.kind, mode: access.mode, raw });
            this._flushAskPending();   // 别让 askOnce 的发起方(出生教育/清空前沉淀)永久卡住
            continue;
          }
          // 空回合兜底: 模型只产 thinking block、没开 text block 就 end_turn(API 允许, SDK 报 success 无 error)。
          // 放在取 compactReason 之前 —— 下面 continue 会跳过整段, 免把待压缩信号一起吞掉。
          // 关键: 这里【不】emit onResult、【不】resolve _askPending, 把它们留给补提那轮。
          // askOnce 是出生教育喂课和清空前沉淀的唯一通道, resolve('') 等于整课/整次沉淀无声丢失。
          // _allowEmptyTurn: 内务轮(体检)有意保持沉默, 不是卡住 —— 见 stream.js 那行注释。
          // 放行但**留一行日志**: "它自己决定不说"和"它坏了"在日志里必须分得开。
          if (!interrupted && !String(finalText || '').trim() && this._turnHadThinking && this._allowEmptyTurn) {
            console.log(`[empty-turn] ${this.name} 内务轮无话可说 → 按设计放行, 不补提`);
          } else if (!interrupted && !String(finalText || '').trim() && this._turnHadThinking) {
            if (!this._emptyTurnRetried) {
              this._emptyTurnRetried = true;
              console.error(`[empty-turn] ${this.name} 只产 thinking 无正文 → 自动补提一次 (askPending=${this._askPending.length})`);
              this._emit('onActivity', '(上一轮只思考没出声, 正在追问一次)');
              // 脱出本消费循环再 submit: submit 内有等压缩/清空的 await, 同步调用会与本循环互等
              retryOrReleaseTurn(this, 'empty-turn',
                () => this.submit(cfg.text('main/empty_turn_retry'), null, { sourceKind: 'auto', _emptyTurnRetry: true }),
                { finalText, interrupted });
              continue;
            }
            // 补提那轮又空: 不再补(防打转), 照常往下走 resolve('')。但必须让人看见, 别再静默。
            console.error(`[empty-turn] ${this.name} 补提后仍是空回合, 放弃补提 (askPending=${this._askPending.length})`);
            this._emit('onActivity', '⚠️ 连续两轮只思考没出声, 已放弃追问 — 请换个问法重发');
          }
          // 强制沉淀(回合不放行): 本轮拿到新知识却零 memory_* → 这一轮不结束, 追一条指令让它先补沉。
          // 与 nudge 的本质差别: nudge 只是下一轮的一句文字, AI 可以不理; 这里是【不 emit onResult】,
          // 复用上面 empty-turn 那条补提通道 —— 对用户是折叠的一次来回, 对 AI 是必须先做完的事。
          // 限一次, 免补提又不沉打转; enabled=false 可一键关(它是唯一上线即生效的行为类改动)。
          if (!interrupted && this._turnKnowledgeHits.length && this._turnMemoryOps === 0 && !this._forceSedimentRetried) {
            let fsCfg = null;
            try { fsCfg = cfg.json('main/force_sediment'); } catch (_) {}
            if (fsCfg && fsCfg.enabled) {
              this._forceSedimentRetried = true;
              const hits = [...new Set(this._turnKnowledgeHits.map((n) => String(n).replace(/^mcp__[a-z]+__/, '')))].join('、');
              console.error(`[force-sediment] ${this.name} 拿到新知识(${hits})却零 memory_* → 不放行, 追一条补沉指令`);
              this._emit('onActivity', '(本轮有新知识没沉, 正在补沉一次)');
              retryOrReleaseTurn(this, 'force-sediment',
                () => this.submit(String(fsCfg.template || '').replace('{hits}', hits), null, { sourceKind: 'auto', _forceSediment: true }),
                { finalText, interrupted });
              continue;
            }
          }
          // 输出侧红线(双通路的另一半): 动作侧拦不住的那些 —— 自称 Claude / 给文件不给绝对路径 /
          // 默认包 speak。走同一条补提通道: 【不 emit onResult】+ 追一条打回指令让它重说。
          // ⚠️ 这一轮的文字已经流式显示出去了, 用户会看到"错的 + 改对的"两段 —— 输出侧的固有代价,
          // 换不掉: 要么等整轮说完才显示(牺牲逐字流式), 要么接受这个。
          if (!interrupted && finalText && !this._redlineRetried) {
            let rlCfg = null;
            try { rlCfg = cfg.json('main/redline_output'); } catch (_) {}
            const verdict = (rlCfg && rlCfg.enabled) ? this.redlineGuard.decideOutput(finalText) : null;
            if (verdict) {
              this._redlineRetried = true;
              console.error(`[redline-out] ${this.name} 输出撞红线「${verdict.redline.slug}」→ 不放行, 打回重说`);
              this._emit('onActivity', '(上一轮撞了红线, 正在重说一遍)');
              retryOrReleaseTurn(this, 'redline-out',
                () => this.submit(String(rlCfg.template || '{reason}').replace('{reason}', verdict.reason), null, { sourceKind: 'auto', _redlineRetry: true }),
                { finalText, interrupted });
              continue;
            }
          }
          // 工具调用漏成正文: 这一轮的正文里躺着一段完整的调用体, 而它从没变成 tool_use ——
          // 那次调用等于没发出, 模型却以为调过了, 后面的话建在空气上。走同一条补提通道,
          // 明确告诉它没调成(刻意不静默: 作者要的就是"让它知道自己砍空了")。
          if (!interrupted && finalText && !this._lostToolRetried) {
            let ltCfg = null;
            try { ltCfg = cfg.json('main/lost_toolcall_retry'); } catch (_) {}
            const lost = (ltCfg && ltCfg.enabled) ? detectLostToolCall(finalText, this._knownToolNames, commandNameSet()) : null;
            if (lost) {
              this._lostToolRetried = true;
              console.error(`[lost-toolcall] ${this.name} 对「${lost.name}」的调用漏成了正文(${lost.via}), 从未发出 → 不放行, 让它重调`);
              this._emit('onActivity', '(上一轮有个工具没真调出去, 正在让它重调)');
              retryOrReleaseTurn(this, 'lost-toolcall',
                () => this.submit(String(ltCfg.template || '').replaceAll('{tool}', lost.name), null, { sourceKind: 'auto', _lostToolRetry: true }),
                { finalText, interrupted });
              continue;
            }
          }
          // 压缩不在本循环内执行(doCompact 要拆流→会与本循环死锁); 只把 reason 抛给外部触发。
          // 🔴 带在 onTurnEnd 上, 不带在 onResult 上: onResult 静音轮会被掐, 压缩信号曾跟着一起丢
          //    (2026-10-09 在系统提醒轮里登记两次都没执行)。onTurnEnd 一轮必发。
          let compactReason = null;
          if (this.compactRequested && !interrupted) { compactReason = this.compactRequested; this.compactRequested = null; }
          this._logUtterance('assistant', finalText, 'reply');
          this._evalMemoryNudge();   // 本回合有沉淀特征却零 memory_* → 挂一条提醒, 下条真人消息带出去
          this._emit('onResult', { finalText, interrupted });
          // 多人格互通: 有挂起的 askOnce → 用本轮 finalText 回给它。UI 已经通过 onResult 显示了, 一举两得。
          if (this._askPending.length) {
            const resolve = this._askPending.shift();
            try { resolve(finalText || ''); } catch (_) {}
          }
          // 收尾放在 onResult 之后: 静音轮那句独白的气泡要先被掐住。onTurnEnd 不在 UI_EVENTS 里、
          // 一轮结束必发 —— busy 灯、心跳标记、压缩这些"必须做的事"都挂它。
          const _wasMuted = turnMute.endTurn(this);
          // held: 刚结束的是唤醒轮, 后面还有原话在等它(compact.js _awaitWake) —— 宿主别据此放开 busy,
          //       不然店主看见转圈停了、没回话, 回话过一会儿才冒出来(2026-10-13 dev 实撞)。
          const held = !!this._waking && this._wakeWaiters > 0;
          this._emit('onTurnEnd', { interrupted, muted: _wasMuted, compactReason, held });
          // 说话期间降下来的换模型指令, 到这儿才兑现 —— 本轮已经收尾, 切进去的是下一轮。
          // 脱出本消费循环再切: setModel 里要 await SDK 并 submit 一条告知, 同步调会与本循环互等。
          if (this._pendingModel) {
            const { model: pend } = this._pendingModel;
            this._pendingModel = null;
            setTimeout(() => {
              this.setModel(pend)
                .then((r) => console.log(`[model-switch] ${this.name} 回合结束兑现 → ${pend || '(默认)'} · applied=${r.applied}${r.applied ? '' : ' reason=' + r.reason}`))
                .catch((e) => console.error('[model-switch]', e && e.message));
            }, 0);
          }
        }
      }
    } catch (e) {
      // 接入故障的另一个出口: SDK 直接把它 throw 出来(实测发生在 teardown 收尾那一刻)。
      // 这里是真 error 对象, 天然就是故障, 不需要结构信号再判一次, 直接分类。
      // 抖动重试与上面同一条路: 不在这儿另开一套, 否则两个出口的行为迟早会漂。
      const thrown = classifyAccessError(e && e.message, this.accessMode);
      if (thrown) {
        if (thrown.retryable && !this._authRetried) {
          this._authRetried = true;
          console.error(`[access/${thrown.kind}] ${this.name} 首次撞上(消费循环抛出) → 先当服务抖动重试一次`);
          this._emit('onActivity', '(连接异常, 正在重试一次)');
          setTimeout(() => {
            this._retryAfterTransientFault()
              .catch((err) => console.error(`[access/${thrown.kind}] ${this.name} 重试失败:`, err && err.message));
          }, 3000);
        } else {
          this._authBlocked = true;
          // 与上面那个出口同一条理由: 长效 token 不好使了就丢掉, 否则重登永远救不回来
          if (thrown.kind === 'oauth_expired') dropSubscriptionToken(this.name);
          console.error(`[access/${thrown.kind}] ${this.name} 判定为真故障(消费循环抛出, mode=${thrown.mode}) → 挂起`);
          this._emit('onAuthExpired', { name: this.name, kind: thrown.kind, mode: thrown.mode, raw: String(e && e.message || '').slice(0, 200) });
        }
      } else { died = true; throw e; }
    } finally {
      // 只有还持牌的那一代才有资格清全局状态。老流(已被拆/已易主)在这儿清, 清掉的是**新流**的
      // _q/_queue/_busy —— 新流从此没人认得它, 下一条 submit 又建一条, 分身越滚越多。
      if (this._q === q) {
        this._q = null; this._queue = null; this._busy = false; this._cur = ''; this._deltaText = ''; this._segStart = 0; this._prevSegStart = 0;
        this._turnStreamed = false;
      }
      // 流【死】了(子进程自己退了/管道断了)= 等在它上面的 askOnce 再也等不到 result。不放行,
      // 它们就只能耗满自己的 deadline —— 退出沉淀那条是 60s, 于是"关窗口后一分钟退不掉且毫无
      // 反馈"(2026-08-25 打包版实测: 子进程空闲期死掉, 提交 23ms 后就 EPIPE, 却仍等满 60s)。
      // teardown 那条路本来就会 flush, 这里补的是【子进程自己死掉】那条 —— 它绕过 teardown。
      //
      // 🔴 只在死掉时放行, 【不能】放宽成"只要 _consume 结束就放行": 流正常收尾后 submit 会
      // ensureStream 重建, 而 _askPending 挂在 this 上跨流存活, 新流的 result 照样接得住它 ——
      // 空回合补提(上面 [empty-turn] 那段)全靠这个语义, 一律放行等于把整课/整次沉淀无声丢掉。
      if (died) this._flushAskPending();
    }
  }
}

module.exports = ConsumeMixin;

