// test-upsert-fields.js — upsert 字段语义的门禁: base_hash 正文闸 + provisional/status
// 跑法: node test-upsert-fields.js
//
// 两组不变量, 都是同一件事的两面 —— **不传的字段不许动, 传了的字段不许被别处悄悄改回去**:
//   ① 传 body 冲掉已有正文必须出示 base_hash。memory_query 只给命题不给正文, 所以
//      "查到了这条记忆" ≠ "知道它正文写了什么"; 没有这道闸, "我读过了"永远只是自觉。
//   ② provisional 显式传了就不许被"改命题自动清零"那条规则抹掉 —— 边改命题边标成临时(=2)
//      正是讨论中命题的典型写法, 抹掉它等于这个档位根本落不下来。
require('./host-wiring');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MemoryGraphV2, bodyHardTokens } = require('../core/memory-v2');
const { renderHit } = require('../core/memory-tools-v2');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-upsert-fields-'));
const g = new MemoryGraphV2(dir);

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { console.log(`  ✓ ${l}`); pass++; } else { console.log(`  ✗ ${l}`); fail++; } };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message || String(e); } };
const cp = (slug) => g.store.node(g.resolve(slug)).claim_provisional;
const bodyOf = (slug) => g.store.bodiesOf([g.resolve(slug)]).get(g.resolve(slug)) || '';

console.log('\n[1] base_hash 正文闸');
g.upsert({ slug: 'reference_gate', claim: '命题: 闸门测试节点', type: 'reference', body: '原有正文, 八个字。' });
ok(bodyOf('reference_gate') === '原有正文, 八个字。', '新建时传 body 不需要 hash');

const noHash = throws(() => g.upsert({ slug: 'reference_gate', body: '想偷偷换掉' }));
ok(/base_hash|memory_section/.test(noHash || ''), `不带 base_hash 覆盖已有正文 → 拒写 (${(noHash || '没抛错').slice(0, 30)})`);
ok(bodyOf('reference_gate') === '原有正文, 八个字。', '🔴 拒写之后正文一个字都没动(不是先写后回滚)');

const badHash = throws(() => g.upsert({ slug: 'reference_gate', body: '换掉', base_hash: 'deadbeef' }));
ok(/hash/.test(badHash || ''), 'hash 对不上 → 拒写(你读到之后它被人改过)');

const h = g.wholeBody('reference_gate').hash;
g.upsert({ slug: 'reference_gate', body: '换成新正文' , base_hash: h });
ok(bodyOf('reference_gate') === '换成新正文', '带对 hash → 正常替换');

// partial 语义: 这条是 ② 那批过期文案的根 —— 以为改任何字段都要重写 body, 于是宁可堆段
g.upsert({ slug: 'reference_gate', claim: '命题: 改了命题但没碰正文' });
ok(bodyOf('reference_gate') === '换成新正文', '🔴 只改 claim 不传 body → 正文一个字不掉, 且不需要 hash');

g.upsert({ slug: 'reference_empty', claim: '命题: 正文本来就是空的', type: 'reference' });
g.upsert({ slug: 'reference_empty', body: '第一次写正文' });
ok(bodyOf('reference_empty') === '第一次写正文', '原正文为空 → 传 body 不要 hash(没东西可冲掉)');

g.upsert({ slug: 'reference_gate', body: '权威下发直接盖', force_overwrite: true });
ok(bodyOf('reference_gate') === '权威下发直接盖', 'force_overwrite 绕闸(留给 factory-sync/教育包这类程序调用方)');

console.log('\n[2] provisional 落值');
g.upsert({ slug: 'reference_p_default', claim: '命题: 默认档', type: 'reference' });
ok(cp('reference_p_default') === 0, '不传 → 默认 0(判过了)');

g.upsert({ slug: 'reference_p_temp', claim: '命题: 讨论中', type: 'reference', provisional: 2 });
ok(cp('reference_p_temp') === 2, '新建传 2 → 落成 2');

g.upsert({ slug: 'reference_p_temp', claim: '命题: 讨论中(改了措辞)' });
ok(cp('reference_p_temp') === 0, '改命题但没传 provisional → 沿用"改写即判过"自动清零');

g.upsert({ slug: 'reference_p_temp', claim: '命题: 又改了措辞', provisional: 2 });
ok(cp('reference_p_temp') === 2,
  '🔴 边改命题边传 2 → 保住 2 (想法一变就重写命题, 但它仍然没判过真假 —— 自动清零不许抹掉显式值)');

