// test-checkup-gate.js — 记忆库定期体检的两个纯判定。
// 门禁只测 checkup-gate.js 导出的纯函数, 不抄 main.js 的 decideActions
// (test-idle-watcher.js 那份抄本连 MIGRATE 都没抄, 再往里加只会让偏差更大)。
'use strict';

const { checkupGate, checkupFindings, CHECKUP_IDLE_MIN } = require('../core/checkup-gate');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log('  ✓', label); pass++; }
  else { console.log('  ✗', label); fail++; }
}

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;   // 固定值, 不用 Date.now() —— 门禁不该依赖真实时钟

// 默认: 空闲够久 · 从没体检过 → 该体检
function g(over = {}) {
  return checkupGate({
    running: false,
    idleMin: CHECKUP_IDLE_MIN + 1, ctxTok: 10_000,
    lastCheckupTs: 0, now: NOW, ...over,
  });
}

console.log('\n[checkupGate · 什么时候该体检]');
ok(g() && g().reason === 'never_checked', '从没体检过 → 立刻体检');
ok(g({ lastCheckupTs: NOW - 8 * DAY }) !== null, '距上次 8 天(默认周期 7) → 到期');
ok(g({ lastCheckupTs: NOW - 8 * DAY }).reason === 'interval_due', '到期的 reason 是 interval_due');
ok(g({ lastCheckupTs: NOW - 3 * DAY }) === null, '距上次才 3 天 → 还不到');
ok(g({ lastCheckupTs: NOW - 6.9 * DAY }) === null, '差一点点不到 7 天 → 不体检(边界)');
ok(g({ lastCheckupTs: NOW - 7.01 * DAY }) !== null, '刚过 7 天 → 体检(边界)');

console.log('\n[checkupGate · 什么时候必须闭嘴]');
ok(g({ running: true }) === null, '回合进行中 → 不插队(会拆掉正在跑的流)');
ok(g({ idleMin: CHECKUP_IDLE_MIN - 1 }) === null, '空闲不够久 → 等');
ok(g({ ctxTok: 400_000 }) === null, '上下文已经很肥 → 先别加, 等压缩收回去');
ok(g({ cfg: { checkupIntervalDays: 0 } }) === null, '周期设 0 = 逃生门, 整个关掉');

// 🔴 防回归 (2026-08-18): dirty / questionPending 两道门被拆掉了, 加回去这条轨道就再也不触发。
// 病史: 照抄 migrate-gate 的口径, 结果真库 meta 表里连 last_checkup_ts 都没有 —— 上线以来
// 一次都没跑成。根因是两道门语义互斥(dirty=false 要"用户没说过话", questionPending=false
// 要"用户回话了"), 且 dirty 只有 COMPACT 清空才归零, 是个不会自愈的锁。
// 「别打扰」的唯一正确表达是 idleMin —— 它会自然恢复。
console.log('\n[checkupGate · 🔴 防回归: 拆掉的两道门别加回来]');
ok(g({ dirty: true }) !== null, '用户聊过(dirty=true)照样体检 —— 空闲够久就是不打扰');
ok(g({ questionPending: true }) !== null, 'AI 上一轮是问句也照样体检(体检只插一行短标签, 冲不掉语境)');
ok(g({ dirty: true, questionPending: true, idleMin: CHECKUP_IDLE_MIN - 1 }) === null,
   '但 idle 不够仍然闭嘴 —— 拆门不等于不设防');

console.log('\n[checkupGate · 配置可覆盖]');
ok(g({ lastCheckupTs: NOW - 2 * DAY, cfg: { checkupIntervalDays: 1 } }) !== null, '周期改 1 天 → 2 天前的就到期了');
ok(g({ idleMin: 3, cfg: { checkupIdleMin: 2 } }) !== null, 'idle 门可调低');
ok(g({ ctxTok: 400_000, cfg: { checkupCtxMaxTok: 500_000 } }) !== null, 'ctx 上限可调高');

// ── checkupFindings ──
// 干净库: pinned 没超 · problems 空 · 孤儿少 · 没到期
const CLEAN = { pinned: 20, quota: 30, isolated: 2, review_due: [], problems: [] };
const f = (over = {}, cfg) => checkupFindings({ ...CLEAN, ...over }, cfg);

