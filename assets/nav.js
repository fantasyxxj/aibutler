// nav.js — 官网顶栏菜单的唯一一份: 栏目、中英名、手机端 ☰ 菜单和样式都在这里。
// 窄屏(≤420px)顶栏放不下 GitHub 按钮, 改在下拉菜单末尾出一项。
// 页面里写 <nav></nav><script src="<到 assets 的相对路径>/nav.js"></script>, 同步执行, 当场填进前面那个 <nav>,
// 所以不会先空一下再出来。根目录按本文件自己的地址推(assets/ 的上一层), 语言看 <html lang>,
// 当前页看地址里是 /site/ 还是 /monologue/。加栏目、改名字只改下面 ITEMS。
(function () {
  var me = document.currentScript;
  var nav = me && me.previousElementSibling;
  if (!nav || nav.tagName !== 'NAV') return;
  var root = new URL('..', me.src).href;
  var en = /^en/i.test(document.documentElement.lang || '');
  var path = location.pathname;
  var onSite = /\/site\//.test(path);
  var page = /\/monologue\//.test(path) ? 'monologue' : onSite ? 'site' : '';

  // [锚点或路径, 中文, 英文]; 以 # 开头的是首页里的段落
  var ITEMS = [
    ['#ask', '说一句就行', 'Just ask'],
    ['#scenes', '用在哪', 'Use cases'],
    ['#memory', '它记得你', 'Memory'],
    ['#features', '功能', 'Features'],
    ['#tech', '技术', 'Tech'],
    [en ? 'docs/en/' : 'docs/', '使用文档', 'Docs'],
    ['monologue/', 'AI自话', 'AI Diary (中文)', 'monologue'],
  ];
  var home = root + 'site/' + (en ? 'en.html' : '');
  var href = function (h) { return h.charAt(0) === '#' ? (onSite ? h : home + h) : root + h; };

  var css = '' +
    'nav.sn{position:sticky;top:0;z-index:10;background:rgba(11,16,34,.78);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border-bottom:1px solid rgba(38,48,90,.6)}' +
    'nav.sn .in{display:flex;align-items:center;height:64px;gap:32px;max-width:1180px;margin:0 auto;padding:0 28px}' +
    'nav.sn .lg{font-weight:800;font-size:20px;letter-spacing:.3px;display:flex;align-items:center;gap:10px}' +
    'nav.sn .lg img{width:28px;height:28px;border-radius:7px;display:block;box-shadow:0 0 16px rgba(240,190,120,.35)}' +
    'nav.sn ul{display:flex;gap:26px;list-style:none;margin:0;padding:0;font-size:14.5px;color:#c3cbef;flex:1}' +
    'nav.sn ul a:hover,nav.sn ul a.on{color:#e6ebff}' +
    'nav.sn .lang{font-size:14px;font-weight:600;color:#c3cbef}nav.sn .lang:hover{color:#e6ebff}' +
    'nav.sn .gh{display:inline-flex;align-items:center;padding:8px 16px;border-radius:999px;font-weight:600;font-size:14px;border:1px solid #26305a;color:#e6ebff;transition:.2s}nav.sn .gh:hover{border-color:#7c8cff}' +
    'nav.sn .bg{display:none;width:40px;height:40px;margin-right:-8px;border:0;background:none;color:#e6ebff;font-size:22px;line-height:40px;cursor:pointer}' +
    '@media (max-width:960px){' +
      'nav.sn .in{gap:18px;padding:0 20px}nav.sn .lang{margin-left:auto}nav.sn .bg{display:block}' +
      'nav.sn ul{display:none;position:absolute;left:0;right:0;top:64px;flex-direction:column;gap:0;padding:6px 0 10px;background:rgba(11,16,34,.97);border-bottom:1px solid rgba(38,48,90,.6);font-size:16px}' +
      'nav.sn.open ul{display:flex}' +
      'nav.sn ul a{display:block;padding:12px 24px}' +
    '}' +
    'nav.sn ul .gx{display:none}' +
    '@media (max-width:420px){nav.sn .gh{display:none}nav.sn ul .gx{display:block}}';
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  var li = ITEMS.map(function (it) {
    var on = it[3] && it[3] === page ? ' class="on"' : '';
    return '<li><a' + on + ' href="' + href(it[0]) + '">' + (en ? it[2] : it[1]) + '</a></li>';
  }).join('') + '<li class="gx"><a href="https://github.com/fantasyxxj/aibutler">GitHub</a></li>';
  nav.className = 'sn';
  nav.innerHTML = '<div class="in">' +
    '<a class="lg" href="' + home + '"><img src="' + root + 'assets/logo.png" alt="">aibutler</a>' +
    '<ul>' + li + '</ul>' +
    '<a class="lang" href="' + root + 'site/' + (en ? '' : 'en.html') + '">' + (en ? '中文' : 'EN') + '</a>' +
    '<a class="gh" href="https://github.com/fantasyxxj/aibutler">GitHub</a>' +
    '<button class="bg" type="button" aria-label="' + (en ? 'Menu' : '菜单') + '" aria-expanded="false">☰</button>' +
    '</div>';

  var btn = nav.querySelector('.bg');
  var set = function (open) {
    nav.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.textContent = open ? '✕' : '☰';
  };
  btn.addEventListener('click', function () { set(!nav.classList.contains('open')); });
  nav.querySelector('ul').addEventListener('click', function (e) { if (e.target.closest('a')) set(false); });
  document.addEventListener('click', function (e) { if (!nav.contains(e.target)) set(false); });
})();
