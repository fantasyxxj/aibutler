// memory-tools-v2.js — 记忆 MCP 工具的 v2 版, 集中一处。
// 常用六件独立注册, 冷门十七件并进 memory_admin(op, args) —— 分法的依据见文件末尾 OPS 上方。
//
// 为什么单开一个模块而不是就地改 agent.js 里那 500 行:
//   · v1 路径一行不改 = 零回归风险, dev 没测通之前生产照常跑(#18 是硬闸门)
//   · v2 工具集中一处便于逐个核对 —— 作者要的是"一个一个做一个一个核对"
//   · 切换只是 agent.js 里挂载哪一份的问题, 回滚也是一行
//
// 对我(AI)可见的三处语义变化, 是整个底座改造的产品意义所在:
//   1. description(摘要) → claim(命题)。摘要说"这篇讲了什么", 命题说"我主张什么"。
//      只有命题能判真假, 所以才谈得上矛盾、推翻、支持。
//   2. importance 不再有 pinned 档。pinned 是"最常查"、红线是"一旦用到必须遵守"、
//      importance 是"有多重要" —— 三个正交的维度, 从今往后各挂各的表, 配额各算各的。
//   3. 一切返回值都带 claim + slug。数字主键对人不可读, 返回值不带命题我就成了瞎子。
//
// 入参里的 id 仍收人可读的 slug(也收数字) —— 我嘴里说得出的是 slug, 库里连的是数字,
// 解析交给引擎。这样我的使用习惯不用跟着底座改。

// 引导类文案(挡门三选一 / 查不到怎么办 / 兜底段怎么用)一律走 config, 不写死在这。
// 判据: 会随观察反复调的 → config; `✅ 沉淀: #12 xxx` 那种机械回执 → 留代码里(外置只增加跳转成本)。
// 装机版改这些文案不用重新打包, 见 config-loader 的覆盖层。
const { cfg } = require('./host'); const { sectionWithGuard } = require('./memory-session-guard');

const DEFAULT_DESC = {
  // 🔴 常驻说明只写【什么时候该想起这个工具】。怎么传参、有什么坑一律不写在这儿 ——
  //    常驻是每一轮都在付钱, 而真正需要那些细节的时刻只占极少数轮。细则作为 reference_tool_*
  //    条目发在出厂知识里, 用到的那一刻按工具名 memory_query 现查。
  //    (作者 2026-09-07:「所有说明要都精炼, 不管代码给的还是哪里给的。唯一可以详细说的,
  //     只有在记忆里面」)
  memory_query: 'Reach for this first — prior knowledge, past mistakes, an established position. Each hit carries its claim, so you know what a node asserts without opening it.',
  memory_upsert: 'Learned something you did not already know → store it now as one falsifiable claim. Shape, dedupe gate and id naming: memory_query "memory_upsert".',
  memory_section: 'Read a node\'s full body, and the base_hash you need before editing it: memory_query "memory_section".',
  memory_write: 'Edit the body of a memory node in place (not a file: MEMORY.md / persona.md are files, use Edit). It may only shrink, never grow: memory_query "memory_write".',
  memory_touch: 'You actually relied on a memory to decide or answer. Skimming does not count.',
  memory_hot: 'What has been active lately. Use it when memory_query cannot find the words — not as a wake-up ritual.',
  // 冷门的十七件并成一把。每件的参数表由工具自己在报错里给, 细则 memory_query "memory_admin"。
  // 🔴 十七个 op 必须逐个点名, 不许用「weeding/pinning/…」这类概括词打包 —— 这不是一个工具,
  //    是十七个工具共用一个入口。合并前每个工具名天天摆在工具面上, 光是那个名字就够让人格
  //    想起"还有这回事"(memory_doctor → 体检, checkup-gate.js 整套戳人机制的前提正是这句);
  //    并进 op 之后名字消失, 概括词替代不了。op 名本身就是触发条件, 不是参数细则, 所以列在
  //    这里合规且必要; 每个 op 的用法另有 reference_tool_memory_admin_<op> 出厂条目。
  memory_admin: 'Eighteen ops on the memory store itself; pass op alone to get its params. doctor = health checkup on the store · ack_problem = stop doctor reporting one kind of problem for now · conflict_scan · conflict_settle · arbitrate = record which claim wins · split · link · neighbors · timeline · revisions · pinned · set_pinned · set_importance · redlines · set_redline · semantic · chores · chore_done.',
};

// 保留这个导出名给既有调用方/测试; 真值来自 memory-tuning.json, 这里只是启动时的快照。
// 判决点用 T().pre_query_threshold 现取, 所以热改配置对挡门同样生效。
const PRE_QUERY_THRESHOLD = 200;

// 把一条检索结果渲染成给 AI 看的文本。命题占主位, slug 次之 —— 反过来就又回到
// "看 id 就下结论不查内容"的老路上了(那正是语义 id 骗过我 4 次的机制)。
// 命题判没判过真假 —— **只标 =2, 不标 =1**, 这是个刻意的取舍不是漏了:
//   =2 讨论中的临时命题, 生命周期几小时, 稀少, 且拿它当依据会当场出错 → 值得强提示
//   =1 迁移时机器垫的历史欠账, 存量 974/1450 = 67%。三分之二的结果都挂同一个标, 两天就被
//      读成背景花纹, 到那时连 =2 的强提示都跟着一起失效 —— 标记的成本是【把别的标记也稀释掉】。
//      这批改走 memory_admin(op=doctor) 分批催(一次 5 条 · 按热度 · 带补法), 那条路不占检索结果的注意力。
const provMark = (r) => (Number(r.claim_provisional) === 2 ? ' ⚠️provisional·unverified' : '');

