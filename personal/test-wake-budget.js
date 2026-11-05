// 唤醒预算门禁 (2026-08-13): 交接便条硬性封顶 + CC 软链不许回潮。
// 病根: MEMORY.md 每轮跟着上下文重读, 涨 1KB = 每轮多花一份钱。实测一份 40.9KB 的便条 ≈ 12.5k tok/轮。
// 跑: node test-wake-budget.js
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const path = require('path');
const os = require('os');
const cfg = require('./config-loader');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };
const SRC = require('./kernel-src').readSrc;   // 源码可能在 core/ 也可能在仓根, 解析收在一处
// 回潮检查只看代码, 不看注释 —— 否则"为什么删掉它"的说明本身会把门禁点红, 逼人删掉最该留的那段解释。
const CODE_ONLY = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

console.log('\n=== [1] 上限常量存在且合理 ===');
const agentSrc = require('./kernel-src').kernelSource();
const m = agentSrc.match(/WAKE_MEMORY_INDEX_MAX_BYTES\s*=\s*Number\(process\.env\.(\w+)\)\s*\|\|\s*(\d+)/);
ok(!!m, '定义了 WAKE_MEMORY_INDEX_MAX_BYTES 且可被环境变量覆盖');
if (m) {
  ok(m[1] === 'BUTLER_WAKE_INDEX_MAX_BYTES', '环境变量名 = BUTLER_WAKE_INDEX_MAX_BYTES: ' + m[1]);
  const v = Number(m[2]);
  ok(v > 0 && v <= 16384, `默认上限在 (0, 16KB] 内: ${v}B`);
}

console.log('\n=== [2] 截断真的接在注入路径上 ===');
// 光有常量不算数 —— 必须真的用在 buildWakePayload 读 MEMORY.md 那一段
const wakeSeg = agentSrc.slice(agentSrc.indexOf('\n  buildWakePayload() {'));
ok(/MEMORY\.md/.test(wakeSeg), 'buildWakePayload 里读 MEMORY.md');
const idxSeg = wakeSeg.slice(wakeSeg.indexOf("'MEMORY.md'"), wakeSeg.indexOf("wake_manifest.md"));
ok(/WAKE_MEMORY_INDEX_MAX_BYTES/.test(idxSeg), '注入 MEMORY.md 的那段真的引用了上限常量');
ok(/memory_index_overweight/.test(idxSeg), '超重时挂上"去瘦身"的提示文案');

