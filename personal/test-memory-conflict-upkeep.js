// test-memory-conflict-upkeep.js — 记忆冲突「定期自动检出 + 收口记账」(作者 2026-08-13 派单)
// 跑法: node test-memory-conflict-upkeep.js
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const path = require('path');
const os = require('os');
const { MemoryGraph } = require('../core/memory.js');
const arb = require('../core/memory-arbitration.js');

const TEST_DIR = path.join(os.tmpdir(), 'butler-conflict-' + Date.now());
fs.mkdirSync(TEST_DIR, { recursive: true });

let pass = 0, fail = 0;
const assert = (actual, expected, label) => {
  const ok = actual === expected;
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); fail++; }
};
const DAY = 86400000;

const g = new MemoryGraph(TEST_DIR);

console.log('\n[1] 换词表达型冲突: jaccard 抓不到, 连边能抓到');
// 这两条讲同一件事、结论相反, 但措辞几乎不重叠 —— 2026-08-09 实测 jaccard 只有 1.8~3.3%(噪声水平)。
g.upsert({ id: 'feedback_sediment_dedupe_first', type: 'feedback', importance: 'high',
           description: '沉记忆之前必须先查重',
           body: '沉之前一律先 query 查 top-3, 主题重合就更新老节点。\n\n## 关联\n[[feedback_sediment_no_need_check]]' });
g.upsert({ id: 'feedback_sediment_no_need_check', type: 'feedback', importance: 'high',
           description: '发现新东西立刻存, 别掂量',
           body: '判据只有一条: 这是不是我原来不知道的。是就默认存, 不必事先翻旧账。' });
const tokA = arb.tokens('沉记忆之前必须先查重');
const tokB = arb.tokens('发现新东西立刻存, 别掂量');
const j = arb.jaccard(tokA, tokB);
console.log(`  (词面重叠 ${Math.round(j * 1000) / 10}% · 阈值 ${arb.SUSPECT_THRESHOLD * 100}%)`);
assert(j < arb.SUSPECT_THRESHOLD, true, '词面筛确实抓不到这对(信噪比≈1 的那类)');
const c1 = g.conflictCandidates({ max: 5 });
assert(c1.some((p) => arb.pairKey(p.a, p.b) === arb.pairKey('feedback_sediment_dedupe_first', 'feedback_sediment_no_need_check')), true,
       '靠"已连边"信号圈到了');
assert(/已连边/.test(c1[0].why), true, '理由里写清怎么圈中的');

console.log('\n[2] 端出来的信息够不够判: 必须给双方正文路径(摘要层判不出主张)');
const top = c1[0];
assert(fs.existsSync(top.a_path), true, 'A 的文件路径可直接 Read');
assert(fs.existsSync(top.b_path), true, 'B 的文件路径可直接 Read');

console.log('\n[3] project_* 不进候选 (记的是状态不是主张, 状态变了不叫冲突)');
g.upsert({ id: 'project_alpha_ship', type: 'project', description: 'alpha 要发版', body: '排期在下周。\n\n## 关联\n[[project_alpha_hold]]', exit_criteria: '发出去' });
g.upsert({ id: 'project_alpha_hold', type: 'project', description: 'alpha 暂缓', body: '先不发。', exit_criteria: '恢复排期' });
const c3 = g.conflictCandidates({ max: 20 });
assert(c3.some((p) => p.a.startsWith('project_') || p.b.startsWith('project_')), false, '候选里没有 project_*');

console.log('\n[4] 同族 id 也算一路信号 (没连边也能圈到)');
g.upsert({ id: 'reference_deploy_step_restart', type: 'reference', description: '部署后要重启', body: '改完 schema 必须重启服务。' });
g.upsert({ id: 'reference_deploy_step_reload', type: 'reference', description: '部署后热加载即可', body: '带 --reload 的实例不用重启。' });
const c4 = g.conflictCandidates({ max: 20 });
const famPair = c4.find((p) => arb.pairKey(p.a, p.b) === arb.pairKey('reference_deploy_step_restart', 'reference_deploy_step_reload'));
assert(!!famPair, true, '同族 id 被圈到');
assert(/同族 id/.test(famPair.why), true, '理由写明同族');

