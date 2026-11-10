// Monitor: 盯一个命令的输出(或一条 WebSocket), 每来一行就投一条通知开新一轮 —— 外面有动静就把代理叫醒。
// 参数照 Claude Code 的 Monitor。挂在后台任务上: 立即回任务号, TaskStop 叫停, 到点或命令退出收尾再通知一次。
// 短时间连来多行合成一条事件, 免得一行一轮。

import { spawn } from 'node:child_process';
import type { BuiltinTool, ToolOutput } from '../tools/registry.js';

const fail = (text: string): ToolOutput => ({ content: [{ type: 'text', text: `<tool_use_error>${text}</tool_use_error>` }], isError: true });
const DEFAULT_MS = 300_000;
const MAX_MS = 1_800_000;
const BATCH_MS = 300;
const EVENT_CAP = 8_000;

export const Monitor: BuiltinTool = {
  name: 'Monitor',
  deferred: true,
  description: 'Watch a shell command (each stdout line is an event) or a WebSocket (each text frame is an event) in the background. '
    + 'Returns a task id at once; every event arrives as a notification that starts a new turn, so you can react to things as they happen '
    + '(a log line, a build finishing, a message arriving). The watch ends when the command exits, the socket closes, the deadline passes, '
    + 'or you call TaskStop. Filter noisy output in the command itself (grep --line-buffered) so only lines worth waking for come through.',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short human-readable description of what you are monitoring (shown in notifications).' },
      timeout_ms: { type: 'number', description: `Kill the monitor after this deadline. Default ${DEFAULT_MS}ms, capped at ${MAX_MS}ms. You are notified at expiry and can re-arm.` },
      command: { type: 'string', description: 'Shell command or script. Each stdout line is an event; exit ends the watch.' },
      ws: {
        type: 'object', description: 'WebSocket to open. Each text frame is an event; socket close ends the watch. Cannot be combined with command.',
        properties: { url: { type: 'string' }, protocols: { type: 'array', items: { type: 'string' } } }, required: ['url'],
      },
    },
    required: ['description'],
  },
  async run(input, ctx) {
    if (!ctx.startBackground) return fail('Monitor is not available in this session');
    const command = input.command ? String(input.command) : '';
    const ws = input.ws && input.ws.url ? input.ws : null;
    if (!command === !ws) return fail('give exactly one of command or ws');
    const deadline = Math.min(MAX_MS, Number(input.timeout_ms) > 0 ? Number(input.timeout_ms) : DEFAULT_MS);
    const description = String(input.description || 'monitor');
    const id = ctx.startBackground({ description, kind: 'monitor', run: (signal, progress, event) => new Promise((resolve) => {
      let buf: string[] = [];
      let timer: any = null;
      let count = 0;
      const flush = () => {
        timer = null;
        if (!buf.length) return;
        let text = buf.join('\n');
        buf = [];
        if (text.length > EVENT_CAP) text = `${text.slice(0, EVENT_CAP)}\n…[truncated]`;
        event(text);
      };
      const line = (l: string) => {
        if (!l.trim()) return;
        count++;
        buf.push(l);
        progress(`${count} event${count === 1 ? '' : 's'}`);
        if (!timer) timer = setTimeout(flush, BATCH_MS);
      };
      let stop: () => void = () => {};
      let settled = false;
      const end = (why: string, isError = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(expire);
        if (timer) { clearTimeout(timer); flush(); }
        stop();
        resolve({ text: `${why} after ${count} event${count === 1 ? '' : 's'}.`, isError });
      };
      const expire = setTimeout(() => end(`Deadline of ${deadline}ms reached; monitor stopped. Re-arm it if you still need to watch`), deadline);
      signal.addEventListener('abort', () => end('Monitor stopped'), { once: true });
      if (command) stop = watchCommand(command, ctx, line, end);
      else stop = watchSocket(ws, line, end);
    }) });
    return { content: [{ type: 'text', text: `Monitor started.\ntask_id: ${id}\nEach event arrives as a notification; do not poll. Stop it with TaskStop.` }] };
  },
};

function watchCommand(command: string, ctx: any, line: (l: string) => void, end: (why: string, isError?: boolean) => void): () => void {
  const posix = process.platform !== 'win32';
  const [sh, args] = posix ? [process.env.SHELL || '/bin/bash', ['-c', command]] : [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command]];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.env || {})) if (typeof v === 'string') env[k] = v;
  const child = spawn(sh, args, { cwd: ctx.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: posix });
  let rest = '';
  let errTail = '';
  child.stdout.on('data', (d: Buffer) => {
    const parts = (rest + d.toString('utf8')).split('\n');
    rest = parts.pop() || '';
    parts.forEach(line);
  });
  child.stderr.on('data', (d: Buffer) => { errTail = (errTail + d.toString('utf8')).slice(-1000); });
  child.on('error', (e) => end(`Command failed to start: ${e.message}`, true));
  child.on('close', (code) => {
    if (rest) line(rest);
    end(`Command exited with code ${code}${code && errTail.trim() ? ` (stderr: ${errTail.trim()})` : ''}`, code !== 0 && code !== null);
  });
  return () => { try { if (posix && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch (_) { /* 已经退了 */ } };
}

function watchSocket(ws: { url: string; protocols?: string[] }, line: (l: string) => void, end: (why: string, isError?: boolean) => void): () => void {
  const WS: any = (globalThis as any).WebSocket;
  if (!WS) { setTimeout(() => end('WebSocket is not available in this runtime', true), 0); return () => {}; }
  let sock: any;
  try { sock = new WS(ws.url, ws.protocols); } catch (e: any) { setTimeout(() => end(`WebSocket failed: ${e.message}`, true), 0); return () => {}; }
  sock.onmessage = (m: any) => {
    if (typeof m.data === 'string') m.data.split('\n').forEach(line);
    else line('[binary frame]');
  };
  sock.onerror = () => end('WebSocket error', true);
  sock.onclose = (c: any) => end(`WebSocket closed (code ${c && c.code})`);
  return () => { try { sock.close(); } catch (_) { /* 已经关了 */ } };
}
