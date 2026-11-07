// WebFetch / WebSearch: 用替身 fetch 离线测, 不打真网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebFetch, WebSearch, htmlToText } from '../dist/index.js';

const ctx = (extra = {}) => ({ signal: new AbortController().signal, env: {}, ...extra });
function stubFetch(fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = fn;
  return () => { globalThis.fetch = orig; };
}
const text = (o) => o.content.map((c) => c.text).join('\n');
const eng = (...list) => ({ BUTLER_SEARCH_ENGINES: JSON.stringify(list) });

test('htmlToText: 去 script/style, 保留标题/列表/链接, 解实体', () => {
  const t = htmlToText('<html><head><title>x</title><style>a{}</style></head><body><h1>店休</h1><p>每周&nbsp;三 &amp; 四</p><ul><li>A</li><li>B</li></ul><a href="https://x.jp/a">链接</a><script>evil()</script></body></html>');
  assert.match(t, /# 店休/);
  assert.match(t, /每周 三 & 四/);
  assert.match(t, /- A\n- B/);
  assert.match(t, /\[链接\]\(https:\/\/x\.jp\/a\)/);
  assert.doesNotMatch(t, /evil|a\{\}/);
});

test('WebFetch: http 升 https; 短页直接返回; 长页带 prompt 交给模型读', async () => {
  const seen = [];
  const restore = stubFetch(async (url) => {
    seen.push(String(url));
    const long = String(url).includes('long');
    return new Response(`<p>${long ? '营业时间 11:00-22:00。'.repeat(2000) : 'short page'}</p>`, { headers: { 'content-type': 'text/html' } });
  });
  try {
    const a = await WebFetch.run({ url: 'http://shop.test/short' }, ctx());
    assert.equal(seen[0], 'https://shop.test/short');
    assert.match(text(a), /short page/);
    let asked = null;
    const b = await WebFetch.run({ url: 'https://shop.test/long', prompt: '几点开门' }, ctx({ complete: async (sys, user) => { asked = user; return '11:00 开门'; } }));
    assert.match(text(b), /11:00 开门/);
    assert.match(asked, /几点开门/);
    const bad = await WebFetch.run({ url: 'ftp://x' }, ctx());
    assert.equal(bad.isError, true);
  } finally { restore(); }
});

test('WebSearch: 引擎表里配了 Brave 就带 key 走 Brave; blocked_domains 过滤', async () => {
  const restore = stubFetch(async (url, init) => {
    assert.match(String(url), /api\.search\.brave\.com/);
    assert.equal(init.headers['X-Subscription-Token'], 'bk');
    return new Response(JSON.stringify({ web: { results: [
      { title: 'Keep', url: 'https://good.jp/a', description: 'ok <b>bold</b>' },
      { title: 'Drop', url: 'https://www.bad.com/b', description: 'x' },
    ] } }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const r = await WebSearch.run({ query: '居酒屋', blocked_domains: ['bad.com'] }, ctx({ env: eng({ type: 'brave', key: 'bk' }) }));
    assert.match(text(r), /Keep/);
    assert.match(text(r), /ok bold/);
    assert.doesNotMatch(text(r), /Drop/);
  } finally { restore(); }
});

test('WebSearch: 已拿掉的 Bing / DuckDuckGo 出现在引擎表里也不去抓, 当没配', async () => {
  const restore = stubFetch(async () => { throw new Error('should not fetch'); });
  try {
    const r = await WebSearch.run({ query: 'x' }, ctx({ env: eng({ type: 'bing' }, { type: 'duckduckgo' }) }));
    assert.equal(r.isError, true);
    assert.match(text(r), /no search engine configured/);
  } finally { restore(); }
});

test('WebSearch: 按用户排的顺序试, 前一家报错就换下一家, 全挂才报失败并列出每家原因', async () => {
  const seen = [];
  const restore = stubFetch(async (url) => {
    seen.push(String(url));
    if (/brave/.test(String(url))) throw new Error('connect ETIMEDOUT');
    return new Response(JSON.stringify({ results: [{ title: 'T', url: 'https://t.cn/', content: 'tav' }] }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const r = await WebSearch.run({ query: 'x' }, ctx({ env: eng({ type: 'brave', key: 'bk' }, { type: 'tavily', key: 'tk' }) }));
    assert.match(seen[0], /brave/);
    assert.match(seen[1], /tavily/);
    assert.match(text(r), /\(tavily\)/);
  } finally { restore(); }
  const restore2 = stubFetch(async () => { throw new Error('blocked'); });
  try {
    const r = await WebSearch.run({ query: 'x' }, ctx({ env: eng({ type: 'brave', key: 'bk' }, { type: 'tavily', key: 'tk' }) }));
    assert.equal(r.isError, true);
    assert.match(text(r), /brave: blocked · tavily: blocked/);
  } finally { restore2(); }
});

test('searchChain: 一家卡住只等到超时就换下一家, 不拖整条', async () => {
  const { searchChain } = await import('../dist/tools/search-engines.js');
  const restore = stubFetch(async (url, init) => {
    if (/brave/.test(String(url))) return new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    return new Response(JSON.stringify({ results: [{ title: 'S', url: 'https://s.org/', content: '' }] }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const t0 = Date.now();
    const r = await searchChain('x', [{ type: 'brave', key: 'bk' }, { type: 'searxng', url: 'https://searx.test/' }], new AbortController().signal, { ua: 'u', text: (s) => s, decode: (s) => s }, 200);
    assert.equal(r.engine, 'searxng');
    assert.ok(Date.now() - t0 < 2000);
  } finally { restore(); }
});

test('WebSearch: 引擎表为空时不去任何地方搜, 直接报没配', async () => {
  const restore = stubFetch(async () => { throw new Error('should not fetch'); });
  try {
    const r = await WebSearch.run({ query: 'x' }, ctx());
    assert.equal(r.isError, true);
    assert.match(text(r), /no search engine configured/);
  } finally { restore(); }
});
