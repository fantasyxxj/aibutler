// test-i18n.js — 界面语言。跑法: node test-i18n.js
//
// 这套门禁真正想守的是**回潮**, 不是"字典能不能取到值"。
// i18n 最典型的坏法是: 半年后加个新按钮, 顺手写死一句中文, 一切照常绿灯,
// 直到某个英语用户截图问"这是什么"。所以 [4][5] 两段是本文件的重点 ——
// 它们扫源码, 不许 index.html / renderer.js 里再出现没进字典的界面文案。
//
// [6] 用 jsdom 走真 DOM: 只断言字典有值不算数, 得看 applyStrings 之后
// 屏幕上的字**真的**换了。
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const i18n = require('./i18n');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

const CJK = /[一-鿿぀-ヿ]/;   // 汉字 + 假名

/* ─────────── [1] 字典键集四语一致 ─────────── */
console.log('\n[1] 四种语言的键必须完全一致');
{
  const locales = Object.keys(i18n.UI);
  // zh-TW 的表在 personal/i18n-zh-TW.js(i18n.js 已 1016 行, 行数门禁不许它再长), 挂进 UI 后一视同仁。
  ok(locales.length === 4, `支持 4 种语言: ${locales.join(' / ')}`);

  const base = Object.keys(i18n.UI['zh-CN']).sort();
  ok(base.length > 50, `zh-CN 有 ${base.length} 个键`);

  for (const l of locales) {
    const keys = Object.keys(i18n.UI[l]).sort();
    const missing = base.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !base.includes(k));
    ok(missing.length === 0, `${l} 不缺键${missing.length ? ' — 缺: ' + missing.join(',') : ''}`);
    ok(extra.length === 0, `${l} 没有多余键${extra.length ? ' — 多: ' + extra.join(',') : ''}`);
  }

  // 值为空 = 界面上那处会变成空白, 比不翻译还糟
  for (const l of locales) {
    const empty = Object.entries(i18n.UI[l]).filter(([, v]) => !String(v || '').trim()).map(([k]) => k);
    ok(empty.length === 0, `${l} 没有空值${empty.length ? ' — 空: ' + empty.join(',') : ''}`);
  }
}

/* ─────────── [2] 非中文字典里不许残留中日文 ─────────── */
console.log('\n[2] en 字典里不许漏翻(残留中日文就是漏了)');
{
  // lang_hint 例外: 语言切换入口本身必须双语 —— 界面被切成一门读不懂的语言时,
  // 用户要靠它切回来, 只写英文的话中文用户就找不着了。行业版同样做法。
  // firstrun_lang_title 例外同理且更甚: 那是**还没选语言**时的第一个框, 三种语言的人都得认得它。
  const BILINGUAL_ON_PURPOSE = new Set(['lang_hint', 'firstrun_lang_title']);
  const leftover = Object.entries(i18n.UI.en)
    .filter(([k, v]) => !BILINGUAL_ON_PURPOSE.has(k) && CJK.test(String(v))).map(([k]) => k);
  ok(leftover.length === 0, `en 无残留中日文${leftover.length ? ' — ' + leftover.join(',') : ''}`);
  ok(CJK.test(i18n.UI.en.lang_hint), 'lang_hint 刻意保持双语(切错语言也找得回来)');
  // 反向也守: 各份字典里这个标题必须**一模一样**且中英兼备。
  // 谁哪天顺手把某一份"翻译"了 → 不一致 → 红。(日文那半写作「言語」也是汉字,
  // 所以不能用假名判在不在, 只能判"各份同一串"。zh-TW 那份就差点被翻成「選擇語言」。)
  {
    const vals = Object.keys(i18n.UI).map((l) => String(i18n.UI[l].firstrun_lang_title || ''));
    ok(new Set(vals).size === 1, `首启语言框标题各份字典完全一致 — "${vals[0]}"`);
    ok(CJK.test(vals[0]) && /[A-Za-z]/.test(vals[0]), '首启语言框标题中英兼备(还没选语言, 谁都得认得)');
  }

  // ja 用汉字假名是正常的, 但简体字特有写法混进来就是抄漏了。抽查几个易错键。
  ok(!/管家|记忆|设置/.test(JSON.stringify(i18n.UI.ja)), 'ja 没混进简体中文词');
}

