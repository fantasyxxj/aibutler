// memory.js — 人格原生图记忆引擎(纯 JS, 无原生依赖)。
// memory_db.py v2 的忠实移植: canon(文件名)锚 + [[链接]]边 + 遗忘曲线热度 + 图扩散检索 + doctor。
// 存储从 SQLite 换成 memory_index.json(落 memoryDir), build 重建时保留 touch 的 last_used/use_count。
// 每个人格 new MemoryGraph(memoryDir) 各自一张图 → 「完整人格自带图记忆」。
const fs = require('fs');
const path = require('path');

const IMP_BASE = { pinned: 100.0, high: 6.0, med: 3.0, low: 1.0 };
const IMP_HL   = { pinned: 99999, high: 120, med: 45, low: 14 };
const REC_W = 5.0;
const TYPE_DEFAULT_IMP = { feedback: 'high', reference: 'med', project: 'med', user: 'high' };
const HOP_DECAY = 0.45;                                  // 每跳激活衰减
const SKIP_LINK = new Set(['name', 'their_name', 'name_slug']);  // 文档示例假链接(canon 后)
const SKIP_FILES = new Set(['MEMORY.md', 'archive_index.md']);
const INDEX_FILE = 'memory_index.json';

const canon = (s) => (s || '').trim().toLowerCase().replace(/-/g, '_');

