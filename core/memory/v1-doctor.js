// v1 体检与冲突仲裁 · 修订历史透传
// 由 memory.js 拆出(内核抽包第 2 步)。方法体逐字搬运, 经 mixin 挂回 MemoryGraph.prototype。
const rev = require('../memory-revisions');
const arb = require('../memory-arbitration');
const {
  canon, today, COGNITION_REFRESH_N,
} = require('./primitives');

class V1DoctorMixin {
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
    // 🔴 进度必须可见, 否则失败模式是静默 ——「数据不够所以没触发」和「代码根本没跑 / 阈值拍错了」
    // 观感完全一样, 三个月后分不清。同源病见 feedback_diagnostic_signal_must_not_share_failure_mode。
    // 顺带把阈值合理性也暴露了: 三个月还停在 12/100, 说明阈值拍高了, 该调而不是该等。
    const counts = rev.revisionCounts(this.dir);
    const revTotal = counts.reduce((s, c) => s + c.revisions, 0);
    const zs = arb.zombies(idx.nodes, today());
    const dues = Object.values(idx.nodes)
      .filter((m) => m.id.startsWith('project_') && (m.status || 'active') === 'active' && m.review_due)
      .map((m) => m.review_due).sort();
    return {
      nodes: nodes.size, edges: idx.links.length, valid,
      validPct: idx.links.length ? Math.round(1000 * valid / idx.links.length) / 10 : 0,
      orphans, dangling: [...dangling.entries()].sort((a, b) => b[1] - a[1]).map(([id, cnt]) => ({ id, cnt })), mismatch,
      pinned: this.pinnedAudit(),
      zombies: zs,
      progress: {
        cognitionRefresh: `${revTotal}/${COGNITION_REFRESH_N} 条修订`,
        cognitionReady: revTotal >= COGNITION_REFRESH_N,
        zombieNextDue: dues.find((d) => d >= today()) || (dues.length ? '全部已过期' : '无在办 project'),
        revisionNodes: counts.length,
        topChanged: counts.slice(0, 5),
      },
    };
  }

  // —— 仲裁(旁路能力, 实现见 memory-arbitration.js) ——
  // 不动 query() 的签名是刻意的: 它是全链路最热的调用点, 改返回结构等于让所有调用方一起改。
  // 想要冲突提示的调用方显式用 queryWithSuspects, 老代码零感知。
  queryWithSuspects(q, opts = {}) {
    const results = this.query(q, opts);
    const idx = this._readIndex() || { nodes: {} };
    const enriched = results.map((r) => {
      const n = idx.nodes[r.id] || {};
      return { ...r, type: n.type, scope: n.scope, title: n.title };
    });
    return { results, suspects: arb.suspectPairs(enriched, opts) };
  }
  arbitrate(opts) {
    const r = arb.arbitrate(this.dir, opts);
    // 判决即记账: 这对已经有结论了, 定期体检不该再端上来问第二遍。
    try { arb.settleConflict(this.dir, { a: opts.winner, b: opts.loser, verdict: 'arbitrated', note: opts.reason || '' }); } catch (_) {}
    this.build();
    return r;
  }
  undoArbitrate(opts) { const r = arb.undoArbitrate(this.dir, opts); this.build(); return r; }
  zombies() { return arb.zombies(this._fresh().nodes, today()); }

  // —— 定期冲突体检(旁路能力, 实现见 memory-arbitration.js) ——
  conflictCandidates(opts = {}) {
    const idx = this._fresh();
    return arb.conflictCandidates(idx.nodes, idx.links, { ...opts, audit: arb.readAudit(this.dir) });
  }
  conflictSettle(opts) { return arb.settleConflict(this.dir, opts); }
  conflictScanDue(opts) { return arb.scanDue(this.dir, opts); }
  conflictMarkScanned(opts) { return arb.markScanned(this.dir, opts); }

  // —— 修订日志(旁路能力, 实现见 memory-revisions.js) ——
  // 薄封装的意义: 调用方只认 graph 一个门面, 不必知道日志落在哪、怎么分片。
  revisions(nodeId, opts) { return rev.revisionLog(this.dir, nodeId, opts); }
  revisionCounts(opts) { return rev.revisionCounts(this.dir, opts); }
  revisionStats(opts) { return rev.revisionStats(this.dir, opts); }
  markOverturned(nodeId, opts) { return rev.markOverturned(this.dir, nodeId, opts); }

}

module.exports = V1DoctorMixin;
