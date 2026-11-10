// 出厂知识同步 (factory-sync.js) 回归测试
// 跑: node test-factory-sync.js
//
// 盯的是升级那一刻最怕出的事: 拿出厂原文冲掉人格自己长出来的记忆。
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const path = require('path');
const os = require('os');
const factory = require('../core/factory-sync');
const { MemoryGraphV2 } = require('../core/memory-v2.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

const NAME = '测试飞飞';
const mkGraph = () => new MemoryGraphV2(fs.mkdtempSync(path.join(os.tmpdir(), 'butler-factory-')));
const nodeOf = (g, slug) => g.store.nodeBySlug(slug);

// v0.0.58 版出厂包(假装)
const V1_ITEMS = [
  { slug: 'reference_alpha', type: 'reference', importance: 'high', title: 'Alpha',
    claim: '旧版说法: alpha 走 A 路径。', keywords: 'alpha 路径', seed_use_count: 3 },
  { slug: 'reference_beta', type: 'reference', importance: 'high', title: 'Beta',
    claim: 'beta 恒定不变。', keywords: 'beta' },
  { slug: 'reference_gamma', type: 'reference', importance: 'med', title: 'Gamma',
    claim: 'gamma 这条下一版会被拿掉。', keywords: 'gamma' },
];
// v0.0.59 版: alpha 改了说法, gamma 拿掉了, delta 是新增的
const V2_ITEMS = [
  { slug: 'reference_alpha', type: 'reference', importance: 'high', title: 'Alpha',
    claim: '新版说法: alpha 改走 B 路径。', keywords: 'alpha 路径 B', seed_use_count: 3 },
  { slug: 'reference_beta', type: 'reference', importance: 'high', title: 'Beta',
    claim: 'beta 恒定不变。', keywords: 'beta' },
  { slug: 'reference_delta', type: 'reference', importance: 'high', title: 'Delta',
    claim: 'delta 是这一版新增的能力。', keywords: 'delta 新增' },
];

console.log('\n=== 首次同步 = 出生灌注 ===');
const g = mkGraph();
const s1 = factory.syncFactory(g, { name: NAME, items: V1_ITEMS, log: () => {} });
ok(s1.failed.length === 0, '零失败' + (s1.failed.length ? ' — ' + s1.failed.join(' | ') : ''));
ok(s1.created === 3 && s1.updated === 0, `空库全是新建 (created=${s1.created})`);
ok(nodeOf(g, 'reference_alpha').is_factory === 1, '建出来的标了出厂');
ok(nodeOf(g, 'reference_alpha').use_count === 3, 'seed_use_count 落库(冷启动排序初值)');

console.log('\n=== 再同步一次: 内容没变就不写 ===');
g.touch(['reference_alpha']);
const hotCount = nodeOf(g, 'reference_alpha').use_count;
const s2 = factory.syncFactory(g, { name: NAME, items: V1_ITEMS, log: () => {} });
ok(s2.unchanged === 3 && s2.updated === 0 && s2.created === 0, `全部判为未变 (unchanged=${s2.unchanged})`);
ok(nodeOf(g, 'reference_alpha').use_count === hotCount,
   `没变就不写, 热度不被 auto-touch 打扰 (${hotCount})`);
ok(!factory.hasChanges(s2), '没变化时不该惊动人格');

console.log('\n=== 升级: 改的覆盖 · 新的插入 · 没了的归档 ===');
const s3 = factory.syncFactory(g, { name: NAME, items: V2_ITEMS, log: () => {} });
ok(s3.updated === 1 && s3.updatedSlugs[0] === 'reference_alpha', '改了说法的那条被覆盖');
ok(/B 路径/.test(nodeOf(g, 'reference_alpha').claim), '库里读到的是新版命题');
ok(s3.created === 1 && s3.createdSlugs[0] === 'reference_delta', '新增的那条插进来了');
ok(s3.archived === 1 && s3.archivedSlugs[0] === 'reference_gamma', '这版拿掉的那条被归档');
ok(nodeOf(g, 'reference_gamma').status === 'archived', '归档是改状态, 不是删除(万一包写漏了还能翻回来)');
ok(nodeOf(g, 'reference_beta').claim === 'beta 恒定不变。', '没动的那条原样不动');
ok(factory.hasChanges(s3), '有变化时会告诉人格');

console.log('\n=== 🔴 人格自己长出来的记忆: 一个字都不许动 ===');
const g2 = mkGraph();
factory.syncFactory(g2, { name: NAME, items: V1_ITEMS, log: () => {} });
// 人格自己沉了一条, 恰好占用了下一版出厂包要用的 slug
g2.upsert({ slug: 'reference_delta', type: 'reference', title: '我自己的 delta',
            claim: '这是我自己踩坑得出来的, 不是出厂给的。', keywords: '自己的', actor: NAME });
// 人格自己的另一条, 与出厂包毫无关系
g2.upsert({ slug: 'feedback_my_own', type: 'feedback', title: '我的经验',
            claim: '我自己的经验, 升级不该碰它。', keywords: '经验' });
const mine = nodeOf(g2, 'feedback_my_own');
const s4 = factory.syncFactory(g2, { name: NAME, items: V2_ITEMS, log: () => {} });
ok(s4.skipped.includes('reference_delta'), 'slug 撞车时让位给人格自生, 不抢名');
ok(/我自己踩坑/.test(nodeOf(g2, 'reference_delta').claim), '被占用那条的正文没被出厂原文冲掉');
ok(nodeOf(g2, 'reference_delta').is_factory === 0, '让位的那条仍属人格自己');
ok(nodeOf(g2, 'feedback_my_own').claim === mine.claim, '无关的自生记忆纹丝不动');
ok(nodeOf(g2, 'feedback_my_own').status !== 'archived', '自生记忆不会被"清单外归档"误伤');

console.log('\n=== 灌库时漏标 is_factory 的出厂条目: 认领回来, 别当成人格自生 ===');
const g5 = mkGraph();
// 早期灌库路径建的出厂条目 —— 内容是出厂原文, 但 is_factory 没打上, actor 也不是这个人格。
g5.upsert({ slug: 'reference_alpha', type: 'reference', title: 'Alpha',
            claim: '旧版说法: alpha 走 A 路径。', keywords: 'alpha 路径', actor: 'education' });
const s5 = factory.syncFactory(g5, { name: NAME, items: V2_ITEMS, log: () => {} });
ok(s5.reclaimed.includes('reference_alpha'), '人格从没写过它 → 认领, 不再让位');
ok(nodeOf(g5, 'reference_alpha').is_factory === 1, '认领后标上出厂, 以后正常吃升级');
ok(/B 路径/.test(nodeOf(g5, 'reference_alpha').claim), '认领的同时把新版正文灌进去');
ok(!s5.skipped.includes('reference_alpha'), '认领的条目不再计入让位');

console.log('\n=== 领域节点(出厂标记但不在任何包里)不被误归档 ===');
const g3 = mkGraph();
factory.syncFactory(g3, { name: NAME, items: V1_ITEMS, log: () => {} });
g3.upsert({ slug: 'user_my_domain', type: 'user', title: `${NAME} 的领域`,
            claim: '我这个人格的领域是: 测试', keywords: '领域', is_factory: 1 });
factory.syncFactory(g3, { name: NAME, items: V2_ITEMS, log: () => {} });
ok(nodeOf(g3, 'user_my_domain').status !== 'archived',
   'user_my_domain 是每个人格独有的出厂节点, 豁免于清单比对');

console.log('\n=== 真包跑一遍: 出生 = 空库同步, 再跑一次应当零变化 ===');
const g4 = mkGraph();
const r1 = factory.syncFactory(g4, { name: NAME, isButler: true, log: () => {} });
ok(r1.failed.length === 0, '真包零失败' + (r1.failed.length ? ' — ' + r1.failed.join(' | ') : ''));
ok(r1.created > 50, `真包灌了 ${r1.created} 条`);
ok(r1.edges > 0 && r1.redlines >= 0, `边 ${r1.edges} 条也连上了`);
const r2 = factory.syncFactory(g4, { name: NAME, isButler: true, log: () => {} });
ok(r2.created === 0 && r2.updated === 0 && r2.archived === 0,
   '同一版重复同步必须零变化 —— 否则每次开机都在假装升级');
ok(!factory.hasChanges(r2), '零变化时不打扰人格');

console.log('\n=== 接线 ===');
const agentSrc = require('./kernel-src').kernelSource();
ok(/factory\.syncFactory/.test(agentSrc), 'agent.js 在升级点真调了同步器');
ok(/wake\/factory_synced/.test(agentSrc), '有变化时会在唤醒正文告知');

// 🔴 只报数字, 不铺名字。2026-08-17 实测: 棒头 0.0.52→0.0.58 铺出 96 条 slug = 4785 字节,
// 占整份唤醒正文的一半。那串名字对人格不可读也不可操作 —— 要用知识是 memory_query 查,
// 没有任何一步需要先知道 slug 叫什么。回潮的样子就是这里又出现 createdSlugs.join。
{
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'core', 'config', 'wake', 'factory_synced.md'), 'utf8');
  ok(!/\{\{changes\}\}/.test(tpl), '模板不再有铺清单的槽位');
  ok(/\{\{created\}\}/.test(tpl), '改成报条数');
  const at = agentSrc.indexOf('wake/factory_synced');
  const seg = agentSrc.slice(Math.max(0, at - 600), at + 300);
  ok(!/(created|updated|archived)Slugs\s*\.\s*join/.test(seg),
     '🔴 唤醒正文不铺 slug 清单(一次升级上百条, 铺出来就是半份正文)');
}

