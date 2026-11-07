// factory-sync.js — 出厂知识同步 (2026-08-17 作者定案: "升级带的不是 md, 是出厂数据; butler 程序去执行覆盖")
//
// 病根: 出生教育早就改成"知识包直接灌进记忆图"了, 升级补课却还停在"把 <版本>.md 拼进唤醒正文"。
// 一份散文两个受众(人 + AI), 而且是**一次性**的 —— 读完随上下文丢掉, 三天后人格不记得这版
// 加了什么, 图里也查不到; 跨版还会撞上 MAX_TOTAL 截断, 截了照样打戳, 丢了永远补不回。
//
// 治法: 出生和升级走同一条路 —— 出厂知识包就是【当前版本出厂知识的全量】, 落库时按 slug 比对:
//   出生 = 空库上跑一次同步; 升级 = 同一个函数再跑一次, 差异自然被算出来。
// 所以不需要"每版一个增量包", 也不需要 superseded 状态机 —— 新的直接覆盖旧的就是退役。
//
// 🔴 为什么覆盖是无损的(作者 2026-08-17): 出厂知识描述的是**引擎当下的客观能力**, 不是人格的经验。
// butler 不升级, 人格把这组记忆改成什么样都不改变引擎行为。人格的经验长在自生组(is_factory=0),
// 那组引擎永不碰 —— 隔离靠这个字段, 不靠 slug 长什么样。
//
// 为什么不给出厂 slug 加 `factory_` 前缀(我一度打算这么做): 已装机人格库里的出厂节点 slug 是
// `feedback_sink_criterion_...` 这种无前缀名, 改前缀会让同一条知识变成两条(旧的留下、新的另建),
// 而且人格正文里的 [[引用]] 会全部断掉。is_factory 已经存在、已经在灌、已经接了冲突体检, 够用。
'use strict';

const { cfg, paths } = require('./host');
// 库里存的 slug 是 canon 过的(小写 + 连字符转下划线)。同步器的清单必须与库同域, 否则包里
// 写成 Feedback-Foo 时: 建节点存成 feedback_foo, 而 seen 里记的是原文 → 归档那趟认不出它,
// 刚写进去的节点当场被自己归档。
const { canon } = require('./memory');
// 译文的字段清单只有一份真源, 在引擎的语言机制里 —— 同步器跟着它走, 不另开一张表。
const { TR_FIELDS } = require('./memory-v2/lang');

// 人格独有、不由知识包管辖的出厂节点。它是造人时填的"领域", 每个人格都不一样,
// 不在任何知识包的清单里 —— 不豁免的话第一次升级就会被当成"这版删掉的"归档掉。
const NOT_IN_BUNDLES = new Set(['user_my_domain']);

// 修订史里的作者。人格自己改的写它自己的名, 出厂同步写这个 —— 翻历史时一眼看得出
// "这条是升级覆盖的"还是"人格自己动的"。
const FACTORY_ACTOR = 'factory-sync';

// 出厂包管辖的字段。同步时这些一律以包为准(包里没写的传空串, 真清空),
// 其余字段(status/use_count/last_used/created)不归包管: 热度是人格自己用出来的。
// translations/body_i18n 进 OWNED 是"换语言零迁移"的全部机制: 译文包与原包同 slug,
// 于是走的是"就地覆盖"那条分支 —— 数字主键不变, 边、热度、history 一条不掉。
const OWNED = ['title', 'claim', 'keywords', 'translations', 'body', 'body_i18n',
               'type', 'importance', 'scope'];

// 知识包里可用的变量。手册已废(知识全进记忆), 所以只剩人格名。
function birthVars(name) {
  return { name };
}

function fillVars(str, vars) {
  let v = String(str == null ? '' : str);
  for (const [k, val] of Object.entries(vars)) v = v.replaceAll('{{' + k + '}}', String(val ?? ''));
  return v;
}

