// 图记忆的常量与纯函数 —— 打分 / 分词 / 日期 / 别名 / frontmatter 解析。
// 由 memory.js 顶部抽出(内核抽包第 2 步)。这里没有类、不认识宿主, 任何应用可单独 require。
//
// 🔴 这批东西 v1 与 v2 共用【同一份】, 不是各存一份。两版并存期间最怕的就是打分算法各改各的 ——
// 行业版与 butler 已经这么漂了 677 行, 不能再来一次。v2 只该替换"数据从哪来", 不该重写"怎么打分"。
const fs = require('fs');
const path = require('path');

// 2026-08-07 重标定 (作者: "pinned 快 500 个, 全都是 105 分, 根本没有区分价值了")。
// 旧值 pinned base=100 / 半衰期=99999天 → hotness 恒 105.0 精确同分, 后果两处:
//   ① hot() 退化成字母序(实测 483 节点里 52 个并列 105, top-12 全是 feedback_b*/c*/d*)
//   ② query() 的 combined = rel*W + hotness 被 100 基分淹没 → 蹭到一个词的 pinned 压过全中的 high
// 新值让 pinned 仍最高但不碾压, 且随时间/使用次数拉开差距。
const IMP_BASE = { pinned: 12.0, high: 6.0, med: 3.0, low: 1.0 };
// 半衰期(天): hot 回答的是"最近在忙啥", 所以量级按周/月算, 不按年 —— 旧值 pinned=99999 等于永不衰减。
const IMP_HL   = { pinned: 60, high: 40, med: 25, low: 10 };
const REC_W = 8.0;      // 时间权重 > 基础重要性差, 这样一个月前的 pinned 会让位给这周的 pinned
const USE_W = 1.2;      // 用得多的浮上来, 但压不过 recency (否则历史高频节点永远赖在 top)
const TYPE_DEFAULT_IMP = { feedback: 'high', reference: 'med', project: 'med', user: 'high' };
// pinned = 常驻: 每个会话开头整份注入系统提示(core/agent/system-prompt.js _pinnedBlock)。
// 配额和单条字数是常驻大小的两道盖 —— 每多一条, 每一轮都多付一次。满了不自动淘汰, 交出清单让人选。
const PINNED_QUOTA = 10;
const PINNED_MAX_CHARS = 120;
// 机械筛信号: 一次性/已完结/指向具体版本的 id, 多半属于"场景已消失"→ 优先进降级候选 (仍由 AI 定夺)。
const PINNED_STALE_HINT = /shipped|deprecated|obsolete|_v\d|_20\d{6}/i;
// 被 supersede 的节点检索降权系数。不硬过滤是刻意的(抄 Zep): 贴出状态让消费方裁决,
// 而不是引擎替它决定看不见 —— 老结论在"作者追问当时为什么那么定"时仍要能被召回。
const SUPERSEDED_PENALTY = 0.4;
// project_* 到期复核: 建库日 + 30 天。僵尸项目不能靠热度衰减检出 ——
// 卡了三个月的真·在办项目热度最低但最不能忘, 机械衰减在这里反而有害, 必须显式到期。
const REVIEW_DUE_DAYS = 30;
// C5 认知刷新触发线(条修订)。拍的初值, 走配置可调 —— 见 doctor().progress 的进度显示。
const COGNITION_REFRESH_N = 100;
const HOP_DECAY = 0.45;                                  // 每跳激活衰减
const SKIP_LINK = new Set(['name', 'their_name', 'name_slug']);  // 文档示例假链接(canon 后)
// persona.md 是【身份档案】不是记忆: 它每次会话已经作为 identity 注入系统提示, 再迁成节点
// 就是同一份内容两处。而且迁进去那条的 claim 只能拿人格名去垫(「管家」/「飞飞」)—— 一个词,
// 判不了真假, 于是每个新人格一出生就先欠一笔兜底命题的账。实测老库里那条 use_count=1,
// 从没被检索用过, 1961 字符纯死重。
const SKIP_FILES = new Set(['MEMORY.md', 'archive_index.md', 'persona.md']);
const INDEX_FILE = 'memory_index.json';   // 已退役, 仅迁移时读一次(热度史的唯一来源)

const canon = (s) => (s || '').trim().toLowerCase().replace(/-/g, '_');

