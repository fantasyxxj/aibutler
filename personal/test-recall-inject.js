// test-recall-inject.js — 自动召回的注入闸(⑤) + 标定值外置(⑥)
//
// 这条链之前是**查了但一个字都不给**: 每轮真的查, 只写 recall_log, 结果扔掉。
// 现在够得上高档的把【主键 + 命题行】拼进上下文。三条不变量:
//   ① 够不上高档的一个字都不注入 —— 塞不相干的东西进上下文比"没查到"更坏, 它会被当依据用掉
//   ② 只给主键 + 命题行, **绝不给正文** —— 给全文的话错的那条会被当事实用, 地板就得抬到
//      0.85+ 才敢给(覆盖率极低 = 等于没做); 只给命题行则错的扫一眼就跳过, 地板才压得到 tier_hi
//   ③ 分档线用现成的 tier_hi, **不新造 recall_inject_floor** —— 同一件事两个真源迟早各调各的
require('./host-wiring');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MemoryGraphV2 } = require('../core/memory-v2');
const WakeMixin = require('../core/agent/wake.js');
const { tune, reloadTuning, setDataDir, TUNING_DEFAULTS } = require('../core/memory-v2/tuning');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-recall-inject-'));
const g = new MemoryGraphV2(dir);
let pass = 0; let fail = 0;
const ok = (c, l) => { if (c) { console.log(`  ✓ ${l}`); pass++; } else { console.log(`  ✗ ${l}`); fail++; } };

const audit = WakeMixin.prototype._auditRecall.bind({ name: '注入测试', memory: g });
// 原话没对上时只给「换成你自己的说法去查」那一句, 不带任何记忆内容(没有命题行, 没有点名)
const MISS = /matched nothing in memory/;
const missOnly = (out) => MISS.test(out) && !/^- #/m.test(out) && !/before answering/.test(out);

g.upsert({ slug: 'reference_kirin_weight', type: 'reference', keywords: '麒麟纹 检索 权重',
  claim: '命题: 麒麟纹检索该加权重', body: '这段正文绝对不该出现在注入里' });
g.upsert({ slug: 'reference_banana', type: 'reference', keywords: '香蕉', claim: '命题: 香蕉是黄的' });

console.log('\n[1] 门禁: 够不上高档的一个字都不注入');
{
  const hit = audit('麒麟纹 检索 权重 怎么调', 'user', false);
  ok(/reference_kirin_weight/.test(hit), '高档命中 → 注入了');
  ok(missOnly(audit('今天天气如何呀朋友', 'user', false)), '🔴 无关输入 → 一条记忆都不给, 只说「原话没对上, 自己换说法查」');
  ok(audit('麒麟纹 检索 权重', 'user', true) === '', '心跳轮不查(那种轮次捞回来的都是噪音)');
  ok(audit('嗯', 'user', false) === '', '太短的输入不查');
  ok(audit('麒麟纹 检索 权重', 'auto', false) === '', '🔴 auto 轮不查 —— 唤醒/沉淀本来就不缺上下文');
}

