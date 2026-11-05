// 检索: 邻接扩散 · 扁平打分 · 兜底命中 · query 主流程
// 由 memory-v2.js 拆出(内核抽包第 2 步)。方法体逐字搬运, 经 mixin 挂回 MemoryGraphV2.prototype。
const {
  tokenize, rrfOrder, semanticWeight, hubDamp, loadAliases, enStem, isEnWord, stemSet,
  SUPERSEDED_PENALTY, HOP_DECAY,
} = require('../memory');
const { tune } = require('./tuning');
const { IDF_FLOOR, estTokens, semConf, tierOf } = require('./consts');
const { variantsOf } = require('./lang');

class RetrievalMixin {
  // 扩散用的邻接表。所有 rel 都参与传播 —— rel 表达的是"什么关系", 不是"关系强弱";
  // 强弱是 weight 的事。唯一例外在 query 出口: supersedes 会额外触发告警。
  _adjacency(idx) {
    const nodes = new Set(Object.keys(idx.nodes).map(Number));
    const adj = new Map();
    for (const e of idx.edges) {
      if (!nodes.has(e.src) || !nodes.has(e.dst)) continue;
      // 只共用过一次的自动边不算数 —— 一次同框可能只是那天恰好都用上了。
      // 门槛卡在这里(而不是不建边), 是因为"共用过 1 次"本身是要攒的证据, 丢了就永远攒不到 2。
      if (e.rel === 'co_used' && (e.weight || 0) < tune('co_edge_min_weight')) continue;
      if (!adj.has(e.src)) adj.set(e.src, new Set()); adj.get(e.src).add(e.dst);
      if (!adj.has(e.dst)) adj.set(e.dst, new Set()); adj.get(e.dst).add(e.src);
    }
    const deg = new Map();
    for (const n of nodes) deg.set(n, adj.has(n) ? adj.get(n).size : 0);
    return { nodes, adj, deg };
  }

