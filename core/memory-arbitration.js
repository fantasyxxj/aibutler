// memory-arbitration.js — 冲突检出(机械筛) + 判决落盘 + 僵尸项目检出。
//
// 与 memory-revisions.js 一样是**旁路**能力: 不参与图检索, 删掉本模块图照样跑。
// 拆出来的第二个理由是 memory.js 已逼近"单文件 ≤500 行"红线。
//
// 设计要点(为什么不做成"检测到冲突就删一条"):
// mem0 issue #4536 翻车实录 ——「我爱中餐」→「我讨厌中餐」→ LLM 直接发 DELETE → get_all() 返回空。
// 所以这里**只降权 + 标状态, 从不删**; 而且先分类再决定要不要选边, 大多数"冲突"其实是场景不同的伪冲突。
const fs = require('fs');
const path = require('path');
const rev = require('./memory-revisions');
const { cosine } = require('./memory-vector');

// 可疑对判定阈值。中文 bigram 的 Jaccard 天然偏低(共享 2-gram 比英文共享单词稀疏),
// 所以这个初值比英文场景的经验值(~0.4)低。**是拍的**, 上线后按实际检出量校准, 走配置不改码。
const SUSPECT_THRESHOLD = 0.25;
const MAX_PAIRS = 3;   // 一次最多提示几对 —— 提示多了等于没提示

// 中文分词的替代方案: ASCII 取词 + 汉字取 bigram。
// 为什么不引分词库: memory.js 全链路零原生依赖是硬约束(打包体积 + 跨平台), 而 bigram 对
// "同一件事的两种说法"这种近义判断已经够用 —— 我们只要圈定候选, 真正判是不是冲突是 AI 的活。
function tokens(s) {
  const t = String(s || '').toLowerCase();
  const out = new Set();
  for (const w of (t.match(/[a-z0-9_]+/g) || [])) if (w.length > 1) out.add(w);
  const zh = t.replace(/[^一-龥]+/g, ' ').trim();
  for (const seg of zh.split(/\s+/)) {
    if (seg.length === 1) { out.add(seg); continue; }
    for (let i = 0; i + 1 < seg.length; i++) out.add(seg.slice(i, i + 2));
  }
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// 机械筛可疑对。零 LLM —— 判"这两条打没打架"搭 AI 读 query 结果那趟顺风车, 不是额外调用。
function suspectPairs(nodes, { threshold = SUSPECT_THRESHOLD, max = MAX_PAIRS } = {}) {
  const list = (nodes || []).filter((n) => n && n.id);
  const tok = new Map(list.map((n) => [n.id, tokens(`${n.description || ''} ${n.title || ''}`)]));
  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      // 判过的不再判: 已有 supersede 关系, 或任一方已是 superseded 态
      if (a.superseded_by === b.id || b.superseded_by === a.id) continue;
      if ((a.status || 'active') !== 'active' || (b.status || 'active') !== 'active') continue;
      const j0 = jaccard(tok.get(a.id), tok.get(b.id));
      if (j0 < threshold) continue;
      // 加权而非硬条件: 同为规则类(feedback)且 scope 相同 → 更可能真打架, 排前面先看
      const sameKind = a.type === 'feedback' && b.type === 'feedback';
      const sameScope = !!(a.scope && b.scope && a.scope === b.scope);
      const weight = j0 * (sameKind ? 1.3 : 1) * (sameScope ? 1.2 : 1);
      pairs.push({
        a: a.id, b: b.id,
        jaccard: Math.round(j0 * 1000) / 10,
        weight: Math.round(weight * 1000) / 10,
        why: [sameKind ? '同为规则类' : '', sameScope ? '同 scope' : ''].filter(Boolean).join(' · ') || '主题重叠',
      });
    }
  }
  return pairs.sort((x, y) => y.weight - x.weight).slice(0, max);
}

