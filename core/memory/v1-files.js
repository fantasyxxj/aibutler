// v1 的 .md 真源: 扫文件 · 解析 · 增量同步 · 索引与统计
// 由 memory.js 拆出(内核抽包第 2 步)。方法体逐字搬运, 经 mixin 挂回 MemoryGraph.prototype。
const fs = require('fs');
const path = require('path');
const {
  canon, today, todayLocal, parseFrontmatter, TYPE_DEFAULT_IMP, SKIP_FILES, SKIP_LINK,
} = require('./primitives');

class V1FilesMixin {
  _mdFiles() {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.md') && !SKIP_FILES.has(f)); }
    catch (_) { return []; }
    return files.map((f) => path.join(this.dir, f)).sort();
  }

  // 解析单个 .md → 节点 + 出边。build 与增量同步共用, 保证两条路径解析结果逐字段一致。
  _parseFile(f, prevRow) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (_) { return null; }
    let st = null;
    try { st = fs.statSync(f); } catch (_) {}
    const [fm, body] = parseFrontmatter(text);
    const id = canon(path.basename(f, '.md'));
    const typ = (fm.type || '').toLowerCase();
    const old = prevRow || {};
    let created = fm.created || old.created;
    if (!created) { created = st ? todayLocal(new Date(st.mtime)) : today(); }
    // 热度史(last_used/use_count)只活在库里, .md 里那两行可能是旧的 —— 但仍以 frontmatter 优先,
    // 因为 upsert/append 会同步写回文件, 而人手工改文件时那也是他的意思。
    const last_used = fm.last_used || old.last_used || created;
    const use_count = parseInt(fm.use_count || old.use_count || 1, 10);
    const importance = (fm.importance || TYPE_DEFAULT_IMP[typ] || 'low').toLowerCase();
    const node = {
      id, title: fm.name || path.basename(f), description: (fm.description || '').slice(0, 500),
      type: typ, importance, created, last_used, use_count, file_path: f, body: body.slice(0, 4000),
      status: (fm.status || 'active').toLowerCase(),
      superseded_by: fm.superseded_by ? canon(fm.superseded_by) : '',
      scope: fm.scope || '',
      origin: fm.origin || '',
      exit_criteria: fm.exit_criteria || '',
      review_due: fm.review_due || '',
      mtime: st ? st.mtimeMs : 0, size: st ? st.size : 0,
    };
    const dsts = [];
    const seen = new Set();
    for (const mm of body.matchAll(/\[\[([A-Za-z0-9_\-]+)\]\]/g)) {
      const dst = canon(mm[1]);
      if (dst === id || SKIP_LINK.has(dst) || seen.has(dst)) continue;
      seen.add(dst); dsts.push(dst);
    }
    return { node, dsts };
  }

  // 同步 .md → 库。只解析【签名变了】的文件(mtime 或 size 不同), 这是换库的全部意义所在:
  // 旧实现每次 upsert 都重读 742 个文件重写 3.1MB, 现在只碰刚写的那一个。
  // 返回是否发生了变动 —— 调用方据此决定要不要丢弃内存快照。
  _sync() {
    const sigs = this.store.fileSigs();
    const files = this._mdFiles();
    const seen = new Set();
    const changed = [];
    for (const f of files) {
      const id = canon(path.basename(f, '.md'));
      seen.add(id);
      let st = null;
      try { st = fs.statSync(f); } catch (_) { continue; }
      const old = sigs.get(id);
      // size 一并比对: mtime 在某些文件系统上只有秒级精度, 同一秒内的两次写会漏判。
      if (old && old.mtime === st.mtimeMs && old.size === st.size) continue;
      changed.push(f);
    }
    const gone = [...sigs.keys()].filter((id) => !seen.has(id));
    if (!changed.length && !gone.length) return false;
    const prev = changed.length ? this.store.allNodes() : {};
    this.store.transaction(() => {
      for (const f of changed) {
        const parsed = this._parseFile(f, prev[canon(path.basename(f, '.md'))]);
        if (!parsed) continue;
        this.store.putNode(parsed.node);
        this.store.replaceLinks(parsed.node.id, parsed.dsts);
      }
      // 文件没了就删节点。这条是必须的: 否则 arbitrate/归档删掉 .md 后, 图里仍留着一条
      // 永远命中不到文件的幽灵节点, 而它照样参与检索和 pinned 配额。
      if (gone.length) this.store.deleteNodes(gone);
    });
    return true;
  }

  // 全量重建: 清库后从 .md 重扫。仅 doctor/迁移/门禁用 —— 日常写路径走 _sync 增量。
  rebuild() {
    const prev = this.store.allNodes();
    this.store.transaction(() => {
      this.store.deleteNodes(Object.keys(prev));
      for (const f of this._mdFiles()) {
        const parsed = this._parseFile(f, prev[canon(path.basename(f, '.md'))]);
        if (!parsed) continue;
        this.store.putNode(parsed.node);
        this.store.replaceLinks(parsed.node.id, parsed.dsts);
      }
    });
    this._cache = null;
    return this._stats();
  }

  // 兼容旧签名: build() 一直是"把磁盘上的 .md 变成可检索的图"这个语义, 只是实现从
  // 全量重写换成了增量同步。所有调用方(upsert/append/link/门禁)零改动。
  build() {
    if (this._sync()) this._cache = null;
    return this._stats();
  }

  _stats() {
    const idx = this._idx();
    const idset = new Set(Object.keys(idx.nodes));
    const valid = idx.links.filter(([, d]) => idset.has(d)).length;
    return { nodes: idset.size, links: idx.links.length, valid,
             validPct: idx.links.length ? Math.round(1000 * valid / idx.links.length) / 10 : 0 };
  }

  // 内存快照。形状与旧 memory_index.json 完全一致({nodes, links}), 所以下游全部逻辑
  // (邻接表/热度/doctor/仲裁) 一行都不用改 —— 换的只是它从哪来。
  _idx() {
    if (!this._cache) this._cache = { nodes: this.store.allNodes(), links: this.store.allLinks() };
    return this._cache;
  }

  _readIndex() { return this._idx(); }
  // 旧 JSON 索引的写入口。库接管后不再落盘 —— 留空实现是为了老调用方(如迁移脚本)不炸。
  _writeIndex() {}

  // 自动保鲜: 每次读之前先看有没有 .md 动过。stat 742 个文件约 3ms,
  // 比旧实现"读 + JSON.parse 3.1MB"(约 20ms)还便宜, 而且不随正文总量增长。
  _fresh() {
    if (this._sync()) this._cache = null;
    return this._idx();
  }

}

module.exports = V1FilesMixin;
