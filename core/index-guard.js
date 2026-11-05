'use strict';
// 4.2 索引类知识挂懒路径 —— 红线守卫的软性兄弟, 同一个 PreToolUse 口子, 相反的处置。
//
// 治的病(作者 2026-08-16 举的三例): 环境清单/部署脚本/代码映射明明在记忆里, AI 就是不用,
// 转头去翻代码, 严重时还误判"没有这个连不上"。
//
// 为什么强制检索救不了: 触发时机在 **AI 的动作**里, 不在用户的话里 ——
// 「查一下昨天订单量」这句话里没有任何数据库连接的语义, 是 AI 自己推理到"我要连库"
// 那一刻才需要环境清单。所以钩子只能挂在动作上。
//
// 和红线的两处相反:
//   · 红线是 deny, 这里是 **放行 + 附一眼**。索引可能过期, 有时确实该翻原始资料。
//   · 红线命中要记账要打回, 这里 **失败完全静默**: 查不到就什么都不说。
//     因为索引类知识的失效本来就是静默的(笨路也能成功), 补一句"没查到"只是噪音。
//
// 穷举的是【通道】不是【内容】: 配置里只写"哪个动作 → 拿什么关键词去查",
// 内容永远来自记忆库。通道有限且早就写死在代码里, 内容无穷。
//
// 🔴 钩子分两层, 出厂那层只放【人人都用】的(作者 2026-09-20):
//   出厂 main/index_hooks.json —— 全实例共用一份, 所以"连数据库先查环境清单"这种
//     只有少数人用得上的钩子不配待在这里: 给所有人定个性化钩子本身就是错的形态。
//   人格目录 <memoryDir>/hooks.json —— 人格自己写自己的领域钩子, 同 key 压过出厂那条。
// 程序只负责读和匹配, 内容归人格。

const fs = require('fs');
const path = require('path');
const { parseTrigger, haystackOf } = require('./redline-guard');

const PERSONA_HOOKS = 'hooks.json';

class IndexGuard {
  // cfg: config-loader(可为 null, 那就整个关掉); graph: 记忆引擎; memoryDir: 人格自定义钩子所在目录
  constructor(graph, { cfg = null, log = console.error, memoryDir = '' } = {}) {
    this.graph = graph;
    this.cfg = cfg;
    this.log = log;
    this.memoryDir = memoryDir;
    this._fired = new Set();   // 同一轮同一个钩子只提一次
    this._mine = null;         // 人格钩子的 mtime 缓存 { mtime, hooks }
  }

  get enabled() { return !!this.graph && typeof this.graph.query === 'function' && !!this.cfg; }

  _conf() {
    try { return this.cfg.json('main/index_hooks'); } catch (e) { return null; }
  }

  // 人格自己的钩子。按 mtime 缓存, 免得每次工具调用都读盘; 文件一改下次调用就重读。
  // 读坏了返回空数组: 一个写歪的自定义钩子不该把出厂那两条一起带走。
  _personaHooks() {
    if (!this.memoryDir) return [];
    const p = path.join(this.memoryDir, PERSONA_HOOKS);
    let mtime = 0;
    try { mtime = fs.statSync(p).mtimeMs; } catch (e) { this._mine = null; return []; }
    if (this._mine && this._mine.mtime === mtime) return this._mine.hooks;

    let hooks = [];
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      hooks = Array.isArray(j) ? j : (j && Array.isArray(j.hooks) ? j.hooks : []);
    } catch (e) {
      // 出声(只进开发日志): 自定义钩子静默失效正是红线表踩过的坑 —— 写的人以为程序兜着,
      // 于是不再自己留神。查不到东西可以静默, 但"你写的东西根本没被加载"不能。
      this.log(`[index] ${PERSONA_HOOKS} 读取失败, 本次只用出厂钩子:`, e && e.message);
    }
    hooks = hooks.filter((h) => {
      if (!h || !h.key || !h.query) return false;
      if (parseTrigger(h.trigger)) return true;
      this.log(`[index] ${PERSONA_HOOKS} 里 "${h.key}" 的 trigger 不合法(格式是 \`工具名:正则\`), 已跳过`);
      return false;
    });
    this._mine = { mtime, hooks };
    return hooks;
  }

  // 人格的在前, 同 key 压过出厂那条。
  _hooks(c) {
    const mine = this._personaHooks();
    if (!mine.length) return c.hooks || [];
    const mineKeys = new Set(mine.map((h) => h.key));
    return [...mine, ...(c.hooks || []).filter((h) => h && !mineKeys.has(h.key))];
  }

  // 返回 null = 什么都不说; 返回字符串 = 附在工具调用前给 AI 看一眼。
  decide(toolName, toolInput) {
    if (!this.enabled) return null;
    const c = this._conf();
    if (!c || c.enabled === false) return null;

    const hay = haystackOf(toolName, toolInput);
    const hook = this._hooks(c).find((h) => {
      if (this._fired.has(h.key)) return false;
      const t = parseTrigger(h.trigger);
      if (!t) return false;
      if (t.tools && !t.tools.has(toolName)) return false;
      return t.re.test(hay);
    });
    if (!hook) return null;

    let hits = [];
    try {
      hits = this.graph.query(hook.query, { k: c.max_hits || 3, kind: 'index_hook' }) || [];
    } catch (e) {
      // 静默: 记忆坏了不该在人家动手的时候跳出来说话。留一行给开发看, 不进对话。
      this.log('[index] 查索引失败(静默放行):', e && e.message);
      return null;
    }
    if (!hits.length) return null;

    this._fired.add(hook.key);
    const lines = hits
      .map((h) => `- ${h.slug || h.id}${h.claim ? ` — ${h.claim}` : ''}`)
      .join('\n');
    // 钩子可自带 header/footer: 默认那套说的是"这能省你一次搜索", 而管住某个动作的钩子
    // 语气完全不同("改这个文件有规矩")。用错语气等于把硬规矩说成了温馨提示。
    return [hook.header || c.header, lines, hook.footer || c.footer].filter(Boolean).join('\n');
  }

  // 挂 PreToolUse。不给 permissionDecision = 不干预权限流程, 照常放行;
  // 只是顺路把 additionalContext 塞进去(sdk.d.ts: PreToolUseHookSpecificOutput.additionalContext)。
  hook() {
    return async (input) => {
      let note = null;
      // 守卫自己抛异常绝不能挡住工具调用 —— 这条比红线那边更硬: 那边至少还有拦的价值,
      // 这边只是"顺手提一句", 为了提一句把人家的活干挂了是纯亏。
      try { note = this.decide(input && input.tool_name, input && input.tool_input); }
      catch (e) { this.log('[index] 守卫异常, 静默放行:', e && e.message); return {}; }
      if (!note) return {};
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: note } };
    };
  }

  resetTurn() { this._fired.clear(); }
}

module.exports = { IndexGuard };
