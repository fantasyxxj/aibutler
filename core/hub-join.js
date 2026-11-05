// hub-join.js — 陌生管家自助连上公网 hub 的那条路。
//
// 作者 2026-08-28 定案: 发出去的管家不各自架 bus, 一律连我们的 hub。身份不靠事先发激活码,
// 走「申请在前 · 批准在中 · 自取在后」三段:
//
//   用户装完留一句话 → 作者在 hub 上看见谁申请了、点头 → 用户回来点一下「检查」自己把 token 拉回来
//
// 码不用在两个人之间传递, 少一次人工传递就少一处出错。
//
// 🔴 claim_secret 只留本地, 上传的是它的 sha256。所以 apply_id 泄露也没用 —— 只有原机器取得走。
'use strict';

const { createHash, randomBytes } = require('crypto');
const registry = require('./registry');

// 出厂就带的两个地址: 先域名, 域名走不通(DNS 被污染 / 证书环境不对)再试 IP。
// 两个都不通就不管了 —— 用户有代理自己去设置里填。
const ENDPOINTS = ['https://hub.aicreditup.com', 'http://160.251.231.68:8012'];
const API = '/api/v1/agent-bus';

// 一个人格一份身份。🔴 install_id 也必须按人格分 —— 服务端 /apply 是按 install_id 找
// 「手上还没走完的申请」原样还回来(resumed), 共用一份的话第二个人格申请时会被 resume 到
// 第一个人格那条上, 于是**所有人格都不能申请**。代价是 per-install 那道每日限流变成
// 每人格各一份额度, 挡人靠 per-IP 那道。
// asked 是「首次引导问过没有」, 与人格无关, 留在顶层。owner_name(这台机器的主人叫什么)同理 ——
// 号按人格发, 人只有一个: 给第二个人格申请时直接带出来, 不用再填。
const DEFAULTS = { install_id: '', claim_secret: '', apply_id: 0, base_url: '', status: '' };

// 老结构(单份, 字段平铺在 hubJoin 顶层)只接 asked 过来, 其余丢弃 —— 一个人格到底连上没有
// 看的是它 plugins.buses 里有没有 token, 不看这里, 所以丢掉不会让已连上的人格掉线。
function hubRoot(reg) {
  const raw = reg.hubJoin || {};
  return { asked: !!raw.asked, owner_name: String(raw.owner_name || ''), byPersona: raw.byPersona || {} };
}

function getState(personaId) {
  const root = hubRoot(registry.loadRegistry());
  return { ...DEFAULTS, ...(root.byPersona[String(personaId || '')] || {}), asked: root.asked, owner_name: root.owner_name };
}

function setState(personaId, patch = {}) {
  const reg = registry.loadRegistry();
  const root = hubRoot(reg);
  const key = String(personaId || '');
  const { owner_name: _owner, ...perPersona } = patch;   // owner_name 只落顶层, 不进人格那份
  if (key) root.byPersona[key] = { ...DEFAULTS, ...(root.byPersona[key] || {}), ...perPersona };
  if ('asked' in patch) root.asked = !!patch.asked;
  if ('owner_name' in patch) root.owner_name = String(patch.owner_name || '');
  reg.hubJoin = root;
  registry.saveRegistry(reg);
  return key ? { ...root.byPersona[key], asked: root.asked } : { asked: root.asked };
}

// install_id 认的是「这个人格这次安装」, 重装换新的 —— 它只用来做限流和
// 「同一个人格别堆一串申请」, 不当身份使, 所以不需要跨重装稳定。
function ensureIdentity(personaId) {
  const st = getState(personaId);
  if (st.install_id && st.claim_secret) return st;
  return setState(personaId, {
    install_id: st.install_id || randomBytes(16).toString('hex'),
    claim_secret: st.claim_secret || randomBytes(32).toString('base64url'),
  });
}

async function post(baseUrl, pathname, body, timeoutMs = 15000) {
  const resp = await fetch(baseUrl + API + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 不是 JSON 就只看状态码 */ }
  return { status: resp.status, json, text };
}

// 探活只为在两个出厂地址里挑一个通的。挑不出来就是这台机器上不去, 不是没配置。
async function pickEndpoint(candidates = ENDPOINTS) {
  for (const base of candidates) {
    try {
      const resp = await fetch(base + API + '/ping', { signal: AbortSignal.timeout(6000) });
      if (resp.ok) return base;
    } catch (_) { /* 换下一个 */ }
  }
  return null;
}

// 提示只在【装完从没问过】时弹一次。问过就再也不弹 —— 用户后来想连去设置里点。
// 升级上来的老安装没有 asked 标记, 所以会被问一次; 已经配过 bus 的直接算作不用问。
function shouldPrompt() {
  const st = getState('');
  if (st.asked) return false;
  const anyBus = registry.list().some((p) => {
    const buses = p && p.plugins && p.plugins.buses;
    return Array.isArray(buses) && buses.length > 0;
  });
  if (anyBus) { setState('', { asked: true }); return false; }
  return true;
}

function dismiss() {
  setState('', { asked: true });
  return { ok: true };
}

