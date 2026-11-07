// 模型调用出错 → 与 Claude Agent SDK 的 system/api_retry 同一套枚举。
// butler 的 classifySdkError 认的就是这几个: authentication_failed / oauth_org_not_allowed /
// billing_error / rate_limit / invalid_request; 认不出的给 server_error / unknown, 宿主会退回原文判断。

import { NoOutputGeneratedError, InvalidResponseDataError } from 'ai';

// 回复说到一半流就断了: AI SDK 不抛错, 只把这一步的 finishReason 标成 interrupted(Anthropic / OpenAI / DeepSeek 实测)。
// step.ts 认到它就抛这个, 走和断流一样的重试。
export class StreamCut extends Error {
  constructor(public partialText: string) { super('stream ended mid-reply (finishReason=interrupted)'); }
}

// model_not_configured 是本 SDK 独有的: Claude Code 有自带默认模型, 不会出这种错; 这里没有, 空着就报它。
export type ApiErrorKind =
  | 'authentication_failed' | 'billing_error' | 'rate_limit'
  | 'invalid_request' | 'server_error' | 'unknown' | 'model_not_configured';

export class AccessError extends Error {
  constructor(public kind: ApiErrorKind, public status: number | null, message: string) {
    super(message);
  }
}

export interface ClassifiedError {
  kind: ApiErrorKind;
  status: number | null;
  retryable: boolean;
  message: string;
}

export function classify(e: any): ClassifiedError {
  if (e instanceof AccessError) return { kind: e.kind, status: e.status, retryable: false, message: e.message };
  const status: number | null = typeof e?.statusCode === 'number' ? e.statusCode
    : typeof e?.status === 'number' ? e.status : null;
  const body = String(e?.responseBody || '');
  const message = String(e?.message || e || 'unknown error') + (body ? ` · ${body.slice(0, 300)}` : '');
  if (status == null) {
    // 没有状态码: 网络层(断线 / 超时 / DNS)值得重试; 请求本身不合法(AI SDK 的 InvalidPrompt 之类)重试也是白费
    // 流中途断开、没收到结束块: AI SDK 抛 NoOutputGeneratedError —— 按错误类型认, 网关抖一下重发就好
    // 断流的三种样子, 都按错误类型认: 一个字没出就断(NoOutputGeneratedError) · 说到一半断(StreamCut, 见 step.ts) ·
    // OpenAI 兼容协议没收到结束原因就断(它抛 InvalidResponseDataError, 11-07 假网关实测)
    const cut = e instanceof StreamCut || NoOutputGeneratedError.isInstance(e) || InvalidResponseDataError.isInstance(e);
    const net = cut || e?.isRetryable === true || /fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket|network|terminated|timeout/i.test(message);
    return { kind: 'unknown', status: null, retryable: net, message };
  }
  if (status === 401 || status === 403) return { kind: 'authentication_failed', status, retryable: false, message };
  if (status === 402) return { kind: 'billing_error', status, retryable: false, message };
  if (status === 429) {
    // 余额不足有的家报 429, 正文里带 quota / balance / insufficient
    const billing = /quota|balance|insufficient|credit/i.test(body);
    return { kind: billing ? 'billing_error' : 'rate_limit', status, retryable: !billing, message };
  }
  if (status >= 500) return { kind: 'server_error', status, retryable: true, message };
  if (status === 408 || status === 409) return { kind: 'unknown', status, retryable: true, message };
  return { kind: 'invalid_request', status, retryable: false, message };
}

// 指数退避: 1s 2s 4s 8s …, 封顶 30s, 加 0~25% 抖动
export function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** (attempt - 1));
  return Math.round(base * (1 + Math.random() * 0.25));
}
