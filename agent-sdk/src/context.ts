// getContextUsage(): 上下文逐项账。字段与 Claude Agent SDK 返回的同名(butler 的 formatContextBill 照读)。
// 分项是按字符数估的(约 4 字符 1 token, 中日文按 1 字 1 token), 合计用最近一次真实 usage —— 估的只是分摊。

import type { Session } from './session.js';

function est(s: string): number {
  let cjk = 0;
  for (const ch of s) if (ch.charCodeAt(0) > 0x2e80) cjk++;
  return Math.ceil((s.length - cjk) / 4) + cjk;
}

export function estimateContext(s: Session): any {
  const reg = s.registry;
  const sysTok = est(s.system + (reg ? reg.deferredNotice() : ''));
  const systemTools: any[] = [];
  const mcpTools: any[] = [];
  for (const e of reg ? reg.entries : []) {
    const loaded = reg!.isLoaded(e);
    const tokens = loaded ? est(e.name + e.description + JSON.stringify(e.inputSchema)) : 0;
    if (e.kind === 'builtin') systemTools.push({ name: e.name, tokens });
    else {
      const m = /^mcp__(.+?)__(.+)$/.exec(e.name);
      mcpTools.push({ serverName: m ? m[1] : '', name: m ? m[2] : e.name, tokens, isLoaded: loaded });
    }
  }
  let userT = 0, asstT = 0, callT = 0, resT = 0;
  for (const m of s.history) {
    const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
    for (const p of parts) {
      if (p.type === 'text') { const t = est(p.text || ''); if (m.role === 'assistant') asstT += t; else userT += t; }
      else if (p.type === 'tool-call') callT += est(JSON.stringify(p.input || {}));
      else if (p.type === 'tool-result') resT += est(JSON.stringify(p.output || ''));
      else if (p.type === 'reasoning') asstT += est(p.text || '');
    }
  }
  const toolsTok = systemTools.reduce((a, x) => a + x.tokens, 0);
  const mcpTok = mcpTools.reduce((a, x) => a + x.tokens, 0);
  const msgTok = userT + asstT + callT + resT;
  const estimated = sysTok + toolsTok + mcpTok + msgTok;
  const total = s.lastInput || estimated;
  const max = s.contextWindow;
  return {
    totalTokens: total,
    maxTokens: max,
    percentage: Math.round((total / max) * 1000) / 10,
    model: s.modelId,
    categories: [
      { name: 'System prompt', tokens: sysTok },
      { name: 'System tools', tokens: toolsTok },
      { name: 'MCP tools', tokens: mcpTok },
      { name: 'Messages', tokens: msgTok },
      { name: 'Free space', tokens: Math.max(0, max - total) },
    ],
    systemPromptSections: [],
    systemTools,
    deferredBuiltinTools: [],
    mcpTools,
    memoryFiles: [],
    agents: [],
    messageBreakdown: {
      toolCallTokens: callT, toolResultTokens: resT, attachmentTokens: 0,
      assistantMessageTokens: asstT, userMessageTokens: userT, redirectedContextTokens: 0,
      unattributedTokens: Math.max(0, total - estimated), toolCallsByType: [],
    },
  };
}
