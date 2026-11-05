// sediment-overlay.js — 关闭 butler 之前那层「正在存档手头活」遮罩。
//
// 后端 IPC 'sediment' 驱动五个相位: show → progress/alive → (notice/notice-alive) → hide。
//
// 🔴 notice 相位是这层的重点, 它替代的是原先一个 dialog.showMessageBoxSync 拦路框。换掉的理由
// 不是"框不好看", 而是那个框说的往往是**假话**: 看门狗放弃等待 ≠ 人格死了 —— 2026-09-24 实测,
// 被判死之后 CLI 侧照样把记忆写完了。停的从来不是它的活, 是我们自己的耳朵。
// 所以这里只**通知**: 不阻塞退出、后台写完主进程自己发 hide 把它收掉、用户想插手随时能按。
//
// 另一半是 alive: 每行底下写它正在干什么。一个不动的框只会让人越等越慌, 而"它还在写第 3 条记忆"
// 和"它死了"在界面上本来长得一模一样。
//
// 在 renderer.js 之后加载 —— 要用那边的 t()。
(function () {
  'use strict';

  const overlay = document.getElementById('sedimentOverlay');
  const list = document.getElementById('sedimentList');
  const actions = document.getElementById('sedimentActions');
  const titleEl = overlay.querySelector('.sediment-title');
  const subEl = overlay.querySelector('.sediment-sub');
  const ICON = { pending: '⏳', done: '✅', error: '⚠️' };

  const row = (sid, name) => {
    const li = document.createElement('li');
    li.dataset.sid = sid;
    li.innerHTML = `<span class="sediment-icon">${ICON.pending}</span>`
                 + '<span class="sediment-who"><span class="sediment-name"></span>'
                 + '<span class="sediment-note"></span></span>';
    li.querySelector('.sediment-name').textContent = name;
    return li;
  };

  // 它在干什么: 写记忆就报第几条(沉淀轮唯一有意义的进度), 别的工具报工具名, 一个字没动就说还在想。
  const note = (info) => {
    if (info.memWrites > 0) return t('sediment_writing', { n: info.memWrites });
    if (info.tool) return t('sediment_using', { tool: info.tool });
    return t('sediment_thinking');
  };

  const setNote = (sid, text) => {
    const el = list.querySelector(`li[data-sid="${sid}"] .sediment-note`);
    if (el) el.textContent = text;
  };

  window.butler.onSediment((d) => {
    if (!d) return;
    if (d.phase === 'show') {
      list.innerHTML = '';
      actions.classList.add('hidden');
      titleEl.textContent = t('sediment_title');
      subEl.textContent = t('sediment_sub');
      for (const p of (d.personas || [])) list.appendChild(row(p.sid, p.name));
      overlay.classList.remove('hidden');
    } else if (d.phase === 'progress') {
      const li = list.querySelector(`li[data-sid="${d.sid}"]`);
      if (!li) return;
      li.querySelector('.sediment-icon').textContent = ICON[d.status] || '？';
      if (d.status === 'done') setNote(d.sid, '');
    } else if (d.phase === 'alive') {
      // 排队等自己那一轮的人, 在遮罩上和卡住的人长得一样 —— 把"还剩几个"一起写出来
      const queued = d.queued > 0 ? ` · ${t('sediment_queued', { n: d.queued })}` : '';
      setNote(d.sid, note(d) + queued);
    } else if (d.phase === 'notice') {
      const busy = (d.busy || []).length;
      titleEl.textContent = t('sediment_notice_title');
      subEl.textContent = busy > 0 ? t('sediment_notice_busy') : t('sediment_notice_stuck');
      list.innerHTML = '';
      for (const f of (d.failed || [])) {
        const li = row(f.sid, f.name);
        li.querySelector('.sediment-icon').textContent = ICON.error;
        li.querySelector('.sediment-note').textContent = f.error || '';
        list.appendChild(li);
      }
      actions.classList.remove('hidden');
      overlay.classList.remove('hidden');
    } else if (d.phase === 'notice-alive') {
      for (const b of (d.busy || [])) setNote(b.sid, note(b));
    } else if (d.phase === 'hide') {
      overlay.classList.add('hidden');
      actions.classList.add('hidden');
    }
  });

  document.getElementById('sedimentWait').onclick = () => window.butler.quitNotice('cancel');
  document.getElementById('sedimentForce').onclick = () => window.butler.quitNotice('force');
})();