  // 与 v1 _flatScores 同构, 只换 haystack 的取材。分数公式、IDF 下限、兜底封顶 0.5、
  // superseded 降权全部原样保留 —— 这些都是实测调出来的, 不该在搬家时顺手改。
  _flatScores(idx, terms) {
    const out = new Map();
    const aliases = loadAliases();
    const nodes = Object.values(idx.nodes);
    const N = nodes.length || 1;
    // 🔴 一个节点可以挂 N 份译文, 每份【各自独立打一遍分, 取最高】—— 不是把各语言拼成一个大
    // haystack。拼起来的话, 一个中日混写的查询会在同一条上把两语的分加起来, 拿到任何单一语言
    // 都拿不到的虚高分; 而段覆盖那道"孤证不立"的闸也会被从不同语言各凑一个 gram 骗过去。
    // 取最高还有个副作用是好的: 无译文的节点变体只有一份, 走下来与改动前逐位相同。
    const varCache = new Map();
    const varsOf = (m) => {
      let v = varCache.get(m.id);
      if (!v) { v = variantsOf(m); varCache.set(m.id, v); }
      return v;
    };
    const hayOf = (m, v) => `${m.slug || ''} ${v.title || ''} ${v.keywords || ''}`.toLowerCase();
    const dhayOf = (v) => (v.claim || '').toLowerCase();
    // df 统计口径: 全语言并集。一个词只要在这条的【任一语言】里出现过就算这条有它 ——
    // 与命中判定(任一变体命中即算命中)是同一把尺, 下面那条注释讲的就是这件事。
    const textCache = new Map();
    const textOf = (m) => {
      let s = textCache.get(m.id);
      if (s === undefined) {
        s = varsOf(m).map((v) => `${v.title || ''} ${v.keywords || ''} ${v.claim || ''}`).join(' ');
        s = `${m.slug || ''} ${s}`.toLowerCase();
        textCache.set(m.id, s);
      }
      return s;
    };
    // 英文按词干集合命中, 中文按子串命中。词干集合按节点缓存, 且【只有查询里真有英文词时才建】,
    // 所以中文查询一次也不会走到这儿。缓存键带上变体下标 —— 少了它, 第一份译文的词干集合会被
    // 当成所有语言的, 于是英文查询只对第一份生效。
    const stemCache = new Map();
    const stemsOf = (m, field, vi) => {
      let byField = stemCache.get(m.id);
      if (!byField) { byField = {}; stemCache.set(m.id, byField); }
      const key = field === 'all' ? 'all' : `${field}:${vi}`;
      if (!byField[key]) {
        const v = field === 'all' ? null : varsOf(m)[vi];
        byField[key] = stemSet(field === 'hay' ? `${m.slug || ''} ${v.title || ''} ${v.keywords || ''}`
                              : field === 'dhay' ? (v.claim || '') : textOf(m));
      }
      return byField[key];
    };
    // 🔴 IDF 的 df 统计必须和命中判定用【同一把尺】。从前两边都是裸 includes, 于是 can 在全库
    // 处处"命中", df 虚高 → IDF 压到 0.15 地板 → disc 低 → 把握度低。只修命中不修 df, 英文
    // 把握度照样上不来 —— 这是 2026-08-17 查出来的真链条。
    // 连 df 一起缓存, 不只缓存权重: df=1 与 df=0 的 IDF 都恰好是 1(log(N/1)/log(N)=1),
    // 光看权重分不出"全库只有一条有"和"全库一条都没有", 而下面排伪 gram 要的正是后者。
    const idfCache = new Map();
    const idfOf = (t, en, stem) => {
      if (idfCache.has(t)) return idfCache.get(t);
      if (N <= 1) { const r = { w: 1, df: 1 }; idfCache.set(t, r); return r; }  // log(N) 在 N=1 时为 0, NaN 会让整张图零命中
      let df = 0;
      for (const m of nodes) if (en ? stemsOf(m, 'all').has(stem) : textOf(m).includes(t)) df++;
      const w = df ? Math.max(IDF_FLOOR, Math.min(1, Math.log(N / df) / Math.log(N))) : 1;
      const r = { w, df };
      idfCache.set(t, r);
      return r;
    };
    const groups = terms.map((x) => {
      const t = typeof x === 'string' ? x : x.t;
      const en = isEnWord(t);
      const stem = en ? enStem(t) : t;
      const { w, df } = idfOf(t, en, stem);
      // pseudo = 切词切出来的碎片, 而且全库一条都没有 → 它是切词的产物, 不是用户问的概念。
      return { term: t, en, stem, syn: aliases.get(t) || new Set(), w,
               pseudo: (typeof x === 'string' ? false : !!x.derived) && df === 0,
               seg: (typeof x === 'string' ? undefined : x.seg) };
    });
    // 把握度按【词段(概念)】算, 不按 gram 算。
    // 2026-08-16 实测: 按 gram 算时, 负例(库里根本没这个话题)的头名把握度中位 0.084、最高 0.166,
    // 高过正例 p10 的 0.033 —— 完全分不开。根因是负例常常靠【单个稀有 2-gram 碰巧命中】拿分,
    // 而 895 条的库里任何一个 2-gram 都可能碰上某条, 且碰上的往往稀有(IDF 高)。
    // 按词段算就问得对了: "你问的这几个概念, 这条讲到了几个" —— 碰上一个仍然只是 1/N。
    const segW = new Map();      // 词段 → 该段最有区分度的 IDF
    const segSize = new Map();   // 词段 → 这段切出了几个 gram
    for (const g of groups) {
      // 🔴 只排掉【切出来的】伪 gram, 不排用户真说出口的词。
      // 中文 2-gram 会切出大量跨词边界的碎片(「版本号」切出「本号」), 它们全库 df=0,
      // 那是切词的产物不是用户问的概念, 留在段长里会把命中比例的分母白白撑大 ——
      // 这正是当初否掉"按命中比例算"的那条理由, 排掉它比例法才站得住。
      // ⚠️ 反过来, 用户真说出口而全库答不上来的整词(df=0)**必须留在分母里**: 说了一堆
      // 库里没有的东西, 就不该判成"高度相关"。那是宁缺毋滥本身, 不是噪音。
      if (g.pseudo) continue;
      const s = g.seg === undefined ? g.term : g.seg;
      if (!segW.has(s) || g.w > segW.get(s)) segW.set(s, g.w);
      segSize.set(s, (segSize.get(s) || 0) + 1);
    }
    const segTotal = [...segW.values()].reduce((a, b) => a + b, 0);
    const maxRel = groups.reduce((s, g) => s + 3 * g.w, 0);
    const fuzzyHit = (g, hay, dhay) => {
      for (const w of g.syn) if (w !== g.term && (hay.includes(w) || dhay.includes(w))) return true;
      return false;
    };
    // 一份变体(某一语言)的打分。整块逐字沿用原来的单语版本 —— 变的只是取材来自哪一份文本,
    // 分数公式、3:1 的层权、兜底封顶 0.5、"孤证不立"的记法一个都没动。
    const scoreVariant = (m, v, vi) => {
      // 高价层放 slug+title+keywords: keywords 就是拿来补数字主键抹掉的那份 id 信号的,
      // 所以它必须和 slug/title 同档(3 分), 放进低价层等于没补。
      // slug 不随语言变(它是主键的人读别名), 所以每份变体都带着它一起打分。
      const hay = hayOf(m, v);
      const dhay = dhayOf(v);
      let rel = 0;
      // disc = 命中词里最有区分度的那个的 IDF。cov 一个人是不够的:
      // 它的分子分母用同一套 IDF 权重, 比值把 IDF 整个约掉了 —— 于是"命中的全是「要不」「怎么」
      // 这类废 gram"和"命中了一个全库只有三条有的专名"算出来一样高。2026-08-16 实测:
      // 只看 cov 时负例(库里根本没有的话题)最高分 0.163, 高过正例 p10 的 0.033, 完全分不开。
      let disc = 0;
      // 🔴 记的是【每段命中了哪几个 gram】, 不是【这段命中过没有】。
      // 2026-08-17 实测: 老判据"段内任一 gram 命中即整段覆盖"对中英是两把尺 ——
      // 中文一个词段切出 9 个 2-gram, 撞上 1 个就算满覆盖; 英文一个词段就 1 个词, 必须真命中。
      // 于是"番茄炒蛋怎么做"这种库里根本没有的问题也能拿到 segCov=1.0。
      // 用 Set 而不是计数器: 同一个 gram 会在 hay 和 dhay 各命中一次, 计数会翻倍。
      const segHitTerms = new Map();
      const noteHit = (g) => {
        if (g.w > disc) disc = g.w;
        const s = g.seg === undefined ? g.term : g.seg;
        let st = segHitTerms.get(s);
        if (!st) { st = new Set(); segHitTerms.set(s, st); }
        st.add(g.term);
      };
      const hit = (g, field, text) => (g.en ? stemsOf(m, field, vi).has(g.stem) : text.includes(g.term));
      for (const g of groups) { if (hit(g, 'hay', hay)) { rel += 3 * g.w; noteHit(g); } }
      for (const g of groups) { if (hit(g, 'dhay', dhay)) { rel += 1 * g.w; noteHit(g); } }
      const exact = rel > 0;
      if (!exact && groups.some((g) => fuzzyHit(g, hay, dhay))) rel += 0.5;
      return { rel, disc, exact, segHitTerms, lang: v.lang };
    };
    for (const m of nodes) {
      // 逐语言打分取最高。比的是 rel(相关度原始分)而不是最终分 —— 最终分掺了热度,
      // 而热度是整条节点共有的, 拿它比变体等于用同一个数比自己, 分不出哪一语更贴题。
      const variants = varsOf(m);
      let best = scoreVariant(m, variants[0], 0);
      for (let vi = 1; vi < variants.length; vi++) {
        const cand = scoreVariant(m, variants[vi], vi);
        if (cand.rel > best.rel) best = cand;
      }
      const { rel, disc, exact, segHitTerms } = best;
      if (terms.length && rel === 0) continue;
      const h = this._hot(m);
      let combined = rel * 3 + h * 0.6;
      // 走 tune 不走常量: 被推翻的记忆压多狠是**松紧** —— 压太狠等于删掉(推翻的初衷是留着防再踩),
      // 压太轻它又会顶掉现行结论。两处必须同时改, 只改一处等于两条路各压各的。
      if (m.status === 'superseded') combined *= tune('superseded_penalty');
      // cov 只由 rel 决定, 【不含热度】。热度是"这条最近常用", 不是"这条跟你问的有关" ——
      // 掺进把握度里, 一条天天查的记忆在任何查询下都会显得很有把握, 那正是闭嘴要挡的东西。
      const cov = maxRel > 0 ? Math.min(1, rel / maxRel) : 0;
      // 🔴 段覆盖 = 段内【命中了几成可命中的 gram】, 不是"撞够 need 个就算满覆盖"。
      // 老写法 `st.size >= need ? segW : 0` 配上 need 封顶 2, 对中日是灾难性的:
      // 词段按空白切, 中日整句没有空格 → 整句 = 1 个词段 → 29 个 gram 的段撞上任意 2 个
      // 就判"这个概念 100% 覆盖"。实测「猫が屋根の上で寝ている、どっちの選択も同じ」对控件
      // 知识拿到 segCov=1.000 / 高档, 一句正常日语问句能让 87 条记忆同时进高档 ——
      // 不是排序不准, 是大家都是满分所以根本没排序。英文按空格切成 N 个单词段, 每段 1 个
      // gram, 拿的是诚实分 0.42, 于是档线一卡就只有英文被卡住。
      // 改成比例之后两边同尺: 英文 1/1 仍是满分(零影响), 日语长句 2/25 才 0.08。
      // need 仍保留作【孤证不立】的地板 —— 撞一个不算讲到了这个概念。
      let segCov = 0;
      for (const [s, st] of segHitTerms) {
        const n = segSize.get(s) || 1;
        const need = Math.min(2, n);
        segCov += st.size >= need ? (segW.get(s) || 0) * Math.min(1, st.size / n) : 0;
      }
      segCov = segTotal > 0 ? Math.min(1, segCov / segTotal) : 0;
      // 把握度 = 概念覆盖 × 区分度。两个因子缺一不可, 各自单独都被实测证伪过:
      //   只看覆盖 → "这个怎么弄一下 有没有办法" 这种全废词查询能覆盖满分;
      //   只看区分度 → 碰巧撞上一个稀有 gram 就满分。
      // 乘起来要求【既讲到了你问的多数概念, 命中的又是有区分度的词】, 实测正例中位 0.838
      // 对负例中位 0.299, 是试过的组合里分得最开的一个。
      const confidence = segCov * disc;
      // lang = 拿到最高分的那份变体是哪一语。它不参与排序, 是给渲染层的线索:
      // 命中的是日文那份而显示的是中文原文时, 至少看得出来为什么这条会被查出来。
      // hitTerms = 这条到底是【靠哪几个词】拿到分的。排序那头做同族饱和抑制要用它:
      // 命中的词被前面某一条整个装下, 这条对本次查询的边际信息就是零。
      const hitTerms = new Set();
      for (const st of segHitTerms.values()) for (const t of st) hitTerms.add(t);
      out.set(m.id, { combined, hot: h, rel, exact, cov, disc, segCov, confidence, lang: best.lang, hitTerms });
    }
    return out;
  }