// ——————————————————————————————————————————————————————————
// 定期冲突体检 (作者 2026-08-13 派: "现在没有记忆冲突的处理机制, 要定期自动解决")
//
// 🔴 为什么候选不靠 jaccard 主力: 2026-08-09 实测 —— 同一件事记两遍(字面重叠) 抓得到 58.5%,
// 但"同主题换词表达、结论相反"只有 1.8~3.3%, 与无关节点噪声 2.8% 重合, 信噪比≈1, 阈值定在哪都分不开。
// 根因是 description 按设计就是摘要, 不含具体主张 —— 两条讲同一件事的记忆在摘要层面可以零词汇重叠。
// 而**换词表达那类恰好就是结构性冲突**(新结论推翻老的 / 规矩层层叠加打架)。
//
// 所以这里换特征, 不挪阈值。用图记忆独有的、jaccard 没有的三路信号圈候选:
//   ① 已连边   —— 我自己判定过"这两条相关"才连的边, 比任何词面相似都准, 而冲突几乎只发生在相关节点之间
//   ② 同族 id  —— feedback_memory_xxx 与 feedback_memory_yyy 天然同主题
//   ③ 都在立规矩 —— 两边正文都是"必须/一律/不许"这类模态句, 撞车概率远高于叙事型节点
// 词面重叠仍算一路(零成本, 抓到算赚), 但只当加分项。
//
// 圈完不判 —— 真判是 AI 读**正文**的活(摘要层判不了, 上面那条根因就是这么来的)。
// 引擎只保证三件机械的事: 到点提醒 / 每次只端几对上来 / 判过的记账别再问第二遍。
const SCAN_INTERVAL_DAYS = 7;      // 多久体检一次
const SCAN_BATCH = 2;              // 一次端几对 —— 端多了等于没端(要读双方正文, 一对就是一次真阅读)
const AUDIT_FILE = '.conflict_audit.json';
// 判过多久可以再问一次。伪冲突结论最稳(基本不会变回去), 问过用户的最短(可能还没等到答复)。
const COOLDOWN_DAYS = { no_conflict: 180, scoped: 180, merged: 180, arbitrated: 180, asked_user: 7 };
const VERDICTS = Object.keys(COOLDOWN_DAYS);
// 立规矩的模态句特征。中英混排都吃, 命中即认为"这条在规定该怎么做", 而不是在记叙一件事。
const MODAL_RE = /必须|一律|永远|只能|不许|不准|禁止|绝不|铁律|默认|应该|不要|别再|优先|首选/;

const pairKey = (a, b) => [a, b].sort().join('|');

function auditPath(memoryDir) { return path.join(memoryDir, AUDIT_FILE); }

function readAudit(memoryDir) {
  try { return JSON.parse(fs.readFileSync(auditPath(memoryDir), 'utf8')); }
  catch (_) { return { last_scan_at: 0, pairs: {} }; }
}

function writeAudit(memoryDir, data) {
  try { fs.writeFileSync(auditPath(memoryDir), JSON.stringify(data, null, 2), 'utf8'); return true; }
  catch (_) { return false; }
}

// 家族 = id 去掉最后一段之后的前缀, 至少两段才算(feedback_memory_upsert_x → feedback_memory_upsert)。
function family(id) {
  const seg = String(id || '').split('_');
  return seg.length >= 3 ? seg.slice(0, -1).join('_') : '';
}