console.log('\n[1.5] 查的是没套信封的原文, 不是整条提交正文');
{
  // bus/TG/LINE/Local API 的正文外面裹一层信封(来源标签 · 投递说明 · 处理指示)。那些词不是对方
  // 问的话, 却照样参与打分 —— 查询词一多就摊薄每条记忆的覆盖率, 把真相关的压到注入线以下。
  // 🔴 dev 实测: 同一句话裸文 top=0.367, 套上 api_single 信封后 0 条命中 —— 注入在 inbox 这一档
  // 上等于恒不触发, 而 inbox 正是为 bus/TG/LINE 这些"人格空着脑子作答"的通路开的。
  const raw = '麒麟纹 检索 权重 怎么调';
  const enveloped = `【来自「verify」· 外部程序 · 单向】\n${raw}\n`
    + '→ 这是本机程序通过 Local API 投递的, 它不接收回复; 要回结果请按正文要求做。';
  ok(/reference_kirin_weight/.test(audit(raw, 'user', false)), '裸原文能命中(对照组)');
  ok(missOnly(audit(enveloped, 'user', false)), '🔴 整条带信封的正文查不出来 —— 这就是必须传 rawText 的原因');

  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'agent', 'stream.js'), 'utf8');
  ok(/opts\.rawText !== undefined \? opts\.rawText : text/.test(src),
    '🔴 submit 拿 opts.rawText 去查, 没传才退回 text');
  // 🔴 图片/贴图/文件消息没有文字, 原文就是空串。写成 `opts.rawText || text` 的话空串是 falsy,
  // 会退回整条信封 —— 把 payload 的 JSON、文件路径全当查询词, 而且恰好发生在最没意义的场合。
  ok(!/opts\.rawText \|\| text/.test(src),
    '🔴 空串不许退回整条(用 !== undefined 判, 不用 ||)');
  ok(audit('', 'user', false) === '' && audit('   ', 'user', false) === '',
    '空原文 → 不查, 直接返回空串');
  // 🔴 逐个投递点查, **不数出现次数**。原来写的是「rawText 出现 ≥6 次」, 结果 9 个点里
  // 漏了 3 个(TG 批量 · LINE 批量 · bothub/bus)照样绿 —— 而漏掉的那个里就有 bus。
  // 数量断言的通病: 它守的是"有人写过这东西", 不是"每个该写的地方都写了"。
  const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const sites = mainSrc.split('\n')
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /sourceKind: 'inbox'/.test(l));
  const missing = sites.filter(({ i }) =>
    !/rawText/.test(mainSrc.split('\n').slice(i, i + 3).join('\n')));
  ok(sites.length >= 9, `找齐了 inbox 投递点 (${sites.length} 个)`);
  ok(missing.length === 0,
    `🔴 每个 inbox 投递点都传了原文${missing.length ? ` — 漏了第 ${missing.map((m) => m.i + 1).join(',')} 行` : ''}`);
}

