// model-list-cache.js — 每把 key(地址 + key)能看到的型号清单, 缓存在数据目录, 派活挑同族型号用。
// 建流那一刻要同步拿到(env 在 spawn 前就得填好), 所以只读盘上那份; 没有或超过一天就在后台重拉, 下次建流用上。
// 第一次没有缓存 = 这次派活退回主模型, 跟改之前一样。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { paths } = require('./host');
const { listIds, vendorFor } = require('./model-tier');

const TTL_MS = 24 * 3600 * 1000;
const inflight = new Map();

function fileFor(a) {
  const h = crypto.createHash('sha1').update(`${a.base_url || ''}\n${a.key || ''}`).digest('hex').slice(0, 16);
  return path.join(paths.dataDir(), 'app', 'cache', 'model-list', `${h}.json`);
}

async function refresh(a, table) {
  const f = fileFor(a);
  if (inflight.has(f)) return inflight.get(f);
  const p = (async () => {
    const v = vendorFor(table, a) || { protocol: 'anthropic' };
    const r = await listIds({ protocol: v.protocol || 'anthropic', vendor: v, base_url: a.base_url || v.list_base || v.base_url || '', key: a.key });
    if (!r.ok) { console.log(`[model-list] 拉清单失败 status=${r.status} → 这次派活跟主模型一样`); return null; }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ at: Date.now(), ids: r.ids }));
    console.log(`[model-list] 缓存 ${r.ids.length} 个型号 → ${path.basename(f)}`);
    return r.ids;
  })().catch((e) => { console.log(`[model-list] 拉清单出错: ${e && e.message}`); return null; })
    .finally(() => inflight.delete(f));
  inflight.set(f, p);
  return p;
}

// 同步取: 返回盘上那份(过期也先用), 过期或没有就顺手在后台重拉
function get(a, table) {
  if (!a || !a.key) return null;
  let hit = null;
  try { hit = JSON.parse(fs.readFileSync(fileFor(a), 'utf8')); } catch (_) { /* 没有缓存 */ }
  if (!hit || Date.now() - (hit.at || 0) > TTL_MS) refresh(a, table);
  return hit && Array.isArray(hit.ids) ? hit.ids : null;
}

module.exports = { get, refresh, fileFor, TTL_MS };