// 圈候选对的共用部分。零 LLM、零网络, 纯读已建好的索引。
// seeds 给了就只配"至少一边是种子"的那些对 —— 检索那条路只关心跟本次命中沾边的冲突,
// 而全库两两配对是平方级的(1683 条 = 141 万对 = 3.3 秒同步占死主线程), 那是七天一次体检的活。
// defer=true 只把料备好、循环交给调用方自己驱动(分片版要在两两之间让出事件循环)。
// vecOf(id) → 归一化向量 | undefined: 给了就加一路语义 —— 同一件事换个说法写两遍, 词面常常对不上
// (10-27 我的库: 只认词面时 2699 条只进池 9 对, 人工判过该合并的 12 对一对都没进前 20)。
// 不给 = 逐位退回纯词面, 没装语义模型的机器行为不变。cos 三个参数由调用方从 memory-tuning 传入。
function scanPairs(nodes, links, { max = SCAN_BATCH, audit = null, now = Date.now(), seeds = null, defer = false,
  vecOf = null, cosIn = 0.955, cosLinkOk = 0.96, cosWeight = 30 } = {}) {
  const all = Object.values(nodes || {}).filter((n) =>
    n && n.id && (n.status || 'active') === 'active' &&
    (n.type === 'feedback' || n.type === 'reference'));   // project 记的是状态不是主张, 状态变了不叫冲突
  const byId = new Map(all.map((n) => [n.id, n]));
  const linked = new Set();
  for (const [s, d] of (links || [])) if (byId.has(s) && byId.has(d)) linked.add(pairKey(s, d));
  const tok = new Map(all.map((n) => [n.id, tokens(`${n.description || ''} ${n.title || ''}`)]));
  const seenPairs = (audit && audit.pairs) || {};

  const out = [];
  const evalPair = (a, b, key) => {
    if (a.superseded_by === b.id || b.superseded_by === a.id) return;
    // 两条都还是出生时灌进来的出厂原样 → 跳过。它们是一起下发、彼此早校对过的,
    // 而且出厂知识之间连边最密(全是规矩类), 不跳的话新人格头几个月每周都在审自己的出厂知识。
    // 有任意一条被人格自己改写过(origin 标记会消失), 这一对就恢复互审。
    // v2 不写 origin, 出厂标记是 is_factory(factory-sync 打上, 人格写不进去); 两种都认。
    const fac = (n) => !!n.is_factory || n.origin === 'birth';
    if (fac(a) && fac(b)) return;
    const prev = seenPairs[key];
    if (prev) {
      const cd = (COOLDOWN_DAYS[prev.verdict] != null ? COOLDOWN_DAYS[prev.verdict] : 180) * 86400000;
      if (now - (prev.at || 0) < cd) return;              // 判过了, 冷却期内不重复问
    }
    const isLinked = linked.has(key);
    const sameFamily = !!family(a.id) && family(a.id) === family(b.id);
    const j0 = jaccard(tok.get(a.id), tok.get(b.id));
    const bothRule = a.type === 'feedback' && b.type === 'feedback';
    const bothModal = MODAL_RE.test(a.body || '') && MODAL_RE.test(b.body || '');
    // 🔴 进池只认一件事: **词面真的撞了**。
    // 老判据是「连边 / 同族 / 词面重叠」三中一, 但前两个都不是打架的证据 —— 两条之间
    // 连着边, 恰恰说明当初写的人认为它们相关且**应当并存**; 同族更是正常细分。而记忆图
    // 边多族也多(实测 2400 节点 8200 边), 这两条旁路等于把阈值架空: top-N 常年被
    // 「互相链接的正常关联」占满, 真正撞车的反被挤下去, 伪冲突就是这么反复刷屏的。
    // 语义这一路只放行「几乎同义」的对(cosIn), 不是放宽阈值: e5 上无关的两条也有 0.88(全库中位数)。
    const va = vecOf && vecOf(a.id), vb = va && vecOf(b.id);
    const cos = va && vb && va.length === vb.length ? cosine(va, vb) : 0;
    if (j0 < SUSPECT_THRESHOLD && cos < cosIn) return;
    // pinned 加权: 红线是全量注入、每次苏醒都照做的东西, 两条红线打架的代价远高于两条参考资料打架。
    const hasPinned = a.importance === 'pinned' || b.importance === 'pinned';
    // 连边改成**减分**(同上: 有边 = 有意并存, 该压低嫌疑); 同族的加分也压下来, 让
    // 真正决定排序的是词面重叠本身。
    // 余弦极高时连边不减分: 同一件事写两遍的往往也被顺手连了边(「0.1.6 准备打包」↔「已打完」)。
    const score = (isLinked && cos < cosLinkOk ? -0.5 : 0) + (sameFamily ? 0.3 : 0) + j0 * 2
                + Math.max(0, cos - cosIn) * cosWeight
                + (bothRule ? 0.6 : 0) + (bothModal ? 0.4 : 0)
                + (hasPinned ? 0.5 : 0)
                + (a.scope && a.scope === b.scope ? 0.2 : 0);
    out.push({
      a: a.id, b: b.id, key,
      score: Math.round(score * 100) / 100,
      // 连边不再列进 why —— 它已经不是「为什么可疑」的理由, 反而是降权项, 写进去
      // 只会让人格把"它俩相关"读成"它俩打架"。
      why: [sameFamily ? '同族 id' : '',
            j0 >= SUSPECT_THRESHOLD ? `词面重叠 ${Math.round(j0 * 1000) / 10}%` : '',
            bothRule ? '都是规矩类' : '', bothModal ? '都在立规矩' : '',
            hasPinned ? '涉及红线' : '', cos >= cosIn ? `语义相近 ${Math.round(cos * 1000) / 1000}` : ''].filter(Boolean).join(' · '),
      a_desc: (a.description || '').slice(0, 100), b_desc: (b.description || '').slice(0, 100),
      a_path: a.file_path, b_path: b.file_path,
      revisited: !!prev,
    });
  };

  if (defer) return { all, evalPair, out, max };

  if (seeds) {
    const done = new Set();
    for (const a of all) {
      if (!seeds.has(a.id)) continue;
      for (const b of all) {
        if (a.id === b.id) continue;
        const key = pairKey(a.id, b.id);
        if (done.has(key)) continue;   // 两条都是种子时会碰面两次
        done.add(key);
        evalPair(a, b, key);
      }
    }
  } else {
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) evalPair(all[i], all[j], pairKey(all[i].id, all[j].id));
    }
  }
  return { all, evalPair, out, max };
}

