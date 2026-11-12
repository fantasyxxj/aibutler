// 体检与冲突仲裁: 候选对 · 裁决 · 僵尸 · doctor 报告
// 由 memory-v2.js 拆出(内核抽包第 2 步)。方法体逐字搬运, 经 mixin 挂回 MemoryGraphV2.prototype。
const { todayLocal, nowLocalISO, PINNED_QUOTA, PINNED_MAX_CHARS } = require('../memory');
const arb = require('../memory-arbitration');
const { bodyHardTokens, bodySize, estTokens } = require('./consts');
const { tune } = require('./tuning');

// 同一个日期式子写两遍是有意的: 带 /g 的 .test() 会记住 lastIndex, 拿同一个对象既 match 又 test
// 会隔次漏判。式子只认 ISO 全日期 —— 宁可漏("8-11 那轮")也不误伤版本号、端口、金额。
const DATE_RE = /20\d\d-\d\d-\d\d/g;
const DATE_ONE_RE = /20\d\d-\d\d-\d\d/;
const CHRONICLE_MIN_DATES = 3;

class DoctorMixin {
  _audit() { try { return JSON.parse(this.store.getMeta('conflict_audit') || '{}'); } catch (_) { return {}; } }
  _saveAudit(a) { this.store.setMeta('conflict_audit', JSON.stringify(a)); }

  conflictCandidates(opts = {}) {
    const idx = this._fresh();
    return this._withSlugs(idx, arb.conflictCandidates(
      this._asLegacyNodes(idx), idx.edges.map((e) => [e.src, e.dst]), { ...opts, audit: this._audit() }));
  }

  // 全库普扫走这条: 分片让出事件循环, 界面全程可用。同步版只留给给了 seeds 的检索路径。
  // 库里有向量就加语义那一路(见 scanPairs 的 vecOf), 没有就逐位退回纯词面。
  async conflictCandidatesChunked(opts = {}) {
    const idx = this._fresh();
    let vecOf = null;
    try {
      const vecs = this._allVectors ? this._allVectors() : [];
      if (vecs.length) { const m = new Map(vecs.map((v) => [v.id, v.vec])); vecOf = (id) => m.get(id); }
    } catch (_) { vecOf = null; }
    return this._withSlugs(idx, await arb.conflictCandidatesChunked(
      this._asLegacyNodes(idx), idx.edges.map((e) => [e.src, e.dst]), {
        ...opts, audit: this._audit(), vecOf,
        cosIn: tune('conflict_cos_in'), cosLinkOk: tune('conflict_cos_link_ok'), cosWeight: tune('conflict_cos_weight'),
      }));
  }

  // 数字 id 对人不可读, 把 slug 和命题补回去 —— 否则端上来的候选名单我看不懂是哪两条在打架
  _withSlugs(idx, out) {
    const withSlug = (id) => { const m = idx.nodes[id]; return m ? { id, slug: m.slug, claim: m.claim } : { id }; };
    return (out.pairs || out || []).map((p) => ({ ...p, a: withSlug(p.a), b: withSlug(p.b) }));
  }

  // 名字跟 v1 保持一致(conflictSettle 而不是 settleConflict) —— 宿主按名字调,
  // 顺手"改得更顺口"就等于制造一个只在运行时才炸的洞。
  conflictSettle({ a, b, verdict, note = '' }) {
    // 🔴 verdict 必须落在冷却表里那几个值。冷却天数是 `memory-arbitration` 的 COOLDOWN_DAYS
    //    按 verdict 查出来的, 表里没有的值会静默落到 180 天默认 —— 于是账本堆野值、语义漂,
    //    而且没有任何地方会报。2026-09-26 实地: 工具说明当时教的是 `false_conflict`(不在表里),
    //    助手照着填了 4 笔, v1 那侧的 settleConflict 对同样的值是直接抛错的。
    //    报错句子用英文: 它直接回给模型看。
    if (!arb.VERDICTS.includes(verdict)) {
      throw new Error(`verdict must be one of ${arb.VERDICTS.join(' | ')}, got: ${verdict}`);
    }
    const ia = this.resolve(a), ib = this.resolve(b);
    const audit = this._audit();
    audit.settled = audit.settled || [];
    audit.settled.push({ a: ia, b: ib, verdict, note, at: nowLocalISO() });
    this._saveAudit(audit);
    return { a: ia, b: ib, verdict };
  }

