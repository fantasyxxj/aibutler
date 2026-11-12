// 发出去的请求里不许有半个 emoji(孤立的 UTF-16 代理项)。
// 文字按长度截断时会把 emoji 从中间切开, JSON.stringify 把剩下那半个写成 `\ud83d`:
// DeepSeek 报 400「unexpected end of hex escape」, 智谱报 500「surrogates not allowed」。
// 坏字符可能来自任何地方(工具返回、记忆、聊天记录), 所以在这一处统一删掉, 所有协议都过这里。

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// 请求体是 JSON 文本, 代理项一律写成 \uXXXX 转义; 一个都没有就不用解析
const ESCAPED = /\\u[dD][89a-fA-F]/;

export function dropLoneSurrogates(s: string): string {
  return s.replace(LONE, '');
}

// 截文字不切开 emoji: 取前 n / 后 n 个 UTF-16 单元, 切口正好在 emoji 中间就让一个
export function head(s: string, n: number): string {
  const t = s.slice(0, Math.max(0, n));
  return /[\uD800-\uDBFF]$/.test(t) ? t.slice(0, -1) : t;
}
export function tail(s: string, n: number): string {
  if (n <= 0) return '';
  const t = s.slice(-n);
  return /^[\uDC00-\uDFFF]/.test(t) ? t.slice(1) : t;
}

function clean(v: any): any {
  if (typeof v === 'string') return dropLoneSurrogates(v);
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') {
    const o: any = {};
    for (const k of Object.keys(v)) o[dropLoneSurrogates(k)] = clean(v[k]);
    return o;
  }
  return v;
}

export function wellFormedBody(body: string): string {
  if (!ESCAPED.test(body)) return body;
  try { return JSON.stringify(clean(JSON.parse(body))); }
  catch { return body; }   // 不是 JSON 就原样发
}

export function withWellFormedBody(base: typeof fetch): typeof fetch {
  return (async (url: any, init?: any) => {
    if (init && typeof init.body === 'string') init = { ...init, body: wellFormedBody(init.body) };
    return base(url, init);
  }) as typeof fetch;
}
