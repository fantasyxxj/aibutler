// 文件类内置工具: Read / Write / Edit / Glob。参数名与输出格式照 Claude Code 的同名工具,
// 模型(和 butler 的各道闸: 它们读 tool_input.file_path / content / old_string / new_string)看到的都一样。

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { BuiltinTool, ToolOutput } from '../tools/registry.js';
import { head } from '../providers/well-formed.js';

const ok = (text: string): ToolOutput => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolOutput => ({ content: [{ type: 'text', text: `<tool_use_error>${text}</tool_use_error>` }], isError: true });

export function absPath(p: string, cwd?: string): string {
  if (!p) return cwd || process.cwd();
  const home = process.env.HOME || '';
  if (p.startsWith('~/') && home) return path.join(home, p.slice(2));
  return path.isAbsolute(p) ? p : path.resolve(cwd || process.cwd(), p);
}

const IMAGE_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;

export const Read: BuiltinTool = {
  name: 'Read',
  description: 'Reads a file from the local filesystem. file_path must be absolute. Reads up to 2000 lines by default; use offset/limit for large files. '
    + 'Results are returned in cat -n format with line numbers starting at 1. Image files (png/jpg/gif/webp) are returned as images.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The absolute path to the file to read' },
      offset: { type: 'integer', description: 'The line number to start reading from' },
      limit: { type: 'integer', description: 'The number of lines to read' },
    },
    required: ['file_path'],
  },
  async run(input, ctx) {
    const p = absPath(String(input.file_path || ''), ctx.cwd);
    let st;
    try { st = await fs.stat(p); } catch (_) { return fail(`File does not exist: ${p}`); }
    if (st.isDirectory()) return fail(`EISDIR: ${p} is a directory, not a file. Use Glob or Bash ls to list it.`);
    const ext = path.extname(p).toLowerCase();
    if (IMAGE_EXT[ext]) {
      const buf = await fs.readFile(p);
      return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: IMAGE_EXT[ext] }] };
    }
    const text = await fs.readFile(p, 'utf8');
    if (!text.length) return ok(`<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>`);
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const start = Math.max(1, Number(input.offset) || 1);
    const limit = Number(input.limit) > 0 ? Number(input.limit) : MAX_LINES;
    const slice = lines.slice(start - 1, start - 1 + limit);
    if (!slice.length) return ok(`<system-reminder>Warning: the file has ${lines.length} lines; offset ${start} is past the end.</system-reminder>`);
    const width = String(start + slice.length - 1).length;
    const body = slice.map((l, i) => {
      const line = l.length > MAX_LINE_CHARS ? `${head(l, MAX_LINE_CHARS)}… [line truncated]` : l;
      return `${String(start + i).padStart(Math.max(width, 6))}\t${line}`;
    }).join('\n');
    const more = start - 1 + slice.length < lines.length ? `\n\n(${lines.length - (start - 1 + slice.length)} more lines; use offset to read further)` : '';
    return ok(body + more);
  },
};

export const Write: BuiltinTool = {
  name: 'Write',
  description: 'Writes a file to the local filesystem, overwriting it if it exists. file_path must be absolute. Parent directories are created.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The absolute path to the file to write' },
      content: { type: 'string', description: 'The content to write to the file' },
    },
    required: ['file_path', 'content'],
  },
  async run(input, ctx) {
    const p = absPath(String(input.file_path || ''), ctx.cwd);
    let existed = true;
    try { await fs.stat(p); } catch (_) { existed = false; }
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, String(input.content ?? ''), 'utf8');
    return ok(existed ? `The file ${p} has been updated successfully.` : `File created successfully at: ${p}`);
  },
};

export const Edit: BuiltinTool = {
  name: 'Edit',
  description: 'Performs exact string replacement in a file. old_string must match the file exactly and be unique unless replace_all is true.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The absolute path to the file to modify' },
      old_string: { type: 'string', description: 'The text to replace' },
      new_string: { type: 'string', description: 'The text to replace it with (must be different from old_string)' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences of old_string (default false)' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  async run(input, ctx) {
    const p = absPath(String(input.file_path || ''), ctx.cwd);
    const oldS = String(input.old_string ?? '');
    const newS = String(input.new_string ?? '');
    if (oldS === newS) return fail('No changes to make: old_string and new_string are exactly the same.');
    let text: string;
    try { text = await fs.readFile(p, 'utf8'); } catch (_) {
      if (oldS === '') { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, newS, 'utf8'); return ok(`File created successfully at: ${p}`); }
      return fail(`File does not exist: ${p}`);
    }
    if (oldS === '') return fail('old_string is empty but the file already exists. Use Write to overwrite it.');
    const count = text.split(oldS).length - 1;
    if (count === 0) return fail(`String to replace not found in file.\nString: ${oldS}`);
    if (count > 1 && !input.replace_all) {
      return fail(`Found ${count} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldS}`);
    }
    const next = input.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
    await fs.writeFile(p, next, 'utf8');
    return ok(`The file ${p} has been updated successfully.`);
  },
};

// —— Glob ——
const SKIP_DIRS = new Set(['node_modules', '.git']);

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) { re += '\\{'; continue; }
      re += `(?:${glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export async function walk(root: string, onFile: (abs: string, rel: string) => boolean | void, limit = 200_000): Promise<void> {
  let seen = 0;
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop() as string;
    let ents;
    try { ents = await fs.readdir(path.join(root, rel), { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(r); continue; }
      if (!e.isFile()) continue;
      if (++seen > limit) return;
      if (onFile(path.join(root, r), r) === false) return;
    }
  }
}

export const Glob: BuiltinTool = {
  name: 'Glob',
  description: 'Fast file pattern matching. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths sorted by modification time (newest first), up to 100.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The glob pattern to match files against' },
      path: { type: 'string', description: 'The directory to search in. Defaults to the working directory.' },
    },
    required: ['pattern'],
  },
  async run(input, ctx) {
    const root = absPath(String(input.path || ''), ctx.cwd);
    const re = globToRegExp(String(input.pattern || '**/*'));
    const hits: string[] = [];
    await walk(root, (abs, rel) => { if (re.test(rel)) hits.push(abs); });
    const withTime = await Promise.all(hits.map(async (h) => ({ h, t: (await fs.stat(h).catch(() => null))?.mtimeMs || 0 })));
    withTime.sort((a, b) => b.t - a.t);
    if (!withTime.length) return ok('No files found');
    const shown = withTime.slice(0, 100).map((x) => x.h);
    return ok(shown.join('\n') + (withTime.length > 100 ? `\n(Results are truncated: ${withTime.length} files matched, showing 100)` : ''));
  },
};
