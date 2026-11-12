// model + env → AI SDK 的模型实例。
//
// 认法(先中先得):
//   1. model 带已知厂商前缀 `厂商/型号`: deepseek/ · openai/ · compat/(任意 OpenAI 兼容端点) · anthropic/
//   2. 其余一律按 Anthropic 协议: env.ANTHROPIC_BASE_URL 有值就打那个网关, 否则打官方。
//      这正是 butler 今天的网关模式 —— 不改任何配置就能从 CC SDK 切过来。
// key 只从调用方给的 env 里取, 不让 AI SDK 去读宿主进程的环境变量: butler 为了防外部 ANTHROPIC_* 劫持,
// 每次都显式传一份干净的 env, 这里要守住同一个边界。

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { apiModelId } from './models.js';
import { AccessError } from '../errors.js';
import { withMessageStartDedupe } from './sse-dedupe.js';
import { withStreamToolOrder } from './tool-order.js';
import { withWellFormedBody } from './well-formed.js';

export type Family = 'anthropic' | 'openai' | 'deepseek' | 'compat';

export interface ResolvedModel {
  model: any;          // LanguageModel
  id: string;          // 报给宿主的型号名(原样, 含 [1m] 等后缀)
  family: Family;
  // 这家协议自带的服务端搜索工具(Anthropic web_search / OpenAI Responses web_search); 没有就 undefined
  serverSearch?: () => any;
}

type Env = Record<string, string | undefined>;

function withV1(url: string): string {
  const u = url.replace(/\/+$/, '');
  return /\/v1$/.test(u) ? u : `${u}/v1`;
}

function need(env: Env, key: string, provider: string): string {
  const v = env[key];
  if (!v) throw new AccessError('authentication_failed', null, `${provider}: missing ${key}`);
  return v;
}

// 每个会话固定一个 id 放进请求头: 网关按它做路由和提示缓存(OpenCode Go 没有它直接 400)。
// User-Agent 自报家门 —— 有的网关会拒掉通用 SDK 的默认 UA。
export const USER_AGENT = 'butler-agent-sdk/0.1.0';

function sessionHeaders(sessionId?: string): Record<string, string> {
  return sessionId ? { 'x-opencode-session': sessionId, 'x-session-id': sessionId } : {};
}

export function resolveModel(modelOpt: string | undefined, env: Env, fetchImpl?: typeof fetch, sessionId?: string): ResolvedModel {
  const id = modelOpt || env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || '';
  if (!id) throw new AccessError('model_not_configured', null, 'no model configured (options.model is empty)');
  const m = /^(deepseek|openai|compat|anthropic)\/(.+)$/.exec(id);
  const prefix = m ? m[1] : null;
  const rest = m ? m[2] : id;
  const base = withWellFormedBody(fetchImpl || fetch);   // 所有协议: 发出前删掉半个 emoji(见 well-formed.ts)
  const f = { fetch: base };
  const common = { 'User-Agent': USER_AGENT, ...sessionHeaders(sessionId) };

  if (prefix === 'deepseek') {
    const p = createDeepSeek({ headers: common, apiKey: need(env, 'DEEPSEEK_API_KEY', 'deepseek'), ...(env.DEEPSEEK_BASE_URL ? { baseURL: env.DEEPSEEK_BASE_URL } : {}), ...f });
    return { model: p(rest), id, family: 'deepseek' };
  }
  if (prefix === 'openai') {
    const p = createOpenAI({ headers: common, apiKey: need(env, 'OPENAI_API_KEY', 'openai'), ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}), ...f });
    return { model: p(rest), id, family: 'openai', serverSearch: () => p.tools.webSearch({}) };
  }
  if (prefix === 'compat') {
    const baseURL = need(env, 'OPENAI_BASE_URL', 'compat');
    const p = createOpenAICompatible({ name: 'compat', headers: common, baseURL, apiKey: env.OPENAI_API_KEY, includeUsage: true, ...f });
    return { model: p(rest), id, family: 'compat' };
  }

  // Anthropic 协议(官方或网关)
  const apiKey = env.ANTHROPIC_API_KEY;
  const authToken = env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey && !authToken) {
    if (env.CLAUDE_CODE_OAUTH_TOKEN) {
      throw new AccessError('authentication_failed', null,
        'subscription login is only available through the Claude Agent SDK; configure an API key or a gateway for this SDK');
    }
    throw new AccessError('authentication_failed', null, 'anthropic: missing ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN');
  }
  // 网关有的认 x-api-key、有的认 Bearer(butler 两个都设)。AI SDK 只许二选一, 另一个用头补上。
  const headers: Record<string, string> = { ...common };
  if (apiKey && authToken) headers.Authorization = `Bearer ${authToken}`;
  const p = createAnthropic({
    ...(env.ANTHROPIC_BASE_URL ? { baseURL: withV1(env.ANTHROPIC_BASE_URL) } : {}),
    ...(apiKey ? { apiKey } : { authToken }),
    headers,
    // 开头连发多个 message_start 的网关: 只留最后一个, 与 Claude Code CLI 一致(见 sse-dedupe.ts)
    // 非 Claude 模型(DeepSeek 等)要按流出顺序回传, 撤回 AI SDK 把 tool_use 挪到最后的那一下(见 tool-order.ts)
    fetch: withMessageStartDedupe(/claude|fable|opus|sonnet|haiku/i.test(rest) ? base : withStreamToolOrder(base)),
  });
  // 用最早那版 20250305: 网关转发的大多只认它
  return { model: p(apiModelId(rest)), id, family: 'anthropic', serverSearch: () => p.tools.webSearch_20250305({}) };
}