/* ─────────── [3] normalizeLocale / fmt ─────────── */
console.log('\n[3] 语言码归一 + 占位符');
{
  ok(i18n.normalizeLocale('zh-Hans-CN') === 'zh-CN', 'macOS 的 zh-Hans-CN → zh-CN');
  // 繁体不再寄到简体: zh-TW 自己有一份完整文案表了。
  // 🔴 字面检索不折叠简繁(繁体查询打不中简体库, 实测 0 命中), 所以这两个必须分开, 不能合并。
  ok(i18n.normalizeLocale('zh-TW') === 'zh-TW', 'zh-TW → zh-TW');
  ok(i18n.normalizeLocale('zh-Hant-TW') === 'zh-TW', 'zh-Hant-TW → zh-TW');
  ok(i18n.normalizeLocale('zh-HK') === 'zh-TW' && i18n.normalizeLocale('zh-MO') === 'zh-TW', '港澳也归繁体');
  ok(i18n.normalizeLocale('zh') === 'zh-CN' && i18n.normalizeLocale('zh-Hans-CN') === 'zh-CN', '裸 zh 与 Hans 仍归简体');
  ok(i18n.normalizeLocale('en-US') === 'en', 'en-US → en');
  ok(i18n.normalizeLocale('ja-JP') === 'ja', 'ja-JP → ja');
  ok(i18n.normalizeLocale('zh_CN') === 'zh-CN', '下划线写法也认');
  ok(i18n.normalizeLocale('ko') === null, '不支持的语言回 null, 由调用方决定默认');
  ok(i18n.normalizeLocale('') === null, '空值回 null');
  ok(i18n.normalizeLocale(undefined) === null, 'undefined 回 null');

  ok(i18n.uiStrings('ko') === i18n.UI['zh-CN'], '不认识的语言落到默认中文');
  ok(i18n.uiStrings('') === i18n.UI['zh-CN'], '没选过语言落到默认中文');
  ok(i18n.DEFAULT_LOCALE === 'zh-CN', '默认是中文(老用户装了新版不许被换语言)');

  ok(i18n.fmt('你好 {name}', { name: '作者' }) === '你好 作者', '占位符替换');
  ok(i18n.fmt('{a} 和 {b}', { a: '1', b: '2' }) === '1 和 2', '多个占位符');
  ok(i18n.fmt('缺 {who}', {}) === '缺 {who}', '没给值就原样留着(空字符串会让句子变得看不懂)');
  ok(i18n.fmt('', {}) === '', '空模板不炸');

  const ids = i18n.supportedUiLocales();
  ok(ids.every((x) => x.id && x.label), 'supportedUiLocales 每项都有 id + label');
  ok(ids.every((x) => i18n.UI[x.id]), '下拉里列出的语言都真有字典');
}

/* ─────────── [4] HTML 不许有脱离字典的界面中文 ─────────── */
// 主窗口(index.html) 和管理窗口(manager.html) 同一把尺子量:
// 管理面板 2026-08-13 才补上 i18n —— 当初只做主界面, 结果是"做了一半", 门禁不覆盖就会再半途而废。
console.log('\n[4] index.html / manager.html: 带中文的元素必须挂 data-i18n*');
for (const page of ['index.html', 'manager.html']) {
  const html = fs.readFileSync(path.join(__dirname, 'renderer', page), 'utf8');
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const offenders = [];
  for (const el of doc.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'TITLE'].includes(el.tagName)) continue;
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
    const hasText = CJK.test(own);
    const hasTitle = CJK.test(el.getAttribute('title') || '');
    const hasPh = CJK.test(el.getAttribute('placeholder') || '');
    // data-i18n-js = 文字由 JS 拼(图标+字典值), applyStrings 单独刷
    const managed = el.hasAttribute('data-i18n') || el.hasAttribute('data-i18n-js');
    if (hasText && !managed) offenders.push(`${el.tagName}#${el.id || '?'} 正文`);
    if (hasTitle && !el.hasAttribute('data-i18n-title')) offenders.push(`${el.tagName}#${el.id || '?'} title`);
    if (hasPh && !el.hasAttribute('data-i18n-ph')) offenders.push(`${el.tagName}#${el.id || '?'} placeholder`);
  }
  ok(offenders.length === 0, `${page}: 无脱管文案${offenders.length ? ' — ' + offenders.join(' | ') : ''}`);

  // 挂了属性但字典里没这个键 = 切完语言变空白
  const used = [];
  for (const el of doc.querySelectorAll('[data-i18n],[data-i18n-title],[data-i18n-ph],[data-i18n-js]')) {
    ['i18n', 'i18n-title', 'i18n-ph', 'i18n-js'].forEach((a) => {
      const k = el.getAttribute('data-' + a);
      if (k) used.push(k);
    });
  }
  const unknown = used.filter((k) => !(k in i18n.UI['zh-CN']));
  ok(used.length > 15, `${page}: 挂了 ${used.length} 处 data-i18n*`);
  ok(unknown.length === 0, `${page}: 引用的键都在字典里${unknown.length ? ' — 野键: ' + unknown.join(',') : ''}`);

  if (page === 'index.html') ok(/id="lang"/.test(html), '语言下拉存在(删了就没入口了)');
}

