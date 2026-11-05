// memory-revisions.js — 统一修订日志(append-only · 按节点分片 · 不进图)。
//
// 为什么独立成模块: memory.js 已 460+ 行, 逼近"单文件 ≤500 行"红线; 且日志是**旁路**能力 ——
// 它不参与图检索、不被 doctor 扫、删掉整个 _revisions/ 目录图照样跑, 边界天然清晰。
//
// 为什么是日志不是图节点: 单条修订没有独立检索价值(没人 query"08-09 被推翻的那条是什么"),
// 价值只在聚合后出现; 几百个没人查的节点还会污染图(被 hot 排序、被 doctor 当孤儿报)。
// → 流水进日志, 规律进图。
//
// 为什么按 node_id 分片: 作者「日志可能是海量的, 怎么查找要有规则, 否则 token 燃烧没边」。
// 解法不是给它设计检索, 是**设计成不需要检索** —— 一个节点一个文件, 要查谁直接开谁, 天然定点。
// 白拿: memory.js 的 _mdFiles() 只扫 .md, 所以 .jsonl 天然不进图, 存储层一行代码不用改。
const fs = require('fs');
const path = require('path');

const DIR_NAME = '_revisions';
// 硬闸①: 单文件超此条数滚动归档。防无限膨胀。
const MAX_LINES = 50;
// 硬闸②: old_body/new_body 超此长度截断存摘要 + 原长。
const MAX_BODY = 2048;
// 剔除和修改是同一件事的两个 op, 不搞两套日志(作者: "其实本质一样啊")。
const OPS = new Set(['create', 'update', 'supersede', 'evict', 'merge']);

function revDir(memoryDir) { return path.join(memoryDir, DIR_NAME); }

// 文件名安全: 只保留 [a-z0-9_-], 其余(含 . / \ ..)一律剔除。
// 日志文件名完全由 node_id 派生, 必须保证它逃不出 _revisions/ —— 传 '../../etc/passwd' 也只能落在本目录。
function safeName(nodeId) {
  const s = String(nodeId || '').trim().toLowerCase().replace(/[^a-z0-9_\-]/g, '');
  return s || 'unknown';
}

