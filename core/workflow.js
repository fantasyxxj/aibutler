// workflow.js — 多步插件的调用引擎, **两版共用一份**。
//
// 单页插件一屏出完; 多步插件有多屏, 需要有人管「现在第几屏 · 翻到哪屏 · 什么时候算走完」。
// 解决的是: 「读一步就跟 AI 说一声『下一步』」。18 步用对话走是 18 个来回, 用按钮走是 0 个 ——
// 下一屏在**这台机器里**拼好当场换上, AI 一次都不叫。省 token 只是顺带的;
// 真正拿到的是「按同一个地方必出同一屏」这种可预期性。
//
// 🔴 定义从**签名包**里来, 而包里只能是数据。这条界线不是洁癖: 包是从外面进来的东西,
// 一旦能带函数, 「验签」就从「证明这份内容没被改过」退化成「允许别人在你机器上跑代码,
// 只不过跑之前先看一眼是谁给的」。作者 2026-08-12 定过同一件事的另一面: 按钮再复杂
// 也不开脚本口子 —— 要 AI 干活就用 {{btn:}} 给它一句话, 那条路本来就通。
// 宿主要往屏里塞现算的值或走完之后报个信, 走 registerPackage 的 fills / finish 两个口子。
//
// 引擎只知道顺序和怎么画。它不知道这是在配 LINE 还是在给孩子上课 ——
// 判据只有一条: 装第二个工作流时, 这个文件一行都不用改。
'use strict';

// 界面文案表由宿主注入(两版各有各的语言架构), core 不内嵌任何一版的文案。
const { i18n } = require('./host');
const uiStrings = (...a) => i18n.uiStrings(...a);

/* 工作流定义:
     stepIds : 顺序(这个数组的次序是唯一真相)
     body    : (stepId, opts) => markdown  一步的内容。**不含导航** ——
               让每步自己写导航, 以后要改就得改 N 遍
     mark    : (stepId, status) => void     进度印(可选)
     finish  : (ctx, opts) => Promise<{message}> 走完最后一步(可选)
     status  : () => { doneCount, total }   进度显示用(可选) */
const REGISTRY = new Map();

function register(id, def) {
  if (!id) throw new Error('workflow: 缺少 id');
  if (!def || !Array.isArray(def.stepIds) || !def.stepIds.length) {
    throw new Error(`workflow ${id}: 缺少 stepIds`);
  }
  if (typeof def.body !== 'function') throw new Error(`workflow ${id}: 缺少 body(stepId, opts)`);
  REGISTRY.set(id, def);
}

const get = (id) => REGISTRY.get(id) || null;
const ids = () => Array.from(REGISTRY.keys());
const has = (wfId, stepId) => {
  const wf = get(wfId);
  return !!wf && wf.stepIds.includes(stepId);
};
const reset = () => REGISTRY.clear();

/* 按钮上的字会原样进 {{cmd:…|label=…}}。规格用 | 切分, 字里混进 | 或 }}
   会让**按钮无声地烂掉**(只剩一段点不动的文字)。四国语文案是我们自己写的, 实际不会混进去,
   但等到在屏幕上发现就太晚了。 */
function safeLabel(s, where) {
  const t = String(s == null ? '' : s);
  if (!t) throw new Error(`workflow: ${where} 的按钮文字是空的`);
  if (t.includes('|') || t.includes('}}')) {
    throw new Error(`workflow: ${where} 的按钮文字里不能有 | 或 }}: ${t}`);
  }
  return t;
}

const cmd = (spec) => `{{cmd:${spec}}}`;

/* 把一步变成「一屏」= 内容 + 导航。
   导航形状: 每屏至少两个(返回 / 下一步), 最后一屏是「全部完成」。 */
function view(wfId, stepId, opts = {}) {
  const wf = get(wfId);
  if (!wf) return null;
  const i = wf.stepIds.indexOf(stepId);
  if (i < 0) return null;

  const locale = opts.locale || i18n.DEFAULT_LOCALE;
  const S = uiStrings(locale);
  const body = wf.body(stepId, { ...opts, locale });
  if (body == null) return null;

  const prev = i > 0 ? wf.stepIds[i - 1] : null;
  const next = i + 1 < wf.stepIds.length ? wf.stepIds[i + 1] : null;

  const nav = [];
  // 返回不碰进度印。往回翻一眼就把「做了/跳过」改掉, 是最难查的一类错。
  if (prev) nav.push(cmd(`wf_go|wf=${wfId}|to=${prev}|label=${safeLabel(S.wf_back, 'wf_back')}`));
  if (next) {
    nav.push(cmd(`wf_go|wf=${wfId}|to=${next}|from=${stepId}|mark=done|label=${safeLabel(S.wf_next, 'wf_next')}`));
    // 跳过的事实要留下 —— 跟「做了」共用一个空白, 出问题时就没地方可疑了。
    nav.push(cmd(`wf_go|wf=${wfId}|to=${next}|from=${stepId}|mark=skipped|label=${safeLabel(S.wf_skip, 'wf_skip')}`));
  } else {
    nav.push(cmd(`wf_finish|wf=${wfId}|from=${stepId}|label=${safeLabel(S.wf_finish, 'wf_finish')}`));
  }

  // 没有「现在第几屏 / 还剩几屏」, 人就是在一个看不到头的东西上一直点。
  const counter = String(S.wf_progress || '{i} / {n}')
    .replace('{i}', String(i + 1)).replace('{n}', String(wf.stepIds.length));

  return [body, '', '---', '', `${counter}　${nav.join(' ')}`].join('\n');
}

