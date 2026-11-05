// plugin-catalog.js — 插件目录: AI 唯一的「有没有现成的」查询口。
//
// 一个插件 = 若干页面模板 + (多页时)一份流程定义。落地形态今天有两种:
//   type=workflow — 多屏 markdown + 顺序, 引擎照着画(workflow.js)
//   type=ui       — 单页, 界面自己的代码跑在沙箱里(ui-packages.js)
// 单页的那种天然不需要流程定义, 所以它没有 steps —— 这不是两套东西, 是同一件事的两个端。
//
// 🔴 这个文件存在的理由是**不把插件塞进常驻提示语**。装了十个插件, 常驻就多十行,
// 而其中九个这辈子都用不上 —— 每一轮都为它们付钱。改成查: AI 只需常驻一句「有插件这回事」,
// 真要用的那一刻再来问。装多少个插件, 常驻都是那一句。
'use strict';

const workflow = require('./workflow');
const uiPackages = require('./ui-packages');
const commands = require('./commands');

// 按钮文字进 {{cmd:…|label=…}} 后按 | 切分, 混进 | 或 }} 会让按钮无声地烂成一段死文字。
// 标题是包自己带的, 我们管不住, 所以在这儿挡一道。
function safeLabel(s, fallback) {
  // 换行也压成空格: 标记 {{…}} 得在一行里, 整段原文(跟读 / 评测)常带换行
  const t = String(s == null ? '' : s).replace(/\|/g, '/').replace(/\}\}/g, '').replace(/\s*\n\s*/g, ' ').trim();
  return t || fallback;
}

/* 装了的插件, 统一形状一份。entry = 把人带进去的那一行, 原样写进回复即可。 */
/* 宿主追加的条目源。core 只认得手顺包和界面包, 而行业版还有视图和行内命令 ——
   那两样也是「这台机器上能用的东西」, 同样不该常驻。core 引不到 industry 的模块,
   所以反过来由宿主在开机时把取数函数登记进来。fn(locale) → 条目数组。
   🔴 条目形状统一: 带参数的(视图/命令)必须给 `write`(照抄就能用的写法)+ `params`(参数形状),
   因为 plugin_open 渲染的是无参模板, 塞不进 date 这类实参 —— 那种只能由 AI 自己写进回复。 */
const sources = [];
function registerSource(fn) { sources.push(fn); }

function list(locale) {
  const out = [];
  for (const fn of sources) {
    try { out.push(...(fn(locale) || [])); }
    catch (e) { console.warn('[plugin-catalog] 条目源出错, 跳过:', e.message); }
  }
  /* 宿主の条目が先、同じ id は宿主の方を残す —— 行業版は手順を自分の目録からも出す(進度で入口が
     変わる版)ので、core の目録にも同じ包が載っていると plugin_find に二行並ぶ(10-15 dev line_setup)。 */
  const seen = new Set(out.map((p) => p.id));
  for (const w of workflow.summary(locale)) {
    if (seen.has(w.id)) continue;
    out.push({
      id: w.id,
      kind: 'workflow',
      title: w.title,
      pages: w.total,
      // No `to`: the engine lands on the first step not yet done. Pinning the first
      // screen here would restart anyone who is half way through, and it is the
      // catalog entry that gets copied verbatim.
      entry: `{{cmd:wf_go|wf=${w.id}|label=${safeLabel(w.title, w.id)}}}`,
    });
  }
  for (const u of uiPackages.summary(locale)) {
    // 常驻板行的槽名直接用包 id: 板上显示的标题有回落链(显式 title > 包自带 title > 槽名), 不会露出机器名。
    const board = u.display === 'board';
    out.push({ id: u.id, kind: 'ui', title: u.title, pages: 1, display: u.display,
               summary: u.summary, usage: u.usage, keywords: u.keywords,
               entry: board ? `{{pin:${u.id}|ui=${u.id}}}` : `{{ui:${u.id}}}` });
  }
  // 开放给人格的命令(包声明 ai:true)挂在各自的条目上, plugin_find 照着列出 plugin_call 的写法。
  for (const p of out) {
    const cmds = commands.aiCommands(p.id);
    if (cmds.length) p.commands = cmds;
  }
  return out;
}

/* 关键词找。空关键词 = 全给 —— 一台机器上的插件是个位数, 「先看看有啥」是正当问法。 */
function find(keyword, locale) {
  const all = list(locale);
  const kw = String(keyword == null ? '' : keyword).trim().toLowerCase();
  if (!kw) return all;
  const terms = kw.split(/\s+/);
  return all.filter((p) => {
    const hay = `${p.id} ${p.title} ${p.keywords || ''}`.toLowerCase();
    return terms.some((t) => hay.includes(t));
  });
}

function get(id, locale) {
  return list(locale).find((p) => p.id === String(id)) || null;
}

/* 界面包を開く時の初期値を標記に足す: `{{ui:dish-new}}` + {name:'鱚の天ぷら'} → `{{ui:dish-new|name=鱚の天ぷら}}`。
   沙箱の init.args に載る(industry/app/renderer/sandbox.js)。値に | や }} が混ざると標記が割れて
   死んだ文字列になるので safeLabel と同じ手当てをする。界面包以外(手順包)には付けない。 */
function withOpenArgs(entry, kind, args) {
  if (kind !== 'ui' || !args || typeof args !== 'object') return entry;
  const tail = Object.keys(args)
    .filter((k) => /^[a-z][a-z0-9_]{0,31}$/.test(k) && args[k] != null && String(args[k]).trim() !== '')
    .map((k) => `|${k}=${safeLabel(args[k], '')}`).join('');
  return tail ? entry.replace(/\}\}$/, `${tail}}}`) : entry;
}

module.exports = { list, find, get, registerSource, withOpenArgs };