// 本地时区 YYYY-MM-DD HH:MM (butler 编码约定禁 UTC)。
// 不从 memory.js 引: memory.js 要 require 本模块, 反向引会成循环依赖。
function localTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function truncField(v, max = MAX_BODY) {
  const s = v == null ? '' : String(v);
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[截断 · 原长 ${s.length} 字符]`;
}

// 硬闸①实现: 留【第一条 + 最近 max 条】。
// 第一条是出生记录永远留 —— 没有它就看不出这个节点最初为什么存在, 而那恰恰是漂移检测的基线。
function rollLog(file, max = MAX_LINES) {
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch (_) { return false; }
  if (lines.length <= max) return false;
  // lines.length > max ⇒ slice(-max) 起点 ≥ 1, 与 lines[0] 不会重复
  fs.writeFileSync(file, [lines[0], ...lines.slice(-max)].join('\n') + '\n', 'utf8');
  return true;
}

// 写一条修订。挂载点只有两个真内容写入位: upsert() 与 append()。
// linkBidirectional 只连边不改内容 → 不记; touch 只动 index → 不记。否则日志会被无意义流水淹没。
function logRevision(memoryDir, entry = {}) {
  const op = entry.op;
  if (!OPS.has(op)) throw new Error(`未知 op: ${op} (合法: ${[...OPS].join(' | ')})`);
  const nid = safeName(entry.node_id);
  const dir = revDir(memoryDir);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const file = path.join(dir, nid + '.jsonl');
  const rec = {
    ts: entry.ts || localTs(),
    op,
    node_id: nid,
    old_body: truncField(entry.old_body),
    new_body: truncField(entry.new_body),
    reason: entry.reason || '',
    basis: Array.isArray(entry.basis) ? entry.basis : (entry.basis ? [entry.basis] : []),
    auto: entry.auto !== false,
    asked: !!entry.asked,
    counterpart: entry.counterpart ? safeName(entry.counterpart) : '',
    // 🔴 事后被作者推翻会被二次写 —— 这条记录不是写完就完。
    overturned: entry.overturned != null ? entry.overturned : null,
  };
  try { fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8'); } catch (_) { return null; }
  rollLog(file);
  return { file, ts: rec.ts, node_id: nid };
}

// 用途 ①②④: 定点读单节点历史。一次 1–2k token 封顶, 因为一个节点一生也就几十条。
function revisionLog(memoryDir, nodeId, { limit = 0 } = {}) {
  const nid = safeName(nodeId);
  const file = path.join(revDir(memoryDir), nid + '.jsonl');
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); }
  catch (_) { return { node_id: nid, found: false, count: 0, entries: [] }; }
  const parsed = [];
  for (const l of lines) { try { parsed.push(JSON.parse(l)); } catch (_) {} }
  return { node_id: nid, found: true, count: parsed.length,
           entries: limit > 0 ? parsed.slice(-limit) : parsed };
}

// C3 机械筛: 只回条数, 不解析 JSON、不返回任何正文。
// 诚实说明: 省的是 **token**(结果进 context 的体积), 不是磁盘 IO —— 仍然要读文件数换行符。
// 用法: 先用它圈出"改动频繁 = 可能在漂移"的节点, 再对那几个开 revisionLog 精读。
function revisionCounts(memoryDir, { min = 1 } = {}) {
  const dir = revDir(memoryDir);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    let n = 0;
    try {
      const t = fs.readFileSync(path.join(dir, f), 'utf8');
      for (let i = 0; i < t.length; i++) if (t[i] === '\n') n++;
    } catch (_) { continue; }
    if (n >= min) out.push({ node_id: f.replace(/\.jsonl$/, ''), revisions: n });
  }
  return out.sort((a, b) => b.revisions - a.revisions || a.node_id.localeCompare(b.node_id));
}

// 用途: 把某条判决标成"事后被推翻"。按 ts 定位(同一节点同一分钟两条判决的概率忽略不计)。
// 这是 C6 统计的唯一真值来源 —— 没有它, 推翻率恒为 0, 整个自校正闭环是死的。
function markOverturned(memoryDir, nodeId, { ts, note = '' } = {}) {
  const nid = safeName(nodeId);
  const file = path.join(revDir(memoryDir), nid + '.jsonl');
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); }
  catch (_) { return { ok: false, reason: '无日志' }; }
  let hit = 0;
  const out = lines.map((l) => {
    let r; try { r = JSON.parse(l); } catch (_) { return l; }
    if (ts && r.ts !== ts) return l;
    if (!ts && hit) return l;            // 不给 ts 时只标最后一条
    r.overturned = { ts: localTs(), note };
    hit++;
    return JSON.stringify(r);
  });
  if (!ts) {                              // 不给 ts: 改最后一条
    for (let i = out.length - 1; i >= 0; i--) {
      let r; try { r = JSON.parse(out[i]); } catch (_) { continue; }
      if (r.overturned) break;
      r.overturned = { ts: localTs(), note }; out[i] = JSON.stringify(r); hit = 1; break;
    }
  }
  if (!hit) return { ok: false, reason: ts ? `没找到 ts=${ts} 的记录` : '日志为空' };
  try { fs.writeFileSync(file, out.join('\n') + '\n', 'utf8'); } catch (_) { return { ok: false, reason: '写失败' }; }
  return { ok: true, node_id: nid, marked: hit };
}

// C6 层 1/2: 推翻率(按 op) + 依据胜率(按 basis)。纯 JS 零 LLM。
// minSample 是这里的灵魂: 样本不足就**不给结论**, 只报 sample_short ——
// 3 条数据算出"66.7% 推翻率"是假精确, 会让人照着一个噪音去调策略。
function revisionStats(memoryDir, { minSample = 20 } = {}) {
  const dir = revDir(memoryDir);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch (_) { return null; }
  const byOp = {}, byBasis = {};
  let total = 0, autoTotal = 0, overturnedTotal = 0;
  for (const f of files) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean); } catch (_) { continue; }
    for (const l of lines) {
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      total++;
      const ot = r.overturned != null;
      if (r.auto) autoTotal++;
      if (ot) overturnedTotal++;
      const o = byOp[r.op] || (byOp[r.op] = { op: r.op, total: 0, auto: 0, overturned: 0 });
      o.total++; if (r.auto) o.auto++; if (ot) o.overturned++;
      for (const b of (r.basis || [])) {
        const e = byBasis[b] || (byBasis[b] = { basis: b, total: 0, win: 0, loss: 0 });
        e.total++; ot ? e.loss++ : e.win++;
      }
    }
  }
  // rate 只在样本够时给数, 否则 null + sample_short=true。判据不足时沉默, 不猜。
  const finish = (e) => {
    const short = e.total < minSample;
    return { ...e, sample_short: short,
             rate: short ? null : Math.round(1000 * (e.overturned != null ? e.overturned : e.loss) / e.total) / 10 };
  };
  return {
    total, auto: autoTotal, overturned: overturnedTotal, minSample,
    byOp: Object.values(byOp).map(finish).sort((a, b) => b.total - a.total),
    byBasis: Object.values(byBasis).map(finish).sort((a, b) => b.total - a.total),
  };
}

module.exports = {
  logRevision, revisionLog, revisionCounts, revisionStats, markOverturned,
  rollLog, safeName, revDir, MAX_LINES, MAX_BODY, OPS,
};
