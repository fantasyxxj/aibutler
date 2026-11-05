// Bash 与 Grep。Grep 用纯 JS 实现(不依赖本机装没装 ripgrep), 参数名照 Claude Code 的 Grep。

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BuiltinTool, ToolOutput } from '../tools/registry.js';
import { absPath, globToRegExp, walk } from './files.js';

const ok = (text: string): ToolOutput => ({ content: [{ type: 'text', text }] });
const MAX_OUT = 30_000;

function shellArgs(command: string): [string, string[]] {
  if (process.platform === 'win32') return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command]];
  return [process.env.SHELL || '/bin/bash', ['-c', command]];
}

function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v;
  return out;
}

let bgSeq = 0;

export const Bash: BuiltinTool = {
  name: 'Bash',
  description: 'Executes a shell command and returns its output (stdout and stderr combined). Default timeout 120000 ms, max 600000. '
    + 'Set run_in_background to start a long-running command without waiting; its output is written to a file you can Read later.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to execute' },
      timeout: { type: 'number', description: 'Optional timeout in milliseconds (max 600000)' },
      description: { type: 'string', description: 'Clear, concise description of what this command does' },
      run_in_background: { type: 'boolean', description: 'Run the command in the background' },
    },
    required: ['command'],
  },
  async run(input, ctx) {
    const command = String(input.command || '');
    const [sh, args] = shellArgs(command);
    const env = cleanEnv(ctx.env);
    if (input.run_in_background) {
      const id = `bg${Date.now().toString(36)}${++bgSeq}`;
      const file = path.join(os.tmpdir(), `agent-sdk-${id}.log`);
      const fh = await fs.open(file, 'w');
      const child = spawn(sh, args, { cwd: ctx.cwd, env, detached: true, stdio: ['ignore', fh.fd, fh.fd] });
      child.unref();
      child.on('exit', () => { fh.close().catch(() => {}); });
      return ok(`Command running in background with ID: ${id}. Output is being written to: ${file}`);
    }
    const timeout = Math.min(600_000, Number(input.timeout) > 0 ? Number(input.timeout) : 120_000);
    return await new Promise<ToolOutput>((resolve) => {
      // 自成进程组: 打断/超时时整组杀掉。只杀外层 shell 的话, 它拉起的子进程还攥着输出管道,
      // 'close' 永远等不到, 回合就卡在这里收不了尾。
      const posix = process.platform !== 'win32';
      const child = spawn(sh, args, { cwd: ctx.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: posix });
      let out = '';
      let truncated = false;
      const take = (d: Buffer) => {
        if (out.length >= MAX_OUT) { truncated = true; return; }
        out += d.toString('utf8');
        if (out.length > MAX_OUT) { out = out.slice(0, MAX_OUT); truncated = true; }
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      let killedBy: string | null = null;
      const signal = (sig: NodeJS.Signals) => {
        try { if (posix && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch (_) { /* 已经退了 */ }
      };
      let settled = false;
      const kill = (why: string) => {
        killedBy = why;
        signal('SIGTERM');
        setTimeout(() => signal('SIGKILL'), 2000).unref();
        // 管道仍被孤儿攥着时 'close' 不会来: 杀完 3 秒还没收尾就直接交差
        setTimeout(() => finish(null), 3000).unref();
      };
      const timer = setTimeout(() => kill(`Command timed out after ${timeout} ms`), timeout);
      const onAbort = () => kill('Command was interrupted');
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => { clearTimeout(timer); settled = true; resolve({ content: [{ type: 'text', text: `<tool_use_error>${e.message}</tool_use_error>` }], isError: true }); });
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        let text = out.replace(/\s+$/, '');
        if (truncated) text += `\n\n[output truncated at ${MAX_OUT} characters]`;
        if (killedBy) text += `${text ? '\n' : ''}${killedBy}`;
        const failed = code !== 0 || !!killedBy;
        if (failed && code != null && !killedBy) text += `${text ? '\n' : ''}Exit code ${code}`;
        resolve({ content: [{ type: 'text', text: text || '(no output)' }], ...(failed ? { isError: true } : {}) });
      };
      child.on('close', (code) => finish(code));
      // 正常退出但后台孙进程还开着管道: 等 500ms 收尾输出, 然后不再等
      child.on('exit', (code) => { setTimeout(() => finish(code), 500).unref(); });
    });
  },
};

const TYPE_EXT: Record<string, string[]> = {
  js: ['.js', '.mjs', '.cjs', '.jsx'], ts: ['.ts', '.tsx', '.mts', '.cts'], py: ['.py'], json: ['.json'], md: ['.md'],
  go: ['.go'], rust: ['.rs'], java: ['.java'], html: ['.html', '.htm'], css: ['.css'], sh: ['.sh'], yaml: ['.yml', '.yaml'],
};

