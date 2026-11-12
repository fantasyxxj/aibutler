// data-dir-ui.js — 系统设置「高级 → 数据位置」: 显示路径 · 打开文件夹 · 搬到别处 · 清理旧数据(搬完重启后才露出)。
// 跟 settings-ui.js 同页加载, 直接用它的 t() / toast() / applyStrings()。搬家本身在主进程 personal/data-move.js:
// 这里点完会弹系统选目录框和确认框, 确认了 app 就重启, 下次启动先搬再起人格。

const DD = {
  path: document.getElementById('dd-path'),
  open: document.getElementById('dd-open'),
  move: document.getElementById('dd-move'),
  clean: document.getElementById('dd-clean'),
  state: document.getElementById('dd-state'),
};

async function ddRefresh() {
  const r = await window.butler.dataDirInfo().catch(() => null);
  if (!r) return;
  DD.path.textContent = r.dir;
  DD.move.disabled = !r.canMove;
  DD.clean.hidden = !r.oldDir;
  DD.clean.disabled = false;
  DD.clean.title = r.oldDir || '';
  DD.state.textContent = r.canMove ? '' : t('sys_datadir_dev');
}

DD.open.addEventListener('click', () => { window.butler.dataDirOpen().catch(() => {}); });
DD.move.addEventListener('click', async () => {
  DD.move.disabled = true;
  const r = await window.butler.dataDirMove().catch((e) => ({ ok: false, error: e && e.message }));
  if (r && !r.ok && r.error) toast(r.error === 'dev' ? t('sys_datadir_dev') : r.error);
  ddRefresh();
});
DD.clean.addEventListener('click', async () => {
  DD.clean.disabled = DD.move.disabled = true;   // 清理和搬家互斥, 主进程也拦
  await window.butler.dataDirCleanOld().catch(() => {});
  ddRefresh();
});

window.butler.onLocaleChanged && window.butler.onLocaleChanged(() => ddRefresh());
(async () => {
  try { applyStrings(await window.butler.getLocale()); } catch (_) {}
  ddRefresh();
})();
