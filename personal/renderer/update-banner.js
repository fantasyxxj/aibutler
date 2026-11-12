// update-banner.js — 有新版时窗口顶上挂一行: 「有新版本 vX(当前 vY)· 下载 · 备用镜像 · 忽略这版」。
// 只提示, 人点了才去下载(作者 11-10 定)。查版本、开链接、记忽略都在主进程 personal/update-check.js。
// 文案四语与样式自带(同 reminder-banner.js)。依赖 renderer.js 的顶层: curLocale。
(function () {
  const L = {
    'zh-CN': { msg: '有新版本 v{v}(当前 v{c})', dl: '下载', mirror: '备用镜像', ignore: '忽略这版', tip: 'GitHub 下载慢的话点「备用镜像」' },
    'zh-TW': { msg: '有新版本 v{v}(目前 v{c})', dl: '下載', mirror: '備用鏡像', ignore: '略過這版', tip: 'GitHub 下載慢的話點「備用鏡像」' },
    ja: { msg: '新しいバージョン v{v} があります(現在 v{c})', dl: 'ダウンロード', mirror: 'ミラー', ignore: 'この版をスキップ', tip: 'GitHub が遅いときは「ミラー」' },
    en: { msg: 'New version v{v} is available (you have v{c})', dl: 'Download', mirror: 'Mirror', ignore: 'Skip this version', tip: 'If GitHub is slow, use Mirror' },
  };
  const s = () => L[curLocale] || L[String(curLocale || '').slice(0, 2)] || L.en;

  const css = document.createElement('style');
  css.textContent = '#updateBar{display:flex;align-items:center;gap:8px;padding:5px 14px;border-bottom:1px solid var(--line);border-left:3px solid var(--accent);background:var(--panel);color:var(--text);font-size:12px}'
    + '#updateBar[hidden]{display:none}'
    + '#updateBar .ub-text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '#updateBar button{flex:0 0 auto;padding:2px 10px;font-size:12px;border-radius:4px;border:1px solid var(--line);background:var(--panel-2);color:var(--text);cursor:pointer}'
    + '#updateBar button.ub-go{background:var(--accent);border-color:var(--accent);color:#1e1e28}';
  document.head.appendChild(css);

  const bar = document.createElement('div');
  bar.id = 'updateBar';
  bar.hidden = true;
  const anchor = document.getElementById('authBanner');
  anchor.parentNode.insertBefore(bar, anchor.nextSibling);

  let info = { latest: null };
  const btn = (cls, text, action) => {
    const b = document.createElement('button');
    b.className = cls; b.textContent = text;
    b.onclick = () => window.butler.updateAct({ action });
    return b;
  };

  function paint() {
    bar.textContent = '';
    bar.hidden = !info.latest;
    if (!info.latest) return;
    const S = s();
    const t = document.createElement('span');
    t.className = 'ub-text';
    t.textContent = `⬆️ ${S.msg.replace('{v}', info.latest).replace('{c}', info.current)}`;
    bar.appendChild(t);
    bar.appendChild(btn('ub-go', S.dl, 'download'));
    const m = btn('ub-mirror', S.mirror, 'mirror');
    m.title = S.tip;
    bar.appendChild(m);
    bar.appendChild(btn('ub-ign', S.ignore, 'ignore'));
  }

  window.butler.onUpdate((d) => { info = d || { latest: null }; paint(); });
  window.butler.updateGet().then((d) => { info = d || { latest: null }; paint(); }).catch(() => {});
  document.getElementById('lang').addEventListener('change', () => setTimeout(paint, 300));
})();