console.log('\n[checkupFindings · 干净就不吭声]');
ok(checkupFindings(null).length === 0, '报告是 null → 空(不炸)');
ok(f().length === 0, '🔴 库干净 → 一项都不报(每周来一句"一切正常"是纯噪音)');
ok(f({ isolated: 19 }).length === 0, '孤儿 19 个未到阈值 20 → 不报');
ok(f({ review_due: ['a', 'b'] }).length === 0, '到期 2 个未到阈值 3 → 不报');

console.log('\n[checkupFindings · 老记忆欠账合并成一条]');
const fat = { kind: '节点过大(拆分候选)', count: 12, sample: ['aaa(300行)'] };
const noClaim = { kind: '缺命题', count: 30, sample: ['bbb'] };
const noType = { kind: '缺归类', count: 15, sample: ['ccc'] };
const legacy = f({ problems: [fat, noClaim, noType], isolated: 40 });
ok(legacy.length === 1, '🔴 肥大+缺命题+缺归类+孤儿 合并成一条, 不是四条');
ok(legacy[0].key === 'legacy_backlog', 'key 是 legacy_backlog');
// 🔴 label 是**喂给模型的**, 所以断言英文原文 —— 中文字面会在下次语言整改时再挂一次。
// 受众判据见 personal/test-model-facing-english.js。
ok(/oversized 12/.test(legacy[0].label) && /no claim 30/.test(legacy[0].label)
  && /unclassified 15/.test(legacy[0].label) && /orphans 40/.test(legacy[0].label),
  '一条标签里四个数都在');
ok(f({ problems: [fat] }).length === 1, '只肥大超标也报(几个是 OR 不是 AND)');
ok(f({ problems: [{ ...fat, count: 4 }] }).length === 0, '肥大 4 个未到阈值 5 → 不报');
ok(f({ problems: [{ ...fat, count: 5 }] }).length === 1, '肥大刚好 5 个 → 报(阈值是 >=)');
ok(f({ problems: [{ ...fat, count: 4 }] }, { fatNodes: 3 }).length === 1, '阈值可配: 调到 3 就报了');
// 🔴 review_queue 退役后, 迁移欠账的四类 reasons 全靠这一条信号端出来。缺归类是其中一类
// (原 classify), 少了它 = 那批 v1 没 type 的老节点再没有任何通路被提起。
ok(f({ problems: [noType] }).length === 1, '只缺归类超标也报(它是原 review_queue 的 classify)');
// 🔴 2026-08-19: doctor 把「真空命题」和「迁移兜底命题」拆成两个 kind(性质不同、补法不同)。
// 这里必须两个都数进来 —— 只认老名字的话, 迁完的人格欠着几百条兜底命题, 而信号显示 0,
// 轨道照跑没人会发现。棒头 169 条那次就是从这条轨道漏出来的。
const provisional = { kind: '命题待判真假', count: 169, sample: ['ddd'] };
ok(f({ problems: [provisional] }).length === 1, '只有兜底命题超标 → 照样报(新 kind 不能漏)');
ok(/no claim 169/.test(f({ problems: [provisional] })[0].label), '兜底命题计入「缺命题」那个数');
ok(/no claim 199/.test(f({ problems: [noClaim, provisional] })[0].label), '真空 30 + 兜底 169 → 合并成 199');
ok(f({ problems: [{ ...noType, count: 9 }] }).length === 0, '缺归类 9 个未到阈值 10 → 不报');

console.log('\n[checkupFindings · 其余各项]');
ok(f({ pinned: 33 })[0].key === 'pinned_over_quota', '快查表超配额 → 报');
ok(/over quota by 3/.test(f({ pinned: 33 })[0].label), '标签写清超了几条');
ok(f({ pinned: 30 }).length === 0, '刚好卡满配额(30/30) → 不算超');
ok(f({ review_due: ['a', 'b', 'c'] })[0].key === 'review_due', '3 个项目到复核日 → 报');
const dang = f({ problems: [{ kind: '悬空边', count: 1 }] });
ok(dang.length === 1 && dang[0].key === 'dangling_edges', '悬空边 1 条就报(不设阈值)');
ok(/fault signal/.test(dang[0].label), '悬空边标签讲明它是故障不是"该整理了"');
ok(f({ problems: [{ kind: '召回失败率过半', count: 9 }] })[0].key === 'recall_fail',
  '召回失败率 → 报(样本量和阈值 doctor 已判过)');