  // 同族饱和抑制: 一条候选命中的词【被前面某一条整个装下】时, 它对这次查询讲不出新东西, 让位
  // 给命中了别的词的条目。已经有 N 条把它装下就让位(N = family_sat_count, 0 关掉)。
  //
  // 病根(2026-09-05 与 2026-09-13 两次实证): 一族里的总论节点天然含着这个话题的通用词
  // (「插件 / plugin / プラグイン」), 于是在**任何**该话题的提问里都排前二, 把细分条目挤出 top-3。
  // 给旁支加关键词、加边、加 hops 都救不回来 —— 名额早被同族占满, 而四语一致复现证明这不是译文问题。
  // 🔴 治的是【名次】不是【分数】: 这一步的列表可能是 RRF 融合过的, 关键词分和余弦分不同量纲,
  //    乘系数会把两把尺混着用; 往后挪一名则与量纲无关。
  // 拿不到命中词的(语义独有 / 图上扩散 / 兜底 LIKE)一律不动: 它们本来就是多样性的来源, 不是霸榜的那一类。
  //
  // 🔴 判据必须逐条比【单条装得下】, 不能拿前面所有条目的**并集**算饱和。并集版 2026-09-13 在
  //    真库上当场打脸: 查「写插件 配色」时, 只命中「配色」一个词的配色条目, 因为「配色」被前面
  //    某条顺带占过就判饱和挪后 —— 抑制反过来打死了唯一一条讲配色的, 与初衷正相反。
  //    并集之下, 越是命中词少而独特的旁支越吃亏, 而旁支恰恰是这套机制要救的那一类。
  // 🔴 另一个试过并否掉的判据是【整批命中词完全相等】: 四语探针 en 从 17 掉到 16、简体 51→50,
  //    因为它抑制得太少却恰好挪错人。三个判据都实测过, 留下的是这一版, 别再往回试。
  // ⚠️ 代价照实记(2026-09-13 真库 k=8 实测 14 题动 1 题): 让位换来的不保证是更相关的条目 ——
  //    「命中词独特」只等于不重复, 不等于更贴题, 实测有一条不相关的记忆借此上位。收益是出厂
  //    四语探针 en 17→18 且其余三语零回退。嫌它得不偿失就把 family_sat_count 调成 0。
  // lifted: 这次顺着连线被扩散到的节点。有边 = 有人说过它俩相关, 那就不是同族重复, 不让位
  // (10-11 实测: 规则连在 top1 上, 自己分数还最高, 却因命中词全被前面用过而让到第 20)。
  _deferSaturatedFamily(ranked, all, k, lifted = new Set()) {
    const satN = tune('family_sat_count');
    if (!(satN > 0) || ranked.length <= k) return ranked;
    const seen = new Map();
    const keep = [], defer = [];
    for (const entry of ranked) {
      if (lifted.has(entry[0])) { keep.push(entry); continue; }
      const v = all.get(entry[0]);
      const hits = v && v.hitTerms;
      if (!hits || !hits.size) { keep.push(entry); continue; }
      let covered = 0;
      for (const prev of seen.values()) {
        let subset = true;
        for (const t of hits) if (!prev.has(t)) { subset = false; break; }
        if (subset) covered++;
      }
      if (covered >= satN) defer.push(entry);
      else { keep.push(entry); seen.set(entry[0], hits); }
    }
    return defer.length ? keep.concat(defer) : ranked;
  }

