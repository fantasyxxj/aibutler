// 关档: 原话捕获 · 沉淀 · 清空重启
// 由 agent.js 拆出(内核抽包第 1 步)。方法体逐字搬运, 经 util.mixin 挂回 Butler.prototype。
const path = require('path');
const fs = require('fs');
const { cfg } = require('../host');
const { withTimeout } = require('./util');

class CompactMixin {
  // 关档前对话原话捕获 (v0.0.23 · 2026-07-19 唐伯虎派单 · 飞飞落地): 引擎化替代"人格自觉存原话"铁律。
  // 时机: doClearWithSediment 顶部, ①沉淀 askOnce 之前 —— 否则 sediment 的 assistant "已沉淀" 会污染 convo 最后一条。
  // 数据源: main.js setCallbacks 注入的 getRecentTurns(n) 回调, 单一真源 s.convo (拒双写)。
  // 落盘: <memoryDir>/ctx_last.json, 冷启动/清空自愈都靠 buildWakePayload 读取注入 (§4.8 关闭重开也 wake, 由 main.js 冷启动 hook 补条件覆盖)。
  _captureRecentTurns(reason = '手动') {
    try {
      const getRecent = this._cb && this._cb.getRecentTurns;
      if (typeof getRecent !== 'function') return;
      const turns = getRecent(6) || [];   // user+assistant 各 3 = 总 6
      if (!turns.length) return;
      const MAX_TEXT = 1200;
      const clipped = turns
        .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string')
        .map((t) => ({
          role: t.role,
          text: t.text.length > MAX_TEXT
            ? t.text.slice(0, 800) + `\n…[original truncated · original length ${t.text.length}]…\n` + t.text.slice(-200)
            : t.text,
          ts: t.ts || 0,
        }));
      if (!clipped.length) return;
      const payload = {
        captured_at: Date.now(),
        captured_reason: reason,
        persona_name: this.name,
        session_id: this.sessionId || null,
        turns: clipped,
      };
      const ctxPath = path.join(this.memoryDir, 'ctx_last.json');
      fs.writeFileSync(ctxPath, JSON.stringify(payload, null, 2));
    } catch (e) {
      console.error(`[captureRecentTurns] ${this.name} 落盘失败: ${e && e.message}`);
    }
  }