/* ─────────── [5] renderer 侧 JS 不许写死界面文案 ─────────── */
console.log('\n[5] renderer.js / manager.js: 字符串字面量里不许有中文');
for (const script of ['renderer.js', 'manager.js', 'settings-ui.js']) {
  const src = fs.readFileSync(path.join(__dirname, 'renderer', script), 'utf8');

  // 用 TypeScript 的 parser 走 AST, 不手写词法 —— 手写的版本会被正则字面量
  // (escapeHtml 里那串 /'/g) 带偏, 把后面的注释当成字符串报出来。
  // 注释里的中文照样随便写: 设计判断本来就该写清楚, 那不是界面文案。
  const ts = require('typescript');
  const sf = ts.createSourceFile(script, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const lits = [];
  const isTextLiteral = (n) => n.kind === ts.SyntaxKind.StringLiteral
    || n.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
    || n.kind === ts.SyntaxKind.TemplateHead
    || n.kind === ts.SyntaxKind.TemplateMiddle
    || n.kind === ts.SyntaxKind.TemplateTail;
  // console.* 的参数不算界面文案: 那是写给开发者看的, 用户永远看不到,
  // 强行翻译只会让排查问题时对不上日志。
  const inConsoleCall = (n) => {
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isCallExpression(p) && /^console\./.test(p.expression.getText(sf))) return true;
    }
    return false;
  };
  (function walk(node) {
    if (isTextLiteral(node) && CJK.test(node.text || '') && !inConsoleCall(node)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      lits.push(`L${line + 1}: ${String(node.text).slice(0, 40)}`);
    }
    ts.forEachChild(node, walk);
  })(sf);
  ok(lits.length === 0, `${script}: 无写死的界面文案${lits.length ? ` (${lits.length} 处) — ` + lits.slice(0, 6).join(' | ') : ''}`);

  // 反向: 确实在用字典, 而不是把文案挪去了别处
  ok((src.match(/\bt\(/g) || []).length > 30, `${script} 用了 ${(src.match(/\bt\(/g) || []).length} 处 t()`);
  ok(/function applyStrings/.test(src), `${script}: applyStrings 存在`);
  ok(/getLocale\(\)/.test(src), `${script}: 启动时拉语言`);
  ok(/onLocaleChanged/.test(src), `${script}: 监听别的窗口切语言`);
}

