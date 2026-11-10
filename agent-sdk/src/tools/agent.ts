// Agent 工具: 起一个子代理把一件事单独做完, 只把它最后的答复交回来。
// 子代理用同一个模型、同一套工具和 PreToolUse 闸, 但历史是空白的, 也不能再起子代理(防无限嵌套)。
// 子代理的流不转发给宿主 —— 宿主只看到这一次工具调用和它的结果, 和 Claude Code 里看到的一样。

import type { BuiltinTool, ToolOutput } from './registry.js';
import { createWorktree, type Worktree } from './worktree.js';

const fail = (text: string): ToolOutput => ({ content: [{ type: 'text', text: `<tool_use_error>${text}</tool_use_error>` }], isError: true });

export const AGENT_TOOL = 'Agent';
export const WORKFLOW_TOOL = 'Workflow';
export const TASK_STOP_TOOL = 'TaskStop';
export const STRUCTURED_OUTPUT = 'StructuredOutput';
export const SEND_MESSAGE_TOOL = 'SendMessage';
// 子代理里摘掉的: 不能再派子代理、开工作流、停后台任务(防无限嵌套)
export const NO_NESTING = [AGENT_TOOL, WORKFLOW_TOOL, TASK_STOP_TOOL, 'Monitor', SEND_MESSAGE_TOOL];

export const Agent: BuiltinTool = {
  name: AGENT_TOOL,
  description: 'Launch a sub-agent to handle a self-contained, multi-step task (research, searching across many files, a long investigation) '
    + 'and return only its final report. The sub-agent starts with no conversation history, so the prompt must contain everything it needs. '
    + 'It has the same tools as you, except it cannot launch further sub-agents. The result carries an agentId: '
    + `use ${'SendMessage'} with that id (or the name you gave it) to continue the same agent with its context intact.`,
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'A short (3-5 word) description of the task' },
      prompt: { type: 'string', description: 'The full task for the sub-agent' },
      subagent_type: { type: 'string', description: 'Optional agent type defined by the host (options.agents)' },
      model: { type: 'string', description: 'Optional model tier for this sub-agent, in the same family as your own model: '
        + '"cheap" for finding files and simple lookups, "daily" for following a clear spec, "strong" only when it must judge or design '
        + '("haiku" / "sonnet" / "opus" mean the same three). A full model id also works. Defaults to your own model.' },
      run_in_background: { type: 'boolean', description: 'Set to true to run this agent in the background. The call returns a task id at once; '
        + 'you are notified with its report when it finishes, so do not poll or wait for it.' },
      name: { type: 'string', description: 'Name for the spawned agent. Makes it addressable via SendMessage({to: name}).' },
      isolation: { type: 'string', enum: ['worktree'], description: 'Isolation mode. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo.' },
    },
    required: ['description', 'prompt'],
  },
  async run(input, ctx) {
    if (!ctx.runSubagent) return fail('sub-agents are not available in this session');
    let prompt = String(input.prompt || '').trim();
    if (!prompt) return fail('prompt is empty');
    let wt: Worktree | null = null;
    if (input.isolation === 'worktree') {
      try { wt = await createWorktree(ctx.cwd); } catch (e: any) { return fail(e && e.message ? e.message : String(e)); }
      prompt = `You are working in an isolated git worktree at ${wt.path} (branch ${wt.branch}), a copy of the repository. `
        + `Make all changes there; commit them on that branch when done.\n\n${prompt}`;
    }
    const tail = async () => (wt ? `\n${await wt.finish()}` : '');
    const agentId = `ag${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const name = input.name ? String(input.name).trim() : undefined;
    const o = { type: input.subagent_type ? String(input.subagent_type) : undefined, model: input.model ? String(input.model) : undefined, agentId, name, cwd: wt ? wt.path : undefined };
    const idLine = `agentId: ${agentId}${name ? ` (name: ${name})` : ''} — use SendMessage to continue this agent.`;
    if (input.run_in_background === true) {
      if (!ctx.startBackground) return fail('background agents are not available in this session');
      const description = String(input.description || 'sub-agent');
      const id = ctx.startBackground({ description, kind: 'local_agent', prompt,
        run: async (signal, progress) => {
          const r = await ctx.runSubagent!(prompt, { ...o, signal, onProgress: (tool) => progress(`using ${tool}`, tool) });
          return { text: `${r.text || '(the sub-agent returned no text)'}\n\n${idLine}${await tail()}`, isError: r.isError };
        } });
      return { content: [{ type: 'text', text: `Async agent launched successfully.\ntask_id: ${id}\n${idLine}\n`
        + 'It is working in the background. You will be notified automatically when it completes — do not poll or sleep waiting for it. '
        + 'Continue with other work or end your turn.' }] };
    }
    try {
      const r = await ctx.runSubagent(prompt, o);
      return { content: [{ type: 'text', text: `${r.text || '(the sub-agent returned no text)'}\n\n${idLine}${await tail()}` }], ...(r.isError ? { isError: true } : {}) };
    } catch (e: any) {
      return fail(`sub-agent failed: ${e && e.message ? e.message : e}${await tail().catch(() => '')}`);
    }
  },
};

export const SUBAGENT_SYSTEM = `You are a sub-agent. Another agent delegated one task to you; complete it with your tools and reply with a concise final report.
- You start with no prior conversation: everything you know about the task is in the request.
- Do the work, then report what you found or did. Include file paths, figures and anything the delegating agent needs to act on.
- Your final message is returned verbatim to the delegating agent; the user does not see it directly.`;

// 叫停一个后台任务(后台子代理或工作流)。停下后照样会收到一条 status=stopped 的通知。
export const TaskStop: BuiltinTool = {
  name: TASK_STOP_TOOL,
  deferred: true,
  description: 'Stop a running background task (a background sub-agent or a workflow) by its task id.',
  inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: 'The task id returned when it was launched' } }, required: ['task_id'] },
  async run(input, ctx) {
    if (!ctx.stopBackground) return fail('background tasks are not available in this session');
    const id = String(input.task_id || '').trim();
    return ctx.stopBackground(id) ? { content: [{ type: 'text', text: `Stopping task ${id}.` }] } : fail(`no running task with id ${id}`);
  },
};

// 给 Agent 起过的子代理接着发话: 正在跑就并进它下一步; 已经跑完就带着原来的上下文在后台再跑一轮, 跑完通知。
export const SendMessage: BuiltinTool = {
  name: SEND_MESSAGE_TOOL,
  deferred: true,
  description: 'Send a message to a sub-agent you launched with Agent, by its agentId or name. If it is still running, the message reaches it '
    + 'between its tool calls. If it has finished, it resumes in the background with its full context and you are notified with its reply.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'The agentId or name of the agent' },
      message: { type: 'string', description: 'What to tell the agent' },
      summary: { type: 'string', description: 'Optional 5-10 word summary shown in the UI' },
    },
    required: ['to', 'message'],
  },
  async run(input, ctx) {
    if (!ctx.sendToAgent) return fail('SendMessage is not available in this session');
    const to = String(input.to || '').trim();
    const message = String(input.message || '').trim();
    if (!to || !message) return fail('to and message are required');
    const r = ctx.sendToAgent(to, message);
    if (r.status === 'missing') return fail(`no agent named or with id "${to}" (only agents launched with Agent in this session can be messaged)`);
    if (r.status === 'queued') return { content: [{ type: 'text', text: `Message queued for ${to}; it will read it between its tool calls.` }] };
    return { content: [{ type: 'text', text: `Agent ${to} resumed in the background.\ntask_id: ${r.taskId}\nYou will be notified with its reply — do not poll.` }] };
  },
};
