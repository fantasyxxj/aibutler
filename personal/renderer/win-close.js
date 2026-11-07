// win-close.js — 弹出窗口(系统设置 · 人格管理)右上角那颗看得见的「关闭」。
// 只有左上角红绿灯和 Esc 的话, 很多人不知道怎么退出, 全屏时红绿灯还会藏起来(作者 11-07)。
// 要排在各页自己的脚本前面载入: 按钮带 data-i18n, 由那一页的 applyStrings 跟着界面语言刷。
'use strict';
(function () {
  const b = document.createElement('button');
  b.type = 'button'; b.id = 'win-close'; b.className = 'm-btn';
  b.dataset.i18n = 'sys_close'; b.textContent = '关闭';
  b.style.cssText = 'position:fixed;top:14px;right:16px;z-index:50';
  b.addEventListener('click', () => window.close());
  document.body.prepend(b);
})();