  // 关联位: 前 3 条的直接邻居里, 有没进结果的就补分最高的那几条(graph_slots, 默认 1)。
  // 店主新教的规矩只连了两三根边, 而出厂知识互相连得很密、扩散时彼此加分, 分数上永远压着它 ——
  // 不留位的话「查到 A 就看得见连在 A 上的规矩」这件事不成立(10-11 实测: 连在 top1 上仍排第 17)。
  _reserveLinkedSlot(ranked, idx, act, conf, via, k, flat) {
    const slots = tune('graph_slots');
    if (flat || !(slots > 0) || !ranked.length) return ranked;
    const { adj } = this._adjacency(idx);
    // 只排除前 3 条自己: 已在结果里但排在后面的也要提上来 —— 调用方常常只显示前几条。
    const have = new Set(ranked.slice(0, 3).map(([id]) => id));
    const cand = new Map();
    for (const [id] of ranked.slice(0, 3)) {
      for (const nb of (adj.get(id) || [])) {
        if (have.has(nb) || !idx.nodes[nb] || !act.has(nb)) continue;
        if (!cand.has(nb)) cand.set(nb, id);
      }
    }
    // 挑谁: 人格自己长的(店主教的)先于出厂, 同类里按这次查询的相关度(act)。按分数一锅排的话名额
    // 永远落在出厂邻居上; 先比重要度的话, 同一枢纽上挂着几条店主规矩时会挑中跟这次无关的那条。
    const rank = (id) => { const m = idx.nodes[id] || {}; return [m.is_factory ? 0 : 1, act.get(id) || 0]; };
    const cmp = (a, b) => { const x = rank(a), y = rank(b); return (y[0] - x[0]) || (y[1] - x[1]); };
    const pick = [...cand.keys()].sort(cmp).slice(0, slots);
    if (!pick.length) return ranked;
    for (const nb of pick) {
      const from = idx.nodes[cand.get(nb)];
      via.set(nb, `图·关联←${(from && from.slug) || cand.get(nb)}`);
      // 把握度至少给到中档线: 它是被一条够格的结果点名带出来的, 不该在下游被当低档滤掉
      conf.set(nb, Math.max(conf.get(nb) || 0, tune('tier_mid')));
    }
    // 插在第 3 条后面, 不放末尾: 调用方常多要几条再自己截(工具层 k+兜底), 放末尾会被截掉。
    const picked = new Set(pick);
    const keep = ranked.filter(([id]) => !picked.has(id)).slice(0, Math.max(0, k - pick.length));
    const at = Math.min(3, keep.length);
    return keep.slice(0, at).concat(pick.map((id) => [id, act.get(id)]), keep.slice(at));
  }