  // 撤销推翻: 删边 + 状态复原。v1 的 undoArbitrate 要去 .md 里把 frontmatter 改回来。
  unsupersede({ winner, loser }) {
    const w = this.resolve(winner), l = this.resolve(loser);
    if (!w || !l) throw new Error('端点不存在');
    this.store.removeEdge(w, l, 'supersedes');
    if (!this.store.supersededBy(l).length) this.store.upsertNode({ id: l, status: 'active' }, { op: 'arbitrate' });
    return { winner: w, loser: l, restored: true };
  }

  // zombies 不吃 links, 所以安全地喂 slug 当 id —— 老算法要靠 project_ 前缀判类型。
  zombies() {
    const idx = this._fresh();
    return arb.zombies(this._asLegacyNodes(idx, { idAsSlug: true }), todayLocal())
      .map((z) => ({ ...z, slug: z.id, id: this.store.idOf(z.id) }));
  }

  // —— 体检 ——
  // v1 的 canon(title)===id 校验整条删除: 数字主键之后 title 与 id 天然不等, 留着 888 条全报错。
  // opts.raw = true 时不滤掉已 ack 的那几类 —— ackProblem 要靠它读到真实数量, 否则第二次
  // ack 拿到的是 0(那一类已经被自己滤没了), 于是"涨了要重报"这条规则永远失效。
  doctor(opts = {}) {
    const idx = this._fresh();
    const nodes = Object.values(idx.nodes);
    const ids = new Set(nodes.map((n) => n.id));
    const problems = [];
    // 悬空边在 v2 由外键从源头挡住, 这里仍查一次: 外键是连接级开关, 万一没开就会静默失效。
    const dangling = idx.edges.filter((e) => !ids.has(e.src) || !ids.has(e.dst));
    if (dangling.length) problems.push({ kind: 'dangling edges', count: dangling.length, hint: 'Foreign key not in effect — verify the storage layer has explicit PRAGMA foreign_keys=ON.' });
    // 真空命题: 建节点时 claim 必填, 所以正常恒为 0。真出现了是写路径破了, 与下面那批性质完全不同。
    const emptyClaim = nodes.filter((n) => !n.claim || !n.claim.trim());
    if (emptyClaim.length) {
      problems.push({ kind: 'missing claim', count: emptyClaim.length,
        sample: emptyClaim.slice(0, 5).map((n) => n.slug),
        hint: 'Empty claim is a bug in the write path (upsert requires claim), not a backlog item — find out what wrote these.' });
    }
    // 兜底命题: 机械迁移拿旧摘要垫的, 非空且看着完全正常, 光读内容分不出来。
    // review_queue 退役后, 那张表里唯一重算不出来的信息就靠 claim_provisional 这个位留住。
    //
    // 🔴 必须与真空分开报, 且必须给补法 + 只摆一小批。
    // 2026-08-19 棒头迁完 169 条被一次性摆出来, 原样回的是「补法不明, 跳过, 下次体检再摆」——
    // 100% 的语料 + 一条补法都没写 = 必然永远跳过, 而且下次还是 169, 这条轨道等于空转。
    // 按热度排: 冷门节点的命题差不影响任何检索, 值得改的永远是正在被查的那些。
    //
    // 🔴 =1 和 =2 分开催, 因为它们烂的方式相反, 催法也就相反:
    //   =2 讨论中的临时命题, 生命周期本来只有几小时。它不按热度烂, 按【放了多久】烂 ——
    //      一条三天前标"临时"还没落定的, 早就没人记得当时在讨论什么了。所以按最久未动排。
    //   =1 迁移欠账是长期的, 冷门那些的烂命题不影响任何检索, 按热度排慢慢还。
    // 合成一条报的话, 974 条 =1 会把少数几条 =2 冲得永远露不出来。
    const PROVISIONAL_BATCH = tune('provisional_batch');
    const hasClaim = (n) => n.claim && n.claim.trim();
    const temp = nodes.filter((n) => hasClaim(n) && Number(n.claim_provisional) === 2)
      .sort((a, b) => String(a.last_used || '').localeCompare(String(b.last_used || '')));
    if (temp.length) {
      problems.push({ kind: 'provisional claim not settled', count: temp.length,
        sample: temp.slice(0, PROVISIONAL_BATCH).map((n) => `${n.slug}(${n.last_used || '?'})`),
        hint: 'Claims you marked "under discussion" — should have been settled within hours. The ones above have gone the longest without a change. Do you still remember what was being debated?'
          + ' Settle: memory_upsert(id="<slug>", claim="claim: ...", provisional=0).'
          + ' If the discussion was abandoned, retire it with status="superseded" — do not let an unresolved claim keep polluting search results.' });
    }
    const provisional = nodes.filter((n) => hasClaim(n) && Number(n.claim_provisional) === 1)
      .sort((a, b) => this._hot(b) - this._hot(a));
    if (provisional.length) {
      problems.push({ kind: 'claim pending true/false judgement', count: provisional.length,
        sample: provisional.slice(0, PROVISIONAL_BATCH).map((n) => n.slug),
        hint: 'These were machine-padded with old summaries during migration — not bad debt, no need to clear all at once. Start with the most-used ones above.'
          + ' For each: read the body, rewrite the summary as a falsifiable claim, then memory_upsert(id="<slug>", claim="claim: ...").'
          + ' 🔴 Do NOT pass body — omitting it leaves every character of the body untouched; once the claim is updated the placeholder flag clears automatically, no separate done marker needed.'
          + ' 🔴 These items do **not** appear with markers in search results (tagging 974 items is the same as tagging none) — this checkup is the only entry point.'
          + ' Cold nodes left untouched do not affect search.' });
    }
    const noType = nodes.filter((n) => !n.type || !String(n.type).trim());
    if (noType.length) problems.push({ kind: 'missing type', count: noType.length, sample: noType.slice(0, 5).map((n) => n.slug) });
    const isolated = nodes.filter((n) => !idx.edges.some((e) => e.src === n.id || e.dst === n.id));
    const dueSoon = nodes.filter((n) => n.review_due && n.review_due <= todayLocal() && (n.status || 'active') === 'active');
    const pinnedOver = Math.max(0, idx.pinned.size - PINNED_QUOTA);
    if (pinnedOver) problems.push({ kind: 'pinned set over quota', count: pinnedOver });
    // 体积体检: 写入闸只管新写的, 存量得靠这里发现。报的是【拆分候选】不是错误 ——
    // 大不等于错, 只等于"点大了边的语义稀薄, 检索也只能整条给你"。
    const fat = [];
    const chronicle = [];
    for (const n of nodes) {
      const b = this.store.bodiesOf([n.id]).get(n.id) || '';
      const sz = bodySize(b);
      // 体检线 = 写入硬闸本身。两条线差一个量级的老做法已废: 那是"存量不合规不该由写入闸背锅"
      // 的年代留下的, 而现在的方针是【碰到哪条就把哪条改到线内】, 所以体检报的就该是欠账全集。
      // 已取代的不算拆分候选: split 把原条标 superseded 且留正文作史, 再报它就永远消不掉(10-14 核对)
      if (sz.tokens > bodyHardTokens() && n.status !== 'superseded') {
        fat.push({ slug: n.slug, lines: sz.lines, tokens: sz.tokens });
      }
      // 同一趟扫完: 正文只读得起一遍, 体积和日期密度分两个循环就是白读一次全库正文。
      const dates = b.match(DATE_RE);
      if (dates && dates.length >= CHRONICLE_MIN_DATES) {
        chronicle.push({ slug: n.slug, dates: dates.length, lines: sz.lines, node: n });
      }
    }
    fat.sort((a, b) => b.tokens - a.tokens);
    if (fat.length) {
      problems.push({ kind: 'body over gate (legacy backlog)', count: fat.length,
        sample: fat.slice(0, 5).map((f) => `${f.slug}(${f.tokens} tokens)`),
        hint: `Limit is ${bodyHardTokens()} tokens. Trim each node you touch — first delete the "how it was proven true" part (reasoning chain / comparisons / trade-offs); that is the main source of body bloat. Still over after that? Split into atomic nodes + [[edges]].` });
    }
    // 编年史体检: 体积只答"大不大", 答不了"哪些字是废的"。日期密度是【正文在记流水账】的
    // 机械信号 —— 实测圈出 365 条, 与"正文 ≥3k"的 188 条重合 81%: 长正文和正文写成编年史
    // 根本是同一批节点, 不是两个毛病。
    //
    // 🔴 机器只圈范围, 判据仍归人: **这句话现在还指导行动吗** —— 指导就留(哪怕讲的是三个月前的
    // 事故), 只是记录发生过才删。拿"有没有提到过去"当判据会把事故复盘一起误删。
    // 与"命题待判真假"同一套摆法: 按热度排 + 只摆 5 条 + 必须给补法, 理由见上面那段。
    const CHRONICLE_BATCH = tune('provisional_batch');
    chronicle.sort((a, b) => this._hot(b.node) - this._hot(a.node));
    if (chronicle.length) {
      problems.push({ kind: 'body looks like a chronicle', count: chronicle.length,
        sample: chronicle.slice(0, CHRONICLE_BATCH).map((c) => `${c.slug}(${c.dates} dates/${c.lines} lines)`),
        hint: `Body contains ${CHRONICLE_MIN_DATES}+ dates = recording a running log. Body should only contain how to use this claim:`
          + ' how to apply it / when it does not apply / which exact command to run for reproduction — the reasoning chain for how it was proven true does not belong here either.'
          + ' Delete narrative process, change history, superseded arguments, "tried A then B" — every body change is fully stored in history,'
          + ' memory_revisions can retrieve it, no need to fear deletion. How to fix: read with memory_section to get base_hash,'
          + ' rewrite, then memory_upsert with it. Cold nodes left untouched do not affect search.' });
    }
    // claim 超注入预算: 写入闸(write.js 的 checkClaimLimit)只管新写的, 存量得靠这里发现 ——
    // 与正文超闸同构, 但后果重一个量级: 正文大只是召回粒度粗, 命题超预算是【整条一个字都注入
    // 不进去】, 而 recall_log 照样记它命中, 光看日志看不出任何异常。
    // 🔴 必须与 checkClaimLimit 用同一把尺(含 `- #999 <slug> ` 前缀), 只量 claim 本身会漏掉
    //    slug 长的那批 —— 实测 2451 条: 只量 claim 是 21 条, 按真实注入成本是 31 条。
    const INJECT_BUDGET = tune('recall_inject_budget');
    const claimCost = (n) => estTokens(`- #999 ${n.slug || ''} ${n.claim || ''}`);
    const claimOver = nodes.filter((n) => hasClaim(n) && claimCost(n) > INJECT_BUDGET)
      .sort((a, b) => claimCost(b) - claimCost(a));
    if (claimOver.length) {
      problems.push({ kind: 'claim over injection budget', count: claimOver.length,
        sample: claimOver.slice(0, 5).map((n) => `${n.slug}(${claimCost(n)} tok)`),
        hint: `Limit is ${INJECT_BUDGET} tokens, counted over the whole recall line including the "- #999 <slug> " prefix — so a long slug eats the budget too.`
          + ' These claims are never injected at all: not truncated, dropped whole, while recall_log still records them as a hit.'
          + ' Fix: move full parameter tables, edge cases and rare branches into the body; keep in the claim one falsifiable assertion'
          + ' plus the smallest complete shape someone can act on. Then memory_upsert(id="<slug>", claim="…") — passing only claim leaves the body untouched.' });
    }
    // claim 带日期: 与上面同源但更要紧 —— 命题行是检索唯一露出来的东西, 正文脏只在展开时误导,
    // 命题脏是每一次搜索都在误导。实测 747 条(52%)。
    const claimDated = nodes.filter((n) => n.claim && DATE_ONE_RE.test(n.claim))
      .sort((a, b) => this._hot(b) - this._hot(a));
    if (claimDated.length) {
      problems.push({ kind: 'claim line contains a date', count: claimDated.length,
        sample: claimDated.slice(0, CHRONICLE_BATCH).map((n) => n.slug),
        hint: 'A falsifiable claim needs no date qualifier — unless the date is itself part of the claim ("after 8-11 the name banto is retired").'
          + ' e.g. "8-16 done: append replaced by section+write" → "Section-level writes use section to read hash + write to replace the whole section; optimistic lock prevents accidental overwrites".'
          + ' Fix: memory_upsert(id="<slug>", claim="...") — 🔴 do NOT pass body; omitting it leaves every character of the body untouched.' });
    }
    // 🔴 没向量要当面报: 模型是运行时从 huggingface 下的, 下不来就一个向量都没有, 检索退化成
    // 纯词面匹配 —— 中文短句一律够不上注入线, 表现是「AI 什么都想不起来」。而接线那两处从前是
    // 静默 catch, 这件事全程无声。这是整个记忆系统瘸了一半, 比下面的失败率更该先看见。
    try {
      const es = this.embedStats();
      if (es && es.total > 0 && es.pending > 0) {
        problems.push({ kind: 'semantic vectors missing', count: es.pending,
          hint: `${es.pending}/${es.total} nodes have no vector — semantic search is degraded to plain word matching, so short Chinese/Japanese queries score near zero. The model (${es.model || 'unknown'}) is downloaded at runtime from huggingface.co: check <dataDir>/models/, or set a network proxy and reopen.` });
      }
    } catch (_) { /* 取不到就不报 —— 附加检查不该让整个体检失败 */ }
    // 尺子进体检: 召回情况是整个记忆系统的成绩单。
    // 🔴 empty 和 unused 是两种病, 合成一个 failRate 会把健康的库报成濒死:
    //   empty  = 查了什么都没捞到 —— 这才是"找不到", 真信号。
    //   unused = 捞到了却没有一条被 touch/改写。`used` 要靠 AI 主动 memory_touch(或改写刚
    //            命中的节点)才置位, 而多数人格根本不常 touch —— 所以它量的是【记账勤不勤】,
    //            不是【检索准不准】。
    // 2026-09-12 一台客户机器实测: 旧口径报 failure rate over 50%(26/34), 而 zero hits 是 0、
    // 抽查两条全以「语义」命中(0.921/0.926)、memory_hot 正常 —— 系统完全健康。旧文案还配着
    // "fix search / fix claims" 的药方, 人格照做就会去改一堆本来没错的命题。
    const recall = this.recallStats();
    if (recall.total >= 20 && recall.empty / recall.total > 0.3) {
      problems.push({ kind: 'searches come back empty', count: recall.empty,
        hint: `${recall.empty}/${recall.total} manual searches found nothing`
          + (recall.emptyFiltered
            ? ` — ${recall.emptyFiltered} of them did match something that the score threshold then filtered out (loosen it), ${recall.emptyBare} matched nothing at all (add the content).`
            : ' — the content is missing, add it.') });
    }
    if (recall.total >= 20 && recall.unused / recall.total > 0.6) {
      problems.push({ kind: 'recalled but never credited', count: recall.unused,
        hint: `${recall.unused}/${recall.total} searches returned results that were never touched. This is a bookkeeping signal, NOT a retrieval fault — \`used\` is only set when you call memory_touch (or rewrite a node you just found). If those answers were actually useful, touch them: that score is how this library learns what matters. Do not rewrite claims over this number alone.` });
    }
    return {
      nodes: nodes.length, edges: idx.edges.length,
      pinned: idx.pinned.size, quota: PINNED_QUOTA,
      // 上限出来之前钉上的超长常驻: 还钉着就留着, 可一旦被撤下就按上限钉不回 —— 体检趁它还在让人格改短
      pinned_too_long: [...idx.pinned].filter((id) => [...String((this.store.node(id) || {}).claim || '')].length > PINNED_MAX_CHARS).length,
      // 半个 emoji(孤立代理项)会让 DeepSeek / 智谱拒收整个请求: 体检时查到就当场删, 报删了几处
      lone_surrogates_fixed: this.store.loneSurrogateScan({ fix: true }).fixed,
      isolated: isolated.length, review_due: dueSoon.map((n) => n.slug),
      recall, utterances: this.utteranceCount(),
      problems: opts.raw ? problems : this._dropAcked(problems),
    };
  }