console.log('\n[5] 批量上限: 一次只端几对 (要读双方正文, 端多了读不完)');
assert(g.conflictCandidates({ max: 2 }).length <= 2, true, 'max=2 时最多 2 对');
assert(arb.SCAN_BATCH, 2, '默认批量 = 2');

console.log('\n[6] 记账后进冷却, 不再重复端同一对');
const settled = g.conflictSettle({ a: 'reference_deploy_step_restart', b: 'reference_deploy_step_reload',
                                   verdict: 'scoped', note: '一个说容器一个说 dev, 场景不同' });
assert(settled.verdict, 'scoped', '记下 verdict');
assert(settled.cooldownDays, 180, 'scoped 冷却 180 天');
const c6 = g.conflictCandidates({ max: 20 });
assert(c6.some((p) => arb.pairKey(p.a, p.b) === arb.pairKey('reference_deploy_step_restart', 'reference_deploy_step_reload')), false,
       '冷却期内不再端上来');

console.log('\n[7] 冷却到期后会再端一次, 并标明是回访');
const c7 = arb.conflictCandidates(g._fresh().nodes, g._fresh().links,
  { max: 20, audit: arb.readAudit(TEST_DIR), now: Date.now() + 181 * DAY });
const revisit = c7.find((p) => arb.pairKey(p.a, p.b) === arb.pairKey('reference_deploy_step_restart', 'reference_deploy_step_reload'));
assert(!!revisit, true, '181 天后重新出现');
assert(revisit.revisited, true, '标了 revisited(是回访不是首次)');

console.log('\n[8] asked_user 冷却最短 —— 问了用户没回, 过几天要再提醒');
g.conflictSettle({ a: 'feedback_sediment_dedupe_first', b: 'feedback_sediment_no_need_check', verdict: 'asked_user', note: '等作者定' });
assert(arb.COOLDOWN_DAYS.asked_user, 7, 'asked_user 冷却 7 天');
const c8 = arb.conflictCandidates(g._fresh().nodes, g._fresh().links,
  { max: 20, audit: arb.readAudit(TEST_DIR), now: Date.now() + 8 * DAY });
assert(c8.some((p) => arb.pairKey(p.a, p.b) === arb.pairKey('feedback_sediment_dedupe_first', 'feedback_sediment_no_need_check')), true,
       '8 天后重新端上来催答复');

console.log('\n[9] 非法 verdict 弹回 (免得记进一个引擎读不懂的账)');
let threw = '';
try { g.conflictSettle({ a: 'x', b: 'y', verdict: 'whatever' }); } catch (e) { threw = e.message; }
assert(/verdict 只能是/.test(threw), true, '非法 verdict 报错');

console.log('\n[10] arbitrate 判决即自动记账 (不必再调 settle)');
const gd = path.join(TEST_DIR, 'sub10');
fs.mkdirSync(gd, { recursive: true });
const g10 = new MemoryGraph(gd);
g10.upsert({ id: 'feedback_rule_old', type: 'feedback', description: '老口径', body: '一律走 A。\n\n## 关联\n[[feedback_rule_new]]' });
g10.upsert({ id: 'feedback_rule_new', type: 'feedback', description: '新口径', body: '改成一律走 B。' });
assert(g10.conflictCandidates({ max: 5 }).length > 0, true, '判之前是候选');
g10.arbitrate({ winner: 'feedback_rule_new', loser: 'feedback_rule_old', reason: '作者当面改的口径', basis: ['user_negated'] });
const a10 = arb.readAudit(gd);
assert(a10.pairs[arb.pairKey('feedback_rule_new', 'feedback_rule_old')].verdict, 'arbitrated', 'arbitrate 自己记了账');
assert(g10.conflictCandidates({ max: 5 }).length, 0, '判完不再端上来');

console.log('\n[11] 定期触发: 到点判定 + 打戳');
const gd11 = path.join(TEST_DIR, 'sub11');
fs.mkdirSync(gd11, { recursive: true });
const g11 = new MemoryGraph(gd11);
assert(g11.conflictScanDue().due, true, '从没扫过 → 到点');
g11.conflictMarkScanned();
assert(g11.conflictScanDue().due, false, '刚扫过 → 不到点');
assert(g11.conflictScanDue({ now: Date.now() + 8 * DAY }).due, true, '8 天后 → 又到点');
assert(arb.SCAN_INTERVAL_DAYS, 7, '默认 7 天一次');

