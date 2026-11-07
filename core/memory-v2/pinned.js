// 常驻集(pinned)与红线, 外加发言/召回日志的薄透传
// 由 memory-v2.js 拆出(内核抽包第 2 步)。方法体逐字搬运, 经 mixin 挂回 MemoryGraphV2.prototype。
const { todayLocal, PINNED_QUOTA, PINNED_MAX_CHARS, PINNED_STALE_HINT } = require('../memory');
const { cfg: hostCfg } = require('./host');
const { validateTrigger } = require('../redline-guard');

class PinnedMixin {
  // —— pinned / 红线 ——
  pinnedAll() {
    const idx = this._fresh();
    const meta = this.store.pinnedMeta();
    return [...idx.pinned].map((id) => idx.nodes[id]).filter(Boolean)
      .map((m) => ({ id: m.id, slug: m.slug, title: m.title, claim: m.claim,
                     importance: m.importance, hot: this._hot(m),
                     use_count: m.use_count,
                     pin_reason: (meta.get(m.id) || {}).reason || '',
                     pinned_at: (meta.get(m.id) || {}).added_at || '' }));
  }

  // 常驻那一份: 只取 active 的, 按标上的先后排(先立的规矩在前, 不随热度抖)。
  pinnedResident() {
    return this.pinnedAll()
      .filter((m) => ((this.store.node(m.id) || {}).status || 'active') === 'active')
      .sort((a, b) => String(a.pinned_at).localeCompare(String(b.pinned_at)) || a.id - b.id);
  }

  // 降级候选名单。判据仍是机械信号 + 交给 AI 定夺 —— 不自动淘汰, 因为对 pinned 而言
  // "冷"是反信号: 红线遵守得越好越不会被查到, 自动淘汰会精确地先删掉最有效的那几条。
  /* 6.7 淘汰四问。四问里前两问客观可判, 引擎替 AI 把它们答掉, 剩下两问("违反会出事故吗 /
     能并进别的吗")是价值判断, 只能它自己答 —— 所以这里出的是【带理由的候选】不是判决。
     第二问在 v2 才第一次答得出来: v1 没有红线表, "已被代码强制了吗"只能靠回忆; v2 的红线
     走 PreToolUse 硬过滤, 一条规矩既然已经被代码挡住, 就不必再占快查名额让人记着。 */
  pinnedAudit() {
    const all = this.pinnedAll();
    const today = todayLocal();
    const reasons = new Map();
    const mark = (m, why) => {
      const k = m.slug || m.id;
      if (!reasons.has(k)) reasons.set(k, []);
      reasons.get(k).push(why);
    };
    for (const m of all) {
      const full = this.store.node(m.id) || {};
      if (PINNED_STALE_HINT.test(m.slug || '')) mark(m, 'name points to a retired version/item');
      if ((full.status || 'active') !== 'active') mark(m, `status is already ${full.status}`);
      if (full.review_due && full.review_due <= today) mark(m, `review overdue: ${full.review_due}`);
      try { if (this.store.redline(m.id)) mark(m, 'already in redline table (code-enforced, no need to ride along every session)'); } catch (_) {}
    }
    return {
      quota: PINNED_QUOTA, used: all.length, over: Math.max(0, all.length - PINNED_QUOTA),
      candidates: [...reasons.keys()],
      candidate_reasons: [...reasons].map(([slug, why]) => ({ slug, why })),
    };
  }

  _pinnedFullMessage(ref) {
    const audit = this.pinnedAudit();
    // 用 slug 回话。调用方常常传的是数字 id, 报错里回一个数字等于让它再查一次自己刚写的是哪条。
    const self = this.store.node(this.resolve(ref));
    const refName = (self && self.slug) || ref;
    const why = new Map(audit.candidate_reasons.map((c) => [c.slug, c.why]));
    const list = this.pinnedAll()
      .map((m) => {
        const k = m.slug || m.id;
        const hint = why.has(k) ? `  ← 可降: ${why.get(k).join(' · ')}` : '';
        return `- ${k} — ${m.claim || m.title || ''}${hint}`;
      })
      .join('\n');
    if (hostCfg()) {
      try {
        return hostCfg().render('main/pinned_retire_four_questions', {
          used: audit.used, quota: audit.quota, ref: refName, list,
        });
      } catch (e) { console.error('[pinned] four-question copy failed, falling back:', e && e.message); }
    }
    // 兜底也得把清单给出去 —— 清单本身就是最有用的那部分, 光说"满了"等于什么都没说。
    return `Pinned set full ${audit.used}/${audit.quota} — it rides along with every session, so to add one, pass demote to take one out.\nCurrent:\n${list}`;
  }

