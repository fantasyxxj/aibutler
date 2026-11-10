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
import { Agent, TaskStop, SendMessage, SUBAGENT_SYSTEM, STRUCTURED_OUTPUT, NO_NESTING } from './tools/agent.js';
import { parseEngines, type EngineConf } from './tools/search-engines.js';
import { Background } from './background.js';

// 联网搜索二选一: 用户配了本机引擎就只给本机 WebSearch, 没配就只给模型服务端自带的 web_search(作者 11-06 定)
export class Session {
  readonly sessionId = uuid();
  out = new Channel<any>();   // 子代理每跑一轮换一个新的(留着续聊的子代理会跑好几轮)
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
  serverSearch: any = null;   // 服务端搜索工具; 只在没配本机引擎时给, 与本机 WebSearch 二选一
  localEngines: EngineConf[] = [];   // 用户在设置里加的本机搜索引擎, 排前的先试
  // Agent 起的子代理留在这里, SendMessage 按 agentId / name 找回来续聊
  readonly agents = new Map<string, AgentRec>();
  // 后台子代理 / 工作流; 收尾通知投进收件箱, 由它开新的一轮
  readonly bg = new Background((m) => this.emit(m), (text) => this.inbox?.push(synthetic(text)), () => this.sessionId, (s) => this.log(s));

  constructor(opts: any) {
    this.opts = opts || {};
    const proc: any = (globalThis as any).process;
    this.env = this.opts.env || (proc && proc.env) || {};
    this.localEngines = parseEngines(this.env.BUTLER_SEARCH_ENGINES);
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
      // 用户在设置里加了搜索引擎(且没勾禁用)就只走本机那几家, 否则只用模型服务端自带的(有就有, 没有就没有)
      if (r.serverSearch && !this.localEngines.length) this.serverSearch = r.serverSearch();
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
    // Agent / TaskStop / SendMessage 由核心层自带; 宿主的 tools 名单里没列它就不会露出来(行业版 / 教育版就没有)
    this.builtins = [...(Array.isArray(this.opts.builtinTools) ? this.opts.builtinTools : []), Agent, TaskStop, SendMessage];
    this.registry = new ToolRegistry(this.opts, this.builtins, this.conns);
    // 宿主没放行 WebSearch(行业版等)就不给服务端搜索: 放行名单管的是「这个人格能不能上网搜」
    const searchAllowed = this.registry.entries.some((e) => e.name === 'WebSearch');
    if (!searchAllowed) this.serverSearch = null;
    // 没配本机引擎 → 本机 WebSearch 摘掉, 两个搜索工具不同时出现, 模型不用挑
    if (searchAllowed && !this.localEngines.length) {
      this.builtins = this.builtins.filter((t) => t.name !== 'WebSearch');
      this.registry = new ToolRegistry(this.opts, this.builtins, this.conns);
    }
    this.log(`[agent-sdk] ${this.modelId}: web search = ${!searchAllowed ? 'off'
      : this.localEngines.length ? `local (${this.localEngines.map((e) => e.type).join(' > ')})`
        : this.serverSearch ? 'provider only' : 'none (model has no built-in search, no local engine set)'}`);
  }

