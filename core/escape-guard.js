'use strict';
// 工具入参里把中日文写成 \uXXXX 的那一次, 当场打回让它直接写字重发。
//
// 治的病(2026-10-20 r13 重放实测): haiku 有时把工具参数里的日文写成 \uXXXX, 而且码是凭记忆
// 写的、写错 —— 解析出来就是错字/错日期/错人数(「予約」变「䮤事」), 半截的 \u12 直接解析失败。
// 根因已在源头修掉(biz_do 参数平放, 见 industry/app/biz-do/index.js); 这里只是兜底。
//
// 只能看**原文**: 解析后的入参里转义已经变成(错的)字, 认不出来。原文分片由 agent/consume.js
// 在 content_block_stop 时判一次, 结果记在 agent._escVerdict(tool_use id → true/false)。
// PreToolUse 和消费循环是两条线, 钩子可能先到, 所以等一小会儿判定; 等不到就放行 —— 守卫自己
// 出错或迟到都不能挡住干活。

// 平假名/片假名/CJK 标点 3000–30FF · 汉字 3400–9FFF · 全角 FF00–FFEF。前面紧挨着另一个反斜杠的
// 是字面的 "\\u…"(有人真要写转义码本身), 不算。
const CJK_ESCAPE = /(^|[^\\])\\u(?:3[0-9a-fA-F]{3}|[4-9][0-9a-fA-F]{3}|[fF][fF][0-9a-eA-E][0-9a-fA-F])/;

function hasCjkEscape(raw) { return CJK_ESCAPE.test(String(raw || '')); }

// 打回文案在 main/escape_guard_reject.md(说话对象是模型, 一份英文)。读不到就用这句。
const FALLBACK = 'Nothing was done: write the Japanese/Chinese characters themselves, not \\uXXXX codes, and call again.';
function reason() {
  try { return require('./host').cfg.render('main/escape_guard_reject', {}) || FALLBACK; } catch (_) { return FALLBACK; }
}

const WAIT_MS = 1500;
const STEP_MS = 50;

function hook(agent) {
  return async (input, toolUseID) => {
    try {
      const id = toolUseID || (input && input.tool_use_id);
      if (!id || !agent._escVerdict) return {};
      // 分片正在收 → 等它收完(最多 WAIT_MS); 连分片都没见过(子代理的调用不走这条流) → 只稍等一下,
      // 不然每个看不到原文的调用都白等 1.5 秒。
      const seen = () => agent._argFrags && agent._argFrags.has(id);
      for (let t = 0; !agent._escVerdict.has(id) && t < (seen() ? WAIT_MS : 200); t += STEP_MS) {
        await new Promise((r) => setTimeout(r, STEP_MS));
      }
      const bad = agent._escVerdict.get(id) === true;
      agent._escVerdict.delete(id);
      if (!bad) return {};
      console.log(`[escape-guard] 打回 ${input && input.tool_name}: 入参里有中日文 \\u 转义`);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason() } };
    } catch (e) {
      console.error('[escape-guard] 守卫异常, 放行:', e.message);
      return {};
    }
  };
}

module.exports = { hasCjkEscape, hook };
