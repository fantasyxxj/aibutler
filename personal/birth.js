// birth.js — 出生教育 v2 (2026-08-13 作者定案: "改成行业版一样的做法, 直接灌记忆, 加一步让它自己体验一遍能力")
//
// 老做法是 17 课串行喂: 每课显示成 user 气泡 → askOnce → 等这轮答完才喂下一课。代价两条:
//   ① 17 课 = 17 次模型调用, 新人格出生要等很久;
//   ② "学没学会"全靠课末"回我一声"的钩子 —— 它答"懂了"和它真会用, 引擎分不出来。
//
// 新做法两段:
//   ① 【灌知识】知识包 JSON 直接 upsert 成记忆节点, **零模型调用**。
//      落点是记忆图而不是一份随装机的文档, 是因为: 知识必须成为它想得起来的东西,
//      而不是一份它得先想到"去查文件"才用得上的资料。
//   ② 【跑体验】一轮之内真调一遍工具、真写一次文件, 然后引擎去查**记忆图的客观状态**来校验,
//      缺什么补提一次。2026-08-07 实测: 动作题写成"说说你打算写什么", 新生儿真的就只"说"了 ——
//      所以校验必须看图里有没有真长出东西, 不能看它嘴上怎么说。
//
// 编排(发消息/等这一轮/出气泡)留在 main.js, 这里只放不依赖会话的纯逻辑, 好让门禁真跑一遍灌注。
'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('./config-loader');
// 出生灌知识 = 空库上跑一次出厂同步。同一个函数升级时再跑一次就是覆盖 —— 所以映射、连边、
// 红线、快查这些都住在 factory-sync.js, 这里不留第二份。
const factory = require('../core/factory-sync');

const { birthVars, fillVars, bundleNames } = factory;

// 段① 灌知识: 零模型调用, 出生那一刻记忆图里就有东西。
//
// 知识包是 v2 命题格式(slug/claim/edges), 一份源。跑在 v1 引擎上时在这里下映射成
// id/description/links —— 不出第二份包, 否则两份迟早对不上。
//
// 🔴 分两趟: 先把所有节点建出来, 再连边。包里的边大量前向引用(一条命题连到它下面几行才
// 定义的那条), 一趟走边会解析不到目标而被静默丢掉。
function applyBirthKnowledge(graph, { name, extra, isButler = false, log = console.log } = {}) {
  const vars = birthVars(name);
  // v1 没有 setRedline —— 拿能力判版本比读环境变量准: 测试可以直接 new 一个 V2 进来。
  const isV2 = typeof graph.setRedline === 'function';
  const stats = { learned: 0, failed: [], ids: [], edges: 0, redlines: 0, pinned: 0 };

  if (isV2) {
    // 出生就是"空库上跑一次出厂同步"。archiveMissing 关掉: 空库没有存量可归档, 开着只是白跑一趟。
    const s = factory.syncFactory(graph, { name, isButler, archiveMissing: false, log: () => {} });
    stats.learned = s.created + s.updated + s.unchanged;
    stats.ids = s.ids;
    stats.edges = s.edges;
    stats.redlines = s.redlines;
    stats.pinned = s.pinned;
    stats.failed = s.failed.slice();
  } else {
    // v1 逃生门。知识包是 v2 命题格式(slug/claim/edges), 一份源, 这里下映射成 id/description/links。
    const manifest = cfg.json('onboarding/manifest');
    for (const b of bundleNames(manifest, isButler)) {
      let bundle;
      try { bundle = cfg.json('onboarding/knowledge/' + b); }
      catch (e) { stats.failed.push(`${b}: 读不了 — ${e.message}`); continue; }
      for (const item of (bundle.items || [])) {
        const slug = item && (item.slug || item.id);
        if (!slug) { stats.failed.push(`${b}: 有一条没有 slug`); continue; }
        const edges = Array.isArray(item.edges) ? item.edges
          : (Array.isArray(item.links) ? item.links.map((to) => ({ rel: 'relates', to })) : []);
        try {
          // origin='birth' 是 v1 的出厂标记(v2 换成 is_factory 列)。冲突体检靠它跳过"两条都还是
          // 出厂原样"的对 —— 出厂知识彼此早校对过, 且它们之间连边最密, 不跳的话新人格头几个月
          // 每周都在审自己的出厂知识。
          graph.upsert({
            id: slug,
            title: fillVars(item.title || slug, vars),
            type: item.type || 'reference',
            importance: item.importance || 'high',
            body: fillVars(item.body || '', vars),
            scope: item.scope || '',
            description: fillVars(item.claim || item.description || item.title || '', vars),
            links: edges.map((e) => e.to),
            origin: 'birth',
          });
          stats.learned += 1;
          stats.ids.push(slug);
        } catch (e) { stats.failed.push(`${slug}: ${e.message}`); }
      }
    }
  }

  // 领域也直接落成记忆: 造人时填的"它是干什么的"本来就是一句确定的话, 喂一课让它复述一遍并不会让它更懂。
  const domain = String(extra || '').trim();
  if (domain) {
    const dClaim = `我这个人格的领域是: ${domain.split('\n')[0].slice(0, 120)}`;
    try {
      graph.upsert(isV2
        // v2 的 importance 只剩 high/med/low —— pinned 是扩展表, 且作者定了「先拆开再看是不是
        // 真常用」, 出生一律不预置 pinned。
        ? { slug: 'user_my_domain', type: 'user', importance: 'high', title: `${name} 的领域`,
            claim: dClaim, keywords: '领域 职责 归谁管 定位', body: domain, is_factory: 1 }
        : { id: 'user_my_domain', type: 'user', importance: 'pinned', title: `${name} 的领域`,
            description: '我这个人格是干什么的、什么不归我管',
            body: domain, links: ['self_identity'], origin: 'birth' });
      stats.learned += 1;
      stats.ids.push('user_my_domain');
    } catch (e) { stats.failed.push(`user_my_domain: ${e.message}`); }
  }

  for (const f of stats.failed) console.error('[birth] 知识灌注:', f);
  log(`[birth] ${name} 灌知识 ${stats.learned} 条`
    + (isV2 ? ` · 边 ${stats.edges} · 红线 ${stats.redlines} · 快查 ${stats.pinned}` : '')
    + (stats.failed.length ? ` · 失败 ${stats.failed.length}` : ''));
  return stats;
}

