// cc-sdk-ui.js — 系统设置里的「Claude 订阅」区块(给有订阅的人的彩蛋)。
// 跟 settings-ui.js 同页加载, 直接用它的 t() / toast() / applyStrings()。下载与存放见 core/cc-sdk-install.js。
// 开启 / 关闭都要重启才算数, 所以状态分「开没开」(enabled)和「这次启动加载了没有」(ccAvailable)两层。
// 关闭和删除分开: 关闭后再单独问删不删下载的文件, 用户确认才删(作者 2026-11-05 定)。

const CC = {
  form: document.getElementById('cc-form'),
  state: document.getElementById('cc-state'),
  on: document.getElementById('cc-on'),
  off: document.getElementById('cc-off'),
  login: document.getElementById('cc-login'),
  relaunch: document.getElementById('cc-relaunch'),
  subtok: document.getElementById('st-form'),
};
let _ccLast = null;
let _ccProg = null;   // 正在下载时的进度文案

function ccRender(d) {
  if (d) _ccLast = d;
  const s = _ccLast; if (!s) return;
  // 订阅长效 token 只对能跑订阅的这次启动有意义
  CC.subtok.style.display = s.loaded ? '' : 'none';
  if (!s.applicable) { CC.form.style.display = 'none'; return; }
  CC.form.style.display = '';
  let key, btn;
  if (s.installing || _ccProg) { key = null; btn = null; }
  else if (s.enabled && !s.loaded) { key = 'sys_cc_need_relaunch'; btn = CC.relaunch; }
  else if (!s.enabled && s.loaded) { key = 'sys_cc_removed_relaunch'; btn = CC.relaunch; }
  else if (!s.enabled) { key = s.installed ? 'sys_cc_state_off_kept' : 'sys_cc_state_off'; btn = CC.on; }
  else if (!s.loggedIn) { key = 'sys_cc_state_need_login'; btn = CC.login; }
  else { key = 'sys_cc_state_ready'; btn = null; }
  CC.state.textContent = key ? t(key, { version: s.version }) : (_ccProg || t('sys_cc_downloading', { pct: 0 }));
  for (const b of [CC.on, CC.login, CC.relaunch]) b.style.display = b === btn ? '' : 'none';
  CC.off.style.display = s.enabled && !s.installing && !_ccProg ? '' : 'none';
}

async function ccRefresh() {
  try {
    const [st, cred] = await Promise.all([window.butler.ccSdkStatus(), window.butler.listCredentials()]);
    ccRender({ ...st, loaded: !(cred && cred.ccAvailable === false), loggedIn: !!(cred && cred.subLoggedIn) });
  } catch (e) { console.error('[settings] ccSdkStatus failed:', e && e.message); }
}

window.butler.onCcSdkProgress((p) => {
  _ccProg = p.step === 'extract' ? t('sys_cc_extracting') : t('sys_cc_downloading', { pct: p.step === 'bin' ? 10 + Math.floor(p.pct * 0.9) : Math.floor(p.pct * 0.1) });
  CC.state.textContent = _ccProg;
});

CC.on.addEventListener('click', async () => {
  // 文件还留着(之前关过没删)就不用再下载, 也不用再弹条款
  if (!(_ccLast && _ccLast.installed) && !confirm(t('sys_cc_confirm'))) return;
  _ccProg = t('sys_cc_downloading', { pct: 0 }); ccRender();
  const r = await window.butler.ccSdkInstall();
  _ccProg = null;
  if (!r || !r.ok) toast(t('sys_cc_failed', { err: (r && r.error) || '' }));
  ccRefresh();
});

CC.off.addEventListener('click', async () => {
  if (!confirm(t('sys_cc_off_confirm'))) return;
  const deleteFiles = confirm(t('sys_cc_delete_confirm'));
  const r = await window.butler.ccSdkDisable({ deleteFiles });
  if (!r || !r.ok) toast(t('sys_cc_failed', { err: (r && r.error) || '' }));
  ccRefresh();
});

CC.relaunch.addEventListener('click', () => window.butler.ccSdkRelaunch());

CC.login.addEventListener('click', async () => {
  CC.login.disabled = true;
  CC.state.textContent = t('relogin_browser');
  const r = await window.butler.relogin();
  CC.login.disabled = false;
  if (!r || !r.ok) toast(t('relogin_failed', { err: (r && r.error) || '' }));
  ccRefresh();
});

window.butler.onLocaleChanged && window.butler.onLocaleChanged(() => ccRender());
(async () => {
  // 状态条是 t() 拼的: 先确保文案到了再画
  try { applyStrings(await window.butler.getLocale()); } catch (_) {}
  ccRefresh();
})();
