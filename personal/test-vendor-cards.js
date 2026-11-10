// test-vendor-cards.js — 设置页加 key 先选厂家: 凭据记住是哪家, 测一下按那家的路走
require('./host-wiring');
const fs = require('fs');
const path = require('path');
const cred = require('../core/credentials');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ' + l); } else { fail++; console.log('  FAIL ' + l); } };
const mem = () => {
  let s = { credentials: [] }; const box = {};
  return {
    settings: { read: () => JSON.parse(JSON.stringify(s)), write: (w) => { s = { ...s, ...w }; } },
    secrets: { set: (k, v) => { box[k] = v; return { ok: true }; }, get: (k) => box[k] || '', status: (k) => (box[k] ? 'ok' : 'none'), available: () => true },
  };
};

(async () => {
  console.log('\n== 凭据记住厂家 ==');
  const d = mem();
  const r = cred.save(d, { name: '千问', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', vendor: 'qwen', apiKey: 'sk-x' });
  ok(r.ok, '存得进');
  const row = () => cred.list({ ...d, defaultName: 'x' }).credentials.find((c) => c.id === r.id);
  ok(row().vendor === 'qwen', 'list 带回 vendor');
  cred.save(d, { id: r.id, name: '千问改名', base_url: row().base_url });
  ok(row().vendor === 'qwen', '不传 vendor 的改名保存不丢厂家');
  cred.save(d, { id: r.id, name: '其他', base_url: 'https://gw.example', vendor: '' });
  ok(row().vendor === '', '显式传空 = 改成「其他」');
  const r2 = cred.save(d, { name: '老的', base_url: '', apiKey: 'sk-ant-y' });
  ok(row && cred.list({ ...d, defaultName: 'x' }).credentials.find((c) => c.id === r2.id).vendor === '', '没选厂家的老写法照旧');
  const rp = cred.save(d, { name: '中转', base_url: 'https://oneapi.example/v1', protocol: 'compat', apiKey: 'sk-z' });
  const row3 = () => cred.list({ ...d, defaultName: 'x' }).credentials.find((c) => c.id === rp.id);
  ok(row3().protocol === 'compat', 'list 带回 protocol');
  cred.save(d, { id: rp.id, name: '中转改名', base_url: 'https://oneapi.example/v1' });
  ok(row3().protocol === 'compat', '不传 protocol 的保存不丢协议');
  cred.save(d, { id: rp.id, name: '中转', base_url: 'https://oneapi.example/v1', protocol: '' });
  ok(row3().protocol === '', '显式传空 = 改回自动');

  console.log('\n== 地址规整 ==');
  const n = cred.normalizeBaseUrl;
  ok(n('ttps://gptproto.com') === 'https://gptproto.com', '少打 h 的补上');
  ok(n('gptproto.com') === 'https://gptproto.com' && n('wucur.com:6543') === 'https://wucur.com:6543', '没写协议的补 https://');
  ok(n('http://wucur.com:6543') === 'http://wucur.com:6543' && n('') === '', '对的原样 · 空的照旧空');
  ok(n('ftp://x.com') === null && n('不是地址') === null, '别的协议 / 乱填 → 判错');
  ok(cred.save(mem(), { name: 'x', base_url: '不是地址', apiKey: 'k' }).error === 'bad_url', '存的时候拦下, 回 bad_url');
  const d2 = mem(); const r3 = cred.save(d2, { name: 'gp', base_url: 'ttps://gptproto.com', apiKey: 'k' });
  ok(cred.list({ ...d2, defaultName: 'x' }).credentials.find((c) => c.id === r3.id).base_url === 'https://gptproto.com', '存下的是补好的地址');
  const es = fs.readFileSync(path.join(__dirname, 'renderer/empty-state.js'), 'utf8');
  ok(/cur\.base_url \|\| ''\}`/.test(es), '首启屏: 同一条 key 改了地址也重拉清单');

  console.log('\n== 测一下: Claude 以外按厂家试通 ==');
  const realFetch = global.fetch; const hits = [];
  global.fetch = async (u) => { hits.push(String(u)); return { ok: false, status: 401, text: async () => '{"error":{"type":"auth"}}', json: async () => ({}) }; };
  const t = await cred.test(d, { name: 'k', base_url: '', vendor: 'openai', apiKey: 'sk-bad' });
  global.fetch = realFetch;
  ok(t.ok === false && !!t.reason, `OpenAI 的 key 走选档那条路, 回原因(${t.reason})`);
  ok(hits.length && hits.every((u) => !/\/v1\/messages/.test(u)), '没去打 Anthropic 的 /v1/messages');

  console.log('\n== 没定协议的网关: Anthropic 发不通就探 OpenAI 兼容 ==');
  {
    const realFetch = global.fetch; const urls = [];
    global.fetch = async (u) => { u = String(u); urls.push(u);
      if (/\/messages$/.test(u)) return { ok: false, status: 404, text: async () => 'not found' };
      if (/^https:\/\/oneapi\.example\/v1\/chat\/completions$/.test(u)) return { ok: true, status: 200, text: async () => '{}' };
      if (/\/models/.test(u)) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-x' }] }) };
      return { ok: false, status: 404, text: async () => '' }; };
    const g = await cred.test(mem(), { apiKey: 'k', base_url: 'https://oneapi.example' });
    ok(g.ok && g.protocol === 'compat' && g.base_url === 'https://oneapi.example/v1' && g.model === 'compat/gpt-x', `探出 OpenAI 兼容并补 /v1: ${JSON.stringify(g)}`);
    urls.length = 0;
    global.fetch = async (u) => { u = String(u); urls.push(u);
      if (/\/messages$/.test(u)) return { ok: true, status: 200, text: async () => '{}' };
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-haiku-x' }] }) }; };
    const a = await cred.test(mem(), { apiKey: 'k', base_url: 'https://gw.example' });
    ok(a.ok && a.protocol === 'anthropic' && !urls.some((u) => /chat\/completions/.test(u)), 'Anthropic 发得通就认 Anthropic, 不再试别的');
    urls.length = 0;
    const e = await cred.test(mem(), { apiKey: 'k', base_url: 'https://gw.example', protocol: 'compat' });
    ok(urls.some((u) => /chat\/completions/.test(u)) && !urls.some((u) => /\/messages$/.test(u)), '手选了 OpenAI 兼容就只按它试');
    urls.length = 0;
    global.fetch = async (u) => { u = String(u); urls.push(u);
      if (/\/messages$/.test(u)) return { ok: false, status: 529, text: async () => 'overloaded' };
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-haiku-x' }] }), text: async () => '{}' }; };
    const o = await cred.test(mem(), { apiKey: 'k', base_url: 'https://gw.example' });
    ok(o.ok && !o.protocol && !urls.some((u) => /chat\/completions/.test(u)), 'Anthropic 口在但这一下没发出去(529): 不改探 OpenAI 兼容');
    global.fetch = realFetch;
  }

  console.log('\n== 界面接线 ==');
  const ui = fs.readFileSync(path.join(__dirname, 'renderer/settings-ui.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, 'renderer/settings.html'), 'utf8');
  ok(/VendorCards\.picker\(/.test(ui) && /_picking = true/.test(ui), '「加一条」先出厂家卡片');
  const at = (f) => html.indexOf(`<script src="${f}"`);
  ok(at('vendor-cards.js') > 0 && at('vendor-cards.js') < at('settings-ui.js'), 'settings.html 在 settings-ui.js 之前载入 vendor-cards.js');
  ok(/vendor: c\.vendor \|\| ''/.test(ui), '保存时带上 vendor');
  ok(/protocol: q\('\.c-proto'\)/.test(ui) && /sys_proto_detected/.test(ui), '保存带上协议, 测出的协议填回下拉');
  ok(/const row = ACL\.lastElementChild;/.test(ui) && !/ACL\.querySelector\(v \?/.test(ui), '选完厂家焦点落在新加那条(列表最后), 不是第一条');

  console.log('\n== 豆包测 key 只看清单(模型要逐个开通, 不真发) ==');
  {
    const realFetch = global.fetch; const urls = [];
    global.fetch = async (u) => { urls.push(String(u)); const good = /models/.test(u);
      return { ok: good, status: good ? 200 : 401, json: async () => ({ data: [{ id: 'doubao-seed-2-0-pro-260215' }, { id: 'doubao-seed-2-1-pro-260915' }] }) }; };
    const g = await cred.test(mem(), { apiKey: 'k-good', vendor: 'doubao', base_url: '' });
    ok(g.ok && urls.every((u) => /\/models$/.test(u)), '豆包: 清单拉得下来就算 key 对, 一条消息都不发');
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    const b = await cred.test(mem(), { apiKey: 'k-bad', vendor: 'doubao', base_url: '' });
    ok(!b.ok && b.reason === 'auth', '豆包: 清单回 401 → key 错');
    global.fetch = realFetch;
  }

  console.log('\n== 建人格模型下拉剔掉不能聊天的(按出厂表 exclude) ==');
  {
    const realFetch = global.fetch;
    const ids = ['doubao-seed-2-0-pro-260215', 'deepseek-v4-pro-260425', 'doubao-seedance-2-0-260128', 'doubao-seedream-5-0-260128', 'doubao-embedding-text-240715', 'hyper3d-gen2-260112'];
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: ids.map((id) => ({ id })) }), text: async () => '' });
    const r = await require('../core/model-options').listModelOptions({ access: { key: 'k', base_url: 'https://ark.cn-beijing.volces.com/api/v3' } });
    const got = r.options.map((o) => o.id).filter(Boolean);
    ok(got.includes('compat/doubao-seed-2-0-pro-260215') && got.includes('compat/deepseek-v4-pro-260425')
      && !got.some((x) => /seedance|seedream|embedding|3d/.test(x)), `豆包下拉只剩能聊天的(代卖的留着): ${got.join(',')}`);
    global.fetch = realFetch;
  }

  console.log('\n== 千问下拉剔掉生成图片 / 视频的(qwen-image · wan*) ==');
  {
    const realFetch = global.fetch;
    const ids = ['qwen3.5-plus', 'qwen-flash', 'qwen-image', 'qwen-image-edit', 'wan2.7-image', 'wan2.5-t2v-preview'];
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: ids.map((id) => ({ id })) }), text: async () => '' });
    const r = await require('../core/model-options').listModelOptions({ access: { key: 'k', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } });
    const got = r.options.map((o) => o.id).filter(Boolean);
    ok(got.includes('compat/qwen3.5-plus') && got.includes('compat/qwen-flash')
      && !got.some((x) => /image|wan/.test(x)), `千问下拉只剩能聊天的: ${got.join(',')}`);
    global.fetch = realFetch;
  }

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