export const Grep: BuiltinTool = {
  name: 'Grep',
  description: 'Content search with regular expressions. output_mode: "files_with_matches" (default), "content" (matching lines, supports -A/-B/-C/-n), "count". '
    + 'Filter files with glob (e.g. "*.js") or type (e.g. "js"). head_limit / offset page the output.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The regular expression pattern to search for' },
      path: { type: 'string', description: 'File or directory to search in. Defaults to the working directory.' },
      glob: { type: 'string', description: 'Glob pattern to filter files' },
      type: { type: 'string', description: 'File type to search (js, ts, py, …)' },
      output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
      '-i': { type: 'boolean', description: 'Case insensitive' },
      '-n': { type: 'boolean', description: 'Show line numbers (content mode, default true)' },
      '-A': { type: 'number' }, '-B': { type: 'number' }, '-C': { type: 'number' },
      multiline: { type: 'boolean', description: '. matches newlines; patterns can span lines' },
      head_limit: { type: 'number', description: 'Limit output to the first N lines/entries (default 250, 0 = unlimited)' },
      offset: { type: 'number', description: 'Skip the first N lines/entries' },
    },
    required: ['pattern'],
  },
  async run(input, ctx) {
    const root = absPath(String(input.path || ''), ctx.cwd);
    const flags = `${input['-i'] ? 'i' : ''}${input.multiline ? 'ms' : 'm'}g`;
    let re: RegExp;
    try { re = new RegExp(String(input.pattern || ''), flags); } catch (e: any) {
      return { content: [{ type: 'text', text: `<tool_use_error>Invalid regex: ${e.message}</tool_use_error>` }], isError: true };
    }
    const mode = input.output_mode || 'files_with_matches';
    const globRe = input.glob ? globToRegExp(String(input.glob).includes('/') ? String(input.glob) : `**/${input.glob}`) : null;
    const exts = input.type ? TYPE_EXT[String(input.type)] || [`.${input.type}`] : null;
    const ctxA = Number(input['-A'] ?? input['-C'] ?? 0) || 0;
    const ctxB = Number(input['-B'] ?? input['-C'] ?? 0) || 0;
    const showN = input['-n'] !== false;

    const files: string[] = [];
    const st = await fs.stat(root).catch(() => null);
    if (!st) return ok(`Path does not exist: ${root}`);
    if (st.isFile()) files.push(root);
    else await walk(root, (abs, rel) => {
      if (globRe && !globRe.test(rel)) return;
      if (exts && !exts.includes(path.extname(rel).toLowerCase())) return;
      files.push(abs);
    });

    const lines: string[] = [];
    for (const f of files) {
      let text: string;
      try {
        const buf = await fs.readFile(f);
        if (buf.length > 5_000_000 || buf.subarray(0, 8000).includes(0)) continue;   // 跳过大文件和二进制
        text = buf.toString('utf8');
      } catch (_) { continue; }
      re.lastIndex = 0;
      if (!re.test(text)) continue;
      if (mode === 'files_with_matches') { lines.push(f); continue; }
      const ls = text.split('\n');
      const hitIdx: number[] = [];
      for (let i = 0; i < ls.length; i++) { re.lastIndex = 0; if (re.test(ls[i])) hitIdx.push(i); }
      if (mode === 'count') { lines.push(`${f}:${hitIdx.length || 1}`); continue; }
      const keep = new Set<number>();
      for (const i of hitIdx) for (let j = Math.max(0, i - ctxB); j <= Math.min(ls.length - 1, i + ctxA); j++) keep.add(j);
      const hits = new Set(hitIdx);
      let prev = -2;
      for (const j of [...keep].sort((a, b) => a - b)) {
        if ((ctxA || ctxB) && prev >= 0 && j > prev + 1) lines.push('--');
        lines.push(`${f}${showN ? (hits.has(j) ? `:${j + 1}:` : `-${j + 1}-`) : ':'}${ls[j]}`);
        prev = j;
      }
    }
    if (!lines.length) return ok(mode === 'count' ? 'No matches found' : 'No files found');
    const off = Math.max(0, Number(input.offset) || 0);
    const lim = input.head_limit === 0 ? Infinity : Number(input.head_limit) > 0 ? Number(input.head_limit) : 250;
    const page = lines.slice(off, off + lim);
    const more = lines.length > off + page.length ? `\n\n[Showing ${page.length} of ${lines.length} results; use offset to see more]` : '';
    const head = mode === 'files_with_matches' ? `Found ${lines.length} file${lines.length === 1 ? '' : 's'}\n` : '';
    return ok(head + page.join('\n') + more);
  },
};
