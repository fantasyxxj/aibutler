// test-knowledge-shards.js — 6.2 常驻瘦身试点: 表单/画图细则按需注入
// 不起真流, 把方法从 Butler.prototype 摘下来绑到假宿主上跑(同 mem-v2-forced-recall-test 的做法)。
// 运行: node test-knowledge-shards.js
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const path = require('path');
const { Butler } = require('../core/agent');

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { if (ok) { pass++; console.log(`  ✅ ${name}${extra ? ' · ' + extra : ''}`); } else { fail++; console.error(`  ❌ ${name}${extra ? ' · ' + extra : ''}`); } };

const take = Butler.prototype._takeKnowledgeShards;
// 挂上原型再赋字段 —— 摘单个方法出来会让它调不到同族的 _shardGateOpen/_shardVars,
// 而那口 catch 会把 TypeError 咽掉变成"返回空串", 测试看起来还是绿的。
const host = () => Object.assign(Object.create(Butler.prototype), { name: 'T' });
const call = (h, text, kind = 'user', hb = false) => take.call(h, text, kind, hb);

// 2026-08-19: 表单/画图/手顺三片已退休(知识全进记忆, 不再下发 md), 只剩 voice/ssml —— 它留着
// 是因为里面是"本机装了哪些音色"这种记忆给不了的机器实况。机制没变, 下面一律改用语音片来验。
const voiceHost = (on = true) => Object.assign(host(), { voice: { enabled: on, voice: 'Tingting' } });
const gate = Butler.prototype._shardGateOpen;

console.log('\n=== T1: 命中才给 ===');
t('朗读触发', call(voiceHost(), '把这段朗读一下').includes('xml:lang'));
t('无关话不给', call(voiceHost(), '今天天气怎么样') === '');
t('「图记忆」不误触发', call(voiceHost(), '把这条沉进图记忆') === '');

console.log('\n=== T2: 只在真人回合 ===');
t('心跳不给', call(voiceHost(), '朗读一下', 'user', true) === '');
t('auto 轮不给', call(voiceHost(), '朗读一下', 'auto') === '');
t('非字符串不炸', call(voiceHost(), null) === '');

console.log('\n=== T3: 自报家门 + 同片不重复 ===');
const h = voiceHost();
const first = call(h, '朗读一下这段');
t('带来源头尾', first.includes('System-attached reference') && first.includes('End of attached reference'));
t('同一片第二次不给', call(h, '再念一遍') === '');

