// test-task-continue.js — 续跑链路改版的门禁 (作者 2026-09-25 定案)
//
// 守的是四件事, 每一件都对应一次真实事故:
//   ① 退避: 老版固定 2 秒 × 8 连发 —— 16:44 实测连吐 8 句同样的话, 8-26 同样的八连有 24 组
//   ② blocked: "卡在人身上"要能用状态字段表达, 而不是靠猜回复正文
//   ③ 正则门已撤: 人格答「等你重启。」照样被判成没在等人
//   ④ 清单活过压缩: 老版 clear() 整份清掉
//   ⑤ 双账不许复活: 入口曾经借 harness 的 TaskCreate/TaskUpdate(靠偷看消息流入参), id 两边
//      各自发号 → 面板清不掉 · 盘上删不掉 · Task not found 三个 bug
require('./host-wiring');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e && e.message}`); fail++; }
};

const idle = require('../core/idle-watcher.js');
const ConsumeMixin = require('../core/agent/consume.js');
const TasksMixin = require('../core/agent/tasks.js');

console.log('\n[① 退避表 · 分钟级, 不是秒级]');
t('退避表是分钟级 —— 最短一档也 ≥ 60s', () => {
  assert.ok(idle.TASK_CONTINUE_BACKOFF_MS.every((ms) => ms >= 60_000),
    `表里有低于 1 分钟的档: ${idle.TASK_CONTINUE_BACKOFF_MS}`);
});
t('退避表单调不降 (越催越慢, 不会越催越快)', () => {
  const a = idle.TASK_CONTINUE_BACKOFF_MS;
  for (let i = 1; i < a.length; i++) assert.ok(a[i] >= a[i - 1], `第 ${i} 档比前一档短`);
});
t('run 1→5 逐级拉长: 1m · 2m · 5m · 10m · 30m', () => {
  assert.deepStrictEqual([1, 2, 3, 4, 5].map(idle.taskContinueDelayMs),
    [60_000, 120_000, 300_000, 600_000, 1_800_000]);
});
t('超出表长维持末值, 不越界 undefined', () => {
  const last = idle.TASK_CONTINUE_BACKOFF_MS[idle.TASK_CONTINUE_BACKOFF_MS.length - 1];
  for (const run of [6, 7, 8, 99]) assert.strictEqual(idle.taskContinueDelayMs(run), last);
});
t('run=0/负数/undefined 不炸, 退回首档', () => {
  for (const bad of [0, -3, undefined, null, NaN]) {
    assert.strictEqual(idle.taskContinueDelayMs(bad), idle.TASK_CONTINUE_BACKOFF_MS[0]);
  }
});
t('🔴 老版那个 2 秒级的催办再也回不来 (整表最小值 ≥ 60s)', () => {
  assert.ok(Math.min(...idle.TASK_CONTINUE_BACKOFF_MS) >= 60_000);
});

console.log('\n[② blocked 态 · 一等参数, 不再绕 metadata]');
const mkAgent = (dir) => ({
  _tasks: [], _taskSeq: 0, name: '测试人格', memoryDir: dir, _emitted: [],
  _emit(ev, payload) { this._emitted.push([ev, payload]); },
  taskOp: TasksMixin.prototype.taskOp,
  _flushTasks: TasksMixin.prototype._flushTasks,
  _saveTasks: TasksMixin.prototype._saveTasks,
  _loadTasks: TasksMixin.prototype._loadTasks,
  _tasksFile: TasksMixin.prototype._tasksFile,
});
const create = (a, subject) => a.taskOp('create', { subject });
const update = (a, args) => a.taskOp('update', args);

t('blocked 参数把任务标成 blocked 并留下理由', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  const a = mkAgent(dir);
  create(a, '补 alembic 迁移');
  update(a, { taskId: '1', blocked: '在等作者拍板' });
  assert.strictEqual(a._tasks[0].status, 'blocked');
  assert.strictEqual(a._tasks[0].blockedReason, '在等作者拍板');
});
t('blocked:null 解除挂起, 回到 pending 且理由清掉', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  const a = mkAgent(dir);
  create(a, 'x');
  update(a, { taskId: '1', blocked: '等人' });
  update(a, { taskId: '1', blocked: null });
  assert.strictEqual(a._tasks[0].status, 'pending');
  assert.ok(!('blockedReason' in a._tasks[0]), 'blockedReason 应该被删掉');
});
t('只改传进来的那一格 (没传 blocked 就不动挂起状态)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  const a = mkAgent(dir);
  create(a, 'x');
  update(a, { taskId: '1', status: 'in_progress' });
  update(a, { taskId: '1', subject: '改个名字' });
  assert.strictEqual(a._tasks[0].status, 'in_progress');
  assert.strictEqual(a._tasks[0].subject, '改个名字');
});
t('blocked 的任务仍留在清单上 (用户看得见, 只是不催)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  const a = mkAgent(dir);
  create(a, 'x');
  update(a, { taskId: '1', blocked: '等人' });
  assert.strictEqual(a._tasks.length, 1);
});
t('deleted 当场移出; 剩下的全是 completed 时整份清空', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  const a = mkAgent(dir);
  create(a, 'a'); create(a, 'b');
  update(a, { taskId: '1', status: 'completed' });
  const r = update(a, { taskId: '2', status: 'deleted' });
  assert.strictEqual(a._tasks.length, 0);
  assert.ok(/清单已清空/.test(r), r);
});
t('🔴 做完的步骤留着打勾, 全部做完才一起清 (作者 10-22)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  const a = mkAgent(dir);
  create(a, '一'); create(a, '二'); create(a, '三');
  update(a, { id: '1', status: 'completed' });
  assert.deepStrictEqual(a._tasks.map((x) => x.status), ['completed', 'pending', 'pending']);
  assert.ok(/3 步, 还剩 2 步/.test(a.taskOp('list', {})));
  // 落盘带着做完的那步: 重启后 ✔ 还在
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8'));
  assert.strictEqual(disk.tasks.length, 3);
  update(a, { id: '2', status: 'completed' });
  assert.strictEqual(a._tasks.length, 3);
  const r = update(a, { id: '3', status: 'completed' });
  assert.strictEqual(a._tasks.length, 0);
  assert.ok(/全部步骤做完, 清单已清空/.test(r), r);
  assert.ok(!fs.existsSync(path.join(dir, 'tasks.json')), '全做完后盘上文件应删掉');
  assert.deepStrictEqual(a._emitted[a._emitted.length - 1], ['onTasks', []], '面板最后收到空清单');
});
t('有一步卡住时, 其余做完也不清空', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  const a = mkAgent(dir);
  create(a, '一'); create(a, '二');
  update(a, { id: '1', blocked: '等人' });
  update(a, { id: '2', status: 'completed' });
  assert.strictEqual(a._tasks.length, 2);
});

t('🔴 status 不收 blocked —— 挂起必须走 blocked 参数, 否则理由会缺', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  const a = mkAgent(dir);
  create(a, 'x');
  const r = update(a, { taskId: '1', status: 'blocked' });
  assert.ok(/只收/.test(r), `应当拒绝并给出枚举, 实际回执: ${r}`);
  assert.strictEqual(a._tasks[0].status, 'pending', '被拒的 status 不该落到条目上');
  assert.ok(!('blockedReason' in a._tasks[0]));
});
t('改不存在的 id 不炸, 回执里把现有 id 列出来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  const a = mkAgent(dir);
  create(a, 'x');
  const r = update(a, { taskId: '99', status: 'deleted' });
  assert.ok(/#99/.test(r) && /#1/.test(r), `回执要说清没有 #99、现有 #1, 实际: ${r}`);
});
t('create 回执带上分配到的 id (拿不到 id 就没法改它)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  const a = mkAgent(dir);
  assert.ok(/#1/.test(create(a, '第一件')), 'create 回执里没有 #id');
});
t('list 把 blocked 的理由一起念出来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  const a = mkAgent(dir);
  create(a, 'x');
  update(a, { taskId: '1', blocked: '等作者拍板' });
  assert.ok(/等作者拍板/.test(a.taskOp('list')), 'list 没带挂起理由, 用户无从知道在等什么');
});
t('少必填参数时回参数表, 而不是静默什么都不做', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  const a = mkAgent(dir);
  assert.ok(/subject/.test(a.taskOp('create', {})), '没提示缺 subject');
  assert.strictEqual(a._tasks.length, 0);
});
t('🔴 update 编错参数名时回 ⚠️ 而不是带 ✅ 的假成功', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  const a = mkAgent(dir);
  create(a, '原标题');
  // `finished` 是编出来的参数名(真名叫 status)。args 是自由 KV, schema 拦不住 → 只能在 taskOp 里拦。
  // (`done` 已收作 status:'completed' 的别名 —— 10-14 dev 模型连写两次, 意思无歧义 —— 所以不能再拿它当野参数测)
  const r = update(a, { taskId: '1', finished: true });
  assert.ok(!r.includes('✅'), `编错参数名却回了 ✅, 调用方会把"没生效"当成"已办妥": ${r}`);
  assert.ok(/finished/.test(r), '没把收到的那个野参数名回显出来, 调用方不知道自己错在哪');
  assert.ok(/status/.test(r), '没给出真正的参数名, 调用方改不对');
  assert.strictEqual(a._tasks[0].status, 'pending', '拦住了却还是改了状态');
  const r2 = update(a, { id: '1', done: true });
  assert.ok(r2.includes('completed'), `done:true 应当真把它办完: ${r2}`);
});
t('🔴 只改 subject 时回执要回显新标题 (否则与"什么都没改"逐字相同)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  const a = mkAgent(dir);
  create(a, '原标题');
  const r = update(a, { taskId: '1', subject: '新标题' });
  assert.ok(r.includes('✅'), '合法的改名被拦住了');
  assert.ok(/新标题/.test(r), `回执没提新标题 —— 改名成功与编错参数名就无法区分了: ${r}`);
  assert.strictEqual(a._tasks[0].subject, '新标题');
});
t('🔴 只改 blocked 理由时回执要回显新理由 (状态前后都是 blocked, 光看箭头判不出)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  const a = mkAgent(dir);
  create(a, 'x');
  update(a, { taskId: '1', blocked: '旧理由' });
  const r = update(a, { taskId: '1', blocked: '新理由' });
  assert.ok(/新理由/.test(r), `回执没提新理由: ${r}`);
  assert.ok(!/旧理由/.test(r), `回执还在念旧理由, 看不出换掉了: ${r}`);
  assert.strictEqual(a._tasks[0].blockedReason, '新理由');
});

