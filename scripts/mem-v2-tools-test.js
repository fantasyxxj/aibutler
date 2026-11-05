#!/usr/bin/env node
// mem-v2-tools-test.js — memory-tools-v2.js 的 MCP 工具层测试。
// 用法: node scripts/mem-v2-tools-test.js
//
// 用 mock 的 tool()/z 跑, 不拉 MCP SDK —— 测的是【工具吐给 AI 的文本对不对】,
// 不是 SDK 会不会注册。因为这一层真正的失败模式是"能调通但返回值没法用":
// 返回一串数字 id 而不带命题, 调用是成功的, 我拿到手却是瞎的。

require('../personal/host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const { MemoryGraphV2 } = require('../core/memory-v2');
const { registerMemoryToolsV2 } = require('../core/memory-tools-v2');

const DIR = '/tmp/mem-v2-tools-test';
fs.rmSync(DIR, { recursive: true, force: true });

// —— 最简 mock: z 只需支持链式 optional/describe, tool 只需收下四个参数 ——
const mk = () => { const o = { optional: () => o, describe: () => o }; return o; };
const z = { string: mk, number: mk, boolean: mk, enum: mk, array: mk, object: mk, record: mk, any: mk };
const tool = (name, desc, schema, handler) => ({ name, desc, schema, handler });

const g = new MemoryGraphV2(DIR);
g.actor = '码上飞';
const tools = registerMemoryToolsV2({ tool, z, graph: g });
const T = Object.fromEntries(tools.map((t) => [t.name, t]));

// 冷门那十七件 2026-09-07 并进 memory_admin(op, args) —— 常驻每一轮都在为每件工具的
// 说明 + 参数 schema 付钱, 而这批合计只占记忆工具调用量的 7.5%。测试沿用老名字调用,
// 由这张表转成 op: 这样每条断言测的仍是"这个动作的返回值对不对", 而路由本身也被跑到了。
const MERGED = { memory_doctor: 'doctor', memory_timeline: 'timeline', memory_neighbors: 'neighbors',
  memory_revisions: 'revisions', memory_link_bidirectional: 'link', memory_pinned: 'pinned',
  memory_set_pinned: 'set_pinned', memory_set_importance: 'set_importance', memory_set_redline: 'set_redline',
  memory_redlines: 'redlines', memory_semantic: 'semantic', memory_arbitrate: 'arbitrate',
  memory_conflict_scan: 'conflict_scan', memory_conflict_settle: 'conflict_settle',
  memory_review_split: 'split', memory_chores: 'chores', memory_chore_done: 'chore_done' };
const call = async (name, args = {}) => {
  const r = MERGED[name]
    ? await T.memory_admin.handler({ op: MERGED[name], args })
    : await T[name].handler(args);
  return r.content[0].text;
};

const results = [];
const t = async (name, fn) => {
  try { const d = await fn(); results.push({ ok: true, name, detail: d || '' }); }
  catch (e) { results.push({ ok: false, name, detail: e.message }); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => assert(a === b, `${m} — 期望 ${JSON.stringify(b)}, 实得 ${JSON.stringify(a)}`);

(async () => {

// 7 = 常用六件(query/upsert/section/write/touch/hot)+ memory_admin。
// 🔴 这个数是**成本闸**, 不是记账: 每多注册一件就是一份说明加一份参数 schema 每轮常驻。
//    要加工具先答一句「它凭什么值得每轮都收费」—— 答不上来就该是 memory_admin 的一个 op。
await t('7 个工具全部注册, 名字无重复', () => {
  eq(tools.length, 7, '工具数');
  eq(new Set(tools.map((x) => x.name)).size, 7, '有重名');
  const names = tools.map((x) => x.name);
  assert(!names.includes('memory_append'), '🔴 append 已被 write 取代, 不该还留在工具集里');
  assert(!names.includes('memory_supersede_section'), '🔴 段级失效随「段」这个概念一起撤掉了');
  for (const gone of Object.keys(MERGED)) {
    assert(!names.includes(gone), `🔴 ${gone} 该并进 memory_admin, 不该再单独注册`);
  }
  for (const must of ['memory_section', 'memory_write', 'memory_admin']) {
    assert(names.includes(must), `缺 ${must}`);
  }
  return names.map((x) => x.replace('memory_', '')).join(' ');
});

await t('每个工具都有非空描述(描述是我唯一的使用说明)', () => {
  const empty = tools.filter((x) => !x.desc || x.desc.length < 10);
  assert(!empty.length, `描述缺失: ${empty.map((x) => x.name).join(', ')}`);
  return '全部有';
});

// 合并的代价是参数不再有 schema 级校验, 所以工具必须自己把参数表说清楚 ——
// 说不清就等于这十七件功能没人会用。
await t('op 写错时给出合法 op 全表', async () => {
  const out = await call('memory_admin', { op: 'nonexistent_op' });
  assert(out.includes('unknown op'), '没说是 op 不认识');
  assert(out.includes('doctor') && out.includes('chore_done'), `没列出合法 op: ${out}`);
  return out.slice(0, 60);
});

await t('缺必填参数时报出该 op 的参数表', async () => {
  const out = await call('memory_admin', { op: 'set_importance', args: { id: 'x' } });
  assert(out.includes('missing') && out.includes('importance'), `没指出缺谁: ${out}`);
  assert(out.includes('args:'), `没给参数表: ${out}`);
  return out.replace(/\n/g, ' ').slice(0, 90);
});

await t('op 内部抛错不炸整轮, 连参数表一起回', async () => {
  const out = await call('memory_admin', { op: 'set_importance', args: { id: 'does_not_exist_at_all', importance: 'high' } });
  assert(out.includes('❌'), `没兜住: ${out}`);
  return out.replace(/\n/g, ' ').slice(0, 90);
});

await t('upsert 沉淀成功并回显命题', async () => {
  const out = await call('memory_upsert', {
    id: 'feedback_ship_order_dev_first', title: 'dev 测试先于打包', type: 'feedback', importance: 'high',
    claim: '命题: 改完代码必须先在 dev 环境跑通再打包, 直接打包替换等于把未验证的代码送进生产',
    keywords: '打包 上线 出货 部署 验证', body: '2026-07-22 越权事故的产物。',
  });
  assert(out.includes('✅ 沉淀'), out);
  assert(out.includes('命题:'), `返回值没回显命题: ${out}`);
  assert(out.includes('新建'), `没标出是新建还是更新: ${out}`);
  return out.split('\n')[0];
});

await t('🔴 query 返回值带命题, 不是只有编号', async () => {
  await call('memory_upsert', { id: 'reference_pinned_is_most_used', title: 'pinned 是最常用',
    type: 'reference', claim: '命题: pinned 的判据是最常查而非最重要, 与 importance 正交必须分表',
    keywords: '置顶 配额 正交', confirm_new: true });
  const out = await call('memory_query', { query: '打包' });
  assert(out.includes('命题:'), `检索结果没带命题: ${out}`);
  assert(out.includes('feedback_ship_order_dev_first'), 'slug 没露出, 人读不了');
  return out.split('\n')[1].trim().slice(0, 40) + '…';
});

// —— 兜底交付(2026-08-17 作者拍板「宁多勿少, ai 可以参与判断」) ——
// 锁的是"够不上闭嘴线的东西还在不在输出里", 不是段头怎么措辞。

await t('🔴 兜底: 够不上闭嘴线的不再被吞掉, 而是单独成段摆出来', async () => {
  const out = await call('memory_query', { query: '打包 柴犬 疫苗 房贷 睡莲 陶笛 苔藓 风筝 沙丘' });
  assert(!out.startsWith('(库里没有'), `本该有兜底可给, 却报了库里没有: ${out}`);
  assert(out.includes('兜底'), `低档条目没有单独成段: ${out}`);
  return out.split('\n').filter((l) => l.includes('○')).length + ' 条兜底';
});

await t('🔴 兜底条目和够格命中分开渲染 —— 混在一起等于分档白做', async () => {
  const out = await call('memory_query', { query: '打包 柴犬 疫苗 房贷 睡莲 陶笛 苔藓 风筝 沙丘' });
  const i = out.indexOf('兜底');
  const weakLines = out.slice(i).split('\n').filter((l) => l.trim().startsWith('○'));
  assert(weakLines.length, '兜底段里一条都没有');
  // 兜底行必须带 via, 因为关键词误命中一眼可辨而语义误命中似是而非, 判它们要用不同标准
  for (const l of weakLines) assert(/\[[^\]]+\]/.test(l), `兜底行没带 via/把握度: ${l}`);
  return weakLines[0].trim().slice(0, 48) + '…';
});

await t('🔴 兜底不许挤占够格条目的名额', async () => {
  const out = await call('memory_query', { query: '打包' });
  const i = out.indexOf('兜底');
  const solidPart = i === -1 ? out : out.slice(0, i);
  assert(solidPart.includes('feedback_ship_order_dev_first'),
    `够格的条目被挤到兜底段或挤没了: ${out}`);
  return '够格的仍在正文段';
});

await t('兜底条目不算"用过" —— 摆出来供判断 ≠ 用了它', async () => {
  const hits = [];
  const g2 = new MemoryGraphV2('/tmp/mem-v2-tools-test-onhit');
  fs.rmSync('/tmp/mem-v2-tools-test-onhit', { recursive: true, force: true });
  const g3 = new MemoryGraphV2('/tmp/mem-v2-tools-test-onhit');
  g3.actor = '码上飞';
  const T2 = Object.fromEntries(registerMemoryToolsV2({ tool, z, graph: g3, onHit: (id) => hits.push(id) })
    .map((x) => [x.name, x]));
  await T2.memory_upsert.handler({ id: 'feedback_pack_first', title: '先测后打包', type: 'feedback',
    claim: '命题: 改完代码必须先在 dev 跑通再打包', keywords: '打包 上线 部署' });
  hits.length = 0;
  const r = await T2.memory_query.handler({ query: '打包 柴犬 疫苗 房贷 睡莲 陶笛 苔藓 风筝 沙丘' });
  const text = r.content[0].text;
  const i = text.indexOf('兜底');
  if (i !== -1) {
    for (const l of text.slice(i).split('\n').filter((x) => x.trim().startsWith('○'))) {
      const m = l.match(/#(\d+)/);
      if (m) assert(!hits.includes(Number(m[1])) && !hits.includes(m[1]),
        `兜底条目 ${m[1]} 被当成用过强化了`);
    }
  }
  void g2;
  return `强化了 ${hits.length} 条`;
});

await t('连兜底都没有才说库里没有 —— 这时才是真没有', async () => {
  const out = await call('memory_query', { query: 'zzzqqq' });
  assert(out.startsWith('(库里没有'), `真空场景该明说库里没有: ${out}`);
  return out.split('\n')[0];
});

await t('查重挡门拦住高度重合的新建, 并给出三条出路', async () => {
  const out = await call('memory_upsert', {
    id: 'feedback_ship_order_dev_first_again', title: 'dev 测试先于打包',
    claim: '命题: 改完代码必须先在 dev 环境跑通再打包, 直接打包替换等于把未验证的代码送进生产',
    keywords: '打包 上线 出货 部署 验证',
  });
  assert(out.includes('挡门'), `没挡住: ${out}`);
  assert(out.includes('memory_write'), '没给合并出路');
  assert(out.includes('confirm_new'), '没给强建出路');
  return '挡住并给了 (a)(b)(c)';
});

await t('section 读得到整条正文和凭据', async () => {
  const out = await call('memory_section', { node: 'feedback_ship_order_dev_first' });
  assert(out.includes('base_hash'), '必须给出 base_hash');
  assert(out.includes('越权事故'), '必须回显内容');
  return out.split('\n')[1];
});

await t('🔴 write 改正文, 不带凭据要被拦', async () => {
  let err = '';
  try {
    await call('memory_write', { node: 'feedback_ship_order_dev_first', content: '想直接盖掉' });
  } catch (e) { err = e.message; }
  assert(err.includes('memory_section'), `应拦下并告诉去哪读, 实得: ${err}`);
  return err.split('\n')[0];
});

await t('write 带凭据改正文, 回吐新指纹', async () => {
  const read = await call('memory_section', { node: 'feedback_ship_order_dev_first' });
  const hash = (read.match(/base_hash: (\w+)/) || [])[1];
  const out = await call('memory_write', { node: 'feedback_ship_order_dev_first',
    content: '越权事故的产物。', base_hash: hash, reason: '删掉正文里的日期' });
  assert(out.includes('✅ 改写正文'), out);
  assert(out.includes('base_hash'), '🔴 必须回吐新指纹, 否则接着改还得重读一次');
  assert(/少 \d+ 字符/.test(out), '要把缩了多少印出来 —— write 的职责就是让正文变短或持平');
  return out.split('\n')[0];
});

// 🔴 便宜的口子只会被用来加: 实测 write 262 次改正文有 251 次在变长(平均 +603 字符),
// 同期 upsert 平均缩 91 字符。所以 write 被钉死在"改"上, 要加内容得去付 upsert 全量的钱。
await t('🔴 write 不许把正文写长, 报错指向 upsert', async () => {
  const read = await call('memory_section', { node: 'feedback_ship_order_dev_first' });
  const hash = (read.match(/base_hash: (\w+)/) || [])[1];
  let err = '';
  try {
    await call('memory_write', { node: 'feedback_ship_order_dev_first',
      content: '这是一段明显更长的内容, 用来验证不许变长这道闸。', base_hash: hash });
  } catch (e) { err = e.message; }
  assert(err.includes('memory_upsert'), `应拦下并指向 upsert, 实得: ${err}`);
  return err.split('\n')[0];
});

await t('hot 列表每条都带命题', async () => {
  const out = await call('memory_hot', { k: 5 });
  assert(out.includes('命题:'), `hot 没带命题, 起床看这个等于白看: ${out}`);
  return out.split('\n')[0];
});

await t('🔴 set_importance 不接受 pinned, 并指路 set_pinned', async () => {
  // memory_admin 把 op 内部的抛错兜成 ❌ 文本(顺带把该 op 的参数表一起回), 所以读返回值不读异常。
  let msg = '';
  try { msg = await call('memory_set_importance', { id: 'feedback_ship_order_dev_first', importance: 'pinned' }); }
  catch (e) { msg = e.message; }
  assert(msg.includes('setPinned') || msg.includes('high/med/low'), `应挡住 pinned, 实得: ${msg}`);
  return '挡住了';
});

await t('set_pinned 置顶 + pinned 列表带命题', async () => {
  await call('memory_set_pinned', { id: 'feedback_ship_order_dev_first', reason: '最常查' });
  const out = await call('memory_pinned');
  assert(out.includes('pinned 1/30'), `配额没显示: ${out}`);
  assert(out.includes('命题:'), 'pinned 列表没带命题');
  return out.split('\n')[0];
});

await t('🔴 红线独立于 pinned, 同一条可兼任且要填正确做法', async () => {
  await call('memory_set_redline', { id: 'feedback_ship_order_dev_first',
    trigger_pattern: 'dist|build|打包|electron-builder',
    correct_action: '先起 dev 跑通全链路, 再 bump 版本号, 再打包' });
  const out = await call('memory_redlines');
  assert(out.includes('正确做法'), `红线没带正确做法 —— 只说不许干什么等于没说: ${out}`);
  const pin = await call('memory_pinned');
  assert(pin.includes('pinned 1/30'), '标红线不该占用 pinned 配额');
  return '红线1 · pinned 仍 1/30';
});

await t('🔴 arbitrate 之后, 召回老结论会强制附带「已被推翻」', async () => {
  await call('memory_upsert', { id: 'feedback_relay_via_butler', title: '跨人格走管家中转',
    type: 'feedback', claim: '命题: 找别的人格要先经过管家中转, 不直接联系', keywords: '中转 人格 通信', confirm_new: true });
  await call('memory_upsert', { id: 'feedback_contact_direct', title: '跨人格一律直连',
    type: 'feedback', claim: '命题: 找任何人格一律直接联系本人, 没有中转站', keywords: '直连 人格 通信', confirm_new: true });
  const arb = await call('memory_arbitrate', { winner: 'feedback_contact_direct', loser: 'feedback_relay_via_butler', reason: '2026-08 已改口径' });
  assert(arb.includes('推翻'), arb);
  const out = await call('memory_query', { query: '中转' });
  assert(out.includes('已被推翻'), `召回时没附带推翻提示 —— 这正是骗过我 4 次的机制: ${out}`);
  assert(out.includes('直接联系'), '没把推翻者的命题带出来');
  return '召回即告警';
});

await t('arbitrate 可撤销', async () => {
  const out = await call('memory_arbitrate', { winner: 'feedback_contact_direct', loser: 'feedback_relay_via_butler', undo: true });
  assert(out.includes('撤销'), out);
  const q = await call('memory_query', { query: '中转' });
  assert(!q.includes('已被推翻'), '撤销后不该还有推翻提示');
  await call('memory_arbitrate', { winner: 'feedback_contact_direct', loser: 'feedback_relay_via_butler' });
  return '撤销并复位';
});

await t('neighbors / timeline / touch 都带命题', async () => {
  await call('memory_link_bidirectional', { from_id: 'feedback_ship_order_dev_first', to_id: 'reference_pinned_is_most_used' });
  const nb = await call('memory_neighbors', { id: 'feedback_ship_order_dev_first' });
  assert(nb.includes('命题:'), `neighbors 没带命题: ${nb}`);
  const tl = await call('memory_timeline', { k: 3 });
  assert(tl.includes('命题:'), 'timeline 没带命题');
  const tc = await call('memory_touch', { ids: ['feedback_ship_order_dev_first'] });
  assert(tc.includes('used='), `touch 没回显计数: ${tc}`);
  return '三个都带';
});

await t('revisions 读得到修订历史(取代 _revisions 分片)', async () => {
  await call('memory_upsert', { id: 'feedback_ship_order_dev_first',
    claim: '命题: 改完代码必须先在 dev 跑通再打包, 且 dev 有独立 userData 不污染生产' });
  const out = await call('memory_revisions', { id: 'feedback_ship_order_dev_first' });
  assert(out.includes('旧:') && out.includes('新:'), `没给出前后对比: ${out}`);
  assert(out.includes('claim'), '没标出改的是哪个字段');
  return out.split('\n')[0];
});

await t('doctor 报得出缺命题/孤岛/配额', async () => {
  const out = await call('memory_doctor');
  assert(/节点 \d+/.test(out), out);
  assert(out.includes('pinned 1/30'), '没报配额');
  return out.split('\n')[0];
});

await t('neighbors 对孤岛节点给出可操作的提示', async () => {
  await call('memory_upsert', { id: 'reference_lonely_island', title: '孤岛',
    type: 'reference', claim: '命题: 这条谁也没连', confirm_new: true });
  const out = await call('memory_neighbors', { id: 'reference_lonely_island' });
  assert(out.includes('孤岛') || out.includes('建议'), `孤岛提示不够具体: ${out}`);
  return out;
});

await t('找不到的节点给明确报错而不是空结果', async () => {
  const out = await call('memory_neighbors', { id: 'does_not_exist_at_all' });
  assert(out.includes('❌'), `应明确报找不到: ${out}`);
  return out;
});

// —— 兜底命题标记: review_queue 退役后唯一留下的那个位 ————————————
// 2026-08-17 作者:「那个 review 的合并了吧, 不用特殊做一个事务了」。take/settle 一起退役 ——
// 改命题直接 memory_upsert 就是, 不需要专门的交件工具; 还没还的账由定期体检反复戳。
await t('兜底命题进得了 doctor 的「缺命题」(否则这批账再没通路被提起)', async () => {
  const nid = g.store.upsertNode({ slug: 't_provisional', title: '兜底样本',
    claim: '这是旧摘要兜底来的', type: 'reference' });
  g.store.markClaimProvisional([nid]);
  const out = await call('memory_doctor');
  assert(/缺命题/.test(out), `命题非空但是兜底的, doctor 得数进来: ${out}`);
  return out.split('\n').find((l) => l.includes('缺命题')) || out.slice(0, 60);
});

await t('改写命题 = 还账, 标记自动落下(不需要谁去标 done)', async () => {
  await call('memory_upsert', { id: 't_provisional', description: '兜底样本',
    body: '正文', claim: '命题: 兜底命题必须被换掉' });
  eq(g.store.nodeBySlug('t_provisional').claim_provisional, 0, '🔴 命题改了标记没清 —— 会被体检永远戳下去');
  return '标记已清零';
});

await t('review_split: 真拆成多条 · 继承边 · 老节点标失效', async () => {
  const other = g.store.upsertNode({ slug: 't_neighbor', title: '邻居', claim: '邻居命题', type: 'reference' });
  const big = g.store.upsertNode({ slug: 't_big', title: '大节点', claim: '兜底大', type: 'reference',
    body: '## 甲\n甲的内容\n\n## 乙\n乙的内容' });
  g.store.addEdge(big, other, 'relates', 'human');
  const out = await call('memory_review_split', { id: 't_big', parts: [
    { slug: 't_big_jia', claim: '命题: 甲成立', body: '甲的内容', type: 'reference' },
    { slug: 't_big_yi', claim: '命题: 乙成立', body: '乙的内容', type: 'reference' },
  ] });
  const jia = g.store.nodeBySlug('t_big_jia');
  const yi = g.store.nodeBySlug('t_big_yi');
  assert(jia && yi, '新节点没建出来');
  eq(g.store.node(big).status, 'superseded', '老节点没标失效');
  assert(String(g.store.bodiesOf([big]).get(big) || '').includes('甲的内容'), '老节点正文被删了 —— 拆错要能回头看');
  const jiaEdges = g.store.edgesOf(jia.id);
  assert(jiaEdges.some((e) => e.dst === other || e.src === other), '没继承老节点的邻居边');
  assert(jiaEdges.some((e) => e.rel === 'supersedes' && e.dst === big), '没连 supersedes 回老节点');
  assert(jiaEdges.some((e) => e.dst === yi.id || e.src === yi.id), '同源两片没互连');
  return out.split('\n')[0];
});

await t('review_split: 少于 2 片直接拒(那不叫拆)', async () => {
  g.store.upsertNode({ slug: 't_nosplit', title: '单片', claim: '兜底', type: 'reference' });
  const out = await call('memory_review_split', { id: 't_nosplit', parts: [
    { slug: 't_nosplit_only', claim: '命题: 只有一片', type: 'reference' }] });
  assert(out.includes('❌'), out);
  eq(g.store.nodeBySlug('t_nosplit_only'), null, '被拒了却已经建了节点');
  return out;
});

g.close();
const pass = results.filter((r) => r.ok).length;
console.log('');
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);

})();