// 报上本人名字、留一句话申请。同一个人格手上还有没走完的申请时, 服务端原样把那条还回来(resumed),
// 所以反复点这个按钮不会堆出一串待办, 也不会撞限流。
// 🔴 personaId 必填 —— 身份是按人格发的, 不带就落不进任何人格, 等于白申请。
// 🔴 ownerName 必填 —— 后台批的时候靠它认人, 之后别人按名字找人(GET /agents?name=)也靠它。
//    光有人格名认不出是谁: 同一个人的几个人格各叫各的, 一句留言又常常不写自己是谁。
async function apply({ displayName, ownerName, message = '', personaId } = {}) {
  const name = String(displayName || '').trim();
  if (!name) return { ok: false, error: '得先有个名字' };
  const owner = String(ownerName || '').trim().slice(0, 64);
  if (!owner) return { ok: false, error: '请填上你自己的名字' };
  if (!personaId) return { ok: false, error: '不知道给哪个人格申请' };

  const st = ensureIdentity(personaId);
  const base = await pickEndpoint();
  if (!base) return { ok: false, error: '连不上 hub —— 域名和 IP 都试过了。有代理的话去设置里手动填地址。' };

  const claimHash = createHash('sha256').update(st.claim_secret).digest('hex');
  let r;
  try {
    r = await post(base, '/apply', {
      display_name: name, owner_name: owner, install_id: st.install_id, claim_hash: claimHash,
      message: String(message || '').slice(0, 2000),
    });
  } catch (e) {
    return { ok: false, error: `连不上 hub: ${e.message}` };
  }

  if (r.status === 429) return { ok: false, error: '申请太频繁了, 明天再试。' };
  if (r.status !== 200 || !r.json) return { ok: false, error: `hub 拒绝了申请 (HTTP ${r.status})` };

  setState(personaId, { apply_id: r.json.apply_id, base_url: base, status: r.json.status, asked: true, owner_name: owner });
  return { ok: true, applyId: r.json.apply_id, status: r.json.status, resumed: !!r.json.resumed };
}

// 用户点「检查」。批了就当场拿 token 并把通道落进这个人格。
async function claim(personaId) {
  const st = getState(personaId);
  if (!st.apply_id || !st.claim_secret) return { ok: false, error: '还没提交过申请' };

  // 申请是从哪个地址提的就回哪个取 —— 换地址那边不认这个 apply_id。
  const base = st.base_url || (await pickEndpoint());
  if (!base) return { ok: false, error: '连不上 hub' };

  let r;
  try {
    r = await post(base, '/claim', { apply_id: st.apply_id, claim_secret: st.claim_secret });
  } catch (e) {
    return { ok: false, error: `连不上 hub: ${e.message}` };
  }

  if (r.status === 404) return { ok: false, error: '这条申请在 hub 上找不到了, 重新申请一次。' };
  if (r.status === 429) return { ok: false, error: '试太多次被锁了, 重新申请一次。' };
  if (r.status !== 200 || !r.json) return { ok: false, error: `hub 没给结果 (HTTP ${r.status})` };

  const status = r.json.status;
  if (status !== 'granted') {
    setState(personaId, { status });
    return { ok: true, granted: false, status };
  }

  const attached = attachBus(personaId, {
    base_url: r.json.base_url || base, agent: r.json.agent_name, token: r.json.token,
  });
  if (!attached.ok) return attached;

  setState(personaId, { status: 'claimed' });
  // 🔴 spec 必须回给界面: 保存人格时 buses 是从面板那张表读回的(manager.js readPluginsFromPanel),
  // 表里没有这一行, 下一次保存就把刚落盘的 token 用空数组覆盖掉。
  return { ok: true, granted: true, agent: r.json.agent_name, bus: attached.spec };
}

// 通道落进人格的 plugins.buses(表还是数组, 只是个人版通常就这一条)。
// inbox: 'bothub' = 收到的件走分级唤醒, 不然只发不收。
function attachBus(personaId, { base_url, agent, token }) {
  const reg = registry.loadRegistry();
  const p = reg.personas.find((x) => x.id === personaId);
  if (!p) return { ok: false, error: `找不到人格 ${personaId}` };

  p.plugins = p.plugins || {};
  const buses = Array.isArray(p.plugins.buses) ? p.plugins.buses : [];
  const spec = {
    id: 'hub', kind: 'bothub', label: 'hub · agent 互通',
    base_url: base_url + API, agent, token, inbox: 'bothub',
  };
  const at = buses.findIndex((b) => b && b.id === 'hub');
  if (at >= 0) buses[at] = spec; else buses.push(spec);
  p.plugins.buses = buses;

  if (!registry.saveRegistry(reg)) return { ok: false, error: '写登记簿失败' };
  return { ok: true, spec };
}

// 后台把 token 撤了(或它本来就失效)时, 把本地那条壳里的 token 清掉。
// 面板的 hubBusOf 是连 token 一起看的, 清掉之后那个人格就回到「申请」那一屏, 用户
// 自己能重新申请 —— 不清的话他看到的是「已连接」而实际一条也收不到, 且无路可走。
// 🔴 按 agent 名找而不是按人格 id: 报 401 的是收件循环, 它手上只有 endpoint 的 agent 名。
function revokeLocalToken(agentName) {
  const name = String(agentName || '').trim();
  if (!name) return { ok: false, error: '没有 agent 名' };
  const reg = registry.loadRegistry();
  let cleared = 0;
  for (const p of reg.personas || []) {
    for (const b of (p.plugins && p.plugins.buses) || []) {
      if (b && b.kind === 'bothub' && b.agent === name && b.token) { b.token = ''; cleared++; }
    }
  }
  if (!cleared) return { ok: true, cleared: 0 };
  if (!registry.saveRegistry(reg)) return { ok: false, error: '写登记簿失败' };
  return { ok: true, cleared };
}

module.exports = { ENDPOINTS, getState, shouldPrompt, dismiss, apply, claim, pickEndpoint, revokeLocalToken };
