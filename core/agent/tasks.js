// 任务清单 —— 增删改查的唯一入口(taskOp) + 落盘与读回。
//
// 🔴 为什么这是一个独立文件: 这份清单以前借 harness 的 TaskCreate/TaskUpdate 维护, 靠**从消息流
//    里偷看工具入参**(原 consume.js 的 `_trackTask`), 所以代码只能住在消费循环里。旁路删掉之后
//    它与消息流再无关系 —— 留在 consume.js 只会让那个文件继续胖下去。
// 🔴 双账是它的来历: 借来的入口让 id 有两个发号方(harness 新会话从 #1 起, butler 从盘上接回的
//    seq 起), 同号不同事 —— 面板条目清不掉 · 会话里删了盘上还在 · 报 Task not found 的 id 其实
//    是另一本账的编号。入口收归自己, 那个分叉从根上不存在。
// 经 util.mixin 挂回 Butler.prototype(见 agent.js 末尾)。
const fs = require('fs');
const path = require('path');
const bgJobs = require('./bg-jobs');
// 挂起(blocked)超过这么久就不再算「这件活的步骤」, 而是在等人 —— 挪进待办簿(见 _sweepStaleBlocked)
const BLOCKED_TO_TODO_MS = 24 * 3600 * 1000;
// ── 参数表与枚举 ────────────────────────────────────────────────────────────────
// status 枚举。`blocked` 是**第五态且不在这份枚举里**: 它只能由 taskOp 的 blocked 参数派生 ——
// 允许直接传 status:'blocked' 的话"挂起理由"就会缺, 而没有理由的挂起等于永久沉默
// (催办按 blocked 跳过它, 人又不知道它在等什么)。
const TASK_STATUS = ['pending', 'in_progress', 'completed', 'deleted'];
const taskLine = (t) => `#${t.id} [${t.status}] ${t.subject}`
  + (t.blockedReason ? ` ← 挂起: ${t.blockedReason}` : '');
// 四个 op 的参数表。🔴 hint 必须写全 —— opTool 的 args 是自由 KV, 传错的参数名**不会被 schema
// 拦住**, 只会静默什么都没发生; 参数表是人格唯一的依据。
const TASK_OPS = {
  list:   { req: [], opt: [], hint: '不收参数。列出这件活的全部步骤和各自状态(做完的也在, 整件做完才清空)。' },
  create: { req: ['subject'], opt: ['description'],
    hint: 'subject 一句话写清要做什么。回执里带分配到的 #id —— 之后改它/删它都用那个 id。' },
  update: { req: ['id'], opt: ['status', 'subject', 'blocked'],
    hint: `status 收 ${TASK_STATUS.join(' / ')} —— completed 留在清单上打勾, 全部步骤 completed 时整份清空; deleted 当场移出。\n`
      + `blocked 传一句理由 = 挂起(仍留在清单上给用户看, 但催办跳过它); blocked 传 null = 解除挂起, 回到 pending。` },
  get:    { req: ['id'], opt: [], hint: '读单条最新状态 —— 要改之前先读一眼, 别拿陈旧状态去改。' },
};

