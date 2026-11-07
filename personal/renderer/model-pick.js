// model-pick.js — 「这把 key 能用哪些模型 · 这个人格在这把 key 上用过哪个」的共用件。
// 人格管理的编辑面板(manager.js)和主界面顶栏的快速切换(model-switch.js)都用它, 规矩只写一份:
// 换 key 就重拉这把 key 的清单, 停在这个人格在这把 key 上用过的型号; 没用过先停第一个, 再按日常档真试一个换上(作者 11-07)。
'use strict';

(function () {
  // 缓存按【接入方式 + 哪条凭据】分桶: 两条凭据多半是两个网关, 能开的模型清单不一样。
  const cache = {};
  const keyOf = (useApi, cred) => (useApi ? `api:${cred || ''}` : 'sub');
  async function load(useApi, credentialId, { fresh = false } = {}) {
    const k = keyOf(useApi, credentialId);
    if (!fresh && cache[k]) return cache[k];
    let v;
    try {
      const r = await window.butler.listModelOptions({ useApi: !!useApi, credentialId: credentialId || '' });
      v = { options: (r && r.options) || [], src: r || null };
    } catch (e) { console.error('[model-pick] listModelOptions failed:', e && e.message); v = { options: [], src: null }; }
    cache[k] = v;
    return v;
  }
  // 没拉过 = null
  const peek = (useApi, credentialId) => cache[keyOf(useApi, credentialId)] || null;

  // 每个人格在每把 key 上最后用过哪个型号(localStorage, 两个窗口同源共用): 换回那把 key 时直接停在它上面。
  // 登记簿里存着的那一对(接入方式 + key)以登记簿为准。
  const LAST_MODEL_KEY = 'butler.lastModelByKey';
  const lastModels = () => { try { return JSON.parse(localStorage.getItem(LAST_MODEL_KEY) || '{}'); } catch (_) { return {}; } };
  const accessOf = (p) => (p.accessMode === 'api' ? 'api' : 'subscription');
  function lastModelFor(p, access, cred) {
    if (access === accessOf(p) && (access !== 'api' || cred === (p.credentialId || ''))) return p.model || '';
    return lastModels()[`${p.id}|${access}|${cred}`] || '';
  }
  function rememberModel(p, access, cred, model) {
    if (!model) return;
    const m = lastModels(); m[`${p.id}|${access}|${cred}`] = model;
    try { localStorage.setItem(LAST_MODEL_KEY, JSON.stringify(m)); } catch (_) { /* 记不住只是少一次方便, 不拦保存 */ }
  }

  // 刚换到 (access, cred) 时该停在哪个型号。probe = 这把 key 没用过, 停的是清单第一个,
  // 调用方应再 probeDaily 一次: 清单第一个常是测试 / 嵌入一类的名字(千问第一个是 pre-mock_…)。
  function choose(p, access, cred, options) {
    const ids = (options || []).map((o) => o.id).filter((x) => access !== 'api' || x);
    const used = lastModelFor(p, access, cred);
    const known = ids.includes(used);
    return { model: known ? used : (ids[0] || ''), probe: access === 'api' && !known };
  }
  async function probeDaily(credentialId) {
    const r = await window.butler.pickModelForTier({ credentialId, tier: 'daily' }).catch(() => null);
    return r && r.ok ? r.model : '';
  }

  // 引擎跟着接入方式定死(作者 11-07): 换了接入方式才跟着换, 只改别的不动老人格原来的引擎
  const sdkFor = (p, access) => (access !== accessOf(p) ? (access === 'api' ? 'butler' : 'claude-code') : (p.sdk || 'claude-code'));

  // id 不在 label 里就补上 —— 手写清单的 label 只有中文描述, 走网关时 id 才是关键信息
  const label = (o) => (!o.id || String(o.label || '').includes(o.id) ? (o.label || o.id) : `${o.label || o.id} — ${o.id}`);

  window.ModelPick = { load, peek, accessOf, lastModelFor, rememberModel, choose, probeDaily, sdkFor, label };
})();
