// credentials.js — API 凭据仓库(多条)。名字 + 端点存 settings.credentials, key 一条一把走 secrets 加密。
//
// 为什么是多条(作者 2026-09-09):「多配置几个备用的」—— 一把 key 挂了(额度满/被封/网关抽风)
// 要能当场换一条, 而不是回设置里把唯一那把覆盖掉。所以一条条命名着放, 人格各自认领。
//
// 🔴 仓库归仓库, 启用归人格: 存了不代表用。哪个人格走订阅、哪个走哪条凭据, 是人格自己的
//    accessMode + credentialId(见 core/agent/env.js accessConfig)。用全局开关管每个人格的事
//    正是 2026-08-18 定案要避免的那种别扭。
'use strict';

const { SUBSCRIPTION_TOKEN_KEY } = require('./agent/env');

const API_KEY_SECRET = 'anthropic_api_key';          // 旧的单把凭据, 现在只剩迁移在读
const credSecret = (id) => `${API_KEY_SECRET}:${id}`;

// 旧的"一把 key + 一个端点"搬进凭据表, 变成一条名叫「默认」的。
// 🔴 先复制 → 确认新位置真解得开 → 再删旧的。解不开(stale: 换机器/重装, 密文在但打不开)就
//    只建条目、不碰旧密文 —— 那种情况用户本来就得重填, 删掉等于连"曾经存过"都看不见了。
function migrate({ settings, secrets, defaultName }) {
  const s = settings.read();
  if ((s.credentials || []).length) return;          // 已经是新结构
  const old = s.access || {};
  if (secrets.status(API_KEY_SECRET) === 'none' && !old.base_url) return;   // 从没配过, 没什么可搬
  const id = 'default';
  const plain = secrets.get(API_KEY_SECRET);
  if (plain) {
    const r = secrets.set(credSecret(id), plain);
    if (!r.ok) { console.error('[cred] 迁移失败(钥匙串不可用), 旧凭据原样留着'); return; }
    if (secrets.get(credSecret(id)) === plain) secrets.set(API_KEY_SECRET, '');
  }
  settings.write({ credentials: [{ id, name: defaultName, base_url: old.base_url || '' }],
                   defaultCredentialId: id });
  console.log(`[cred] 旧凭据已迁成「${defaultName}」${plain ? '(含 key)' : '(密文解不开, 只建了条目)'}`);
}

// 仓库里有没有任何一把能用的 key。启动期的"要不要拦着登订阅"靠它 ——
// 顺手把迁移做了: 这是开机路径上第一个碰凭据的地方, 比等用户点开设置页要早。
function hasAnyKey({ settings, secrets, defaultName }) {
  migrate({ settings, secrets, defaultName });
  return (settings.read().credentials || []).some((c) => secrets.has(credSecret(c.id)));
}

// key 永远不回渲染层, 只给"存没存过": none / ok / stale
// (stale = 密文还在但这台机器解不开了。当没存处理, 但得说清为什么要重填。)
const row = (secrets) => (c) => ({ id: c.id, name: c.name || '', base_url: c.base_url || '', vendor: c.vendor || '', protocol: c.protocol || '',
                                   keyState: secrets.status(credSecret(c.id)) });

// 订阅长效 token(`claude setup-token` 产出)。存了它, buildEnv 就把 CLAUDE_CODE_OAUTH_TOKEN
// 注给子进程, CLI 认到就不再读 keychain —— 那条会偶发断裂、断了就得人工重登的 refreshToken
// 续期链被整个绕开。这是无人值守场景下 401 的根治手段, 不是又一把 API key。
// 真值同样不回渲染层, 只给 none / ok / stale。
function subTokenState({ secrets }) {
  return { state: secrets.status(SUBSCRIPTION_TOKEN_KEY), keychain: secrets.available() };
}

// 三态与 apiKey 同口径: undefined/'' = 不动已存的 · null = 删掉 · 串 = 换成这个。
// 🔴 换完要重起人格子进程才生效: env 是 spawn 那一刻拼死的, 活着的子进程改不了。
function saveSubToken({ secrets }, token) {
  if (token === null) return secrets.set(SUBSCRIPTION_TOKEN_KEY, '');
  const t = String(token == null ? '' : token).trim();
  if (!t) return { ok: true, unchanged: true };
  return secrets.set(SUBSCRIPTION_TOKEN_KEY, t);
}

