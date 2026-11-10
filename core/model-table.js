// model-table.js — 模型定义扩展表: 建人格挑档、派活挑同族型号都读这一张。
//
// 两份拼成一张(作者 11-09):
//   · 出厂 config/models/vendors.json —— 各家官方家族名分四档, 随版本升级, 我们维护
//   · 本机 数据目录 config/models/vendors.local.json —— 用户或人格写, 没有就是空表(网关乱名字、「派活就用 X」)
// 主键是「厂家 id + 档」, 逐格拼: 本机写了的那一格整格替换出厂那一格(写什么用什么, 便宜档填 opus 也照用),
// 没写的格照用出厂, 本机新出现的厂家追加。整份覆盖层(config-loader 的 pick)会挡住以后的出厂升级, 所以另起一个名字。
'use strict';

const { cfg } = require('./host');
const { candidatesForTier, vendorFor, personaModel } = require('./model-tier');

// 派活的三档 → 表里同名三档; top 只给建人格挑, 派活不用
const DISPATCH_TIERS = ['strong', 'daily', 'cheap'];

function merge(factory, local) {
  const out = { ...(factory || {}), vendors: ((factory && factory.vendors) || []).map((v) => ({ ...v, tiers: { ...(v.tiers || {}) } })) };
  if (!local) return out;
  for (const k of Object.keys(local)) if (k !== 'vendors' && k !== '_') out[k] = local[k];
  for (const lv of local.vendors || []) {
    if (!lv || !lv.id) continue;
    const fv = out.vendors.find((v) => v.id === lv.id);
    if (!fv) { out.vendors.push({ ...lv, tiers: { ...(lv.tiers || {}) } }); continue; }
    for (const k of Object.keys(lv)) if (k !== 'tiers') fv[k] = lv[k];
    Object.assign(fv.tiers, lv.tiers || {});
  }
  return out;
}

function load() {
  return merge(cfg.json('models/vendors'), cfg.jsonOptional('models/vendors.local', null));
}

// 人格模型名 → { prefix, bare }。prefix 是协议前缀(compat/ openai/ deepseek/ 或空 = Anthropic 协议), 子代理要跟主模型走同一条通道。
function splitModel(model) {
  const m = /^([a-z]+)\/(.+)$/.exec(String(model || ''));
  return { prefix: m ? m[1] : '', bare: (m ? m[2] : String(model || '')).replace(/\[1m\]$/i, '') };
}

// 主模型属于哪一家、哪一档。凭据上记的厂家(或地址认出的那家)对得上就用它; 否则各家都对一遍, 取命中最长的
// (Gemini 的「-pro」也能命中 deepseek-v4-pro, 但 DeepSeek 自家的家族名命中得更长)。
function familyOf(table, model, access = {}) {
  const { bare } = splitModel(model);
  if (!bare) return null;
  const order = table.tierOrder || ['top', 'strong', 'daily', 'cheap'];
  const hit = (v) => {
    let best = null;
    for (const tier of order) for (const fam of ((v.tiers || {})[tier] || [])) {
      const m = new RegExp(fam, 'i').exec(bare);
      if (m && (!best || m[0].length > best.len)) best = { vendor: v, tier, len: m[0].length };
    }
    return best;
  };
  const hinted = (access.vendor || access.base_url) ? vendorFor(table, access) : null;
  const h = hinted && hit(hinted);
  if (h) return { vendor: h.vendor, tier: h.tier };
  let best = null;
  for (const v of table.vendors || []) { const x = hit(v); if (x && (!best || x.len > best.len)) best = x; }
  return best && { vendor: best.vendor, tier: best.tier };
}

// 同家的 strong / daily / cheap 各取清单里最新的那个, 带主模型的协议前缀; 认不出或清单里没有的档 → 不给(调用方退回主模型)
function tierModels(table, model, ids, access = {}) {
  // 用户自己选型号的厂家(manual, 豆包): 清单里的别的型号不知道开没开通, 子代理一律用主模型
  const hinted = (access.vendor || access.base_url) ? vendorFor(table, access) : null;
  if (hinted && hinted.manual) return {};
  const fam = familyOf(table, model, access);
  if (!fam || !Array.isArray(ids) || !ids.length) return {};
  const { prefix } = splitModel(model);
  const out = {};
  for (const tier of DISPATCH_TIERS) {
    const id = candidatesForTier(ids, fam.vendor, tier).matched[0];
    if (id) out[tier] = prefix ? `${prefix}/${id}` : personaModel('anthropic', id);
  }
  return out;
}

module.exports = { load, merge, familyOf, tierModels, splitModel, DISPATCH_TIERS };