  _bodyHitIds(terms) {
    const out = new Set();
    const aliases = loadAliases();
    for (const x of terms) {
      const t = typeof x === 'string' ? x : x.t;
      const derived = typeof x === 'string' ? false : x.derived;
      if (derived) continue;    // 2-gram 碎片在长正文里几乎必然命中, 会把兜底层变成"全库都算命中"
      for (const id of this.store.bodyMatches(t)) out.add(id);
      for (const w of (aliases.get(t) || new Set())) {
        if (w !== t) for (const id of this.store.bodyMatches(w)) out.add(id);
      }
    }
    return out;
  }

  // 检索只看没退役的: 出厂同步把这版包里删掉的条目标 archived(factory-sync.js), 本意就是"检索查不到"。
  // 只在检索这里滤, 不动 _fresh() —— 体检、出厂同步还要看得见 archived 才能翻回来。
  _activeIdx() {
    const idx = this._fresh();
    if (this._activeFor === idx) return this._activeIdxCache;
    const nodes = {};
    for (const [id, m] of Object.entries(idx.nodes)) if ((m.status || 'active') !== 'archived') nodes[id] = m;
    this._activeFor = idx;
    this._activeIdxCache = { nodes, edges: idx.edges, pinned: idx.pinned };
    return this._activeIdxCache;
  }

