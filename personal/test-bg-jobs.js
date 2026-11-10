// test-bg-jobs.js — 后台作业由程序列进任务面板; task 里挂起超一天的步骤挪进待办簿。跑: node test-bg-jobs.js
//
// 来历(11-09 实查): 人格把 task 当「后台作业监视 + 等别人」的追踪表, 清单永远清不空。
// 治法: 后台作业(两种引擎都发 system/task_*)程序自己维护成面板行; 等人的挪进待办簿, task 只留这件活的步骤。
require('./host-wiring');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Butler } = require('../core/agent');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

// 每个 agent 一个目录: 清单会落盘, 共用目录就串到下一个里
function mkAgent() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-bgjobs-'));
  fs.mkdirSync(path.join(tmp, 'memory'), { recursive: true });
  const b = new Butler(tmp, { name: '测试体' });
  const seen = { panels: [] };
  b.setCallbacks({
    onText: () => {}, onActivity: () => {}, onTool: () => {}, onToolDone: () => {},
    onUsage: () => {}, onTextDone: () => {}, onResult: () => {}, onTasks: (rows) => seen.panels.push(rows),
  });
  b.submit = async () => {};
  return { b, seen };
}
async function* stream(...msgs) { for (const m of msgs) yield m; }
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const sys = (subtype, extra) => ({ type: 'system', subtype, session_id: 's1', ...extra });

(async () => {
  console.log('\n=== 后台作业进任务面板: 开跑 ▶ → 进度 → 收尾 ✔; 前台子代理不列 ===');
  {
    const { b, seen } = mkAgent();
    b.taskOp('create', { subject: '模型自己列的一步' });
    await b._consume(stream(
      sys('init', { model: 'm' }),
      sys('task_started', { task_id: 'a1', tool_use_id: 't1', description: '查三个目录', task_type: 'local_agent', is_backgrounded: true }),
      sys('task_started', { task_id: 'f1', tool_use_id: 't2', description: '前台的', task_type: 'local_agent', is_backgrounded: false }),
      sys('task_started', { task_id: 'w1', description: '审一遍', task_type: 'local_workflow', workflow_name: 'review' }),
      sys('task_progress', { task_id: 'a1', description: '查三个目录', summary: '2/3 done', usage: {} }),
      { type: 'result', subtype: 'success' },
    ));
    await tick(600);
    const last = seen.panels.at(-1);
    const jobs = last.filter((r) => r.job);
    ok(last.some((r) => !r.job && r.subject === '模型自己列的一步'), '模型列的步骤还在面板上');
    ok(jobs.length === 2, `只列后台的两个(后台子代理 + 工作流), 前台不列(实得 ${JSON.stringify(jobs.map((j) => j.id))})`);
    ok(jobs.every((j) => j.status === 'in_progress'), '开跑后是 ▶');
    ok((jobs.find((j) => j.id === 'bg:a1') || {}).detail === '2/3 done', '进度那行写进 detail');
    ok((jobs.find((j) => j.id === 'bg:w1') || {}).subject.startsWith('review'), '工作流那行带脚本名');
    ok(Date.now() - (b.lastBgLaunchTs || 0) < 5000, '🔴 后台在跑 → lastBgLaunchTs 续上(idle-watcher 不压缩)');

    await b._consume(stream(
      sys('task_notification', { task_id: 'a1', status: 'completed', summary: 'x', output_file: '' }),
      sys('task_notification', { task_id: 'w1', status: 'failed', summary: 'x', output_file: '' }),
      { type: 'result', subtype: 'success' },
    ));
    await tick();
    const after = seen.panels.at(-1).filter((r) => r.job);
    ok(after.find((j) => j.id === 'bg:a1').status === 'completed', '收尾后 ✔');
    ok(after.find((j) => j.id === 'bg:w1').status === 'failed', '失败的 ✖');
    ok(b._tasks.length === 1, '🔴 后台作业不写进模型那份 task 清单(不落盘、不进起床清单)');
  }

  console.log('\n=== 换了会话: 上个会话没收尾的后台作业标成叫停 ===');
  {
    const { b, seen } = mkAgent();
    await b._consume(stream(sys('task_started', { task_id: 'a9', description: '长活', task_type: 'local_agent', is_backgrounded: true }), { type: 'result', subtype: 'success' }));
    await b._consume(stream({ type: 'system', subtype: 'init', session_id: 's2', model: 'm' }, { type: 'result', subtype: 'success' }));
    await tick();
    ok(seen.panels.at(-1).find((r) => r.id === 'bg:a9').status === 'stopped', '旧会话的在跑行变成 ■');
  }

  console.log('\n=== task 里挂起超一天 → 挪进待办簿, 下一条消息告诉模型 ===');
  {
    const { b } = mkAgent();
    const calls = [];
    b.personaOps = { runPluginCommand: async (name, args) => { calls.push({ name, args }); return { ok: true }; } };
    b.taskOp('create', { subject: '等作者看图' });
    b.taskOp('create', { subject: '刚挂起的' });
    b.taskOp('create', { subject: '正在做的' });
    b.taskOp('update', { id: '1', blocked: '作者还没回' });
    b.taskOp('update', { id: '2', blocked: '等构建' });
    ok(typeof b._tasks[0].blockedAt === 'number', '挂起时记下起算点');
    b._tasks[0].blockedAt = Date.now() - 25 * 3600 * 1000;
    ok(b._takeTaskSweepNote() === '', '第一次取: 扫描刚开始, 还没有告知');
    await tick();
    ok(calls.length === 1 && calls[0].name === 'todo.add' && calls[0].args.title === '等作者看图' && calls[0].args.note === '作者还没回' && calls[0].args.who === '测试体',
      `🔴 用 todo.add 记进待办簿, 标题 / 等什么 / 谁记的都带上(实得 ${JSON.stringify(calls)})`);
    ok(b._tasks.map((t) => t.subject).join('|') === '刚挂起的|正在做的', '只挪超一天的那条, 其余留着');
    const note = b._takeTaskSweepNote();
    ok(/待办簿/.test(note) && note.includes('#1 等作者看图'), '下一条消息带上告知');
    ok(b._takeTaskSweepNote() === '', '告知只带一次');
    b.taskOp('update', { id: '2', blocked: null });
    ok(b._tasks.find((t) => t.id === '2').blockedAt === undefined, '解除挂起清掉起算点');
  }

  console.log('\n=== 没有待办簿(没有插件命令执行器)就原样留着 ===');
  {
    const { b } = mkAgent();
    b.personaOps = null;
    b.taskOp('create', { subject: '等人' });
    b.taskOp('update', { id: '1', blocked: '等' });
    b._tasks[0].blockedAt = Date.now() - 48 * 3600 * 1000;
    b._takeTaskSweepNote();
    await tick();
    ok(b._tasks.length === 1, '留在清单上');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