  // 🔴 每条告警都得有「确认不修」的出口。像 body over gate 那种历史存量, 既不该一次全改
  // 也不该每次体检都被念一遍 —— 没有出口的话, 人格只能在"永远被念叨"和"去乱改一通"之间选,
  // 两个都不对, 而且念得越久越容易把整条轨道训成噪音(连真该修的那几条也一起跳过)。
  // 🔴 ack 记的是**当时那个数**, 不是永久免死: 数量涨了照样重新报, 因为涨出来的是新欠的账。
  _dropAcked(problems) {
    return (problems || []).filter((p) => {
      let ack = null;
      try { ack = JSON.parse(this.store.getMeta(`ack:${p.kind}`) || 'null'); } catch (_) { /* 坏值当没 ack */ }
      return !ack || (p.count || 0) > (ack.count || 0);
    });
  }

  // 确认某类告警"知道了, 暂时不修"。再报的条件是它变多了。
  ackProblem(kind, note = '') {
    const d = this.doctor({ raw: true });
    const cur = (d.problems || []).find((p) => p.kind === kind);
    const count = cur ? (cur.count || 0) : 0;
    this.store.setMeta(`ack:${kind}`, JSON.stringify({ count, note, at: new Date().toISOString() }));
    return { kind, acked_at_count: count, note };
  }

  stats() { return this.store.stats(); }
}

module.exports = DoctorMixin;