const birthSrc = fs.readFileSync(path.join(__dirname, 'birth.js'), 'utf8');
ok(/factory\.syncFactory/.test(birthSrc), '出生走同一个同步器(不留第二份映射)');

// 🔴 2026-08-20 实撞: 同步器内部早就不看 app 版本号了, 可它住在 buildWakePayload() 里,
// 而那个函数由 main.js 三条件(全新人格 / 有未消费 ctx_last / app 版本变了)决定调不调。
// 于是"改了出厂包但没 bump 版本号"时三条件全不成立, 同步一次都不跑, dev 四个人格库
// 全停在老版 body 且无任何报错。修在内层不算修 —— 外层这道闸才是真正拦住它的那道。
{
  const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const atSync = mainSrc.indexOf('runFactorySync');
  // 认条件本身而不是整句 `if (…` —— 闸门前面还挂着 newborn 短路(新生儿不发冷启动唤醒),
  // 按整句找会在闸门加任何前缀时变成假红。
  const atGate = mainSrc.indexOf('!hasHadAssistant');
  ok(atSync !== -1, '🔴 main.js 冷启动时真调了出厂同步(不靠唤醒流程放行)');
  ok(atSync !== -1 && atGate !== -1 && atSync < atGate,
     '🔴 同步跑在 wake 三条件闸门【之前】—— 排到后面等于又被闸住');
  ok(/factoryChanged/.test(mainSrc), '出厂包真有变动时也能触发一次 wake(否则人格不知道自己变了什么)');

  // buildWakePayload 只许消费同步结果, 不许自己再跑一遍: 重跑会把 unchanged 算两遍,
  // 也会让"同步到底跑没跑"重新取决于唤醒流程。
  const atWake = agentSrc.indexOf('\n  buildWakePayload() {');
  const wakeSeg = agentSrc.slice(atWake);
  ok(!/factory\.syncFactory\(/.test(wakeSeg),
     '🔴 buildWakePayload 里不再直接调同步器(改成拿 runFactorySync 的缓存)');
  ok(/this\.runFactorySync\(\)/.test(wakeSeg), 'buildWakePayload 从缓存取结果');
}

// 下发的核心记忆副本(bundle_id 同为 leaf_core)只在版本号不旧于随包那份时才替换它:
// 货架还停在旧版时, 新安装包自带的那份不能被盖掉(11-08)。
{
  console.log('\n[下发包与随包核心记忆: 版本新的赢]');
  const factory = require('../core/factory-sync');
  const mine = factory.loadFactoryItems({}).items.find((x) => x.bundle === 'leaf_core');
  const shipped = mine ? mine.version : '0.0.0';
  const pack = (v) => [{ id: 'core', knowledge: { bundle_id: 'leaf_core', version: v, items: [{ slug: 'probe_pack_only_x', claim: 'x' }] } }];
  const has = (r) => r.items.some((x) => x.item.slug === 'probe_pack_only_x');
  ok(!has(factory.loadFactoryItems({ packs: pack('0.0.1') })), `旧版下发包(0.0.1)不盖随包 ${shipped}`);
  ok(has(factory.loadFactoryItems({ packs: pack(shipped) })), '同版本取下发那份');
  ok(has(factory.loadFactoryItems({ packs: pack('99.0.0') })), '新版下发包替换随包那份');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
