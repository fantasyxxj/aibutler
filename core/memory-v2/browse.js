// 浏览与游走: 解析引用 · 邻居 · touch 强化 · 热度/最近/时间线
// 由 memory-v2.js 拆出(内核抽包第 2 步)。方法体逐字搬运, 经 mixin 挂回 MemoryGraphV2.prototype。
const { canon, todayLocal, nowLocalISO } = require('../memory');
const { tune } = require('./tuning');

class BrowseMixin {
  // —— agent.js 会调到的其余接口(让 v2 能直接顶替 v1 实例) ——
  // v1 的 ensureReady 要扫 .md 建索引; v2 开库即就绪, 这里只回一份统计。
  ensureReady() { return this.store.stats(); }
  build() { return this.store.stats(); }
  hasNode(ref) { return !!this.resolve(ref); }
  revisions(ref, { limit = 20 } = {}) {
    const id = this.resolve(ref);
    return id ? this.store.historyOf(id, limit) : [];
  }
  // 检索 + 疑似冲突一起返回。冲突检出搭 query 的顺风车: 机械筛是纯 JS, 判不判架由读结果时顺带做,
  // 全程零额外 LLM 调用。时机也是刻意的 —— 正要拿这两条做事的那一刻, 上下文正好对得上。
  queryWithSuspects(q, opts = {}) {
    const results = this.query(q, opts);
    const hit = new Set(results.map((r) => r.id));
    const suspects = this.conflictCandidates({ max: 3, seeds: hit });
    return { results, suspects };
  }
  // 🔴 返回形状必须与 v1 的 arb.scanDue 一致({due,...}), 不能是裸 boolean。
  // 宿主 agent.js 起床清单那段写的是 `conflictScanDue().due` —— 裸 boolean 上取 .due 得 undefined,
  // 于是【冲突体检在 v2 下永远不注入】, 而且不报错。翻默认开关时才暴露出来:
  // 在此之前 dropin 测试反倒把裸 boolean 锁成了"正确"(它按 v2 自己的形状写断言, 而不是按 v1 的契约)。
  conflictScanDue({ days = 7, now = Date.now() } = {}) {
    const a = this._audit();
    const last = a.last_scan ? Date.parse(a.last_scan) : 0;
    return { due: !a.last_scan || (now - last) / 86400000 >= days, last_scan_at: last, days };
  }
  conflictMarkScanned({ now = Date.now() } = {}) {
    const a = this._audit();
    a.last_scan = nowLocalISO(new Date(now));
    this._saveAudit(a);
    return a.last_scan;
  }

  // —— 图 ——
  neighbors(id, { hops = 1 } = {}) {
    const idx = this._fresh();
    const { adj } = this._adjacency(idx);
    const seen = new Set([id]);
    let frontier = new Set([id]);
    const out = [];
    for (let h = 1; h <= hops; h++) {
      const nxt = new Set();
      for (const cur of frontier) {
        for (const nb of (adj.get(cur) || [])) {
          if (seen.has(nb)) continue;
          seen.add(nb); nxt.add(nb);
          const m = idx.nodes[nb];
          if (m) out.push({ id: nb, slug: m.slug, claim: m.claim, title: m.title, hops: h });
        }
      }
      frontier = nxt;
    }
    return out;
  }

  // 用过强化。收字符串(slug)或数字(id)都认 —— 我嘴里说得出的是 slug, 库里连的是数字。
  resolve(ref) {
    if (typeof ref === 'number') return ref;
    if (/^\d+$/.test(String(ref))) return parseInt(ref, 10);
    return this.store.idOf(canon(ref));
  }