  // 单条字数的盖: 常驻每个会话都整条带着, 超了让写的人当场改短。
  // 出厂条目改不了命题, 「改短再钉」走不通 —— 另附一段: 短版存成自己的一条再钉(main/pinned_too_long_factory.md)
  pinnedTooLong(claim, factorySlug = '') {
    const len = [...String(claim || '')].length;
    if (len <= PINNED_MAX_CHARS) return '';
    const vars = { max: PINNED_MAX_CHARS, len, slug: factorySlug };
    try {
      if (hostCfg()) {
        const base = hostCfg().render('main/pinned_too_long', vars);
        return factorySlug ? `${base}\n${hostCfg().render('main/pinned_too_long_factory', vars)}` : base;
      }
    }
    catch (e) { console.error('[pinned] too-long copy failed, falling back:', e && e.message); }
    return `Not pinned: a pinned claim rides along with every session, so it is at most ${vars.max} characters (this one is ${vars.len}). Rewrite the claim shorter, then pin again.`;
  }

  setPinned(ref, reason = '', { demote } = {}) {
    const id = this.resolve(ref);
    if (!id) throw new Error(`node not found: ${ref}`);
    if (!this.store.isPinned(id)) {
      const n = this.store.node(id) || {};
      const tooLong = this.pinnedTooLong(n.claim, n.is_factory ? (n.slug || String(ref)) : '');
      if (tooLong) throw new Error(tooLong);
    }
    if (!this.store.isPinned(id) && this.store.pinnedCount() >= PINNED_QUOTA) {
      // 6.7: 光说"满了"等于把活推回去让它凭印象挑。把清单 + 四问 + 引擎已答出的客观理由
      // 一起交出去, 才是"引擎强制提问 + AI 按客观判据答"。
      if (!demote) throw new Error(this._pinnedFullMessage(ref));
      const dId = this.resolve(demote);
      if (!dId) throw new Error(`demote node not found: ${demote}`);
      this.store.unpin(dId);
    }
    this.store.setPinned(id, reason);
    return { id, pinned: true, used: this.store.pinnedCount(), quota: PINNED_QUOTA };
  }

  unpin(ref) { const id = this.resolve(ref); if (id) this.store.unpin(id); return { id, pinned: false }; }

  // 触发模式【写错】要拒收(写错的人以为自己写对了, 于是不再留神);
  // 【没写】照收 —— 那是一条只标了严重性、程序不拦的红线, 但要如实回报 enforced=false。
  setRedline(ref, opts) {
    const id = this.resolve(ref);
    if (!id) throw new Error(`node not found: ${ref}`);
    const v = validateTrigger((opts || {}).trigger_pattern);
    if (!v.ok) throw new Error(`redline trigger_pattern invalid: ${v.reason}`);
    this.store.setRedline(id, opts);
    return { id, redline: true, enforced: v.enforced, note: v.reason || '' };
  }
  redlines() { return this.store.allRedlines(); }

  // 守卫记账两件套。守卫是软判断调的(typeof === 'function'), 不转出去就会静默丢账 ——
  // 那正是"报告成功其实没写"的经典形状, 所以宁可薄成一行也要显式转出来。
  noteViolation(ref) { const id = this.resolve(ref); if (id) this.store.bumpViolation(id); return { id }; }
  logError({ node_id = null, raw = '', at = null } = {}) {
    const id = node_id ? this.resolve(node_id) : null;
    return this.store.logError({ node_id: id, raw, at });
  }
  errorLog(limit = 50) { return this.store.errorLog(limit); }

  // —— 原话流水(底片) + 召回日志(尺子) ——
  // 两者都【只写不读进上下文】: 底片是给事后回溯用的, 尺子是给度量用的, 塞进每轮对话没有意义。
  addUtterance(u) { return this.store.addUtterance(u); }
  utterances(opts) { return this.store.utterances(opts); }
  utteranceCount() { return this.store.utteranceCount(); }
  recallStats(opts) { return this.store.recallStats(opts); }
  recallLog(limit = 50) { return this.store.recallLog(limit); }

}

module.exports = PinnedMixin;
