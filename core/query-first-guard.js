'use strict';
// 先查后办: 真人回合里, 还没 memory_query / memory_section 过, 第一个办事类工具调用打回一次。
//
// 治的病(2026-10-11 行业版调教实测): 教过的规则存成了命题, 店主换个说法, 拿原话自动召回就撞不上;
// 人格自己提炼成类别词去查却能查到(「営業時間 閉店 変更 設定」→ 规则排第一)。所以缺的不是提炼能力,
// 是「先查」这一步不一定发生 —— 提示型的点名/没对上提示只把查询率拉到四句里三句。
// SDK 没有 tool_choice 可以强制第一步, 于是挂在动作上: 它要动手的那一刻, 没查过就先挡一次。
//
// 和红线守卫同一个 PreToolUse 口子, 但:
//   · 每回合最多打回一次 —— 挡第二次就是不让干活了, 查不查的提醒到此为止。
//   · 只管真人回合(user/inbox)。心跳/唤醒/沉淀这些 auto 轮不挡。
//   · 拦哪些工具由 main/query_first.json 的 tool_pattern 决定, 不写死在这里。

const { HAS_EXTERNAL_TEXT } = require('./agent/util');

const QUERY_TOOLS = /(^|__)memory_(query|section)$/;

class QueryFirstGuard {
  // sourceKindOf: 取当前回合来源的函数(agent._turnSourceKind), 守卫自己不持有 agent。
  constructor(cfg, sourceKindOf) {
    this.cfg = cfg;
    this.sourceKindOf = sourceKindOf;
    this.resetTurn();
  }

  _conf() {
    try { return this.cfg.json('main/query_first') || null; } catch (_) { return null; }
  }

  // 返回 null = 放行; 返回字符串 = 打回理由。纯判断, 方便门禁直接测。
  decide(toolName) {
    const name = String(toolName || '');
    if (QUERY_TOOLS.test(name)) { this._queried = true; return null; }
    if (this._queried || this._blocked) return null;
    const c = this._conf();
    if (!c || c.enabled === false || !c.tool_pattern) return null;
    if (!HAS_EXTERNAL_TEXT(this.sourceKindOf())) return null;
    if (!new RegExp(c.tool_pattern).test(name)) return null;
    this._blocked = true;
    return String(c.reason || 'Query memory first.').split('{tool}').join(name);
  }

  hook() {
    return async (input) => {
      let reason = null;
      // 守卫自己出错绝不能挡住干活。
      try { reason = this.decide(input && input.tool_name); } catch (e) { console.error('[query-first] 守卫异常, 放行:', e.message); return {}; }
      if (!reason) return {};
      console.log(`[query-first] 打回 ${input.tool_name}: 本回合还没查过记忆`);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
    };
  }

  resetTurn() { this._queried = false; this._blocked = false; }
}

module.exports = { QueryFirstGuard };