console.log('\n[12] 账本落在记忆目录里, 跟着记忆走');
assert(fs.existsSync(path.join(gd11, arb.AUDIT_FILE)), true, `账本文件 ${arb.AUDIT_FILE} 已落盘`);
assert(arb.AUDIT_FILE.startsWith('.'), true, '点开头 —— 不被 _mdFiles 当节点扫进图');

console.log('\n[12b] 出厂知识彼此不互审, 但被改过一条就恢复互审');
{
  const gd = path.join(TEST_DIR, 'sub12b');
  fs.mkdirSync(gd, { recursive: true });
  const gb = new MemoryGraph(gd);
  // 出生灌注: 两条都是出厂原样, 而且连着边、都是规矩类 —— 不跳的话必然被圈成候选
  gb.upsert({ id: 'feedback_factory_a', type: 'feedback', importance: 'pinned', origin: 'birth',
              description: '出厂规矩甲', body: '一律先查再动手。\n\n## 关联\n[[feedback_factory_b]]' });
  gb.upsert({ id: 'feedback_factory_b', type: 'feedback', importance: 'pinned', origin: 'birth',
              description: '出厂规矩乙', body: '发现新东西必须立刻存下来。' });
  assert(gb.conflictCandidates({ max: 9 }).length, 0, '两条都是出厂原样 → 一对都不端');
  // 人格自己改写其中一条(不传 origin) → 标记消失 → 恢复互审
  gb.upsert({ id: 'feedback_factory_b', type: 'feedback', importance: 'pinned',
              description: '出厂规矩乙(我改过)', body: '存之前先查重, 别急着存。' });
  const after = gb.conflictCandidates({ max: 9 });
  assert(after.some((p) => arb.pairKey(p.a, p.b) === arb.pairKey('feedback_factory_a', 'feedback_factory_b')), true,
         '改过一条后这对恢复互审');
  // origin 刻意不继承 —— 这正是"已经不是出厂原样"的判据
  assert(gb._fresh().nodes['feedback_factory_b'].origin, '', '自己改写后 origin 标记消失');
  assert(gb._fresh().nodes['feedback_factory_a'].origin, 'birth', '没动过的那条仍是出厂标记');
}

console.log('\n[13] 接线: 工具/文案/起床注入都真接上了');
const agentSrc = require('./kernel-src').kernelSource();
// 2026-08-23: v1 记忆路径整块删了, 记忆工具只剩 memory-tools-v2.js 一处(同 test-memory-pinned-quota)。
const memToolsSrc = require('./kernel-src').readSrc('memory-tools-v2.js');
// 2026-09-07: 这两个口子并进了 memory_admin(op, args) —— 查的还是同一件事(实现在不在、
// 按得下去吗), 只是检查点从"工具注册了吗"下移成"op 有没有 + 合流口注册了吗"。
for (const op of ['conflict_scan', 'conflict_settle']) {
  assert(new RegExp(`^ {4}${op}: \\{`, 'm').test(memToolsSrc), true, `memory_admin 有 op=${op}`);
  assert(agentSrc.includes(`'mcp__butler__memory_${op}'`), false, `并入后的 memory_${op} 不该还在白名单里`);
}
assert(agentSrc.includes("'mcp__butler__memory_admin'"), true, 'memory_admin 进了 allowedTools');
// 印的字段必须是 conflictCandidates 真返回的(score/why)。取错字段不报错, 只是恒印 undefined。
const scanBlock = memToolsSrc.slice(memToolsSrc.indexOf('    conflict_scan: {'), memToolsSrc.indexOf('    conflict_settle: {'));
assert(/s\.score/.test(scanBlock), true, 'conflict_scan 印 score');
assert(/s\.jaccard/.test(scanBlock), false, 'conflict_scan 不印 conflictCandidates 没给的字段');
assert(/conflictCandidatesChunked/.test(scanBlock), true, 'conflict_scan 走分片版(同步全库普扫会把主进程占死几秒)');