function today() {
  // 北京时间(UTC+8) 的 YYYY-MM-DD, 与 python 端一致
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function daysBetween(d1, d2) {
  const a = Date.parse(d1 + 'T00:00:00Z'), b = Date.parse(d2 + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}
function hotness(importance, lastUsed, useCount) {
  const imp = (importance || 'low').toLowerCase();
  const base = IMP_BASE[imp] != null ? IMP_BASE[imp] : 1.0;
  const hl = (IMP_HL[imp] != null ? IMP_HL[imp] : 14) * (1 + Math.log(1 + Math.max(0, useCount || 0)));
  const d = daysBetween(lastUsed || today(), today());
  const recency = hl > 0 ? Math.exp(-d / hl) : 0;
  return Math.round((base + REC_W * recency) * 1000) / 1000;
}
const hubDamp = (deg) => 1.0 / (1.0 + Math.log(1 + Math.max(0, deg || 0)));

function parseFrontmatter(text) {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text);
  if (!m) return [{}, text];
  const fm = {};
  for (const line of m[1].split('\n')) {
    const mm = /^\s*([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (mm) {
      const k = mm[1].trim();
      let v = mm[2].trim().replace(/^["']|["']$/g, '');
      if (v && !(k in fm)) fm[k] = v;
    }
  }
  return [fm, m[2]];
}

class MemoryGraph {
  constructor(memoryDir) {
    this.dir = path.resolve(memoryDir);
    this.indexPath = path.join(this.dir, INDEX_FILE);
  }

  _mdFiles() {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.md') && !SKIP_FILES.has(f)); }
    catch (_) { return []; }
    return files.map((f) => path.join(this.dir, f)).sort();
  }

  // 重建索引: 扫 *.md → 节点(canon 文件名锚)+边([[链接]]), 保留旧 index 的 last_used/use_count
  build() {
    const prev = this._readIndex() || { nodes: {} };
    const nodes = {};
    const links = [];
    for (const f of this._mdFiles()) {
      let text;
      try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
      const [fm, body] = parseFrontmatter(text);
      const id = canon(path.basename(f, '.md'));
      const typ = (fm.type || '').toLowerCase();
      const old = prev.nodes[id] || {};
      let created = fm.created || old.created;
      if (!created) { try { created = new Date(fs.statSync(f).mtime).toISOString().slice(0, 10); } catch (_) { created = today(); } }
      const last_used = fm.last_used || old.last_used || created;
      const use_count = parseInt(fm.use_count || old.use_count || 1, 10);
      const importance = (fm.importance || TYPE_DEFAULT_IMP[typ] || 'low').toLowerCase();
      nodes[id] = {
        id, title: fm.name || path.basename(f), description: (fm.description || '').slice(0, 500),
        type: typ, importance, created, last_used, use_count, file_path: f, body: body.slice(0, 4000),
      };
      const seen = new Set();
      for (const mm of body.matchAll(/\[\[([A-Za-z0-9_\-]+)\]\]/g)) {
        const dst = canon(mm[1]);
        if (dst === id || SKIP_LINK.has(dst) || seen.has(dst)) continue;
        seen.add(dst); links.push([id, dst]);
      }
    }
    const idset = new Set(Object.keys(nodes));
    const valid = links.filter(([, d]) => idset.has(d)).length;
    const index = { builtAt: Date.now(), nodes, links };
    this._writeIndex(index);
    return { nodes: idset.size, links: links.length, valid, validPct: links.length ? Math.round(1000 * valid / links.length) / 10 : 0 };
  }

  _readIndex() {
    try { return JSON.parse(fs.readFileSync(this.indexPath, 'utf8')); } catch (_) { return null; }
  }
  _writeIndex(index) {
    try { fs.writeFileSync(this.indexPath, JSON.stringify(index)); } catch (_) {}
  }
  // 自动保鲜: 索引缺失, 或任一 .md 比 builtAt 新 → 重建
  _fresh() {
    const idx = this._readIndex();
    if (!idx || !idx.nodes) { this.build(); return this._readIndex(); }
    let newest = 0;
    for (const f of this._mdFiles()) { try { const t = fs.statSync(f).mtimeMs; if (t > newest) newest = t; } catch (_) {} }
    if (newest > (idx.builtAt || 0)) { this.build(); return this._readIndex(); }
    return idx;
  }

  // 无向邻接(关联双向), 仅两端都是真节点的边
  _adjacency(idx) {
    const nodes = new Set(Object.keys(idx.nodes));
    const adj = new Map();
    for (const [s, d] of idx.links) {
      if (nodes.has(s) && nodes.has(d)) {
        if (!adj.has(s)) adj.set(s, new Set()); adj.get(s).add(d);
        if (!adj.has(d)) adj.set(d, new Set()); adj.get(d).add(s);
      }
    }
    const deg = new Map();
    for (const n of nodes) deg.set(n, adj.has(n) ? adj.get(n).size : 0);
    return { nodes, adj, deg };
  }

  _flatScores(idx, terms) {
    const out = new Map();
    for (const m of Object.values(idx.nodes)) {
      const hay = (m.id + ' ' + (m.title || '')).toLowerCase();
      const dhay = (m.description || '').toLowerCase();
      let rel = 0;
      for (const t of terms) { if (hay.includes(t)) rel += 3; }
      for (const t of terms) { if (dhay.includes(t)) rel += 1; }
      if (terms.length && rel === 0) continue;
      const h = hotness(m.importance, m.last_used, m.use_count);
      out.set(m.id, { combined: rel * 2 + h, hot: h, rel });
    }
    return out;
  }

  // 图扩散检索: 扁平命中做种子 → 沿边逐跳扩散(枢纽抑制), 捞回名字不含关键词但被链上的关联记忆
  query(q, { k = 8, hops = 2, flat = false } = {}) {
    const idx = this._fresh();
    const terms = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const flatM = this._flatScores(idx, terms);
    if (!flatM.size) return [];
    const act = new Map(), via = new Map();
    for (const [id, v] of flatM) { act.set(id, v.combined); via.set(id, '直接'); }
    if (!flat) {
      const { adj, deg } = this._adjacency(idx);
      let frontier = new Map([...flatM].map(([id, v]) => [id, v.combined]));
      for (let hop = 1; hop <= hops; hop++) {
        const nxt = new Map();
        for (const [id, energy] of frontier) {
          for (const nb of (adj.get(id) || [])) {
            const add = energy * HOP_DECAY * hubDamp(deg.get(nb));
            if (add < 0.3) continue;
            act.set(nb, (act.get(nb) || 0) + add);
            nxt.set(nb, Math.max(nxt.get(nb) || 0, add));
            if (!flatM.has(nb) && !via.has(nb)) via.set(nb, `图·${hop}跳←${id.slice(0, 28)}`);
          }
        }
        frontier = nxt;
      }
    }
    const ranked = [...act.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
    return ranked.map(([id, score]) => {
      const m = idx.nodes[id] || {};
      return { id, score: Math.round(score * 10) / 10, via: via.get(id) || '图',
               description: m.description || '', file_path: m.file_path || '',
               importance: m.importance, last_used: m.last_used, hot: hotness(m.importance, m.last_used, m.use_count) };
    });
  }

  neighbors(id, { hops = 1 } = {}) {
    const idx = this._fresh();
    const { nodes, adj } = this._adjacency(idx);
    let nid = canon(id);
    if (!nodes.has(nid)) {
      const cand = [...nodes].filter((n) => n.includes(nid) || n.endsWith(nid));
      if (!cand.length) return { id: nid, found: false, neighbors: [] };
      nid = cand[0];
    }
    const desc = (n) => (idx.nodes[n] && idx.nodes[n].description || '').slice(0, 70);
    const seen = new Set([nid]);
    const out = [];
    let frontier = [nid];
    for (let hop = 1; hop <= hops; hop++) {
      const nxt = [];
      for (const x of frontier) {
        for (const nb of [...(adj.get(x) || [])].sort()) {
          if (seen.has(nb)) continue;
          seen.add(nb); nxt.push(nb);
          out.push({ hop, id: nb, description: desc(nb) });
        }
      }
      frontier = nxt;
    }
    return { id: nid, found: true, description: desc(nid), neighbors: out };
  }

  touch(names) {
    const idx = this._fresh();
    const res = [];
    for (const raw of (Array.isArray(names) ? names : [names])) {
      const name = canon(raw);
      const m = idx.nodes[name];
      if (!m) { res.push({ id: name, ok: false }); continue; }
      m.last_used = today(); m.use_count = (m.use_count || 1) + 1;
      res.push({ id: name, ok: true, last_used: m.last_used, use_count: m.use_count });
    }
    this._writeIndex(idx);
    return res;
  }

  // §2.2 pre-query 挡门用: 判断某 id 是否已在图中 (canon 后匹配).
  hasNode(id) {
    const nid = canon(id);
    const idx = this._readIndex();
    return !!(idx && idx.nodes && idx.nodes[nid]);
  }

  hot(k = 20) {
    const idx = this._fresh();
    return Object.values(idx.nodes)
      .map((m) => ({ id: m.id, hot: hotness(m.importance, m.last_used, m.use_count), importance: m.importance,
                     use_count: m.use_count, last_used: m.last_used, description: (m.description || '').slice(0, 70) }))
      .sort((a, b) => b.hot - a.hot).slice(0, k);
  }

  // 时间线: 日期视图从图派生(替代手工编年史)。by='last_used'|'created'
  timeline(k = 30, by = 'last_used') {
    const idx = this._fresh();
    return Object.values(idx.nodes)
      .map((m) => ({ id: m.id, date: m[by] || m.created, type: m.type, importance: m.importance,
                     description: (m.description || '').slice(0, 70) }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, k);
  }

  doctor() {
    const idx = this._fresh();
    const nodes = new Set(Object.keys(idx.nodes));
    const deg = new Map(), dangling = new Map();
    for (const [s, d] of idx.links) {
      if (nodes.has(d)) { deg.set(s, (deg.get(s) || 0) + 1); deg.set(d, (deg.get(d) || 0) + 1); }
      else dangling.set(d, (dangling.get(d) || 0) + 1);
    }
    const orphans = [...nodes].filter((n) => !(deg.get(n) > 0));
    const valid = idx.links.filter(([, d]) => nodes.has(d)).length;
    const mismatch = [];
    for (const m of Object.values(idx.nodes)) {
      const t = m.title || '';
      if (t.endsWith('.md')) continue;
      if (t && canon(t) !== m.id) mismatch.push({ id: m.id, name: t });
    }
    return {
      nodes: nodes.size, edges: idx.links.length, valid,
      validPct: idx.links.length ? Math.round(1000 * valid / idx.links.length) / 10 : 0,
      orphans, dangling: [...dangling.entries()].sort((a, b) => b[1] - a[1]).map(([id, cnt]) => ({ id, cnt })), mismatch,
    };
  }

  // 建/更新一个记忆节点 .md(把「事情」放进图的原语): 写 frontmatter + body + [[links]], 重建索引
  upsert({ id, title, type = 'project', importance, description = '', body = '', links = [] }) {
    if (!id) throw new Error('upsert 需要 id');
    const nid = canon(id);
    const fname = path.join(this.dir, nid + '.md');
    const now = today();
    // spec §2.1 auto-touch: init 0, 结尾 +=1 → 新建首沉=1 (等价手动 touch), update=existing+1.
    // 语义"凡 upsert 皆一次'我用过'signal", 跟 memory_touch 收紧后语义闭环.
    // fallback ||1 三处 (build line 82 / touch line 216 / update 老值兜底) 保守不动.
    let created = now, last_used = now;
    let use_count = 0;
    const existing = this._readIndex();
    if (existing && existing.nodes[nid]) {
      created = existing.nodes[nid].created || now;
      last_used = now; use_count = (existing.nodes[nid].use_count || 1);
    }
    use_count += 1;
    const imp = importance || TYPE_DEFAULT_IMP[type] || 'med';
    const linkBlock = (links && links.length)
      ? '\n\n## 关联\n' + links.map((l) => `[[${canon(l)}]]`).join(' · ') : '';
    const fm = [
      '---', `name: ${title || nid}`, `description: "${String(description).replace(/"/g, "'").slice(0, 480)}"`,
      'metadata:', '  node_type: memory', `  type: ${type}`, `  importance: ${imp}`,
      `  created: ${created}`, `  last_used: ${last_used}`, `  use_count: ${use_count}`, '---', '',
    ].join('\n');
    fs.writeFileSync(fname, fm + body + linkBlock + '\n', 'utf8');
    const stats = this.build();
    return { id: nid, file_path: fname, ...stats };
  }
}

module.exports = { MemoryGraph, canon, hotness, today };