console.log('\n[③ 续跑判据里不许再出现"猜正文"]');
t('🔴 maybeContinueTasks 不再读 lastTurnWasQuestion', () => {
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const fn = src.slice(src.indexOf('function maybeContinueTasks'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(!body.includes('lastTurnWasQuestion'),
    '续跑又开始看那段"猜 AI 上一句是不是问句"的正则了 —— 作者 9-11 已在压缩闸上定案撤除, 见 core/compact-gate.js:7');
});
t('🔴 待办口径把 blocked 排除在外', () => {
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  assert.ok(/function pendingTasksOf[\s\S]{0,400}!==\s*'blocked'/.test(src),
    'pendingTasksOf 没有把 blocked 滤掉, blocked 会照样被催');
});
t('提示语给的是真出口 (blocked 的用法写在里面)', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'core/config/main/task_continue.md'), 'utf8');
  assert.ok(md.includes('blocked'), '出口没写 blocked, 人格无从知道怎么挂起');
  assert.ok(/task\(op='update'/.test(md), '提示语没给自家 task 工具的写法');
  assert.ok(!/TaskUpdate/.test(md), '🔴 提示语还在教 TaskUpdate —— 那个工具已经关掉了, 照着做必然报错');
});

console.log('\n[④ 清单活过压缩与重启]');
t('落盘→读回: 未完成任务与 seq 都接得上', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  const a = mkAgent(dir);
  create(a, '第一件'); create(a, '第二件');
  update(a, { taskId: '1', blocked: '等作者' });
  const b = mkAgent(dir);
  b._loadTasks();
  assert.strictEqual(b._tasks.length, 2);
  assert.strictEqual(b._taskSeq, 2, 'seq 没接上会发出重复 id, 后续 update 改到错的那条');
  assert.strictEqual(b._tasks.find((x) => x.id === '1').status, 'blocked');
  assert.strictEqual(b._tasks.find((x) => x.id === '1').blockedReason, '等作者');
});
t('清单清空后盘上文件跟着删掉 (不留空壳吵下一次启动)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  const a = mkAgent(dir);
  create(a, 'x');
  assert.ok(fs.existsSync(path.join(dir, 'tasks.json')));
  update(a, { taskId: '1', status: 'completed' });
  assert.ok(!fs.existsSync(path.join(dir, 'tasks.json')));
});
t('超过 7 天的清单不再吵人, 文件一并清掉', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  const f = path.join(dir, 'tasks.json');
  fs.writeFileSync(f, JSON.stringify({
    saved_at: Date.now() - 8 * 24 * 3600 * 1000, seq: 3,
    tasks: [{ id: '3', subject: '上上周的事', status: 'pending' }],
  }));
  const a = mkAgent(dir);
  a._loadTasks();
  assert.strictEqual(a._tasks.length, 0);
  assert.ok(!fs.existsSync(f), '超期文件应该被删掉, 否则每次启动都读一次再丢一次');
});
t('盘上文件损坏不炸进程, 只是当作没有', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  fs.writeFileSync(path.join(dir, 'tasks.json'), '{这不是 json');
  const a = mkAgent(dir);
  a._loadTasks();
  assert.strictEqual(a._tasks.length, 0);
});
t('🔴 clear() 不再把清单整份清掉', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core/agent/compact.js'), 'utf8');
  assert.ok(!/this\._tasks\s*=\s*\[\]\s*;\s*this\._taskSeq\s*=\s*0/.test(src),
    'clear() 又开始清空任务清单了 —— 作者 9-25:「任务一旦压缩了就没了, 这个不行」');
  assert.ok(src.includes('_saveTasks()'), 'clear() 里应当落盘, 让新会话接得回来');
});
t('🔴 起床清单会把未完成任务念给新会话听', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core/agent/wake.js'), 'utf8');
  assert.ok(/手上还欠着的任务/.test(src), 'buildWakePayload 没注入任务清单');
  assert.ok(/blocked/.test(src.slice(src.indexOf('手上还欠着的任务'), src.indexOf('手上还欠着的任务') + 1200)),
    '注入段里没告诉新会话 blocked 怎么用');
});
t('构造 Butler 时会尝试接回盘上清单', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core/agent.js'), 'utf8');
  assert.ok(/_loadTasks\(\)/.test(src), 'agent.js 构造里没有 _loadTasks, 重启就丢');
});