  query(q, { k = 8, hops = 2, flat = false, semantic = true, minTier = 'med', budget = 0, kind = 'query' } = {}) {
    const idx = this._activeIdx();
    const terms = tokenize(q);
    const all = this._flatScores(idx, terms);
    const flatM = new Map([...all].filter(([, v]) => v.exact));
    const fuzzyM = new Map([...all].filter(([, v]) => !v.exact));
    const act = new Map(), via = new Map(), lifted = new Set();
    const semScore = new Map();
    const conf = new Map();
    for (const [id, v] of flatM) { act.set(id, v.combined); via.set(id, '直接'); conf.set(id, v.confidence); }
    if (!flat) {
      const { adj, deg } = this._adjacency(idx);
      // 只有精确命中(rel≥1)配当扩散种子。弱信号可以进结果, 但不能当传播源 ——
      // 2026-08-09 实测: 兜底命中一并当种子时旧 top8 有 43.8% 被冲掉。
      let frontier = new Map([...flatM].filter(([, v]) => v.rel >= 1)
        .map(([id, v]) => [id, { energy: v.combined, conf: v.confidence }]));
      for (let hop = 1; hop <= hops; hop++) {
        const nxt = new Map();
        for (const [id, f] of frontier) {
          for (const nb of (adj.get(id) || [])) {
            const add = f.energy * HOP_DECAY * hubDamp(deg.get(nb));
            if (add < 0.3) continue;
            act.set(nb, (act.get(nb) || 0) + add);
            lifted.add(nb);
            const nbConf = f.conf * HOP_DECAY;
            const prev = nxt.get(nb);
            nxt.set(nb, { energy: Math.max((prev && prev.energy) || 0, add),
                          conf: Math.max((prev && prev.conf) || 0, nbConf) });
            // 邻居的把握 = 种子的把握逐跳打折。它自己一个词都没命中, 凭的是"跟命中的那条有关",
            // 这份把握本来就该比种子低一档; 两跳外基本必然落进闭嘴区, 这是对的。
            if (!flatM.has(nb)) conf.set(nb, Math.max(conf.get(nb) || 0, nbConf));
            if (!flatM.has(nb) && !via.has(nb)) {
              const from = idx.nodes[id];
              via.set(nb, `图·${hop}跳←${(from && from.slug) || id}`);
            }
          }
        }
        frontier = nxt;
      }
    }
    let kwRanked = [...act.entries()].sort((a, b) => b[1] - a[1]);
    const semHits = semantic ? this._semanticRanking() : [];
    if (kwRanked.length < k) {
      const pool = new Map(fuzzyM);
      for (const id of this._bodyHitIds(terms)) {
        if (act.has(id) || pool.has(id)) continue;
        const m = idx.nodes[id];
        if (!m) continue;
        const h = this._hot(m);
        let combined = 0.5 * 3 + h * 0.6;
        // 走 tune 不走常量: 被推翻的记忆压多狠是**松紧** —— 压太狠等于删掉(推翻的初衷是留着防再踩),
      // 压太轻它又会顶掉现行结论。两处必须同时改, 只改一处等于两条路各压各的。
      if (m.status === 'superseded') combined *= tune('superseded_penalty');
        pool.set(id, { combined, hot: h, rel: 0.5, exact: false, body: true });
      }
      const extra = [...pool.entries()].filter(([id]) => !act.has(id))
        .sort((a, b) => b[1].combined - a[1].combined);
      for (const [id, v] of extra) { via.set(id, v.body ? '兜底·正文' : '兜底·别名'); conf.set(id, tune('fallback_conf')); }
      kwRanked = kwRanked.concat(extra.map(([id, v]) => [id, v.combined]));
    }
    // 🔴 先融合出【比 k 多】的候选, 过滤完再切 k。反过来做的话, 低档条目会先占满 k 个名额,
    // 再被过滤掉 —— 结果是明明还有够格的却只给了两条。
    const wide = Math.max(k * 3, k + 8);
    let ranked = kwRanked.slice(0, wide);
    if (semHits.length) {
      const semById = new Map(), semIds = [];
      for (const h of semHits) {
        if (!idx.nodes[h.id]) continue;   // 向量还在但节点已删
        semById.set(h.id, h); semIds.push(h.id);
      }
      const kwIds = kwRanked.map(([id]) => id);
      const kwScore = new Map(kwRanked);
      ranked = rrfOrder(kwIds, semIds, wide, semanticWeight(kwRanked)).map((id) => {
        const h = semById.get(id);
        if (kwScore.has(id)) {
          // 两路都命中时置信度取较高的一路。关键词那一路可能只是上面的兜底 LIKE 撞上一次
          // (FALLBACK_CONF=0.08), 无条件让它赢就等于把 0.88 的余弦按 0.08 记 —— 最该出场的
          // 记忆被压进"引擎自己没把握"的兜底段, 而下面那道过滤用的正是这个值。
          if (h) {
            semScore.set(id, h.score);
            const sc = semConf(h.score);
            if (sc > (conf.get(id) || 0)) { conf.set(id, sc); via.set(id, `语义·${h.score.toFixed(3)}`); }
          }
          return [id, kwScore.get(id)];
        }
        semScore.set(id, h.score);
        via.set(id, `语义·${h.score.toFixed(3)}`);
        // 语义独有的条目关键词一个没中, 把握全由余弦给。真正的关键词命中(覆盖率算出来的)
        // 通常高于余弦档, 上面那个 max 不会把它覆盖掉 —— 被覆盖的只有兜底那一档。
        conf.set(id, Math.max(conf.get(id) || 0, semConf(h.score)));
        return [id, h.score];
      });
    }
    // 分数不够就闭嘴。默认切在中档: 低档 = 图上远得没影了 / 兜底 LIKE 撞上一次 / 余弦刚过地板,
    // 这些塞进上下文不是"多点线索", 是让我拿着不相干的东西当依据答话。
    const floorConf = minTier === 'high' ? tune('tier_hi') : (minTier === 'low' ? 0 : tune('tier_mid'));
    const before = ranked.length;
    ranked = ranked.filter(([id]) => (conf.get(id) || 0) >= floorConf);
    const filtered = Math.max(0, Math.min(before, kwRanked.length) - ranked.length);
    ranked = this._deferSaturatedFamily(ranked, all, k, lifted);
    ranked = ranked.slice(0, k);
    ranked = this._reserveLinkedSlot(ranked, idx, act, conf, via, k, flat);
    // 注入预算: 条数管不住体积 —— 8 条命题可能是 200 token 也可能是 2000。
    // 按序累加着切, 不重排: 结果本来就是按分数下来的, 高档天然在前, 预算自然先喂给最有把握的。
    // 🔴 至少留一条: 预算再紧也不能把"最有把握的那条"整条砍掉 —— 那就从"少给点"变成了"什么都没给",
    // 而调用方会把空结果读成"库里没有"。
    if (budget > 0) {
      let spent = 0;
      const fit = [];
      for (const [id, score] of ranked) {
        const m = idx.nodes[id] || {};
        const cost = estTokens(`${m.slug || ''} ${m.title || ''} ${m.claim || ''}`) + 8;
        if (fit.length && spent + cost > budget) break;
        fit.push([id, score]);
        spent += cost;
      }
      ranked = fit;
    }
    const out = ranked.map(([id, score]) => {
      const m = idx.nodes[id] || {};
      const shown = semScore.has(id) ? Math.round(semScore.get(id) * 1000) / 1000 : Math.round(score * 10) / 10;
      // 🔴 supersedes 边在这里兑现它的执行力: 召回一条已被推翻的记忆时, 强制把推翻者的命题一并带出。
      // v1 的 superseded_by 只是 nodes 上一个字段, 没人在召回时看 —— 这就是
      // feedback_cross_persona_relay_via_butler_not_direct 骗过我 4 次的机制。
      const sup = this.store.supersededBy(id);
      const c = Math.round((conf.get(id) || 0) * 1000) / 1000;
      return {
        id, slug: m.slug || '', score: shown, via: via.get(id) || '图',
        // 🔴 tier 必须跟着结果一起出去。分档只在引擎里算完就扔掉的话, 拿结果的那一侧
        // 仍然只能看到一串条目, 分不出哪条是"当事实用"哪条是"仅供参考" —— 三分档就白做了。
        confidence: c, tier: tierOf(conf.get(id) || 0),
        // 🔴 返回值必须带 claim。检索结果不带命题, 我拿到的就只是一串数字编号和标题 ——
        // 那等于把"不读正文就知道这条讲什么"的全部收益扔掉。
        claim: m.claim || '', title: m.title || '',
        // 🔴 与 tier 同理: 这个位算在引擎里却不带出去, 渲染层就永远分不出哪条命题还没判过
        // 真假 —— 而未判过的那条长得跟定论一模一样。带出来才谈得上标记。
        claim_provisional: Number(m.claim_provisional) || 0,
        anchors: m.anchors || '',
        // 🔴 同上: 算在引擎里不带出去, 渲染层就无从提醒「这条是别的项目验的」。
        projects: m.projects || '',
        importance: m.importance, last_used: m.last_used,
        hot: this._hot(m), pinned: idx.pinned.has(id),
        status: m.status || 'active',
        overturned_by: sup.map((s) => ({ id: s.id, slug: s.slug, claim: s.claim })),
      };
    });
    // 尺子: 每次检索都留一条流水, 供事后算"查了却没用上"的比例。
    // 记账失败绝不能影响检索结果 —— 尺子坏了是尺子的事, 不该让人查不了东西。
    try {
      // top_score 记的是【把握度】不是 combined 绝对分。尺子的读数要能跨查询比较,
      // 而绝对分随词数/语料整体平移 —— 记它等于记了一列没法横向比的数。
      // filtered 必须单独记: 闭嘴上线后, "零命中"会多出第三种成因(有东西但不够格),
      // 不分开的话尺子会把"检索太严"误报成"库里没有 → 去补内容", 指错整改方向。
      // 🔴 filtered 记的是【够不上闭嘴线的条数】, 不是【被丢弃的条数】。两者在 minTier='med'
      // 下相等, 但兜底交付(minTier='low')会把低档条目留在 out 里 —— 那时若只数被丢弃的,
      // filtered 恒为 0, "检索太严"这个信号就凭空消失了。所以两处都要数。
      // 🔴 kind 决定这条流水算不算进成绩单。只有我主动查的('query')才算 ——
      // 自动钩子('auto')是系统塞的、查重('dedupe')的目的恰恰是希望查不到,
      // 这两类天然不会被 touch。混进一个分母实测把失败率从 71% 抬到 88%。
      this.store.logRecall({
        q, kind, hits: out.length,
        top_score: out.length ? out[0].confidence : 0,
        top_ids: out.map((r) => r.id),
        filtered: filtered + out.filter((r) => r.tier === 'low').length,
      });
    } catch (e) { console.error('[recall-log] 记账失败(不影响检索):', e && e.message); }
    return out;
  }

}

module.exports = RetrievalMixin;