console.log('\n=== [3] 超重文案存在且带可操作指引 ===');
const ow = cfg.render('wake/memory_index_overweight', { kb: '40.9', maxKb: '8', droppedLines: '52', path: '/x/MEMORY.md' });
ok(ow.includes('40.9') && ow.includes('8'), '占位符 kb/maxKb 被真替换');
ok(ow.includes('52'), '告诉人格丢了多少行');
ok(ow.includes('/x/MEMORY.md'), '给出文件绝对路径(不然它不知道去改哪个)');
ok(/memory_upsert/.test(ow), '指明出路 = 细节挪进图节点, 不是让它硬删');
ok(!/\{\{/.test(ow), '没有漏替换的占位符');

console.log('\n=== [4] 截断按整行切, 不切碎条目/UTF-8 ===');
// 直接验行为: 造一份超重便条跑一遍真逻辑
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-budget-'));
const MAX = 8192;
const line = '- 🔴 这是一条中文的在办事项, 用来把便条撑到超过上限 → [[project_something_long]]';
const many = Array.from({ length: 400 }, (_, i) => line + i).join('\n');
fs.writeFileSync(path.join(tmp, 'MEMORY.md'), many);
// 复刻 agent.js 的切法(门禁跟实现同规则: 整行累加, 超了就停)
const lines = many.split('\n');
const kept = []; let used = 0;
for (const ln of lines) {
  const cost = Buffer.byteLength(ln) + 1;
  if (used + cost > MAX) break;
  kept.push(ln); used += cost;
}
ok(used <= MAX, `截断后不超上限: ${used}B <= ${MAX}B`);
ok(kept.length > 0 && kept.length < lines.length, `确实截掉了一部分: 留 ${kept.length}/${lines.length} 行`);
ok(kept.every((l) => l.startsWith('- 🔴')), '留下的每行都是完整条目(没有被切一半的)');
ok(!kept.join('\n').includes('�'), '没有 UTF-8 碎字');
fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n=== [5] 不超重时原样注入, 不加噪音 ===');
const small = '# 便条\n- 🔴 一件没干完的事 → [[project_x]]\n';
ok(Buffer.byteLength(small) <= MAX, '样本本身不超重');
// 不超重路径不该出现超重文案 —— 用源码结构保证: 截断分支在 if (rawBytes > MAX) 里
ok(/if\s*\(rawBytes\s*>\s*WAKE_MEMORY_INDEX_MAX_BYTES\)/.test(idxSeg), '截断走 if 分支, 不超重时零额外注入');

console.log('\n=== [6] CC 软链不许回潮 ===');
// 2026-08-13 作者定案: CC 里就没有 butler 人格的记忆。软链让 CC auto-memory 把 MEMORY.md 又装一遍,
// 且只在出生时建一次、失败只进日志 → 一整类静默失败。删干净了就不许再长回来。
const personaCode = CODE_ONLY(SRC('persona.js'));
const mainCode = CODE_ONLY(SRC('main.js'));
const agentCode = CODE_ONLY(agentSrc);
ok(!/ensureCcSymlink/.test(personaCode), 'persona.js 代码里没有 ensureCcSymlink');
ok(!/ensureCcSymlink/.test(mainCode), 'main.js 代码里没有 ensureCcSymlink 调用');
ok(!require('../core/persona.js').ensureCcSymlink, 'persona.js 不再导出 ensureCcSymlink');
for (const [f, src] of [['persona.js', personaCode], ['main.js', mainCode], ['agent.js', agentCode]]) {
  ok(!/symlinkSync|junction/.test(src), `${f} 代码里没有建软链的调用`);
}
// 更严: 不许有任何地方往 ~/.claude/projects/<slug>/memory 写
ok(!/projects['"\s,)\]]*[^\n]*['"]memory['"]/.test(personaCode + mainCode),
   '没有代码再去拼 ~/.claude/projects/<slug>/memory 路径');
// 注释反过来要留着: 删掉原因就会有人再把它加回来
ok(/软链/.test(SRC('persona.js')), 'persona.js 保留了"为什么不再建软链"的说明');

console.log('\n=== [6.5] 真跑 buildWakePayload · 不是复刻逻辑 ===');
// 上面 [4] 验的是"同规则复刻", 门禁全绿而真路径是废的 —— 犯过。这里起真 Butler 走真函数。
const { Butler } = require('../core/agent');
const realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-real-'));
const realMem = path.join(realHome, '.claude', 'memory');
fs.mkdirSync(realMem, { recursive: true });
const fatLine = '- 🔴 一条中文在办事项, 细节全写在便条里(反面教材) → [[project_x]]';
const fat = Array.from({ length: 400 }, (_, i) => fatLine + i).join('\n');
fs.writeFileSync(path.join(realMem, 'MEMORY.md'), fat);
const b = new Butler(realHome, { name: '预算测试' });
const wake = b.buildWakePayload();
const idxStart = wake.indexOf(cfg.text('wake/memory_index_heading').trim());
ok(idxStart >= 0, '唤醒正文里有便条段');
ok(wake.includes('overweight'), '超重时真的挂上了警告');
ok(!wake.includes(fatLine + '399'), '最后一行没被注入(确实截了)');
ok(wake.includes(fatLine + '0'), '开头的条目还在(截尾不截头)');
const injectedIdx = wake.slice(idxStart);
const bodyOnly = injectedIdx.slice(0, injectedIdx.indexOf('🔴 **Truncated above'));
ok(Buffer.byteLength(bodyOnly) <= MAX + 200, `真注入的便条正文不超上限: ${Buffer.byteLength(bodyOnly)}B`);

// 反向: 瘦的便条原样进, 不加警告
fs.writeFileSync(path.join(realMem, 'MEMORY.md'), '# 便条\n- 🔴 一件没干完的事 → [[project_x]]\n');
const wakeSlim = new Butler(realHome, { name: '预算测试2' }).buildWakePayload();
ok(wakeSlim.includes('一件没干完的事'), '瘦便条原样注入');
ok(!wakeSlim.includes('overweight'), '不超重时没有警告噪音');
fs.rmSync(realHome, { recursive: true, force: true });

console.log('\n=== [7] 便条抬头得说清它是什么 ===');
// 抬头写"记忆索引(全文)"会诱导人格把细节往里塞 —— 名字本身就是设计
const heading = cfg.text('wake/memory_index_heading');
ok(/handoff note|not done yet/.test(heading), '抬头点明它是交接便条, 不是"记忆全文"');
ok(/\[\[|指针/.test(heading), '抬头指明细节走图记忆指针');

console.log('\n=== [8] 唤醒正文不许再塞记忆内容 (2026-08-17 作者: "醒来就塞上下文, 塞不起") ===');
// 砍掉的四段: 记忆心法全文 / pinned 全量 / hot top-5 / recent top-5, 约 3.3k tok 常驻。
// 它们在人格自己的记忆库里都查得到, 代码再塞一份 = 第二副本 + 每次苏醒白付。
// 收录判据: 唤醒正文只装【这一刻才有、库里查不到】的东西。这一段就是那条判据的门禁。
const wakeSeg8 = agentSrc.slice(agentSrc.indexOf('\n  buildWakePayload() {'));
const wakeCode = CODE_ONLY(wakeSeg8);
for (const [what, re] of [
  ['记忆心法全文 (UNIVERSAL_RULES)', /UNIVERSAL_RULES|memory_disciplines/],
  ['pinned 全量', /pinnedAll\s*\(/],
  ['hot 热记忆', /\.hot\s*\(/],
  ['recent 时间轴', /\.recent\s*\(/],
]) ok(!re.test(wakeCode), `buildWakePayload 里没有${what}`);
for (const f of ['memory_disciplines', 'memory_disciplines_heading', 'pinned_heading', 'hot_heading', 'recent_heading']) {
  ok(!fs.existsSync(path.join(__dirname, '..', 'core', 'config', 'wake', `${f}.md`)), `config/wake/${f}.md 已删除`);
}
// 删了硬注入就必须有触发句顶上, 否则人格空着醒来还不自知 —— 这才是这次改动真正的风险点。
const pre = cfg.text('wake/preamble');
ok(/memory_hot/.test(pre), '触发句点名第一个动作是 memory_hot');
ok(/memory_query/.test(pre), '触发句告诉人格规矩/用法自己 memory_query 查');
ok(/memory_admin\(op='pinned'\)/.test(pre), '触发句给出 pinned 的取用通路');
// 兜底另一半: 心法确实在出厂知识包里, 不是被删没了
const leaf = require('../core/config/onboarding/knowledge/leaf_core.json');
const leafArr = Array.isArray(leaf) ? leaf : (leaf.items || leaf.propositions || leaf.nodes || []);
const leafTxt = JSON.stringify(leafArr);
for (const [what, kw] of [
  ['动前先查', 'memory_query'], ['醒来先 hot', 'memory_hot'],
  ['用过强化', 'memory_touch'], ['pinned 定义', 'pinned'],
]) ok(leafTxt.includes(kw), `出厂知识包里仍有「${what}」相关命题(砍掉硬注入后的唯一来源)`);

console.log('\n=== [9] 真跑一遍: 唤醒正文确实瘦了 ===');
const home9 = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-slim-'));
const mem9 = path.join(home9, '.claude', 'memory');
fs.mkdirSync(mem9, { recursive: true });
fs.writeFileSync(path.join(mem9, 'MEMORY.md'), '# 便条\n- 🔴 一件没干完的事 → [[project_x]]\n');
const w9 = require('../core/agent').Butler ? new (require('../core/agent').Butler)(home9, { name: '瘦身测试' }).buildWakePayload() : '';
ok(w9.includes('memory_hot'), '正文里有触发句');
ok(!/你的红线|快查表\(/.test(w9), '正文里没有 pinned 段');
ok(!/最近在忙啥|热记忆 top/.test(w9), '正文里没有 hot 段');
ok(!/沉前查重/.test(w9), '正文里没有心法全文');
ok(w9.includes('一件没干完的事'), '交接便条仍在(这是留下来的核心)');
ok(Buffer.byteLength(w9) < 4096, `空库人格的唤醒正文 < 4KB: 实际 ${Buffer.byteLength(w9)}B`);
fs.rmSync(home9, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '✅' : '❌'} test-wake-budget: ${pass} 过 / ${fail} 败`);
process.exit(fail === 0 ? 0 : 1);