/* Where an entry button with no `to` lands: the first step not yet done.
   The engine owns the progress, so it resolves the landing itself instead of
   having the AI look it up and hand the answer back — a round trip that costs a
   tool call and can be got wrong. Everything done (or no progress wired) → first step. */
function resumePoint(wf) {
  const snap = typeof wf.status === 'function' ? wf.status() : null;
  return (snap && snap.resumeAt) || wf.stepIds[0];
}

/* 按钮被按了。返回的 render 会原地换掉那一屏。
   这里**不过 AI** —— 过了就是 18 步 18 次计费, 而且多出「按了却出别的屏」的余地。 */
function go(wfId, { to, from, mark } = {}, opts = {}) {
  const wf = get(wfId);
  if (!wf) return { ok: false, code: 'unknown_workflow', message: `未知的工作流: ${wfId}` };
  const target = to || resumePoint(wf);
  if (!wf.stepIds.includes(target)) {
    return { ok: false, code: 'unknown_step', message: `${wfId}: 未知的一步 ${target}` };
  }
  // 印是「按的人, 给他正看着的那一步」打的。from 不在顺序里说明调用写错了 ——
  // 闷头往下走的话, 就只有进度永远填不满, 而没人知道为什么。
  if (mark) {
    if (!wf.stepIds.includes(from)) {
      return { ok: false, code: 'unknown_step', message: `${wfId}: 未知的一步 ${from}` };
    }
    if (typeof wf.mark === 'function') wf.mark(from, mark);
  }
  const render = view(wfId, target, opts);
  if (render == null) return { ok: false, code: 'render_failed', message: `${wfId}: 画不出 ${target}` };
  return { ok: true, render, step: target, message: '' };
}

/* 最后一步。个人版这边没有「我们的平台」, 所以默认就到此为止 ——
   包自己也报不了信(它只有数据), 所以 finish 只能是宿主给的。 */
async function finish(wfId, { from } = {}, ctx = {}, opts = {}) {
  const wf = get(wfId);
  if (!wf) return { ok: false, code: 'unknown_workflow', message: `未知的工作流: ${wfId}` };
  if (from) {
    if (!wf.stepIds.includes(from)) {
      return { ok: false, code: 'unknown_step', message: `${wfId}: 未知的一步 ${from}` };
    }
    if (typeof wf.mark === 'function') wf.mark(from, 'done');
  }
  const S = uiStrings(opts.locale || i18n.DEFAULT_LOCALE);
  if (typeof wf.finish !== 'function') return { ok: true, message: S.wf_done || 'ok' };
  const r = await wf.finish(ctx, opts);
  return { ok: true, ...(r || {}), message: (r && r.message) || S.wf_done || 'ok' };
}

/* ── 声明式(包)那一侧 ── */

// 一段文字可以是一根字符串, 也可以是 { 'zh-CN': …, ja: …, en: … }。
// 找不到当前语言就退到默认语言, 再退到包里有的第一种 —— 宁可给人看到别的语言,
// 也不能给一屏空白: 空白是没法自己诊断的, 看到日文至少知道是包没翻译。
function textFor(v, locale) {
  if (typeof v === 'string') return v;
  if (!v || typeof v !== 'object') return null;
  const pick = v[locale] || v[i18n.DEFAULT_LOCALE];
  if (typeof pick === 'string' && pick) return pick;
  for (const k of Object.keys(v)) {
    if (typeof v[k] === 'string' && v[k]) return v[k];
  }
  return null;
}

// 两种占位符填充。缺值就把**整行**丢掉 —— 屏幕上留一个没换掉的 `{token}` 或半张图,
// 对方只会照着念; 少一行至少看得出这里缺东西。
// assets 是包自带的图/文件, fills 是宿主现算的值(webhook 地址之类, 包里写不死)。
function assetText(md, assets) {
  if (!md || !md.includes('{{asset:')) return md;
  return String(md).split('\n').filter((line) => {
    let ok = true;
    line.replace(/\{\{asset:([^}]+)\}\}/g, (m, k) => { if (!(assets || {})[k]) ok = false; return m; });
    return ok;
  }).map((line) => line.replace(/\{\{asset:([^}]+)\}\}/g, (m, k) => (assets || {})[k] || m)).join('\n');
}

function fillText(md, fills) {
  if (!md || !/\{\w+\}/.test(md)) return md;
  return String(md).split('\n').filter((line) => {
    let ok = true;
    line.replace(/\{(\w+)\}/g, (m, k) => { if (!(fills || {})[k]) ok = false; return m; });
    return ok;
  }).map((line) => line.replace(/\{(\w+)\}/g, (m, k) => (fills || {})[k] || m)).join('\n');
}