// 出生教育的正文: **一段发完**, 动手题 + 见主人都在里面。
//
// 🔴 作者 2026-08-25 两次纠正, 合起来是一条要求:
//    ①「明明没完事, 为什么第一段就见主人?」→ 顺序必须是"三件做完再去见"
//    ②「还是两段, 合成一段, 在一段里面逻辑搞清楚」→ 但**不许靠拆消息**来实现那个顺序
//    所以顺序靠**文字**钉死(教材里写明"这三件都落地了, 才轮到最后一件"), 不靠拆成两条消息。
//    拆消息除了多一次往返、多一次等待, 并不会让模型更守序。
//    补做那一段**只在真缺项时**才发 —— 判据修好之后它应该基本不出现。
function buildExperienceText({ name, isButler = false, knowledgeCount = 0, memoryDir = '' } = {}) {
  const manifest = cfg.json('onboarding/manifest');
  // 🔴 路径要**直接给**, 不能只给文件名。2026-08-25 实测: 教材只说「把 persona.md 补上」,
  // 新人格就自己猜了个相对路径去 Read, 失败后再 Glob `**/persona.md` 找真身 —— 白费两轮。
  // 位置本来就在 self_identity 里(绝对路径, 逐字正确), 但它没查就动手了。
  // ⟹ 与其指望它先查, 不如在提到文件的那一句里就把路径写死。
  const vars = { ...birthVars(name), personaMdPath: memoryDir ? path.join(memoryDir, 'persona.md') : 'persona.md' };
  const tailKey = isButler ? manifest.experience_tail_butler : manifest.experience_tail_leaf;
  // 🔴 renderL 不是 render: 出生教育以对话形式显示在聊天窗里, 用户第一眼就读到 → 跟界面语言走。
  // 唤醒正文里那些只有模型读得到的段落仍是英文单份, 两者别混。
  return cfg.renderL('onboarding/' + manifest.experience, { ...vars, knowledgeCount })
       + '\n' + cfg.renderL('onboarding/' + tailKey, vars);
}

function buildRetryText({ name, missing = [] } = {}) {
  const manifest = cfg.json('onboarding/manifest');
  return cfg.renderL('onboarding/' + manifest.experience_retry, { name, missing: missing.join('\n') });
}

