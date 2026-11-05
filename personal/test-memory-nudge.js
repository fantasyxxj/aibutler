// test-memory-nudge.js — 动态记忆提醒: 有沉淀特征却零 memory_* → 下一条真人消息前 prepend 提醒。
// 跑: node test-memory-nudge.js
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('./config-loader');
const { Butler } = require('../core/agent');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };

// 不起流: 直接拿实例调纯判定/取用方法(不碰 submit 的 SDK 路径)
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-nudge-'));
const b = new Butler(tmpHome, { name: '测试人格' });

console.log('=== T1: 命中特征 + 零 memory_* → 挂提醒 ===');
b._turnMemoryOps = 0; b._turnUserText = '这里不对，改回去'; b._memoryNudge = null;
b._evalMemoryNudge();
ok(b._memoryNudge === '不对', '命中「不对」');

console.log('=== T2: 命中特征但沉过了 → 不提醒 ===');
b._turnMemoryOps = 2; b._turnUserText = '记住这个规矩'; b._memoryNudge = null;
b._evalMemoryNudge();
ok(b._memoryNudge === null, '已调 memory_* 则不挂');

console.log('=== T3: 无特征 → 不提醒 ===');
b._turnMemoryOps = 0; b._turnUserText = '帮我看下这个函数'; b._memoryNudge = null;
b._evalMemoryNudge();
ok(b._memoryNudge === null, '普通请求不挂');

console.log('=== T4: auto 回合(心跳/唤醒/出生教育) → 不判 ===');
b._turnMemoryOps = 0; b._turnUserText = null; b._memoryNudge = null;
b._evalMemoryNudge();
ok(b._memoryNudge === null, 'auto 轮 _turnUserText=null 不判');

console.log('=== T5: 注入只发生在真人回合, 且一次性 ===');
b._memoryNudge = '事故';
ok(b._takeMemoryNudge('auto') === '', 'auto 轮不注入');
ok(b._memoryNudge === '事故', 'auto 轮不消耗标志');
const injected = b._takeMemoryNudge('user');
ok(injected.includes('事故'), 'user 轮注入且带命中词');
ok(injected.includes('memory_upsert'), '提醒里给了可执行动作');
ok(injected.endsWith('\n\n'), '与正文之间留空行');
ok(b._memoryNudge === null, '注入后标志清空(一次性)');
ok(b._takeMemoryNudge('user') === '', '不重复注入');

console.log('=== T6: 配置完整性 ===');
const c = cfg.json('main/memory_nudge');
ok(Array.isArray(c.patterns) && c.patterns.length > 0, 'patterns 非空');
ok(typeof c.template === 'string' && c.template.includes('{hit}'), 'template 有 {hit} 占位');
ok(c.patterns.every((p) => typeof p === 'string' && p.length >= 2), '每条 pattern 至少 2 字(免误报)');
// 三类特征各有覆盖
for (const [kind, probe] of [['纠正', '不对'], ['定案', '钦定'], ['事故', '事故'], ['点名要记', '记住']]) {
  ok(c.patterns.includes(probe), `${kind} 类有代表词「${probe}」`);
}
// 🔴 四语都要有: 这张表原先只有简体中文, 于是日本店主说「違う」、台湾店主打「記住」一律不命中 ——
// 对他们来说这个功能等于不存在, 而且不报错。四语版本一度只活在 industry 的覆盖里(整份覆盖不合并,
// 等于 core 后来的改进行业版全吃不到), 现已并回 core 这一份。
for (const [lang, probe] of [['ja', '違う'], ['zh-TW', '記住'], ['en', 'from now on'], ['zh-CN', '记住']]) {
  ok(c.patterns.includes(probe), `${lang} 命中得了「${probe}」(缺这门语言的话该语言用户等于没这功能)`);
}
// 模板不许写死工具名: v1 是 memory_append, v2 换成 memory_section + memory_write。
// 行业版那份覆盖就写死了 memory_append, 于是一直在教店铺管家去调一个早已撤掉的工具。
ok(!/memory_append/.test(c.template), '🔴 template 没写死已撤的 memory_append');

console.log('=== T7: 常见正常对话不误报 ===');
for (const s of ['帮我改一下这个函数', '这个怎么跑', '看看日志', '打包一下', '好的，继续']) {
  b._turnMemoryOps = 0; b._turnUserText = s; b._memoryNudge = null;
  b._evalMemoryNudge();
  ok(b._memoryNudge === null, `不误报: 「${s}」`);
}

// 第三格: 平静的技术讨论 —— 撞不上情绪词表, 也够不着 force_sediment 的外部来源判据。
// 判据换成「连续几个真人回合零 memory_*」, 这个维度才和"有没有漏存"直接相关
// (idle 时长和 ctx 胖瘦都不是: 讨论进行中 idle 恒为 0, 而刚压完的会话可以很瘦却已经定了三件事)。
const TH = Number(c.streak_threshold);
const quiet = (n) => { for (let i = 0; i < n; i++) { b._turnMemoryOps = 0; b._turnMemoryWrites = 0; b._turnUserText = '那这里改成按轮数算'; b._evalMemoryNudge(); } };
const reset = () => { b._turnsSinceMemoryOp = 0; b._memoryNudge = null; b._memoryNudgeStreak = 0; b._turnMemoryOps = 0; b._turnMemoryWrites = 0; };