console.log('\n[checkupFindings · 触发器是信号不是医生]');
const one = f({ problems: [fat] })[0];
ok(typeof one.label === 'string' && one.label.length < 80, '🔴 只出短标签');
ok(one.what === undefined && one.why === undefined && one.how === undefined,
  '🔴 不出诊断/不出药方 —— 那是 AI 的判断, 且信号里的快照会过期');

// 🔴 迁移欠账已并进体检(2026-08-17 作者:「那个 review 的合并了吧, 不用特殊做一个事务了」)。
// 下面两条防的是把它加回去: 曾经有 review_queue 一张表 + MIGRATE 一条轨道 + 唤醒正文一段,
// 三处都拆了。加回任何一处 = 又要处理"标了 done 却没真做 / 跳过算不算还完"那堆假问题。
console.log('\n[回归 · 迁移欠账不再有独立通路]');
const fs = require('fs');
const path = require('path');
ok(!fs.existsSync(path.join(__dirname, 'migrate-gate.js')), 'migrate-gate.js 已删');
const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
ok(!/'MIGRATE'/.test(mainSrc), "main.js 里没有 MIGRATE 轨道");
const agentSrc = require('./kernel-src').kernelSource();
ok(!/reviewBreakdown/.test(agentSrc), '唤醒正文不再注入迁移欠账段(起床 payload 跟着瘦一截)');
const schemaSrc = fs.readFileSync(require('./kernel-src').resolveSrc('memory-schema-v2.sql'), 'utf8');
ok(!/CREATE TABLE IF NOT EXISTS review_queue/.test(schemaSrc), 'schema 里 review_queue 表已删');
ok(/claim_provisional/.test(schemaSrc), '🔴 但兜底命题那个位留着 —— 它是唯一重算不出来的欠账');

console.log('\n[多项同时超标]');
const many = f({ pinned: 35, problems: [fat, noClaim], isolated: 40, review_due: ['a', 'b', 'c', 'd'] });
ok(many.length === 3, '快查表 + 老记忆欠账 + 复核到期 = 3 条');
ok(many.map((x) => x.key).join(',') === 'pinned_over_quota,legacy_backlog,review_due', '顺序稳定');

// 体检报了 conflict_pairs, 人格接着就得用 conflict_settle 结掉它 —— 所以那个工具的说明
// 和冷却表必须是同一套值。2026-09-26 实地: 说明教的是 `false_conflict`(不在冷却表里),
// 助手照着填了 4 笔, 而 v2 的落盘当时零校验, 野值静默落到 180 天默认冷却, 没有一处会报。
console.log('\n[conflict_settle 的 verdict: 说明 = 冷却表]');
{
  const fs = require('fs');
  const path = require('path');
  const arb = require('../core/memory-arbitration');
  const CORE = path.join(__dirname, '..', 'core');
  const hint = (fs.readFileSync(path.join(CORE, 'memory-tools-v2.js'), 'utf8')
    .match(/hint: 'verdict:[^']*'/) || [''])[0];
  ok(hint.length > 0, 'conflict_settle 的 hint 找得到');
  const listed = hint.replace(/^hint: 'verdict:/, '').split('.')[0]
    .split('/').map((s) => (s.trim().match(/^[a-z_]+/) || [''])[0]).filter(Boolean);
  ok(listed.length >= 3, `hint 列了 ${listed.length} 个值`);
  const stray = listed.filter((v) => !arb.VERDICTS.includes(v));
  ok(stray.length === 0,
    `hint 列的值都在冷却表里${stray.length ? ' —— 野值: ' + stray.join(', ') : ''}`);
  ok(/merged/.test(hint) && /already merged/i.test(hint),
    'hint 写明 merged 只有真合过才填(这个调用本身不改那两条记忆)');
  const dsrc = fs.readFileSync(path.join(CORE, 'memory-v2', 'doctor.js'), 'utf8');
  ok(/arb\.VERDICTS\.includes\(verdict\)/.test(dsrc),
    'v2 的 conflictSettle 会拦野 verdict(v1 一直会拦, v2 曾经零校验)');
}

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