const badVal = throws(() => g.upsert({ slug: 'reference_p_temp', provisional: 7 }));
ok(/0|1|2/.test(badVal || ''), `非法档位当场挡下 (${(badVal || '没抛错').slice(0, 24)})`);

g.upsert({ slug: 'reference_p_default', status: 'superseded' });
ok(g.store.node(g.resolve('reference_p_default')).status === 'superseded',
  'status 从工具层写得进去(没有顶替者的退休走这条)');

console.log('\n[3] 带出检索面 + 只标 =2');
g.upsert({ slug: 'reference_q_judged', claim: '命题: 麒麟纹已判过', type: 'reference', keywords: '麒麟纹' });
g.upsert({ slug: 'reference_q_temp', claim: '命题: 麒麟纹也许该加权', type: 'reference', keywords: '麒麟纹', provisional: 2 });
g.upsert({ slug: 'reference_q_legacy', claim: '命题: 麒麟纹旧摘要垫的', type: 'reference', keywords: '麒麟纹', provisional: 1 });
// query() 直接返回结果数组, 不是 {hits:[...]} —— 包一层是照着别处的印象写的, 会静默拿到 0 条
const hits = g.query('麒麟纹', { k: 5 });
const byslug = Object.fromEntries(hits.map((x) => [x.slug, x]));
ok(hits.length >= 3 && byslug.reference_q_temp, `检索拿得到三条 (${hits.length})`);
ok(byslug.reference_q_temp && byslug.reference_q_temp.claim_provisional === 2,
  '🔴 claim_provisional 跟着结果出去了(留在引擎里的话渲染层永远判不出来)');
ok(/⚠️provisional·unverified/.test(renderHit(byslug.reference_q_temp)), '=2 渲染出强提示');
ok(byslug.reference_q_legacy && !/⚠️provisional·unverified/.test(renderHit(byslug.reference_q_legacy)),
  '🔴 =1 不标 —— 存量 974/1450 全打同一个标就成了背景花纹, 连 =2 的提示都会被一起稀释');
ok(!/⚠️provisional·unverified/.test(renderHit(byslug.reference_q_judged)), '=0 不标');

