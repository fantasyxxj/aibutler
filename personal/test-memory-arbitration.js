// test-memory-arbitration.js — 仲裁 + 生命周期字段门禁
// 跑法: node test-memory-arbitration.js
// 覆盖: 5 个 frontmatter 字段读写与缺省兜底 · 字段不被 upsert 抹掉 · exit_criteria 强制闸
//       · suspectPairs 命中/误报 · arbitrate 落盘与 undo · 僵尸检出 · doctor 进度可见

const fs = require('fs');
const path = require('path');
const os = require('os');
const { MemoryGraph } = require('../core/memory.js');
const A = require('../core/memory-arbitration.js');

const TEST_DIR = path.join(os.tmpdir(), 'butler-mem-arb-' + Date.now());
fs.mkdirSync(TEST_DIR, { recursive: true });

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}`); fail++; }
};
const eq = (a, b, label) => ok(a === b, `${label} (got ${a}, want ${b})`);
const read = (id) => fs.readFileSync(path.join(TEST_DIR, id + '.md'), 'utf8');

const g = new MemoryGraph(TEST_DIR);

console.log('\n[1] status 缺省兜底 active (parseFrontmatter 跳过空值, 必须在 build 兜底)');
g.upsert({ id: 'feedback_a', type: 'feedback', description: '测试A dev 实测', body: 'aaa' });
ok(/status: active/.test(read('feedback_a')), '写盘带 status: active');
ok(!/superseded_by/.test(read('feedback_a')), '空字段不写盘(写了也读不出来, 徒增噪音)');
const idx1 = g._fresh();   // 0.0.56: 索引在 SQLite, 形状与旧 memory_index.json 一致
eq(idx1.nodes['feedback_a'].status, 'active', 'index 里也是 active');

console.log('\n[2] exit_criteria 强制闸: 只挡新建 project_*, 不误伤别的');
let threw = false;
try { g.upsert({ id: 'project_zombie', type: 'project', description: '僵尸' }); } catch (_) { threw = true; }
ok(threw, '新建 project_* 缺 exit_criteria → 抛错');
ok(!fs.existsSync(path.join(TEST_DIR, 'project_zombie.md')), '抛错后没留下半个文件');
let threw2 = false;
try { g.upsert({ id: 'reference_no_type', description: '省略 type 的调用' }); } catch (_) { threw2 = true; }
ok(!threw2, '省略 type 的 reference_* 不被误挡(type 默认值恰好是 project, 所以判定必须用 id 前缀)');

console.log('\n[3] review_due 缺省 = 建库日 + 30 天, 且不会被后续 upsert 推远');
g.upsert({ id: 'project_ok', type: 'project', description: '正常项目', exit_criteria: '上架完成' });
const due = (read('project_ok').match(/review_due: (\S+)/) || [])[1];
// 从【本地的今天】起算 +30 天。原来这里跟着 today() 写死 UTC+8, 那口径已废。
const _t = new Date();
const _p2 = (n) => String(n).padStart(2, '0');
const _todayLocal = `${_t.getFullYear()}-${_p2(_t.getMonth() + 1)}-${_p2(_t.getDate())}`;
const expect = new Date(Date.parse(_todayLocal + 'T00:00:00Z') + 30 * 86400000).toISOString().slice(0, 10);
eq(due, expect, 'review_due 自动 +30 天');

console.log('\n[4] 🔴 生命周期字段不被 upsert 整体重写抹掉');
g.upsert({ id: 'project_ok', type: 'project', description: '改了描述', body: '新正文' });
ok(/exit_criteria: 上架完成/.test(read('project_ok')), 'exit_criteria 继承住(不显式继承就会被静默抹掉)');
ok(read('project_ok').includes('review_due: ' + due), 'review_due 没被推远(否则永远不到期)');
ok(/改了描述/.test(read('project_ok')), 'description 确实更新了');

console.log('\n[5] suspectPairs: 该命中的命中, 该放过的放过');
const nodes = [
  { id: 'feedback_p', description: '改完代码必须先在 dev 环境实测再打包', type: 'feedback', status: 'active' },
  { id: 'feedback_q', description: '改完代码要先在 dev 环境实测然后才打包', type: 'feedback', status: 'active' },
  { id: 'reference_r', description: '日语词库 N5 覆盖率统计', type: 'reference', status: 'active' },
];
let sp = A.suspectPairs(nodes);
eq(sp.length, 1, '只检出 1 对(不误报无关节点)');
ok(sp[0].a === 'feedback_p' && sp[0].b === 'feedback_q', '检出的是那两条近义规则');
ok(sp[0].why.includes('同为规则类'), '标注了加权理由');
eq(A.suspectPairs([{ ...nodes[0], superseded_by: 'feedback_q' }, nodes[1]]).length, 0, '已有 supersede 关系 → 判过了不再判');
eq(A.suspectPairs([{ ...nodes[0], status: 'superseded' }, nodes[1]]).length, 0, '非 active → 跳过');

console.log('\n[6] arbitrate: 非破坏落盘 + 留痕');
g.upsert({ id: 'feedback_new', type: 'feedback', description: '新结论 dev 实测', body: '新' });
g.upsert({ id: 'feedback_old', type: 'feedback', description: '老结论 dev 实测', body: '老正文原封不动' });
const r = g.arbitrate({ winner: 'feedback_new', loser: 'feedback_old', reason: '08-09 推翻 07-18 口径', basis: ['user_negated'] });
ok(/status: superseded/.test(read('feedback_old')), '败方标 superseded');
ok(/superseded_by: feedback_new/.test(read('feedback_old')), '指向胜方');
ok(/老正文原封不动/.test(read('feedback_old')), '🔴 正文一个字没动(判错了损失的是召回不是数据)');
ok(r.trace.includes('标为失效'), '返回留痕文本给用户看');
const rl = g.revisions('feedback_old');
eq(rl.entries[rl.count - 1].op, 'supersede', '日志记 op=supersede');
eq(rl.entries[rl.count - 1].counterpart, 'feedback_new', '日志记对手方');

console.log('\n[7] superseded 降权但不硬过滤(贴出状态让消费方裁决)');
const q = g.query('dev 实测', { flat: true });
ok(q.length >= 2, '失效的那条仍能被召回(追问"当时为什么那么定"要用)');
const oldHit = q.find((x) => x.id === 'feedback_old');
eq(oldHit.status, 'superseded', 'query 返回项带 status');
eq(oldHit.superseded_by, 'feedback_new', 'query 返回项带 superseded_by');
ok(q.findIndex((x) => x.id === 'feedback_new') < q.findIndex((x) => x.id === 'feedback_old'), '现结论排在失效结论之前');

console.log('\n[8] undo: 判错了能改回来(推翻率统计的真值来源)');
const u = g.undoArbitrate({ loser: 'feedback_old', reason: '判错了' });
ok(u.restored, 'undo 成功');
ok(/status: active/.test(read('feedback_old')), '恢复 active');
ok(!/superseded_by: feedback_new/.test(read('feedback_old')), 'superseded_by 已清空');
ok(u.logMarked, '日志里那条判决被标 overturned');

console.log('\n[9] setFmField 只改 frontmatter, 不误伤 body');
const fake = '---\nname: x\nmetadata:\n  type: feedback\n---\n正文里写了一行 status: 待定 做笔记\n';
const after = A.setFmField(fake, 'status', 'superseded');
ok(/正文里写了一行 status: 待定/.test(after), 'body 里的同名行没被改');
ok(/^ {2}status: superseded$/m.test(after), 'fm 里正确插入');

console.log('\n[10] 僵尸项目: 到期才报, 不靠热度衰减');
g.upsert({ id: 'project_zombie1', type: 'project', description: '早该完的活', exit_criteria: '上线', review_due: '2026-01-01' });
g.upsert({ id: 'project_active1', type: 'project', description: '还在办', exit_criteria: '上线', review_due: '2099-01-01' });
const z = g.zombies();
eq(z.length, 1, '只报过期那条');
eq(z[0].id, 'project_zombie1', '报的是正确的那条');
ok(z[0].daysOverdue > 200, `算出逾期 ${z[0].daysOverdue} 天`);
ok(z[0].exit_criteria === '上线', '带出完成判据(便于当场判断还在不在办)');

console.log('\n[11] doctor 进度可见 —— 防"没触发"和"坏了"长得一样');
const doc = g.doctor();
ok(/^\d+\/\d+ 条修订$/.test(doc.progress.cognitionRefresh), `认知刷新进度: ${doc.progress.cognitionRefresh}`);
eq(doc.progress.cognitionReady, false, '没到阈值 → ready=false');
// 注意: 同一个 TEST_DIR 里 [3] 建的 project_ok 到期日是 today+30, 比 2099 更近 —— 报最近的那个才对
eq(doc.progress.zombieNextDue, due, `报出【最近的】下次到期日(而非任选一个)`);
eq(doc.zombies.length, 1, 'doctor 带出僵尸清单');
ok(Array.isArray(doc.progress.topChanged), '带出改动最频繁的节点(漂移嫌疑)');

console.log(`\n结果: ${pass} pass, ${fail} fail`);
try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
