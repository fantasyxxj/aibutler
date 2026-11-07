// settings-tabs.js — 系统设置分组: 通用 · 模型服务 · 工具 · 高级。每块 .m-form 带 data-group, 这里只管切。
// 「Claude 订阅」那块(#cc-form)由 cc-sdk-ui.js 决定显不显示, 所以隐藏用 hidden 属性, 不碰它的 style.display。
(() => {
  const bar = document.querySelector('.sys-tabs');
  const show = (g) => {
    bar.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.group === g));
    document.querySelectorAll('.m-form[data-group]').forEach((f) => { f.hidden = f.dataset.group !== g; });
  };
  bar.addEventListener('click', (e) => { const b = e.target.closest('button[data-group]'); if (b) show(b.dataset.group); });
  // 首启屏「去添加 Key」带 group=models 进来, 直接停在加 key 那一页
  const want = new URLSearchParams(location.search).get('group');
  show(want && bar.querySelector(`button[data-group="${want}"]`) ? want : 'general');
  if (window.butler && window.butler.onSettingsGroup) window.butler.onSettingsGroup((g) => { if (bar.querySelector(`button[data-group="${g}"]`)) show(g); });
})();