  // 子代理: 同一套工具和闸、共用 MCP 连接, 空白历史, 不能再起子代理, 流不转发给宿主。
  // options.agents[type].prompt 给了就用它当子代理的系统提示词。模型: 调用时指定 > 类型定义里的 > 跟主代理同一个。
  // extra: 只给这个子代理的工具(工作流要结构化结果时的 StructuredOutput)
  static child(parent: Session, type?: string, model?: string, extra: BuiltinTool[] = [], cwd?: string): Session {
    const def = type && parent.opts.agents ? parent.opts.agents[type] : null;
    const tools = Array.isArray(parent.opts.tools) && extra.length ? [...parent.opts.tools, ...extra.map((t) => t.name)] : parent.opts.tools;
    const c = new Session({
      ...parent.opts,
      ...(cwd ? { cwd } : {}),
      tools,
      systemPrompt: ((def && def.prompt) || SUBAGENT_SYSTEM) + (extra.some((t) => t.name === STRUCTURED_OUTPUT)
        ? `\n- When you are done, call the ${STRUCTURED_OUTPUT} tool once with your result; that object is what gets returned.` : ''),
      includePartialMessages: false,
      extraArgs: undefined,
      disallowedTools: [...(parent.opts.disallowedTools || []), ...NO_NESTING],
    });
    c.isChild = true;
    c.model = parent.model; c.modelId = parent.modelId; c.family = parent.family;
    c.contextWindow = parent.contextWindow; c.maxOutput = parent.maxOutput;
    const want = subagentModelId(parent, model || (def && def.model));
    if (want && want !== parent.modelId) {
      const r = resolveModel(want, parent.env, parent.opts.fetch, c.sessionId);   // 认不出 / 缺 key 就抛, Agent 工具把它报成调用失败
      const info = modelInfo(r.id);
      c.model = r.model; c.modelId = r.id; c.family = r.family;
      c.contextWindow = info.contextWindow; c.maxOutput = info.maxOutput;
    }
    c.system = c.opts.systemPrompt;
    c.conns = parent.conns;
    c.mcpStatus = parent.mcpStatus;
    c.builtins = [...parent.builtins, ...extra];
    c.serverSearch = parent.serverSearch;
    c.registry = new ToolRegistry(c.opts, c.builtins, c.conns);
    c.inbox = new Inbox((async function* () { /* 子代理没有后续消息 */ })(), () => {});
    return c;
  }

  rememberAgent(rec: AgentRec): void {
    this.agents.set(rec.id, rec);
    if (rec.name) this.agents.set(rec.name, rec);
    // 留太多占内存: 超出就丢最早的、已经停下的
    const uniq = [...new Set(this.agents.values())];
    for (const old of uniq) {
      if (uniq.length <= MAX_AGENTS) break;
      if (old.running) continue;
      for (const [k, v] of this.agents) if (v === old) this.agents.delete(k);
      uniq.splice(uniq.indexOf(old), 1);
    }
  }

  emit(m: any): void { this.out.push(m); }

  emitEvent(ev: any): void {
    if (!this.partial) return;
    this.out.push({ type: 'stream_event', event: ev, parent_tool_use_id: null, session_id: this.sessionId, uuid: uuid() });
  }

  async close(): Promise<void> {
    this.bg.stopAll();
    if (!this.isChild) for (const c of this.conns) await c.close();
    this.out.close();
  }
}

export interface AgentRec { id: string; name?: string; child: Session; running: boolean }
const MAX_AGENTS = 20;

// 引擎自己投进收件箱的用户消息: 不回放给宿主(宿主没发过它)
export function synthetic(text: string): any {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, isSynthetic: true };
}

// 派活按档说: cheap / daily / strong(haiku / sonnet / opus 是它们的同义词)。
// 宿主按同族挑好的三档放在 env.BUTLER_SUBAGENT_MODELS(带协议前缀, 别家也能用, 见 butler core/model-table.js), 先用它;
// 没给那一档时, 主代理走 Anthropic 协议就取 env 的 ANTHROPIC_DEFAULT_*_MODEL, 再没有用当前这代的官方型号;
// 走别家协议就沿用主模型。'inherit' 同 CC 的 agent 定义, 也是沿用。其余当完整型号。
const TIER_OF: Record<string, string> = { cheap: 'cheap', haiku: 'cheap', daily: 'daily', sonnet: 'daily', strong: 'strong', opus: 'strong' };
const ANTHROPIC_TIER: Record<string, [string, string]> = {
  cheap: ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'claude-haiku-4-5'],
  daily: ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'claude-sonnet-5'],
  strong: ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'claude-opus-5-5'],
};

function subagentModelId(parent: Session, want?: string): string {
  const w = String(want || '').trim();
  if (!w || w === 'inherit') return '';
  const tier = TIER_OF[w.toLowerCase()];
  if (!tier) return w;
  let picked: Record<string, string> = {};
  try { picked = JSON.parse(parent.env.BUTLER_SUBAGENT_MODELS || '{}') || {}; } catch (_) { /* 宿主给坏了就当没给 */ }
  if (picked[tier]) return picked[tier];
  const a = ANTHROPIC_TIER[tier];
  return parent.family === 'anthropic' ? (parent.env[a[0]] || a[1]) : '';
}