console.log('\n[2] 只给主键 + 命题行, 绝不给正文');
{
  const hit = audit('麒麟纹 检索 权重 怎么调', 'user', false);
  ok(/#\d+/.test(hit), '带主键(展开时直接 memory_section(node=id), 不用二次查询)');
  ok(/命题: 麒麟纹检索该加权重/.test(hit), '带命题行');
  ok(!/这段正文绝对不该出现/.test(hit), '🔴 正文一个字都没进去 —— 给全文的话错的那条会被当事实用掉');
  // 🔴 抬头只留一个能认出来的标记, **不在这里解释怎么读**。实测 64% 的轮次会注入, 抬头每多
  // 一句就乘 0.64 × 每天轮数; 而这段动态块每轮内容都变, **吃不到 prompt cache**, 常驻提示词吃得到。
  // 所以"未必用得上 / 怎么展开"讲在 prompts/memory_engine.md, 那里讲一次就够。
  ok(/\[Memory/.test(hit), '有个能认出来的标记(不冒充用户说的话)');
  const head = require('../core/host').cfg.json('main/forced_recall').inject_heading;
  const { estTokens } = require('../core/memory-v2/consts');
  ok(estTokens(head) <= 15, `🔴 抬头够短 (${estTokens(head)} token; 原先 47 token 占每次注入的 21%)`);
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'core', 'config', 'prompts', 'memory_engine.md'), 'utf8');
  ok(/\[Memory/.test(prompt) && /may or may not be relevant/.test(prompt),
    '🔴 怎么读这个块讲在常驻提示词里(搬出去了就得真在那边, 不然两头都没有)');
}

console.log('\n[3] 标定值外置(⑥): 条数与 token 都能调, 且没有新造地板');
{
  ok(typeof tune('recall_inject_max') === 'number', 'recall_inject_max 在 tuning 里');
  ok(typeof tune('recall_inject_budget') === 'number', 'recall_inject_budget 在 tuning 里');
  ok(typeof tune('provisional_batch') === 'number', 'provisional_batch 从 doctor 硬编码搬进来了');
  ok(typeof tune('recall_used_window') === 'number', 'recall_used_window 搬进来了');
  ok(typeof tune('superseded_penalty') === 'number', 'superseded_penalty 搬进来了');
  // 🔴 这一条是刻意的反向断言: tier_hi 的原注释逐字写着「≥此值 = 高档, 当事实直接注入」——
  // 注入分档线本来就存在, 只是 _auditRecall 从没去用它。再造一个就是同一件事两个真源。
  // 查的是**键在不在**, 不是源码里出没出现这个词 —— 注释里正解释着为什么不造它。
  ok(!('recall_inject_floor' in TUNING_DEFAULTS), '🔴 没有新造 recall_inject_floor(注入分档线直接用 tier_hi)');
  const wakeSrc = fs.readFileSync(path.join(__dirname, '..', 'core', 'agent', 'wake.js'), 'utf8');
  ok(/tier === 'high'/.test(wakeSrc), '注入判据读的是 tier 分档, 不是另立一个数');
}

console.log('\n[4] 预算闸: 宁可少给, 不许超');
{
  for (let i = 0; i < 8; i++) {
    // 关键词与查询逐字相同, 才够得上高档 —— 不然它们根本进不了注入, 上限也就验不到
    g.upsert({ slug: `reference_bulk_${i}`, type: 'reference', keywords: '麒麟纹 检索 权重',
      claim: `命题: 这是第 ${i} 条用来把预算撑爆的很长很长很长很长很长很长的命题行内容` });
  }
  // 覆盖层落在【宿主注入的数据目录】里, 不指过来的话写了也不生效(会静默按出厂默认跑)
  setDataDir(dir);
  const ovPath = path.join(dir, 'memory-tuning.json');
  fs.writeFileSync(ovPath, JSON.stringify({ recall_inject_budget: 1 }));
  reloadTuning();
  ok(tune('recall_inject_budget') === 1, '用户目录覆盖生效(装机版调参不用重新打包)');
  ok(missOnly(audit('麒麟纹 检索 权重', 'user', false)), '🔴 预算 1 token → 一条都放不下, 宁可不给也不超');
  // 压低 tier_hi 让多条够得上, 直接验条数上限 —— 靠堆同关键词的节点是验不出来的:
  // 词一常见 IDF 就掉, 全体分数一起沉到高档线以下(打分器的正确行为, 别跟它较劲)。
  // 顺带这也证明了分档线**真的**是 tier_hi 在管: 调它就能改变注入行为。
  fs.writeFileSync(ovPath, JSON.stringify({ recall_inject_max: 2, recall_inject_budget: 4000, tier_hi: 0.01 }));
  reloadTuning();
  const many = audit('麒麟纹 检索 权重', 'user', false);
  const n = (many.match(/^- #/gm) || []).length;
  ok(n === 2, `条数上限生效(max=2, 实得 ${n})`);
  ok(n > 0, '🔴 调低 tier_hi 就有更多条被注入 —— 证明管注入的确实是 tier_hi 这个数');
}

console.log('\n[5] 中档只点名: 教过的规则换个说法落在中档, 不给命题行, 只给 slug 让它自己去查');
{
  const ovPath = path.join(dir, 'memory-tuning.json');
  // 把高档线抬到够不着、中档线压到底, 命中就全落中档; 点名线压到 0 让分数不成为变量 —— 验的是形状不是标定
  // ([4] 堆了 8 条同关键词节点, IDF 已经把分数压到 0.15 上下, 不压 tier_mid 会全掉进低档)
  fs.writeFileSync(ovPath, JSON.stringify({ tier_hi: 0.99, tier_mid: 0.01, recall_hint_floor: 0, recall_hint_max: 2 }));
  reloadTuning();
  const out = audit('麒麟纹 检索 权重 怎么调', 'user', false);
  ok(/memory_section these before answering: /.test(out), '中档命中 → 出点名行');
  ok(!/^- #/m.test(out), '🔴 中档不给命题行(只给名字, 错的扫一眼就跳过)');
  ok(!/命题:/.test(out), '🔴 命题行文字一个字都没漏进来');
  const names = (out.match(/before answering: (.*)/) || [, ''])[1].split(', ').filter(Boolean);
  ok(names.length === 2, `点名条数受 recall_hint_max 管(max=2, 实得 ${names.length})`);
  ok(missOnly(audit('今天天气如何呀朋友', 'user', false)), '🔴 无关输入不点名 —— 没命中就不列任何条目');
  fs.writeFileSync(ovPath, JSON.stringify({ tier_hi: 0.99, tier_mid: 0.01, recall_hint_floor: 0.99 }));
  reloadTuning();
  ok(missOnly(audit('麒麟纹 检索 权重 怎么调', 'user', false)), '够不上 recall_hint_floor → 不点名');
  fs.rmSync(ovPath, { force: true });
  reloadTuning();
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? '❌' : '✅'} test-recall-inject: ${pass} 过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