class TasksMixin {
  // 任务清单的唯一入口 —— 增删改查全从这里过, 改完推界面 + 落盘。
  //
  // 🔴 为什么自己做而不借 harness 的 TaskCreate/TaskUpdate: 借来那条路是**从消息流里偷看入参**
  //    (原 `_trackTask`), 于是 id 由两边各自发号 —— harness 新会话从 #1 起, butler 从盘上接回的
  //    seq 起, 同号不同事。三个 bug 全长在那个姿势上: 面板条目清不掉 · 会话里删了盘上还在 ·
  //    报 `Task not found` 的 id 其实是另一本账的编号。入口收归自己, id 就只有一个来源。
  //
  // 🔴 这份清单是**一件活**的拆解步骤, 不是多件事的待办。做完的步骤留着打勾, 整件活的步骤全部
  //    completed 那一刻整份清掉(作者 2026-10-22:「任务做完之前都留着, 做完了才一起拿掉」)。
  //    用户靠一列 ✔ 确认没有漏步; 清单不会一轮轮攒下去, 因为下一件活开工前上一件已经清空。
  //    (2026-08-25 那版是做完一步立刻移出, 面板上永远看不到 ✔。)
  // ⚠️ id 用 `_taskSeq` 单调递增而不是 `length+1`: 移除条目后再用 length 会**发出重复 id**,
  //    于是后续 update 改到错的那条上。
  //
  // 回执字符串直接给模型看(mcp-tools 的 `task` 工具只是这个方法的薄壳)。逻辑留在 mixin 上
  // 是为了**能测** —— 写进 buildMcp() 的闭包里就谁也够不着了(persona_admin 那套就是这样不可测的)。
  taskOp(op, args) {
    // 主键统一叫 id(与 reminder / memory_* 同名); 旧名 taskId 照收 —— 两个名字串用时 dev 一半调用失败(10-14)
    const a = { ...(args || {}) };
    if (a.taskId !== undefined) { if (a.id === undefined) a.id = a.taskId; delete a.taskId; }
    // 同一回 dev 里模型顺手写的另外两种: title 当 subject、done 当 completed —— 意思无歧义, 照收
    if (a.title !== undefined) { if (a.subject === undefined) a.subject = a.title; delete a.title; }
    if (a.done === true || a.done === 'true') { if (a.status === undefined) a.status = 'completed'; delete a.done; }
    if (a.status === 'done') a.status = 'completed';
    const spec = TASK_OPS[op];
    if (!spec) return `⚠️ 没有 op='${op}' 这个用法。可用: ${Object.keys(TASK_OPS).join(' / ')}`;
    // 认不得的参数直接拒, 不许静默丢: 模型带 due/recurring 进来, 丢掉之后它就跟人说「到时候会提醒你」
    // —— 这份清单没有时间轴, 从来不会到点弹出。时间相关的一律指去 reminder。
    const unknown = Object.keys(a).filter((k) => !spec.req.includes(k) && !spec.opt.includes(k));
    if (unknown.length) {
      return `⚠️ Unknown args: ${unknown.join(', ')} — nothing was saved. This list has no dates and never fires at a time; `
        + `for anything time-bound use the reminder tool instead.\nop='${op}' takes ${[...spec.req, ...spec.opt].join(', ') || 'no args'}.`;
    }
    const missing = spec.req.filter((k) => a[k] === undefined || a[k] === null || a[k] === '');
    if (missing.length) {
      return `op='${op}' 需要 ${spec.req.map((k) => `${k}=…`).join(', ')}`
        + `${spec.opt.length ? ` · 可选 ${spec.opt.join(', ')}` : ''}\n缺: ${missing.join(', ')}\n${spec.hint}`;
    }
    if (!Array.isArray(this._tasks)) this._tasks = [];

    if (op === 'list') {
      if (!this._tasks.length) return '(清单是空的 — 手上没欠着的事)';
      const left = this._tasks.filter((x) => x.status !== 'completed').length;
      return `${this._tasks.length} 步, 还剩 ${left} 步:\n` + this._tasks.map(taskLine).join('\n');
    }
    if (op === 'create') {
      this._taskSeq = (this._taskSeq || this._tasks.length) + 1;
      const t = { id: String(this._taskSeq), subject: String(a.subject), status: 'pending' };
      if (a.description) t.description = String(a.description);
      this._tasks.push(t);
      this._flushTasks();
      return `✅ 建了 #${t.id}: ${t.subject}`;
    }

    const t = this._tasks.find((x) => x.id === String(a.id).replace(/^#/, ''));
    if (!t) {
      return `⚠️ 清单上没有 #${a.id}。`
        + (this._tasks.length ? `现在有: ${this._tasks.map((x) => '#' + x.id).join(' ')}` : '清单是空的。');
    }
    if (op === 'get') return taskLine(t) + (t.description ? `\n${t.description}` : '');

    // op === 'update'
    if (a.status !== undefined && !TASK_STATUS.includes(a.status)) {
      return `⚠️ status 只收 ${TASK_STATUS.join(' / ')}, 收到的是 '${a.status}'。`
        + `要挂起请用 blocked 参数传一句理由, 不是传 status:'blocked'。`;
    }
    // 🔴 一个 opt 字段都没认出来 = 调用方编错了参数名(`done` 当 `status` 之类)。args 是自由 KV,
    //    schema 拦不住, 所以这里是唯一拦得住的地方。老版直接落到下面回一条 `✅ #N pending → pending`
    //    —— 一个字都没改却带着 ✅, 而调用方只有回执可看, 于是把"没生效"当成"已办妥"。
    //    判定条件与下面每个字段的写入条件逐一对齐: 对不齐就会出现"算改了却没写进去"的第二种假成功。
    const touched = ['subject', 'status'].filter((k) => a[k]).concat(a.blocked !== undefined ? ['blocked'] : []);
    if (!touched.length) {
      const junk = Object.keys(a).filter((k) => k !== 'id');
      return `⚠️ #${t.id} 一个字都没改 —— args 里除了 id 没有认得的字段`
        + `${junk.length ? `(收到的是: ${junk.join(', ')})` : ''}。\n`
        + `op='update' 可选 ${spec.opt.join(', ')}\n${spec.hint}`;
    }
    const before = t.status;
    if (a.subject) t.subject = String(a.subject);
    if (a.status) t.status = a.status;
    // 🔴 blocked 现在是**一等参数**, 不再塞进 metadata 绕路。绕路那版的理由是 harness 的 status
    //    枚举由 SDK 写死, 传第五个值会被 schema 挡掉; 入口收归自己之后那层枷锁没有了。
    //    但语义原样保留: 挂起的任务仍躺在清单上给用户看, 只是 maybeContinueTasks 不再催它 ——
    //    这是"卡在人身上"唯一的结构化表达, 替掉老版那道猜"AI 上一句是不是问句"的正则门。
    if (a.blocked !== undefined) {
      if (a.blocked === null || a.blocked === '') {
        if (t.status === 'blocked') t.status = 'pending';
        delete t.blockedReason; delete t.blockedAt;
      } else {
        if (t.status !== 'blocked') t.blockedAt = Date.now();   // 挂起起算点: 超一天挪进待办簿
        t.status = 'blocked'; t.blockedReason = String(a.blocked);
      }
    }
    if (t.status === 'deleted') this._tasks = this._tasks.filter((x) => x !== t);
    // 整件活的步骤全打勾了 → 一起清掉
    const allDone = this._tasks.length > 0 && this._tasks.every((x) => x.status === 'completed');
    if (allDone) this._tasks = [];
    this._flushTasks();
    // 🔴 逐字段回显本次**实际写入**的值。只回显状态的老版判不出成没成: 改 subject 成功与编错
    //    参数名什么都没改, 两条回执逐字相同(都是 `✅ #N pending → pending`)。回执是调用方唯一
    //    的凭据, 它必须自己说清改了什么, 否则每改一次都得再 list 一遍才敢信。
    const changes = [before === t.status ? `状态仍是 ${t.status}` : `${before} → ${t.status}`];
    if (touched.includes('subject')) changes.push(`标题改为「${t.subject}」`);
    if (touched.includes('blocked')) changes.push(t.blockedReason ? `挂起理由改为「${t.blockedReason}」` : '已解除挂起');
    const tail = allDone ? ' · 全部步骤做完, 清单已清空' : (t.status === 'deleted' ? ' · 已移出清单' : '');
    return `✅ #${t.id} ${changes.join(' · ')}${tail}`;
  }

  // 清单变了 → 推界面 + 落盘。🔴 两件事必须成对: 只推不落, 重启就回到旧清单;
  // 只落不推, 用户屏幕上那份是假的。
  _flushTasks() {
    this._emit('onTasks', this._panelRows());
    this._saveTasks();
  }

  // 任务面板 = 模型列的步骤 + 程序跑着的后台作业(bg-jobs.js, 带 job:true)。推面板一律走这里, 两种行才不会互相冲掉
  _panelRows() {
    return [...(this._tasks || []).map((t) => ({ ...t })), ...bgJobs.rows(this)];
  }

  // 挂起超一天的步骤挪进待办簿: 那是在等人, 不是这件活的步骤(11-09 实查: 挂着不清的全是「等谁交东西」)。
  // 挪成功才从清单拿掉; 没有待办簿(行业版等没有插件命令执行器)就原样留着。告知攒在 _taskSweepNote, 下一条消息带给模型。
  async _sweepStaleBlocked() {
    const run = this.personaOps && this.personaOps.runPluginCommand;
    const list = this._tasks || [];
    if (typeof run !== 'function' || !list.some((t) => t.status === 'blocked')) return;
    if (this._sweeping) return;
    this._sweeping = true;
    try {
      const now = Date.now();
      const moved = [];
      for (const t of list) {
        if (t.status !== 'blocked') continue;
        if (!t.blockedAt) { t.blockedAt = now; this._saveTasks(); continue; }   // 老清单没记起算点: 从现在算
        if (now - t.blockedAt < BLOCKED_TO_TODO_MS) continue;
        const r = await run('todo.add', { title: t.subject, note: t.blockedReason || '', who: this.name }).catch((e) => ({ ok: false, message: e && e.message }));
        if (r && r.ok) moved.push(t);
        else console.error(`[tasks] ${this.name} #${t.id} 挪待办簿失败: ${(r && (r.message || r.code)) || 'no result'}`);
      }
      if (!moved.length) return;
      this._tasks = (this._tasks || []).filter((t) => !moved.includes(t));
      this._flushTasks();
      console.log(`[tasks] ${this.name} 挂起超一天的 ${moved.map((t) => '#' + t.id).join(' ')} 挪进待办簿`);
      this._taskSweepNote = (this._taskSweepNote || '') + `<system-reminder>\n这几条在 task 里挂起超过一天, 已挪进待办簿(plugin_call id='todo'): `
        + moved.map((t) => `#${t.id} ${t.subject}${t.blockedReason ? `(等: ${t.blockedReason})` : ''}`).join(' · ')
        + `。task 只放手上这件活的步骤; 等人、等结果的事在待办簿里跟。\n</system-reminder>\n`;
    } finally { this._sweeping = false; }
  }

  // 每条提交取一次: 顺手再扫一遍(结果下一条带上), 把攒下的告知交出去
  _takeTaskSweepNote() {
    this._sweepStaleBlocked().catch((e) => console.error(`[tasks] ${this.name} 扫挂起出错: ${e && e.message}`));
    const n = this._taskSweepNote || '';
    this._taskSweepNote = '';
    return n;
  }

  // 清单落盘 —— 作者 2026-09-25: 「任务一旦压缩了就没了, 这个不行」。
  // 老行为: _tasks 只活在内存, clear() 直接清空, 压缩/重启双双归零。而清空的理由(见 compact.js)
  // 是"清空后 AI 已经不认得这些任务了" —— 那个理由只在**没有重新注入**的前提下成立, 现在
  // buildWakePayload 会把未完成清单念给新会话听, 前提不再成立。
  // 🔴 落盘带来的新风险: 万一混进一条人格自己也不认的任务, 老办法(重启清掉)失效了。
  //    对策不是不落盘, 而是让它看得见 —— 起床清单里逐条列出, 它有 task(op='update') 可以自己删。
  _tasksFile() { return path.join(this.memoryDir, 'tasks.json'); }

  _saveTasks() {
    try {
      // 做完的步骤一起落盘(重启后 ✔ 还在); 全做完时内存里已清空, 这里删文件
      const list = this._tasks || [];
      if (!list.some((t) => t.status !== 'completed')) { try { fs.unlinkSync(this._tasksFile()); } catch (_) {} return; }
      fs.writeFileSync(this._tasksFile(), JSON.stringify({
        saved_at: Date.now(), seq: this._taskSeq || 0, tasks: list,
      }, null, 2), 'utf8');
    } catch (e) { console.error(`[tasks] ${this.name} 清单落盘失败: ${e && e.message}`); }
  }

  _loadTasks() {
    try {
      const f = this._tasksFile();
      if (!fs.existsSync(f)) return;
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      const TASK_STALE_MS = 7 * 24 * 3600 * 1000;   // 超一周的清单不再吵人: 那时的"待办"早已不是现在这件
      if (Date.now() - (raw.saved_at || 0) > TASK_STALE_MS) {
        console.log(`[tasks] ${this.name} 盘上清单超期(>7d), 丢弃`);
        try { fs.unlinkSync(f); } catch (_) {}
        return;
      }
      this._tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
      this._taskSeq = raw.seq || this._tasks.length;
      if (this._tasks.length) console.log(`[tasks] ${this.name} 从盘上接回 ${this._tasks.length} 件未完成`);
    } catch (e) { console.error(`[tasks] ${this.name} 清单读盘失败: ${e && e.message}`); }
  }
}

module.exports = TasksMixin;
// 参数表/枚举 —— mcp-tools 的薄壳与门禁测试都读这一份, 定义两处必然漂开。
module.exports.TASK_OPS = TASK_OPS;
module.exports.TASK_STATUS = TASK_STATUS;