  // 沉淀成败的**客观**判据: 图里节点数 + MEMORY.md 字节数。沉淀前后各拍一张, 两个都没长
  // = 什么都没沉进去。取这两个量是因为沉淀提示词要求的正是这两件事(沉图记忆 + 改便条)。
  // 读不到就返 0 —— 两次都读不到会得出 0<=0 判失败, 这是**故意的**: 量不出来时宁可报失败让人看一眼,
  // 也不要默认成功。同源判据见 personal/birth.js 的 birthSnapshot。
  // 等这个人格真的闲下来(或到上限)。给沉淀的成败判据用 —— 它还在跑的时候拍快照必然冤枉它。
  async _waitIdle(maxMs = 60000) {
    const t0 = Date.now();
    while (this.isRunning() && Date.now() - t0 < maxMs) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // 带"活体检测"的等待。
  // 🔴 作者 2026-08-25:「如果真在干活, 不能强制啊, 要是死了才能强制吧」。
  // askOnce 自带的 deadline 是到点就 reject —— 它分不清「卡死了」和「正在认真干活」,
  // 于是人格明明在一条条写记忆, 用户脸上却弹出"强制关闭"。
  // 改成: **只在它已经停止活动的前提下**才认超时; 只要还在跑就接着等。
  // 兜底是 hardCap(默认 3 倍) —— 万一它陷进死循环, 总不能真的不让人关机。
  async _askUntilDoneOrDead(text, deadlineMs, opts = {}) {
    // 硬上限只兜"死循环", 所以取【倍数】和【绝对下限】里大的那个 —— 只按倍数算的话,
    // deadline 越短越容易把正在认真干活的掐死(300ms 的 deadline 会给出 900ms 的硬上限)。
    const hardCap = opts.hardCapMs || Math.max(deadlineMs * 3, 10 * 60 * 1000);
    // 🔴 首字之前和首字之后是两笔账, 不能共用一个预算。2026-09-13 实测: 三人格并发沉淀时首字就要等
    // 159s, 于是 180s 的硬上限只剩 21s 留给真正干活的部分 —— 被砍掉的不是死循环, 是一次正常的沉淀。
    // 传了 idleKillMs 就变成: 首字之前吃 hardCap(兜"连一个字都吐不出来"), 首字一到换成看**停手多久**。
    // 不传则退回老的一段式, 行为不变。
    //
    // 🔴 2026-09-24: 开口之后量的是【离最近一个产出多久】, 不是【离第一个产出多久】——
    // 沉淀真正的活(几条 memory_upsert + 改 MEMORY.md)全发生在首字之后, 按"离首字多久"砍
    // 等于给整段工作设了个总时长上限。实测老师写了 4 分多钟, 于是一次**完全成功**的沉淀被判卡死,
    // 而它在被判死之后照样把记忆写完了 —— 停的从来不是它的活, 是我们自己的耳朵。
    // 判死的唯一合法判据是「它停手了却还没收尾」, 还在产出就一秒都不许砍。
    const idleKill = opts.idleKillMs || 0;
    let settled = false;
    // 🔴 看门狗放弃等待时**不许**把 askOnce 挂在 _askPending 里的 resolver 摘掉(别再"优化"这里了)。
    // 被放弃的那一轮还活着, 它迟早会吐出自己的 result —— 队列里那个已 settled 的 resolver 正是
    // 用来吸收它的墓碑。摘掉墓碑, 那条迟到的回复就会被 consume 的 shift() 串给**下一个**提问的人,
    // 于是下一轮对话拿到的是上一轮沉淀的 "nothing to save"(2026-09-24 试着摘过, 当场被
    // test-selfheal 的「自愈后对话正常」抓住)。_askPending 是靠先进先出对齐的, 墓碑是对齐的一部分。
    const ask = this.askOnce(text, 0, opts.askOpts || {})
      .then((v) => { settled = true; return v; }, (e) => { settled = true; throw e; });
    const watchdog = (async () => {
      const t0 = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, 500));
        if (settled) return undefined;                       // 正常回来了, 看门狗退场
        const waited = Date.now() - t0;
        // 活体信号往外报一份: 这个循环本来就是唯一知道"它还在不在动"的地方, 遮罩靠它写
        // 「正在写第 3 条记忆」。不报的话用户面前只有一个不动的框, 越等越像死机。
        if (opts.onAlive) {
          try {
            opts.onAlive({ waited, lastOutputAt: this._lastOutputAt, running: this.isRunning(),
                           tool: this._lastToolName || '', memWrites: this._turnMemoryWrites || 0 });
          } catch (_) {}
        }
        // 必须比 t0 新才算数: 上一轮留下的时间戳会让本轮一睁眼就"早已超时"
        const lastAt = (idleKill && this._lastOutputAt > t0) ? this._lastOutputAt : 0;
        if (lastAt) {
          if (Date.now() - lastAt > idleKill) {
            throw new Error(`对方(${this.name})已经 ${Math.round(idleKill / 1000)}s 没有任何产出 — 判定卡住, 不再等`);
          }
        } else if (waited > hardCap) {
          throw new Error(`对方(${this.name})${Math.round(hardCap / 1000)}s 连一个字都没吐 — 到硬上限, 不再等`);
        }
        // 还在干活就继续等, 一秒都不催
        if (!this.isRunning() && waited > deadlineMs) {
          throw new Error(`对方(${this.name})已停止活动且 ${Math.round(deadlineMs / 1000)}s 内没有回音 — 判定卡住`);
        }
      }
    })();
    return Promise.race([ask, watchdog]);
  }

  // 兼容旧调用名: doCompact 现在 = 轻量"整理记忆·清空重启"。病根(满仓 resume 冷读生成交接摘要, 顶重调用卡 40s~5min,
  // 期间全员 submit 死等 → "思考中"假死)已彻底废除。所有老触发端(onResult/idle-watch/手动/心跳)不改, 自动获得廉价新行为。
  async doCompact(reason = '手动', deadlineMs = 120000) {
    return this.doClearWithSediment(reason, deadlineMs);
  }

  // 整理记忆·清空重启(butler 最核心机制, 全人格通用): ①轻沉淀 → ②瞬间清空 → ③唤醒引导加载器。
  //   ① 轻沉淀: 把此刻手头活跃线程 upsert 进图记忆(秒级, 不 resume 满仓、不总结全场 —— 满仓 resume 正是"思考中"假死病根)。
  //   ② 瞬间 clear: 无交接摘要, 上下文彻底丢弃。
  //   ③ 唤醒: 清空后代码自己戳一个 turn, 唤醒消息正文 = wakePhrase + 起床清单(记忆工具用法+hot+MEMORY.md+wake_manifest),
  //      由代码硬装、代码保证执行(不靠人格自觉扫 systemPrompt)。这一步内置在此 → 所有触发端(onResult/idle/手动)统一自愈。
  // 配合起来, 上下文成为可随时丢弃的工作内存 —— 记忆图才是真存储。
  // opts.skipWake=true: 关闭 butler / 单人格前调用——进程要死了不需要唤醒, fire-and-forget wake submit 真发出去纯浪费 API.
  // opts.keepContextOnSedimentFail=true: 沉淀没沉成就【别清空】, 原样把上下文留着。
  //   给关闭流程用: 那条路上清空本来就没意义(进程马上死), 而清掉就等于把没沉下去的活亲手扔了 ——
  //   于是"取消退出·一会再关"这个选项形同虚设(用户点了也救不回来)。留着才对得起那个按钮。
  //   ⚠️ idle-watch / 手动整理**不能**传它: 那些路子的目的就是腾空上下文, 不清等于没干活。
  async doClearWithSediment(reason = '手动', deadlineMs = 120000, opts = {}) {
    if (this._clearing) return this._clearing;   // 防重入: idle-watch 与 onResult 并发触发共用同一次
    const run = (async () => {
      this._emit('onCompact', { phase: 'start', reason: `saving to memory · ${reason}` });   // 复用 UI 处理中指示
      // ★ v0.0.23: 步骤 0 · 关档前对话原话 snapshot 到 ctx_last.json (必须在 ①沉淀 之前, 否则 assistant "已沉淀" 会污染 convo 最后一条)。
      // 错误吞掉, 主流程不阻塞: 落盘失败 ≠ 清空失败, 只是新我下次接不上语境。
      this._captureRecentTurns(reason);
      // ① 轻沉淀: 只沉淀"还没落盘、清空后要接着干"的活跃线程。_bypassClearGate 让这轮 submit 不被 _clearing 门挡(否则自锁)。
      //
      // 🔴 成败只看这一轮**有没有跑完**(超时 / 抛错才算失败), 不验它存没存下东西 —— 作者 2026-09-23 定。
      // 原先拿「节点数没涨且 MEMORY.md 没变」判「没沉淀」, 证不出它想证的事: 真没沉 / 本来无事可沉 /
      // **正确地更新了已有节点**(节点数不涨) 三种长得一模一样, 于是关一个标签就弹「沉淀失败」、
      // 还因此不清空上下文。退出 app 那条路 9-23 改了, 这里的判定当时漏了, 10-08 关标签又撞上。
      const sediment = { ran: false, ok: true, error: '' };
      if (this.sessionId && this._q) {
        sediment.ran = true;
        let reply = '';
        try {
          // 沉淀是机器对自己说话, 界面不该看见 —— 尤其是约定好的 "nothing to save"
          // 那句口令, 它是给代码读的协议不是给人读的文案(所以也不该翻译成各国语言)。
          // 🔴 静音靠 askOpts 里的 `_mute`, 它只静**这一次提交自己那一轮**(见 agent.js 那段):
          // 不许改回"先开一个实例级开关再包起来", 那样真人在闸口按下的回车会被连带掐死。
          reply = await this._askUntilDoneOrDead(
            cfg.text('main/clear_sediment'), deadlineMs,
            { hardCapMs: opts.hardCapMs, idleKillMs: opts.idleKillMs, onAlive: opts.onAlive,
              askOpts: { sourceKind: 'auto', _bypassClearGate: true, _mute: true } }) || '';
        } catch (e) {
          sediment.ok = false;
          sediment.error = String((e && e.message) || e);
          console.error(`[clearSediment] ${this.name} 沉淀超时/失败: ${sediment.error}`);
        }
        if (sediment.ok) {
          // 🔴 必须等它**真的闲下来**再清空。askOnce 是被"下一个 result"解开的, 它分不清
          // 哪个 result 对应哪次提交 —— 点关闭时人格正在回话的话, **那一轮**的 result 会立刻把
          // 沉淀的等待解开, 而真正的沉淀在后面那轮才做; 这时清空等于掐掉正在写的那一轮。
          await this._waitIdle(deadlineMs);
          // "nothing to save" 是 main/clear_sediment.md 约定的口令, 只记一行日志, 不改成败。
          if (/nothing to save/i.test(String(reply))) {
            console.log(`[clearSediment] ${this.name} 人格报告无事可沉`);
          }
        }
      }
      // 沉淀没成 + 调用方要求保命 → 到此为止, 上下文原样留着不动。
      // 那些活还在上下文里, 用户点"取消退出"就还能再试一次; 清掉就是亲手扔了。
      if (sediment.ran && !sediment.ok && opts.keepContextOnSedimentFail) {
        // 🔴 走这条早退的路 = 不清空也不拆流, 那就得**自己**把沉淀期间关掉的东西全开回来。
        // 静音的无条件复位点只有 _teardownStream()(stream.js), 而这里正是跳过它的那条路:
        // 不复位的话人格从此对界面哑巴 —— 它照常回话、照常干活, 而屏幕上一个字都不出,
        // 用户看到的是"永远在思考"(2026-09-24 老师实撞, 卡了 20 分钟)。
        // 用户选的是「先别关」, 那就必须原样还给他一个能用的人格, 不能只退回一半。
        this._turnMuted = false;
        this._emit('onCompact', { phase: 'done' });   // 收掉"处理中"指示, 否则界面一直转
        return { ok: false, reason, droppedUsrMsgs: 0, sediment, keptContext: true };
      }
      // ② 瞬间清空(clear 内部自带 onCompact done 指示 + teardown 兜底)。
      // 成败必须**跟着返回值往上走**: 关闭流程据此决定要不要拦住用户、让他选"先别关"。
      // (原先这里把失败吞在 catch 里只记一行日志, sedimentOne 照样返回 ok:true,
      //  于是 runQuitFlow 那个「沉淀失败」对话框成了永远弹不出来的死代码。)
      const res = { ...(await this.clear(reason)), sediment };
      // ③ 唤醒引导加载器: 清空后自愈戳一 turn。不 await(fire-and-forget), _bypassClearGate 免被自己的 _clearing 门挡。
      // shuttingDown 门: 当 sedimentOne 复用了别人已在跑的 _clearing(idle-watch/onResult 自动触发, 没传 opts.skipWake),
      // 关闭流程置的 this.shuttingDown 兜住这里—— 拦住"进程要死了还打唤醒 submit"的浪费.
      if (opts.skipWake || this.shuttingDown) return res;
      // 懒唤醒(闲时清空用): 不立刻戳唤醒轮, 挂标记等下一条消息进门(_awaitWake)。必须在 run 里挂 ——
      // 挂在外面的话, 等着清空的那条消息会先于标记放行, 冷着进新会话。
      if (opts.lazyWake) { this._parkedNeedsWake = true; return res; }
      this.startWake('clear', { mute: false });   // 照旧上屏; 走 startWake 是为了让紧跟着的原话等它跑完
      return res;
    })();
    this._clearing = run;
    try { return await run; } finally { this._clearing = null; }
  }

  // 闲了就清空(宿主给 idle-watcher 的 idleClearMin 开启, 行业版用): 闲到 cache 过期, 保活就是白付整段上下文,
  // 不如直接清。照常先沉淀(店主说过没存的规矩靠这一轮补, 作者 10-19 定「清空必须保存」),
  // 只是不立刻唤醒 —— 唤醒挪到下一条消息进门时(_awaitWake), 没人再说话就不花这一轮。
  async idleClear(reason = 'idle') {
    return this.doClearWithSediment(reason, 120000, { lazyWake: true });
  }

  // 新会话的唤醒: 单独一轮, 跑完才放下一条进来。开机 / 闲置复活 / 清空后三处共用这一个入口。
  // 🔴 不许再把唤醒或任何机器文字垫在新会话第一句原话前面: 模型会把整条当开机信号, 回句寒暄,
  //    店主交代的规矩不存(2026-10-13 行业版实测: 垫着 0/3 存, 先单独跑一轮开机再说 3/3)。
  // 🔴 必须等它跑完: 连着排队的消息会被 CLI 合成一轮(turn-mute.js), 合进去就又成了垫在前面。
  // 默认静音: 行业版开机不许 AI 先开口(industry/app/boot.js deliverOpening 注释, 作者 08-14 定)。
  // 唤醒那一句。行业版覆盖成中性英文: 店铺设的唤醒词是日语时, 它是新会话的第一句话, 会把整段会话带成日语。
  _wakeGreeting() { return this.wakePhrase || `Wake up, ${this.name}`; }

  startWake(kind, { mute = true } = {}) {
    if (this._waking) return this._waking;
    const head = {
      startup: '(system auto · startup) The app just started; this is a fresh session.',
      resume: '(system auto · resumed after idle) The session was shut down while idle; this is a fresh session.',
      clear: '(system auto · post-clear recovery) You just cleared context and restarted the session.',
    }[kind];
    let body;
    try { body = `${head} ${this._wakeGreeting()}\n\n${this.buildWakePayload()}`; }
    catch (e) { console.error(`[wake] ${this.name} 构建唤醒失败(照常答话): ${e && e.message}`); return Promise.resolve(); }
    // 必须打日志: 唤醒静音, 不打的话"补了"与"没补"在外面长得一模一样。
    console.log(`[wake] ${this.name} ${kind} · ${body.length} 字符${mute ? ' · 静音' : ''}`);
    return this.runAlone(body, { _bypassClearGate: true, _mute: mute }, `唤醒 ${kind}`);
  }

  // 机器自己的一轮(唤醒 · 存档提醒): 单独跑, 跑完才放原话进来。和原话合进同一轮, 原话就被机器话盖住 ——
  // 新会话首句被当开机信号(10-13), 最高档存档提醒与店主教规矩同秒提交、那条规矩没存(10-14)。
  // 正在跑一轮机器话时再来一条, 不叠, 返回正在跑的那条。
  runAlone(body, opts = {}, label = 'auto') {
    if (this._waking) return this._waking;
    const p = this.askOnce(body, 0, { sourceKind: 'auto', _allowEmptyTurn: true, _alone: true, ...opts })
      .catch((e) => console.error(`[alone] ${this.name} ${label} 失败(照常答话): ${e && e.message}`))
      .finally(() => { if (this._waking === p) this._waking = null; });
    this._waking = p;
    return p;
  }

  // submit 入口调: 闲置回收过就先补一轮唤醒; 正在唤醒就等它。等不完也放行 —— 冷着答话也比答不上话好。
  async _awaitWake() {
    if (this._parkedNeedsWake && !this._waking) { this._parkedNeedsWake = false; this.startWake('resume'); }
    if (!this._waking) return;
    this._wakeWaiters = (this._wakeWaiters || 0) + 1;
    try { await withTimeout(this._waking, 180000, `等唤醒(${this.name})`); } catch (_) {}
    finally { this._wakeWaiters--; }
  }

  // 清空上下文(对标 Claude Code /clear): 拆流 → 丢弃 sessionId + 待注入交接摘要 → 全新空白会话。
  // 与 doCompact 的本质区别: 不生成/不保留任何交接摘要, 整段历史彻底丢弃, 人格从零开始
  // (下轮 submit 时 ensureStream 用 sessionId=null → resume:undefined 建全新 session, 身份系统提示照常重注入)。
  async clear(reason = '手动') {
    // #8 clear buf drop: 拆流前扫 buf pending user msg 数 (拆完 _queue=null 就没了), 后端返给 UI 明示"放弃了 N 条"
    const droppedUsrMsgs = (this._queue && this._queue.pendingCount) ? this._queue.pendingCount() : 0;
    this._emit('onCompact', { phase: 'start', reason: `clear · ${reason}` });   // 复用 UI 处理中指示
    try {
      await withTimeout(this._teardownStream(), 15000, `clear teardown(${this.name})`);
    } catch (e) {
      // 拆不动也继续清状态: _teardownStream 进门就已摘牌(_q/_queue 置空)且会 abort 弃船, 下轮 ensureStream 重建。
      // 🔴 这里【不能】再动 _q/_queue: 我们只是不等了, 那半截 teardown 还在跑, 而新流随时可能已经建起来 ——
      // 在这儿置空等于把新流的句柄抹掉(2026-08-25 双会话事故的其中一环)。
      console.error(`[clear] ${this.name} teardown 拆不动(${e && e.message}) → 不再等, 强制清其余状态`);
      this._flushAskPending();   // teardown 半途超时 → 内部 flush 没跑到, 这里补
    }
    this.sessionId = null;         // 关键: 不 resume 旧 session → 全新对话
    this.pendingHandoff = null;    // 关键: 丢弃任何待注入交接摘要(与 compact 相反), 真正清空
    this.dirtySinceLastClear = false;   // idle-watch 门: 归零, 空闲期不再触发清空/保活直到有真消息进来
    this.keepalive_count = 0;           // v6 (2026-07-22): 清空后归零, 保活次数重新计
    this.wakeCtxBase = null;            // 清空 = 下次苏醒重测基数 (每次苏醒的起床清单+初始化产物量可能不同)
    this.lastInput = 0;
    this.compactRequested = null;
    if (this.sessionHits) this.sessionHits.clear();   // 新会话从零累积 memory_query 命中
    if (this.sessionExpanded) this.sessionExpanded.clear();  // memory_section 判重表也清: 新会话应能重看老 body
    // 🔴 2026-09-25 作者定案:「任务一旦压缩了就没了, 这个不行」—— 未完成的清单**活过清空**。
    // 老行为是整份清掉, 理由写着"清空之后 AI 已经不认得这些任务了, 挂着就是给用户看一份连它
    // 自己都不认的东西"。那个理由只在**没有重新注入**时成立: 现在 buildWakePayload 会把未完成
    // 清单念给新会话听(见 wake.js), 新我睁眼就认得它们, 前提不再成立。
    // 已完成的本来就在 _trackTask 里移出去了, 所以这里留下的全是真还欠着的事。
    // _taskSeq 也必须留着 —— 归零会发出和盘上重复的 id, 后续 TaskUpdate 改到错的那条上。
    this._saveTasks();
    this._emit('onTasks', this._panelRows());
    this._cur = ''; this._deltaText = ''; this._busy = false;
    this._emit('onUsage', this.usage());
    this._emit('onCompact', { phase: 'done' });
    return { ok: true, reason, droppedUsrMsgs };
  }
}

module.exports = CompactMixin;