/* ─────────── [6] jsdom 真闭环: 切语言, 屏幕上的字真的换 ─────────── */
console.log('\n[6] 真 DOM: applyStrings 之后界面真的变了');
{
  const html = fs.readFileSync(path.join(__dirname, 'renderer', 'index.html'), 'utf8');
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // 只取 applyStrings 的那段逻辑放进真 DOM 跑(renderer.js 整只跑要 electron 的 window.butler)
  const box = { document: doc, window: dom.window, S: {}, cancelBtn: doc.getElementById('cancelBtn'),
                statusEl: doc.getElementById('statusbar'), _statusKey: 'idle', _statusOverride: null };
  vm.createContext(box);
  vm.runInContext(`
    const t = (k, vars) => { const v = S[k]; if (v == null) return '';
      return vars ? String(v).replace(/\\{(\\w+)\\}/g, (m,n)=> vars[n]!=null?String(vars[n]):m) : v; };
    function setStatus(state, text) {
      _statusKey = state || 'idle'; _statusOverride = text || null;
      const map = { idle: t('status_idle'), thinking: t('status_thinking'), tool: t('status_tool') };
      statusEl.textContent = text || map[_statusKey] || map.idle;
      statusEl.dataset.state = _statusKey;
    }
    function applyStrings(payload) {
      S = (payload && payload.strings) || S;
      document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
      document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
      document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
      cancelBtn.textContent = '⏹ ' + t('cancel');
      setStatus(_statusKey, _statusOverride);
    }
  `, box);

  const sendBtn = doc.getElementById('sendBtn');
  const inputEl = doc.getElementById('input');
  const statusbar = doc.getElementById('statusbar');

  ok(sendBtn.textContent === '发送', '出厂那一帧是中文(主进程还没回话时的兜底)');

  box.applyStrings({ strings: i18n.UI.en });
  ok(sendBtn.textContent === 'Send', '切 en: 发送 → Send');
  ok(!CJK.test(inputEl.placeholder), '切 en: 输入框提示不再有中文');
  ok(statusbar.textContent === i18n.UI.en.status_idle, '切 en: 状态条跟着换(它是拼出来的, 最容易漏)');
  ok(doc.getElementById('compactBtn').title === i18n.UI.en.compact_hint, '切 en: title 也换');

  box.applyStrings({ strings: i18n.UI.ja });
  ok(sendBtn.textContent === '送信', '切 ja: → 送信');
  ok(doc.getElementById('cancelBtn').textContent === '⏹ キャンセル', '切 ja: 图标+文字拼的按钮也换');

  // 状态条停在非 idle 时切语言 —— idle 可以停几小时, 但 thinking 时切更容易露馅
  box.setStatus('thinking', null);
  box.applyStrings({ strings: i18n.UI.en });
  ok(statusbar.textContent === i18n.UI.en.status_thinking, 'thinking 状态下切语言, 状态条也跟着换');

  // 工具名是 AI 生成的实时文本, 不该被翻译表冲掉
  box.setStatus('tool', '🟡 Reading memory.js');
  box.applyStrings({ strings: i18n.UI.ja });
  ok(statusbar.textContent === '🟡 Reading memory.js', '切语言不冲掉 AI 生成的实时文本');

  box.applyStrings({ strings: i18n.UI['zh-CN'] });
  ok(sendBtn.textContent === '发送', '切回中文: → 发送');
}

