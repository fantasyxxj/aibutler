// test-memory-ack-problem.js — 体检告警的「确认不修」出口。
//
// 🔴 为什么要有它: 像 body over gate 那种历史存量, 既不该一次全改也不该每次体检都被念一遍。
// 没有出口的话人格只能在"永远被念叨"和"去乱改一通"之间选, 而念得越久越容易把整条轨道训成
// 噪音 —— 连真该修的那几条也一起被跳过。
// 🔴 ack 的是【当时那个数】不是永久免死: 涨了要重新报, 因为涨出来的是新欠的账。
// 跑: node personal/test-memory-ack-problem.js
require('./host-wiring');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Butler } = require('../core/agent');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ackprob-'));
const b = new Butler(home, { name: 'ACK测试' });
const g = b.memory;

// 造一类必定被报的告警: 命题行里带 ISO 日期
// ⚠️ 必须带 tag: 同名 slug 走的是更新不是新增, 数量不会涨, 那样第二批根本测不到"涨了要重报"
const dated = (n, tag) => { for (let i = 0; i < n; i++) g.upsert({ slug: `reference_dated_${tag}_${i}`, claim: `这条命题里带了 2026-09-12 这个日期 ${tag}${i}` }); };

console.log('=== T1: 先确认这类告警真的会报 ===');
dated(3, "a");
const KIND = 'claim line contains a date';
const d0 = g.doctor();
const p0 = (d0.problems || []).find((p) => p.kind === KIND);
ok(!!p0, `体检报了「${KIND}」×${p0 && p0.count}`);

console.log('=== T2: ack 之后就不报了 ===');
const r = g.ackProblem(KIND, '历史存量, 这批先不动');
ok(r.acked_at_count === (p0 && p0.count), `ack 记下的是当时那个数(${r.acked_at_count})`);
const d1 = g.doctor();
ok(!(d1.problems || []).some((p) => p.kind === KIND), '🔴 ack 之后体检不再报它');

console.log('=== T3: 数量涨了要重新报(不是永久免死) ===');
dated(2, "b");
const d2 = g.doctor();
const p2 = (d2.problems || []).find((p) => p.kind === KIND);
ok(!!p2, `🔴 又多了 2 条之后重新报出来(现 ×${p2 && p2.count})`);
ok(p2 && p2.count > r.acked_at_count, '重新报的前提是数量超过了 ack 时的数');

console.log('=== T4: 再 ack 一次, 认掉新的数量 ===');
const r2 = g.ackProblem(KIND);
ok(r2.acked_at_count === (p2 && p2.count), `🔴 第二次 ack 读到的是真实数量 ${r2.acked_at_count}, 不是 0`);
ok(!(g.doctor().problems || []).some((p) => p.kind === KIND), '认掉之后又安静了');

console.log('=== T5: raw 出口不受 ack 影响(ackProblem 靠它读真实数) ===');
const raw = g.doctor({ raw: true });
ok((raw.problems || []).some((p) => p.kind === KIND), '🔴 doctor({raw:true}) 照样看得到已 ack 的那类');

console.log('=== T6: ack 只挡被点名的那一类, 不误伤别的 ===');
g.upsert({ slug: 'reference_orphan_probe', claim: '一条没有任何边的孤岛节点' });
const d3 = g.doctor();
ok(!(d3.problems || []).some((p) => p.kind === KIND), '被 ack 的那类仍然安静');
ok(typeof d3.isolated === 'number', '其余体检项照常工作');

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
