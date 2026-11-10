// 任务面板: 输入框上方那一小块。两种行 —— 模型用 task 列的这件活的步骤, 和程序跑着的后台作业
// (后台子代理 / 工作流 / 后台命令, job:true, 由 core/agent/bg-jobs.js 维护)。从 renderer.js 拆出。
// 用到 renderer.js 的 t(); 只在运行时被调, 加载顺序在它前面没关系。

function renderTasks(tab) {
  let box = document.getElementById('taskpanel');
  if (!box) {
    box = document.createElement('div');
    box.id = 'taskpanel';
    const strip = document.getElementById('attachstrip');
    strip.parentNode.insertBefore(box, strip);
  }
  const list = tab.tasks || [];
  // 两种行: 模型列的步骤(计「还剩几步」) + 程序跑着的后台作业(job:true, 由 core/agent/bg-jobs.js 维护)
  const steps = list.filter((x) => !x.job);
  const left = steps.filter((x) => x.status !== 'completed').length;
  const running = list.filter((x) => x.job && x.status === 'in_progress').length;
  if (!list.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  // blocked = 卡在别人身上(task 的 blocked 参数派生的第五态), 不标出来就跟没开始的 ○ 混在一起
  const MARK = { completed: '✔', in_progress: '▶', pending: '○', blocked: '⏸', failed: '✖', stopped: '■' };
  const head = [steps.length ? t('tasks_left').replace('{n}', left).replace('{total}', steps.length) : '',
    running ? t('tasks_bg_running').replace('{n}', running) : ''].filter(Boolean).join(' · ') || t('tasks_bg_done');
  box.innerHTML = `<div class="tp-head">${head}</div>`
    + list.map((x) => `<div class="tp-row ${x.status}${x.job ? ' job' : ''}"><span class="tp-mark">${MARK[x.status] || '○'}</span>`
        + `<span class="tp-txt"></span>${x.job ? '<span class="tp-detail"></span>' : ''}</div>`).join('');
  // 文本用 textContent 落, 不拼进 HTML —— 任务标题是模型写的, 拼字符串就是一个 XSS 口子
  box.querySelectorAll('.tp-row').forEach((row, i) => {
    const x = list[i];
    row.querySelector('.tp-txt').textContent = x.subject || '';
    if (x.blockedReason) row.title = x.blockedReason;   // 悬停看在等什么
    const d = row.querySelector('.tp-detail');
    if (d) { d.textContent = x.detail || ''; if (x.detail) row.title = x.detail; }
  });
}