function renderHit(r) {
  const mark = r.status === 'superseded' ? ' ⛔superseded' : '';
  const pin = r.pinned ? ' 📌' : '';
  // 🔴 中档必须当面写出"不确定"三个字, 不能只给个 0.31 让我自己悟。
  // 分档如果只体现为一个小数, 我读的时候仍然会把所有返回项一视同仁地当依据 ——
  // 那三分档就退化成了一列没人看的元数据。
  const tier = r.tier === 'med' ? ' ⚠️uncertain' : (r.tier === 'high' ? '' : ' ·weak');
  const head = `[${r.score} ${r.via}${tier}]${mark}${provMark(r)}${pin} #${r.id} ${r.slug || ''}`;
  const over = (r.overturned_by || []).length
    ? `\n    ⛔ superseded by → ${r.overturned_by.map((o) => `${o.slug}: ${o.claim}`).join(' / ')}`
    : '';
  // 🔴 锚点必须在这里露出来, 不能只躺在正文里等人去读。要核对的那一刻多一跳, 结果就是
  // 直接去 grep —— 记忆给命题而验证它要从零翻找, 两条路代价差一个数量级, 贵的那条没人走。
  const anc = r.anchors ? `\n    ↳ verify: ${r.anchors}` : '';
  // 🔴 标注在这里露出来才有用: 它要在【正要照着这条动手】那一刻提醒「这条只在那几个项目里验过」。
  // 刻意只陈述事实不下判断 —— 它是参考不是闸, 同一条结论在别的项目成立与否得当场自己判。
  const prj = r.projects ? `\n    ↳ 验于: ${r.projects}` : '';
  return `${head}\n    ${r.claim || '(no claim)'}${anc}${prj}${over}`;
}

// 兜底条目: 够不上闭嘴线, 但仍摆出来让 AI 自己判。渲染压到一行 —— 它的定位是线索不是依据,
// 占的篇幅必须明显小于正经命中, 否则读起来会和够格的条目一样重。
function renderWeak(r) {
  const mark = r.status === 'superseded' ? ' ⛔superseded' : '';
  const pin = r.pinned ? ' 📌' : '';
  return `  ○ [${r.via} ${r.confidence}]${mark}${provMark(r)}${pin} #${r.id} ${r.slug || ''} — ${r.claim || '(no claim)'}`;
}

// 兜底名额 / 默认条数 / 查重挡门线都是标定值, 统一从 memory-tuning.json 取(见 memory-v2.js)。
// 每次调用时读而不是模块加载时快照: reloadTuning() 改完要能当场生效。
// 兜底名额的意义: 多给的代价是几十 token 扫一眼, 漏掉的代价是永久丢失且我不会知道自己丢过 ——
// 代价不对称所以默认给, 但仍要封顶, 无限兜底 = 把全库倒进上下文, 那等于没有检索。
const { currentTuning } = require('./memory-v2');
const { msg } = require('./memory-v2/messages');
const { looseShape, gather } = require('./agent/flat-args');
const { getLang, langName } = require('./memory-v2/lang');
// 认原话的文字是哪门语言 —— 只用来把退回提示写成人话, 判断本身只看有没有非 ASCII 字。
const scriptName = (t) => (/[\u3040-\u30ff]/.test(t) ? 'Japanese' : /[\uac00-\ud7af]/.test(t) ? 'Korean'
  : /[\u4e00-\u9fff]/.test(t) ? 'Chinese' : 'their language');
const T = () => currentTuning();
// 记忆写法辅导开关(main/memory_coaching.json): 行业版关掉, 店小二会把辅导当成店主的话回给店主。
// 出厂节点不让人格写: factory-sync 对 is_factory=1 的节点按包整条覆盖, 写进去的店主规矩下次升级就无声消失
// (10-14 dev: 「来店说生日就送甜品」被写进了出厂的纪念日 SOP)。只堵 AI 的两个写口, factory-sync / birth 直调图不受影响。
const isFactory = (g, ref) => { const id = g.resolve(ref); const m = id && g.store.node(id); return !!(m && m.is_factory); };
const coachingOn = () => { try { return cfg.json('main/memory_coaching').enabled !== false; } catch (_) { return true; } };

