// 工具总表: 内置工具(宿主注册进来的, 例如 @butler/agent-sdk/node 的 Read/Bash…) + MCP 工具。
//
// 过滤语义对齐 Claude Agent SDK:
//   options.tools            —— 内置工具里开哪些(不给 = 宿主注册的全开)
//   options.allowedTools     —— 收紧 MCP 工具(名单外的模型看不见); 内置工具给了 tools 就只看 tools。
//                               permissionMode=bypassPermissions 时整份不起作用 —— CC 实测如此: butler 白名单里
//                               没有 Agent / plugin_open, 人格在 CC 下照样调得动
//   options.disallowedTools  —— 一律摘掉
// 延迟加载: 开了 ToolSearch 时, MCP 工具里没标 alwaysLoad 的只报名字, 模型用 ToolSearch 取 schema 后
// 下一步才带上完整定义。内置工具始终带全。顺序固定(内置按注册序, MCP 按全名排序), 前缀缓存才稳。

import { jsonSchema } from 'ai';
import type { McpConnection } from '../mcp/connect.js';

export interface ToolContent { type: string; text?: string; data?: string; mimeType?: string }
export interface ToolOutput { content: ToolContent[]; isError?: boolean }
export interface ToolContext {
  cwd?: string;
  signal: AbortSignal;
  env: Record<string, string | undefined>;
  // 让工具借当前会话的模型做一次无工具的补全(WebFetch 读长页面用)
  complete?: (system: string, user: string) => Promise<string>;
  // 起一个子代理把 prompt 做完, 拿回它的最终答复(Agent 工具用)
  runSubagent?: (prompt: string, o: { type?: string }) => Promise<{ text: string; isError: boolean }>;
}

export interface BuiltinTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;   // JSON Schema
  run(input: any, ctx: ToolContext): Promise<ToolOutput>;
  // 按会话定制(例如按 cwd 现找技能写进描述); 返回 null = 这个会话不开这个工具
  prepare?(opts: any): BuiltinTool | null;
}

export interface ToolEntry {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  kind: 'builtin' | 'mcp';
  deferred: boolean;
  searchHint?: string;
  run(input: any, ctx: ToolContext): Promise<ToolOutput>;
}

export const TOOL_SEARCH = 'ToolSearch';

export class ToolRegistry {
  readonly entries: ToolEntry[] = [];
  private byName = new Map<string, ToolEntry>();
  private loaded = new Set<string>();
  readonly deferralOn: boolean;

  constructor(opts: any, builtins: BuiltinTool[], conns: McpConnection[]) {
    const wantBuiltins: string[] | null = Array.isArray(opts.tools) ? opts.tools : null;
    const allowed: Set<string> | null = Array.isArray(opts.allowedTools) && opts.permissionMode !== 'bypassPermissions' ? new Set(opts.allowedTools) : null;
    const denied = new Set<string>(Array.isArray(opts.disallowedTools) ? opts.disallowedTools : []);
    const visible = (n: string) => !denied.has(n) && (!allowed || allowed.has(n) || n === TOOL_SEARCH);
    const builtinVisible = (n: string) => wantBuiltins ? !denied.has(n) : visible(n);

    this.deferralOn = !!wantBuiltins && wantBuiltins.includes(TOOL_SEARCH) && !denied.has(TOOL_SEARCH);

    const prepared = builtins.map((b) => (b.prepare ? b.prepare(opts) : b)).filter(Boolean) as BuiltinTool[];
    const pool = new Map(prepared.map((b) => [b.name, b]));
    const order = wantBuiltins ? wantBuiltins : prepared.map((b) => b.name);
    for (const n of order) {
      const b = pool.get(n);
      if (!b || !builtinVisible(n)) continue;
      this.add({ name: b.name, description: b.description, inputSchema: b.inputSchema, kind: 'builtin', deferred: false, run: (i, c) => b.run(i, c) });
    }
    if (this.deferralOn) this.add(this.toolSearchEntry());

    const mcp = conns.flatMap((c) => c.tools.map((t) => ({ c, t })))
      .sort((a, b) => (a.t.fullName < b.t.fullName ? -1 : a.t.fullName > b.t.fullName ? 1 : 0));
    for (const { c, t } of mcp) {
      if (!visible(t.fullName)) continue;
      this.add({
        name: t.fullName, description: t.description, inputSchema: t.inputSchema, kind: 'mcp',
        deferred: this.deferralOn && !t.alwaysLoad, searchHint: t.searchHint,
        run: (input, ctx) => c.call(t.name, input || {}, ctx.signal),
      });
    }
  }