// 译文落库前序列化成 JSON 字符串。两条讲究:
//   ① 键要排序 —— 存的是字符串, contentChanged 也按字符串比, 键序一变就假装"内容变了";
//   ② 变量在【叶子字符串】上替换, 不在序列化之后的整串上 —— 人格名里出现引号会撑坏 JSON。
// 包里没写译文就落空串(不是 '{}'), 这样没翻译的节点两边都是 '', 永远判不出"变了"。
function packI18n(raw, vars, leafFields) {
  if (!raw || typeof raw !== 'object') return '';
  const out = {};
  for (const lang of Object.keys(raw).sort()) {
    const v = raw[lang];
    if (leafFields === null) {                       // body_i18n: 一语一段纯文本
      if (typeof v === 'string' && v) out[lang] = fillVars(v, vars);
      continue;
    }
    if (!v || typeof v !== 'object') continue;
    const one = {};
    for (const f of leafFields) if (v[f]) one[f] = fillVars(v[f], vars);
    if (Object.keys(one).length) out[lang] = one;
  }
  return Object.keys(out).length ? JSON.stringify(out) : '';
}

function bundleNames(manifest, isButler) {
  return [...(manifest.knowledge || []), ...(isButler ? (manifest.knowledge_butler || []) : [])];
}

/* 出厂知识的两个来源: 配置层的包 + **装着的行业包自己带的**。
   行业包的知识以前没有路进记忆库, 唯一的出口是 overlay —— 那是每轮全量付费的常驻提示语,
   而且常驻随装包数线性增长。packs 由调用方传进来(core 引不到 industry 的包目录),
   形状就是 pack-loader 吐出来的那个对象, 认里面的 `knowledge` 字段。
   读不出来的记进 failed 不静默跳过: 少一个包就是少一批知识, 而少了的那批 AI 不会知道自己缺。 */
function allBundles(isButler, packs = []) {
  const manifest = cfg.json('onboarding/manifest');
  const out = [];
  const failed = [];
  for (const b of bundleNames(manifest, isButler)) {
    try { out.push({ name: b, bundle: cfg.json('onboarding/knowledge/' + b) }); }
    catch (e) { failed.push(`${b}: 读不了 — ${e.message}`); }
  }
  for (const p of (packs || [])) {
    if (!p || !p.knowledge) continue;
    // 下发包带的 bundle 与配置层那份同名时(核心记忆的下发副本 pack.core, 其 bundle_id 就是
    // leaf_core)**替换而不是追加** —— 两份是同一批知识的新旧两版。都留着的话每条要处理两遍,
    // 同步日志的计数凭空翻倍; 而且谁说了算取决于数组顺序这种看不见的东西。下发那份更新, 它赢。
    const dup = out.findIndex((e) => e.bundle && e.bundle.bundle_id
                                     && e.bundle.bundle_id === p.knowledge.bundle_id);
    const entry = { name: `pack:${p.id}`, bundle: p.knowledge };
    if (dup >= 0) out[dup] = entry; else out.push(entry);
  }
  return { bundles: out, failed };
}

// 一条知识包 item → 节点字段。出生和升级共用这一份映射, 不出第二份。
function itemToNode(item, vars) {
  const raw = item && (item.slug || item.id);
  if (!raw) return null;
  const node = { slug: canon(raw), is_factory: 1 };
  node.title = fillVars(item.title || slug, vars);
  node.claim = fillVars(item.claim || item.description || item.title || '', vars);
  node.keywords = fillVars(item.keywords || '', vars);
  node.body = fillVars(item.body || '', vars);
  node.translations = packI18n(item.translations, vars, TR_FIELDS);
  node.body_i18n = packI18n(item.body_i18n, vars, null);
  node.type = item.type || 'reference';
  node.importance = item.importance || 'high';
  node.scope = item.scope || '';
  return node;
}

// 读齐这个人格该有的全部出厂条目(通用包 + butler 专属包)。
function loadFactoryItems({ isButler = false, packs = [] } = {}) {
  const { bundles, failed } = allBundles(isButler, packs);
  const items = [];
  for (const { name, bundle } of bundles) {
    for (const item of (bundle.items || [])) {
      if (!(item && (item.slug || item.id))) { failed.push(`${name}: 有一条没有 slug`); continue; }
      items.push({ item, bundle: bundle.bundle_id || name, version: bundle.version || '?' });
    }
  }
  return { items, failed };
}

// 出厂包也能带"升级后人格该对自己做什么"。跟知识 items 同一份包、同一条通道 ——
// 下一版想派新活(整理什么、重认什么)只改包不改代码, 这正是这层存在的理由。
// key 由包作者写死并自带版本(如 tidy_pinned@0.0.58): 幂等落在 key 上, 重开机不重派。
function loadFactoryChores({ isButler = false, packs = [] } = {}) {
  const out = [];
  for (const { bundle } of allBundles(isButler, packs).bundles) {
    for (const c of (bundle.chores || [])) {
      if (c && c.key && c.title) out.push({ key: c.key, title: c.title, detail: c.detail || '' });
    }
  }
  return out;
}

