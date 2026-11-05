// test-memory-pinned-quota.js — 无头验证 pinned(常驻)配额 10 + 配额硬闸
// 跑法: node test-memory-pinned-quota.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { MemoryGraph, PINNED_QUOTA, pinnedGate } = require('../core/memory.js');

const TEST_DIR = path.join(os.tmpdir(), 'butler-pinned-quota-' + Date.now());
fs.mkdirSync(TEST_DIR, { recursive: true });

let pass = 0, fail = 0;
const assert = (actual, expected, label) => {
  const ok = actual === expected;
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}: got ${actual}, want ${expected}`); fail++; }
};

const g = new MemoryGraph(TEST_DIR);

console.log('\n[1] PINNED_QUOTA 导出 = 10');
assert(PINNED_QUOTA, 10, '配额常量');

console.log('\n[2] pinnedAll: 空图返空');
assert(g.pinnedAll().length, 0, '无 pinned');

console.log('\n[3] pinnedAll: 只返 pinned, 不含 high/med/low');
g.upsert({ id: 'feedback_red_line_a', importance: 'pinned', description: 'red line a', body: 'x' });
g.upsert({ id: 'feedback_normal_b', importance: 'high', description: 'normal b', body: 'x' });
g.upsert({ id: 'project_low_c', importance: 'low', description: 'low c', body: 'x', exit_criteria: 'c 做完' });
const only = g.pinnedAll();
assert(only.length, 1, '只有 1 条 pinned');
assert(only[0].id, 'feedback_red_line_a', '返回的是 pinned 那条');

console.log('\n[4] pinnedAll: 全量不截断 (造 35 条 > 配额)');
for (let i = 0; i < 34; i++) {
  g.upsert({ id: `feedback_line_${String(i).padStart(2, '0')}`, importance: 'pinned',
             description: `line ${i}`, body: 'x' });
}
assert(g.pinnedAll().length, 35, '35 条全返 (不按 quota 截)');

console.log('\n[5] pinnedAll: 内部有序, 不是恒同分退化字母序');
// 旧引擎 IMP_HL.pinned=99999 → 全部恒 105.0 精确同分 → Array.sort 稳定 → 退化插入序。
// 重标定后 use_count 加分 (USE_W*ln(1+uc)) 应把被 touch 的那条顶上来。
g.touch(['feedback_line_33']);
g.touch(['feedback_line_33']);
g.touch(['feedback_line_33']);
const ordered = g.pinnedAll();
assert(ordered[0].id, 'feedback_line_33', '被 touch 3 次的排第一 (不是字母序 line_00)');
const distinctScores = new Set(ordered.map((m) => m.hot)).size;
assert(distinctScores > 1, true, `分数不再全同 (distinct=${distinctScores})`);

console.log('\n[6] pinnedAudit: 超限计算');
const a1 = g.pinnedAudit();
assert(a1.count, 35, 'count=35');
assert(a1.quota, PINNED_QUOTA, 'quota=PINNED_QUOTA');
assert(a1.over, 35 - PINNED_QUOTA, 'over=35-quota');

console.log('\n[7] pinnedAudit: stale 机械筛优先 (id 含 shipped/已弃/版本号)');
g.upsert({ id: 'project_butler_v0028_shipped', importance: 'pinned',
           description: '已出货的老版本', body: 'x', exit_criteria: '已出货' });
const a2 = g.pinnedAudit();
const staleFirst = a2.candidates[0];
assert(staleFirst.id, 'project_butler_v0028_shipped', 'stale 命中的排候选第一');
assert(staleFirst.stale, true, '标了 stale 旗');
assert(a2.candidates.filter((c) => c.stale).length >= 1, true, '候选里含 stale');

console.log('\n[8] pinnedAudit: 未超限时 over=0 且仍给候选(供主动瘦身)');
const g2 = new MemoryGraph(path.join(TEST_DIR, 'sub2'));
fs.mkdirSync(path.join(TEST_DIR, 'sub2'), { recursive: true });
g2.upsert({ id: 'feedback_only_one', importance: 'pinned', description: 'one', body: 'x' });
const a3 = g2.pinnedAudit();
assert(a3.over, 0, '1 条不超限');
assert(a3.candidates.length, 1, '仍给候选名单');

console.log('\n[9] 配额硬闸决策 (测的就是 agent.js 用的那份 pinnedGate, 不是复制品)');
// 2026-08-13 由"警告放行"改成"硬挡 + demote 一步换人"。
const full = Array.from({ length: PINNED_QUOTA }, (_, i) => `feedback_p${i}`);
const act = (o) => pinnedGate(o).action;
assert(act({ importance: 'pinned', selfId: 'feedback_new', pinnedIds: full }), 'block', '满额 + 新标 pinned → 弹回');
assert(act({ importance: 'pinned', selfId: 'feedback_new', pinnedIds: [...full, 'feedback_x'] }), 'block', '超额照样弹回');
assert(act({ importance: 'pinned', selfId: 'feedback_p3', pinnedIds: full }), 'pass', '老 pinned 更新 → 放行(不占新名额)');
assert(act({ importance: 'pinned', selfId: 'feedback_new', pinnedIds: full.slice(0, PINNED_QUOTA - 1) }), 'pass', '未满 → 放行');
assert(act({ importance: 'high', selfId: 'feedback_new', pinnedIds: full }), 'pass', '标 high → 放行');
assert(act({ importance: '', selfId: 'feedback_new', pinnedIds: full }), 'pass', '未标 importance → 放行');
assert(act({ importance: 'pinned', selfId: 'feedback_new', demote: 'feedback_p0', pinnedIds: full }), 'swap', '带 demote → 换人');
assert(act({ importance: 'pinned', selfId: 'feedback_new', demote: 'feedback_new', pinnedIds: full }), 'reject_self', 'demote 填自己 → 拒');
assert(act({ importance: 'pinned', selfId: 'feedback_new', demote: 'feedback_notpinned', pinnedIds: full }), 'reject_absent', 'demote 不在 pinned 名单 → 拒');
assert(act({ importance: 'pinned', selfId: 'feedback_new', demote: 'feedback_p0', pinnedIds: full.slice(0, 5) }), 'pass', '没满时 demote 不生效(不误伤)');

console.log('\n[9b] setImportance: 只动档位, 正文一个字不改');
const g9dir = path.join(TEST_DIR, 'sub9');
fs.mkdirSync(g9dir, { recursive: true });
const g9 = new MemoryGraph(g9dir);
const BODY = '第一行正文\n\n## 小节\n- 要点 A\n- 要点 B\n';
g9.upsert({ id: 'feedback_demo_line', importance: 'pinned', description: 'demo', body: BODY });
const beforeRaw = fs.readFileSync(path.join(g9dir, 'feedback_demo_line.md'), 'utf8');
const r9 = g9.setImportance('feedback_demo_line', 'high', '场景没了');
assert(r9.from, 'pinned', '报出原档位');
assert(r9.to, 'high', '报出新档位');
assert(g9.pinnedAll().length, 0, '降级后不再是 pinned');
const afterRaw = fs.readFileSync(path.join(g9dir, 'feedback_demo_line.md'), 'utf8');
assert(afterRaw.slice(afterRaw.indexOf('---', 3)), beforeRaw.slice(beforeRaw.indexOf('---', 3)), 'frontmatter 之后的正文逐字节不变');
assert(/importance:\s*high/.test(afterRaw), true, 'frontmatter 档位已改');
assert(/last_used:\s*2026|last_used/.test(afterRaw), true, 'last_used 字段仍在');
// 降级不该算"我用过它"(会污染 recent 段)
const fmBefore = beforeRaw.match(/last_used:\s*(\S+)/)[1];
const fmAfter = afterRaw.match(/last_used:\s*(\S+)/)[1];
assert(fmAfter, fmBefore, '降级不动 last_used');
// 留痕: 红线什么时候退的休要追得到
const rl = g9.revisions('feedback_demo_line');
assert(rl.entries.some((e) => /importance pinned→high/.test(e.reason || '')), true, '修订日志记下了降级');
assert(rl.entries.some((e) => /场景没了/.test(e.reason || '')), true, '降级理由进了日志');
// 升档也走同一把: 空位时能升回来
g9.setImportance('feedback_demo_line', 'pinned');
assert(g9.pinnedAll().length, 1, '能升回 pinned');
let threw = '';
try { g9.setImportance('feedback_demo_line', 'critical'); } catch (e) { threw = e.message; }
assert(/importance 只能是/.test(threw), true, '非法档位报错');
threw = '';
try { g9.setImportance('feedback_no_such_node', 'high'); } catch (e) { threw = e.message; }
assert(/节点不存在/.test(threw), true, '节点不存在报错');

console.log('\n[10] 三段注入: pinned/hot/recent 互不重复 (逻辑同 agent.js buildWakePayload)');
const pinned = g.pinnedAll();
const pinnedIds = new Set(pinned.map((m) => m.id));
const hot = g.hot(pinned.length + 40).filter((m) => !pinnedIds.has(m.id)).slice(0, 5);
const seen = new Set([...pinnedIds, ...hot.map((m) => m.id)]);
const recent = g.recent(40).filter((m) => !seen.has(m.id)).slice(0, 5);
assert(hot.every((m) => !pinnedIds.has(m.id)), true, 'hot 段不含 pinned');
assert(recent.every((m) => !seen.has(m.id)), true, 'recent 段不含前两段');

console.log('\n[11] hot 池子必须开够 (36 条 pinned 能把 top-N 占满 → 小池会被过滤成空)');
// 这是实现时踩到的真坑: 原写法 hot(20).filter(非pinned) 在 pinned≥20 时恒返空数组。
const naive = g.hot(20).filter((m) => !pinnedIds.has(m.id)).slice(0, 5);
const sized = g.hot(pinned.length + 40).filter((m) => !pinnedIds.has(m.id)).slice(0, 5);
console.log(`  naive(池20)=${naive.length} 条 · sized(池${pinned.length + 40})=${sized.length} 条`);
assert(sized.length > 0, true, '开够池子后 hot 段非空');
assert(sized.length >= naive.length, true, '大池不劣于小池');

console.log('\n[11b] recent 排序抗批量元数据污染 (2026-08-07 降级 36 条 pinned 时实测踩到)');
// 场景: 批量改 frontmatter(降级/doctor修复/格式迁移) 会把一批老节点的 mtime 刷成"现在"。
// 若 recent 纯按 mtime 排, 起床段3 就会全是刚被批处理的老货, 而不是"上次收工在干啥"。
const g3dir = path.join(TEST_DIR, 'sub3');
fs.mkdirSync(g3dir, { recursive: true });
const g3 = new MemoryGraph(g3dir);
g3.upsert({ id: 'project_fresh_work', description: '今天刚沉的活', body: 'x', exit_criteria: '干完' });
g3.upsert({ id: 'project_ancient_note', description: '很久以前的老节点', body: 'x', exit_criteria: '干完' });
// 把老节点的 last_used 改老 (模拟它本来就是旧的)
const ancientFile = path.join(g3dir, 'project_ancient_note.md');
fs.writeFileSync(ancientFile,
  fs.readFileSync(ancientFile, 'utf8').replace(/^(\s*last_used:\s*).*$/m, '$12026-01-01'), 'utf8');
g3.build();
// 再把老节点 mtime 刷成"现在"(批量操作的副作用), 新节点 mtime 反而更早
const now = new Date();
fs.utimesSync(path.join(g3dir, 'project_fresh_work.md'), now, new Date(now.getTime() - 60000));
fs.utimesSync(ancientFile, now, now);
const r3 = g3.recent(5);
console.log(`  recent 顺序: ${r3.map((m) => `${m.date}/${m.id}`).join(' | ')}`);
assert(r3[0].id, 'project_fresh_work', 'last_used 新的排第一 (不被刷新的 mtime 顶掉)');

console.log('\n[12] doctor 带上 pinned 体检');
const d = g.doctor();
assert(typeof d.pinned, 'object', 'doctor().pinned 存在');
assert(d.pinned.quota, PINNED_QUOTA, 'doctor 报 quota');
assert(d.pinned.over > 0, true, 'doctor 报超限');

console.log('\n[12b] 接线: 工具定义了就得真注册进去 (犯过"preload 暴露了 renderer 没接")');
// 2026-08-23: v1 记忆路径整块删了 —— 那个"逃生门"指向的库(老 memory.db)和工具(memory_append)
// 都已不存在, 按下去必死。记忆工具现在只有 memory-tools-v2.js 一处。检查的意图一个字没变。
const agentSrc = require('./kernel-src').kernelSource();
const memToolsSrc = require('./kernel-src').readSrc('memory-tools-v2.js');
// 2026-09-07: pinned / set_importance 这类冷门口子并进了 memory_admin(op, args), 接线的检查点
// 跟着下移一层 —— 光有 op 实现而工具没进白名单, 同样是"定义了但按不下去"。
const descs = JSON.parse(fs.readFileSync(path.join(__dirname, '../core/config/tools/descriptions.json'), 'utf8'));
assert(Object.keys(descs).some((k) => k.startsWith('memory_')), false,
  '记忆工具的说明只留代码里那一份 —— descriptions.json 再放一份就是两份会各自漂的文案');
assert(/'memory_admin'/.test(memToolsSrc), true, 'memory-tools-v2.js 定义了 memory_admin');
assert(/return \[[\s\S]*?\bmemAdmin\b[\s\S]*?\];/.test(memToolsSrc), true, 'memory_admin 进了返回的工具数组');
assert(agentSrc.includes("'mcp__butler__memory_admin'"), true, 'memory_admin 进了 allowedTools 白名单');
for (const op of ['pinned', 'set_pinned', 'set_importance']) {
  assert(new RegExp(`^ {4}${op}: \\{`, 'm').test(memToolsSrc), true, `memory_admin 有 op=${op}`);
  assert(agentSrc.includes(`'mcp__butler__memory_${op}'`), false, `已并入的 memory_${op} 不该还留在白名单里`);
}
// v1 逃生门必须真的没了。坏掉的安全网比没有更危险: 只在出事那一刻才暴露自己是坏的。
assert(/BUTLER_MEMORY_V2/.test(agentSrc.replace(/^\s*\/\/.*$/gm, '')), false, 'BUTLER_MEMORY_V2 开关已拆(注释不算)');
assert(agentSrc.includes("'mcp__butler__memory_append'"), false, '已废的 memory_append 不在白名单里');
assert(fs.existsSync(path.join(__dirname, '../core/config/main/pinned_quota_block.md')), true, '硬挡文案在 config 里(不硬编码在 js)');
assert(fs.existsSync(path.join(__dirname, '../core/config/main/pinned_quota_warn.md')), false, '旧的"警告放行"文案已删干净');

console.log('\n[13] 清理');
fs.rmSync(TEST_DIR, { recursive: true, force: true });
assert(fs.existsSync(TEST_DIR), false, '临时目录已清理');

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