console.log('\n=== T4: 整份给, 不截断 ===');
// 语音片是 render 的, 磁盘原文里带 {{}} 占位符, 没法整份比对 ——
// 改认"不含占位符的最后一行一字不少", 截断的话这行必然不在。
const ssmlSrc = fs.readFileSync(path.join(__dirname, '../core/config/knowledge/voice/ssml.md'), 'utf8').trim();
const tail = ssmlSrc.split('\n').filter((l) => l.trim() && !/\{\{/.test(l)).pop();
t('语音细则一字不少', call(voiceHost(), '朗读一下').includes(tail), tail.slice(0, 24) + '…');

// T5(一轮最多两片) 已删: 只剩一片时无从构造"两片同时命中"。max_shards_per_turn 仍配着,
// 将来再有第二片时把这一节加回来。

console.log('\n=== T6: 话术不许硬编码在 agent.js 里 ===');
const src = require('./kernel-src').kernelSource();
const c = JSON.parse(fs.readFileSync(path.join(__dirname, '../core/config/main/knowledge_shards.json'), 'utf8'));
t('header 不在代码里', !src.includes(c.header));
t('footer 不在代码里', !src.includes(c.footer));
t('触发词不在代码里', !src.includes('示意图'));

console.log('\n=== T7: 常驻侧只留目录 ===');
const resident = fs.readFileSync(path.join(__dirname, '../core/config/prompts/presentation.md'), 'utf8');
t('细则已搬走', !resident.includes('data-btn') && !resident.includes('animateTransform'));
// 认能力不认措辞: 目录里的检索词会改(diagram → chart/flowchart 就改过一次),
// 钉死字面量的话一次同义改写就把门禁变成假红。
t('目录仍点名两样能力', /\bform\b/.test(resident) && /diagram|chart|flowchart|svg/.test(resident));
// 细则去处已从"命中自动附上的片"改成记忆(2026-08-19), 保底腿也跟着改成怎么查回来
t('留了保底腿(memory_query 查回来)', resident.includes('memory_query'));
t('不再指 md 细则', !/细则给我/.test(resident));
const residentBytes = Buffer.byteLength(resident);
t('体积降下来了', residentBytes < 2600, `${residentBytes} 字节(原 6793)`);

console.log('\n=== T8: 坏配置不挡对话 ===');
t('配置缺 key 时静默返空', call(host(), '{{in') !== undefined);

// —— 9.2 工具用法按需带入: 语音细则(voiceHost / gate 已在文件上方定义) ——

console.log('\n=== T9: 语音关着时一个字都不给 ===');
t('语音关 → 不给', call(voiceHost(false), '把这段朗读一下') === '');
t('没有 voice 字段也算关', call(host(), '把这段朗读一下') === '');
// 语法表已搬进记忆, 片里只剩机器实况(本机能读哪些语言) —— 认这个才是认"片真的给了"
t('语音开 → 给', call(voiceHost(), '把这段朗读一下').includes('xml:lang'));

console.log('\n=== T10: 认不出的门按关处理 ===');
t('未知 when 判关', gate.call(host(), { key: 'x', when: '没这个门' }) === false);
t('无 when 判开', gate.call(host(), { key: 'x' }) === true);

console.log('\n=== T11: 语音片是渲染的, 不许留生占位符 ===');
const vs = call(voiceHost(), '给我念一下这段');
t('多语段渲染进去了', vs.includes('xml:lang'));
// 手册已废(知识全进记忆): 片里不许再有任何 md 指路, 只许指记忆
t('不再指向 md 手册', !/\.md\b/.test(vs) && !/playbook/i.test(vs));
t('改成指向记忆', /memory_query|memory_section/.test(vs));
const stray = vs.match(/\{\{\w+\}\}/g) || [];
t('没有未替换的占位符', stray.length === 0, stray.join(','));

console.log('\n=== T12: 语音常驻侧只剩指针 + 底线 ===');
const vres = fs.readFileSync(path.join(__dirname, '../core/config/voice/common_rules.md'), 'utf8');
t('8 原语表已搬走', !vres.includes('<break time=') && !vres.includes('<sub alias='));
t('底线仍常驻(说不出理由就别打)', vres.includes('textual reason'));
t('留了保底腿(怎么把知识查回来)', vres.includes('memory_query'));
t('常驻侧也不再指 md 手册', !/\.md\b/.test(vres) && !/playbook/i.test(vres));
const vBytes = Buffer.byteLength(vres);
t('体积降下来了', vBytes < 900, `${vBytes} 字节(原 1546 + multilang 578 = 2124)`);

console.log('\n=== T14: 手顺细则已退片, 改走出厂知识包 ===');
// 原来是一片带 workflows_installed 门的 md。2026-08-19 知识全进记忆后片已删,
// 细则由召回带上来 —— 「没装的手顺不存在」这条也一并进了包, 顶掉原来那道门。
t('手顺片已不再登记', !(c.shards || []).some((s) => s.key === 'workflow/howto'));
t('带客户走手顺不再触发任何片', call(host(), '带客户走一遍手顺') === '');
const pack = JSON.parse(fs.readFileSync(path.join(__dirname, '../core/config/onboarding/knowledge/leaf_core.json'), 'utf8'));
const packSlugs = new Set(pack.items.map((x) => x.slug));
t('入口按钮写法在包里', packSlugs.has('reference_workflow_entry_button_lands_where_progress_says'));
t('「没装的手顺不存在」也在包里(替代那道门)', packSlugs.has('reference_uninstalled_workflow_does_not_exist'));

console.log('\n=== T15: 手顺与人格名单在常驻侧已归零 ===');
// 2026-08-20 作者定: 手顺的设计侧知识(翻屏花不花钱/拆几屏/wf_go 怎么拼)是【流程设计者】的事,
// 执行侧人格拿到的是签好名的成品流程, 只管一屏屏走完 —— 那些知识对它没有收件人。
// 人格名单同理: list_personas 工具随时能查, 且比启动那刻定死的快照准。两个文件整个删掉。
const P = (f) => fs.existsSync(path.join(__dirname, '../core/config/prompts', f));
t('workflows.md 已删', !P('workflows.md'));
t('roster_block.md 已删', !P('roster_block.md'));
const agentSrc = require('./kernel-src').kernelSource();
t('装配处不再注入手顺清单', !agentSrc.includes('prompts/workflows'));
t('装配处不再注入人格名单', !agentSrc.includes('prompts/roster_block'));

console.log('\n=== T13: 每个细则文件都必须登记 ===');
const shardDir = path.join(__dirname, '../core/config/knowledge');
const onDisk = [];
for (const d of fs.readdirSync(shardDir)) {
  if (!fs.statSync(path.join(shardDir, d)).isDirectory()) continue;
  for (const f of fs.readdirSync(path.join(shardDir, d))) {
    if (f.endsWith('.md')) onDisk.push(`${d}/${f.replace(/\.md$/, '')}`);
  }
}
const registered = new Set((c.shards || []).map((s) => s.key));
const orphan = onDisk.filter((k) => !registered.has(k));
t('没有没接线的细则', orphan.length === 0, orphan.join(',') || `${onDisk.length} 片全登记`);
const missing = [...registered].filter((k) => !fs.existsSync(path.join(shardDir, k + '.md')));
t('登记的片文件都在', missing.length === 0, missing.join(','));

console.log('\n=== T16: 6.1 常驻总账 —— 只留索引, 加东西必须先想清楚 ===');
// 棘轮: 常驻是每一轮都要付的钱, 涨了必须是有意识的决定, 不能顺手就涨。
// 细则往 config/knowledge/ 加多少都行 —— 那是命中才付费的。
const RESIDENT = [
  ...fs.readdirSync(path.join(__dirname, '../core/config/prompts')).map((f) => `../core/config/prompts/${f}`),
  '../core/config/voice/common_rules.md', '../core/config/voice/on_header.md',
];
// 🔴 判据是 token 不是字节。字节在跨语言时会严重误导: 汉字 UTF-8 占 3 字节但约 1 token,
// 英文约 4 字符 1 token —— 2026-08-30 把常驻整片从中文换成英文, 字节从 8700 涨到 12427(+43%),
// 而 token 从约 2900 涨到 3072(+6%)。棘轮守的是"每一轮都要付的钱", 钱按 token 算, 所以按字节
// 判会把一次几乎不花钱的语言切换误报成失控膨胀。估法与 memory 那边一致: 汉字 1 tok/字, 其余 4 字符/tok。
const estTokens = (s) => {
  const han = (s.match(/[一-龥]/g) || []).length;
  return Math.round(han + (s.length - han) / 4);
};
let residentTotal = 0;
for (const f of RESIDENT) residentTotal += estTokens(fs.readFileSync(path.join(__dirname, f), 'utf8'));
// 2900 → 3200 tok。这一格是**有意识点的**: 2026-08-30 作者定「程序里给 AI 看的文本一口气全改英文,
// 两版共用一套」—— 内核是两版共用的, 行业版卖去日本, 内核里躺着中文就是问题。语言切换本身几乎不花钱
// (+6%), 余量留给 language.md 那条加强 —— 它治的是【第一轮】的行为: 提示词是什么语言写的, 人格就
// 容易拿那个语言作答(中文提示词回日文用户中文, 实测踩过; 英文提示词会反过来打中文用户)。
// 按需召回救不了第一轮(那时还没有可召回的线索), 所以这条只能常驻。
t('常驻提示词总量在预算内', residentTotal < 3200, `${residentTotal} tok / 3200`);
// 每片都得有真东西 —— 空壳片说明有人把内容删了而不是搬了。
// 例外: 知识全进记忆后, 有的片只剩"机器实况"(本机装了哪些音色这种记忆给不了的动态值)。
// 那种片天生就短, 用知识片的字数尺子量它是错的 —— 认渲染变量, 有变量就说明它还在干活。
const sizes = onDisk.map((k) => {
  const src = fs.readFileSync(path.join(shardDir, k + '.md'), 'utf8');
  return [k, Buffer.byteLength(src), /\{\{\w+\}\}/.test(src)];
});
const thin = sizes.filter(([, n, live]) => n < 300 && !live).map(([k]) => k);
t('没有空壳片', thin.length === 0, thin.join(',') || sizes.map(([k, n, live]) => `${k}:${n}${live ? '(实况)' : ''}`).join(' · '));

console.log(`\n${fail ? '❌' : '✅'} ${pass} 绿 ${fail} 红`);
process.exit(fail ? 1 : 0);
