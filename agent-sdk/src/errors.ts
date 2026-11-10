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
  // 服务商因为这次提交的内容拒收(超长 / 图片太大): 改了内容再发能救回来, 跟配置错误分开。limit = 报错里写的上限数字
  rejected?: 'prompt' | 'image';
  limit?: number;
}

// 先凭状态码认定出错(400 / 413), 再看报错说的是哪种内容问题。字串照 Claude Code 认的那几组, 外加各家自己的说法
// (智谱 1261「Prompt exceeds max length」)。
const IMAGE_REJECT = /could not process image|image exceeds|image dimensions exceed|image does not match the provided media type|images? (is |are )?too large|exceeds api limit|images exceed the api limit|image size/i;
const PROMPT_REJECT = /prompt is too long|input is too long|exceeds max(imum)? length|context (window|length)|maximum context|too many (input )?tokens|token limit|prompt exceeds/i;

function rejection(status: number, text: string): { rejected?: 'prompt' | 'image'; limit?: number } {
  if (IMAGE_REJECT.test(text)) {
    const px = text.match(/(\d{3,5})\s*(?:x\s*\d{3,5}\s*)?(?:px|pixels)/i);
    return { rejected: 'image', ...(px ? { limit: Number(px[1]) } : {}) };
  }
  if (PROMPT_REJECT.test(text) || status === 413) return { rejected: 'prompt' };
  return {};
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
  // 2xx 还出错 = 已经开流、读正文时断了(AI SDK 把它包成 statusCode=200 的 "Failed to process successful response"):
  // 跟没收到结束块一样是断流, 重发。那个 200 是开流时的响应头, 不是这次错误的状态, 报出去只会让人看不懂, 所以记空;
  // 底层原因(读超时 / 对方关连接)带在消息里进日志。11-10 老黄 glm-5.3-flash 中途 5 分钟没数据被读超时掐断
  if (status >= 200 && status < 300) return { kind: 'unknown', status: null, retryable: true, message: `reply stream broke off midway (${rootCause(e)})` };
  if (status === 401 || status === 403) return { kind: 'authentication_failed', status, retryable: false, message };
  if (status === 402) return { kind: 'billing_error', status, retryable: false, message };
  if (status === 429) {
    // 余额不足有的家报 429, 正文里带 quota / balance / insufficient
    const billing = /quota|balance|insufficient|credit/i.test(body);
    return { kind: billing ? 'billing_error' : 'rate_limit', status, retryable: !billing, message };
  }
  if (status >= 500) return { kind: 'server_error', status, retryable: true, message };
  if (status === 408 || status === 409) return { kind: 'unknown', status, retryable: true, message };
  return { kind: 'invalid_request', status, retryable: false, message, ...((status === 400 || status === 413) ? rejection(status, message) : {}) };
}

// cause 链最底下那个: 读超时是 UND_ERR_BODY_TIMEOUT, 对方关连接多是 UND_ERR_SOCKET / ECONNRESET
function rootCause(e: any): string {
  let cur = e?.cause ?? e;
  for (let i = 0; i < 8 && cur?.cause; i++) cur = cur.cause;
  const code = typeof cur?.code === 'string' ? `${cur.code}: ` : '';
  return `${code}${String(cur?.message || cur || 'unknown')}`.slice(0, 200);
}

// 指数退避: 1s 2s 4s 8s …, 封顶 30s, 加 0~25% 抖动
export function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** (attempt - 1));
  return Math.round(base * (1 + Math.random() * 0.25));
}
