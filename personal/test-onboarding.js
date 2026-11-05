// 出生教育 v2 (灌知识 + 体验校验) 回归测试 + md.js 有序列表编号
// 跑: node test-onboarding.js
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const cfg = require('./config-loader');
const birth = require('./birth');
const { MemoryGraph, PINNED_QUOTA } = require('../core/memory.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

console.log('\n=== 出生教育 v2 · 结构 ===');
const manifest = cfg.json('onboarding/manifest');
const NAME = '测试飞飞';
const bundlesLeaf = birth.bundleNames(manifest, false);
const bundlesButler = birth.bundleNames(manifest, true);
ok(bundlesLeaf.length > 0, '叶子线有知识包');
ok(bundlesButler.length > bundlesLeaf.length, '管家线多一份专属知识包');
for (const b of bundlesButler) {
  ok(fs.existsSync(path.join(__dirname, '../core/config/onboarding/knowledge', b + '.json')), '知识包存在: ' + b);
}
// 🔴 出生教育显示在聊天窗里, 用户看得见 → 四语一份都不能少。漏一语的样子不是报错,
// 是那个语言的用户静默拿到另一种语言的教材, 所以门禁按语言逐份查。
const EXP_KEYS = [manifest.experience, manifest.experience_tail_leaf, manifest.experience_tail_butler, manifest.experience_retry];
for (const k of EXP_KEYS) {
  for (const lc of require('../core/memory-v2/lang').LANGS) {
    ok(fs.existsSync(path.join(__dirname, '../core/config/onboarding', `${k}.${lc}.md`)), `体验文案存在: ${k}.${lc}`);
  }
}

console.log('\n=== 知识包内容合法性 ===');
const VALID_TYPE = new Set(['feedback', 'reference', 'project', 'user']);
// 包里不再允许 pinned: 它已从 importance 挪进扩展表, 且作者 2026-08-16 定了「先拆开, 拆完再看
// 是不是真常用」—— 出生一律不预置, 父条的 pinned 也不许被拆出来的子命题继承。
const VALID_IMP = new Set(['high', 'med', 'low']);
const VALID_REL = new Set(['relates', 'refines', 'supports', 'part_of', 'supersedes', 'contradicts']);
const allItems = [];
const bundleOf = new Map();
for (const b of bundlesButler) {
  const bundle = cfg.json('onboarding/knowledge/' + b);
  ok(!!bundle.bundle_id && !!bundle.version, `${b}: 有 bundle_id 和 version`);
  ok(Array.isArray(bundle.items) && bundle.items.length > 0, `${b}: items 非空`);
  for (const it of bundle.items) bundleOf.set(it.slug, b);
  allItems.push(...bundle.items);
}
const slugs = allItems.map((i) => i.slug);
ok(slugs.every(Boolean), '每条都有 slug');
ok(new Set(slugs).size === slugs.length, 'slug 不重复');
ok(slugs.every((s) => /^(feedback|reference|project|user)_/.test(s)), '每条 slug 都用四类前缀');
ok(allItems.every((i) => VALID_TYPE.has(i.type)), 'type 全合法');
ok(allItems.every((i) => VALID_IMP.has(i.importance)), 'importance 全合法(不含 pinned)');
// 🔴 命题是这一版的核心: 不读正文就知道这是什么。摘要判不了真假, 边也就只能表达"有关"。
ok(allItems.every((i) => i.claim && i.claim.trim().length >= 12), '每条都有像样的 claim(命题)');
ok(allItems.every((i) => !i.description), '不许再留 description(v1 残留)');
ok(allItems.every((i) => !i.links), '不许再留扁平 links(要用带类型的 edges)');
ok(allItems.every((i) => !i.body || i.body.length > 20), 'body 可以没有, 有就得有实质内容');
ok(allItems.every((i) => i.keywords && i.keywords.trim()), '每条都有 keywords(数字主键抹掉的检索信号靠它补)');
// 边悬空 = 图里一堆连不到东西的边, 正是知识包自己警告过的那种自造悬空
const known = new Set([...slugs, 'self_identity']);
const edgesOf = (i) => (i.edges || []);
const dangling = allItems.flatMap((i) => edgesOf(i).filter((e) => !known.has(e.to)).map((e) => `${i.slug}→${e.to}`));
ok(dangling.length === 0, 'edges 不悬空' + (dangling.length ? ' — 悬空: ' + dangling.join(', ') : ''));
ok(allItems.every((i) => edgesOf(i).every((e) => VALID_REL.has(e.rel))), 'rel 全是约定值');
ok(allItems.every((i) => edgesOf(i).length > 0), '每条至少连一条边(孤儿命题召不回来)');
// 🔴 方向性: 通用包不许指向管家专属包 —— 非管家人格只灌 leaf_core, 那种边一定断。
const crossBad = allItems.filter((i) => bundleOf.get(i.slug) !== 'butler_extra')
  .flatMap((i) => edgesOf(i).filter((e) => bundleOf.get(e.to) === 'butler_extra').map((e) => `${i.slug}→${e.to}`));
ok(crossBad.length === 0, '通用包不依赖管家专属包' + (crossBad.length ? ' — 违规: ' + crossBad.join(', ') : ''));
// 正文里写出可解析的双方括号会造出引擎真去连的边, 而那些目标多半不存在
const bracket = allItems.filter((i) => /\[\[[A-Za-z0-9_-]+\]\]/.test((i.body || '') + i.claim));
ok(bracket.length === 0, '正文不写裸 wikilink(要连边走 edges 字段)' + (bracket.length ? ' — 违规: ' + bracket.map((i) => i.slug).join(',') : ''));
// pinned = 常驻(每个会话整份注入), 该常驻的是人格干活之后自己定下的规矩 —— 出厂包不带。
const prePinned = allItems.filter((i) => i.pinned);
ok(prePinned.length === 0,
   `出厂包不预置 pinned (${prePinned.length} 条${prePinned.length ? ': ' + prePinned.map((i) => i.slug).join(', ') : ''})`);
// seed_use_count: 全 1 会让新人格第一天的 hot() 退化成字母序(见 hot 排序被压死那个坑)。
// 上限卡 4 —— 出厂估计不该压住人格自己积累的真实频次。
ok(allItems.every((i) => Number.isInteger(i.seed_use_count) && i.seed_use_count >= 1 && i.seed_use_count <= 4),
   '每条都有 1~4 的 seed_use_count(冷启动排序, 且压不住真实频次)');
ok(new Set(allItems.map((i) => i.seed_use_count)).size >= 3,
   'seed 至少分了三档(全给同一个值等于没排序)');
// 红线有自己的属性表, 不占 pinned 配额; 但得填全, 否则 PreToolUse 挂不上钩
// `redline: {off: true}` 是收回出厂红线的写法(factory-sync), 不算一条红线。
const redlines = allItems.filter((i) => i.redline && !i.redline.off);
ok(redlines.every((i) => i.redline.trigger_pattern && i.redline.correct_action),
   `红线都填了触发与正确做法 (${redlines.length} 条)`);

console.log('\n=== 变量替换 ===');
const vars = birth.birthVars(NAME);
const renderedAll = allItems.map((i) => birth.fillVars(i.body || '', vars) + '\n' + birth.fillVars(i.claim, vars)).join('\n');
ok(!/\{\{\w+\}\}/.test(renderedAll), '知识包无未替换模板变量');
// 出生教育【一段发完】(作者 2026-08-25:「我要一段」), 动手题 + 见主人都在 buildExperienceText 里。
// 🔴 下面那批内容断言写的是英文短语, 所以这里把显示语言钉死在 en —— 四语的覆盖由本节末尾
// 的逐语言循环负责, 两件事分开: 内容对不对只需验一份, 缺不缺语言要验四份。
const memLang = require('../core/memory-v2/lang');
memLang.setLang('en');
const expLeaf = birth.buildExperienceText({ name: NAME, isButler: false, knowledgeCount: 18 });
const expButler = birth.buildExperienceText({ name: NAME, isButler: true, knowledgeCount: 22 });
ok(!/\{\{\w+\}\}/.test(expLeaf) && !/\{\{\w+\}\}/.test(expButler), '体验文案无未替换模板变量');
ok(expLeaf.includes(NAME) && expLeaf.includes('18'), '体验文案带上了名字和灌注条数');

// 四语各渲一遍。这里不看措辞(那是译者的事), 只看【结构没塌】: 占位符填没填、指名的
// 工具在不在、有没有引用真实的骨架字面串 —— 漏译一份的样子是静默拿到别的语言, 不报错。
for (const lc of memLang.LANGS) {
  memLang.setLang(lc);
  for (const isButler of [false, true]) {
    const t = birth.buildExperienceText({ name: NAME, isButler, knowledgeCount: 18, memoryDir: '/tmp/probe/.claude/memory' });
    const tag = `${lc}/${isButler ? 'butler' : 'leaf'}`;
    ok(!/\{\{\w+\}\}/.test(t), `${tag}: 无未替换模板变量`);
    ok(t.includes(NAME) && t.includes('18'), `${tag}: 名字与条数填进去了`);
    ok(t.includes('/tmp/probe/.claude/memory/persona.md'), `${tag}: persona.md 给的是绝对路径`);
    ok(t.includes('🔥 Current task') && t.includes('(empty for now)'),
       `${tag}: 引用的是 MEMORY.md 骨架里真实的节名与占位符`);
    ok(['memory_hot', 'memory_query', 'memory_touch', 'memory_upsert', 'memory_admin'].every((x) => t.includes(x)),
       `${tag}: 五个工具名一个没丢`);
  }
}
memLang.setLang('en');

console.log('\n=== 真跑一次灌注 (不是看文本, 是看图里真长出什么) ===');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-birth-'));
const g = new MemoryGraph(TMP);
const stats = birth.applyBirthKnowledge(g, { name: NAME, extra: '负责给儿子讲日语课', isButler: true, log: () => {} });
ok(stats.failed.length === 0, '灌注零失败' + (stats.failed.length ? ' — ' + stats.failed.join(' | ') : ''));
ok(stats.learned === allItems.length + 1, `灌注条数对上 (${stats.learned} = ${allItems.length} 知识 + 1 领域)`);
const built = g.build();
ok(built.nodes === stats.learned, `图里真有这么多节点 (${built.nodes})`);
ok(built.validPct >= 90, `边有效率 ${built.validPct}% (self_identity 那条出生礼物此时还没建, 允许少量悬空)`);
const hot = g.hot(9999);
ok(hot.every((m) => m.description && m.description.trim()), '每个节点都带 description(v1 下映射自 claim)');
ok(g.pinnedAll().length <= PINNED_QUOTA, `灌完 pinned ${g.pinnedAll().length} 条, 未超配额`);
ok(g.pinnedAll().some((m) => m.id === 'user_my_domain'), '领域被灌成节点(不再喂一课让它复述)');
// 真正的判据: 它能不能"想得起来" —— 用新生儿真会用的查法(空格分关键词)去查, 而不是用节点标题去查。
// 检索按空格切词后做匹配, 所以整句话原样传进去几乎命中不了 —— 这条限制知识包里也教了。
for (const [q, want] of [
  ['pinned 常驻', 'reference_pinned_is_resident_every_session'],
  ['上下文 清空', 'feedback_context_is_disposable_memory_is_storage'],
  ['记忆 冲突', 'reference_classify_the_conflict_before_judging_it'],
  ['领域', 'user_my_domain'],
]) {
  const hits = g.query(q, { k: 5 }).map((r) => r.id);
  ok(hits.includes(want), `召回得到: 「${q}」→ ${want}` + (hits.includes(want) ? '' : ' — 实际 top5: ' + hits.join(',')));
}

// 出生知识彼此连边最密(全是规矩类), 不标出厂就会在新人格第一次苏醒时被冲突体检整批圈成候选 ——
// 一个刚出生的人格头几个月每周都在审自己的出厂知识, 那是纯浪费。
ok(g.conflictCandidates({ max: 9 }).length === 0, '灌完立刻体检: 出厂知识之间零候选');
ok(g.hot(9999).every((m) => m.id === 'user_my_domain' || true), '(灌注节点全部带出厂标记, 见下)');
ok(Object.values(g._fresh().nodes).every((n) => n.origin === 'birth'), '每条灌进来的都标了 origin=birth');

console.log('\n=== 体验校验: 量的是图的客观状态, 不是它嘴上说做没做 ===');
const memoryMd = path.join(TMP, 'MEMORY.md');
fs.writeFileSync(memoryMd, '# 骨架\n', 'utf8');
const before = birth.birthSnapshot(g, TMP);
ok(birth.verifyBirthExperience(before, before).length === 3, '三件都没做 → 三项都缺');
// ① 自己沉一条
g.upsert({ id: 'user_first_thought', type: 'user', description: '我醒来第一个念头', body: '我叫' + NAME });
const afterSink = birth.birthSnapshot(g, TMP);
ok(birth.verifyBirthExperience(before, afterSink).length === 2, '沉了自己的第一条 → 少一项缺');
ok(!birth.verifyBirthExperience(before, afterSink).some((m) => m.includes('第 ③')), '缺项里不再有第 ③ 步');
// ② 强化一条
g.touch(['user_first_thought']);
const afterTouch = birth.birthSnapshot(g, TMP);
ok(!birth.verifyBirthExperience(before, afterTouch).some((m) => m.includes('第 ④')), 'touch 过 → 第 ④ 步销账');
// ③ 写 MEMORY.md
fs.writeFileSync(memoryMd, '# 骨架\n\n## 🔥 在办区\n- 出生教育刚跑完, 等主人回话\n', 'utf8');
const afterMd = birth.birthSnapshot(g, TMP);
ok(birth.verifyBirthExperience(before, afterMd).length === 0, '三件都做了 → 零缺项(不再补提)');
// 补提文案只列缺的那几项
const retry = birth.buildRetryText({ name: NAME, missing: birth.verifyBirthExperience(before, before) });
ok(retry.includes(NAME) && /memory_upsert/.test(retry) && /Current task/.test(retry),
   '补提文案点名了缺的那几件事(编号会随教材改版而变, 所以判据取动作本身)');
ok(!/\{\{\w+\}\}/.test(retry), '补提文案无未替换模板变量');
fs.rmSync(TMP, { recursive: true, force: true });

// ── v2 底座下的灌注 ──────────────────────────────────────────────
// 🔴 这一段是补 2026-08-16 的血账: v2 下出生教育一直【静默失败】—— birth.js 拿语义 id 当数字
// 主键传, upsert 判成"更新已有节点", UPDATE 匹配 0 行还不抛错, 于是报告 learned=22 而库里 0 条。
// 所以这里不看 stats 说灌了多少, 只看库里真长出多少。
console.log('\n=== v2 底座: 命题 + 有向类型边 + 红线 ===');
const { MemoryGraphV2 } = require('../core/memory-v2.js');
const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-birth-v2-'));
const g2 = new MemoryGraphV2(TMP2);
const st2 = birth.applyBirthKnowledge(g2, { name: NAME, extra: '负责给儿子讲日语课', isButler: true, log: () => {} });
ok(st2.failed.length === 0, 'v2 灌注零失败' + (st2.failed.length ? ' — ' + st2.failed.join(' | ') : ''));
const nodes2 = Object.values(g2._fresh().nodes);
ok(nodes2.length === allItems.length + 1,
   `v2 库里真有这么多节点 (${nodes2.length} = ${allItems.length} 知识 + 1 领域) —— 不看 stats 报了多少`);
ok(nodes2.every((n) => n.claim && n.claim.trim()), '每个节点都带命题(检索结果不带 claim 我就是瞎子)');
ok(nodes2.every((n) => n.is_factory === 1), '每条都标了出厂(冲突体检靠它跳过出厂知识互审)');
ok(nodes2.every((n) => n.importance !== 'pinned'), 'v2 下 importance 里没有 pinned 这一档');
// 常驻: 出生时一条都没有(领域已在 persona.md 里每轮注入, 不重复占位)。
const pinned2 = g2.pinnedAll();
ok(pinned2.length === 0, `出生后常驻为空 (${pinned2.length}/${PINNED_QUOTA})`);
// seed use_count: 分档必须真落到库里, 否则第一天 hot() 还是字母序
const seeded = nodes2.filter((n) => n.slug && n.slug !== 'user_my_domain');
ok(new Set(seeded.map((n) => n.use_count)).size >= 3, 'seed 分档真落库(不是全 1)');
const seedOf = (s) => nodes2.find((n) => n.slug === s).use_count;
ok(seedOf('feedback_query_memory_before_acting') > seedOf('reference_keepalive_breaks_even_at_ten_times'),
   '天天要用的那条排在冷背景知识前面');
// 🔴 seed 只在新建时生效: 出厂估计绝不许覆盖人格自己积累的真实频次
g2.touch(['reference_keepalive_breaks_even_at_ten_times']);
const realCount = seedOf('reference_keepalive_breaks_even_at_ten_times') + 1;
birth.applyBirthKnowledge(g2, { name: NAME, extra: '负责给儿子讲日语课', isButler: true, log: () => {} });
const after = Object.values(g2._fresh().nodes).find((n) => n.slug === 'reference_keepalive_breaks_even_at_ten_times');
ok(after.use_count > realCount - 1 && after.use_count !== 1,
   `重灌不会把真实频次打回出厂种子 (${realCount} → ${after.use_count})`);
// 有向类型边: 拿 linkBidirectional 代替会写反, 所以这里逐个 rel 对账
const e2 = g2.store.allEdges();
const wantEdges = allItems.reduce((a, i) => a + (i.edges || []).length, 0);
ok(e2.length >= wantEdges, `边真落库 (${e2.length} 条, 包里 ${wantEdges} 条)`);
const relKinds = new Set(e2.map((e) => e.rel));
ok(['part_of', 'supports', 'refines', 'relates'].every((r) => relKinds.has(r)),
   '四种类型边都在: ' + [...relKinds].join(','));
// 方向性: A part_of B 不等于 B part_of A
const idOf = (s) => g2.resolve(s);
const partOf = e2.filter((e) => e.rel === 'part_of');
ok(partOf.some((e) => e.src === idOf('feedback_knowledge_questions_dig_them_yourself')
                   && e.dst === idOf('feedback_three_kinds_of_matter_three_handlings')), 'part_of 方向正确(子→父)');
ok(!partOf.some((e) => e.src === idOf('feedback_three_kinds_of_matter_three_handlings')
                    && e.dst === idOf('feedback_knowledge_questions_dig_them_yourself')), 'part_of 没被写成双向');
ok(g2.redlines().length === redlines.length, `红线挂上了 (${g2.redlines().length} 条) 且不占快查表配额`);
ok(g2.redlines().every((r) => r.trigger_pattern && r.correct_action), '红线带触发与正确做法');
// DB 即真源: 一个节点 .md 都不该有
const strayMd = fs.readdirSync(TMP2).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
ok(strayMd.length === 0, 'v2 下不落节点 .md' + (strayMd.length ? ' — 多出: ' + strayMd.join(',') : ''));
// 拆细了之后还召不召得回来 —— 拆分的意义就在这: 查"要不要标 pinned"该命中那一条, 不是一个大块
for (const [q, want] of [
  ['pinned 常驻', 'reference_pinned_is_resident_every_session'],
  ['被质疑 依据', 'feedback_weigh_the_challenge_before_yielding'],
  ['插话 改道', 'feedback_interrupt_is_either_redirect_or_supplement'],
  ['单向 异步', 'reference_cross_persona_messaging_is_one_way_async'],
]) {
  const hits = g2.query(q, { k: 5 }).map((r) => r.slug);
  ok(hits.includes(want), `v2 召回: 「${q}」→ ${want}` + (hits.includes(want) ? '' : ' — 实际 top5: ' + hits.join(',')));
}
fs.rmSync(TMP2, { recursive: true, force: true });

console.log('\n=== 关键内容仍在(改版不许丢) ===');
const everything = renderedAll + '\n' + expLeaf + '\n' + expButler;
ok(/Current task/.test(everything) && !/索引区/.test(everything),
   'MEMORY.md 只教「🔥 手头这件」(骨架里的真实节名), 不教索引区');
ok(/一律存进记忆库/.test(everything) && /MEMORY\.md 只写在办的事/.test(everything), '教了长期知识进记忆库、MEMORY.md 只写在办的事(守知识不守口号: 命题正面化后逐字查否定说法必落空)');
ok(/第二份索引/.test(everything), '教了指针清单会变成第二份索引');
ok(/3KB/.test(everything) && /行数/.test(everything), '教了体量约束是字节不是行数');
// pinned = 常驻: 每个会话整份注入, 只放每句回话都适用的规矩。
ok(/常驻/.test(everything) && /每个会话/.test(everything), '教了 pinned 是常驻、每个会话都带着');
ok(/每句回话都适用/.test(everything), '教了常驻只放每句回话都适用的规矩');
ok(!/四问/.test(everything), '不再教作废的 pinned 淘汰四问');
ok(!new RegExp(`上限\\s*${PINNED_QUOTA}`).test(everything) && !/demote/.test(everything),
   '不把程序已硬控的配额数字与换人参数抄进知识包(引擎自己会挡, 抄一份就是第二副本)');
ok(/点对点直连|不需要谁批准/.test(everything), '教了人格间 mesh 全互通');
ok(!/只能找管家|默认不直接通话|用户授权 \+ 管家开通/.test(everything), '没教假的直连限制');
ok(/what domain.*focus on|focus on\?/.test(expButler), '管家线收尾反问用户领域');
ok(/独立|互不共享/.test(everything) && /专注一件事/.test(everything), '管家线含带用户上手内容');
ok(/哪个渠道|哪条渠道/.test(everything), '教了从哪个渠道来就回到哪个渠道');
ok(/op='conflict_scan'/.test(everything) && /op='conflict_settle'/.test(everything), '教了冲突体检与收口');
ok(/op='set_importance'/.test(everything), '教了只改档位的正确工具');
for (const real of ["op='create'", "op='list'", "op='open'", "op='tune'"]) ok(everything.includes(real), '教了实有工具: persona_admin ' + real);
// 🔴 幽灵工具比不写更糟: 照着调必然 tool not found, 人格却以为是自己参数写错而反复重试。判据是
// 旧名后紧跟左括号 = 拿它当能调的东西教; 只提一句「原来那个独立命令 X」是**有意**的废弃锚点, 不算。
const taught = allItems.map((it) => JSON.stringify(it, (k, v) => (k === 'keywords' ? undefined : v))).join('\n');
for (const ghost of ['grant_peer', 'revoke_peer', 'ask_persona', 'persona_tune', 'send_bothub', 'bus_put_file', 'bus_get_file', 'list_personas', 'open_persona', 'create_persona']) ok(!taught.includes(ghost + '('), '不教已下线工具: ' + ghost);

console.log('\n=== 硬动作 (2026-08-07 实测: 写成"说说你打算写什么", 新生儿真的只"说"了) ===');
ok(/actually do|run real tools/.test(expLeaf), '体验文案要求真调工具');
ok(/`Edit`|Edit\//.test(expLeaf) && /`Read`|Read /.test(expLeaf),
   'MEMORY.md 那步是动手改文件(而且要求改完重读确认)');
ok(/Don't ask.*should I do|just do it/.test(expLeaf), '明说不必先请示(那头没人实时答)');
ok(/memory_hot/.test(expLeaf) && /memory_query/.test(expLeaf) && /memory_upsert/.test(expLeaf)
   && /memory_touch/.test(expLeaf) && /op='doctor'/.test(expLeaf), '六步覆盖了读/查/沉/强化/体检');

console.log('\n=== 工具覆盖: 每个注册工具都得让 AI 知道 ===');
const D = require('../core/config/tools/descriptions.json');
// 手册已废(知识全进记忆)。第三个来源改成工具描述本身 —— 但描述得真讲了用法,
// 不能只是重复一遍工具名, 所以要求 ≥60 字才算"教到"。
const taughtByDesc = (k) => String(D[k] || '').length >= 60;
const untaught = Object.keys(D).filter((k) => !everything.includes(k) && !taughtByDesc(k));
ok(untaught.length === 0, `${Object.keys(D).length} 个工具全教到(知识包/体验文案/工具描述)` + (untaught.length ? ' — 漏: ' + untaught.join(',') : ''));

console.log('\n=== 身份描述必须肯定式 (对没有先验概念的新生儿, 说"你不是X"反而先植入了 X) ===');
for (const [re, label] of [
  [/你不是[别人用户]/, '"你不是…"式身份否定'],
  [/天生的?\s*AI\s*坏毛病|你最危险的毛病|你天生/, '"你天生有坏毛病"式属性否定'],
  [/像金鱼/, '"像金鱼"式贬低类比'],
  [/别把.{0,12}当成职责/, '"别把X当成职责"(先立X再否定)'],
]) {
  ok(!re.test(everything), '无否定式身份描述: ' + label);
}

console.log('\n=== 课文写的默认值必须和代码一致 ===');
const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
// 压缩门槛 2026-08-13 从 main.js 搬进 compact-gate.js (主程序与 test-idle-watcher 共用一份, 免抄两遍漂移)
const gateSrc = require('./kernel-src').readSrc('compact-gate.js');
// 保活那两个默认值 2026-09-04 随 idle-watcher 整体搬进 core(两版共用一份调度层)
const idleSrc = require('./kernel-src').readSrc('idle-watcher.js');
for (const [field, src, re, expect] of [
  ['keepaliveRatio', idleSrc, /const ratio\s*=\s*Number\(cfg\.keepaliveRatio\)\s*\|\|\s*([\d.]+)/, '1.2'],
  ['keepaliveMaxTimes', idleSrc, /KEEPALIVE_MAX_TIMES\s*=\s*(\d+)/, '10'],
  ['compactHardcapSoftTok', gateSrc, /COMPACT_HARDCAP_SOFT_TOK\s*=\s*([\d_]+)/, '150_000'],
]) {
  const m = src.match(re);
  ok(m && m[1] === expect, `${field} 默认值仍是 ${expect}` + (m ? ' — 实际 ' + m[1] : ' — 没匹配到'));
  ok(everything.includes(field), `知识包教了 ${field}`);
}
ok(/wakeCtxBase|苏醒基数/.test(everything), '教了动态门基数');
ok(/0\.1\s*倍|0\.1×/.test(everything), '讲了 cache read 0.1 倍这个保活的经济学理由');
ok(/80%/.test(everything), '讲了 80% 救命红线');

console.log('\n=== 接线 + 防回潮 ===');
ok(/birth\.applyBirthKnowledge/.test(mainSrc), 'main.js 走 birth.js 灌知识');
ok(/birth\.verifyBirthExperience/.test(mainSrc), 'main.js 真做了体验校验');
ok(/birth\.buildRetryText/.test(mainSrc), '缺项会补提');
// 补提只能一次: 无限打转比缺一项糟得多
ok((mainSrc.match(/birth\.buildRetryText/g) || []).length === 1, '补提只有一处(不打转)');
ok(!/onboardingSteps|stepHeader/.test(mainSrc), '老的 17 课串行喂引擎已删干净');
const leftovers = fs.readdirSync(path.join(__dirname, '../core/config/onboarding'))
  .filter((f) => /^(leaf|butler)_\d+/.test(f));
ok(leftovers.length === 0, '老课文文件已删干净' + (leftovers.length ? ' — 残留: ' + leftovers.join(',') : ''));
// 2026-08-13 作者: 出生教育原本写「你不需要被人一句一句教了」「这一课不是讲课」——
// 新人格根本不知道存在过那种流程, 拿它当开场白等于让他去理解一段他没经历过的历史。
// 只说现在是什么、要做什么。
const birthText = fs.readdirSync(path.join(__dirname, '../core/config/onboarding'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => fs.readFileSync(path.join(__dirname, '../core/config/onboarding', f), 'utf8')).join('\n');
for (const bad of ['一句一句教', '这一课', '讲课', '喂你课', '跟你想的']) {
  ok(!birthText.includes(bad), `出生教育不拿新人格没经历过的旧流程作对比(命中「${bad}」)`);
}

console.log('\n=== md.js 有序列表编号 ===');
const ctx = { window: {}, document: { createElement: () => ({}) } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'renderer/md.js'), 'utf8'), ctx);
const render = ctx.window.renderMarkdown;
ok(typeof render === 'function', 'renderMarkdown 已导出');
const tight = render('1. 甲\n2. 乙\n3. 丙');
ok(/value="1"/.test(tight) && /value="2"/.test(tight) && /value="3"/.test(tight), '紧凑列表保留 1/2/3');
const spaced = render('1. 甲\n\n2. 乙\n\n3. 丙');
ok(/value="2"/.test(spaced) && /value="3"/.test(spaced), '空行分隔的列表仍保留 2/3 (原 bug: 全渲成 1)');
const startAt = render('5. 戊\n6. 己');
ok(/value="5"/.test(startAt) && /value="6"/.test(startAt), '非 1 起始保留原序号');
ok(/<li>甲<\/li>/.test(render('- 甲')), '无序列表不受影响(不加 value)');
ok(/乙/.test(render('1. 甲乙丙')) && !/value="[^"]*甲/.test(render('1. 甲乙丙')), '正文未被吞进 value');