// 圈候选对(同步)。只在给了 seeds 的检索路径上用 —— 不给 seeds 就是全库平方级, 会占死主线程。
function conflictCandidates(nodes, links, opts = {}) {
  const { out, max } = scanPairs(nodes, links, opts);
  return out.sort((x, y) => y.score - x.score).slice(0, max);
}

// 全库普扫的分片版: 每积够一批对就让出一次事件循环。总时长不比同步版短(甚至更长),
// 但主线程从不被连续占死 —— 后台普扫慢没关系, 卡住界面才有关系。
const YIELD_EVERY_PAIRS = 5000;   // ≈12ms 一片, 一帧之内
async function conflictCandidatesChunked(nodes, links, opts = {}) {
  const { all, evalPair, out, max } = scanPairs(nodes, links, { ...opts, seeds: null, defer: true });
  let since = 0;
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) evalPair(all[i], all[j], pairKey(all[i].id, all[j].id));
    since += all.length - i - 1;
    if (since >= YIELD_EVERY_PAIRS) { since = 0; await new Promise((r) => setImmediate(r)); }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, max);
}

// 记账: 这对判过了, 冷却期内别再端上来。verdict 决定冷却多久。
function settleConflict(memoryDir, { a, b, verdict, note = '', now = Date.now() } = {}) {
  if (!a || !b) throw new Error('settleConflict 需要 a 和 b');
  if (!VERDICTS.includes(verdict)) throw new Error(`verdict 只能是 ${VERDICTS.join(' | ')}, 收到: ${verdict}`);
  const data = readAudit(memoryDir);
  const key = pairKey(a, b);
  data.pairs = data.pairs || {};
  data.pairs[key] = { verdict, note, at: now };
  writeAudit(memoryDir, data);
  return { key, verdict, cooldownDays: COOLDOWN_DAYS[verdict], settled: true };
}

// 到点了没。第一次跑(last_scan_at=0)也算到点 —— 新图没历史包袱, 扫一次基本是空的, 成本可忽略。
function scanDue(memoryDir, { days = SCAN_INTERVAL_DAYS, now = Date.now() } = {}) {
  const a = readAudit(memoryDir);
  const last = a.last_scan_at || 0;
  return { due: now - last >= days * 86400000, last_scan_at: last, days };
}

function markScanned(memoryDir, { now = Date.now() } = {}) {
  const data = readAudit(memoryDir);
  data.last_scan_at = now;
  writeAudit(memoryDir, data);
  return data.last_scan_at;
}

// 只在 frontmatter 段内改字段, 绝不碰 body ——
// body 里出现一行 "status: 待定" 是完全可能的(记笔记), 用全文正则会把它误伤。
function setFmField(text, key, value) {
  const m = /^(---\s*\n)([\s\S]*?)(\n---\s*\n?)([\s\S]*)$/.exec(text);
  if (!m) return text;
  let fm = m[2];
  const re = new RegExp(`^(\\s*)${key}:\\s*.*$`, 'm');
  if (re.test(fm)) fm = fm.replace(re, `$1${key}: ${value}`);
  else if (/^metadata:\s*$/m.test(fm)) fm = fm.replace(/^metadata:\s*$/m, `metadata:\n  ${key}: ${value}`);
  else fm = fm + `\n  ${key}: ${value}`;
  return m[1] + fm + m[3] + m[4];
}

