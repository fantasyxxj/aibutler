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

test('WebSearch: 有 BRAVE_API_KEY 走 Brave; blocked_domains 过滤', async () => {
  const restore = stubFetch(async (url, init) => {
    assert.match(String(url), /api\.search\.brave\.com/);
    assert.equal(init.headers['X-Subscription-Token'], 'bk');
    return new Response(JSON.stringify({ web: { results: [
      { title: 'Keep', url: 'https://good.jp/a', description: 'ok <b>bold</b>' },
      { title: 'Drop', url: 'https://www.bad.com/b', description: 'x' },
    ] } }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const r = await WebSearch.run({ query: '居酒屋', blocked_domains: ['bad.com'] }, ctx({ env: { BRAVE_API_KEY: 'bk' } }));
    assert.match(text(r), /Keep/);
    assert.match(text(r), /ok bold/);
    assert.doesNotMatch(text(r), /Drop/);
  } finally { restore(); }
});

test('WebSearch: 没 key 走 DuckDuckGo html, 解出标题/链接/摘要', async () => {
  const html = `<div class="result results_links"><div class="links_main"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.jp%2Fmenu&rut=x">月影 <b>メニュー</b></a>
    <a class="result__snippet" href="x">焼き鳥と<b>地酒</b>の店</a></div></div>`;
  const restore = stubFetch(async () => new Response(html, { headers: { 'content-type': 'text/html' } }));
  try {
    const r = await WebSearch.run({ query: '月影' }, ctx());
    assert.match(text(r), /duckduckgo/);
    assert.match(text(r), /月影 メニュー/);
    assert.match(text(r), /https:\/\/example\.jp\/menu/);
    assert.match(text(r), /焼き鳥と地酒の店/);
  } finally { restore(); }
});