function list({ settings, secrets, defaultName, subLoggedIn }) {
  migrate({ settings, secrets, defaultName });
  const s = settings.read();
  return {
    credentials: (s.credentials || []).map(row(secrets)),
    defaultCredentialId: s.defaultCredentialId || '',
    subLoggedIn,
    keychain: secrets.available(),
  };
}

// 地址规整: 少打 h 的补上, 没写协议的补 https://; 剩下不是 http(s):// 开头的算填错 → null。
// 不规整的话错地址会照样存下, 到拉清单时只剩一句 fetch failed, 谁也看不出是少了个字母。
function normalizeBaseUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  if (/^ttps?:\/\//i.test(u)) u = 'h' + u;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(u)) u = 'https://' + u;
  try { const p = new URL(u); if (p.protocol !== 'http:' && p.protocol !== 'https:') return null; } catch (_) { return null; }
  return u;
}

// 新增或改一条。id 空 = 新增。apiKey 三态: undefined/'' = 不动已存的那把 · null = 删掉 · 串 = 换成这个
function save({ settings, secrets }, patch = {}) {
  const name = String(patch.name || '').trim();
  if (!name) return { ok: false, error: 'name_required' };
  const base_url = normalizeBaseUrl(patch.base_url);
  if (base_url === null) return { ok: false, error: 'bad_url' };
  const s = settings.read();
  const all = [...(s.credentials || [])];
  // 只靠毫秒时间戳的话, 同一毫秒连存两条会撞成同一个 id, 后一条把前一条覆盖掉
  const id = patch.id || `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  if (patch.apiKey === null) secrets.set(credSecret(id), '');
  else if (patch.apiKey) {
    // 钥匙串不可用 → 整单失败, 不留"条目建了但 key 没存"的半截状态
    const r = secrets.set(credSecret(id), patch.apiKey);
    if (!r.ok) return r;
  }
  // vendor = 设置页厂家卡片选的那家(core/config/models/vendors.json 的 id); 空 = 「其他」自己填地址
  const next = { id, name, base_url };
  const vendor = patch.vendor !== undefined ? String(patch.vendor || '') : ((all.find((c) => c.id === id) || {}).vendor || '');
  if (vendor) next.vendor = vendor;
  // protocol = 这条走什么 API 协议(anthropic / compat …); 空 = 自动(厂家表, 认不出按 Anthropic)。三态同 vendor
  const protocol = patch.protocol !== undefined ? String(patch.protocol || '') : ((all.find((c) => c.id === id) || {}).protocol || '');
  if (protocol) next.protocol = protocol;
  const at = all.findIndex((c) => c.id === id);
  if (at >= 0) all[at] = next; else all.push(next);
  const write = { credentials: all };
  // 默认那条必须始终指向一个真存在的条目 —— 指空了的话新建人格没得预选, 而这事不会报错
  if (patch.makeDefault) write.defaultCredentialId = id;
  else if (!s.defaultCredentialId || !all.some((c) => c.id === s.defaultCredentialId)) write.defaultCredentialId = id;
  settings.write(write);
  return { ok: true, id };
}

// 删掉一条。认领它的人格不会因此起不来 —— accessConfig 找不到会回落到默认那条
// (见 core/agent/env.js pickCredential)。硬认 id 的话删一条能让若干人格集体哑火。
function remove({ settings, secrets }, id) {
  const s = settings.read();
  const all = (s.credentials || []).filter((c) => c.id !== id);
  secrets.set(credSecret(id), '');
  const write = { credentials: all };
  if (s.defaultCredentialId === id) write.defaultCredentialId = all.length ? all[0].id : '';
  settings.write(write);
  return { ok: true, defaultCredentialId: write.defaultCredentialId };
}

// 报错正文只留最有信息量的那一截: 网关的错误体动辄几百字(还带 trace id), 原样塞进那个
// 单行 span 只会被截断成看不懂的开头。有 error.type 就用它, 没有就取前 80 字。
function briefErr(raw) {
  try {
    const e = JSON.parse(raw).error;
    if (e && (e.type || e.message)) return `${e.type || ''}${e.type && e.message ? ' · ' : ''}${String(e.message || '').slice(0, 80)}`;
  } catch (_) { /* 不是 JSON 就按纯文本截 */ }
  return String(raw || '').replace(/\s+/g, ' ').slice(0, 80);
}

// 挑一个**真能用**的模型来探: 网关清单第一条未必是 Anthropic 协议的东西(gptproto 第一条是
// chatgpt-4o-latest, 打 /v1/messages 直接 500), 拿它去探等于用一个坏模型冤枉一把好 key。
function pickProbeModel(rows) {
  const ids = rows.map((r) => (r && (r.id || r.name)) || '').filter(Boolean);
  return ids.find((s) => /haiku/i.test(s)) || ids.find((s) => /claude/i.test(s)) || ids[0] || '';
}

// 真发一条 max_tokens:1 的 messages —— 这才是"这把 key 能不能出货"的唯一证据。
// 🔴 只有 401/403 才判 key 坏。别的失败(400/404/429/5xx)一律不判红: 我们这里是裸 fetch,
//    缺了 CLI 会带的一堆头, 网关可能因此拒绝 —— 实测 opencode zen/go 对裸请求返 400
//    MissingSessionID, 而同一把 key 走 butler 真实路径完全正常。把那种情况判红, 就是拿
//    "我这条探针发不出去"去冤枉一把好 key, 比恒绿还糟。
async function probeMessages(base, key, model, nModels) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST', signal: ctl.signal,
      // x-opencode-session: opencode zen/go 对没有它的请求一律 400 MissingSessionID(它按会话做路由),
      // 而 CLI 走真实路径不受影响 —— 探针不带就只能验出一句"发不出去", 等于没验。别的网关不认识它, 忽略。
      headers: { 'x-api-key': key, authorization: `Bearer ${key}`, 'x-opencode-session': 'butler-credential-test',
                 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    });
    if (res.ok) return { ok: true, sent: true, detail: `${nModels} 个模型 · ${model} 真发通过` };
    const body = briefErr(await res.text().catch(() => ''));
    if (res.status === 401 || res.status === 403) return { ok: false, detail: `key 被拒: ${res.status} ${body}` };
    return { ok: true, status: res.status, detail: `key 没被拒(${res.status}), 但 ${model} 发不出来: ${body}` };
  } catch (e) {
    return { ok: true, detail: e.name === 'AbortError' ? `${model} 25s 没返回 —— 慢, 但不是 key 的问题` : `探测出错: ${String(e.message || e)}` };
  } finally { clearTimeout(timer); }
}

// 拉模型清单: `/v1/models` 和 `/models` **两种都试一遍**, 哪个回得来算哪个。
// 版本段在谁手里各家不一样 —— 有的算进 base_url(DeepSeek 的 `…/anthropic` 下就没有 /v1/models
// 这个地址, 点一次测试直接 404), 有的要 /v1。试连这一跳的 URL 是我们自己拼的, 那就两种都试,
// 不拿我们的拼法去断定人家的端点该长什么样。
// (真发那一条不在此列: 它必须跟 SDK 走同一个地址, 而 SDK 拼的就是 `<base>/v1/messages`。)
async function listModels(base, key) {
  for (const p of ['/v1/models?limit=1000', '/models?limit=1000']) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(`${base}${p}`, {
        method: 'GET', signal: ctl.signal,
        headers: { 'x-api-key': key, authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' },
      });
      if (!res.ok) continue;
      const j = await res.json().catch(() => ({}));
      const rows = Array.isArray(j.data) ? j.data : (Array.isArray(j) ? j : []);
      if (rows.length) return rows;
    } catch (_) { /* 这一种形状不通就试下一种 */ }
    finally { clearTimeout(timer); }
  }
  return [];
}

// 先拉 models 拿一个模型名, 再拿它去 probeMessages 真验。
async function test({ settings, secrets }, patch = {}) {
  const key = patch.apiKey || (patch.id ? secrets.get(credSecret(patch.id)) : '');
  if (!key) return { ok: false, error: 'no_key' };
  const saved = patch.id ? (settings.read().credentials || []).find((x) => x.id === patch.id) : null;
  let base = normalizeBaseUrl(patch.base_url) || '';   // 测之前也补一下少打的 h, 跟保存时同一套
  if (!base && saved) base = String(saved.base_url || '').trim();
  // 选了厂家卡片的(Claude 以外): 照建人格时那条路试 —— 在这把 key 上找日常档、真发一条。
  // 下面的 Anthropic 探针只认 /v1/messages, 拿它测 OpenAI / 千问的 key 必红。
  // 没记厂家的老凭据按地址认, 地址空着按 key 长相认(认不出 = 网关, 照旧走 Anthropic 探针)
  const table = require('./model-table').load();   // 出厂表 + 本机表逐格拼好的那张
  const modelTier = require('./model-tier');
  const protocol = patch.protocol !== undefined ? String(patch.protocol || '') : ((saved && saved.protocol) || '');
  const vendor = (patch.vendor !== undefined ? patch.vendor : (saved && saved.vendor))
    || (modelTier.vendorFor(table, { base_url: base, key, protocol }) || {}).id;
  if (vendor && vendor !== 'anthropic') {
    // 出厂表里标了 manual 的厂家(豆包: 模型要用户逐个开通, 拿哪个真发都可能撞上没开通的):
    // 清单那一跳就验 key —— 对的 key 回清单, 错的回 401/403, 不选模型也不真发
    const v = table.vendors.find((x) => x.id === vendor);
    if (v && v.manual) {
      const l = await modelTier.listIds({ protocol: v.protocol, vendor: v, base_url: base || v.base_url, key }).catch(() => ({ ok: false, status: 0 }));
      return l.ok ? { ok: true, detail: `key 有效, 列出 ${l.ids.length} 个模型` }
        : { ok: false, reason: l.status === 401 || l.status === 403 ? 'auth' : 'list_failed' };
    }
    const r = await modelTier.pickForTier({ table, access: { base_url: base, key, vendor, protocol }, tier: table.defaultTier || 'daily' });
    // 整档试不通时, 原因取第一个候选的(多半全是同一个原因: key 没额度 / 没开通)
    return r.ok ? { ok: true, model: r.model, tier: r.tier }
      : { ok: false, reason: r.reason === 'tier_unusable' && r.tried[0] ? r.tried[0].reason : r.reason };
  }
  base = (base || 'https://api.anthropic.com').replace(/\/+$/, '');
  const rows = await listModels(base, key);
  const model = pickProbeModel(rows);
  // 🔴 两种形状都拿不到清单也**不判红**: 这一跳本来就证明不了 key(opencode / gptproto 实测
  //    拿现编的 `sk-fake-nonsense-123` 照样返 200 + 完整清单), 既然证明不了成功, 就更不配
  //    拿来证明失败。端点有没有 models 是各家自己的事, 跟这把 key 有没有效无关。
  const a = model ? await probeMessages(base, key, model, rows.length) : { ok: true, detail: '这个端点不给模型清单 —— 自动验不了, 发条消息看看通不通' };
  if (a.sent) return { ...a, protocol: 'anthropic' };
  // 没定协议、且 Anthropic 那个口压根不存在(404/405): 再按 OpenAI 兼容试(地址不带 /v1 的顺带试加上), 通了把协议和地址带回去存。
  // 拉不到清单 / 超时 / 5xx 不算 —— 可能只是这一下慢, 不能因此把一个 Anthropic 网关改成别的协议
  if (protocol || !a.ok || !model || ![404, 405].includes(a.status)) return a;
  for (const b of /\/v1$/.test(base) ? [base] : [base, `${base}/v1`]) {
    const c = await modelTier.pickForTier({ table, access: { base_url: b, key, protocol: 'compat' }, tier: table.defaultTier || 'daily' }).catch(() => ({ ok: false }));
    console.log(`[cred] Anthropic 口 ${a.status} · 探 OpenAI 兼容 ${b} → ${c.ok ? c.model : c.reason} (试 ${(c.tried || []).map((x) => `${x.id}:${x.ok ? 'ok' : `${x.status} ${x.detail || x.reason}`}`).join(' | ') || '无'})`);
    if (c.ok) return { ok: true, model: c.model, protocol: 'compat', base_url: b };
  }
  return a;
}

// —— 跑一次 `claude setup-token`, 把结果自己收好 ——
// 这条路的全部意义是"以后不用再管"。要是每次换 token 都得开终端、认出哪一行是 token、
// 再粘回设置里, 省下来的心智就白费了 —— 所以做成一个按钮: 你只管在浏览器里点授权。
//
// ⚠️ token 的输出格式官方没文档, 写这段时也没真跑过。所以 ① 宽容匹配 ②【无论成败都把
// 完整原始输出打进日志】。万一没捞着, 照日志改一行匹配即可, 不必让人再点一遍授权。
// 🔴 token 会被终端按行宽折成两段, 必须拼回来 —— 2026-09-18 真跑一次才发现。实际输出:
//     Your OAuth token (valid for 1 year):
//     sk-ant-oat01-M9LQj8……PdFre81B     ← 第一段, 在行宽处断开
//      ffdnB_dgXiN7AK8……Gq1wAA          ← 第二段, 行首还多一个缩进空格
//     Store this token securely. You won't be able to see it again.
// 单条 /sk-ant-[A-Za-z0-9_-]{20,}/ 捞到的是**半截 token**, 长得挺像真的, 存进去只会在下次
// 用的时候莫名 401。拼接判据: 从 sk-ant 那行起, 后续【整行都是 token 合法字符】的行依次
// 拼上 —— 紧跟的 "Store this token securely." 带句号和撇号, 自然停住。
// ⚠️ 别图省事改成"删掉所有空白再匹配": CR 一删, 后面的 Store…securely 会连成一体被吃进来
//    (实测捞出 130 字符、结尾是 securely, 而正确答案是 108)。
const SETUP_TOKEN_HEAD = /^sk-ant-[A-Za-z0-9_\-]+$/;
const SETUP_TOKEN_CONT = /^[A-Za-z0-9_\-]+$/;
const SETUP_TOKEN_COLS = 80;
const stripAnsi = (s) => String(s)
  .replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][AB0]|\x1b[78]/g, '')
  // script 会在开头糊上 ^D 和退格这类裸控制字符, 留着迟早糊在 token 那一行上。
  // 保留 \t \n \r —— 按行拼接全靠它们。
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

// 🔴 光按行拼还不够 —— 必须先把输出当成终端**回放**一遍再读屏幕。2026-09-19 真跑一次打脸:
// CLI 用 ink 做界面, token 两段之间根本没有换行符, 走的是 ESC[1B(下移一行但不回行首) 和
// ESC[15G(跳到第 15 列); 把这些控制符 strip 掉之后, 两段连同后面的 "Store this token
// securely." 糊成一整行, 上面那套整行判据当场失效, 还会吞掉被跳列写入的字符
// (实测拼出 105 字符而完整是 108, 少的那几个里就有一个 J)。所以先按 80 列摆一块屏幕,
// 让光标指令把字符放回它们本来的位置, 再按行拼。屏宽不敏感: 80/100/120 拼出的结果相同,
// 因为断行是 ink 自己用指令控制的, 不靠终端自动折行。
function replayAnsi(s, cols = SETUP_TOKEN_COLS) {
  const grid = [];
  const at = (r) => (grid[r] || (grid[r] = []));
  let r = 0, c = 0, savedR = 0, savedC = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\x1b') {
      const rest = s.slice(i + 1);
      let m;
      if ((m = /^\[([0-9;?]*)([A-Za-z])/.exec(rest))) {
        const n = parseInt(m[1], 10) || 1;
        switch (m[2]) {
          case 'A': r = Math.max(0, r - n); break;
          case 'B': r += n; break;
          case 'C': c += n; break;
          case 'D': c = Math.max(0, c - n); break;
          case 'G': c = n - 1; break;
          case 'H': case 'f': {
            const p = m[1].split(';');
            r = (parseInt(p[0], 10) || 1) - 1; c = (parseInt(p[1], 10) || 1) - 1; break;
          }
          case 'K': {
            const row = at(r), mode = parseInt(m[1], 10) || 0;
            if (mode === 0) row.length = Math.min(row.length, c);
            else if (mode === 1) { for (let x = 0; x <= c; x++) row[x] = ' '; }
            else row.length = 0;
            break;
          }
          case 'J': {
            const mode = parseInt(m[1], 10) || 0;
            if (mode === 2) grid.length = 0;
            else if (mode === 0) { at(r).length = Math.min(at(r).length, c); for (let x = r + 1; x < grid.length; x++) grid[x] = []; }
            break;
          }
          default: break;   // 颜色/私有模式那些不影响落字, 略过
        }
        i += m[0].length; continue;
      }
      if ((m = /^\][^\x07\x1b]*(\x07|\x1b\\)/.exec(rest))) { i += m[0].length; continue; }   // OSC
      if ((m = /^[()][AB0]/.exec(rest))) { i += m[0].length; continue; }                      // 字符集切换
      if (rest[0] === '7') { savedR = r; savedC = c; i += 1; continue; }
      if (rest[0] === '8') { r = savedR; c = savedC; i += 1; continue; }
      i += 1; continue;
    }
    if (ch === '\n') { r++; continue; }
    if (ch === '\r') { c = 0; continue; }
    if (ch === '\b') { c = Math.max(0, c - 1); continue; }
    if (ch === '\t') { c = (Math.floor(c / 8) + 1) * 8; continue; }
    if (ch < ' ' || ch === '\x7f') continue;
    if (c >= cols) { c = 0; r++; }
    at(r)[c] = ch; c++;
  }
  return grid.map((row) => Array.from(row, (x) => (x === undefined ? ' ' : x)).join('').replace(/\s+$/, ''));
}

// 从 setup-token 的整段【原始】输出里取出完整 token。取不到返回 null。
// 🔴 要喂原始字节, 不能喂 stripAnsi 过的 —— 位置信息全在那些控制符里, strip 一次就没了。
function pickSetupToken(out) {
  const lines = replayAnsi(String(out)).map((l) => l.trim());
  let tok = null;
  for (const l of lines) {
    if (tok === null) { if (SETUP_TOKEN_HEAD.test(l)) tok = l; continue; }
    if (l && SETUP_TOKEN_CONT.test(l)) tok += l; else break;
  }
  return tok;
}

// 借系统 script 命令套一个伪终端。mac/BSD: script -q <file> <cmd...> · Linux: script -qec "<cmd>" <file>
function ptyWrap(bin, args) {
  const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
  if (process.platform === 'darwin') return ['script', ['-q', '/dev/null', bin, ...args]];
  if (process.platform === 'linux') return ['script', ['-qec', [bin, ...args].map(q).join(' '), '/dev/null']];
  return [bin, args];   // Windows 没有 script: 原样跑, 由调用方从失败里看出来
}

// 拿 token 真打一次最小请求。这条完全绕开 keychain, 所以它只证明这张 token 本身好不好使。
async function probeToken(tok) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Authorization': `Bearer ${tok}`, 'anthropic-version': '2023-06-01',
                 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 4,
                             messages: [{ role: 'user', content: 'hi' }] }),
    });
    if (res.ok) return { ok: true };
    return { ok: false, detail: `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}` };
  } catch (e) {
    return { ok: false, detail: e.name === 'AbortError' ? '验证超时(20s)' : String(e.message || e) };
  } finally { clearTimeout(timer); }
}

let setupInFlight = null;   // 与重登同理: 一次就够, 绝不能几处同时弹浏览器
function runSetupToken({ secrets, claudeBin }, timeoutMs = 600000) {
  if (setupInFlight) { console.log('[auth/setup-token] 已在进行中, 共享同一次'); return setupInFlight; }
  setupInFlight = new Promise((resolve) => {
    const { spawn } = require('child_process');
    let child;
    try {
      // 🔴 必须给它一个【伪终端】, 不能用管道。2026-09-18 实测: stdio 走 pipe 时它输出 0 字节、
      // 浏览器根本不弹, 静静挂到超时为止 —— 看日志只会以为"用户没点"。
      // Node 没有内置 pty, 借系统的 script 命令套一层(mac/BSD 与 Linux 的参数位置不同)。
      const [bin, argv] = ptyWrap(claudeBin, ['setup-token']);
      child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
      console.log(`[auth/setup-token] 开始 pid=${child.pid} via ${bin} — 浏览器会打开, 需要人点一下授权`);
    } catch (e) {
      console.error(`[auth/setup-token] spawn 失败: ${e && e.message}`);
      return resolve({ ok: false, error: String(e && e.message) });
    }
    let buf = '';
    const eat = (tag) => (d) => { buf += String(d); console.log(`[auth/setup-token][${tag}] ${stripAnsi(d).trim().slice(0, 300)}`); };
    try { child.stdout.on('data', eat('out')); child.stderr.on('data', eat('err')); } catch (_) {}
    let done = false;
    const finish = (v) => {
      if (done) return; done = true;
      try { clearTimeout(to); } catch (_) {}
      try { child.kill(); } catch (_) {}
      console.log(`[auth/setup-token] 结束 ok=${v.ok} ${v.error || ''}`);
      resolve(v);
    };
    child.on('error', (e) => finish({ ok: false, error: String(e && e.message) }));
    child.on('exit', async (code) => {
      const clean = stripAnsi(buf);          // 只给人看(日志/诊断)
      const tok = pickSetupToken(buf);       // 解析必须吃原始字节, 见 replayAnsi 的注释
      if (!tok) {
        console.error(`[auth/setup-token] 没在输出里认出 token (exit ${code})。完整输出如下, 照它改 pickSetupToken 的拼行规则:\n${clean.slice(0, 4000)}`);
        return finish({ ok: false, error: `没认出 token (CLI exit ${code})`, raw: clean.slice(0, 4000) });
      }
      // 🔴 存之前真打一次 API。坏 token(比如折行只捞到半截)长得跟真的一模一样, 存进去之后
      // 所有人格会集体 401, 而那时候没人知道是这张 token 的错。验一次就把这种事挡在门外。
      const live = await probeToken(tok);
      if (!live.ok) {
        console.error(`[auth/setup-token] token 验不过(${live.detail}) → 不存, 现有登录照旧`);
        return finish({ ok: false, error: `拿到的 token 用不了: ${live.detail}`, raw: clean.slice(0, 2000) });
      }
      const r = saveSubToken({ secrets }, tok);
      if (!r || r.ok === false) return finish({ ok: false, error: `存盘失败: ${(r && r.error) || '钥匙串不可用'}` });
      const hint = `${tok.slice(0, 12)}…${tok.slice(-4)}`;
      console.log(`[auth/setup-token] ✅ 已存好 (${hint}, 共 ${tok.length} 字符) — 重起人格后生效`);
      finish({ ok: true, hint });
    });
    const to = setTimeout(() => finish({ ok: false, error: '授权超时(10 分钟)' }), timeoutMs);
  }).finally(() => { setupInFlight = null; });
  return setupInFlight;
}

// 宿主把活口子递进来(subLoggedIn 是会变的, 所以要 getter 不要值)。
function register({ ipcMain, settings, secrets, defaultName, subLoggedIn, claudeBin, openApiPersonas }) {
  // 🔴 迁移在这儿无条件跑一次, 不挂在 hasAnyKey 上: 那条只在"没登录订阅"的分支里被调,
  //    而订阅已登录的机器在 main.js ensureClaudeAuth 开头就 return 了 —— 老 key 于是一直没搬家,
  //    要等用户碰巧点开设置页才补跑。register 是开机路径上必经的一步, 与登录状态无关。
  try { migrate({ settings, secrets, defaultName: defaultName() }); } catch (e) { console.error('[cred] 开机迁移失败:', e && e.message); }
  const dn = () => defaultName();
  // ccAvailable: 这台有没有 CC SDK。没有(开源下载版)时界面把订阅和登录整个藏掉, 只剩配 key
  ipcMain.handle('list-credentials', async () => {
    const cc = await require('./agent/util').ccAvailable();
    return { ...list({ settings, secrets, defaultName: dn(), subLoggedIn: cc && subLoggedIn() }), ccAvailable: cc };
  });
  ipcMain.handle('save-credential', async (_e, patch) => save({ settings, secrets }, patch));
  // 开着、且此刻用的就是这条的人格。改它的端点或 key 要连这些人格一起重启 —— 凭据在建流那刻进 env
  ipcMain.handle('credential-users', async (_e, { id } = {}) => {
    const { pickCredential } = require('./agent/env');
    const users = (openApiPersonas ? openApiPersonas() : []).filter((p) => {
      const c = pickCredential(settings, p.credentialId);
      return c && c.id === id;
    });
    return { users: users.map((p) => ({ id: p.id, name: p.name })) };
  });
  ipcMain.handle('delete-credential', async (_e, { id } = {}) => remove({ settings, secrets }, id));
  ipcMain.handle('set-default-credential', async (_e, { id } = {}) => {
    settings.write({ defaultCredentialId: id || '' });
    return { ok: true };
  });
  ipcMain.handle('test-credential', async (_e, patch) => test({ settings, secrets }, patch));
  ipcMain.handle('sub-token-state', async () => subTokenState({ secrets }));
  ipcMain.handle('save-sub-token', async (_e, { token } = {}) => saveSubToken({ secrets }, token));
  ipcMain.handle('run-setup-token', async () => runSetupToken({ secrets, claudeBin }));
}

module.exports = { register, migrate, hasAnyKey, list, save, remove, test, normalizeBaseUrl, API_KEY_SECRET, credSecret,
                   subTokenState, saveSubToken, runSetupToken, pickSetupToken, ptyWrap, probeToken, SUBSCRIPTION_TOKEN_KEY };