console.log('=== T8: 连续零 memory_* 的平静讨论 ===');
ok(Number.isInteger(TH) && TH > 0, `streak_threshold 是正整数(${TH})`);
ok(typeof c.streak_template === 'string' && c.streak_template.includes('{n}'), 'streak_template 有 {n} 占位');
// 🔴 作者 9-12 原话「没形成更要存啊, 没形成的, 下次肯定要讨论的」—— 没定论的那半必须写进模板,
// 只说"存结论"会让人格把讨论到一半的中间状态默认排除在外, 而那恰恰是清空后唯一找不回的东西。
ok(/provisional/.test(c.streak_template), '🔴 streak_template 交代了没定论的怎么存(provisional)');
ok(!/memory_append/.test(c.streak_template), '🔴 streak_template 没写死已撤的 memory_append');

reset(); quiet(TH - 1);
ok(b._memoryNudgeStreak === 0, `差一轮到阈值不挂(${TH - 1}/${TH})`);
quiet(1);
ok(b._memoryNudgeStreak === TH, `满 ${TH} 轮挂上`);

console.log('=== T9: 只有真写库才清零, 查不算 ===');
reset(); quiet(TH - 1);
b._turnMemoryOps = 1; b._turnMemoryWrites = 1; b._turnUserText = '那这条存一下'; b._evalMemoryNudge();
ok(b._turnsSinceMemoryOp === 0, 'memory_upsert/write → 计数清零');
ok(b._memoryNudgeStreak === 0, '清零后不挂');

// 🔴 这一条是整个机制的命门。查记忆是每轮必做的动作(硬规矩 1), 所以 _turnMemoryOps 几乎轮轮非零 ——
// 拿它当判据的话连续计数永远数不到 1, 提醒一次都发不出来, 而代码看上去完全正常。
// 漏存真正的样子就是【查了一堆、一条没存】: 2026-09-12 活样本, 一整程十几次 query、零 upsert。
reset();
for (let i = 0; i < TH; i++) { b._turnMemoryOps = 9; b._turnMemoryWrites = 0; b._turnUserText = '再查查看'; b._evalMemoryNudge(); }
ok(b._turnsSinceMemoryOp === TH, '🔴 查了一堆但一条没存 → 计数照常涨');
ok(b._memoryNudgeStreak === TH, '🔴 查了一堆但一条没存 → 照样催');

console.log('=== T9b: 情绪词那格判据不变(碰过记忆就不啰嗦) ===');
reset();
b._turnMemoryOps = 1; b._turnMemoryWrites = 0; b._turnUserText = '记住这个规矩'; b._evalMemoryNudge();
ok(b._memoryNudge === null, '查过了就不发情绪词提醒(原有行为)');

console.log('=== T10: auto 轮不参与计数 ===');
reset(); quiet(TH - 1);
const before = b._turnsSinceMemoryOp;
b._turnMemoryOps = 0; b._turnUserText = null; b._evalMemoryNudge();
ok(b._turnsSinceMemoryOp === before, 'auto 轮(心跳/唤醒/沉淀)不推进计数');

console.log('=== T11: patterns 命中优先, 不重复催 ===');
reset(); quiet(TH - 1);
b._turnMemoryOps = 0; b._turnUserText = '这个记住'; b._evalMemoryNudge();
ok(b._memoryNudge === '记住', '命中情绪词走原通道');
ok(b._memoryNudgeStreak === 0, '同一轮不再叠一条 streak 提醒');

console.log('=== T12: streak 提醒的注入 ===');
reset(); quiet(TH);
ok(b._takeMemoryNudge('auto') === '', 'auto 轮不注入');
const inj = b._takeMemoryNudge('user');
ok(inj.includes(String(TH)), `注入文本带上了轮数(${TH})`);
ok(inj.includes('memory_upsert'), '给了可执行动作');
ok(inj.endsWith('\n\n'), '与正文之间留空行');
ok(b._memoryNudgeStreak === 0, '注入后标志清空(一次性)');
// 🔴 送出去才清零: 不清的话下一轮计数仍在阈值之上, 会变成每轮都催 —— 催成背景噪音就等于没催。
ok(b._turnsSinceMemoryOp === 0, '🔴 注入后连续计数归零, 不会每轮复发');
ok(b._takeMemoryNudge('user') === '', '不重复注入');

console.log('=== T13: 一键关 ===');
ok(c.streak_enabled === true, '当前默认开启');
const saved = c.streak_enabled;
c.streak_enabled = false;
reset(); quiet(TH + 2);
ok(b._memoryNudgeStreak === 0, 'streak_enabled=false 时不挂');
c.streak_enabled = saved;

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