console.log('\n[4] doctor 按值分开催');
const probs = g.doctor().problems.filter((p) => /claim|provisional/.test(p.kind));
const temp = probs.find((p) => /provisional claim not settled/.test(p.kind));
const legacy = probs.find((p) => /claim pending true\/false judgement/.test(p.kind));
ok(!!temp && !!legacy, '两类分开报(合成一条的话少数 =2 会被 =1 的量冲得永远露不出来)');
ok(temp && temp.sample.every((s) => /\(/.test(s)), '=2 的样本带上"多久没动"(它按放置时长烂, 不按热度烂)');
ok(temp && /Settle:|superseded/.test(temp.hint || ''), '=2 的 hint 给了两条出路: 落定 或 退休');
ok(legacy && /Do NOT pass body/.test(legacy.hint || ''), '=1 的 hint 仍提醒只改 claim 别传 body');
ok(legacy && /this checkup is the only entry point/.test(legacy.hint || ''),
  '🔴 =1 的 hint 说明白它不在检索结果里露出来 —— 否则会以为"没看见标记就是没有欠账"');

console.log('\n[5] 写入回执: 有触发条件才响, 不许常亮');
{
  const notes = (r) => (r.notes || []).join('\n');

  // 正文要满足两个条件才算"干净": ① 够长 —— write 只许改不许加, 从三个字起步后面一次都改不动
  // ② 带命令/路径 —— 否则会触发「这段是不是在复述命题」那条提示, 那条守的正是"不许常亮"。
  const clean = g.upsert({ slug: 'reference_r_clean', claim: '命题: 干净的一条', type: 'reference',
    body: '照 core/memory-v2/write.js 那条路走, 留出后面几次缩短的余地。' });
  ok((clean.notes || []).length === 0,
    '🔴 干净的写入一条提示都不出 —— 常亮的提示两天就读成噪音, 那时该看的那条也跟着废');

  const dated = g.upsert({ slug: 'reference_r_dated', claim: '命题: 2026-08-16 完工了某事', type: 'reference' });
  ok(/There is a date in the claim line/.test(notes(dated)) && /part of the claim/.test(notes(dated)),
    'claim 带日期 → 问它"日期是命题的一部分吗"(只提示不拦截: 有些日期真的是命题本身)');

  const chron = g.upsert({ slug: 'reference_r_chron', claim: '命题: 正文在记流水账', type: 'reference',
    body: '2026-08-01 甲\n2026-08-11 乙\n2026-08-20 丙' });
  ok(/change history/.test(notes(chron)) && /memory_revisions/.test(notes(chron)),
    '正文 ≥3 个日期 → 问哪些是变化史, 并告诉它 history 全量存着所以删了不丢');

  // 行数闸已废, 提示改看 token 数(纯拉丁按 4 字符 1 token)。而且提示语点名的是「论证」
  // 不是笼统的"太长了" —— 泛泛说太长, 人删掉的多半是操作细节; 而实测正文膨胀的主体
  // 是当初说服自己的那段推理链。
  const long = g.upsert({ slug: 'reference_r_long', claim: '命题: 正文很长', type: 'reference',
    body: 'x'.repeat(Math.ceil(bodyHardTokens() * 0.7) * 4) });
  ok(/how I originally proved this true/.test(notes(long)), '正文接近上限 → 提示先删论证');
  ok(new RegExp(String(bodyHardTokens())).test(notes(long)), '并把上限印出来');

  const w = g.write({ node: 'reference_r_clean', content: '新做法, 比原来短。',
    base_hash: g.wholeBody('reference_r_clean').hash, actor: 'test' });
  ok(/当前命题/.test(notes(w)) && /还准吗/.test(notes(w)),
    '🔴 改正文必印当前命题行 + "这次改动之后这句还准吗" —— 它只动正文, 命题行不会自己跟着变');
  ok(/不传 body/.test(notes(w)), '并告诉它改命题别传 body(否则照着改会把正文冲了)');
  ok(w.shrank > 0, '回执报出缩了多少 —— write 的职责就是让正文变短或持平');

  // 🔴 write 只许改不许加。实测它 96% 的使用都在让正文变长(平均每次 +603 字符), 而全量
  // upsert 平均缩 91 字符 —— 便宜的口子只会被用来加, 所以把它钉死在"改"上。
  let grew = '';
  try {
    g.write({ node: 'reference_r_clean', content: '这次写一段明显更长的内容进去试试',
      base_hash: g.wholeBody('reference_r_clean').hash, actor: 'test' });
  } catch (e) { grew = e.message; }
  ok(/memory_upsert/.test(grew), '把正文写长会被拒, 且报错指向 upsert');

  // ③.5: 改正文顺手改命题, 一次调用完成 —— 否则"正文改了命题没改"要靠两次调用的自觉
  const w3 = g.write({ node: 'reference_r_clean', content: '第三次',
    base_hash: g.wholeBody('reference_r_clean').hash, claim: '命题: 顺手把命题也改了', actor: 'test' });
  ok(g.store.node(g.resolve('reference_r_clean')).claim === '命题: 顺手把命题也改了',
    'memory_write 传 claim → 命题行同一次调用就改掉了');
  ok(/顺手把命题也改了/.test(notes(w3)), '回执印的是【改完之后】的命题, 不是老那句');
}

// ④ anchors: 命题关于代码时, 该核对哪一行要跟着检索结果一起出来。
// 这一组守的不是"字段存得住", 而是**它必须出现在 renderHit 的输出里** —— 躺在正文里等人
// 去读的锚点等于没有: 要核对的那一刻多一跳, 走的就还是重新 grep 那条贵路。
console.log('\n[4] anchors 可验锚点');
{
  const a = g.upsert({ slug: 'reference_r_anchor', claim: '命题: 召回是每轮都跑的', type: 'reference',
    anchors: 'core/wake.js:78 core/index-guard.js:42' });
  ok(g.store.node(a.id).anchors === 'core/wake.js:78 core/index-guard.js:42', 'anchors 落库');

  const hit = g.query('召回 每轮', { flat: true, minTier: 'low' }).find((r) => r.slug === 'reference_r_anchor');
  ok(hit && hit.anchors === 'core/wake.js:78 core/index-guard.js:42',
    '🔴 检索结果带 anchors —— 算在引擎里却不带出去, 渲染层就永远拿不到');
  ok(/↳ verify: core\/wake\.js:78/.test(renderHit(hit)), '🔴 renderHit 把锚点印出来');

  g.upsert({ slug: 'reference_r_anchor', claim: '命题: 召回是每轮都跑的(改了命题)' });
  ok(g.store.node(a.id).anchors === 'core/wake.js:78 core/index-guard.js:42',
    'partial 语义: 只改 claim 不传 anchors, 锚点一个字不掉');

  const bare = g.upsert({ slug: 'reference_r_noanchor', claim: '命题: 这条跟代码无关', type: 'reference' });
  const bareHit = g.query('跟代码无关', { flat: true, minTier: 'low' }).find((r) => r.id === bare.id);
  ok(bareHit && !/↳ 核对/.test(renderHit(bareHit)),
    '没锚点的不多印一行 —— 常亮的装饰两天就读成噪音, 那时真有锚点的那条也跟着废');
}

// 工具层的 type 是选填, 所以"省略 type"是常态而非例外。缺省曾经落 'project', 于是每一次省略
// 都撞上 project 的 exit_criteria 闸, 报错还谈的是"僵尸项目" —— 与调用方在做的事毫不相干。
console.log('\n[7] 省了 type 按 slug 前缀认, 认不出来也不许落 project');
{
  const typeOf = (s) => g.store.node(g.resolve(s)).type;
  for (const t of ['reference', 'feedback', 'user']) {
    const slug = `${t}_infer_x`;
    ok(!throws(() => g.upsert({ slug, claim: `命题: ${t} 前缀不传 type` })), `${t}_ 前缀省 type → 建得成`);
    ok(typeOf(slug) === t, `  └ type 落成 ${t}(落空 type 的节点体检和默认重要度都判不了)`);
  }
  ok(!throws(() => g.upsert({ slug: 'shop_regular_tanaka', claim: '命题: 前缀不在四类里' })),
    '前缀认不出来也建得成');
  ok(typeOf('shop_regular_tanaka') === 'reference', '  └ 认不出来落最轻的 reference, 不落 project');

  // 反面: 治僵尸项目那道源头闸不许被上面这条顺手拆掉
  ok(!!throws(() => g.upsert({ slug: 'project_zombie', claim: '命题: 没写完工条件' })),
    '🔴 project_ 前缀省 type 仍被 exit_criteria 闸拦下(前缀推出来的 project 也是 project)');
  ok(!!throws(() => g.upsert({ slug: 'reference_pretend', claim: '命题: 显式说自己是项目', type: 'project' })),
    '🔴 显式 type=project 照样拦(前缀不带 project_ 也不放过)');
}

console.log('\n[keywords] 新建必须带 keywords —— 检索只看 title/claim/keywords, 空着就只剩命题原句撞得上');
(async () => {
  const { registerMemoryToolsV2 } = require('../core/memory-tools-v2');
  const mk = () => { const o = { optional: () => o, describe: () => o }; return o; };
  const z = { string: mk, number: mk, boolean: mk, enum: mk, array: mk, object: mk, record: mk, any: mk };
  const tools = registerMemoryToolsV2({ tool: (name, desc, schema, handler) => ({ name, handler }), z, graph: g });
  const up = (a) => tools.find((t) => t.name === 'memory_upsert').handler(a).then((r) => r.content[0].text);
  const G_claim = (slug) => g.store.node(g.resolve(slug)).claim;
  const noKw = await up({ id: 'feedback_kw_missing', claim: '命题: 设定改了要连系统一起改', type: 'feedback' });
  ok(/keywords/.test(noKw) && !g.resolve('feedback_kw_missing'), '🔴 新建不带 keywords → 退回写法要求, 一个字都没落库');
  ok(/next time this applies/.test(noKw), '退回文案说清了该写什么(下次会怎么说, 不是这次的例子)');
  const blank = await up({ id: 'feedback_kw_missing', claim: '命题: 设定改了要连系统一起改', keywords: '   ' });
  ok(!g.resolve('feedback_kw_missing'), '只有空格也算没填');
  const noLink = await up({ id: 'feedback_kw_missing', claim: '命题: 设定改了要连系统一起改', keywords: '改设定 营业时间 定休日 价格 调整' });
  ok(/links/.test(noLink) && !g.resolve('feedback_kw_missing'), '🔴 新建不带 links → 退回让它想清楚连到哪, 一个字都没落库');
  ok(/memory_query/.test(noLink) && /ask the person/.test(noLink) && !/pass `links="none"`/.test(noLink),
     '退回文案给了出路: 先查出相关节点再连, 不知道用在哪就问用户 —— 不再给 none 这个口子(作者 10-14)');
  const fake = await up({ id: 'feedback_kw_missing', claim: '命题: 设定改了要连系统一起改', keywords: '改设定 营业时间', links: 'shop_rules_made_up' });
  ok(/None of these exist/.test(fake) && !g.resolve('feedback_kw_missing'), '🔴 links 全是编的名字 → 退回(否则静默丢掉, 照样零连线)');
  const withKw = await up({ id: 'feedback_kw_missing', claim: '命题: 设定改了要连系统一起改', keywords: '改设定 营业时间 定休日 价格 调整', links: 'reference_gate' });
  ok(/saved to memory/.test(withKw) && !!g.resolve('feedback_kw_missing'), '带了 keywords 和 links → 正常新建');
  const nb = g.store.db.all('select count(*) c from edges where src=? or dst=?', [g.resolve('feedback_kw_missing'), g.resolve('feedback_kw_missing')])[0].c;
  ok(nb > 0, 'links 真的连成了边');
  const alone = await up({ id: 'feedback_kw_alone', claim: '命题: 孤立的一条', keywords: '孤立 测试', links: 'none' });
  ok(/saved to memory/.test(alone) && !!g.resolve('feedback_kw_alone'), 'links="none" 放行(真孤立的不卡死)');
  ok(!g.resolve('none'), '「none」不会被当成一个节点名去连');
  const noted = await up({ id: 'feedback_kw_noted', claim: '命题: 设定改了要连系统一起改', keywords: '改设定 定休日', links: 'none',
    body: '设定改了要连系统一起改' });
  ok(/📌/.test(noted) && /not for the person you are talking to/.test(noted.split('📌')[0]),
    '🔴 附带 📌 提示时先声明「只给你看, 别跟对方提」(店小二曾把它当店主的话回了)');
  const upd = await up({ id: 'feedback_kw_missing', claim: '命题: 设定改了必须当场连系统一起改' });
  ok(/saved to memory/.test(upd), '更新已有节点不强制 keywords(只改命题不该被拦)');

  // 出厂节点 AI 写不进去: 升级会整条覆盖, 写进去的店主规矩会无声消失(10-14 dev 纪念日 SOP)
  g.upsert({ slug: 'rest_factory_sop', claim: '命题: 出厂的做法', keywords: '出厂', is_factory: 1, actor: 'factory-sync' });
  const wr = (a) => tools.find((t) => t.name === 'memory_write').handler(a).then((r) => r.content[0].text);
  const fUp = await up({ id: 'rest_factory_sop', claim: '命题: 店主说生日送甜品' });
  ok(/factory knowledge/.test(fUp) && /rest_factory_sop/.test(fUp), '🔴 改出厂节点 → 退回, 让它另建一条连过去');
  ok(G_claim('rest_factory_sop') === '命题: 出厂的做法', '出厂节点的命题一个字没动');
  const fWr = await wr({ node: 'rest_factory_sop', content: 'x', force: true });
  ok(/factory knowledge/.test(fWr), '🔴 memory_write 改出厂正文同样退回');

  // 新建 feedback 后回包附上对方原话, 让它核对自己有没有补了对方没说的(拿不准就问)
  const ag = { _turnUserText: '雨の日は帰りにビニール傘を一本貸して', _turnSeq: 1, _turnQueried: { seq: 1, ids: new Set([g.resolve('rest_factory_sop')]), solid: [] } };
  const tools2 = registerMemoryToolsV2({ tool: (name, desc, schema, handler) => ({ name, handler }), z, graph: g, agent: ag });
  const up2 = (a) => tools2.find((t) => t.name === 'memory_upsert').handler(a).then((r) => r.content[0].text);
  const chk = await up2({ id: 'feedback_rain_service', type: 'feedback', claim: 'When a guest comes on a rainy day, I give a discount.',
    keywords: '雨 サービス rain service', links: 'rest_factory_sop' });
  ok(/saved to memory/.test(chk) && /feedback_rain_service/.test(chk.split('saved to memory')[1].split('\n\n')[1] || '') && /ask them/.test(chk),
    '🔴 新建 feedback → 回包要它按「何时·做什么」自查, 推测填的就问');
  const chk2 = await up2({ id: 'reference_rain_note', type: 'reference', claim: '命题: 雨天客少', keywords: '雨 rain', links: 'rest_factory_sop' });
  ok(/saved to memory/.test(chk2) && !/ask them/.test(chk2), 'reference 不附这段核对');

  // 问过之后的答复改写那条暂定的, 不另建(10-14 dev: 猜测版 #494 与答复版 #496 并存)
  g.upsert({ slug: 'feedback_hot_day_pending', claim: '命题: 热天来的客人给点服务(打折或冷饮?)', keywords: '暑い 热天', provisional: 2 });
  ag._turnQueried = { seq: 1, ids: new Set([g.resolve('feedback_hot_day_pending'), g.resolve('rest_factory_sop')]), solid: ['feedback_hot_day_pending'] };
  const dup = await up2({ id: 'feedback_hot_day_towel', type: 'feedback', claim: '命题: 热天来店先上冷毛巾, 不打折',
    keywords: '暑い おしぼり hot towel', links: 'feedback_hot_day_pending' });
  ok(/provisional/.test(dup) && !g.resolve('feedback_hot_day_towel'), '🔴 新条连向暂定条 → 退回让它改写那条, 不另建');
  const other = await up2({ id: 'feedback_other_matter', type: 'feedback', claim: '命题: 外国客人给英文菜单',
    keywords: '外国人 english menu', links: 'rest_factory_sop' });
  ok(/saved to memory/.test(other), '只是查到了无关的暂定条、没连它 → 照常存');
  const dupOk = await up2({ id: 'feedback_hot_day_towel', type: 'feedback', claim: '命题: 热天来店先上冷毛巾, 不打折',
    keywords: '暑い おしぼり hot towel', links: 'feedback_hot_day_pending', confirm_new: true });
  ok(/saved to memory/.test(dupOk), 'confirm_new=true 是另一回事时的出口');

  // 被闸退回的保存记在本轮账上, 补存成功才销账(回合末 wake.js 据此下一轮点名补存)
  ag._turnSeq = 2;
  await up2({ id: 'feedback_regulars_care', type: 'feedback', claim: '命题: 常客多照顾', keywords: '常連 regulars' });
  ok(ag._turnUnsaved && ag._turnUnsaved.seq === 2 && ag._turnUnsaved.ids.has('feedback_regulars_care'), '🔴 退回的保存记账');
  ag._turnQueried = { seq: 2, ids: new Set([g.resolve('rest_factory_sop')]), solid: [] };
  await up2({ id: 'feedback_regulars_care', type: 'feedback', claim: '命题: 常客多照顾', keywords: '常連 regulars', links: 'rest_factory_sop' });
  ok(!ag._turnUnsaved.ids.has('feedback_regulars_care'), '补存成功 → 销账');

  // 态度词命题退回叫它问; 带固定说法/数字的放行(10-14 dev: 回包曾是 [object Object])
  ag._turnSeq = 3; ag._turnQueried = { seq: 3, ids: new Set([g.resolve('rest_factory_sop')]), solid: [] };
  const vg = await up2({ id: 'feedback_kids_kind', type: 'feedback', claim: 'When customers bring children, be kind and gentle.',
    keywords: '子ども連れ kids', links: 'rest_factory_sop' });
  ok(/Not saved/.test(vg) && /kind/.test(vg) && !g.resolve('feedback_kids_kind'), '🔴 只有态度词的做法 → 退回叫它问(回包是文字不是 [object Object])');
  const ph = await up2({ id: 'feedback_phone_close', type: 'feedback', claim: 'At the end of a phone booking, say: 当日お気をつけてお越しください (take care on your way).',
    keywords: '電話 予約 phone close', links: 'rest_factory_sop' });
  ok(/saved to memory/.test(ph), '照抄的固定说法里带 take care 不误拦');
  ag._turnUserText = '常連さんの予約は大事にしてあげて';
  const sv = await up2({ id: 'feedback_regular_booking', type: 'feedback', claim: 'Regular customers get their preferred seat held.',
    keywords: '常連 予約 regulars', links: 'rest_factory_sop' });
  ok(/Not saved/.test(sv) && /大事に/.test(sv), '🔴 对方原话含糊(大事に)而命题没数字/引号 → 退回叫它问(它换词绕不过原话)');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${fail ? '❌' : '✅'} test-upsert-fields: ${pass} 过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
