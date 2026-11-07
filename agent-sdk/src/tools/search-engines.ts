// 本机 WebSearch 的搜索引擎。用户在设置里自己加、自己排先后(见 core/search-keys.js),
// 经 env.BUTLER_SEARCH_ENGINES 传进来: JSON 数组 [{ type, key?, url? }], 排前的先试。
//
// 一家失败(连不上 / 超时 / 报错 / 一条结果都没解出来)就换下一家, 全挂才报错 ——
// 大陆直连 Brave 会被挡到超时(11-06 实测), 所以每家只等 ENGINE_TIMEOUT_MS。
// 不要 key 的 Bing / DuckDuckGo 抓网页 11-07 拿掉: 回的是凑数页面或人机验证页, 见 butler core/search-keys.js。
// 加一种引擎 = 在 ENGINES 里登记一个函数 + 设置页 core/search-keys.js 的 TYPES 加一项。

export interface Hit { title: string; url: string; snippet: string }
export interface EngineConf { type: string; key?: string; url?: string }
type Search = (q: string, conf: EngineConf, signal: AbortSignal, util: Util) => Promise<Hit[]>;
interface Util { ua: string; text: (html: string) => string; decode: (s: string) => string }

export const ENGINE_TIMEOUT_MS = 8_000;

async function brave(q: string, c: EngineConf, signal: AbortSignal, u: Util): Promise<Hit[]> {
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=10`, { headers: { Accept: 'application/json', 'X-Subscription-Token': c.key || '' }, signal });
  if (!r.ok) throw new Error(`Brave HTTP ${r.status}`);
  const j: any = await r.json();
  return (j.web?.results || []).map((x: any) => ({ title: x.title, url: x.url, snippet: u.text(x.description || '') }));
}

async function tavily(q: string, c: EngineConf, signal: AbortSignal): Promise<Hit[]> {
  const r = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.key || ''}` }, body: JSON.stringify({ query: q, max_results: 10 }), signal });
  if (!r.ok) throw new Error(`Tavily HTTP ${r.status}`);
  const j: any = await r.json();
  return (j.results || []).map((x: any) => ({ title: x.title, url: x.url, snippet: x.content || '' }));
}

// 用户自己架的 SearXNG: 实例要在 settings.yml 的 search.formats 里开 json, 否则回 403
async function searxng(q: string, c: EngineConf, signal: AbortSignal, u: Util): Promise<Hit[]> {
  const base = String(c.url || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('SearXNG address is not set');
  const r = await fetch(`${base}/search?q=${encodeURIComponent(q)}&format=json`, { headers: { Accept: 'application/json', 'User-Agent': u.ua }, signal });
  if (!r.ok) throw new Error(`SearXNG HTTP ${r.status}${r.status === 403 ? ' (enable the json format on the instance)' : ''}`);
  const j: any = await r.json();
  return (j.results || []).slice(0, 10).map((x: any) => ({ title: x.title || '', url: x.url, snippet: u.text(x.content || '') }));
}

export const ENGINES: Record<string, Search> = { brave, tavily, searxng };

export function parseEngines(raw: string | undefined): EngineConf[] {
  try {
    const a = JSON.parse(String(raw || '[]'));
    return Array.isArray(a) ? a.filter((e) => e && ENGINES[e.type]) : [];
  } catch (_) { return []; }
}

// 外层信号一断(用户中止)就整条停; 单家超时只断这一家
function withTimeout(outer: AbortSignal, ms: number): { signal: AbortSignal; done: () => void } {
  const ac = new AbortController();
  const stop = () => ac.abort();
  if (outer.aborted) ac.abort(); else outer.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => ac.abort(new Error(`timed out after ${ms / 1000}s`)), ms);
  return { signal: ac.signal, done: () => { clearTimeout(timer); outer.removeEventListener('abort', stop); } };
}

export async function searchChain(q: string, engines: EngineConf[], outer: AbortSignal, u: Util, ms = ENGINE_TIMEOUT_MS): Promise<{ engine: string; hits: Hit[] }> {
  const errs: string[] = [];
  for (const e of engines) {
    if (outer.aborted) break;
    const t = withTimeout(outer, ms);
    try {
      const hits = await ENGINES[e.type](q, e, t.signal, u);
      if (hits.length) return { engine: e.type, hits };
      errs.push(`${e.type}: no results`);
    } catch (err: any) {
      errs.push(`${e.type}: ${t.signal.aborted && !outer.aborted ? `timed out after ${ms / 1000}s` : (err && err.message) || err}`);
    } finally { t.done(); }
  }
  // 每家都通了只是没结果 = 真没搜到, 不算失败
  if (errs.length && errs.every((s) => s.endsWith(': no results'))) return { engine: engines.map((e) => e.type).join(', '), hits: [] };
  throw new Error(errs.join(' · ') || 'no search engine configured');
}