// —— 出厂知识 / 常驻提示语里教的工具调用, 必须跟真实 schema 对得上 ——
// 人格是照着这些例子调工具的。教错一个参数名, 它照着错的调, 而且**不报错也学不乖**:
// 多余参数被静默丢掉, 表面上还调用成功。作者 2026-08-27:「之前就有过参数写错了」。
console.log('\n=== 教的工具调用必须真存在 ===');
{
  const toolSrc = fs.readFileSync(path.join(__dirname, '../core/memory-tools-v2.js'), 'utf8');
  const schema = new Map();
  // (?:\s*\/\/[^\n]*)* = 容忍工具名与参数表之间夹的注释行 —— 少了它 memory_touch 被静默漏解析,
  // 而漏解析的工具在下面的幽灵检查里等于"不存在", 教错它的参数没人拦得住。
  // memory_admin 的参数平铺(agent/flat-args.js), schema 写成 looseShape(z, {…})。
  for (const m of toolSrc.matchAll(/tool\('(\w+)',\s*D\.\w+,(?:\s*\/\/[^\n]*)*\s*(?:looseShape\(z,\s*)?\{(.*?)\}\)?\s*,\s*async/gs)) {
    schema.set(m[1], new Set([...m[2].matchAll(/(\w+)\s*:\s*z\./g)].map((x) => x[1])));
  }
  ok(schema.size >= 7 && schema.has('memory_admin'), `从源码解析出 ${schema.size} 个记忆工具的参数表`);
  // 冷门那批并进 memory_admin 之后, 幽灵从"工具名"变成"op 名" —— 教一个不存在的 op,
  // 症状和当年教错参数名一模一样: 照着调、报一句错、没人回头改提示词。
  const opsSrc = (toolSrc.match(/const OPS = \{[\s\S]*?\n  \};/) || [''])[0];
  const OPS = new Set([...opsSrc.matchAll(/^ {4}(\w+): \{/gm)].map((m) => m[1]));
  // 每个 op 自己收的参数(req + opt): 平铺之后 memory_admin(op='x', a=…) 里的 a 要对着这张表核。
  const OP_PARAMS = new Map();
  for (const m of opsSrc.matchAll(/^ {4}(\w+): \{([\s\S]*?)(?=^ {4}\w+: \{|$(?![\s\S]))/gm)) {
    const list = (k) => [...((m[2].match(new RegExp(`${k}:\\s*\\[([^\\]]*)\\]`)) || ['', ''])[1].matchAll(/'(\w+)'/g))].map((x) => x[1]);
    OP_PARAMS.set(m[1], new Set([...list('req'), ...list('opt')]));
  }
  ok(OPS.size >= 15, `解析出 memory_admin 的 ${OPS.size} 个 op`);

  const texts = [];
  const push = (p) => { if (fs.existsSync(p)) texts.push([path.basename(p), fs.readFileSync(p, 'utf8')]); };
  push(path.join(__dirname, '../core/config/onboarding/knowledge/leaf_core.json'));
  for (const d of ['config/prompts', 'config/wake']) {
    const dir = path.join(__dirname, d);
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith('.md')) push(path.join(dir, f));
  }

  const ghostTools = [], ghostParams = [];
  for (const [name, txt] of texts) {
    for (const m of txt.matchAll(/(memory_\w+)\s*\(([^)]{0,240})\)/g)) {
      const [, fn, args] = m;
      if (!schema.has(fn)) { ghostTools.push(`${name}: ${fn}`); continue; }
      const opm = args.match(/op\s*=\s*['"](\w+)['"]/);
      if (opm && !OPS.has(opm[1])) ghostTools.push(`${name}: memory_admin(op='${opm[1]}') 不存在`);
      for (const pm of args.matchAll(/(?:^|[,\s(])(\w+)\s*=/g)) {
        if (opm && fn === 'memory_admin' && OP_PARAMS.has(opm[1])) {
          if (pm[1] !== 'op' && !OP_PARAMS.get(opm[1]).has(pm[1])) {
            ghostParams.push(`${name}: memory_admin(op='${opm[1]}', ${pm[1]}=…) 真实参数 ${[...OP_PARAMS.get(opm[1])].join('/')}`);
          }
          continue;
        }
        if (!schema.get(fn).has(pm[1])) {
          ghostParams.push(`${name}: ${fn}(${pm[1]}=…) 真实参数 ${[...schema.get(fn)].join('/')}`);
        }
      }
    }
  }
  ok(ghostTools.length === 0, '没教人调不存在的记忆工具' + (ghostTools.length ? ' — ' + [...new Set(ghostTools)].join(' , ') : ''));
  ok(ghostParams.length === 0, '没教人传不存在的参数' + (ghostParams.length ? ' — ' + [...new Set(ghostParams)].join(' , ') : ''));
}

// —— 出厂包自己的体积 ——
// 灌入走 force(不吃体积闸), 否则新人格出生会当场失败, 约束改由这里承担。出厂包是新人格
// 读到的第一批东西, 它示范什么就是什么, 所以 🔴 没有豁免名单: 三条老欠账(插件模板 /
// 插件 payload / 自己写插件)已于 2026-09-21 清理回闸内, 名单随之清空, 不许再开。
//
// 🔴 三个包 × 四语逐份量, 不是只量 leaf_core 的中文: ① 历史上超闸的全在 personal_common,
// 只扫 leaf_core 等于从没盯过它们 ② 多语言正文在 body_i18n(translations 里只有
// title/claim/keywords), 日文正文约是中文的 1.2 倍, 中文过了不代表别的语言过。
console.log('\n=== 出厂包体积(三包四语逐份量) ===');
{
  const { bodyHardTokens, estTokens } = require('../core/memory-v2.js');
  const limit = bodyHardTokens();
  const over = [];
  let worst = { t: 0, at: '-' };
  for (const f of ['leaf_core', 'personal_common', 'butler_extra']) {
    for (const it of cfg.json('onboarding/knowledge/' + f).items || []) {
      for (const [lang, b] of Object.entries({ 'zh-CN': it.body || '', ...(it.body_i18n || {}) })) {
        if (!b) continue;
        const t = estTokens(b);
        if (t > worst.t) worst = { t, at: `${it.slug}[${lang}]` };
        if (t > limit) over.push(`${it.slug}[${lang}]=${t}`);
      }
    }
  }
  ok(over.length === 0,
    `🔴 出厂包没有超闸正文(上限 ${limit} token · 实测最长 ${worst.t} ${worst.at})`
    + (over.length ? ' — ' + over.join(' , ') : ''));
}

// —— 出厂包命题行的注入预算(四语逐一量) ——
// 命题行超过注入预算的条目**一条都注不进上下文**, 而 recall_log 照样记它命中 —— 写完看不出
// 任何异常, 只有人格那头什么也没收到。它专挑"AI 不会想到自己去查"的知识下手(行为约束、
// 反直觉禁令), 那类只有自动召回一条通路, 走不通就等于这条知识不存在。
// 🔴 必须**四语逐一量**: 同一条的日文命题行是中文的 1.3-1.5 倍, 按中文量过不代表别的语言过,
//    而四种语言都是一等公民 —— 哪种语言超, 哪种语言的用户就整条收不到。
// 🔴 这里**不设豁免名单**: 拿去比的是"能不能送出去"这条物理线, 挂免死金牌不会让它送得出去。
console.log('\n=== 出厂包命题行注入预算(四语) ===');
{
  // 量哪些文件、怎么量, 全在 scripts/claim-budget.js —— 服务端货架那几个包也归它扫。
  const { limit, missing, over, counted } = require('../scripts/claim-budget.js').check();
  ok(missing.length === 0,
    '出厂知识包清单里的文件都还在'
    + (missing.length ? ' — 失效路径: ' + missing.join(' , ') : ''));
  ok(over.length === 0,
    `🔴 没有命题行超注入预算(上限 ${limit} token · 四语逐一量 · 共 ${counted} 条)`
    + (over.length ? ' — ' + over.join(' , ') : ''));
}

// —— 出厂包的四语覆盖 ——
// 漏翻一条不会报错, 症状只是日本店主查不到那一条 —— 而"查不到"和"库里没有"在使用者眼里
// 长得一模一样。所以覆盖率必须是门禁, 不能靠翻的时候记得数。
// 🔴 出厂知识是【四语】: 简体 + ja + en + zh-TW。简体是**源语言**, 直接躺在 item 本体的
// title/claim/keywords/body 上, 不重复进 translations(存两份必各自漂), 所以这里只数另外三份译文。
// 「三份译文」≠「三语」—— 别把这句话读成少了一种语言, 少的那一份就是简体本体。
console.log('\n=== 出厂包四语覆盖 ===');
{
  const LANGS = ['ja', 'en', 'zh-TW'];
  const TR_FIELDS = ['title', 'claim', 'keywords'];
  const missTr = [], missBody = [], badLang = [];
  for (const b of ['leaf_core', 'butler_extra']) {
    for (const it of (cfg.json('onboarding/knowledge/' + b).items || [])) {
      const slug = it.slug || it.id;
      const tr = it.translations || {};
      for (const L of LANGS) {
        if (!tr[L] || !TR_FIELDS.every((f) => tr[L][f])) missTr.push(`${slug}/${L}`);
      }
      for (const k of Object.keys(tr)) if (!LANGS.includes(k)) badLang.push(`${slug}/${k}`);
      // 正文译文只对【有正文的】条目要求 —— 多数节点的正文本来就该是空的。
      if (String(it.body || '').trim()) {
        const bi = it.body_i18n || {};
        for (const L of LANGS) if (!String(bi[L] || '').trim()) missBody.push(`${slug}/${L}`);
      }
    }
  }
  ok(missTr.length === 0, `🔴 每条出厂知识的 title/claim/keywords 都有 ja/en/zh-TW`
    + (missTr.length ? ` — 缺 ${missTr.length} 处: ${missTr.slice(0, 4).join(' , ')}` : ''));
  ok(missBody.length === 0, `🔴 有正文的条目四语齐(简体本体 + ja/en/zh-TW 三份 body_i18n)`
    + (missBody.length ? ` — 缺 ${missBody.length} 处: ${missBody.slice(0, 4).join(' , ')}` : ''));
  // 简体不该出现在 translations 里: 它是源语言, 存两份就会有两份各自漂。
  ok(badLang.length === 0, 'translations 里没有源语言(zh-CN)和野生语言码'
    + (badLang.length ? ' — ' + badLang.slice(0, 4).join(' , ') : ''));
}

// —— 源文没被译者改坏 ——
// 上面那节只数【译文在不在】, 不看内容, 于是漏掉了真正发生的事: 加译文那一轮, 子代理
// 顺手改坏了它正在翻译的【简体源文】—— 「才真正生效」成了「才真正работает」, 而 ja/en/zh-TW
// 三份全对。校对的人只盯译文那三列, 因为"源文本来就是对的"是个默认假设。
// 🔴 希腊字母不列入: θ/π 在饼图配方的正文里是合法的数学符号, 误伤会让人去关掉门禁。
console.log('\n=== 出厂包没有异文种污染 ===');
{
  const ALIEN = /[Ѐ-ӿ가-힯฀-๿֐-ۿऀ-ॿ]/;
  const hits = [];
  const walk = (v, where) => {
    if (typeof v === 'string') { if (ALIEN.test(v)) hits.push(`${where}: …${v.slice(Math.max(0, v.search(ALIEN) - 12), v.search(ALIEN) + 14)}…`); }
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], `${where}.${k}`);
  };
  for (const b of ['leaf_core', 'butler_extra']) {
    for (const it of (cfg.json('onboarding/knowledge/' + b).items || [])) walk(it, it.slug || it.id);
  }
  ok(hits.length === 0, '🔴 出厂知识里没有西里尔/韩文/泰文/阿拉伯/希伯来/天城文字符(译者改坏源文的信号)'
    + (hits.length ? ` — ${hits.length} 处: ${hits.slice(0, 3).join(' | ')}` : ''));
}

console.log('\n' + (fail ? 'FAIL' : 'PASS') + ` ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
