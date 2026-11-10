// model-tier-ipc.js — 按档选模型的主进程那一半, 自注册(main.js 只 require 一下; 单开文件因 main.js 撞行数闸)。
//   model-vendors          → 厂家卡片要的东西(id · 名字 · 官方地址 · 有哪几档), 不含正则
//   pick-model-for-tier    → { credentialId, tier, vendor?, id? } → 在这把 key 上找到那一档能用的型号(真发一条试通);
//                            出厂表标 manual 的厂家(豆包)回 manual:true + 型号清单, 带 id 就只试那一个
// 逻辑在 core/model-tier.js, 厂家表在 config/models/vendors.json。
'use strict';

const { ipcMain } = require('electron');
const settings = require('./settings');
const { accessConfig } = require('../core/agent');
const modelTier = require('../core/model-tier');
const registry = require('../core/registry');

// 出厂表 + 本机表(数据目录 config/models/vendors.local.json)逐格拼好的那张, 见 core/model-table.js
const table = () => require('../core/model-table').load();

// 厂家名按界面语言取: labels[语言] 没有就用 label(中文厂家在英文界面不显示中文)
function vendorLabel(v) {
  const i18n = require('./i18n');
  const l = i18n.normalizeLocale(settings.read().language) || i18n.normalizeLocale(require('electron').app.getLocale()) || i18n.DEFAULT_LOCALE;
  return (v.labels && v.labels[l]) || v.label;
}

ipcMain.handle('model-vendors', async () => {
  const t = table();
  return {
    tierOrder: t.tierOrder || ['top', 'strong', 'daily', 'cheap'],
    defaultTier: t.defaultTier || 'daily',
    vendors: (t.vendors || []).map((v) => ({ id: v.id, label: vendorLabel(v), base_url: v.base_url || '', protocol: v.protocol,
      tiers: Object.keys(v.tiers || {}).filter((k) => (v.tiers[k] || []).length) })),
  };
});

ipcMain.handle('pick-model-for-tier', async (_e, { credentialId = '', tier = '', vendor = '', id = '' } = {}) => {
  const a = accessConfig(true, null, credentialId);
  if (!a) return { ok: false, reason: 'no_key' };
  const cred = (settings.read().credentials || []).find((c) => c.id === credentialId) || {};
  try {
    const access = { ...a, vendor: vendor || cred.vendor || '' };
    if ((modelTier.vendorFor(table(), access) || {}).manual) {
      const m = await modelTier.pickManual({ table: table(), access, id });
      console.log(`[model-tier] ${cred.name || credentialId} 自选型号 ${id || '(列清单)'} → ${m.ok ? m.model : m.reason} · 清单 ${m.ids.length}`);
      return m;
    }
    const r = await modelTier.pickForTier({ table: table(), access, tier });
    console.log(`[model-tier] ${cred.name || credentialId} ${r.tier} → ${r.ok ? r.model : r.reason}`
      + ` (试 ${r.tried.map((x) => `${x.id}:${x.ok ? 'ok' : x.reason}`).join(', ') || '无'})${r.fallback ? ' · 没认出档位, 用清单前几个' : ''}`);
    // 已有人格在这把 key 上用着这个型号 = 真用过, 提示写「用过」而不是「测通」
    const bare = (m) => String(m || '').replace(/^[a-z]+\//, '');   // 老人格存的型号可能没带协议前缀
    if (r.ok) r.used = registry.list().some((p) => p.accessMode === 'api' && (p.credentialId || '') === credentialId && bare(p.model) === bare(r.model));
    return r;
  } catch (e) {
    return { ok: false, reason: 'error', detail: String(e && e.message || e) };
  }
});