// —— 分词(2026-08-13 从行业版回流) ——
// 个人版原先按空白切词, 于是一整句中文/日文变成一个 term, 子串匹配几乎必然落空 ——
// 而我(和作者)恰恰全程用中文提问。行业版 08-11 就修了, 一直没回流到这边。
//
// CJK 连续串额外切 2-gram。为什么是 2: 中文的意义单元多是双字(记忆/门禁/召回/迁移),
// 1-gram 噪音大到没用, 3-gram 又会漏掉双字词。原片段一并保留 —— 整句精确命中时它多拿一份分,
// 长匹配自然排在碎片匹配前面。
const CJK_RUN = /[぀-ヿ㐀-鿿豈-﫿]+/g;
// 语义检索用的模型。定在这里(而不是散在调用方)是因为它同时是【向量的有效性标签】——
// 换模型必须整体重算, 混用两个模型的向量算余弦是纯粹的胡来, 所以模型名跟着每条向量一起入库。
const EMBED_MODEL = 'Xenova/multilingual-e5-small';
// 向量的有效性标签 = 模型名 + 文本配方。配方 d = 只喂 title+description, 不喂正文。
// 把配方也写进标签, 是为了换配方能跟换模型一样让旧向量自动整体作废重算, 不必另写迁移。
// 为什么不喂正文(2026-08-13 真库 747 节点实测): 长正文把向量拉向语料均值, 少数长节点因此变成
// "万能吸铁石" —— 同一条同时当上几个互不相干问句的语义第一名。改成只喂 description 后,
// 5 条测试问句里 3 条从 #6/#5/#14 升到 #1, 补齐耗时也从 688 秒降到 220 秒。
const VECTOR_TAG = `${EMBED_MODEL}#d`;
// 关键词与语义两路结果的融合参数(依据见 _semanticRanking 与下面 query() 的融合段)。
// RRF 的平滑常数: 业界默认 60 是给百万级检索的, 我们是千级库, C 小才放大头部排名差异。
// 164(英)和 750(中)两个规模上都是 C=10 赢。库涨到几万条时该重跑 scripts/lab-fuse.js 重标, 不是凭感觉调。
const RRF_C = 10;
// 语义那一路的话语权 = SEM_WEIGHT_GAIN × 关键词头部的「平坦度」, 见 semanticWeight()。
// 0.8 取自细网格扫描的平原中央(C=10 下 0.5–0.8 中文都零退步), 不是单点最优值 —— 挑平原中间
// 而不是最高格, 是因为样本只有 48 个查询, 尖峰多半是拟合出来的。
const SEM_WEIGHT_GAIN = 0.8;

// 关键词路对这次查询有多大把握 → 语义该有多大话语权。
// 判据是它自己的分数形状: 头部尖(第 3 名远低于第 1 名)= 它分得出高下, 语义靠边;
// 头部平 = 它自己也在猜, 让语义参与重排。
//
// 🔴 为什么不是"按语言分岔", 也不用绝对分数: 绝对分是语料属性 —— 中文走 2-gram 命中项多,
// top1 均分 50.1, 英语只有 24.0, 同一个阈值搬过去必然错。而【比值】在两种语料上方向一致:
// 答案在 top3 时 中0.63/英0.67, 不在时 中0.73/英0.80。所以这一套规则不需要知道查询是什么语言。
function semanticWeight(kwRanked) {
  const top = kwRanked[0] && kwRanked[0][1];
  if (!top) return 1;                       // 关键词全空 = 毫无把握, 语义满权
  const third = (kwRanked[2] && kwRanked[2][1]) || 0;
  const flat = Math.max(0, Math.min(1, third / top));
  return flat * SEM_WEIGHT_GAIN;
}

// Reciprocal Rank Fusion: score = Σ 1/(C + rank)。按【排名】融合而不是按分数 ——
// 两路的分数量纲本来就不可比(关键词是 rel*3+hot, 语义是余弦), 强行加权等于拍脑袋。
// 两路都靠前的条目自动升到最前, 只有一路认的排在其后。
function rrfOrder(kwIds, semIds, k, semWeight = 1) {
  const s = new Map();
  kwIds.forEach((id, i) => s.set(id, (s.get(id) || 0) + 1 / (RRF_C + i + 1)));
  semIds.forEach((id, i) => s.set(id, (s.get(id) || 0) + semWeight / (RRF_C + i + 1)));
  return [...s.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => id);
}

