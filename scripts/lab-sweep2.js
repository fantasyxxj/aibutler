// scripts/lab-sweep2.js — 在缓存好的两路排名上扫策略空间, 找帕累托前沿。
//
// 要回答的问题只有一个: 存不存在【一套不分语言的规则】, 在中文上不退步、同时把英语排序拉起来。
// 纯 node, 不碰模型 —— 输入是 lab-dump.js 的产物。
const fs = require('fs');

const K = 8;
const CORPORA = { zh: JSON.parse(fs.readFileSync('/tmp/dump-zh.json', 'utf8')),
                  en: JSON.parse(fs.readFileSync('/tmp/dump-en.json', 'utf8')) };

function rrf(kwIds, semIds, { C = 10, semWeight = 1, k = K } = {}) {
  const s = new Map();
  kwIds.forEach((id, i) => s.set(id, (s.get(id) || 0) + 1 / (C + i + 1)));
  semIds.forEach((id, i) => s.set(id, (s.get(id) || 0) + semWeight / (C + i + 1)));
  return [...s.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([x]) => x);
}
function withLock(p, n, opt) {
  const lock = p.kwAll.slice(0, n);
  const rest = rrf(p.kwAll, p.semAll, { ...opt, k: K + n }).filter((id) => !lock.includes(id));
  return lock.concat(rest).slice(0, K);
}
// 头部尖不尖: 第 i+1 名相对第 1 名的分数比。小 = 尖 = 关键词路分得出高下。
const ratioAt = (p, i) => (p.kwScores[0] ? (p.kwScores[i] || 0) / p.kwScores[0] : 1);

const strategies = [];
const add = (name, fn, family) => strategies.push({ name, fn, family });

// ① 固定锁深 × RRF 常数
for (const n of [0, 1, 2, 3, 4, 5]) for (const C of [5, 10, 20, 60])
  add(`fix n=${n} C=${C}`, (p) => withLock(p, n, { C }), 'fixed');

// ② 变深度: 逐位问"这席还跟第一名同档吗", 同档才锁。无固定深度, 天然自适应。
for (const beta of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) for (const cap of [2, 3, 5])
  add(`var beta=${beta} cap=${cap}`, (p) => {
    let n = 0; while (n < cap && ratioAt(p, n) >= beta) n++;
    return withLock(p, n, { C: 10 });
  }, 'var');

// ③ 二值自适应: 头部平就松锁
for (const thr of [0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85]) for (const [d, s] of [[3, 0], [3, 1], [3, 2], [5, 1], [5, 2]])
  add(`bin thr=${thr} ${d}/${s}`, (p) => withLock(p, ratioAt(p, 2) < thr ? d : s, { C: 10 }), 'bin');

// ④ 连续权重: 不动锁, 改语义的话语权。关键词头部越平, 语义权重越高。
for (const n of [0, 1, 2, 3]) for (const gain of [0.5, 1, 1.5, 2])
  add(`w n=${n} gain=${gain}`, (p) => {
    const flat = ratioAt(p, 2);                 // 0(尖) .. 1(平)
    const w = Math.max(0, Math.min(2, flat * gain));
    return withLock(p, n, { C: 10, semWeight: w });
  }, 'weight');

// ⑤ 两路共识: 两路都把同一条排第一 = 高度可信, 锁深; 不一致 = 松。
for (const [d, s] of [[3, 0], [3, 1], [5, 1], [2, 0]])
  add(`agree ${d}/${s}`, (p) => withLock(p, p.kwAll[0] === p.semAll[0] ? d : s, { C: 10 }), 'agree');

// ⑥ 共识 + 平坦度 双条件
for (const thr of [0.65, 0.7, 0.75])
  add(`agree|flat thr=${thr}`, (p) => {
    const confident = p.kwAll[0] === p.semAll[0] || ratioAt(p, 2) < thr;
    return withLock(p, confident ? 3 : 0, { C: 10 });
  }, 'combo');

// ⑦ 细网格: 帕累托点周围到底是平原还是尖刺。是尖刺就说明只是拟合了这 48 个查询。
for (const n of [0, 1, 2]) for (const gain of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.4])
  for (const C of [5, 10, 20])
    add(`W n=${n} g=${gain} C=${C}`, (p) => {
      const w = Math.max(0, Math.min(2, ratioAt(p, 2) * gain));
      return withLock(p, n, { C, semWeight: w });
    }, 'grid');

function evaluate(fn, per) {
  let hit = 0, top1 = 0, top3 = 0;
  for (const p of per) {
    const i = fn(p).indexOf(p.id);
    if (i >= 0) hit++;
    if (i === 0) top1++;
    if (i >= 0 && i < 3) top3++;
  }
  return { hit, top1, top3 };
}

const rows = strategies.map((s) => {
  const zh = evaluate(s.fn, CORPORA.zh), en = evaluate(s.fn, CORPORA.en);
  return { name: s.name, family: s.family, zh, en, score: zh.top3 + en.top3, score1: zh.top1 + en.top1 };
});

