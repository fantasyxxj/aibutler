// WebFetch / WebSearch。只用 fetch, 属于核心层(手机上也能跑)。参数名照 Claude Code 的同名工具。
//
// WebFetch: 抓页面 → 去标签成正文。正文长、又给了 prompt 时, 用当前会话的模型读一遍再回答
//   (ctx.complete 由 loop 提供), 免得整页几万字塞进上下文。
// WebSearch: env 里有 BRAVE_API_KEY 用 Brave, 有 TAVILY_API_KEY 用 Tavily, 都没有走 DuckDuckGo 的 html 版。

import type { BuiltinTool, ToolOutput } from './registry.js';

const ok = (text: string): ToolOutput => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolOutput => ({ content: [{ type: 'text', text: `<tool_use_error>${text}</tool_use_error>` }], isError: true });
const UA = 'Mozilla/5.0 (compatible; butler-agent-sdk/0.1; +https://github.com/)';
const MAX_DIRECT = 12_000;     // 不经模型直接返回的正文上限
const MAX_FOR_MODEL = 100_000; // 交给模型读的正文上限

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENT[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): string {
  let s = html.replace(/<(script|style|noscript|svg|head|template)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => {
    const txt = t.replace(/<[^>]+>/g, '').trim();
    return txt && /^https?:/.test(href) ? `[${txt}](${href})` : txt;
  });
  s = s.replace(/<h([1-6])[^>]*>/gi, (_m, n) => `\n\n${'#'.repeat(Number(n))} `);
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<(br|\/p|\/div|\/tr|\/h[1-6]|\/section|\/article|\/header|\/footer)[^>]*>/gi, '\n');
  s = s.replace(/<(td|th)[^>]*>/gi, ' | ');
  s = s.replace(/<[^>]+>/g, '');
  s = decode(s);
  return s.split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export const WebFetch: BuiltinTool = {
  name: 'WebFetch',
  description: 'Fetches a URL, converts the page to text, and answers `prompt` against it. HTTP is upgraded to HTTPS. '
    + 'Fails on authenticated/private pages.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch content from' },
      prompt: { type: 'string', description: 'What to extract or answer from the page' },
    },
    required: ['url'],
  },
  async run(input, ctx) {
    let url = String(input.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return fail(`Invalid URL: ${url}`);
    url = url.replace(/^http:\/\//i, 'https://');
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5' }, redirect: 'follow', signal: ctx.signal });
    } catch (e: any) { return fail(`Fetch failed: ${e && e.message}`); }
    if (!res.ok) return fail(`HTTP ${res.status} ${res.statusText} for ${url}`);
    const type = res.headers.get('content-type') || '';
    if (!/text|json|xml|javascript/.test(type)) return fail(`Unsupported content type: ${type || 'unknown'}`);
    const raw = await res.text();
    const text = /html|xml/.test(type) ? htmlToText(raw) : raw;
    const head = `URL: ${res.url || url}\n\n`;
    const prompt = String(input.prompt || '').trim();
    if (text.length <= MAX_DIRECT || !prompt || !ctx.complete) {
      const body = text.length > MAX_DIRECT ? `${text.slice(0, MAX_DIRECT)}\n\n[truncated: ${text.length} characters total]` : text;
      return ok(head + body);
    }
    try {
      const answer = await ctx.complete(
        'You read a web page on behalf of an agent. Answer the request using only the page content. Quote exact figures, names and dates. Say so if the page does not contain the answer.',
        `Request: ${prompt}\n\n--- page content ---\n${text.slice(0, MAX_FOR_MODEL)}`,
      );
      return ok(head + answer);
    } catch (e: any) {
      return ok(`${head}${text.slice(0, MAX_DIRECT)}\n\n[truncated; summarising failed: ${e && e.message}]`);
    }
  },
};

interface Hit { title: string; url: string; snippet: string }

