// 一次 query() 的全部状态: 模型、工具、历史、收件箱、输出通道。
// 历史只在内存里 —— butler 每次建流都是空白会话(resume 恒为 undefined), 续线程靠它自己的 wake。

import { Channel, Inbox } from './channel.js';
import { resolveModel, type Family } from './providers/resolve.js';
import { modelInfo } from './providers/models.js';
import { buildSystemPrompt } from './preset.js';
import { connectServers, type McpConnection, type McpTransportFactory } from './mcp/connect.js';
import { ToolRegistry, type BuiltinTool } from './tools/registry.js';
import { collectPreToolUse } from './hooks.js';
import { uuid } from './loop.js';
import { Agent, AGENT_TOOL, SUBAGENT_SYSTEM } from './tools/agent.js';

// 服务端 web_search 不一定真能用(网关可能不支持或搜不到), 所以本机 WebSearch 一直留着当兜底
const SEARCH_NOTE = '\n\nThere are two web search tools: web_search runs on the model provider\'s side, WebSearch runs locally. '
  + 'Use web_search first; if it errors or finds nothing useful, use WebSearch.';

const LOCAL_FALLBACK_DESC = 'Fallback web search that runs locally. Use web_search first; call this only when web_search errored '
  + 'or found nothing useful. Returns result titles, URLs and snippets; cite the URLs you rely on.';

export class Session {
  readonly sessionId = uuid();
  readonly out = new Channel<any>();
  readonly opts: any;
  readonly env: Record<string, string | undefined>;
  readonly cwd?: string;
  readonly replay: boolean;
  readonly partial: boolean;
  readonly maxTurns: number;
  readonly preHooks: ReturnType<typeof collectPreToolUse>;
  readonly log: (s: string) => void;
  inbox!: Inbox<any>;

  model: any = null;
  modelId = '';
  family: Family = 'anthropic';
  contextWindow = 200_000;
  maxOutput = 16_384;
  system = '';
  registry: ToolRegistry | null = null;
  conns: McpConnection[] = [];
  mcpStatus: Array<{ name: string; status: string }> = [];
  history: any[] = [];
  lastInput = 0;
  toolKey = '';               // 上一步发出去的工具清单(名字串), 变了就要丢旧思考块
  setupError: unknown = null;
  builtins: BuiltinTool[] = [];
  isChild = false;
  serverSearch: any = null;   // 服务端搜索工具; 有它时与本机 WebSearch 并列给模型

  constructor(opts: any) {
    this.opts = opts || {};
    const proc: any = (globalThis as any).process;
    this.env = this.opts.env || (proc && proc.env) || {};
    this.cwd = this.opts.cwd;
    this.replay = !!(this.opts.extraArgs && 'replay-user-messages' in this.opts.extraArgs);
    this.partial = !!this.opts.includePartialMessages;
    this.maxTurns = Number(this.opts.maxTurns) > 0 ? Number(this.opts.maxTurns) : 200;
    this.preHooks = collectPreToolUse(this.opts.hooks);
    this.log = typeof this.opts.logger === 'function' ? this.opts.logger : (s: string) => console.error(s);
  }

  async setup(): Promise<void> {
    this.system = buildSystemPrompt(this.opts.systemPrompt, this.cwd);
    try {
      const r = resolveModel(this.opts.model, this.env, this.opts.fetch, this.sessionId);
      this.model = r.model; this.modelId = r.id; this.family = r.family;
      // 用户在设置里勾了「优先用自己的搜索 key」(BUTLER_SEARCH_PREFER)就只走本机, 否则服务端优先
      if (r.serverSearch && !this.env.BUTLER_SEARCH_PREFER) this.serverSearch = r.serverSearch();
      const info = modelInfo(r.id);
      this.contextWindow = info.contextWindow;
      this.maxOutput = Number(this.opts.maxOutputTokens) > 0 ? Number(this.opts.maxOutputTokens) : info.maxOutput;
    } catch (e) {
      this.setupError = e;
      this.modelId = this.opts.model || '';
    }
    const factory: McpTransportFactory | undefined = this.opts.mcpTransport;
    this.conns = await connectServers(this.opts.mcpServers, factory, this.log);
    const connected = new Set(this.conns.map((c) => c.server));
    this.mcpStatus = Object.keys(this.opts.mcpServers || {}).map((name) => ({ name, status: connected.has(name) ? 'connected' : 'failed' }));
    // Agent 由核心层自带; 宿主的 tools 名单里没列它就不会露出来(行业版 / 教育版就没有)
    this.builtins = [...(Array.isArray(this.opts.builtinTools) ? this.opts.builtinTools : []), Agent];
    // 服务端搜索开着时, 本机 WebSearch 的说明改成「兜底」: 只在系统提示里叮嘱一句, 模型照样先挑它(11-03 haiku 实测)
    if (this.serverSearch) this.builtins = this.builtins.map((t) => t.name === 'WebSearch' ? { ...t, description: LOCAL_FALLBACK_DESC } : t);
    this.registry = new ToolRegistry(this.opts, this.builtins, this.conns);
    // 宿主没放行 WebSearch(行业版等)就不给服务端搜索: 放行名单管的是「这个人格能不能上网搜」
    if (!this.registry.entries.some((e) => e.name === 'WebSearch')) this.serverSearch = null;
    if (this.serverSearch) this.system += SEARCH_NOTE;
    this.log(`[agent-sdk] ${this.modelId}: web search = ${this.serverSearch ? 'provider first, local fallback' : `local only${this.env.BUTLER_SEARCH_PREFER ? ` (${this.env.BUTLER_SEARCH_PREFER} preferred)` : ''}`}`);
  }

  // 子代理: 同一个模型、同一套工具和闸、共用 MCP 连接, 空白历史, 不能再起子代理, 流不转发给宿主。
  // options.agents[type].prompt 给了就用它当子代理的系统提示词。
  static child(parent: Session, type?: string): Session {
    const def = type && parent.opts.agents ? parent.opts.agents[type] : null;
    const c = new Session({
      ...parent.opts,
      systemPrompt: (def && def.prompt) || SUBAGENT_SYSTEM,
      includePartialMessages: false,
      extraArgs: undefined,
      disallowedTools: [...(parent.opts.disallowedTools || []), AGENT_TOOL],
    });
    c.isChild = true;
    c.model = parent.model; c.modelId = parent.modelId; c.family = parent.family;
    c.contextWindow = parent.contextWindow; c.maxOutput = parent.maxOutput;
    c.system = c.opts.systemPrompt;
    c.conns = parent.conns;
    c.mcpStatus = parent.mcpStatus;
    c.builtins = parent.builtins;
    c.serverSearch = parent.serverSearch;
    c.registry = new ToolRegistry(c.opts, c.builtins, c.conns);
    c.inbox = new Inbox((async function* () { /* 子代理没有后续消息 */ })(), () => {});
    return c;
  }

  emit(m: any): void { this.out.push(m); }

  emitEvent(ev: any): void {
    if (!this.partial) return;
    this.out.push({ type: 'stream_event', event: ev, parent_tool_use_id: null, session_id: this.sessionId, uuid: uuid() });
  }

  async close(): Promise<void> {
    if (!this.isChild) for (const c of this.conns) await c.close();
    this.out.close();
  }
}
