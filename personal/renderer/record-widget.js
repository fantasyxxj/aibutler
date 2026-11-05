// record-widget.js — md.js 里 ```record fence 的 UI 状态机: 待录/录中/已录(试听/重录/提交).
// 提交 → window.butler.saveAudio(sid, wav) 落盘 → user 消息 [audio:/path · 3.2s] 注入下一轮.
// fence 内容: 首行可选 "lang: en/ja/zh/auto", 其余整段当"要用户看的提示"文本 (可 markdown).
(function () {
  // 解析 fence 内容: {lang, prompt}
  function parseSrc(src) {
    const lines = (src || '').split('\n');
    let lang = 'auto';
    let start = 0;
    const m = lines[0] && lines[0].match(/^\s*lang\s*:\s*(\w+)\s*$/i);
    if (m) { lang = m[1].toLowerCase(); start = 1; }
    return { lang, prompt: lines.slice(start).join('\n').trim() };
  }

  // 状态: idle → recording → recorded → submitting → submitted
  function upgrade(el, sid) {
    if (!el || el.dataset.upgraded === '1') return;
    el.dataset.upgraded = '1';
    const src = el.dataset.src || '';
    const { lang, prompt } = parseSrc(src);
    el.innerHTML = '';

    if (prompt) {
      const pr = document.createElement('div');
      pr.className = 'record-prompt';
      // 提示文字用极简纯文本(escape 已在 md.js data-src 里做过, 这里 innerText 出即可)
      pr.innerText = prompt;
      el.appendChild(pr);
    }

    const ctl = document.createElement('div');
    ctl.className = 'record-controls';
    const btn = document.createElement('button');
    btn.className = 'rec-btn';
    btn.type = 'button';
    btn.textContent = '🎤 开始录音';
    const timer = document.createElement('span');
    timer.className = 'rec-timer';
    timer.textContent = '';
    ctl.appendChild(btn);
    ctl.appendChild(timer);
    el.appendChild(ctl);

    let state = 'idle';
    let wavBytes = null;
    let audioUrl = null;
    let audioEl = null;
    let tickTimer = null;
    let recStart = 0;

    const setTimer = (sec) => { timer.textContent = sec != null ? `${sec.toFixed(1)}s` : ''; };
    const startTick = () => {
      recStart = performance.now();
      tickTimer = setInterval(() => setTimer((performance.now() - recStart) / 1000), 100);
    };
    const stopTick = () => { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } };

    const paint = () => {
      // 每次状态变清理并重画控件区; prompt 不动
      ctl.innerHTML = '';
      if (state === 'idle') {
        btn.textContent = '🎤 开始录音';
        ctl.appendChild(btn); ctl.appendChild(timer);
      } else if (state === 'recording') {
        btn.textContent = '⏹ 结束录音';
        btn.className = 'rec-btn recording';
        ctl.appendChild(btn); ctl.appendChild(timer);
      } else if (state === 'recorded') {
        const play = document.createElement('button'); play.type = 'button'; play.className = 'rec-btn secondary'; play.textContent = '▶ 试听';
        const redo = document.createElement('button'); redo.type = 'button'; redo.className = 'rec-btn secondary'; redo.textContent = '🔄 重录';
        const submit = document.createElement('button'); submit.type = 'button'; submit.className = 'rec-btn primary'; submit.textContent = '✓ 提交';
        play.onclick = () => {
          if (!audioUrl) return;
          if (!audioEl) { audioEl = new Audio(audioUrl); }
          audioEl.currentTime = 0;
          audioEl.play().catch(() => {});
        };
        redo.onclick = async () => {
          if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; audioEl = null; }
          wavBytes = null;
          state = 'idle'; paint();
        };
        submit.onclick = () => doSubmit();
        ctl.appendChild(play); ctl.appendChild(redo); ctl.appendChild(submit); ctl.appendChild(timer);
      } else if (state === 'submitting') {
        btn.textContent = '⏳ 提交中…'; btn.disabled = true; btn.className = 'rec-btn';
        ctl.appendChild(btn); ctl.appendChild(timer);
      } else if (state === 'submitted') {
        const done = document.createElement('span'); done.className = 'rec-done';
        done.textContent = `✓ 已提交 · ${timer.textContent}`;
        ctl.appendChild(done);
      }
    };

    btn.onclick = async () => {
      if (state === 'idle') {
        // 探 whisper: 就算没装, 录音本身能做; 但提交后 audio 消息只有教师人格才用得上, 这里不阻塞
        try {
          await window.audioRecorder.start();
          state = 'recording'; paint();
          startTick();
        } catch (e) {
          alert('麦克风权限被拒或无设备: ' + (e && e.message || e));
        }
      } else if (state === 'recording') {
        stopTick();
        try {
          wavBytes = await window.audioRecorder.stop();
          if (!wavBytes || wavBytes.byteLength < 2000) {
            alert('录音太短, 请重试'); state = 'idle'; paint(); return;
          }
          const blob = new Blob([wavBytes], { type: 'audio/wav' });
          audioUrl = URL.createObjectURL(blob);
          state = 'recorded'; paint();
        } catch (e) {
          alert('录音失败: ' + (e && e.message || e));
          state = 'idle'; paint();
        }
      }
    };

    async function doSubmit() {
      if (!wavBytes) return;
      state = 'submitting'; paint();
      try {
        const r = await window.butler.saveAudio(sid, wavBytes);
        if (!r || !r.ok) { alert('保存失败: ' + (r && r.error || '未知')); state = 'recorded'; paint(); return; }
        // 注入到下一轮 user 消息: [audio:/path · 3.2s · lang=xx]
        const msg = `[audio:${r.path} · ${r.sec}s · lang=${lang}]`;
        state = 'submitted'; timer.textContent = `${r.sec}s`; paint();
        // 通过 window.butler.send 直发 (由 renderer.js 全局 emitUserMessage 挂到 window 供本 widget 用)
        if (typeof window.emitUserMessage === 'function') {
          window.emitUserMessage(sid, msg);
        } else {
          // 兜底: 若 emitUserMessage 缺失, 直接调 send API (跳过 UI 气泡渲染, 只走 IPC)
          window.butler.send(sid, { text: msg });
        }
      } catch (e) {
        alert('提交失败: ' + (e && e.message || e));
        state = 'recorded'; paint();
      }
    }

    paint();
  }

  window.recordWidget = { upgrade };
})();