/* ─────────── [7] manager.js 里 t() 引用的键都得真存在 ─────────── */
// 管理面板的文案大半是 innerHTML 拼出来的, 键写错不会报错, 只会渲染成空白格子。
console.log('\n[7] manager.js / renderer.js: t() 引用的键都在字典里');
{
  for (const script of ['manager.js', 'renderer.js', 'settings-ui.js']) {
    const src = fs.readFileSync(path.join(__dirname, 'renderer', script), 'utf8');
    const keys = [...src.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
    const unknown = [...new Set(keys)].filter((k) => !(k in i18n.UI['zh-CN']));
    ok(keys.length > 20, `${script}: 引用了 ${keys.length} 处 t('key')`);
    ok(unknown.length === 0, `${script}: 无野键${unknown.length ? ' — ' + unknown.join(',') : ''}`);
  }

  // 反向: 字典里的 mgr_*/sys_* 得真有人用, 否则就是改完界面留下的死键。
  // 扫全部窗口的源码 —— 少列一份文件, 那份文件用到的键就会被误判成死键(2026-08-17 加设置窗口时踩过)。
  const uiSrc = ['renderer/manager.js', 'renderer/manager.html', 'renderer/settings-ui.js', 'renderer/search-ui.js', 'renderer/cc-sdk-ui.js',
                 'renderer/settings.html', 'renderer/index.html', 'main.js', 'cc-sdk-boot.js']
    .map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
  for (const [prefix, min] of [['mgr_', 60], ['sys_', 20]]) {
    const keys = Object.keys(i18n.UI['zh-CN']).filter((k) => k.startsWith(prefix));
    const dead = keys.filter((k) => !uiSrc.includes(k));
    ok(keys.length > min, `字典里有 ${keys.length} 个 ${prefix}* 键`);
    ok(dead.length === 0, `没有没人用的 ${prefix}* 死键${dead.length ? ' — ' + dead.join(',') : ''}`);
  }
}

/* ─────────── [8] jsdom 真闭环: 管理面板切语言真的变 ─────────── */
console.log('\n[8] 真 DOM: 管理窗口 applyStrings 之后界面真的变了');
{
  const html = fs.readFileSync(path.join(__dirname, 'renderer', 'manager.html'), 'utf8');
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const box = { document: doc, S: {} };
  vm.createContext(box);
  vm.runInContext(`
    const t = (k, vars) => { const v = S[k]; if (v == null) return '';
      return vars ? String(v).replace(/\\{(\\w+)\\}/g, (m,n)=> vars[n]!=null?String(vars[n]):m) : v; };
    function applyStrings(payload) {
      S = (payload && payload.strings) || S;
      document.title = t('mgr_title');
      document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
      document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
      document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
    }
  `, box);

  const createBtn = doc.getElementById('f-create');
  const nameInput = doc.getElementById('f-name');
  const dirInput = doc.getElementById('f-dir');

  ok(createBtn.textContent === '创建并打开', '出厂那一帧是中文(主进程还没回话时的兜底)');

  box.applyStrings({ strings: i18n.UI.en });
  ok(createBtn.textContent === 'Create and open', '切 en: 创建并打开 → Create and open');
  ok(!CJK.test(nameInput.placeholder), '切 en: 名字输入框提示不再有中文');
  ok(!CJK.test(dirInput.placeholder), '切 en: 目录输入框提示不再有中文');
  ok(doc.title === i18n.UI.en.mgr_title, '切 en: 窗口标题也换(它不在 data-i18n 里, 最容易漏)');

  // 整屏扫一遍: 有没有哪个角落还留着中文
  const leftover = [];
  for (const el of doc.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'TITLE'].includes(el.tagName)) continue;
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
    if (CJK.test(own)) leftover.push(el.tagName + '#' + (el.id || '?'));
    if (CJK.test(el.getAttribute('placeholder') || '')) leftover.push(el.tagName + '#' + (el.id || '?') + '[ph]');
  }
  ok(leftover.length === 0, `切 en 后整屏无残留中文${leftover.length ? ' — ' + leftover.join(' | ') : ''}`);

  box.applyStrings({ strings: i18n.UI.ja });
  ok(createBtn.textContent === '作成して開く', '切 ja: → 作成して開く');
  ok(doc.title === i18n.UI.ja.mgr_title, '切 ja: 窗口标题也换');

  box.applyStrings({ strings: i18n.UI['zh-CN'] });
  ok(createBtn.textContent === '创建并打开', '切回中文: → 创建并打开');
}

/* ─────────── [9] 首启语言选择: 弹框前的判断 ─────────── */
// 弹框本身测不了(要 electron), 所以判断全抽进了纯函数 firstRunLanguageChoices。
console.log('\n[9] 首启语言屏: OS 语言 → 默认反转在哪个按钮');
{
  const c = i18n.firstRunLanguageChoices('zh-CN');
  ok(c.ids.length === 4 && c.labels.length === 4, `4 个按钮: ${c.labels.join(' / ')}`);
  // 选语言的界面不需要翻译 —— 每种语言用自己的文字写自己的名字
  ok(c.labels.every((l) => !/^[a-z-]+$/i.test(l) || l === 'English'),
     '按钮上是语言自己的名字, 不是 locale 代码');
  ok(!CJK.test('English') && c.labels.includes('English'), 'English 用拉丁字母自称');

  const guessOf = (osLocale) => i18n.firstRunLanguageChoices(osLocale).guess;
  ok(guessOf('en-US') === 'en', 'en-US → en');
  ok(guessOf('ja-JP') === 'ja', 'ja-JP → ja');
  ok(guessOf('zh-Hans-CN') === 'zh-CN', 'zh-Hans-CN → zh-CN');
  ok(guessOf('zh-Hant-TW') === 'zh-TW', 'zh-Hant-TW → zh-TW(繁体已有自己那份, 不再寄简体)');
  ok(guessOf('th-TH') === i18n.DEFAULT_LOCALE, `泰语等不支持的 → 默认 ${i18n.DEFAULT_LOCALE}`);
  ok(guessOf('') === i18n.DEFAULT_LOCALE, '空 locale → 默认');
  ok(guessOf(undefined) === i18n.DEFAULT_LOCALE, 'undefined → 默认(取不到 OS 语言也不能崩)');

  // 默认反转的按钮必须就是猜中的那个 —— 猜对的人一个回车就过去了
  for (const osl of ['en-US', 'ja-JP', 'zh-CN', 'th-TH']) {
    const r = i18n.firstRunLanguageChoices(osl);
    ok(r.ids[r.defaultIndex] === r.guess, `${osl}: 默认按钮落在 ${r.guess} 上`);
  }
}