  private add(e: ToolEntry): void {
    if (this.byName.has(e.name)) return;
    this.entries.push(e);
    this.byName.set(e.name, e);
  }

  get(name: string): ToolEntry | undefined { return this.byName.get(name); }

  isLoaded(e: ToolEntry): boolean { return !e.deferred || this.loaded.has(e.name); }

  deferredNames(): string[] { return this.entries.filter((e) => e.deferred).map((e) => e.name); }

  // 本步发给模型的工具定义(AI SDK ToolSet, 不带 execute —— 执行由 loop 自己做)
  toolSet(): Record<string, any> {
    const out: Record<string, any> = {};
    for (const e of this.entries) {
      if (!this.isLoaded(e)) continue;
      out[e.name] = { description: e.description, inputSchema: jsonSchema(normalizeSchema(e.inputSchema)) };
    }
    return out;
  }

  // 延迟工具清单: 接在系统提示词末尾。整场会话不变, 不破坏前缀缓存。
  deferredNotice(): string {
    const names = this.deferredNames();
    if (!names.length) return '';
    return `\n\n# Deferred tools\nThe following tools are available but their schemas are not loaded. `
      + `Call ${TOOL_SEARCH} with query "select:<name>[,<name>...]" (or keywords) to load them before use:\n`
      + names.join('\n');
  }

  private toolSearchEntry(): ToolEntry {
    return {
      name: TOOL_SEARCH,
      description: 'Fetches full schema definitions for deferred tools so they can be called. '
        + 'Query forms: "select:A,B" fetches these exact tools; keywords search names and descriptions; '
        + '"+word" requires word in the name.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'select:<name>[,<name>...] or keywords' },
          max_results: { type: 'number', description: 'max results for keyword search (default 5)' },
        },
        required: ['query'],
      },
      kind: 'builtin',
      deferred: false,
      run: async (input) => this.search(String(input?.query || ''), Number(input?.max_results) || 5),
    };
  }

  search(query: string, max: number): ToolOutput {
    const deferred = this.entries.filter((e) => e.deferred);
    let hits: ToolEntry[];
    if (query.startsWith('select:')) {
      const want = query.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
      hits = want.map((w) => deferred.find((e) => e.name === w || e.name.endsWith(`__${w}`))).filter(Boolean) as ToolEntry[];
    } else {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const must = words.filter((w) => w.startsWith('+')).map((w) => w.slice(1));
      const rest = words.filter((w) => !w.startsWith('+'));
      hits = deferred
        .filter((e) => must.every((w) => e.name.toLowerCase().includes(w)))
        .map((e) => {
          const hay = `${e.name} ${e.description} ${e.searchHint || ''}`.toLowerCase();
          return { e, s: rest.reduce((n, w) => n + (e.name.toLowerCase().includes(w) ? 3 : hay.includes(w) ? 1 : 0), 0) };
        })
        .filter((x) => x.s > 0 || !rest.length)
        .sort((a, b) => b.s - a.s)
        .slice(0, max)
        .map((x) => x.e);
    }
    if (!hits.length) return { content: [{ type: 'text', text: `No deferred tools matched "${query}".` }] };
    for (const h of hits) this.loaded.add(h.name);
    const lines = hits.map((h) => `<function>${JSON.stringify({ description: h.description, name: h.name, parameters: h.inputSchema })}</function>`);
    return { content: [{ type: 'text', text: `<functions>\n${lines.join('\n')}\n</functions>` }] };
  }
}

// MCP 列出来的 schema 偶尔缺 type / properties, 有的家会直接 400。补齐成一个合法的 object schema。
function normalizeSchema(s: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...(s || {}) };
  if (!out.type) out.type = 'object';
  if (out.type === 'object' && !out.properties) out.properties = {};
  delete out.$schema;
  return out;
}
