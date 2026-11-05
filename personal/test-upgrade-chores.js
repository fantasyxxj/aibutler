#!/usr/bin/env node
// test-upgrade-chores.js — 装了新版本之后, 人格该对自己做的调整会不会真的发生。
//
// 背景(2026-08-17 作者): 棒头真副本升级重跑, 三件事同时暴露 —— 更新说明没显示、没人去清理
// 记忆、两条出厂 pinned 条目被老库存量顶掉且只打了一行 stdout。共同点是**都靠人格自觉**,
// 而人格不会自己想起来。所以这批活得像迁移待办一样: 落库 · 硬端到眼前 · 做完才消失。
//
// 这里不只扫源码 —— 真建实例、真调 buildWakePayload(), 看正文里有没有那一段。
// (08-12 栽过: 门禁全绿而真机每个按钮都红, 正因为测试从不测注入本身。)

require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const path = require('path');

const TEST_DIR = '/tmp/butler-upgrade-chores-test';
fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DIR, { recursive: true });

let pass = 0; let fail = 0;
const assert = (got, want, label) => {
  const ok = got === want;
  console.log(`${ok ? '✅' : '❌'} ${label}${ok ? '' : `  — 期望 ${want}, 实得 ${got}`}`);
  ok ? pass++ : fail++;
};

const { Butler } = require('../core/agent.js');
const home = path.join(TEST_DIR, 'sub');
fs.mkdirSync(home, { recursive: true });
const b = new Butler(home, { name: '升级任务测试' });
const st = b.memory.store;

console.log('=== [1] 队列本身: 幂等 + 做完不复活 ===');
assert(st.enqueueChore({ key: 'k1', version: '0.0.58', title: '甲', detail: 'd' }), true, '新 key 派得进去');
assert(st.enqueueChore({ key: 'k1', version: '0.0.58', title: '甲', detail: 'd' }), false, '同 key 重开机不重复派');
assert(st.choresPending().length, 1, '队列里就一件');
st.choreDone('k1');
assert(st.choresPending().length, 0, '标完成后出队');
assert(st.enqueueChore({ key: 'k1', version: '0.0.59', title: '甲', detail: 'd' }), false,
  '🔴 已经 done 的不复活 —— 干完的活再跳回眼前, 人格第二次就不信这个队列了');

console.log('\n=== [2] 空队列零注入 (每次推一段"本次无待办"等于教人格跳过不看) ===');
assert(/🔧 New version installed/.test(b.buildWakePayload()), false, '没待办 → 一个字都不注');

console.log('\n=== [3] 引擎自检: 快查表超配额就派活 ===');
// 造一个超配额的老库形态: 直连 store.setPinned 绕过闸(闸在 graph 层), 模拟迁移器搬进来的存量
for (let i = 0; i < 33; i++) {
  const id = st.upsertNode({ slug: `reference_old_pin_${i}`, title: `老存量${i}`, claim: `c${i}`, type: 'reference' });
  st.setPinned(id, '迁移搬入');
}
const audit = b.memory.pinnedAudit();
assert(audit.used > audit.quota, true, `确实超了 (${audit.used}/${audit.quota})`);

const n = b._enqueueUpgradeChores({ pinnedBlocked: [
  { slug: 'feedback_reply_to_the_channel_it_came_from', title: '从哪条通路来就回哪条' },
] }, '0.0.58');
// 🔴 别断言总件数。队列里同时有出厂包带的活和引擎自检出来的活, 一加出厂 chore 就把这里
// 撞红(2026-08-17 已撞过一次), 而"派了几件"从来不是这一节要验的事 —— 按 key 精确取。
const byKey = (k) => st.choresPending().find((c) => c.key === k);
assert(n >= 1, true, '引擎自检派出来了');
const chore = byKey('pinned_over_quota@0.0.58');
assert(!!chore, true, '派的是快查表超配额那件');
assert(/pinned set/.test(chore.title), true, '标题说清了要干什么');
assert(chore.title.includes(String(audit.used)), true, '标题带实数 (不是写死的占位数字)');
assert(/feedback_reply_to_the_channel_it_came_from/.test(chore.detail), true,
  '🔴 点名了这次被顶掉的出厂条目 —— 老实现只有一行 stdout, 用户和人格都不知道少了什么');

console.log('\n=== [4] 判据是"超了"而不是"这次有没有被挡" ===');
st.choreDone(chore.key);
// 这一版没带 pinned 类出厂条目 → blocked 为空, 但库仍然超标, 活照派
const n2 = b._enqueueUpgradeChores({ pinnedBlocked: [] }, '0.0.59');
assert(n2 >= 1, true, '没有条目被挡也照样派 (否则老库永远轮不到收拾)');
assert(/costs on every reply/.test(byKey('pinned_over_quota@0.0.59').detail), true, '说明里讲清了为什么现在就得收');