function contentChanged(prev, next) {
  return OWNED.some((f) => String(prev[f] == null ? '' : prev[f]) !== String(next[f] == null ? '' : next[f]));
}

// 边只在真变了才写。原先这里是无条件 graph.upsert({slug, edges}), 两处代价:
//   ① 145 个节点 = 145 次写事务 ≈ 7 秒, 而且整段落在主窗口出来【之前】(实测 mac 2 个人格 15 秒);
//   ② upsert 自带 auto-touch, 于是每次开机把全部出厂节点的 use_count 集体 +1 ——
//      正是第一趟那道守卫写着要防的事(热度排序被出厂知识淹掉), 同一个判断只修了第一趟。
// 不能简单跟着 created/updated 走: 边不在 OWNED 里, contentChanged 判不出"只改了边"的新版包,
// 那样会静默漏同步。所以老老实实比一遍库里现有的边, 一致就一个字都不写。
function syncEdges(graph, slug, edges) {
  const nid = graph.resolve(slug);
  if (!nid) return;
  const byRel = new Map();
  for (const e of edges) {
    if (!e || !e.to) continue;
    const dst = graph.resolve(e.to);
    if (!dst || dst === nid) continue;
    const rel = e.rel || 'relates';
    if (!byRel.has(rel)) byRel.set(rel, []);
    byRel.get(rel).push(dst);
  }
  if (!byRel.size) return;
  const have = graph.store.edgesOf(nid);
  for (const [rel, dsts] of byRel) {
    // 只跟【人写的同类边】比。引擎自己长出来的 co_used 不归出厂包管, 混进来比会恒判"变了"。
    const cur = new Set(have.filter((e) => e.src === nid && e.rel === rel && e.made_by === 'human').map((e) => e.dst));
    const want = new Set(dsts);
    if (cur.size === want.size && [...want].every((d) => cur.has(d))) continue;
    graph.store.replaceEdges(nid, dsts, rel, 'human');
  }
}