/* ─────────── [10] 首启三步的先后顺序 ─────────── */
// 🔴 顺序错了**不会报错**, 只是设置静默丢失: settings.json 住在 dataDir()/app/ 下,
// 数据目录是第二步才定的 —— 语言在第一步就落盘 = 写进默认位, 用户接着自选了别的文件夹,
// 那份设置就成了孤儿, 重启读不回来。所以这条只能靠门禁守。
console.log('\n[10] 首启三步: 问语言 → 选目录 → 才落盘');
{
  // 两个框 2026-09-23 从 main.js 搬进了 first-run.js(那份只许改不许长), 调用点还在 main.js。
  const src = fs.readFileSync(path.join(__dirname, 'first-run.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const at = (re) => src.search(re);

  const iLang = at(/const locale = chooseLanguage\(\)/);
  const iDir = at(/\n  chooseDataDir\(locale\)/);
  const iRun = main.search(/const firstRunLocale = require\('\.\/first-run'\)\.run\(\)/);
  const iSave = main.search(/settings\.write\(\{ language: firstRunLocale \}\)/);

  ok(iLang > 0, '① chooseLanguage() 有被调用');
  ok(iDir > 0, '② chooseDataDir(locale) 有被调用');
  ok(iSave > 0, '③ settings.write({ language }) 有被调用');
  ok(iLang < iDir, '语言问在选目录之前(后面两个框都要用它显示)');
  ok(iRun > 0 && iRun < iSave, '🔴 落盘排在选目录之后(否则设置写进默认位, 用户自选了别处就成孤儿)');

  // 数据目录那个框曾经是硬编码中文的(英语用户装上第一眼就是中文)。它在 createWindow 之前,
  // 不走 renderer 的 data-i18n 扫描 → [4][5] 扫不到它, 只能在这儿守。
  // 找**会出现在屏幕上**的中文字面量: 注释是给我们看的、console 是给日志看的, 都不算。
  const uiLiterals = (code) => code.split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))            // 行尾注释(这两个函数体里没有带 // 的字符串)
    .filter((l) => !/^\s*[*/]/.test(l))              // 块注释
    .filter((l) => !/console\.(log|error|warn)/.test(l))
    .flatMap((l) => l.match(/'[^']*'|"[^"]*"/g) || [])
    .filter((s) => CJK.test(s));

  const dirFn = src.slice(at(/function chooseDataDir/), at(/两步一趟跑完/));
  ok(dirFn.length > 200, '截到了 chooseDataDir 函数体');
  const dirHard = uiLiterals(dirFn);
  ok(dirHard.length === 0,
     `数据目录框里没有硬编码中文文案${dirHard.length ? ' — ' + dirHard.join(' | ') : ''}`);
  ok(/i18n\.uiStrings\(locale\)/.test(dirFn), '数据目录框用的是上一步选的语言');

  // 语言框自己也一样: 它比 uiStrings 还早, 用的是 OS 猜测值
  const langFn = src.slice(at(/function chooseLanguage/), at(/② 让用户选数据保存位置/));
  const langHard = uiLiterals(langFn);
  ok(langHard.length === 0,
     `语言框里没有硬编码中文文案${langHard.length ? ' — ' + langHard.join(' | ') : ''}`);
  ok(/i18n\.uiStrings\(c\.guess\)/.test(langFn), '语言框用 OS 猜测值渲染(此刻还没人选过语言)');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} i18n: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
