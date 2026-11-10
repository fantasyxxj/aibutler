// Workflow 工具: 接口照 Claude Code 的同名工具。模型写一段脚本, 用 agent() / parallel() / pipeline() / phase() 编排子代理;
// 调用立即返回任务号, 整个工作流作为一个后台任务跑(进宿主的任务面板), 跑完引擎自己通知主代理开新的一轮。
// 每次调用把脚本存成 <临时目录>/butler-workflows/<会话>/<runId>/script.js, 每个 agent() 的结果记进同目录 journal.jsonl;
// 改脚本后带 scriptPath + resumeFromRunId 重跑, 提示词和参数都没变的 agent() 直接用上次的结果。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuiltinTool, ToolContext, ToolOutput } from '../tools/registry.js';
import { WORKFLOW_TOOL } from '../tools/agent.js';
import { parseScript, runBody } from './workflow-script.js';

const fail = (text: string): ToolOutput => ({ content: [{ type: 'text', text: `<tool_use_error>${text}</tool_use_error>` }], isError: true });

const MAX_ITEMS = 4096;
const MAX_DEPTH = 3;

// 存着的命名工作流: 项目 .claude/workflows/<name>.js, 再看用户目录
function findNamed(name: string, cwd?: string): string | null {
  if (!/^[\w.-]+$/.test(name)) return null;
  const dirs = [cwd && path.join(cwd, '.claude', 'workflows'), path.join(os.homedir(), '.claude', 'workflows')].filter(Boolean) as string[];
  for (const d of dirs) for (const ext of ['.js', '.mjs']) {
    const f = path.join(d, name + ext);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function limits(env: Record<string, string | undefined>) {
  const n = (k: string, d: number) => (Number(env[k]) > 0 ? Math.floor(Number(env[k])) : d);
  // 同时在跑的子代理数 / 一个工作流一共能派的子代理数(CC 是 min(16, CPU-2) 和 1000; 这里按桌面和按量计费收紧)
  return { concurrency: n('BUTLER_WORKFLOW_CONCURRENCY', 4), maxAgents: n('BUTLER_WORKFLOW_MAX_AGENTS', 50) };
}

const baseDir = (sessionId: string) => path.join(os.tmpdir(), 'butler-workflows', sessionId);

export const Workflow: BuiltinTool = {
  name: WORKFLOW_TOOL,
  deferred: true,
  description: 'Run a multi-agent workflow script in the background. Use it when control flow across several sub-agents should be deterministic '
    + '(fan out over a list, run stages per item, verify findings with independent agents). The script must begin with '
    + '`export const meta = { name, description, phases }` (a pure literal), followed by plain JavaScript using:\n'
    + '- agent(prompt, {label?, phase?, schema?, model?, agentType?}) → the sub-agent\'s final text, or with a JSON Schema `schema` the validated object; null if it failed\n'
    + '- parallel([() => agent(...), ...]) → array of results, waits for all; a failed thunk gives null\n'
    + '- pipeline(items, stage1, stage2, ...) → each item runs through all stages on its own, no barrier between stages; each stage gets (prevResult, item, index)\n'
    + '- phase(title) groups the following agents; log(message) shows a progress line; args is the `args` input verbatim\n'
    + '- workflow(nameOrScript, args?) runs another workflow inline (a name from .claude/workflows/ or a full script) and returns its result; it shares this run\'s agent limits\n'
    + 'The body runs in an async context (use await; `return` gives the workflow result). No filesystem, network, Date.now() or Math.random(). '
    + 'The call returns a task id at once and you are notified with the result when it finishes — do not wait or poll. '
    + 'The script is saved and its path returned: to iterate, edit that file and call again with scriptPath (plus resumeFromRunId to reuse unchanged agent() results).',
  inputSchema: {
    type: 'object',
    properties: {
      script: { type: 'string', description: 'Self-contained workflow script starting with `export const meta = {...}`' },
      scriptPath: { type: 'string', description: 'Path to a saved workflow script (returned by an earlier call); takes precedence over script' },
      args: { description: 'Value exposed to the script as the global `args`, verbatim. Pass arrays/objects as real JSON values, not as a JSON string' },
      name: { type: 'string', description: 'Name of a saved workflow in .claude/workflows/<name>.js (project, then home)' },
      resumeFromRunId: { type: 'string', description: 'Run id of an earlier run in this session: agent() calls with unchanged prompt and options reuse its results' },
    },
  },
  async run(input, ctx) {
    if (!ctx.startBackground || !ctx.runSubagent || !ctx.sessionId) return fail('workflows are not available here (sub-agents cannot start workflows)');
    let src = typeof input.script === 'string' ? input.script : '';
    if (input.scriptPath) {
      try { src = fs.readFileSync(String(input.scriptPath), 'utf8'); } catch (e: any) { return fail(`cannot read scriptPath: ${e && e.message}`); }
    }
    if (!src.trim() && input.name) {
      const f = findNamed(String(input.name), ctx.cwd);
      if (!f) return fail(`no workflow named "${input.name}" in .claude/workflows/ (project or home); pass the script itself`);
      src = fs.readFileSync(f, 'utf8');
    }
    if (!src.trim()) return fail('script is empty');
    let parsed: ReturnType<typeof parseScript>;
    try { parsed = parseScript(src); } catch (e: any) { return fail(e.message); }
    const runId = `wf_${Math.random().toString(36).slice(2, 10)}`;
    const dir = path.join(baseDir(ctx.sessionId), runId);
    fs.mkdirSync(dir, { recursive: true });
    const scriptPath = path.join(dir, 'script.js');
    fs.writeFileSync(scriptPath, src, 'utf8');
    const cache = input.resumeFromRunId ? loadJournal(path.join(baseDir(ctx.sessionId), String(input.resumeFromRunId), 'journal.jsonl')) : new Map();
    const id = ctx.startBackground({
      description: parsed.meta.description || parsed.meta.name, kind: 'local_workflow', workflowName: parsed.meta.name,
      run: (signal, progress) => execute(parsed, input.args, ctx, { signal, progress, dir, cache, runId }),
    });
    return { content: [{ type: 'text', text: `Workflow "${parsed.meta.name}" launched in the background.\ntask_id: ${id}\nrunId: ${runId}\n`
      + `scriptPath: ${scriptPath}\ntranscriptDir: ${dir}\n`
      + `${cache.size ? `Resuming from ${input.resumeFromRunId}: ${[...cache.values()].reduce((n, q) => n + q.length, 0)} cached agent results.\n` : ''}`
      + 'You will be notified with its result when it finishes — do not poll or wait. Continue with other work or end your turn.' }] };
  },
};

interface RunState { signal: AbortSignal; progress: (summary: string, lastTool?: string) => void; dir: string; cache: Map<string, any[]>; runId: string }

async function execute(parsed: ReturnType<typeof parseScript>, args: unknown, ctx: ToolContext, st: RunState): Promise<{ text: string; isError: boolean }> {
  const { concurrency, maxAgents } = limits(ctx.env);
  const journal = path.join(st.dir, 'journal.jsonl');
  let curPhase = '';
  let started = 0, done = 0, failed = 0, cached = 0, active = 0;
  const waiting: Array<() => void> = [];
  const report = (extra?: string, tool?: string) => st.progress(
    `${curPhase ? `${curPhase} · ` : ''}${done}/${started} agents done${failed ? `, ${failed} failed` : ''}${extra ? ` · ${extra}` : ''}`, tool);
  const slot = async () => { while (active >= concurrency) await new Promise<void>((r) => waiting.push(r)); active++; };
  const release = () => { active--; const w = waiting.shift(); if (w) w(); };

  const agent = async (prompt: unknown, opts: any = {}) => {
    if (st.signal.aborted) throw new Error('workflow stopped');
    const p = String(prompt ?? '');
    const o = opts && typeof opts === 'object' ? opts : {};
    if (o.schema !== undefined && !(o.schema && o.schema.type === 'object' && o.schema.properties && typeof o.schema.properties === 'object')) {
      throw new Error('agent(): schema needs {type: "object", properties: {...}} at its root');
    }
    if (++started > maxAgents) throw new Error(`agent(): this workflow already started ${maxAgents} agents (the cap); split the work or raise BUTLER_WORKFLOW_MAX_AGENTS`);
    const key = JSON.stringify([p, o.schema ?? null, o.model ?? null, o.agentType ?? null]);
    const hit = st.cache.get(key);
    if (hit && hit.length) {
      const v = hit.shift();
      cached++; done++;
      append(journal, { key, label: o.label || '', result: v, cached: true });
      report();
      return v;
    }
    await slot();
    const label = String(o.label || p.slice(0, 40));
    try {
      if (st.signal.aborted) throw new Error('workflow stopped');
      report(`▶ ${label}`);
      const r = await ctx.runSubagent!(p, { model: o.model ? String(o.model) : undefined, type: o.agentType ? String(o.agentType) : undefined,
        schema: o.schema, signal: st.signal, onProgress: (name) => report(`${label}: ${name}`, name) });
      const v = r.isError ? null : (o.schema ? r.structured ?? null : r.text);
      if (v === null) failed++;
      done++;
      append(journal, { key, label, phase: o.phase || curPhase, result: v });
      report();
      return v;
    } finally { release(); }
  };

  const settle = (f: () => unknown) => Promise.resolve().then(f).catch(() => null);
  const checkLen = (a: unknown, who: string) => {
    if (!Array.isArray(a)) throw new Error(`${who}: expects an array`);
    if (a.length > MAX_ITEMS) throw new Error(`${who}: at most ${MAX_ITEMS} items`);
  };
  const makeHooks = (argsValue: unknown, depth: number): Record<string, unknown> => ({
    agent,
    parallel: (thunks: Array<() => unknown>) => { checkLen(thunks, 'parallel()'); return Promise.all(thunks.map((t) => settle(t))); },
    pipeline: (items: unknown[], ...stages: Array<(prev: unknown, item: unknown, i: number) => unknown>) => {
      checkLen(items, 'pipeline()');
      return Promise.all(items.map((item, i) => settle(async () => {
        let v: unknown = item;
        for (const stage of stages) v = await stage(v, item, i);
        return v;
      })));
    },
    phase: (title: unknown) => { curPhase = String(title ?? ''); report(); },
    log: (m: unknown) => report(String(m ?? '')),
    args: argsValue,
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    // 嵌套工作流: 就地跑完拿返回值, 和外层共用并发 / 总数上限与 journal(续跑照样命中)
    workflow: async (ref: unknown, subArgs?: unknown) => {
      if (depth >= MAX_DEPTH) throw new Error(`workflow(): nested more than ${MAX_DEPTH} levels`);
      const r = String(ref ?? '');
      let src = r;
      if (!/export\s+const\s+meta/.test(r)) {
        const f = findNamed(r, ctx.cwd);
        if (!f) throw new Error(`workflow(): no workflow named "${r}" in .claude/workflows/`);
        src = fs.readFileSync(f, 'utf8');
      }
      const sub = parseScript(src);
      report(`↳ ${sub.meta.name}`);
      return runBody(sub.body, makeHooks(subArgs, depth + 1), `${sub.meta.name}.js`);
    },
  });
  const hooks = makeHooks(args, 0);

  try {
    const value = await runBody(parsed.body, hooks, path.join(st.dir, 'script.js'));
    const out = value === undefined ? '(the workflow returned nothing)' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return { text: `Workflow "${parsed.meta.name}" finished (runId ${st.runId}): ${done} agents${cached ? ` (${cached} from cache)` : ''}`
      + `${failed ? `, ${failed} returned null` : ''}.\nJournal: ${journal}\n\nResult:\n${out}`, isError: false };
  } catch (e: any) {
    return { text: `Workflow "${parsed.meta.name}" failed (runId ${st.runId}) after ${done} agents: ${e && e.message ? e.message : e}\n`
      + `Journal: ${journal}\nFix the script at ${path.join(st.dir, 'script.js')} and call Workflow again with scriptPath and resumeFromRunId: "${st.runId}".`, isError: true };
  }
}

function append(file: string, rec: unknown): void {
  try { fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8'); } catch (_) { /* 记不下来只影响续跑 */ }
}

// 上一次的 journal: 同一个 key(提示词 + schema + 型号 + 类型)按出现顺序排队, 返回 null 的不复用
function loadJournal(file: string): Map<string, any[]> {
  const m = new Map<string, any[]>();
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return m; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.result === null || r.result === undefined) continue;
      if (!m.has(r.key)) m.set(r.key, []);
      m.get(r.key)!.push(r.result);
    } catch (_) { /* 半行跳过 */ }
  }
  return m;
}