// 出厂知识同步。空库上跑 = 出生灌知识; 装过的库上跑 = 升级覆盖。同一个函数。
//
// 三条分支, 判据只看 is_factory:
//   slug 不存在            → 新建(is_factory=1)
//   存在且 is_factory=1    → 这是旧版出厂知识, 以包为准整体覆盖(内容真变了才写)
//   存在且 is_factory=0    → 人格自己长出来的占了这个名, **跳过**并报告。出厂 slug 是我们自己
//                            写死的可控清单, 撞上说明命名撞车, 该由开发方改包, 不该运行时抢名。
//
// 🔴 分两趟: 先建全部节点再连边。包里的边大量前向引用(一条命题连到下面几行才定义的那条),
// 一趟走边会解析不到目标而被静默丢掉。
function syncFactory(graph, { name, isButler = false, archiveMissing = true, packs = [],
                             items: override = null, log = console.log } = {}) {
  const vars = birthVars(name);
  // 变动明细而不只是计数: 升级后要在唤醒正文里点名"你这几条出厂知识变了", 光给数字没法查。
  // changes 是同一份差异的另一种投影: slug 给唤醒正文点名(AI 要拿它去 memory_query),
  // title/claim 给用户侧更新说明渲染 HTML。两边同源, 说明和真灌进去的东西不可能对不上。
  const stats = { created: 0, updated: 0, unchanged: 0, skipped: [], archived: 0, renamed: 0,
                  createdSlugs: [], updatedSlugs: [], archivedSlugs: [], renamedSlugs: [], changes: [],
                  failed: [], ids: [], edges: 0, redlines: 0, pinned: 0, pinnedBlocked: [],
                  reclaimed: [] };
  // override 是给测试用的"假装这是新版包"入口 —— 真跑升级时差异来自装机包本身。
  const { items, failed } = override
    ? { items: override.map((i) => ({ item: i, bundle: 'inline', version: 'test' })), failed: [] }
    : loadFactoryItems({ isButler, packs });
  stats.failed.push(...failed);

  const before = new Map();
  for (const n of graph.store.factoryNodes()) before.set(n.slug, n);
  const seen = new Set();
  const pending = [];

  for (const { item, bundle, version } of items) {
    const node = itemToNode(item, vars);
    if (!node) continue;
    seen.add(node.slug);
    // 包里带 renamed_from = 这条对老库来说是同一条知识换了个名字, 不是新增。
    // 不认这个标记就会裂成两条: 新名从零建(热度归零), 旧名被下面的 archiveMissing 退役,
    // 而别人正文里的 [[旧名]] 全指向那条退役节点。改名只换别名, 热度/边/history 都留着。
    const renamedFrom = item.renamed_from ? canon(item.renamed_from) : null;
    if (renamedFrom && !graph.store.nodeBySlug(node.slug)) {
      const old = graph.store.nodeBySlug(renamedFrom);
      // 只改出厂节点。同名的人格自生记忆不碰 —— 那是它自己的经验, 与这条出厂知识无关。
      if (old && old.is_factory) {
        const r = graph.renameSlug(renamedFrom, node.slug);
        if (r.renamed) {
          stats.renamed += 1;
          stats.renamedSlugs.push(`${renamedFrom} → ${node.slug}`);
          // before 的 key 是 slug: 跟着改, 否则下面拿不到旧内容比对(会恒判"变了"),
          // 且旧 key 留着会被 archiveMissing 当成"这版删掉的条目"去归档一条已经不存在的 slug。
          const b = before.get(renamedFrom);
          if (b) { before.set(node.slug, b); before.delete(renamedFrom); }
        }
      }
    }
    const prev = graph.store.nodeBySlug(node.slug);
    // 名字被人格自己的记忆占了 —— 不抢。抢了等于拿出厂原文冲掉它自己的经验。
    //
    // 但"没打 is_factory"不等于"人格写的": 早期灌库路径建节点时压根没打这个标(餐饮那批 61 条
    // 的 history actor 是 'education'), 于是每次升级都让位给它自己, 内容永久冻在初版 —— 发出去
    // 的知识包对这些 slug 完全无效, 而日志只说"让位自生 N", 看着像正常保护。判据改成看历史:
    // 这个人格本人写过才算它的经验; 从没写过就是灌库时漏了标, 认领回来。
    if (prev && !prev.is_factory) {
      if (graph.store.historyOf(prev.id, 200).some((h) => h.actor === name)) {
        stats.skipped.push(node.slug); continue;
      }
      graph.upsert({ slug: node.slug, is_factory: 1, actor: FACTORY_ACTOR });
      prev.is_factory = 1;
      stats.reclaimed.push(node.slug);
    }
    try {
      if (!prev) {
        // 🔴 force: 出厂包整批灌入不吃体积闸。那道闸治的是"人格自己写记忆时啰嗦", 而出厂包的
        // 内容是【设计】出来的 —— 它该在设计时受约束, 不该在灌入时被拒: 拒了就是新人格出生失败。
        // 约束改由门禁承担 —— test-onboarding.js 断言超闸条目必须在存量豁免名单里, 不许新增。
        graph.upsert({ ...node, seed_use_count: item.seed_use_count, actor: FACTORY_ACTOR, force: true });
        stats.created += 1;
        stats.createdSlugs.push(node.slug);
        stats.changes.push({ kind: 'added', slug: node.slug, title: node.title, claim: node.claim });
      // 🔴 比对必须拿 before 里那份: nodeBySlug 走 NODE_COLS, 出于"常驻内存正比于节点数"的
      // 尺度约束【不返回 body】。拿它比 body 会恒判"变了", 于是每次开机都在假装升级。
      } else if (contentChanged(before.get(node.slug) || prev, node)) {
        // force_overwrite: 拿装机包原文冲掉旧版出厂正文是这里的本职。上面 170 行已经保证
        // 只碰 is_factory 的节点, 人格自己写的一律 skip —— base_hash 那道闸防的不是这个。
        // force 与 force_overwrite 是两道闸: 前者解体积, 后者解 base_hash。升级要两道都解 ——
        // 拿装机包原文冲掉旧版出厂正文正是这里的本职。
        graph.upsert({ ...node, actor: FACTORY_ACTOR, force_overwrite: true, force: true });
        stats.updated += 1;
        stats.updatedSlugs.push(node.slug);
        stats.changes.push({ kind: 'changed', slug: node.slug, title: node.title, claim: node.claim });
      } else {
        // 没变就不写。全量 upsert 会让 auto-touch 把 use_count 集体 +1, 热度排序被出厂知识淹掉。
        stats.unchanged += 1;
      }
      stats.ids.push(node.slug);
      pending.push({ slug: node.slug, item });
    } catch (e) { stats.failed.push(`${node.slug}: ${e.message}`); }
  }

  // 这版删掉的出厂条目: 标 archived 不删。删是不可逆的, 而"某条出厂知识被新版拿掉"本身罕见 ——
  // 万一是包写漏了, archived 还能翻回来, 删了就没了。检索默认只看 active, 所以效果等同于退役。
  //
  // 🔴 有包没读进来就整轮不归档: 判据是"这版包里没有了", 而包压根没加载时这个判据不成立 ——
  // 照归档等于把那个包的知识整批退役, 而且是在读包已经报错的那一刻顺手做的。
  if (archiveMissing && failed.length) {
    log(`[factory] 有 ${failed.length} 个包没读进来, 本轮不归档(判据不成立)`);
  } else if (archiveMissing) {
    for (const [slug, n] of before) {
      if (seen.has(slug) || NOT_IN_BUNDLES.has(slug) || n.status === 'archived') continue;
      try {
        graph.upsert({ slug, status: 'archived', actor: FACTORY_ACTOR });
        stats.archived += 1;
        stats.archivedSlugs.push(slug);
        stats.changes.push({ kind: 'removed', slug, title: n.title, claim: n.claim });
      }
      catch (e) { stats.failed.push(`${slug} 归档: ${e.message}`); }
    }
  }

  // 第二趟: 连有向类型边 + 挂红线 + 快查。节点此时全在库里, 前向引用才解析得到。
  for (const p of pending) {
    const item = p.item;
    const edges = Array.isArray(item.edges) ? item.edges
      : (Array.isArray(item.links) ? item.links.map((to) => ({ rel: 'relates', to })) : []);
    if (edges.length) {
      try { syncEdges(graph, p.slug, edges); stats.edges += edges.length; }
      catch (e) { stats.failed.push(`${p.slug} 连边: ${e.message}`); }
    }
    // `redline: {off: true}` 收回出厂时立过的红线 —— 包里光删掉 redline 字段, 装机端那条照旧拦人。
    if (item.redline && item.redline.off) {
      try { const id = graph.resolve(p.slug); if (id) graph.store.unsetRedline(id); }
      catch (e) { stats.failed.push(`${p.slug} 撤红线: ${e.message}`); }
    } else if (item.redline) {
      try { graph.setRedline(p.slug, item.redline); stats.redlines += 1; }
      catch (e) { stats.failed.push(`${p.slug} 红线: ${e.message}`); }
    }
    if (item.pinned) {
      // 🔴 撞配额单列, 不混进 failed。老用户升级时这几乎必然发生(老库 pinned 早就超标),
      // 而它跟"写坏了"是两回事: 命题本身已经进库了, 只是没抢到快查名额。混在 failed 里
      // 就只剩一行 stdout, 谁也不会发现新版本的快查条目被老存量顶掉了。
      try { graph.setPinned(p.slug, item.pinned.reason || '出生预置'); stats.pinned += 1; }
      catch (e) { stats.pinnedBlocked.push({ slug: p.slug, title: p.title || '', reason: e.message }); }
    }
  }

  for (const f of stats.failed) console.error('[factory] 出厂同步:', f);
  for (const s of stats.skipped) console.error(`[factory] slug 被人格自生记忆占用, 跳过: ${s}`);
  for (const b of stats.pinnedBlocked) console.error(`[factory] 这条只进了库没进快查表: ${b.slug} —— ${String(b.reason).split('\n')[0]}`);
  return stats;
}

// 有没有实质变化 —— 决定升级后要不要在唤醒正文里说一句。
function hasChanges(stats) {
  return !!(stats && (stats.created || stats.updated || stats.archived || stats.renamed));
}

module.exports = { birthVars, fillVars, bundleNames, itemToNode, loadFactoryItems,
                   loadFactoryChores, syncFactory, hasChanges, NOT_IN_BUNDLES, OWNED };
