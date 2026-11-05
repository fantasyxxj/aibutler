// Agent 工具: 起一个子代理把一件事单独做完, 只把它最后的答复交回来。
// 子代理用同一个模型、同一套工具和 PreToolUse 闸, 但历史是空白的, 也不能再起子代理(防无限嵌套)。
// 子代理的流不转发给宿主 —— 宿主只看到这一次工具调用和它的结果, 和 Claude Code 里看到的一样。

import type { BuiltinTool, ToolOutput } from './registry.js';

const fail = (text: string): ToolOutput => ({ content: [{ type: 'text', text: `<tool_use_error>${text}</tool_use_error>` }], isError: true });

export const AGENT_TOOL = 'Agent';

export const Agent: BuiltinTool = {
  name: AGENT_TOOL,
  description: 'Launch a sub-agent to handle a self-contained, multi-step task (research, searching across many files, a long investigation) '
    + 'and return only its final report. The sub-agent starts with no conversation history, so the prompt must contain everything it needs. '
    + 'It has the same tools as you, except it cannot launch further sub-agents.',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'A short (3-5 word) description of the task' },
      prompt: { type: 'string', description: 'The full task for the sub-agent' },
      subagent_type: { type: 'string', description: 'Optional agent type defined by the host (options.agents)' },
    },
    required: ['description', 'prompt'],
  },
  async run(input, ctx) {
    if (!ctx.runSubagent) return fail('sub-agents are not available in this session');
    const prompt = String(input.prompt || '').trim();
    if (!prompt) return fail('prompt is empty');
    try {
      const r = await ctx.runSubagent(prompt, { type: input.subagent_type ? String(input.subagent_type) : undefined });
      return { content: [{ type: 'text', text: r.text || '(the sub-agent returned no text)' }], ...(r.isError ? { isError: true } : {}) };
    } catch (e: any) {
      return fail(`sub-agent failed: ${e && e.message ? e.message : e}`);
    }
  },
};

export const SUBAGENT_SYSTEM = `You are a sub-agent. Another agent delegated one task to you; complete it with your tools and reply with a concise final report.
- You start with no prior conversation: everything you know about the task is in the request.
- Do the work, then report what you found or did. Include file paths, figures and anything the delegating agent needs to act on.
- Your final message is returned verbatim to the delegating agent; the user does not see it directly.`;
