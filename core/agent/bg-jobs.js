// 后台作业进任务面板。两种引擎都按 Claude Agent SDK 的样子发 system/task_started · task_progress · task_notification
// (Butler 引擎见 agent-sdk/src/background.ts), 这里把它们维护成面板上「程序跑着的活」那几行:
// ▶ 在跑 · ✔ 完成 · ✖ 失败 · ■ 叫停。状态全由程序管, 模型不用把后台作业手写进 task 再挂起等它
// (11-09 实查: 人格把 task 当后台作业监视表用, 清单永远清不空)。
// 只列后台的: 前台子代理随那次工具调用一起结束, 工具行已经画过了。做完的留 10 分钟给人看一眼再撤。
const KEEP_DONE_MS = 10 * 60 * 1000;
const STATUS = { completed: 'completed', failed: 'failed', stopped: 'stopped', killed: 'stopped' };

function jobs(agent) {
  if (!(agent._bgJobs instanceof Map)) agent._bgJobs = new Map();
  return agent._bgJobs;
}

function push(agent) { agent._emit('onTasks', agent._panelRows()); }

// 处理一条 system 消息; 是 task_* 就吃掉(返回 true)
function onSystemMsg(agent, msg) {
  const m = jobs(agent);
  if (msg.subtype === 'init') {
    // 换了会话(重建流 / 清空): 上个会话里没收尾的后台活已随它没了, 别在面板上一直转
    let changed = false;
    for (const j of m.values()) if (j.status === 'in_progress' && j.sessionId && j.sessionId !== msg.session_id) { finish(agent, j, 'stopped'); changed = true; }
    if (changed) push(agent);
    return false;
  }
  if (!/^task_/.test(msg.subtype || '')) return false;
  const id = msg.task_id;
  if (msg.subtype === 'task_started') {
    const bg = msg.is_backgrounded !== false || msg.task_type === 'local_workflow';
    if (!id || !bg || msg.skip_transcript || msg.ambient) return true;
    m.set(id, { id, subject: msg.workflow_name ? `${msg.workflow_name} · ${msg.description || ''}` : (msg.description || msg.task_type || id),
      status: 'in_progress', kind: msg.task_type || '', sessionId: msg.session_id, detail: '' });
    agent.lastBgLaunchTs = Date.now();
    console.log(`[bg-jobs] ${agent.name} 后台开跑 ${id} (${msg.task_type || '?'}) ${msg.description || ''}`);
    push(agent);
    return true;
  }
  const j = m.get(id);
  if (!j) return true;
  if (msg.subtype === 'task_progress') {
    j.detail = msg.summary || (msg.last_tool_name ? `→ ${msg.last_tool_name}` : j.detail);
    agent.lastBgLaunchTs = Date.now();   // 还在干活就续上「别压缩」的那段时间(idle-watcher 的 bgBusy)
    // 进度可能一秒好几条, 面板半秒推一次就够
    if (!agent._bgPushTimer) agent._bgPushTimer = setTimeout(() => { agent._bgPushTimer = null; push(agent); }, 500);
    return true;
  }
  if (msg.subtype === 'task_notification') {
    finish(agent, j, STATUS[msg.status] || 'completed');
    console.log(`[bg-jobs] ${agent.name} 后台收尾 ${id} → ${j.status}`);
    push(agent);
    return true;
  }
  if (msg.subtype === 'task_updated' && msg.patch && STATUS[msg.patch.status]) {
    finish(agent, j, STATUS[msg.patch.status]);
    push(agent);
  }
  return true;
}

function finish(agent, j, status) {
  j.status = status;
  const t = setTimeout(() => { jobs(agent).delete(j.id); push(agent); }, KEEP_DONE_MS);
  if (t.unref) t.unref();
}

// 面板一行: id 加前缀, 不跟模型那份 task 的 #编号撞
function rows(agent) {
  return [...jobs(agent).values()].map((j) => ({ id: `bg:${j.id}`, subject: j.subject, status: j.status, job: true, ...(j.detail ? { detail: j.detail } : {}) }));
}

module.exports = { onSystemMsg, rows };