  /* 5.2 共现自动建边。
     信号取"一起被 touch"而不是"一起被查出来": 后者只说明这两条词面像, 而检索本来就是靠词面
     找到它们的 —— 照着建边等于把检索已经知道的事又存一遍, 只会长出一堆同义反复的边。
     touch 是"我真靠这两条一起办成了一件事", 那才是检索看不见、值得记下来的关联。
     两道闸: ①一次 touch 超过 MAX 条按"扫库"算, 不建边 ②累计到 MIN 次才参与扩散(见 _adjacency)。 */
  touch(refs, { cooccur = true } = {}) {
    const list = Array.isArray(refs) ? refs : [refs];
    const done = [];
    for (const r of list) {
      const id = this.resolve(r);
      if (!id) continue;
      const m = this.store.node(id);
      if (!m) continue;
      this.store.setUsage(id, todayLocal(), (m.use_count || 0) + 1);
      // 尺子回填: touch = "我真靠这条做了决策"(铁律 4), 所以它是刚才那次检索**有没有帮上忙**
      // 的唯一硬证据。不回填的话召回日志只知道"给了什么", 不知道"有没有用", 度量就是空的。
      // 窗口大小由引擎侧给: 存储层不认识标定值(反向依赖 tuning 会把分层倒过来), 而这个数
      // 恰恰是要跟着 auto 召回占比反复调的 —— 窗口小了隔几轮再 touch 就记不上功, 失败率虚高。
      try { this.store.markRecallUsed(id, { lookback: tune('recall_used_window') }); } catch (_) {}
      // 🔴「用到了顺手改」: touch 的语义是"我真靠这条做了决策", 也就是**判断它准不准所需要的
      // 上下文此刻正好都在手上** —— 这是修它最省事的一刻, 过了就得重新读一遍才改得动。
      // 存量清洗因此是两条腿: 用到的这条在这里(零额外成本, 只碰真被用上的那几条), 没用到的
      // 交给体检隔一段时间摆一小批。**不能靠"一打开就把全库摆到眼前"** —— 那种清单没人做得动,
      // 而且做不动的清单会把整条轨道训成噪音, 连该做的那几条也一起被跳过。
      const dirty = [];
      if (/20\d\d-\d\d-\d\d/.test(m.claim || '')) dirty.push('claim line still contains a date');
      if (Number(m.claim_provisional) === 1) dirty.push('this claim was machine-padded with an old summary during migration; no one has judged it true or false');
      if (Number(m.claim_provisional) === 2) dirty.push('this claim is still marked "under discussion" and has never been settled');
      done.push({ id, slug: m.slug, use_count: (m.use_count || 0) + 1, claim: m.claim || '', dirty });
    }
    if (cooccur && done.length >= 2 && done.length <= tune('co_touch_max_batch')) {
      try {
        for (let i = 0; i < done.length; i++) {
          for (let j = i + 1; j < done.length; j++) this.store.bumpCoEdge(done[i].id, done[j].id);
        }
      } catch (e) { console.error('[co-edge] 长边失败(不挡 touch):', e && e.message); }
    }
    return done;
  }

  hot(k = 20) {
    const idx = this._fresh();
    return Object.values(idx.nodes)
      .filter((m) => (m.status || 'active') !== 'archived')
      .map((m) => ({ id: m.id, slug: m.slug, title: m.title, claim: m.claim,
                     importance: m.importance, pinned: idx.pinned.has(m.id),
                     hot: this._hot(m), use_count: m.use_count, last_used: m.last_used }))
      .sort((a, b) => b.hot - a.hot)
      .slice(0, k);
  }

  recent(k = 5) {
    const idx = this._fresh();
    return Object.values(idx.nodes)
      .sort((a, b) => String(b.last_used || '').localeCompare(String(a.last_used || '')))
      .slice(0, k)
      .map((m) => ({ id: m.id, slug: m.slug, title: m.title, claim: m.claim, last_used: m.last_used }));
  }

  timeline(k = 30, by = 'last_used') {
    const idx = this._fresh();
    const key = by === 'created' ? 'created' : 'last_used';
    return Object.values(idx.nodes)
      .sort((a, b) => String(b[key] || '').localeCompare(String(a[key] || '')))
      .slice(0, k)
      .map((m) => ({ id: m.id, slug: m.slug, title: m.title, claim: m.claim, [key]: m[key] }));
  }

  // 这条知识是谁给的: platform | local | override, 没这个节点则 null。
  // 行业版知识包下发靠它判要不要覆盖 —— 店里改写过的(override)不能被出厂原文冲掉。
  originOf(ref) {
    const nid = this.resolve(ref);
    if (!nid) return null;
    const n = this.store.node(nid);
    return n ? (n.provenance || 'local') : null;
  }

}

module.exports = BrowseMixin;