console.log('\n=== [4.5] 引擎自检: 命题行带日期就派活(存量清洗必须跟着版本走, 不能只有作者自己清) ===');
{
  // 冷门的带日期命题: 用过 1 次。它不该把活派出来 —— 冷门节点的烂命题不影响任何检索。
  st.upsertNode({ slug: 'reference_cold_dated', title: '冷门', type: 'reference',
    claim: '命题: 2026-08-01 那天改了个东西', use_count: 1 });
  const n3 = b._enqueueUpgradeChores({ pinnedBlocked: [] }, '0.0.60');
  assert(!byKey('dirty_claims@0.0.60'), true,
    '🔴 只有冷门脏命题时不派活 —— 长尾算进来会让人一看分母就放弃, 整条轨道空转');

  // 热的带日期命题: 用过 9 次, 这种每次检索都在误导人
  st.upsertNode({ slug: 'reference_hot_dated', title: '热门', type: 'reference',
    claim: '命题: 2026-08-16 完工: append 换成 section+write', use_count: 9 });
  b._enqueueUpgradeChores({ pinnedBlocked: [] }, '0.0.61');
  const dc = byKey('dirty_claims@0.0.61');
  assert(!!dc, true, '有热的脏命题 → 派活');
  assert(/\d/.test(dc.title), true, '标题带实数(每个人格库里脏多少条不一样, 写死当场就错)');
  assert(/reference_hot_dated/.test(dc.detail), true, '点名最热的那几条, 不是让人自己去找');
  assert(!/reference_cold_dated/.test(dc.detail), true, '冷门那条没混进清单');
  // 🔴 存量清洗的正路是"用到了顺手改 + 没用到的隔段时间来一批"(v1→v2 迁移就是这么还的)。
  // 这条 chore 只教判据 + 带做第一小批, 不许把整个欠账摆到眼前 —— 摆出来就是没人做得动的清单,
  // 而做不动的清单会把整条轨道训成噪音, 连该做的那几条也一起被跳过。
  assert(/done when those are fixed/.test(dc.detail), true,
    '🔴 明说这件活就这一小批, 不是让人清库');
  assert(/don't need attention right now/.test(dc.detail), true, '明说剩下的现在不用管');
  assert(/Fix on touch/.test(dc.detail) && /batches over time/.test(dc.detail), true,
    '🔴 交代了剩下那些走哪两条腿(用到了改 / 体检一批批来), 否则人格会以为欠账没人管');
  assert(/Don't try to fix the whole store at once/.test(dc.detail), true, '明确劝阻一次做完');
  assert(/guide action right now/.test(dc.detail), true,
    '🔴 给的是判据不是"你有 N 条脏的" —— 光报数没人知道该删哪句');
  assert(/Pass only claim, never body/.test(dc.detail), true,
    '🔴 写明只传 claim 别传 body(照着改会顺手把正文冲了)');
  assert(/memory_revisions|history/.test(dc.detail), true, '告诉它改错了回得去, 否则不敢动');
  st.choreDone(dc.key);
}

console.log('\n=== [5] 硬端到眼前 (真调 buildWakePayload) ===');
const wake = b.buildWakePayload();
assert(/🔧 New version installed/.test(wake), true, '🔴 起床清单正文里真出现了这一段');
assert(wake.includes(`${st.choresPending().length} things`), true, '报了件数 (实数, 不是写死的)');
assert(wake.includes("memory_admin(op='chore_done'"), true, '告诉了它做完怎么标');
assert(st.choresPending().every((c) => wake.includes(c.key)), true,
  '每件都给了 key (漏一件那件就永远标不掉)');
assert(/memory_admin\(op='pinned'\)/.test(wake), true, '告诉了它先用哪个工具看全表');
assert(/must apply in every reply/.test(wake), true, '给了判据 —— 只留每句回话都要用的');

console.log('\n=== [6] 没做完就一直端, 做完自己消失 ===');
assert(/🔧 New version installed/.test(b.buildWakePayload()), true, '再苏醒一次仍然端');
for (const c of st.choresPending()) st.choreDone(c.key);
assert(/🔧 New version installed/.test(b.buildWakePayload()), false, '全做完 → 这段消失');

console.log('\n=== [7] 出厂包能带任务 (下一版加新活不用改代码) ===');
const factory = require('../core/factory-sync.js');
assert(Array.isArray(factory.loadFactoryChores({ isButler: false })), true, '装载器在, 包里没写就是空数组');

console.log('\n=== [8] pinned 撞闸不再混进 failed ===');
const fsrc = require('./kernel-src').readSrc('factory-sync.js');
assert(/pinnedBlocked\.push/.test(fsrc), true, '撞闸走 pinnedBlocked');
assert(/stats\.failed\.push\(`\$\{p\.slug\} pinned/.test(fsrc), false,
  '不再混进 failed (混着就只剩一行 stdout)');

console.log('\n=== [9] 用户侧说明: 聊天里直接显示, 不是一行光秃秃的路径 ===');
const cu = require('../core/capability-update.js');
const md = cu.renderNotesMd([
  { version: '0.0.57', items: [{ title: '记性变好了', detail: 'd1' }] },
  { version: '0.0.58', items: [{ title: '自己收拾记忆', detail: 'd2' }] },
]);
assert(/- 记性变好了/.test(md), true, 'markdown 列表 (要过渲染管线的)');
assert(/- 自己收拾记忆/.test(md), true, '跨版的每一条都列');
assert(/d1/.test(md), false, '气泡里只出 title, 细节点开完整版看');

const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
assert(/md: true/.test(mainSrc), true, '🔴 消息带 md 标记 (system 气泡默认纯文本, 不标就是一坨)');
const rendSrc = fs.readFileSync(path.join(__dirname, 'renderer', 'renderer.js'), 'utf8');
assert(/m\.role === 'assistant' \|\| m\.md/.test(rendSrc), true, '渲染层认这个标记');
assert(/renderer\/style\.css/.test('renderer/style.css')
  && /update-note/.test(fs.readFileSync(path.join(__dirname, 'renderer', 'style.css'), 'utf8')), true,
  '卡片样式在 (不然继承 system 的居中灰 12px, 长文没法读)');

console.log('\n=== [10] 出厂包带的 chore: 红线与 pinned 分家要主动告诉人格 ===');
// v2 把红线从 importance 拆成了独立表, 但知识只躺在库里 = 人格不查就不知道。棒头真副本实测:
// pinned 表 0 条 · redlines 2 条 —— 分家发生了, 它一次没归位过。所以这版必须派活, 不是等它自己发现。
const factory2 = require('../core/factory-sync.js');
const split = factory2.loadFactoryChores({ isButler: false }).find((c) => c.key === 'redline_pinned_split');
assert(!!split, true, '出厂包(leaf_core)带得出这条 chore');
assert(factory2.loadFactoryChores({ isButler: true }).some((c) => c.key === 'redline_pinned_split'),
  true, '管家版也拿得到 (两边都要归位)');
assert(/@/.test(split ? split.key : '@'), false,
  '🔴 key 不带版本号 —— 带了就每升一版复活一次, 而这是一次性的活');
assert(/memory_admin\(op='set_redline'\)/.test(split.detail) && /memory_admin\(op='set_pinned'\)/.test(split.detail), true,
  '给出动手用的两个工具 (只讲区别不给工具 = 听完还是不知道怎么归位)');
assert(/memory_admin\(op='redlines'\)/.test(split.detail) && /memory_admin\(op='pinned'\)/.test(split.detail), true,
  '先让它看自己两张表的现状 (不看现状无从判断该动谁)');
// 🔴 断言写的是英文, 因为 chore 正文只有模型读得到、用户在窗口里看不见 → 一律英文单份。
// 用户看得见的那两处(起床语 / 出生教育)才四语, 别把这两类混起来改。
assert(/an incident/i.test(split.detail) && /most-consulted/i.test(split.detail), true,
  '🔴 两条判据都写明 (红线=违反出事故 · pinned=最常查不是最重要; 混了就会拿重要性去标 pinned)');
assert(/correct action/i.test(split.detail), true, '带上"红线必须写正确做法"这条约束');
// 分家是三分不是二分: 实测码上飞 pinned 30 条 = 红线 13 · 真快查 4 · 判断口径/哲学 13。
// 第三类既不该被程序拦(不是动作)也不该占快查名额(不是具体值), 归宿是主库 high。只教二分
// 的话这 13 条无处可去, 人格只会原地不动 —— 名额还是满的, 分家等于没做。
assert(/memory_admin\(op='set_importance'\)/.test(split.detail), true,
  '🔴 给出降档工具 (第三类要撤出 pinned; 不给工具它就只能留着)');
// 理由必须是 auto-touch 污染热度, 不能再说"upsert 会把正文冲掉": 不传 body 一个字都不动。
// 拿一句假话当理由, 人格照做也只是碰巧对, 换个场景就会从它推出错结论。
assert(/memory_upsert/.test(split.detail) && /热度|use_count|touch/.test(split.detail), true,
  '🔴 说清别拿 upsert 改档位的真理由 (每次 auto-touch 把 use_count +1, 元数据维护污染热度排序)');
// 只禁【肯定说法】。正文里那句 "not because you'd lose the body" 是否定, 正是要的, 别误伤
// (同 test-birth-gift 对 "born empty" 的处理)。
assert(/(?:upsert|it) (?:will |would |can )?(?:overwrite|wipe|clobber)s? the body|冲掉正文|覆盖 body/i.test(split.detail), false,
  '🔴 没退回"upsert 会冲掉正文"那句假话 (只有传了 body 才替换正文)');
assert(/philosophy|judgement call|判断口径/i.test(split.detail), true,
  '🔴 讲到第三类 (只教红线/快查二分, 占掉一半名额的判断口径类就无处可去)');
// 出厂文案不许写死条数: 我第一版写"你那 30 条里", 棒头实机是 63 条(超配额) —— 当场就是错的。
// 同 migration_todo 写死 888 那个坑: 出厂包对每个人格讲同一句话, 凡具体数字必须来自运行时。
assert(/\d+\s*条/.test(split.title), false,
  '🔴 标题不写死条数 (各人格 pinned 存量不同, 写死当场就错)');

try { b.memory.close && b.memory.close(); } catch (_) {}
fs.rmSync(TEST_DIR, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 绿 ${fail} 红`);
process.exit(fail === 0 ? 0 : 1);
