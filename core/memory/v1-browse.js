// v1 浏览: 邻居 · touch · 热度/最近/时间线 · 快查集 · 重要性
// 由 memory.js 拆出(内核抽包第 2 步)。方法体逐字搬运, 经 mixin 挂回 MemoryGraph.prototype。
const fs = require('fs');
const path = require('path');
const rev = require('../memory-revisions');
const {
  canon, hotness, today, nowLocalISO, parseFrontmatter, PINNED_QUOTA, TYPE_DEFAULT_IMP, IMP_BASE, PINNED_STALE_HINT,
} = require('./primitives');

class V1BrowseMixin {
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
    const hits = [];
    for (const raw of (Array.isArray(names) ? names : [names])) {
      const name = canon(raw);
      const m = idx.nodes[name];
      if (!m) { res.push({ id: name, ok: false }); continue; }
      m.last_used = today(); m.use_count = (m.use_count || 1) + 1;
      hits.push(m);
      res.push({ id: name, ok: true, last_used: m.last_used, use_count: m.use_count });
    }
    // 只写这几行, 不碰 .md 文件 —— touch 是"我用过它"的信号, 不是内容变更。
    // 写回文件会刷新 mtime, 于是下次 _sync 判它变了要重解析, 白白把增量退化成全量。
    if (hits.length) this.store.transaction(() => {
      for (const m of hits) this.store.setUsage(m.id, m.last_used, m.use_count);
    });
    return res;
  }

  // §2.2 pre-query 挡门用: 判断某 id 是否已在图中 (canon 后匹配).
  hasNode(id) {
    const nid = canon(id);
    const idx = this._fresh();
    return !!(idx && idx.nodes && idx.nodes[nid]);
  }

  // —— 迁移: memory_index.json → SQLite ——
  // 🔴 为什么必须迁移而不是直接从 .md 重扫: last_used / use_count(热度史)【只活在索引里】。
  // .md 的 frontmatter 里虽然也有这两行, 但 touch 是不写文件的(写了会刷 mtime 拖垮增量),
  // 所以文件里那份是陈旧的。丢了热度史 = 全库热度归零 = hot()/起床清单/pinned 排序一起失真,
  // 而且不可恢复 —— 那是两个多月每天使用积累出来的信号。
  //
  // 幂等: 迁过就在 meta 里盖章, 重复调用直接返回。人格随时可能被关掉, 所以整个导入包在一个事务里,
  // 中断则整体回滚, 下次重来 —— 不存在"迁到一半"的中间态。
  migrateFromJson({ force = false } = {}) {
    const done = this.store.getMeta('migrated_from_json');
    if (done && !force) return { migrated: false, reason: 'already-done' };
    let old = null;
    try { old = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')); } catch (_) {}
    // 没有旧索引 = 全新人格, 不算失败: 盖章后走正常的 .md 全量建库路径。
    if (!old || !old.nodes) {
      this.store.setMeta('migrated_from_json', nowLocalISO());
      this.rebuild();
      return { migrated: false, reason: 'no-legacy-index', nodes: this._stats().nodes };
    }
    // 先按 .md 建全图(内容以文件为准), 再把热度史盖回去(热度以旧索引为准)。
    this.rebuild();
    const idx = this._idx();
    let heat = 0;
    this.store.transaction(() => {
      for (const [id, o] of Object.entries(old.nodes)) {
        const cur = idx.nodes[id];
        if (!cur) continue;                 // 旧索引里有、文件已删的, 不复活
        const lu = o.last_used || cur.last_used;
        const uc = Math.max(parseInt(o.use_count || 1, 10), parseInt(cur.use_count || 1, 10));
        this.store.setUsage(id, lu, uc);
        heat++;
      }
      this.store.setMeta('migrated_from_json', nowLocalISO());
      this.store.setMeta('legacy_index_nodes', String(Object.keys(old.nodes).length));
    });
    this._cache = null;
    // 🔴 刻意不删 memory_index.json。它是唯一的热度史备份, 留着才有回退余地 ——
    // 万一这版库出问题要回滚到 0.0.55, 那个文件必须还在(feedback_migration_never_run_seed_wipe_script)。
    const st = this._stats();
    return { migrated: true, nodes: st.nodes, links: st.links, heatRestored: heat,
             legacyNodes: Object.keys(old.nodes).length };
  }

  // 人格启动时调这一下就够: 没迁过就迁, 迁过就只做增量同步。
  ensureReady() {
    const done = this.store.getMeta('migrated_from_json');
    if (!done) return this.migrateFromJson();
    this._fresh();
    return { migrated: false, reason: 'already-done', ...this._stats() };
  }

  hot(k = 20) {
    const idx = this._fresh();
    return Object.values(idx.nodes)
      .map((m) => ({ id: m.id, hot: hotness(m.importance, m.last_used, m.use_count), importance: m.importance,
                     use_count: m.use_count, last_used: m.last_used, description: (m.description || '').slice(0, 70) }))
      .sort((a, b) => b.hot - a.hot).slice(0, k);
  }

  // 起床用: pinned 全量(受 PINNED_QUOTA 保护), 不参与热度竞争排序。
  // 为什么全量而不是 top-N: "遵守悖论"在 pinned 内部同样成立 —— 被老实遵守的红线 use_count 不涨、
  // 会沉到队尾, 只取 top-N 等于配额加了、通胀治了, 最该常驻的那几条还是漏。30 条 ≈ 800 tokens。
  // 排序只为输出稳定(热的在前), 语义上每条都要注入, 次序不承载取舍。
  pinnedAll() {
    const idx = this._fresh();
    return Object.values(idx.nodes)
      .filter((m) => (m.importance || '').toLowerCase() === 'pinned')
      .map((m) => ({ id: m.id, hot: hotness(m.importance, m.last_used, m.use_count),
                     description: (m.description || '').slice(0, 70) }))
      .sort((a, b) => b.hot - a.hot);
  }

  // pinned 配额体检: 报超限 + 出降级候选名单。只推荐不自动执行 (理由见 PINNED_QUOTA 注释)。
  // 候选排序 = 机械筛圈定: ① id 命中 stale 提示词(已 ship/已弃/带版本号) ② 文件 mtime 最老。
  // 真正判"该不该降"是 AI 的判断力, 判据唯一权威文本在 config/onboarding/leaf_07_memory_hygiene.md, 此处不复述。
  pinnedAudit() {
    const idx = this._fresh();
    const list = Object.values(idx.nodes)
      .filter((m) => (m.importance || '').toLowerCase() === 'pinned')
      .map((m) => {
        let mtime = 0;
        try { mtime = fs.statSync(m.file_path).mtimeMs; } catch (_) {}
        return { id: m.id, mtime, stale: PINNED_STALE_HINT.test(m.id),
                 description: (m.description || '').slice(0, 70) };
      });
    const over = Math.max(0, list.length - PINNED_QUOTA);
    const candidates = list
      .sort((a, b) => (b.stale - a.stale) || (a.mtime - b.mtime))
      .slice(0, over ? over + 5 : 5);
    return { count: list.length, quota: PINNED_QUOTA, over, candidates };
  }

  // 改一个节点的 importance, 不碰正文 —— 配额满时"上一个下一个"里"下一个"那半边动作。
  // 不复用 upsert 是刻意的: upsert 整体重写 frontmatter + body, 拿它来降级就得先把正文原样读回来
  // 再写一遍, 而那正是 feedback_memory_upsert_overwrites_body_read_merge_first 那次丢内容的路径。
  // 降级只该动一行, 就让它只动一行。
  setImportance(id, importance, reason = '') {
    const nid = canon(id);
    const fname = path.join(this.dir, nid + '.md');
    if (!fs.existsSync(fname)) throw new Error(`节点不存在: ${nid}`);
    const imp = String(importance || '').toLowerCase();
    if (!(imp in IMP_BASE)) throw new Error(`importance 只能是 pinned/high/med/low, 收到: ${importance}`);
    const raw = fs.readFileSync(fname, 'utf8');
    const head = raw.match(/^---\n[\s\S]*?\n---\n?/);
    if (!head) throw new Error(`${nid}.md 没有 frontmatter, 不敢动`);
    const [prevFm] = parseFrontmatter(raw);
    const from = (prevFm && prevFm.importance) || '';
    let block = head[0];
    const replaced = block.replace(/^(\s*importance:\s*).*$/m, `$1${imp}`);
    // 老节点可能整行没写 importance(靠 TYPE_DEFAULT_IMP 兜底), 那就在 metadata: 下补一行。
    block = replaced !== block ? replaced : block.replace(/^(metadata:\s*)$/m, `$1\n  importance: ${imp}`);
    // 不动 last_used: 降级是元数据维护, 不是"我用过它"。混进去会污染 recent 段
    // (2026-08-07 批量降 36 条 pinned 后当场复现过, 见 recent() 注释)。
    fs.writeFileSync(fname, block + raw.slice(head[0].length), 'utf8');
    this.build();
    // 留痕: 正文没变所以 old/new_body 空, 但"某条红线什么时候退的休、为什么退"日后要追得到。
    try {
      rev.logRevision(this.dir, { node_id: nid, op: 'update',
        reason: `importance ${from || '(默认)'}→${imp}${reason ? ' · ' + reason : ''}` });
    } catch (_) {}
    return { id: nid, from, to: imp };
  }

  // 起床用: 最近真正动过的 N 条, 纯时间轴不看 importance —— 与 hot() 互补。
  // 排序 = last_used(天级) 主序 + mtime 同日内 tiebreak, 两级各治一个病:
  //   · 只用 last_used: 只到"天"精度, 同一天沉的十几条并列 → 退化字母序(实测 archive_* 因 a 开头排第一)
  //   · 只用 mtime: 任何批量元数据操作(降级 pinned / doctor 修复 / 格式迁移)都会把一批老节点的 mtime
  //     刷成"现在", 于是 recent 段全是刚被批处理的老货 —— 实测 2026-08-07 降级 36 条 pinned 后当场复现。
  // 两级组合后: 批量改 frontmatter 不动 last_used, 主序不受污染; 同日内仍有真实先后。
  recent(k = 5) {
    const idx = this._fresh();
    return Object.values(idx.nodes)
      .map((m) => {
        let mtime = 0;
        try { mtime = fs.statSync(m.file_path).mtimeMs; } catch (_) {}
        return { id: m.id, mtime, date: m.last_used || m.created, type: m.type,
                 importance: m.importance, description: (m.description || '').slice(0, 70) };
      })
      .sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.mtime - a.mtime))
      .slice(0, k);
  }

  // 时间线: 日期视图从图派生(替代手工编年史)。by='last_used'|'created'
  timeline(k = 30, by = 'last_used') {
    const idx = this._fresh();
    return Object.values(idx.nodes)
      .map((m) => ({ id: m.id, date: m[by] || m.created, type: m.type, importance: m.importance,
                     description: (m.description || '').slice(0, 70) }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, k);
  }

}

module.exports = V1BrowseMixin;
