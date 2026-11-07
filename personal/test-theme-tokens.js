// 深浅主题 token 回归: theme.css 两套同名、样式里引用的变量都有定义、插件沙箱与 theme.css 同值、外观设置接上了。
const fs = require('fs');
const path = require('path');
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const R = (f) => fs.readFileSync(path.join(__dirname, 'renderer', f), 'utf8');
const vars = (blk) => Object.fromEntries([...blk.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

const css = R('theme.css');
const li = css.indexOf('@media (prefers-color-scheme: light)');
ok(li > 0, 'theme.css 有浅色媒体查询');
const dark = vars(css.slice(0, li)), light = vars(css.slice(li));
const colorKeys = Object.keys(dark).filter((k) => !k.startsWith('--radius') && !/^['"]/.test(dark[k]));   // 圆角与文字串(如 --tool-done-label)不分深浅
ok(colorKeys.every((k) => k in light), '🔴 深色里每个颜色 token 浅色都有一份(缺了浅色下就落回深色值)');

// 引用了没定义的变量不报错, 只是取不到值 —— sediment 卡片原先写 var(--fg) 就是这样一直落在兜底色上
const defined = new Set(Object.keys(dark));
for (const f of ['style.css', 'settings.html', 'manager.js', 'settings-ui.js', 'renderer.js', 'image-save.js', 'hub-firstrun.js', 'empty-state.js', 'persona-card.js', 'persona-card.css', 'edit-tabs.js', 'channel-cards.js']) {
  const used = [...R(f).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
  const bad = [...new Set(used.filter((v) => !defined.has(v)))];
  ok(!bad.length, `${f} 引用的变量都在 theme.css 里定义` + (bad.length ? ': 缺 ' + bad.join(' ') : ''));
}

// 彩色底上的字要自己定色: 继承来的 var(--text) 深色时碰巧是白字, 浅色下就成了蓝底黑字 —— 管理窗「创建并打开」就是这么看不清的
const tinted = /background(?:-color)?:\s*var\(--(brand|user|danger|ok|accent|warn)\)/;
const tintSrc = { 'style.css': R('style.css'), 'persona-card.css': R('persona-card.css'), 'hub-firstrun.js': R('hub-firstrun.js'), 'empty-state.js': R('empty-state.js'), 'reminder-banner.js': R('reminder-banner.js'), 'todo.json': fs.readFileSync(path.join(__dirname, '..', 'core', 'config', 'plugins', 'todo.json'), 'utf8') };
for (const [f, src] of Object.entries(tintSrc)) {
  const bad = [...src.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .filter(([, sel, d]) => tinted.test(d) && !/:hover|dot|badge/.test(sel) && !/(^|[;{\s])color:\s*(#[0-9a-f]{3,8}|var\(--panel\))/i.test(d))
    .map(([, sel]) => sel.trim().split(/['+]/).pop().trim());
  ok(!bad.length, `${f} 彩色底的规则都定了字色` + (bad.length ? ': ' + bad.join(' | ') : ''));
}

const sb = R('sandbox.js');
const sd = vars((sb.match(/THEME_DARK = '([^']+)'/) || [])[1] || '');
const sl = vars((sb.match(/THEME_LIGHT = '([^']+)'/) || [])[1] || '');
ok(Object.keys(sd).length >= 15 && Object.entries(sd).every(([k, v]) => dark[k] === v), '🔴 插件沙箱深色 token 与 theme.css 同值');
ok(Object.keys(sl).length >= 15 && Object.entries(sl).every(([k, v]) => light[k] === v), '🔴 插件沙箱浅色 token 与 theme.css 同值');
ok(/prefers-color-scheme: light\)\{:root\{color-scheme:light;' \+ THEME_LIGHT/.test(sb), '沙箱 iframe 自己带媒体查询(开着的插件切主题当场跟着变)');

// 删样式块删出一个多余的 } 不报错, 只是后面整片规则失效、布局当场错乱
for (const f of ['theme.css', 'style.css', 'persona-card.css']) { const c = R(f).replace(/\/\*[\s\S]*?\*\//g, ''); ok((c.match(/{/g) || []).length === (c.match(/}/g) || []).length, `${f} 花括号配平`); }

for (const f of ['index.html', 'manager.html', 'settings.html']) ok(/href="theme\.css"[\s\S]*href="style\.css"/.test(R(f)), `${f} 先引 theme.css 再引 style.css`);
const ipc = fs.readFileSync(path.join(__dirname, 'theme-ipc.js'), 'utf8');
ok(/nativeTheme\.themeSource = m/.test(ipc), '主题落到 nativeTheme.themeSource');
ok(/require\('\.\/theme-ipc'\)/.test(fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')), 'main.js 接上 theme-ipc');
ok(/id="themeSeg"/.test(R('settings.html')) && /setTheme\(/.test(R('settings-ui.js')), '系统设置里有外观三选一');

if (fails) { console.log(`\n✗ ${fails} 项失败`); process.exit(1); }
console.log('\n✓ 主题 token 全部通过');