// 进度快照 → 给 AI 读的一段话。跳过的步骤单独点名: 那是"后来接不上"最常见的原因。
function progressText(wfId, snap) {
  if (!snap || (!snap.doneCount && !(snap.skippedIds || []).length)) {
    return `${wfId}: not started yet (the user has not taken a step).`;
  }
  const lines = [`${wfId}: ${snap.doneCount}/${snap.total} done`
    + (snap.updatedAt ? ` · last activity ${snap.updatedAt}` : '')];
  if (snap.finished) lines.push('The user side is **all finished**. What is left is the service provider\'s configuration.');
  else if (snap.resumeAt) lines.push(`current step: ${snap.resumeAt}`);
  if ((snap.skippedIds || []).length) {
    lines.push(`**skipped step(s)**: ${snap.skippedIds.join(' · ')} —— these often cause things not to link up.`);
  }
  return lines.join('\n');
}

const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/* 包的形状校验。这里**宁可啰嗦** —— 包是签过名的, 所以走到这一步内容一定是我们出的,
   那么形状错了就一定是我们自己写错了, 越早在屏幕上喊出来越省事。
   反过来: 校验不过就整个不装(见 loadFromPackages), 不留半个能翻两屏的残疾工作流。 */
function checkWorkflowPayload(p) {
  if (!p || typeof p !== 'object') return '包是空的';
  if (!Array.isArray(p.steps) || !p.steps.length) return 'steps 是空的';
  const seen = new Set();
  for (let i = 0; i < p.steps.length; i++) {
    const s = p.steps[i];
    if (!s || typeof s !== 'object') return `第 ${i + 1} 步不是一个对象`;
    if (!STEP_ID.test(String(s.id || ''))) return `第 ${i + 1} 步的 id 不合法: ${s.id}`;
    if (seen.has(s.id)) return `一步的 id 重复了: ${s.id}`;
    seen.add(s.id);
    // 每种语言各查一遍。只查"当前语言画得出来"的话, 用户切一次语言才发现某步是空的。
    if (!textFor(s.md, i18n.DEFAULT_LOCALE)) return `第 ${i + 1} 步 (${s.id}) 没有内容 md`;
  }
  return null;
}

/* 把一个签名包装成引擎认识的定义。progress 由宿主注入 ——
   引擎不碰盘, 包也碰不到盘(它只有数据)。 */
// fills 是宿主现算的填空值(可以给函数, 每次翻屏现取), finish 是走完最后一步后宿主要做的事
// (个人版这边没有"我们的平台"所以通常不给; 行业版拿它去报状态给管理平台)。
// 包里只有数据, 这两样都只能由宿主递进来。
function registerPackage(payload, { progress, fills, finish } = {}) {
  const bad = checkWorkflowPayload(payload);
  if (bad) return { ok: false, code: 'bad_workflow', message: bad };

  const wfId = payload.id;
  const byId = new Map(payload.steps.map((s) => [s.id, s]));
  register(wfId, {
    stepIds: payload.steps.map((s) => s.id),
    body: (stepId, opts) => fillText(
      assetText(textFor((byId.get(stepId) || {}).md, (opts || {}).locale || i18n.DEFAULT_LOCALE),
                payload.assets),
      typeof fills === 'function' ? fills() : fills),
    mark: progress ? (stepId, status) => progress.mark(wfId, stepId, status) : undefined,
    status: progress ? () => progress.snapshot(wfId, payload.steps.map((s) => s.id)) : undefined,
    finish: typeof finish === 'function' ? (ctx, opts) => finish(wfId, ctx, opts) : undefined,
    title: payload.title,
    version: payload.version,
  });
  return { ok: true, id: wfId, steps: payload.steps.length };
}

/* 装上所有已落地的工作流包。all = packages.loadAll() 的结果。
   一个坏了不影响别的 —— 一片烂叶子让所有手顺一起消失, 用户是永远搞不清发生了什么的。 */
function loadFromPackages(all, { progress, fills, finish } = {}) {
  const loaded = [], failed = [];
  for (const p of (all && all.accepted) || []) {
    if (p.type !== 'workflow') continue;
    const r = registerPackage(p, { progress, fills, finish });
    if (r.ok) loaded.push({ id: p.id, version: p.version, steps: r.steps });
    else failed.push({ id: p.id, code: r.code, message: r.message });
  }
  return { loaded, failed };
}

// 装了什么, 给 AI 看的一份清单(它据此才能开口引出第一屏)。
function summary(locale) {
  return ids().map((id) => {
    const wf = get(id);
    return {
      id,
      title: textFor(wf.title, locale || i18n.DEFAULT_LOCALE) || id,
      firstStep: wf.stepIds[0],
      total: wf.stepIds.length,
    };
  });
}

module.exports = {
  register, get, ids, has, view, go, finish, safeLabel, reset,
  registerPackage, loadFromPackages, checkWorkflowPayload, textFor, summary,
  fillText, assetText, progressText,
  _REGISTRY: REGISTRY,
};