async function braveSearch(q: string, key: string, signal: AbortSignal): Promise<Hit[]> {
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=10`, { headers: { Accept: 'application/json', 'X-Subscription-Token': key }, signal });
  if (!r.ok) throw new Error(`Brave HTTP ${r.status}`);
  const j: any = await r.json();
  return (j.web?.results || []).map((x: any) => ({ title: x.title, url: x.url, snippet: htmlToText(x.description || '') }));
}

async function tavilySearch(q: string, key: string, signal: AbortSignal): Promise<Hit[]> {
  const r = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ query: q, max_results: 10 }), signal });
  if (!r.ok) throw new Error(`Tavily HTTP ${r.status}`);
  const j: any = await r.json();
  return (j.results || []).map((x: any) => ({ title: x.title, url: x.url, snippet: x.content || '' }));
}

async function ddgSearch(q: string, signal: AbortSignal): Promise<Hit[]> {
  const r = await fetch('https://html.duckduckgo.com/html/', { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `q=${encodeURIComponent(q)}`, signal });
  if (!r.ok) throw new Error(`DuckDuckGo HTTP ${r.status}`);
  // 查得太密时 DuckDuckGo 回 202 + 人机验证页: 不是「没搜到」, 照实报失败, 模型才会换法子
  if (r.status === 202) throw new Error('DuckDuckGo is rate-limiting this machine (HTTP 202); retry later, or ask the user to set a Brave/Tavily key in settings');
  const html = await r.text();
  // 按结果块切开再各自取标题和摘要 —— 一条正则跨块配对会把摘要配错或配空
  const hits: Hit[] = [];
  for (const block of html.split(/class="result results_links|class="result__body/).slice(1)) {
    const a = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    let url = decode(a[1]);
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    if (hits.some((h) => h.url === url)) continue;
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(block);
    hits.push({ title: htmlToText(a[2]), url, snippet: sn ? htmlToText(sn[1]) : '' });
    if (hits.length >= 10) break;
  }
  return hits;
}

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; } };
const inDomains = (u: string, ds: string[]) => ds.some((d) => { const h = host(u); const x = d.replace(/^www\./, ''); return h === x || h.endsWith(`.${x}`); });

export const WebSearch: BuiltinTool = {
  name: 'WebSearch',
  description: 'Searches the web and returns result titles, URLs and snippets. Use allowed_domains / blocked_domains to filter. '
    + 'Cite the URLs you rely on.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only include results from these domains' },
      blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Never include results from these domains' },
    },
    required: ['query'],
  },
  async run(input, ctx) {
    const q = String(input.query || '').trim();
    if (!q) return fail('query is empty');
    const allow: string[] = Array.isArray(input.allowed_domains) ? input.allowed_domains : [];
    const block: string[] = Array.isArray(input.blocked_domains) ? input.blocked_domains : [];
    // 只允许某几个站时把 site: 拼进查询, 否则后端给的前十条可能一条都不在名单里
    const query = allow.length ? `${q} ${allow.map((d) => `site:${d}`).join(' OR ')}` : q;
    let hits: Hit[];
    let engine: string;
    try {
      // 用户勾了优先哪家就先用哪家; 没勾则有哪把 key 用哪把, 都没有才去 DuckDuckGo
      const useTavily = !!ctx.env.TAVILY_API_KEY && (ctx.env.BUTLER_SEARCH_PREFER === 'tavily' || !ctx.env.BRAVE_API_KEY);
      if (ctx.env.BRAVE_API_KEY && !useTavily) { engine = 'brave'; hits = await braveSearch(query, ctx.env.BRAVE_API_KEY, ctx.signal); }
      else if (useTavily) { engine = 'tavily'; hits = await tavilySearch(query, ctx.env.TAVILY_API_KEY!, ctx.signal); }
      else { engine = 'duckduckgo'; hits = await ddgSearch(query, ctx.signal); }
    } catch (e: any) { return fail(`Search failed: ${e && e.message}`); }
    if (allow.length) hits = hits.filter((h) => inDomains(h.url, allow));
    if (block.length) hits = hits.filter((h) => !inDomains(h.url, block));
    if (!hits.length) return ok(`Web search results for "${q}" (${engine}): no results.`);
    const lines = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet.slice(0, 300)}` : ''}`);
    return ok(`Web search results for "${q}" (${engine}):\n\n${lines.join('\n\n')}`);
  },
};

export function webTools(): BuiltinTool[] {
  return [WebFetch, WebSearch];
}