// ── 全库普扫的归属(作者 2026-09-09 定案) ──────────────────────────────
// 旧口径是"起床时同步扫一遍全库"。实测 1683 条节点 = 141 万对 = 3.4 秒把主进程占死,
// 而起床恰恰是最不该卡的时刻。新口径: 普扫归 idle-watcher 的 CHECKUP 轨道, 空闲时分片跑。
// 🔴 这三条是反向断言 —— 守的是"重活别再挂回同步路上", 它退化时不会报错, 只会变卡。
// 只认真调用点 —— 光写 conflictScanDue 会被 util.js 里提到它的一句注释误伤。
assert(/memory\.conflict(ScanDue|Candidates)\(/.test(agentSrc), false, '起床清单里不许再有冲突普扫');
const idleSrc = require('./kernel-src').readSrc('idle-watcher.js');
assert(/conflictCandidatesChunked/.test(idleSrc), true, '普扫挪进了体检轨道, 且走分片版');
const decideBlock = idleSrc.slice(idleSrc.indexOf('function decideCheckup'), idleSrc.indexOf('async function runCheckup'));
assert(/memory\.doctor\(\)|conflictCandidates/.test(decideBlock), false,
  'decideCheckup 是每 30s 都走的同步决策, 里面不许跑 doctor / 普扫这种重活');

console.log('\n[13b] 真起一个 Butler, 看普扫挪走之后两边行为对不对');
// 🔴 只用正则扫源码不够: 08-12 刚栽过一次 —— 门禁全绿而真机每个按钮都红, 原因正是
// "测试从不测注入本身"。所以这里真建实例、真调 buildWakePayload(), 看返回的正文里有没有这段。
(async () => {
  const home = path.join(TEST_DIR, 'sub13b');
  fs.mkdirSync(home, { recursive: true });
  const { Butler } = require('../core/agent.js');
  const b = new Butler(home, { name: '测试新生儿' });
  const gm = b.memory;
  // 🔴 这里用 v2 写法(slug + claim), 不是 v1 的 id + description。
  // 装上新版本之后 Butler 起来就是 v2(BUTLER_MEMORY_V2 默认开), 所以拿 v1 API 写的断言
  // 验的是一个发版后不存在的世界 —— 绿了也不说明真机上这段还在工作。
  // 上面 [1]~[13a] 显式 new MemoryGraph 直测 v1 引擎, 不受开关影响, 保持原样。
  // 🔴 先建 y 再建 x: v2 不再从正文正则抠边, links 要显式传, 而 links 里的目标
  // 得先存在才 resolve 得到(建 x 时 y 还没有 → 边悄悄没建成 → 三路主信号一路都不中 → 圈不出候选)。
  gm.upsert({ slug: 'feedback_my_rule_y', type: 'feedback', importance: 'high',
              claim: '命题: 必须先请示再动手', body: '必须先请示再动手。' });
  gm.upsert({ slug: 'feedback_my_rule_x', type: 'feedback', importance: 'high',
              claim: '命题: 一律先斩后奏', body: '一律先斩后奏。',
              links: ['feedback_my_rule_y'] });
  assert(/Memory conflict checkup/.test(b.buildWakePayload()), false, '起床清单里一个字都不再提冲突(重活挪走了)');

  // 分片版必须真扫得出来 —— 挪走归挪走, 功能不能跟着没了。
  const pairs = await b.memory.conflictCandidatesChunked({ max: 8 });
  const ids = pairs.map((p) => `${p.a.slug}|${p.b.slug}`).join(' ');
  assert(/feedback_my_rule_x/.test(ids) && /feedback_my_rule_y/.test(ids), true, '分片版圈得出这一对');
  assert(/\[object Object\]/.test(ids), false, '候选没被渲染成 [object Object]');

  // 检索那条路只算跟本次命中沾边的对。全库两两配对是平方级的, 挂在每次 query 上
  // 实测 3.4 秒占死主进程 —— 这条守的就是"seeds 必须传下去", 退化时不报错只变卡。
  const seeded = b.memory.conflictCandidates({ max: 8, seeds: new Set() });
  assert(seeded.length, 0, '种子集为空 → 一对都不算(证明真按 seeds 走, 没有偷偷全库扫)');

  console.log('\n[14] 清理');
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  assert(fs.existsSync(TEST_DIR), false, '临时目录已清理');

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();
