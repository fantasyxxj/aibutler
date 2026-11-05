// v1 检索: 邻接扩散 · 扁平打分 · query 主流程 · 正文兜底
// 由 memory.js 拆出(内核抽包第 2 步)。方法体逐字搬运, 经 mixin 挂回 MemoryGraph.prototype。
const {
  hotness, tokenize, rrfOrder, semanticWeight, hubDamp, loadAliases, SUPERSEDED_PENALTY, HOP_DECAY,
} = require('./primitives');

class V1RetrievalMixin {
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
    // 每个查询词展开成同义词组; 一组只计一次分 —— 否则一个词有 5 个同义词就凭空多拿 5 倍权重。
    // 无别名时 group = {自己}, 行为与改动前完全一致(向后兼容的关键)。
    const aliases = loadAliases();
    const nodes = Object.values(idx.nodes);
    // 切出来的 gram 按稀有度定价: 「记忆」「门禁」这种满图都是的片段, 命中了也说明不了什么;
    // 「量化」「倒排」只出现在少数几条里, 命中一次就基本锁定答案。不这么做, 一句中文切出十几个
    // gram, 分数就被那几个到处都有的片段主导。
    // 🔴 2026-08-13 改: 从"只作用于 derived"改成【所有查询词都参与】。
    // 原设计"人自己打的词维持原权重"是 2026-08-09 在【中文】库上定的, 前提是"人打的是关键词"(空格分隔的
    // 少数几个实词)。这个前提在英语上整个不成立 —— 英语问句天生是整句自然语言, 虚词占七成, 而英文词不切
    // gram 全是 derived=false, 于是 "the/what/you" 和 "pdf/port" 拿到完全一样的权重, 信号被虚词淹死。
    // 实测(164 节点英语库): 目标节点并非搜不到, 而是排在 18/23/52/68/82/98 位 —— 7 条"只有语义捞得回来"
    // 的记忆里 6 条是这么被埋掉的, 真·零命中只有 1 条。改成全员 IDF 后纯关键词 62.5%→83.3%(top3 11→17)。
    // 中文侧零倒退且 top1 17→18: IDF 是从本库统计的, 人打的实词本来就稀有, 降权几乎不动它们。
    // 所以这不是"给英语开的特例", 是把一条误当成通则的中文经验收回到它真正的适用范围。
    const N = nodes.length || 1;
    const idfCache = new Map();
    const idfOf = (t) => {
      if (idfCache.has(t)) return idfCache.get(t);
      // 🔴 N≤1 直接给满权重: 分母 log(N) 在 N=1 时为 0, 除出来是 NaN, 而 NaN 会一路污染到
      // rel(NaN>0 恒 false) —— 后果是【整张图一条都命中不了】, 且不报错。
      // 刚出生的人格、或只剩一条记忆的图正好落在这个洞里。2026-08-13 被单节点用例照出来,
      // 行业版那份同源代码有同样的洞。
      if (N <= 1) { idfCache.set(t, 1); return 1; }
      let df = 0;
      for (const m of nodes) {
        if ((m.id + ' ' + (m.title || '') + ' ' + (m.description || '')).toLowerCase().includes(t)) df++;
      }
      // 下限 0.15 而不是 0: 高频不等于无关, 只是不该单凭它上位。
      const w = df ? Math.max(0.15, Math.min(1, Math.log(N / df) / Math.log(N))) : 1;
      idfCache.set(t, w);
      return w;
    };
    const groups = terms.map((x) => {
      const t = typeof x === 'string' ? x : x.t;          // 老调用方传字符串数组也照吃
      const derived = typeof x === 'string' ? false : x.derived;
      return { term: t, syn: aliases.get(t) || new Set(), w: idfOf(t) };
    });
    // 兜底层命中: 同义词命中。body 命中同属兜底但已挪到 query() 的补位阶段 ——
    // 正文不再常驻内存(见 memory-store.allNodes 的尺度说明), 而兜底本来就只在结果不足时才起作用,
    // 没有理由让热路径为它付全量正文的代价。
    const fuzzyHit = (g, hay, dhay) => {
      for (const w of g.syn) if (w !== g.term && (hay.includes(w) || dhay.includes(w))) return true;
      return false;
    };
    for (const m of nodes) {
      const hay = (m.id + ' ' + (m.title || '')).toLowerCase();
      const dhay = (m.description || '').toLowerCase();
      // 精确层: 只认原词, 打分与改动前逐分相同 → 已经能搜到的东西, 相对次序纹丝不动。
      let rel = 0;
      for (const g of groups) { if (hay.includes(g.term)) rel += 3 * g.w; }
      for (const g of groups) { if (dhay.includes(g.term)) rel += 1 * g.w; }
      // 兜底层: 别名命中 + body 命中合起来只加一次 0.5, 总量封顶。
      // 🔴 2026-08-09 实测教训 —— 最初让别名命中拿满分(与原词等价)、body 按组累加, 结果 571 节点
      // 真实库上旧 top8 有 43.8% 被换掉, "门禁 测试"把门禁基线 SOP 挤出去换进来一个日语 app 节点。
      // 根因: 扩大候选池的手段一旦参与主排序, 就会稀释精确匹配的优势。
      // 定位清楚就简单了 —— 别名和 body 都是【召回兜底】, 职责是"让搜不到的搜得到", 不是"改排名"。
      // 封顶 0.5 < 1(单个 description 命中分), 保证纯兜底命中的节点排在任何精确命中者之后。
      // 🔴 兜底分只给【纯兜底命中者】。给精确命中者也加, 等于"正文里恰好也提了一嘴"就多拿 1.5 分
      // (combined = rel*3), 精确命中之间的次序就被搅乱了 —— 2026-08-09 实测正是这一条让 "asar 打包"
      // 把 pinned 红线 feedback_asar_hides_files_from_ai_read_tool 挤出了 top8。
      // 这样处理后, 精确命中者的 rel 与改动前**逐分相同**, 排序数学上不可能变。
      const exact = rel > 0;
      if (!exact && groups.some((g) => fuzzyHit(g, hay, dhay))) rel += 0.5;
      if (terms.length && rel === 0) continue;
      const h = hotness(m.importance, m.last_used, m.use_count);
      // 检索排序里 relevance 必须压过 importance: 查的是"跟这事有关的", 不是"最重要的"。
      // hotness 降权成同分时的次序调节量, 否则蹭到一个词的 pinned 会压过标题全中的 high。
      let combined = rel * 3 + h * 0.6;
      // 降权而非过滤: 老结论仍要能被召回(追问"当时为什么那么定"), 只是不该压过现结论。
      // 放在这里而不是 query 出口, 是为了让扩散种子能量一并降下去。
      if (m.status === 'superseded') combined *= SUPERSEDED_PENALTY;
      out.set(m.id, { combined, hot: h, rel, exact });
    }
    return out;
  }

  // 图扩散检索: 扁平命中做种子 → 沿边逐跳扩散(枢纽抑制), 捞回名字不含关键词但被链上的关联记忆
  query(q, { k = 8, hops = 2, flat = false, semantic = true } = {}) {
    const idx = this._fresh();
    const terms = tokenize(q);
    const all = this._flatScores(idx, terms);
    // 🔴 这里【不能】在 all 为空时提前返回。旧实现可以, 是因为正文命中会在 _flatScores 里
    // 记上 0.5 分让 all 非空; 正文移出热路径后, "只有正文里写了"的节点在这一步是零命中,
    // 提前返回就把兜底层和语义层一起跳过了 —— 改完当场被 body 兜底用例照出来。
    // 所以让流程照常走到下面的补位段, 由它决定还有没有东西可捞。
    // 精确命中与兜底命中彻底分层: 兜底(别名/正文)是【结果不足时的补位】, 不是排序竞争者。
    // 这样精确命中之间的相对次序与改动前逐分相同 —— "召回变强"不以"排序变乱"为代价。
    const flatM = new Map([...all].filter(([, v]) => v.exact));
    const fuzzyM = new Map([...all].filter(([, v]) => !v.exact));
    const act = new Map(), via = new Map();
    const semScore = new Map();   // 语义命中的真实相似度(排序用压制值, 展示用原值)
    for (const [id, v] of flatM) { act.set(id, v.combined); via.set(id, '直接'); }
    if (!flat) {
      const { adj, deg } = this._adjacency(idx);
      // 🔴 只有【精确命中】才配当扩散种子(rel≥1 = 至少一次 title/description 原词命中)。
      // 2026-08-09 实测: 兜底命中(别名/body)一并当种子时, "检索 召回"的种子池从 4 个暴增到 144 个,
      // 扩散能量泛滥, 旧 top8 有 43.8% 被冲掉 —— 而同一份代码在 flat 模式下只差 6.7%。
      // 弱信号可以进结果, 但不能当传播源: 一个"正文顺嘴提过"的节点没资格把能量灌给它的所有邻居。
      // rel≥1 这个门槛恰好等价于改动前的种子集(旧版最小命中增量就是 description 的 +1)。
      let frontier = new Map([...flatM].filter(([, v]) => v.rel >= 1).map(([id, v]) => [id, v.combined]));
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
    // 关键词全序。故意【不】截断到 k —— 融合层按排名算 RRF, 需要 top-k 之外的位次:
    // 英语实测里有一条关键词排 #8、语义排 #1 的记忆, 只看 top-8 就永远看不见它。
    let kwRanked = [...act.entries()].sort((a, b) => b[1] - a[1]);
    // 补位: 精确命中凑不满 k 条时, 才让别名/正文命中的顶上来。
    // 这就是"别名表"和"body 纳入检索"的真正价值场景 —— 换了说法、或内容只写在正文里,
    // 精确匹配一条都搜不到的时候。平时它们安静待着, 不干扰排序。
    // 🔴 这里【不能】写成"语义有货也补"。2026-08-13 落地锁头+RRF 时我写过那一版, 理由是
    // "RRF 的候选池要给完整序列"; 一天后测出来那是错的, 而且代价惊人:
    //   ① 代价: 语义默认开之后 semHits 恒非空 → 全表 LIKE 变成每查必跑, 实测 +26ms,
    //      比语义本身(编码 21.5ms + 全库余弦 0.7ms)还贵。防"LIKE 进热路径"的条件, 被我自己翻默认那步废掉了。
    //   ② 无用: 兜底命中一次捞回几百条(实测 285/352/489), concat 在关键词序列末尾, RRF 权重
    //      1/(10+300)≈0.003, 而语义头部是 1/(10+1)≈0.09 —— 差 30 倍, 数学上进不了 top-k。
    //      只在一路出现的条目本来就能从 semIds 那一路进 RRF, 不靠这份残缺的关键词排名。
    // 所以维持原判: 兜底层只做【关键词凑不满 k 条时的补位】, 不为融合而跑。
    const semHits = semantic ? this._semanticRanking() : [];
    if (kwRanked.length < k) {
      // 正文命中在这一刻才去库里查 —— 全表 LIKE 只发生在"精确命中凑不满"或"要算融合"时。
      // 与旧实现逐分等价: 正文命中同样记 rel=0.5, 与别名命中并列排序后一起补位。
      const pool = new Map(fuzzyM);
      for (const id of this._bodyHitIds(idx, terms)) {
        if (act.has(id) || pool.has(id)) continue;
        const m = idx.nodes[id];
        if (!m) continue;
        const h = hotness(m.importance, m.last_used, m.use_count);
        let combined = 0.5 * 3 + h * 0.6;
        if (m.status === 'superseded') combined *= SUPERSEDED_PENALTY;
        pool.set(id, { combined, hot: h, rel: 0.5, exact: false, body: true });
      }
      const extra = [...pool.entries()]
        .filter(([id]) => !act.has(id))
        .sort((a, b) => b[1].combined - a[1].combined);
      for (const [id, v] of extra) via.set(id, v.body ? '兜底·正文' : '兜底·别名');
      kwRanked = kwRanked.concat(extra.map(([id, v]) => [id, v.combined]));
    }
    let ranked = kwRanked.slice(0, k);
    // 语义层: 置信度加权 RRF(不锁头)。
    // 🔴 前三版都错在【形状】上, 不是错在参数:
    //   v1 "关键词凑不满 k 条才补语义" = 死代码(CJK 2-gram 上线后碎片几乎总能凑满, 语义永远轮不到)。
    //   v2 "给语义留 2 个末席 + 显著性门槛" = 占坑式, 它砍掉关键词最弱一席塞语义, 完全不看两路的一致性。
    //      英语实测抓到它独有的病: 一条关键词排 #8、语义排 #1 的记忆, 放宽门槛后反而被挤出 top-8。
    //   v3 "锁死关键词前 3 席" = 中文确实零退步, 但它把英语的收益一起锁没了 —— 英语 top3/top1
    //      与纯关键词【逐条相同】(17/13), 语义捞回的两条全落在第 4-8 席。当初判它"英语收益一条
    //      不少"是因为只看了「答案有没有进 top-8」这个钝指标, 它看不见排序退化。
    // v4 = 把硬锁换成软权重: 语义的话语权随关键词自身的把握连续变化(semanticWeight)。
    // 硬锁本来就是"信不信关键词"的粗糙代餐, 而分数形状能直接把这件事测出来。
    // 实测(2026-08-13, IDF 修完后的基线, 各 24 问句):
    //   中文 750 真库  top3 22→22 · top1 18→18 · 答案零挤出 · 名次净变 +1(实质中性)
    //   英语 164 节点  top3 17→21 · top1 13→17 · 答案零挤出零压低 · 名次净变 +13
    // 所以不按语言分岔 —— 判据是"关键词这次有多大把握", 不是"这是什么语言"。
    if (semHits.length) {
      const semById = new Map();
      const semIds = [];
      for (const h of semHits) {
        if (!idx.nodes[h.id]) continue;   // 向量还在但节点已删 —— 不能召回一条不存在的记忆
        semById.set(h.id, h);
        semIds.push(h.id);
      }
      const kwIds = kwRanked.map(([id]) => id);
      const kwScore = new Map(kwRanked);
      ranked = rrfOrder(kwIds, semIds, k, semanticWeight(kwRanked)).map((id) => {
        if (kwScore.has(id)) return [id, kwScore.get(id)];
        // 纯语义命中: 展示分用真实相似度, 与关键词的分数不是一个量纲, via 标出来以示区分。
        const h = semById.get(id);
        semScore.set(id, h.score);
        via.set(id, `语义·${h.score.toFixed(3)}`);
        return [id, h.score];
      });
    }
    return ranked.map(([id, score]) => {
      const m = idx.nodes[id] || {};
      const shown = semScore.has(id) ? Math.round(semScore.get(id) * 1000) / 1000 : Math.round(score * 10) / 10;
      return { id, score: shown, via: via.get(id) || '图',
               description: m.description || '', file_path: m.file_path || '',
               importance: m.importance, last_used: m.last_used, hot: hotness(m.importance, m.last_used, m.use_count),
               status: m.status || 'active', superseded_by: m.superseded_by || '' };
    });
  }

  // 正文兜底命中。放在库里做匹配而不是把正文搬进 JS —— 见 memory-store.allNodes 的尺度说明。
  // 只取原词不取 2-gram 碎片: 碎片在正文这种长文本里几乎必然命中, 会把兜底层变成"全库都算命中"。
  _bodyHitIds(idx, terms) {
    const out = new Set();
    const aliases = loadAliases();
    for (const x of terms) {
      const t = typeof x === 'string' ? x : x.t;
      const derived = typeof x === 'string' ? false : x.derived;
      if (derived) continue;
      for (const id of this.store.bodyMatches(t)) out.add(id);
      for (const w of (aliases.get(t) || new Set())) {
        if (w !== t) for (const id of this.store.bodyMatches(w)) out.add(id);
      }
    }
    return out;
  }

}

module.exports = V1RetrievalMixin;
