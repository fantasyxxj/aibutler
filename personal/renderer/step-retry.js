// step-retry.js — 断流重试时撤掉这一步已经流出去的半截字(作者 11-07)。
// 主进程发 assistant-step: start = 模型开始新的一步, 记下当前气泡写到了哪儿; discard = 引擎要重发这一步
// (api_retry 带 retry_delay_ms > 0, 见 core/agent/consume.js), 把气泡退回记下的位置, 重发的字从那儿接着写。
// 用 renderer.js 的 tabs / bodyOf, 排在它后面载入。
'use strict';

(function () {
  window.butler.onStep((sid, phase) => {
    const tab = tabs.get(sid);
    if (!tab) return;
    const b = tab.activeBubble;
    if (phase === 'start') { tab._stepMark = b ? { bubble: b, len: bodyOf(b).textContent.length } : { bubble: null }; return; }
    if (phase !== 'discard' || !b) return;
    const m = tab._stepMark || { bubble: null };
    const body = bodyOf(b);
    if (m.bubble === b) { body.textContent = body.textContent.slice(0, m.len); return; }
    // 这个气泡是这一步里才建的: 整个退回成「…」占位, 重发的正文照常往里写
    body.textContent = '…';
    b.classList.add('thinking');
  });
})();
