// ui-packages.js — 界面包(type: 'ui')的登记处。
//
// 工作流包(type: 'workflow')带的是"顺序 + 每步写什么", 引擎照着画。
// 界面包带的是**界面自己的代码** —— 它跑在沙箱里, 所以随便写多复杂都行
// (renderer/sandbox.js 那份注释是这件事的完整理由)。
//
// 这个文件只做三件事: 从落地的包里挑出 ui 类型 / 验形状 / 记在内存里给 renderer 取。
// 它**不碰沙箱也不碰界面** —— 校验用的是 sandbox.js 导出的同一个函数,
// 免得"主进程认为合格"和"沙箱认为合格"是两套标准。
'use strict';

const { uiCheck: sandbox } = require('./host');
const { pickLang } = require('./i18n-pick');

const REGISTRY = new Map();

const reset = () => REGISTRY.clear();
const get = (id) => REGISTRY.get(String(id)) || null;
const ids = () => Array.from(REGISTRY.keys());

// 给 renderer 的一份。html/css/js 原样带过去 —— 那些字节最后就是要进沙箱的。
const all = () => Array.from(REGISTRY.values());

/* 包名也要挑语言。视图和手顺的 title 早就是四语对象, 只有界面包还是字符串原样透传 ——
   店主切到中文, 包的内容全变中文, 目录上的名字却还是日语。挑法走 i18n-pick 那一份。 */
const pickTitle = (title, locale) => pickLang(title, locale);

function registerPackage(payload) {
  const bad = sandbox.checkUiPayload(payload);
  if (bad) return { ok: false, code: 'bad_ui', message: bad };
  const id = String(payload.id);
  REGISTRY.set(id, {
    id,
    version: payload.version || '',
    title: payload.title || id,
    // 认得的只有 'board' 一个值。别的一律当没写(随对话流) —— 拼错的字面量不该悄悄变成第三种行为。
    display: payload.display === 'board' ? 'board' : undefined,
    // 切界面语言时能不能推一条 {locale} 进去让它自己重画。不声明的宿主只能整个重挂, 会冲掉没保存的输入。
    locale_push: payload.locale_push === true || undefined,
    // 给人格读的说明跟包放在一起: summary 一句话(plugin_find 每条都带), usage 完整用法(要用时才读)。
    // keywords 供 plugin_find 按「要干什么」找到它。都可以是四语对象。
    summary: payload.summary || '',
    usage: payload.usage || '',
    keywords: payload.keywords || '',
    html: payload.html,
    css: payload.css || '',
    js: payload.js || '',
  });
  return { ok: true, id };
}

/* 装上所有已落地的界面包。all = packages.loadAll() 的结果。
   一个坏了不影响别的 —— 一片烂叶子让所有界面一起消失, 用户永远搞不清发生了什么。 */
function loadFromPackages(loaded) {
  const ok = [], failed = [];
  for (const p of (loaded && loaded.accepted) || []) {
    if (p.type !== 'ui') continue;
    const r = registerPackage(p);
    if (r.ok) ok.push({ id: p.id, version: p.version });
    else failed.push({ id: p.id, code: r.code, message: r.message });
  }
  return { loaded: ok, failed };
}

// 装了什么, 给 AI 看的一份清单 —— 它据此才知道自己能在回话里摆出哪些界面。
// 🔴 只给 id 和标题, **不给 html/js**: 界面的代码没有一个字该进模型的上下文,
// 那既是白烧的钱, 也是让 AI 有机会"照着改一份"的口子。
function summary(locale) {
  // display = 包自己声明的默认摆法(`board` = 钉常驻板 / 不写 = 随对话流走)。**摆法是包的属性, 不是调用方式**:
  // 「营业中一直点」(预约名单/待办板)还是「偶尔用一次」由写包的人知道, 让 AI 每次现猜, 猜错了也没人反馈。
  return all().map((p) => ({ id: p.id, title: pickTitle(p.title, locale), version: p.version, display: p.display,
    summary: pickLang(p.summary, locale) || '', usage: pickLang(p.usage, locale) || '', keywords: pickLang(p.keywords, locale) || '' }));
}

module.exports = { reset, get, ids, all, summary, pickTitle, registerPackage, loadFromPackages, _REGISTRY: REGISTRY };