console.log('\n[⑤ 双账不许复活 · 增删改的入口只有自己那一个]');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
t('🔴 consume.js 里没有「偷看 TaskCreate/TaskUpdate 入参」那条旁路', () => {
  const src = read('core/agent/consume.js');
  assert.ok(!/b\.name === 'TaskCreate'/.test(src),
    '旁路复活了 —— 从消息流偷看入参会让 id 出现第二个来源, 那正是三个 bug 的根');
  assert.ok(!/^\s*_trackTask\s*\(/m.test(src),
    '_trackTask 的方法定义复活了 —— 注释里提它当历史交代可以, 重新长出来不行');
});
t('🔴 发号只走 _taskSeq, 不许 length+1 (会发出重复 id)', () => {
  const src = read('core/agent/tasks.js');
  assert.ok(!/_tasks\.length \+ 1/.test(src), '又用 length+1 发号了');
  assert.ok(/_taskSeq = \(this\._taskSeq \|\| this\._tasks\.length\) \+ 1/.test(src));
});
t('task 工具注册了, 而且在白名单里 (漏一处就是看得见调不动)', () => {
  assert.ok(/tools\.push\(taskTool\)/.test(read('core/agent/mcp-tools.js')), 'mcp-tools 没注册 task');
  assert.ok(/'mcp__butler__task'/.test(read('core/agent/stream.js')), 'buildAllowedTools 没放行 mcp__butler__task');
});
t('两份 descriptions 都有 task 的说明 (整文件覆盖, 漏一份该版就是 undefined)', () => {
  for (const f of ['core/config/tools/descriptions.json', 'industry/config/tools/descriptions.json']) {
    assert.ok(JSON.parse(read(f)).task, `${f} 缺 task 的描述`);
  }
});
t('四个 op 齐全, 每个都有参数表和 hint', () => {
  const { TASK_OPS } = TasksMixin;
  assert.deepStrictEqual(Object.keys(TASK_OPS), ['list', 'create', 'update', 'get']);
  for (const [op, spec] of Object.entries(TASK_OPS)) {
    assert.ok(Array.isArray(spec.req) && Array.isArray(spec.opt), `${op} 少 req/opt`);
    assert.ok(spec.hint && spec.hint.length > 10, `${op} 的 hint 太短, 人格会瞎传参数`);
  }
});
t('🔴 buildEnv 关掉 harness 那套 tasks 功能位 (否则双账还在, 且每轮白付提醒的 token)', () => {
  const { buildEnv } = require('../core/agent/env.js');
  assert.strictEqual(buildEnv(null, false, null).CLAUDE_CODE_ENABLE_TASKS, 'false');
});
t('🔴 仓库那份 builtin_tools.json 不再放 TaskCreate/TaskUpdate', () => {
  const list = JSON.parse(read('core/config/main/builtin_tools.json'));
  assert.ok(!list.includes('TaskCreate') && !list.includes('TaskUpdate'),
    '仓库那份还留着 harness 的 task 工具 —— 它跟代码一起走, 新代码有自家 task 了');
  // 🔴 数据目录那份覆盖层**故意不在这里检查**: 它被当前已安装的那个版本读取, 而那个版本的代码里
  //    还没有自家 task 工具。开发机上先摘掉 = 装机版人格当场失去全部任务能力(狂人那 12 条更清不掉)。
  //    摘它是**发版步骤**的一环(新版装上去之后再同步覆盖层), 不是单测该管的事。
});
t('🔴 出厂知识里不许再教 TaskCreate (新人格一出生就会调一个不存在的工具)', () => {
  const src = read('core/config/onboarding/knowledge/leaf_core.json');
  assert.ok(!/TaskCreate|TaskUpdate/.test(src), '四语出厂知识还在教 harness 那套');
});

console.log(`\n${fail ? '❌' : '✅'} test-task-continue: ${pass} 过 / ${fail} 败\n`);
process.exit(fail ? 1 : 0);