// 基线 = 现行落地(锁3 C=10)与纯关键词
const base = rows.find((r) => r.name === 'fix n=3 C=10');
const kwOnly = { zh: evaluate((p) => p.kwAll.slice(0, K), CORPORA.zh), en: evaluate((p) => p.kwAll.slice(0, K), CORPORA.en) };

// 帕累托: 没有别的策略在 (zh.top3, en.top3, zh.top1, en.top1) 四项上全都 >= 且至少一项 >
const dim = (r) => [r.zh.top3, r.en.top3, r.zh.top1, r.en.top1];
const pareto = rows.filter((r) => !rows.some((o) => {
  const a = dim(o), b = dim(r);
  return a.every((v, i) => v >= b[i]) && a.some((v, i) => v > b[i]);
}));

console.log('纯关键词基线   zh top3=%d top1=%d | en top3=%d top1=%d', kwOnly.zh.top3, kwOnly.zh.top1, kwOnly.en.top3, kwOnly.en.top1);
console.log('现行落地(锁3)  zh top3=%d top1=%d | en top3=%d top1=%d', base.zh.top3, base.zh.top1, base.en.top3, base.en.top1);
console.log('\n=== 帕累托前沿 (%d/%d 个策略) ===', pareto.length, rows.length);
console.log('策略'.padEnd(24), 'zh:top3/top1  en:top3/top1   合计top3');
for (const r of pareto.sort((a, b) => b.score - a.score || b.score1 - a.score1)) {
  console.log(r.name.padEnd(24), `  ${r.zh.top3}/${r.zh.top1}         ${r.en.top3}/${r.en.top1}          ${r.score}`);
}

// 中文零退步(top3>=22 且 top1>=18) 前提下, 英语最好能到多少
const safe = rows.filter((r) => r.zh.top3 >= kwOnly.zh.top3 && r.zh.top1 >= kwOnly.zh.top1)
  .sort((a, b) => b.en.top3 - a.en.top3 || b.en.top1 - a.en.top1);
console.log('\n=== 中文严格零退步的前提下, 英语最好的 8 个 ===');
for (const r of safe.slice(0, 8)) console.log(r.name.padEnd(24), `zh ${r.zh.top3}/${r.zh.top1}  en ${r.en.top3}/${r.en.top1}`);
console.log('中文零退步的策略共 %d 个', safe.length);

// 次序保全检查: 2026-08-09 铁律是"已经搜得到的东西相对次序不许被新机制搅乱", 锁头本来就是为它加的。
// 取消锁之后必须逐条比对次序 —— 命中数持平不等于同序。
{
  const cand = (p) => {
    const w = Math.max(0, Math.min(2, ratioAt(p, 2) * 0.8));
    return withLock(p, 0, { C: 10, semWeight: w });
  };
  console.log('\n=== 次序保全(候选 vs 纯关键词, 逐条比对) ===');
  for (const [tag, per] of Object.entries(CORPORA)) {
    let same3 = 0, same1 = 0, demoted = 0, dropped = 0, promoted = 0, deltaSum = 0;
    for (const p of per) {
      const kw = p.kwAll.slice(0, K), got = cand(p);
      if (kw[0] === got[0]) same1++;
      if (kw.slice(0, 3).every((id, i) => got[i] === id)) same3++;
      const ki = kw.indexOf(p.id), gi = got.indexOf(p.id);
      if (ki >= 0 && gi < 0) dropped++;
      else if (ki >= 0 && gi > ki) demoted++;
      if (gi >= 0 && (ki < 0 || gi < ki)) promoted++;
      if (ki >= 0 && gi >= 0) { deltaSum += ki - gi; }
    }
    console.log(`${tag}: 头1同 ${same1}/${per.length} · 头3逐条同序 ${same3}/${per.length} · 答案被挤出 ${dropped} · 压低 ${demoted} · 提升 ${promoted} · 名次净变 ${deltaSum > 0 ? '+' : ''}${deltaSum}`);
  }
}

// 平原检查: 细网格里"中文零退步 且 英语 top3>=20"的格子占多少。
// 零星几个 = 尖刺 = 拟合噪音; 连成一片 = 参数不敏感 = 可信。
const grid = rows.filter((r) => r.family === 'grid');
const good = grid.filter((r) => r.zh.top3 >= 22 && r.zh.top1 >= 18 && r.en.top3 >= 20);
console.log('\n=== 平原检查(细网格 %d 格) ===', grid.length);
console.log('中文零退步 且 英语top3>=20 的格子: %d 个 (%d%%)', good.length, Math.round(good.length / grid.length * 100));
for (const C of [5, 10, 20]) {
  console.log(`-- C=${C} --   ` + [0, 1, 2].map((n) => `n=${n}`).join('              '));
  for (const gain of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.4]) {
    const cells = [0, 1, 2].map((n) => {
      const r = grid.find((x) => x.name === `W n=${n} g=${gain} C=${C}`);
      const ok = r.zh.top3 >= 22 && r.zh.top1 >= 18;
      return `${ok ? ' ' : '!'}zh${r.zh.top3}/${r.zh.top1} en${r.en.top3}/${r.en.top1}`;
    });
    console.log(`g=${String(gain).padEnd(4)}`, cells.join('   '));
  }
}
