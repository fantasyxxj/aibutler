# @butler/agent-sdk

A multi-provider agent SDK for TypeScript / JavaScript.

Its public surface is a drop-in for the subset of `@anthropic-ai/claude-agent-sdk` that butler uses — `query()`, `tool()`, `createSdkMcpServer()` and the same message stream (`system/init`, `stream_event`, `assistant`, `user` replay, `system/api_retry`, `result`) — so a host can switch between the two by changing one import. Unlike the Claude Agent SDK it does not spawn a CLI: the agent loop, tools and provider adapters run in-process, on top of the [Vercel AI SDK](https://ai-sdk.dev).

- **Providers**: Anthropic protocol (official or any gateway via `ANTHROPIC_BASE_URL`), OpenAI, DeepSeek, any OpenAI-compatible endpoint. More via AI SDK provider packages.
- **Portable core**: the main entry uses only `fetch` and standard JS (a test enforces this), so it can run in Electron, React Native, iOS JavaScriptCore or a browser. Desktop-only tools live in `@butler/agent-sdk/node`.
- **Built-in tools**: `ToolSearch`, `Agent` (sub-agents, foreground or background), `SendMessage` and `TaskStop` in the core; `WebFetch` / `WebSearch` (fetch only, usable on mobile); `Read` `Write` `Edit` `Glob` `Grep` `Bash` `Skill` `Workflow` `Monitor` in the Node entry.

## Usage

```js
import { query, tool, createSdkMcpServer } from '@butler/agent-sdk';
import { nodeTools, nodeMcpTransport } from '@butler/agent-sdk/node';
import { z } from 'zod';

const server = createSdkMcpServer({ name: 'app', tools: [
  tool('today', 'Returns today\'s date', {}, async () => ({ content: [{ type: 'text', text: new Date().toDateString() }] })),
] });

const q = query({
  prompt: 'What day is it?',
  options: {
    model: 'deepseek/deepseek-chat',            // or 'openai/gpt-5-mini', 'compat/<model>', or a bare Anthropic-protocol id
    env: { DEEPSEEK_API_KEY: '...' },
    systemPrompt: 'You are a helpful assistant.',
    mcpServers: { app: server },
    builtinTools: nodeTools(),                  // Read Write Edit Glob Grep Bash WebFetch WebSearch Skill
    mcpTransport: nodeMcpTransport,             // stdio / http / sse MCP servers
    includePartialMessages: true,
  },
});
for await (const m of q) if (m.type === 'result') console.log(m.result);
```

### Model selection

| `model` | Endpoint | Key from `env` |
|---|---|---|
| `deepseek/<id>` | DeepSeek | `DEEPSEEK_API_KEY` (`DEEPSEEK_BASE_URL` optional) |
| `openai/<id>` | OpenAI | `OPENAI_API_KEY` (`OPENAI_BASE_URL` optional) |
| `compat/<id>` | any OpenAI-compatible endpoint | `OPENAI_BASE_URL` + `OPENAI_API_KEY` |
| anything else | Anthropic Messages protocol | `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` for gateways |

### Supported `query()` options

`prompt` (string or async iterable of user messages), `model`, `env`, `cwd`, `systemPrompt` (string, or `{type:'preset', preset:'claude_code', append}`), `tools`, `allowedTools`, `disallowedTools`, `mcpServers`, `hooks.PreToolUse`, `abortController`, `includePartialMessages`, `extraArgs['replay-user-messages']`, `maxTurns`, `maxOutputTokens`, plus `builtinTools`, `mcpTransport`, `fetch`, `logger`. CLI-only options of the Claude Agent SDK (`pathToClaudeCodeExecutable`, `settingSources`, `permissionMode`, …) are accepted and ignored.

The returned `Query` is an async iterator with `interrupt()` and `getContextUsage()`.

## Behaviour notes

- **Agent**: runs a sub-agent with the same model, tools and hooks, a blank history and no further `Agent`; only its final answer comes back as the tool result, its stream is not forwarded. `options.agents[type].prompt` overrides the sub-agent system prompt.
- **Background tasks**: `Agent` with `run_in_background: true`, `Bash` with `run_in_background: true`, every `Workflow` and every `Monitor` return a task id at once. Like the Claude Agent SDK, the task emits `system/task_started`, `system/task_progress` and `system/task_notification`; when it settles a `<task-notification>` user message is queued, which starts a new turn if the agent is idle. `TaskStop` stops one; closing the query stops them all. `Monitor` also queues a `<task-notification>` with `<status>event</status>` for each batch of output lines while it runs, so outside events wake the agent.
- **Sub-agent follow-ups**: every `Agent` result carries an `agentId` (and the optional `name`). `SendMessage({to, message})` reaches a running agent between its tool calls, or resumes a finished one in the background with its full history. `isolation: "worktree"` runs the agent in a temporary git worktree on a new branch; it is removed if the agent changed nothing.
- **Workflow**: same interface as Claude Code's tool — a script starting with `export const meta = {...}` orchestrates sub-agents with `agent()` / `parallel()` / `pipeline()` / `phase()` / `log()` and nested `workflow(nameOrScript, args)` (named scripts come from `.claude/workflows/<name>.js` in the project, then home), run in a `node:vm` context without `require`, `Date.now()` or `Math.random()`. `agent(prompt, {schema})` returns a validated object via a `StructuredOutput` tool. Each run saves `script.js` and `journal.jsonl` under `<tmpdir>/butler-workflows/<session>/<runId>/`; `resumeFromRunId` reuses results of unchanged `agent()` calls. Limits: `BUTLER_WORKFLOW_CONCURRENCY` (default 4) and `BUTLER_WORKFLOW_MAX_AGENTS` (default 50).
- **Skill**: file-based skills — directories with a `SKILL.md` (YAML front matter `name` / `description`) under `<cwd>/.claude/skills/` and `~/.claude/skills/`; `options.skills` limits the list. The tool is hidden when no skill is found. Skills that ship inside the Claude Code binary are not available.
- **WebSearch** runs the engines listed in `env.BUTLER_SEARCH_ENGINES` (JSON `[{type, key?, url?}]`, set by the host from the user's settings), first to last, moving on when one fails or times out. With no engines set, `WebSearch` is removed and only the provider's own `web_search` is offered (when the model has one); with engines set, only `WebSearch` is offered. **WebFetch** returns page text; for long pages with a `prompt`, the session model reads the page and answers.

- **Tool deferral**: when `tools` includes `ToolSearch`, MCP tools not marked `alwaysLoad` are listed by name only; the model loads their schemas with `ToolSearch` first.
- **Prompt caching**: Anthropic-protocol models get cache breakpoints on the system prompt and the last two messages; other providers cache prefixes automatically, and tool order is kept stable.
- **Soft interjection**: user messages that arrive while a turn is running are merged in before the next model call.
- **Retries**: 5xx / 429 / network errors are retried with backoff and reported as `system/api_retry`; 401/403/400 are not retried.
- **Gateway session header**: every request carries a stable per-session `x-opencode-session` header (required by some gateways) and `User-Agent: butler-agent-sdk/<version>`.

## Files

| File | Role |
|---|---|
| `src/index.ts` | public exports |
| `src/query.ts` | `Query`: lifecycle, turn scheduling, `interrupt()`, `getContextUsage()` |
| `src/session.ts` | per-query state: model, tools, history, inbox, output channel |
| `src/loop.ts` | one turn: steps, tool execution (adjacent read-only calls run together), hooks, retries, result |
| `src/step.ts` | one model call: AI SDK stream → Claude-style `stream_event`s and content blocks |
| `src/convert.ts` | message / tool-result / usage format conversion |
| `src/hooks.ts` | `PreToolUse` hook runner |
| `src/errors.ts` | error classification and backoff |
| `src/preset.ts` | default system prompt used for the `claude_code` preset |
| `src/context.ts` | context usage breakdown |
| `src/channel.ts` | async queues |
| `src/background.ts` | background tasks: task ids, `task_*` messages, the `<task-notification>` that starts the next turn |
| `src/providers/` | model resolution, model table (context window), prompt caching |
| `src/tools/registry.ts` | tool list, filtering, deferral, `ToolSearch`, which tools are read-only |
| `src/tools/agent.ts` | `Agent` sub-agent tool (optional `model`: haiku / sonnet / opus or a full id; `run_in_background`, `name`, `isolation`), `SendMessage` and `TaskStop` |
| `src/tools/worktree.ts` | temporary git worktree for `isolation: "worktree"` |
| `src/tools/web.ts` | `WebFetch` / `WebSearch`, HTML → text |
| `src/tools/search-engines.ts` | local search engines (Bing, DuckDuckGo, Brave, Tavily, SearXNG), tried in the user's order with a per-engine timeout |
| `src/mcp/` | `tool()` / `createSdkMcpServer()`; connecting MCP servers |
| `src/node/` | desktop tools (`files.ts`, `shell.ts`, `skills.ts`, `monitor.ts`, `workflow.ts` + `workflow-script.ts`) and MCP transports (Node only) |
| `test/` | `npm test` |
| `scripts/live-smoke.mjs` | live test against a real gateway |

## Using it from butler

`core/agent/util.js` → `resolveSdkKind()` picks the SDK per persona: subscription personas use the Claude Agent SDK (`claude-code`); key personas follow their `sdk` field (`claude-code` | `butler`, this one), and an empty field means the Claude Agent SDK when it is installed, otherwise this one. `BUTLER_AGENT_SDK=claude-code|butler` forces one for the whole app. Persona models written as `deepseek/…`, `openai/…` or `compat/…` get their credential mapped to the matching provider variables (`core/agent/env.js`).

Packaging: `npm run dist:mac` / `npm run dist:win` (scripts/dist.js) build the only installer there is. It ships neither the Claude Agent SDK nor the `claude` binary; users who want their Claude subscription turn it on in System settings, which downloads both (core/cc-sdk-install.js). The build runs `npm run build:agent-sdk` first.