// 体验前后各拍一张记忆图的快照。三个量各对一个动作, 量的都是"图里有没有真长出东西", 不看它说了什么。
//
// 🔴 `touched` **不能**数"use_count>1 的条数": 出厂知识灌进来时 seed_use_count 就是 1~4,
// 一出生就有 129/165 条 >1。人格再 touch 一条本来就 >1 的, 这个计数纹丝不动 → 必然误报
// "还没 touch" → 必然多补发一段。2026-08-25 实测就栽在这, 白跑一轮真机测试。
// 改成记下每条的 use_count, 事后看**有没有哪条涨了** —— touch 一条老节点必然让它 +1,
// 而新建节点不影响老节点, 两个判据互不串味。
function birthSnapshot(graph, memoryDir) {
  const snap = { nodes: 0, uses: new Map(), mdBytes: 0 };
  try {
    const rows = graph.hot(9999);
    snap.nodes = rows.length;
    for (const m of rows) snap.uses.set(m.slug || m.id, m.use_count || 1);
  } catch (_) {}
  try { snap.mdBytes = fs.statSync(path.join(memoryDir, 'MEMORY.md')).size; } catch (_) {}
  return snap;
}

// 有没有哪条节点被强化过。两条通路都算:
//   ① 出生前就存在的某条 use_count 涨了 —— 人格 touch 出厂知识, 这是最常见的形状;
//   ② 这一轮新建的某条 use_count 已经 >1 —— 它沉了自己那条又顺手 touch 了。
// ⚠️ 只认 ① 会漏掉 ②(新节点不在 before 里, 怎么涨都看不见); 只认"use_count>1 的条数"
//    则会被出厂 seed_use_count 淹掉(129/165 一出生就 >1) —— 那正是 2026-08-25 白跑一轮的坑。
function anyTouched(before, after) {
  for (const [k, v] of before.uses) {
    if ((after.uses.get(k) || 0) > v) return true;
  }
  for (const [k, v] of after.uses) {
    if (!before.uses.has(k) && v > 1) return true;
  }
  return false;
}

// 缺什么就说什么, 不缺就一句都不多说。文案正向 —— 说的是"这件事还没落地", 不是"你没做到"。
function verifyBirthExperience(before, after) {
  const missing = [];
  if (after.nodes <= before.nodes) {
    missing.push('- **Your own first memory has not been saved yet** (the last step of item ①) — `memory_upsert` a node that belongs to you; what it says and what id it gets are both yours to decide.');
  }
  if (!anyTouched(before, after)) {
    missing.push('- **No memory has been reinforced by you yet** (the touch step in item ①) — the one that genuinely just helped you work something out, `memory_touch` it.');
  }
  if (after.mdBytes <= before.mdBytes) {
    missing.push('- **The "🔥 Current task" section of `MEMORY.md` is still the factory placeholder** (item ②) — that section is already in the file, you do not need to create it; use Edit to replace the `(empty for now)` under it with your real state right now.');
  }
  return missing;
}

// 出生完成标记: 记忆目录下 .birth.json { state: 'pending'|'done', retries, learned, isButler, error, at }。
// 体验环节开跑前写 pending, 正常收尾(或用户按停)写 done, 模型报错就留 pending 等补跑。
// 🔴 没有这个文件 = 老人格(标记出现之前出生的), 当已完成 —— 否则升级后所有老人格都会重新上一遍课。
const BIRTH_FILE = '.birth.json';
const MAX_BIRTH_RETRIES = 3;   // 自动补跑封顶: key 一直没修时, 不必每次打开都对着坏模型撞一次

function readBirthState(memoryDir) {
  try { return JSON.parse(fs.readFileSync(path.join(memoryDir, BIRTH_FILE), 'utf8')); } catch (_) { return null; }
}

function writeBirthState(memoryDir, patch) {
  const next = { ...(readBirthState(memoryDir) || {}), ...patch, at: new Date().toISOString() };
  try { fs.writeFileSync(path.join(memoryDir, BIRTH_FILE), JSON.stringify(next, null, 2)); }
  catch (e) { console.error('[birth] 写出生标记失败:', e && e.message); }
  return next;
}

// 还欠一次体验环节、且没到补跑上限
function birthNeedsRetry(memoryDir) {
  const st = readBirthState(memoryDir);
  return !!st && st.state === 'pending' && (Number(st.retries) || 0) < MAX_BIRTH_RETRIES;
}

module.exports = {
  birthVars, fillVars, bundleNames,
  applyBirthKnowledge, buildExperienceText, buildRetryText,
  birthSnapshot, verifyBirthExperience,
  readBirthState, writeBirthState, birthNeedsRetry, MAX_BIRTH_RETRIES,
};
