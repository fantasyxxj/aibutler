// path-marquee.js — 顶栏人格目录: 放得下就整条显示, 放不下就让路径在框里来回慢慢滚, 不截断也不挤折人格名。
// 用法: PathMarquee.set(el, text)。el 自己按 flex 分到的宽度量, 窗口一变宽窄就重算。
'use strict';

(function () {
  const CSS = `
.pmq { overflow: hidden; white-space: nowrap; min-width: 0; }
.pmq > span { display: inline-block; }
.pmq.run > span { animation: pmq-slide var(--pmq-dur, 8s) ease-in-out infinite alternate; }
@keyframes pmq-slide { 0%, 15% { transform: translateX(0); } 85%, 100% { transform: translateX(var(--pmq-shift)); } }
/* 窄到只剩几个字母时整条藏起来, 露半截路径比不露还难认 */
.pmq.tiny > span { visibility: hidden; }
@media (prefers-reduced-motion: reduce) { .pmq.run > span { animation: none; } }
`;
  let styled = false;
  const seen = new WeakSet();

  function fit(el) {
    const inner = el.firstElementChild;
    if (!inner) return;
    el.classList.toggle('tiny', el.clientWidth < 48);
    const over = inner.scrollWidth - el.clientWidth;
    if (over > 1) {
      el.style.setProperty('--pmq-shift', `-${over}px`);
      el.style.setProperty('--pmq-dur', `${Math.max(4, over / 25).toFixed(1)}s`);   // 约 25px/秒, 再短也给 4 秒
      el.classList.add('run');
    } else el.classList.remove('run');
  }

  function set(el, text) {
    if (!styled) { const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); styled = true; }
    el.classList.add('pmq');
    el.classList.remove('run');
    el.innerHTML = '';
    const inner = document.createElement('span');
    inner.textContent = text;
    el.appendChild(inner);
    if (!seen.has(el)) { seen.add(el); new ResizeObserver(() => fit(el)).observe(el); }
    requestAnimationFrame(() => fit(el));
  }

  window.PathMarquee = { set };
})();