// 判决落盘: 给败方标 superseded + 指向胜方, 记 op=supersede 日志, 返回留痕文本。
// 非破坏是刻意的 —— 失效只写元数据, 判错了损失的是召回不是数据, 随时可逆。
function arbitrate(memoryDir, { winner, loser, reason = '', basis = [], auto = true, asked = false } = {}) {
  if (!winner || !loser) throw new Error('arbitrate 需要 winner 和 loser');
  if (winner === loser) throw new Error('winner 和 loser 不能是同一条');
  const lp = path.join(memoryDir, loser + '.md');
  if (!fs.existsSync(lp)) throw new Error(`败方节点不存在: ${loser}`);
  if (!fs.existsSync(path.join(memoryDir, winner + '.md'))) throw new Error(`胜方节点不存在: ${winner}`);

  const before = fs.readFileSync(lp, 'utf8');
  let after = setFmField(before, 'status', 'superseded');
  after = setFmField(after, 'superseded_by', winner);
  fs.writeFileSync(lp, after, 'utf8');

  const r = rev.logRevision(memoryDir, {
    op: 'supersede', node_id: loser, counterpart: winner,
    old_body: '', new_body: '', reason, basis, auto, asked,
  });
  // B5 作者钦定: 自动判也留痕。成本一行字, 换来他能随时抓我判错。
  const trace = `↳ 顺带：把 ${loser} 标为失效（原因：${reason || '与 ' + winner + ' 冲突'}）`;
  return { winner, loser, ts: r && r.ts, trace, auto, asked };
}

// 推翻一次判决: 败方恢复 active + 日志标 overturned。
// 这是整个自校正闭环的唯一真值来源 —— 没有它, 推翻率恒为 0, C6 统计层就是死的,
// "判得准的类别自动获得更多自动权"这个机制也就永远不会启动。
// 非破坏设计在这里兑现: 判错了改回来就行, 原文一个字没动过。
function undoArbitrate(memoryDir, { loser, reason = '' } = {}) {
  if (!loser) throw new Error('undoArbitrate 需要 loser');
  const lp = path.join(memoryDir, loser + '.md');
  if (!fs.existsSync(lp)) throw new Error(`节点不存在: ${loser}`);
  let text = fs.readFileSync(lp, 'utf8');
  text = setFmField(text, 'status', 'active');
  text = setFmField(text, 'superseded_by', '');
  fs.writeFileSync(lp, text, 'utf8');
  const m = rev.markOverturned(memoryDir, loser, { note: reason });
  return { loser, restored: true, logMarked: m.ok, reason };
}

// 僵尸项目: review_due 过期且仍 active 的 project_*。
// 🔴 为什么不用热度衰减检出: 一个卡了三个月的**真·在办**项目热度最低但最不能忘,
// 机械衰减在这里反而有害 —— 它会精确地先干掉最该被追问的那几条。必须显式到期。
function zombies(nodes, todayStr) {
  const out = [];
  for (const m of Object.values(nodes || {})) {
    if (!m.id || !m.id.startsWith('project_')) continue;
    if ((m.status || 'active') !== 'active') continue;
    if (!m.review_due) continue;
    if (String(m.review_due) >= String(todayStr)) continue;
    const a = Date.parse(m.review_due + 'T00:00:00Z'), b = Date.parse(todayStr + 'T00:00:00Z');
    out.push({
      id: m.id, review_due: m.review_due,
      daysOverdue: isNaN(a) || isNaN(b) ? 0 : Math.round((b - a) / 86400000),
      exit_criteria: m.exit_criteria || '(未填)',
      description: (m.description || '').slice(0, 70),
    });
  }
  return out.sort((x, y) => y.daysOverdue - x.daysOverdue);
}

module.exports = {
  suspectPairs, arbitrate, undoArbitrate, zombies, setFmField, tokens, jaccard,
  SUSPECT_THRESHOLD, MAX_PAIRS,
  conflictCandidates, conflictCandidatesChunked, settleConflict, scanDue, markScanned, readAudit, pairKey, family,
  SCAN_INTERVAL_DAYS, SCAN_BATCH, VERDICTS, COOLDOWN_DAYS, AUDIT_FILE,
};