// —— 英文按【词】匹配, 中文按【子串】匹配 ——
// 🔴 这两者不是风格差异, 是文字系统决定的, 不能共用一套:
//   中文没有词边界, 子串匹配是必需的 —— "预约"必须能从"预约管理"里捞出来;
//   英文有空格, 同一套子串匹配就变成 bug —— can⊂cancel · art⊂start · you⊂what_you_do。
// 2026-08-17 实测的代价: 伪命中不只是多给几条结果, 它先毒死 IDF —— df 虚高 → 权重压到地板
// → disc 低 → 把握度低。于是英文正例把握度只有 0.004~0.127, 低于中文负例中位 0.299,
// 【不存在任何单一阈值能同时分开两者】。所以修的是切词, 不是阈值。
const EN_WORD = /^[a-z][a-z0-9'-]*$/;
const DOUBLE_TAIL = /([bdfglmnprt])\1$/;
// 保守词干: 只削最常见的屈折后缀, 且【削完不足 4 字符就不削】——
// 否则 thing→th · notes→not 这类会把不同的词并到一起, 比不削更糟。
const EN_RULES = [['ations', ''], ['ation', ''], ['ements', ''], ['ement', ''],
                  ['ings', ''], ['ing', ''], ['ies', 'y'], ['ied', 'y'],
                  ['ers', ''], ['ed', ''], ['es', ''], ['s', '']];
function enStem(w) {
  if (w.length < 4) return w;
  for (const [suf, rep] of EN_RULES) {
    if (!w.endsWith(suf)) continue;
    const cut = w.slice(0, w.length - suf.length) + rep;
    if (cut.length < 4) continue;                  // 削过头, 换下一条规则
    // cancelled→cancell→cancel · running→runn→run: 削完的尾部叠字母收掉,
    // 否则同一个词的两种拼法会落在两个 stem 上, 等于没归一。
    return cut.replace(DOUBLE_TAIL, '$1');
  }
  return w;
}
function isEnWord(t) { return t.length >= 3 && EN_WORD.test(t); }
// 把一段文本切成【词干集合】。英文查询才会用到它 —— 中文查询一次也不调,
// 所以中文用户零成本。
function stemSet(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().split(/[^a-z0-9']+/)) {
    if (w.length >= 3) out.add(enStem(w));
  }
  return out;
}

// 🔴 只削【首尾】标点, 不动词内部: can't · e-mail · 0.0.55 · #123 都必须原样留住。
// 从前按空白切完就直接进检索, 于是 "honestly," 带着逗号去查库 —— 全库 df=0, 而 df=0 在
// IDF 里拿的是满权 1.0(最稀有), 一个永远命中不了的词就这样以最高权重压进段覆盖的分母。
// 英文自然句每句话都带标点, 所以这条对英文是系统性的; 中文靠 CJK_RUN 另外切 gram, 受害轻。
const EDGE_PUNCT = /^[\s,.!?;:"'`(){}\[\]<>—–…、，。！？；：「」『』（）《》【】]+|[\s,.!?;:"'`(){}\[\]<>—–…、，。！？；：「」『』（）《》【】]+$/g;
function stripEdgePunct(s) { return s.replace(EDGE_PUNCT, ''); }

// 🔴 英文纯功能词一律不进检索。它们不是"权重低一点", 是**零区分度还带毒**:
// isEnWord 要求长度≥3, 所以 a / i / to / me 这些 1-2 字母的词【掉回子串匹配】——
// 实测本库 1796 条里 a 命中 1783 条(99%)、i 1740、to 723、me 701(因为 me ⊂ memory)。
// 它们给几乎每一条记忆都白送一份分子, 把所有节点的覆盖率一起抬高, 于是谁也分不出谁。
// 不靠 IDF 自动压: IDF 只压"本库常见"的词, 而英文虚词在中文为主的库里恰恰罕见 ——
// 实测 could 的 IDF 0.853、few 0.907, 几乎顶格, 方向正好反了。所以只能显式列。
// ⚠️ 只收纯功能词。list / set / type / few / options / sel / btn 这类在技术语料里是实词, 一律不收。
const EN_STOP = new Set([
  'a', 'an', 'the', 'i', 'me', 'my', 'mine', 'you', 'your', 'yours', 'we', 'our', 'us', 'it', 'its',
  'he', 'she', 'him', 'her', 'they', 'them', 'their',
  'to', 'of', 'for', 'in', 'on', 'at', 'by', 'with', 'from', 'into', 'onto', 'about',
  'and', 'or', 'but', 'so', 'if', 'then', 'than', 'as', 'not',
  'is', 'are', 'was', 'were', 'be', 'am', 'been', 'being',
  'do', 'does', 'did', 'done', 'have', 'has', 'had',
  'that', 'this', 'these', 'those', 'there', 'here',
  'please', 'just', 'honestly', 'actually', 'really', 'maybe', 'perhaps',
]);

// derived 标记谁是切出来的(CJK 2-gram)。原先只有它们参与 IDF 降权, 2026-08-13 改成【所有词都参与】——
// 理由见 _flatScores 里 idfOf 上方那段。derived 这个标记现在只剩正文兜底那一处在用(碎片不查正文)。
function tokenize(q) {
  const out = new Map();
  // seg = 这个词出自原查询的第几个词段。加它是为了让上层能按【概念】而不是按 gram 计覆盖:
  // 一个四字词切出的 3 个 2-gram 全命中, 表达的仍然只是"命中了一个概念"。
  // 纯加字段, 不改任何既有行为 —— 老消费者只读 .t / .derived。
  const put = (t, derived, seg) => { if (!out.has(t)) out.set(t, { t, derived, seg }); };
  const segs = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (let si = 0; si < segs.length; si++) {
    const seg = stripEdgePunct(segs[si]);
    if (!seg || EN_STOP.has(seg)) continue;
    // 纯数字(1-2 位)不进检索: 查询里的数字多是量词, id 里的数字是版本号/日期, 撞上纯属字形相同。
    // 3 位以上保留 —— 那是错误码/端口/年份这类强语义(409 / 3100 / 0.0.55)。
    if (!/^\d{1,2}$/.test(seg)) put(seg, false, si);
    for (const run of seg.match(CJK_RUN) || []) {
      if (run.length < 2) { put(run, false, si); continue; }
      for (let i = 0; i + 2 <= run.length; i++) put(run.slice(i, i + 2), true, si);
    }
  }
  // 去重靠 Map: 同一个 gram 在长句里会重复出现, 不去重等于给它翻倍加权。
  return [...out.values()];
}

// pinned 配额闸的判决。纯函数放在这里, 是为了让 agent.js 的闸和门禁测的是**同一份**逻辑 ——
// 从前门禁里躺着一份"复制自 agent.js"的判决副本, 那种测试挡不住 agent.js 那侧改错。
// 入参全是已 canon 化的 id。
function pinnedGate({ importance, selfId, demote, pinnedIds }) {
  if (importance !== 'pinned') return { action: 'pass' };
  const cur = pinnedIds || [];
  if (cur.includes(selfId)) return { action: 'pass' };        // 老 pinned 更新, 不占新名额
  if (cur.length < PINNED_QUOTA) return { action: 'pass' };
  if (!demote) return { action: 'block' };                    // 满了又没指定让位的 → 弹回
  if (demote === selfId) return { action: 'reject_self' };
  if (!cur.includes(demote)) return { action: 'reject_absent' };
  return { action: 'swap' };
}

// 作者 2026-08-16 钦定: 一律直接用本地时间, 不许自己算时区偏移。
// 原实现是 `Date.now() + 8*3600*1000` 写死北京时间 —— 本机在东京(UTC+9), 本地 00:00~01:00
// 之间它给出的是【昨天】。曾以"存量 888 条都按这口径写的, 改了热度排序会抖一天"为由留着,
// 已被驳回: 一天的抖动是一次性的, 一直错下去不是。
function today() { return todayLocal(); }
// 🔴 时间字段一律本地时区, 禁 UTC (作者 2026-08-15 钦定, 见 agent.js 日志时间戳同款注释)。
// toISOString() 是 UTC: 本机在东京(UTC+9), 凌晨 00:00~09:00 之间它给出的是【昨天】,
// 直接把 last_used/created 写错一天, 热度和时间线跟着错。
function todayLocal(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// 带时区偏移的完整时刻, 如 2026-08-16T21:17:34+09:00。
// 带偏移而不是裸本地串: 偏移在, 这个时刻就是无歧义的(既能还原绝对时间, 又保留了当地几点);
// 裸串换台机器读就不知道是哪个时区的 21:17。
function nowLocalISO(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();          // 分钟, 东八/东九为正
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${todayLocal(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
// §2.3 memory_append 签名头用: 系统本地时区 YYYY-MM-DD HH:MM (butler 编码约定禁 UTC).
function localTimestampShort() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// 这两个是【纯日期算术】, 不取当前时刻 —— 故意在 UTC 轴上进出(parse 'Z' → 加天 → 切 'Z'):
// 同轴进出不产生时区漂移, 且避开本地轴上跨夏令时那天 +86400000ms 不等于加一天的坑。
// 别照着"禁 UTC"把它改成本地解析, 那才会引入 bug。
function addDays(dateStr, n) {
  const t = Date.parse(dateStr + 'T00:00:00Z');
  if (isNaN(t)) return dateStr;
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}
function daysBetween(d1, d2) {
  const a = Date.parse(d1 + 'T00:00:00Z'), b = Date.parse(d2 + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}
function hotness(importance, lastUsed, useCount) {
  const imp = (importance || 'low').toLowerCase();
  const base = IMP_BASE[imp] != null ? IMP_BASE[imp] : 1.0;
  const uc = Math.max(0, useCount || 0);
  const hl = IMP_HL[imp] != null ? IMP_HL[imp] : 14;
  const d = daysBetween(lastUsed || today(), today());
  const recency = hl > 0 ? Math.exp(-d / hl) : 0;
  // use_count 从"拉长半衰期"改成"直接加分": 旧写法让常用节点几乎不衰减, 与 pinned 叠加后同分并列更严重。
  return Math.round((base + REC_W * recency + USE_W * Math.log(1 + uc)) * 1000) / 1000;
}
const hubDamp = (deg) => 1.0 / (1.0 + Math.log(1 + Math.max(0, deg || 0)));

// 别名表(§6.3): 领域同义词归一, 治"换了说法就召回不到"。
// 缺失/损坏时退回空表而不是抛错 —— 别名表只是召回增强, 不该让整个记忆引擎因为一个可选配置炸掉。
// (与 config-loader "缺失硬报错" 的哲学不同是刻意的: 那管的是提示词, 丢了行为大变; 这个丢了只是搜得差一点。)
// 路径可由宿主注入(setAliasesFile): 行业版的 config/ 布局与 butler 不同, core 不该猜自己之外的
// 目录。不注入则退回 butler 自带的那份, 所以 butler 侧零配置、行为不变。
let _aliasCache = null;
let _aliasesFile = null;
function setAliasesFile(absPath) {
  _aliasesFile = absPath || null;
  _aliasCache = null;
}
function loadAliases() {
  if (_aliasCache) return _aliasCache;
  const map = new Map();
  try {
    // 别名表属于宿主的出厂配置(两版各有各的词表), 由宿主 setAliasesFile() 递进来。
    // 没递就当没有别名 —— 检索照常跑, 只是不做同义扩展, 不该为此去猜宿主的目录布局。
    const f = _aliasesFile;
    if (!f) { _aliasCache = new Map(); return _aliasCache; }
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const group of (raw.groups || [])) {
      const set = new Set(group.map((x) => String(x).toLowerCase()));
      for (const w of set) map.set(w, set);
    }
  } catch (_) {}
  _aliasCache = map;
  return map;
}

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

module.exports = {
  canon, hotness, today, todayLocal, nowLocalISO, localTimestampShort, addDays, daysBetween,
  tokenize, pinnedGate, enStem, isEnWord, stemSet, rrfOrder, semanticWeight, hubDamp,
  setAliasesFile, loadAliases, parseFrontmatter,
  EMBED_MODEL, VECTOR_TAG, PINNED_QUOTA, PINNED_MAX_CHARS, TYPE_DEFAULT_IMP, SKIP_FILES, SKIP_LINK, INDEX_FILE,
  IMP_BASE, IMP_HL, REC_W, USE_W, SUPERSEDED_PENALTY, HOP_DECAY,
  PINNED_STALE_HINT, REVIEW_DUE_DAYS, COGNITION_REFRESH_N,
};