function registerMemoryToolsV2({ tool, z, graph, descriptions = {}, onHit = () => {}, agent = null }) {
  const D = { ...DEFAULT_DESC, ...descriptions };
  const G = () => (typeof graph === 'function' ? graph() : graph);
  const txt = (s) => ({ content: [{ type: 'text', text: s }] });
  const splitIds = (s) => (s ? s.split(/[\s,、]+/).filter(Boolean) : undefined);
  // 閂で差し戻された保存を回合ごとに控える。差し戻しのあと書き直さずに「記録しました」と答えて終わる
  // (10-14 新生 dev: 常連の規則が関連付けの閂で 2 回戻され、そのまま未保存)。回合末に wake.js が拾って次の回合で追う。
  const trackUnsaved = (fn) => async (a) => {
    const res = await fn(a);
    if (agent && a && a.id) {
      const t = (res && res.content && res.content[0] && res.content[0].text) || '';
      if (!agent._turnUnsaved || agent._turnUnsaved.seq !== agent._turnSeq) agent._turnUnsaved = { seq: agent._turnSeq, ids: new Map() };
      if (/saved to memory/.test(t)) agent._turnUnsaved.ids.delete(a.id);
      else if (/^⚠️/.test(t)) agent._turnUnsaved.ids.set(a.id, a.claim || '');
    }
    return res;
  };

  const memQuery = tool('memory_query', D.memory_query,
    { query: z.string().describe('keywords, space-separated'),
      k: z.number().optional().describe('number of results (default 8)'),
      hops: z.number().optional().describe('graph diffusion hops (default 2; 0 = flat only)') },
    async ({ query, k, hops }) => {
      const g = G();
      const flat = hops === 0;
      // 语义层: 查询向量先算好(跨进程跑 wasm), 同步主路才吃得到。算不出就静默降级成纯关键词 ——
      // 语义是增强不是前置条件, 缺了不该让检索失败。
      const release = g.prepareSemantic ? await g.prepareSemantic(query) : () => {};
      const { default_k: DK, fallback_max: FALLBACK_MAX } = T();
      const K = k || DK;
      let all;
      // 🔴 minTier:'low' = 让引擎把够不上闭嘴线的也交出来, 分层由这一层做。
      // 理由不是"多给点保险": ①代价不对称 —— 漏检永久且我不会知道自己丢过, 误检只是扫一眼
      // ②检索是多轮的, 兜底条目的价值不止"它可能是答案", 更是"下一次该换什么词查"的线索。
      // 敢这么做的前提是 v2 返回值带 claim/tier/via —— v1 只有 id+分数, 那时多给纯属噪音。
      try { all = g.query(query, { k: K + FALLBACK_MAX, hops: hops == null ? 2 : hops, flat, minTier: 'low' }); }
      finally { release(); }
      // 名额在这里重分配, 不能让引擎按分数一路切到 K —— 把握度序和绝对分序不是同一个序,
      // 低档条目会挤掉够格的。够格的先占满 K, 兜底另开预算。
      // 记下这一轮查出过哪些节点 —— 新建记忆的 links 要从这里挑(见 memory_upsert 的「先查再挂」)。
      if (agent) {
        if (!agent._turnQueried || agent._turnQueried.seq !== agent._turnSeq) agent._turnQueried = { seq: agent._turnSeq, ids: new Set(), solid: [] };
        for (const r of all) agent._turnQueried.ids.add(r.id);
        for (const r of all) if (r.tier !== 'low' && r.slug && !agent._turnQueried.solid.includes(r.slug)) agent._turnQueried.solid.push(r.slug);
      }
      const solid = all.filter((r) => r.tier !== 'low').slice(0, K);
      const weak = all.filter((r) => r.tier === 'low').slice(0, FALLBACK_MAX);
      // 连兜底都空 = 是真的没有。以前这句在"够格的没有"时就说了, 而那时候库里往往是有东西的。
      const QO = cfg.json('main/memory_query_output');
      if (!solid.length && !weak.length) return txt(cfg.fill(QO.empty, { query }));
      // 只强化够格的。兜底条目是"摆出来供判断", 摆一次不等于用了 → 心法 4。
      for (const r of solid) onHit(r.id);
      const rows = solid;
      // 🔴 查询**不带疑似冲突明细**。这活体检那条路已经在干, 而且做法是对的:
      // idle-watcher 普扫后只报个数, 明细让人格自己跑 memory_admin(op='conflict_scan')
      // 取实时的。查询是热路径, 每一轮都在付这笔钱, 而真要处理冲突的只占极少数轮 ——
      // 同「工具说明只留触发条件」是一个判据。实测某人格近 200 次查询里 148 次「返回未用」,
      // 每次还要为这段付 400–800 token。
      const suspectLine = '';
      // 🔴 兜底段必须写清"怎么用", 光摆条目我会把它们和够格的一视同仁 —— 那就把分档白做了。
      // 尤其要按 via 分岔提醒: 关键词误命中(can⊂cancel)是两条风马牛不相及的记忆, 一眼分得出;
      // 语义误命中恰恰是"字面不像意思近", 似是而非才最容易被我信以为真。
      const weakLine = weak.length
        ? cfg.fill(QO.weak_head, { count: weak.length })
          + weak.map(renderWeak).join('\n')
          + QO.weak_tail
        : '';
      const head = rows.length
        ? `top-${rows.length} for "${query}":\n${rows.map(renderHit).join('\n')}`
        : cfg.fill(QO.no_solid, { query });
      return txt(`${head}${suspectLine}${weakLine}`);
    },
    // SDK 0.3.201 起 MCP 工具默认全 deferred(schema 要先 ToolSearch 才拿得到)。
    // 只有这四件常驻: query/hot/upsert/touch —— 判据是"多一跳就会导致我少做"。
    // 它们是铁律"动手前先查记忆""发现新东西就先存"的入口, 加一跳人格就会少查少沉,
    // 而这种退化不报错、没人看得见。compact_context 低频, 刻意不占名额。
    { alwaysLoad: true, searchHint: 'search memory graph' });

  const memUpsert = tool('memory_upsert', D.memory_upsert,
    { id: z.string().describe('node slug (lowercase_underscore). Updates if it exists, creates if not.'),
      title: z.string().optional(),
      // string 不用 enum: enum 填错只回一句"不在列表里", 24 次 type='task' 都没看到「待办去 task」那句(10-14 dev)
      type: z.string().optional().describe('user = who this person is (identity, preferences, habits) · feedback = a way of doing things someone taught or corrected · '
          + 'reference = a checked fact that will still be true next week · project = an in-progress state that may change by next week '
          + '(where it stands, next step, waiting on whom; needs exit_criteria, close it when done). Test: is it certainly still true next week? If not, project. A to-do is not a type here — put it on the `task` tool.'),
      importance: z.enum(['high', 'med', 'low']).optional().describe('pinned is not here — pinning (resident in every session) is memory_admin(op=set_pinned)'),
      // 🔴 claim 保持**必填**, 而且是刻意的: 改正文时被迫把命题复述一遍, 正好逼出"这次改动之后
      // 这句还准吗"那一问 —— #1433 那次(正文已被推翻而命题行仍以旧口径出现在每次检索里)就是
      // 没人问这一句造成的。自定义 error 是为了让漏传时看见的是这一问, 而不是一句类型错误。
      // ⚠️ 用 `error` 不是 `required_error`: zod v4 把后者删了, 写了不报错也不生效, 静默回落成默认文案。
      claim: z.string({ error: 'What claim are you saving? State it now — after editing the body the old claim is often no longer accurate, '
        + 'and search results only surface the claim line. It must be one falsifiable assertion that still holds when the body is deleted. '
        + 'If you only want to edit the body and leave the claim unchanged, pass the current claim back as-is.' })
        .describe('🔴 claim: one falsifiable assertion that still holds when the body is deleted — resolve every reference, '
          + 'spell out every enumeration, then cut only what that test does not need. Full criteria: memory_query "命题 判据"'),
      // 🔴 2026-10-11 行业版调教实测: 只写「会被什么词查到」时, 人格把教它那一次的例子词原样铺进去
      // (値段 田中さん 再来週の金曜), 换个说法重启后四条规则一条都查不回来。所以要点明「例子只是其中一种」。
      keywords: z.string().optional().describe('space-separated, required when creating. The words someone will say the NEXT time this applies, '
        + 'in their language AND in English (you search in either) — today\'s example is only one of them: cover at least two different situations and the verb forms '
        + '(変えたい 直したい 見直したい), plus the kind-of-task words you would search with; drop names and numbers that belong only to this one case.'),
      anchors: z.string().optional().describe('if the claim is about code/config, provide path:line here (space-separated for multiple), '
        + 'e.g. "core/index-guard.js:42". Shown alongside search results so verification is one read, '
        + 'not a fresh grep. Code moves, so this is a hint not a guarantee; search nearby if it no longer matches.'),
      // 🔴 describe 每轮全价注入(#2450), 所以只留一句定义。为什么是多值、空值什么意思,
      // 这些写在 schema 注释和记忆里, 不占每轮的钱。
      projects: z.string().optional().describe('which projects this was verified in, space-separated. Multi-value; omit if unsure.'),
      body: z.string().optional().describe('body markdown. ⚠️ passing it replaces the whole body; omit it to leave the body untouched.'),
      base_hash: z.string().optional().describe('required only to overwrite an existing body: the hash from memory_section.'),
      // 字符串而非数组: 带 z.array 的参数会让模型的 tool 入参整个丢成 {}(记忆 #1305, 88k 次普查)
      links: z.string().optional().describe('slugs of related nodes to connect, space-separated; required when creating'),
      exit_criteria: z.string().optional().describe('project_* only, and required there: what counts as done.'),
      scope: z.string().optional().describe('where this rule applies. Narrower scope wins on conflict.'),
      review_due: z.string().optional().describe('project_* only: review-by date YYYY-MM-DD'),
      provisional: z.number().optional().describe('0=verified (default) · 2=provisional. Unsure → 2, better than not storing it.'),
      status: z.enum(['active', 'superseded']).optional().describe('validity. Replacing it with a new conclusion → memory_admin(op=arbitrate), not this field; this one is for retirement with no replacement.'),
      confirm_new: z.boolean().optional().describe('confirm this is a new angle that must be created (bypasses the dedupe gate)') },
    trackUnsaved(async (a) => {
      if (a.type && !['feedback', 'reference', 'project', 'user'].includes(a.type)) {
        return txt(`⚠️ Not saved: type '${a.type}' does not exist — it is feedback / reference / project / user.`
          + (/task|todo|remind/i.test(a.type) ? ' A to-do goes on the `task` tool; something due at a time goes on `reminder`.' : ''));
      }
      const g = G();
      const exists = !!g.resolve(a.id);   // 新建必须带 keywords: 检索只看 title/claim/keywords(10-11 店小二实测)
      if (exists && isFactory(g, a.id)) return txt(cfg.render('main/memory_factory_readonly', { slug: a.id }));
      if (!exists && !(a.keywords || '').trim()) return txt(cfg.render('main/memory_keywords_required', { slug: a.id }));
      // 关键词要带一个主人那门语言的词: 检索按词面撞, 主人用日语问时一行全英文的关键词撞不上
      // (10-14 行业版 dev: 新店助手把「日曜のラストオーダー 22 時」存成纯英文, 用「ラストオーダー」查不到)。
      // 看的是**这一轮对方实际说话的字**, 界面语言只在没有原话可看时(收工 · 唤醒)兜底 —— 新装的店界面默认英文,
      // 店主照样用日语说话, 只看界面就整道放行了(10-14 dev 第 4 轮)。
      const ui = getLang();
      const said = agent && typeof agent._turnUserText === 'string' ? agent._turnUserText : '';
      const speaksNonAscii = /[^\x00-\x7F]/.test(said);
      if (!exists && (speaksNonAscii || (!said && ui && !/^en/i.test(ui))) && !/[^\x00-\x7F]/.test(a.keywords)) {
        return txt(cfg.render('main/memory_keywords_lang', { slug: a.id, lang: speaksNonAscii ? scriptName(said) : langName(ui) }));
      }
      // 作法(feedback)の命題が「態度」だけ(kind / 丁寧に…)なら差し戻して問わせる。数字・引用が入っていれば説明済みとみなす。
      if (!exists && a.type === 'feedback' && a.claim) {
        try {
          const V = cfg.json('main/memory_vague_claim');
          const heard = agent && typeof agent._turnUserText === 'string' ? agent._turnUserText.toLowerCase() : '';
          const word = (V.words || []).find((w) => (/^[a-z]/i.test(w) ? new RegExp(`\\b${w}\\b`, 'i') : new RegExp(w)).test(a.claim))
            || (V.said || []).find((w) => heard.includes(w.toLowerCase()));
          if (word && !new RegExp(V.concrete).test(a.claim)) return txt(cfg.render('main/memory_vague_claim_reject', { word }));
        } catch (_) { /* 設定が壊れても保存は止めない */ }
      }
      // 新建必须表态连到哪: 讲「怎么做」的规则跟被问的事很少同词, 只能靠连线被扩散带出来(10-11 称呼加様实测)。
      const noLinks = /^\s*none\s*$/i.test(a.links || '');
      if (!exists && !noLinks && !(a.links || '').trim()) return txt(cfg.render('main/memory_links_required', { slug: a.id }));
      // 编出来的名字会被静默丢掉, 照样零连线(10-11 实测填了个不存在的 shop_rules) —— 一条都对不上就同样退回。
      if (!exists && !noLinks && !(splitIds(a.links) || []).some((l) => g.resolve(l))) {
        return txt(`${cfg.render('main/memory_links_required', { slug: a.id })}\n\nNone of these exist in memory: ${a.links.trim()} — find real ones with memory_query.`);
      }
      // 先查再挂: 新建记忆的 links 至少一条出自本轮 memory_query 的结果。程序不判挂得对不对, 只查这一步走没走 ——
      // 10-13 行业版 dev 5 次教店规: 先查的都挂对了, 没查的直接拿召回提示行点名的通用守则或上一条店规来挂。
      // links="none" 也要查过才算数 —— 它的意思是「查了, 真没有可挂的」; 10-13 dev 被退回一次后就拿 none 跳过查询。
      if (!exists && agent) {
        // 按节点 id 比: 模型照检索结果里的 `#351` 填编号也是查来的(10-13 只认 slug 时把对的编号全退回, 它被逼成填 none)。
        const seen = (agent._turnQueried && agent._turnQueried.seq === agent._turnSeq) ? agent._turnQueried.ids : null;
        if (!seen || (!noLinks && !(splitIds(a.links) || []).some((l) => seen.has(g.resolve(l))))) {
          return txt(cfg.render('main/memory_links_from_query', { slug: a.id }));
        }
        // none = 「查了, 真没有可挂的」。查出了够格的结果还填 none, 就是拿它跳过挂接(10-14 dev 第 5 轮 7 条里 6 条这样存, 复考全没想起来)。
        const solid = agent._turnQueried.solid || [];
        if (noLinks && solid.length) {
          return txt(cfg.render('main/memory_links_none_but_found', { slug: a.id, found: solid.slice(0, 6).join(' ') }));
        }
        // 問いの答えは問いを書いた暫定エントリを書き直す。別に建てると「推測」と「答え」が両方残り、
        // 後で両方引かれる(10-14 dev: 暑い日に「値引き」入りの暫定 #494 が残ったまま #496 を新設)。
        // 判据は「暫定エントリへ繋ごうとしている」: 答えは問いに繋がれる(#496→#494)。検索に出ただけの無関係な暫定は拾わない。
        const pending = a.confirm_new ? [] : (splitIds(a.links) || []).filter((l) => {
          const m = g.resolve(l) && g.store.node(g.resolve(l)); return m && Number(m.claim_provisional) === 2 && !m.is_factory;
        });
        if (pending.length) return txt(cfg.render('main/memory_rewrite_provisional', { found: pending.slice(0, 3).join(' ') }));
      }
      // 查重挡门: 只挡新建, 老节点直接落。只看扁平直接命中 top-1(图跳不算重复)。
      if (!a.confirm_new && !exists) {
        const q = `${a.title || ''} ${a.claim || ''} ${a.keywords || ''}`.trim();
        // 🔴 minTier:'low' = 查重这一路【不过分档】。它有自己的判据(PRE_QUERY_THRESHOLD 绝对分),
        // 两套闸叠加的话, 一条真重复的老节点会因为把握度不够而被悄悄滤掉, 挡门就静默失效了。
        const hits = q ? g.query(q, { k: 3, flat: true, semantic: false, minTier: 'low', kind: 'dedupe' }) : [];
        const top = hits.length ? hits[0].score : 0;
        const gate = T().pre_query_threshold;
        if (top > gate) {
          return txt(cfg.render('main/memory_dedupe_gate', {
            top, gate, slug: hits[0].slug,
            candidates: hits.map((h, i) => `${i + 1}. [${h.score}] ${h.slug}\n   ${h.claim}`).join('\n\n'),
          }));
        }
      }
      // 🔴 force_overwrite 刻意不暴露成工具参数: 给了口子, 被闸拦下时就会直接绕过去, 闸即废。
      // AI 永远有正路(memory_section 读一遍); 那开关只留给程序调用方(factory-sync/知识包下发)。
      const r = g.upsert({ slug: a.id, title: a.title, type: a.type, importance: a.importance,
        claim: a.claim, keywords: a.keywords, anchors: a.anchors, projects: a.projects, body: a.body,
        base_hash: a.base_hash, links: noLinks ? undefined : splitIds(a.links),
        exit_criteria: a.exit_criteria, scope: a.scope, review_due: a.review_due,
        provisional: a.provisional, status: a.status });
      // 改一个老节点就是用上了它 —— 复核作业里我反复"查出来 → 改它的 claim", 全程不 touch,
      // 于是成绩单把一整轮有效检索记成了失败。只对更新记功, 新建没有前置召回可归。
      if (!r.is_new) { try { g.store.markRecallUsed(r.id); } catch (e) { /* 记账坏了不该挡沉淀 */ } }
      const st = g.stats();
      // 新しい作法(feedback)を書いた直後に「来月これを見て使えるか・推測で埋めた所は無いか」を自問させる。
      // 常駐に書くだけでは haiku は一度も問わず、自分で補った規則を保存した(10-14 dev: 雨の日 →「割引か一品」)。
      // 判定はしない(曖昧さは機械に測れない) —— 道具の返事は読んで従うので、ここに置く。
      // 数字・引用入りの命題は店主が言い切った規則 —— 自問を付けると「念のため確認させてください」を誘う(10-15 dev v6)。
      let concrete = false;
      try { concrete = new RegExp(cfg.json('main/memory_vague_claim').concrete).test(a.claim || ''); } catch (_) {}
      // 宿主が足す自問(行業版: 店規の回に既存エントリを書き換えた時の「名指しした物は在るか」)。既定は無し。
      const extra = agent && typeof agent._extraUpsertReceipt === 'function'
        ? agent._extraUpsertReceipt({ isNew: !!r.is_new, slug: r.slug, said }) : '';
      const check = r.is_new && a.type === 'feedback' && said.trim() && !concrete
        ? `\n\n${cfg.render('main/memory_check_claim_usable', { slug: r.slug })}` : (extra ? `\n\n${extra}` : '');
      // 查重挡门只比词面, 换个说法写同一件事照样放行(10-27 我的库: 人工判过的 12 对重复全过了门)。
      // 新建后再拿向量跟全库比一次, 像就点名 —— 只提示不拦, 这一带兄弟条目与真重复混在一起, 判断归人格。
      let dup = '';
      if (r.is_new) {
        try {
          const sims = await g.similarTo(`${a.title || ''} ${a.claim || ''} ${a.keywords || ''}`.trim(),
            { min: T().dup_hint_cos, exclude: r.id });
          if (sims.length) dup = `\n\n${cfg.render('main/memory_dup_hint', {
            candidates: sims.map((h) => `- [${h.cos}] ${h.slug}: ${h.claim.slice(0, 160)}`).join('\n') })}`;
        } catch (_) { /* 提示坏了不该挡沉淀 */ }
      }
      return txt(`✅ saved to memory: #${r.id} ${r.slug}${r.is_new ? ' (new)' : ' (updated)'}\n` +
        `   ${a.claim}\ngraph: ${st.nodes} nodes/${st.edges} edges/${st.pinned} pinned/${st.redlines} hard rules` +
        (coachingOn() && (r.notes || []).length
          ? `\n\n${msg('notes_head')}` + r.notes.map((n) => `\n\n${n}`).join('') : '') + check + dup);
    }),
    { alwaysLoad: true, searchHint: 'save to memory graph' });

  // 🔴 段的概念已整个撤掉, 读写正文各剩一个口子。
  // 撤的理由不是"段没用", 而是段正是让一条记忆装得下多个命题的凭借 —— 有 ## 在, 正文就能
  // 合法地长出第 2、第 3 个子命题。需要小标题就说明该拆成原子节点了, 不是该加个标题。
  // memory_section: session 级判重 —— agent 通过闭包传入(this 在 SDK async handler 里不绑 agent, 赌不来)。
  const memSection = tool('memory_section', D.memory_section,
    // node 可选 + ids/id 别名: upsert 收 id、touch 收 ids, 模型照哪个形状调都得读得到(10-14 dev: 27 次 id/ids 整轮校验失败)
    { node: z.string().optional().describe('node slug or numeric id; space-separated for several'),
      id: z.string().optional().describe('same as node'), ids: z.string().optional().describe('same as node'),
      force: z.boolean().optional().describe('force full body even if already opened this session') },
    async ({ node, id, ids, force }) => sectionWithGuard(agent, (n) => G().wholeBody(n), [node, id, ids].filter(Boolean).join(' '), force));

  const memWrite = tool('memory_write', D.memory_write,
    // node/content 收 id/body 别名并在处理里判缺: 必填交给 zod 时只回一句类型错, 当文件写的(path/file_path)也看不出走错了门(10-14 dev 14 次)
    { node: z.string().optional().describe('node slug or numeric id'), id: z.string().optional().describe('same as node'),
      content: z.string().optional().describe('**complete new body content** (replace semantics, not append). Pass empty string to clear.'),
      body: z.string().optional().describe('same as content'),
      base_hash: z.string().optional().describe('required (unless force): the hash from memory_section'),
      claim: z.string().optional().describe('update the claim in the same call — editing a body does not update it, and search only shows the claim.'),
      reason: z.string().optional().describe('one-sentence reason for this edit'),
      force: z.boolean().optional().describe('skip the pre-read check only; the size and no-grow gates still apply.'),
      path: z.string().optional(), file_path: z.string().optional() },
    async ({ node: n0, id, content: c0, body, base_hash, claim, reason, force, path: p, file_path: fp }) => {
      const node = n0 || id, content = c0 !== undefined ? c0 : body;
      if (!node && (p || fp)) return txt('⚠️ Not written: memory_write rewrites the body of a memory node (node=<slug>, content). It does not write files — '
        + 'MEMORY.md and other files go through Write / Edit.');
      if (!node || content === undefined) return txt(`⚠️ Not written: missing ${!node ? 'node (the memory\'s slug)' : 'content (the complete new body)'}. `
        + 'Shape: memory_write(node, content, base_hash) — get base_hash from memory_section first.');
      const g = G();
      if (g.resolve(node) && isFactory(g, node)) return txt(cfg.render('main/memory_factory_readonly', { slug: node }));
      const r = g.write({ node, content, base_hash, claim, force, actor: g.actor || '', reason: reason || 'no reason given' });
      // 把"缩了多少"印出来: write 的职责就是让正文变短或持平, 数字摆在眼前才知道这次改动是哪一种。
      const delta = r.shrank > 0 ? `${r.shrank} chars shorter than before` : 'same length as before';
      return txt(`✅ body rewritten: ${r.slug} (${r.chars} chars, ${delta})\n` +
        `new base_hash: ${r.hash}  ← use this directly for a follow-up edit, no need to re-read` +
        (r.notes || []).map((n) => `\n\n${n}`).join(''));
    });

  const memTouch = tool('memory_touch', D.memory_touch,
    // 字符串而非数组: 带 z.array 的参数会让模型的 tool 入参整个丢成 {}(记忆 #1305, 88k 次普查)
    { ids: z.string().optional().describe('node slug or numeric id; space-separated for multiple'), id: z.string().optional().describe('same as ids') },
    async ({ ids, id }) => {
      const done = G().touch(splitIds([ids, id].filter(Boolean).join(' ')) || []);
      if (!done.length) return txt('(no nodes matched)');
      // 只有脏的那几条才追一句 —— 干净的照旧一行, 不然 touch 每次都吐一堆字, 两天就没人看了。
      const nudge = done.filter((d) => (d.dirty || []).length).map((d) =>
        `\n\n📌 ${d.slug}: ${d.dirty.join(' · ')}\n   "${d.claim}"\n`
        + '   You just relied on this — the context is right here. Fixing it now is cheaper than coming back later:\n'
        + `   memory_upsert(id="${d.slug}", claim="claim: …")  passing only claim leaves the body untouched.`).join('');
      return txt(done.map((d) => `✔ ${d.slug} used=${d.use_count}`).join('\n') + nudge);
    },
    { alwaysLoad: true, searchHint: 'reinforce used memory' });

  const memHot = tool('memory_hot', D.memory_hot, { k: z.number().optional() },
    async ({ k }) => {
      const rows = G().hot(k || 20);
      if (!rows.length) return txt('(memory graph is empty)');
      return txt(rows.map((m) =>
        `[${m.hot} ${m.importance}${m.pinned ? ' 📌' : ''} used=${m.use_count}] ${m.slug}\n    ${m.claim}`).join('\n'));
    },
    { alwaysLoad: true, searchHint: 'what has been active lately' });

  // —— memory_admin: 冷门那十七件的合流口 ————————————————————————
  //
  // 为什么合: 每多注册一件工具就是一份说明 + 一份参数 schema 常驻, 每一轮都在付钱。
  // 实测 6109 份 transcript / 20350 次记忆工具调用, 这十七件加起来只占 7.5%,
  // 而独立的六件占 84.9% —— 冷的那批凭什么和热的那批一样每轮全额计费。
  //
  // 代价说清楚: 合并后参数没有 schema 级校验(args 是自由对象), 传错只能靠下面
  // 自己报"这个 op 收哪几个参数"。所以每个 op 都必须写全 req/opt, 那就是它的参数表。
  const OPS = {
    doctor: { run: () => {
      const d = G().doctor();
      const ps = d.problems || [];
      return txt([
        `nodes ${d.nodes} · edges ${d.edges} · pinned ${d.pinned}/${d.quota} · isolated ${d.isolated}`,
        d.review_due.length ? `overdue review ${d.review_due.length}: ${d.review_due.slice(0, 8).join(', ')}` : 'overdue review: none',
        ...ps.map((p) => `⚠️ ${p.kind} ×${p.count}${p.hint ? ` — ${p.hint}` : ''}${p.sample ? ` — e.g.: ${p.sample.join(', ')}` : ''}`),
        // 🔴 每条告警都要有「知道了, 这次不修」的出口, 否则只剩"永远被念叨"和"去乱改"两条路
        ps.length ? `\n不打算现在修的, 用 op='ack_problem' 确认掉(数量涨了会自动重新报): memory_admin(op="ack_problem", kind="${ps[0].kind}")` : '',
      ].filter(Boolean).join('\n'));
    } },

    ack_problem: { req: ['kind'], opt: ['note'],
      hint: 'kind 照抄 doctor 里 ⚠️ 后面那个名字。确认的是【当前这个数量】, 以后涨了会重新报 —— 它是"这批存量我认了", 不是永久免死。',
      run: (a) => {
        const r = G().ackProblem(a.kind, a.note || '');
        return txt(`✅ 已确认「${r.kind}」当前 ${r.acked_at_count} 条不修, 体检不再报它; 超过这个数会重新出现。`);
      } },

    timeline: { opt: ['k', 'by'], run: (a) => {
      const by = a.by === 'created' ? 'created' : 'last_used';
      return txt(G().timeline(a.k || 30, by).map((m) => `${m[by]} · ${m.slug}\n    ${m.claim}`).join('\n'));
    } },

    neighbors: { req: ['id'], opt: ['hops'], run: (a) => {
      const g = G();
      const nid = g.resolve(a.id);
      if (!nid) return txt(`❌ node not found: ${a.id}`);
      const rows = g.neighbors(nid, { hops: a.hops || 1 });
      if (!rows.length) return txt(`(${a.id} has no neighbors yet — isolated nodes are not reachable by search; consider adding some edges)`);
      return txt(rows.map((n) => `${n.hops} hop(s) · ${n.slug}\n    ${n.claim}`).join('\n'));
    } },

    revisions: { req: ['id'], opt: ['limit'], run: (a) => {
      const g = G();
      const nid = g.resolve(a.id);
      if (!nid) return txt(`❌ node not found: ${a.id}`);
      const rows = g.store.historyOf(nid, a.limit || 20);
      if (!rows.length) return txt('(no revision history)');
      return txt(rows.map((r) =>
        `${r.at.slice(0, 16).replace('T', ' ')} · ${r.op}/${r.field}${r.actor ? ` · ${r.actor}` : ''}\n` +
        `    before: ${String(r.before || '').slice(0, 90)}\n    after: ${String(r.after || '').slice(0, 90)}`).join('\n'));
    } },

    link: { req: ['from_id', 'to_id'], opt: ['rel'],
      hint: 'rel: relates (default)/refines/supports/contradicts/part_of. For supersedes use op=arbitrate.',
      run: (a) => {
        const r = G().linkBidirectional({ from_id: a.from_id, to_id: a.to_id, rel: a.rel || 'relates' });
        return txt(`✅ edge linked: #${r.from} ←${r.rel}→ #${r.to}`);
      } },

    pinned: { run: () => {
      const g = G();
      const rows = g.pinnedAll();
      const audit = g.pinnedAudit();
      const head = `pinned ${audit.used}/${audit.quota}${audit.over ? ` ⚠️ over by ${audit.over}` : ''}`;
      const cand = audit.candidates.length ? `\n\nCandidates to take out (mechanical filter, your call): ${audit.candidates.join(', ')}` : '';
      return txt(`${head}\n${rows.map((m) => `📌 ${m.slug}\n    ${m.claim}`).join('\n')}${cand}`);
    } },

    set_pinned: { req: ['id'], opt: ['on', 'reason', 'demote'],
      hint: 'Pinned = resident: its claim rides along at the top of every session. on=false removes it. demote=<slug> takes one out in the same call when the set is full.',
      run: (a) => {
        const g = G();
        if (a.on === false) { const r = g.unpin(a.id); return txt(`✔ removed from pinned set: #${r.id}`); }
        const r = g.setPinned(a.id, a.reason || '', { demote: a.demote });
        return txt(`📌 pinned: #${r.id} · pinned ${r.used}/${r.quota}${a.demote ? ` (${a.demote} displaced)` : ''}`);
      } },

    set_importance: { req: ['id', 'importance'], hint: 'importance: high/med/low. Pinning is a separate axis: op=set_pinned.',
      run: (a) => {
        const r = G().setImportance(a.id, a.importance);
        return txt(`✔ #${r.id} importance → ${r.importance}`);
      } },

    set_redline: { req: ['id'], opt: ['trigger_pattern', 'correct_action', 'level', 'off'],
      hint: 'trigger_pattern is a regex, not prose: `toolName[,toolName…]:regex` matched against toolName + params JSON. '
        + 'correct_action must say what to do instead — "do not do X" alone leaves nothing to act on. level: block (default)/warn. off=true removes the mark.',
      run: (a) => {
        const g = G();
        const nid = g.resolve(a.id);
        if (!nid) return txt(`❌ node not found: ${a.id}`);
        if (a.off) { g.store.unsetRedline(nid); return txt(`✔ hard rule removed: #${nid}`); }
        const r = g.setRedline(nid, { trigger_pattern: a.trigger_pattern, correct_action: a.correct_action, level: a.level || 'block' });
        return txt([
          `🔴 hard rule set: #${nid}`,
          `   trigger: ${a.trigger_pattern || '(not set)'}`,
          `   correct action: ${a.correct_action || '(not set)'}`,
          r.enforced ? '   ✅ the system will intercept at the moment you act' : `   ⚠️ ${r.note}`,
        ].join('\n'));
      } },

    redlines: { run: () => {
      const rows = G().redlines();
      if (!rows.length) return txt('(no hard rules)');
      return txt(rows.map((r) =>
        // warn 档命中是放行了的提醒, 不是违规 —— 写成 violated, 助手会据此编造自己犯了什么错(10-14 行业版 dev 实撞)。
        `${r.level === 'block' ? '🔴' : '⚠️'} ${r.slug}${r.violations ? (r.level === 'block'
          ? ` (violated ${r.violations} times)` : ` (warning shown ${r.violations} times · the action went through)`) : ''}`
        + `\n    ${r.claim}\n    correct action: ${r.correct_action || '(not set)'}`).join('\n'));
    } },

    semantic: { opt: ['on'], hint: 'omit on to just check status',
      run: (a) => {
        const g = G();
        if (a.on !== undefined) g.setSemanticFusion(a.on);
        const s = g.embedStats();
        return txt(`semantic fusion: ${g.semanticFusionOn() ? 'on' : 'off'} · model ${s.model || '(not installed)'} · done ${s.done} pending ${s.pending}`);
      } },

    // 老结论不删只挂牌: 直接标失效会让它悄悄消失, 下次同样的错没有任何拦路杆。
    arbitrate: { req: ['winner', 'loser'], opt: ['undo', 'reason'],
      hint: 'winner = the new conclusion that prevails, loser = the old one being superseded.',
      run: (a) => {
        const g = G();
        if (a.undo) { const r = g.unsupersede({ winner: a.winner, loser: a.loser }); return txt(`✔ supersede undone: #${r.loser} restored to active`); }
        const r = g.supersede({ winner: a.winner, loser: a.loser, actor: g.actor || '' });
        return txt(`⚖️ #${r.winner} supersedes #${r.loser}${a.reason ? `\n   reason: ${a.reason}` : ''}\n` +
          '   The old conclusion can still be recalled (useful when retracing past reasoning), but every recall from now on will carry "superseded".');
      } },

    // 分片版: 全库两两配对要几秒, 同步跑会把主进程占死(界面一个字都打不进)。
    conflict_scan: { opt: ['max'], run: async (a) => {
      const rows = await G().conflictCandidatesChunked({ max: a.max || 8 });
      if (!rows.length) return txt('(no conflict candidates found)');
      return txt(rows.map((s) =>
        `score ${s.score} — ${s.why || '主题重叠'}\n  A ${s.a.slug}: ${s.a.claim}\n  B ${s.b.slug}: ${s.b.claim}`).join('\n\n'));
    } },

    conflict_settle: { req: ['a', 'b', 'verdict'], opt: ['note'],
      hint: 'verdict: no_conflict / scoped (both kept, different contexts) / merged (ONLY if you already merged them — this call changes neither memory) / asked_user. A real supersede goes through op=arbitrate.',
      run: (a) => {
        const r = G().conflictSettle({ a: a.a, b: a.b, verdict: a.verdict, note: a.note });
        return txt(`✔ verdict recorded: #${r.a} vs #${r.b} → ${a.verdict}`);
      } },

    // 拆节点。老库那批肥大记忆靠 upsert 拆不动: 要手拼四步(建节点·搬正文·逐条连边·标失效),
    // 中途任何一步失败都留下半拆的图, 所以给一个原子动作。
    split: { req: ['id', 'parts'], opt: ['note'],
      hint: 'parts: at least 2 objects, each {slug, claim, body?, title?, type?, importance?, keywords?, exit_criteria?}',
      run: (a) => {
        const g = G();
        const nid = g.resolve(a.id);
        if (!nid) return txt(`❌ node not found: ${a.id}`);
        const parts = a.parts;
        if (!Array.isArray(parts) || parts.length < 2) return txt('❌ at least 2 parts required — 1 part is not a split; use memory_upsert to change a claim.');
        const old = g.store.node(nid);
        // 老节点的边不知道该跟哪一片走, 所以每一片都继承一份。宁多勿少: 边多了顺藤摸瓜时一眼扫掉,
        // 边丢了是"我以为连着其实早断了", 而且永远不会有人发现。co_used 不继承 —— 那是引擎按
        // 实际共现长出来的, 复制过去等于伪造了一段没发生过的使用史。
        const inherit = g.store.edgesOf(nid).filter((e) => e.made_by !== 'engine');
        const created = [];
        try {
          g.store.transaction(() => {
            for (const p of parts) {
              const r = g.upsert({ slug: p.slug, title: p.title || p.slug, claim: p.claim,
                body: p.body, type: p.type, importance: p.importance, keywords: p.keywords,
                exit_criteria: p.exit_criteria, actor: g.actor || '' });
              created.push(r);
              for (const e of inherit) {
                const other = e.src === nid ? e.dst : e.src;
                if (other !== r.id) g.store.addEdge(r.id, other, e.rel, e.made_by || 'human');
              }
              g.store.addEdge(r.id, nid, 'supersedes', 'human');
            }
            // 同源的几片互连: 拆开之后它们各自成立, 但"本来是一件事"这个事实只能靠边留住。
            for (const x of created) for (const y of created) if (x.id !== y.id) g.store.addEdge(x.id, y.id, 'relates', 'human');
            // 老节点留着不删: 拆错了要能回头看原文。status=superseded 让它退出常规召回,
            // 而召回到它时引擎会强制附带"已被 X 推翻"(supersedes 边的既有行为)。
            g.store.upsertNode({ id: nid, status: 'superseded' }, { actor: g.actor || '', op: 'split', note: a.note || '' });
          });
        } catch (e) { return txt(`❌ split failed (rolled back entirely, graph has no half-split state): ${e && e.message}`); }
        return txt(`✂️ #${nid} ${(old && old.slug) || ''} split into ${created.length} nodes, original marked superseded (body preserved):\n`
          + created.map((c) => `  → #${c.id} ${c.slug}`).join('\n')
          + `\n${inherit.length} edges inherited × each piece`);
      } },

    // 唤醒正文已经把待办全文端上来了, 所以"看"是补位用的; 真正必需的是标完成 ——
    // 没有它队列永远不空, 那段会一直挂在每次苏醒里。
    chores: { run: () => {
      const rows = G().store.choresPending();
      if (!rows.length) return txt('✅ no pending upgrade self-check tasks');
      return txt(rows.map((c) => `[${c.key}]${c.version ? ` (v${c.version})` : ''} ${c.title}\n  ${c.detail}`).join('\n\n'));
    } },

    chore_done: { req: ['key'], hint: 'key is shown at the end of each item in the wake body',
      run: (a) => {
        const g = G();
        if (!g.store.choresPending().some((c) => c.key === a.key)) return txt(`❌ task not found (or already marked done): ${a.key}`);
        g.store.choreDone(a.key);
        const left = g.store.choresPending().length;
        return txt(left ? `✔ marked done: ${a.key} · ${left} remaining` : `✔ marked done: ${a.key} · all done, this section will not appear again`);
      } },
  };

  // 🔴 光列字段名不够用: 拿到 `args: id, parts` 仍不知道该拼成什么形状, 每次都要先试错一轮
  // 再看报错(外部用户 2026-09-12 反馈原话「别只给字段名」)。所以连**可照抄的整句调用**一起给,
  // 必填在前可选带 `?`。这段只在缺参数/出错那刻才出现, 不是每轮 describe, 写详细不花常驻的钱。
  const opSpec = (name) => {
    const s = OPS[name];
    const req = (s.req || []).join(', ') || '(none)';
    const opt = (s.opt || []).length ? ` · optional: ${s.opt.join(', ')}` : '';
    const shape = [...(s.req || []).map((k) => `${k}=…`), ...(s.opt || []).map((k) => `${k}?=…`)].join(', ');
    return `op="${name}" params: ${req}${opt}${s.hint ? `\n   ${s.hint}` : ''}`
      + `\n   照这个形状调: memory_admin(op="${name}"${shape ? `, ${shape}` : ''})`;
  };

  const memAdmin = tool('memory_admin', D.memory_admin,
    // 参数平铺在 op 后面(agent/flat-args.js): loose 收下其余顶层键, 不必把十七个 op 的参数并集
    // 逐个声明把 schema 撑回原样。校验由上面的 req 表在运行时做, 报错里带回该 op 的参数表。
    looseShape(z, { op: z.enum(Object.keys(OPS)) }),
    async (input) => {
      const { op } = input;
      const args = gather(input, ['op']);
      const spec = OPS[op];
      if (!spec) return txt(`❌ unknown op "${op}" — legal ops: ${Object.keys(OPS).join(' ')}`);
      const a = args || {};
      const missing = (spec.req || []).filter((k) => a[k] === undefined || a[k] === '');
      if (missing.length) return txt(`❌ missing: ${missing.join(', ')}\n   ${opSpec(op)}`);
      try { return await spec.run(a); }
      catch (e) { return txt(`❌ ${op} failed: ${(e && e.message) || e}\n   ${opSpec(op)}`); }
    });

  return [memQuery, memUpsert, memSection, memWrite, memTouch, memHot, memAdmin];
}

module.exports = { registerMemoryToolsV2, DEFAULT_DESC, renderHit, PRE_QUERY_THRESHOLD };
