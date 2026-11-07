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

  console.log('\n== 界面接线 ==');
  const ui = fs.readFileSync(path.join(__dirname, 'renderer/settings-ui.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, 'renderer/settings.html'), 'utf8');
  ok(/VendorCards\.picker\(/.test(ui) && /_picking = true/.test(ui), '「加一条」先出厂家卡片');
  const at = (f) => html.indexOf(`<script src="${f}"`);
  ok(at('vendor-cards.js') > 0 && at('vendor-cards.js') < at('settings-ui.js'), 'settings.html 在 settings-ui.js 之前载入 vendor-cards.js');
  ok(/vendor: c\.vendor \|\| ''/.test(ui), '保存时带上 vendor');
  ok(/const row = ACL\.lastElementChild;/.test(ui) && !/ACL\.querySelector\(v \?/.test(ui), '选完厂家焦点落在新加那条(列表最后), 不是第一条');

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
