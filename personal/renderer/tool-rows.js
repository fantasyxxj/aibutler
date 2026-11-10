// tool-rows.js — 对话里的工具调用条显不显示。默认藏(状态栏已显示正在跑的工具, 条目堆在对话里挡正文, 作者 11-09)。
// 只挂一个 class, 条目照常生成 —— 设置里打开, 已有的和以后的当场全显示回来。
(function () {
  const apply = (on) => document.body.classList.toggle('show-tools', !!on);
  window.butler.getToolRows().then((r) => apply(r && r.on)).catch(() => {});
  window.butler.onToolRowsChanged((d) => apply(d && d.on));
})();
