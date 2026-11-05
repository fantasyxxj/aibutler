// scripts/en-lab-fuse.js — 第三轮: 融合【策略】之争, 不只是阈值之争。
//
// 现行机制是"给语义留 2 个末席": 砍掉关键词最弱的一席, 塞语义进去。第二轮暴露了它的形状问题 ——
// feedback_verify_artifact_contains_new_code/q2 关键词排 #8、语义排 #1, 放宽阈值后它反而被挤出 top-8。
// 一个两路都认的条目被融合搞丢了, 这是"留席位"独有的病(它不看两路的一致性, 只看谁占坑)。
//
// 对照 RRF(reciprocal rank fusion): score = Σ 1/(C + rank)。两路都靠前的条目自动升到最前,
// 只有一路认的条目排在其后。业界混合检索的默认做法, 没有阈值要标定。
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const host = require(path.join(ROOT, 'personal', 'embed-host'));
host.registerScheme();

const DIR = process.env.LAB_DIR;
const QUERIES = process.env.LAB_Q;
const K = 8;
const DEEP = 5000;

function out(o) { process.stdout.write('LAB:' + JSON.stringify(o) + '\n'); }

function rrf(kwIds, semIds, { C = 60, k = K, semWeight = 1 } = {}) {
  const s = new Map();
  kwIds.forEach((id, i) => s.set(id, (s.get(id) || 0) + 1 / (C + i + 1)));
  semIds.forEach((id, i) => s.set(id, (s.get(id) || 0) + semWeight / (C + i + 1)));
  return [...s.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => id);
}

function lockN(p, n) {
  const lock = p.kwAll.slice(0, n);
  const rest = rrf(p.kwAll, p.semAll, { C: 10, k: K + n }).filter((id) => !lock.includes(id));
  return lock.concat(rest).slice(0, K);
}
function lockAdaptive(p, thr, deep, shallow) {
  const s = p.kwScores;
  const ratio = s[0] ? (s[2] || 0) / s[0] : 1;
  return lockN(p, ratio < thr ? deep : shallow);
}

app.whenReady().then(async () => {
  try {
    host.installProtocol();
    const { MemoryGraph } = require(path.join(ROOT, 'memory'));
    const { normalize, cosine } = require(path.join(ROOT, 'core', 'memory-vector'));

    const g = new MemoryGraph(DIR);
    g.setEmbedder(host.embed);
    g.markSemanticOptIn();
    const entries = g.store.allVectors(g.embedModel);

    const queries = JSON.parse(fs.readFileSync(QUERIES, 'utf8'));
    const flat = [];
    for (const it of queries) for (const key of ['q1', 'q2']) if (it[key]) flat.push({ id: it.id, key, q: it[key] });

    const per = [];
    for (const f of flat) {
      const kwRaw = g.query(f.q, { k: DEEP, semantic: false });
      const kwAll = kwRaw.map((r) => r.id);
      const kwScores = kwRaw.map((r) => r.score);
      const [raw] = await host.embed([`query: ${f.q}`]);
      const qv = normalize(raw);
      const semAll = entries.map((e) => ({ id: e.id, score: cosine(qv, e.vec) }))
        .sort((a, b) => b.score - a.score).map((x) => x.id);
      per.push({ ...f, kwAll, kwScores, semAll, qv });
    }

    // 诊断: 命中在 top3 内 vs 不在, 关键词分数形状差在哪 —— 阈值必须由这个分布定, 不能拍。
    {
      const g1 = [], g2 = [];
      for (const p of per) {
        const i = p.kwAll.indexOf(p.id);
        const s = p.kwScores;
        const row = { top1: s[0] || 0, top3: s[2] || 0, ratio: s[0] ? (s[2] || 0) / s[0] : 0, rank: i };
        (i >= 0 && i < 3 ? g1 : g2).push(row);
      }
      const avg = (a, k) => Math.round((a.reduce((x, r) => x + r[k], 0) / (a.length || 1)) * 100) / 100;
      out({ stage: 'diag', inTop3: g1.length, notInTop3: g2.length,
        hit_top1score: avg(g1, 'top1'), miss_top1score: avg(g2, 'top1'),
        hit_ratio31: avg(g1, 'ratio'), miss_ratio31: avg(g2, 'ratio') });
    }

    const strategies = {
      'A 纯关键词(现行默认)': (p) => p.kwAll.slice(0, K),
      'B 纯语义': (p) => p.semAll.slice(0, K),
      'C RRF C=60': (p) => rrf(p.kwAll, p.semAll, { C: 60 }),
      'D RRF C=10': (p) => rrf(p.kwAll, p.semAll, { C: 10 }),
      'E RRF C=60 语义半权': (p) => rrf(p.kwAll, p.semAll, { C: 60, semWeight: 0.5 }),
      'F RRF 语义只取 top20': (p) => rrf(p.kwAll, p.semAll.slice(0, 20), { C: 60 }),
      // 老铁律: 已经搜得到的东西, 相对次序不许被新机制搅乱(2026-08-09 那次 top8 被冲掉 43.8% 的教训)。
      // 所以锁住关键词最强的前 N 席, 只让 RRF 去争剩下的位置 —— 收益仍在末席拿, 代价封死在头部之外。
      'G 锁关键词top3 + 余位RRF10': (p) => {
        const lock = p.kwAll.slice(0, 3);
        const rest = rrf(p.kwAll, p.semAll, { C: 10, k: K + 3 }).filter((id) => !lock.includes(id));
        return lock.concat(rest).slice(0, K);
      },
      'H 锁关键词top5 + 余位RRF10': (p) => {
        const lock = p.kwAll.slice(0, 5);
        const rest = rrf(p.kwAll, p.semAll, { C: 10, k: K + 5 }).filter((id) => !lock.includes(id));
        return lock.concat(rest).slice(0, K);
      },
      // 自适应: 锁多深由关键词路自己的把握定。头部尖(score[2]/score[0] 小)= 它分得出高下, 锁住别动;
      // 头部平 = 它自己也在猜, 让 RRF 全权重排。阈值取两语料 hit/miss 均值之间。
      'I 自适应锁(ratio<0.7 锁3 否则 0)': (p) => lockAdaptive(p, 0.7, 3, 0),
      'J 自适应锁(ratio<0.75 锁3 否则 1)': (p) => lockAdaptive(p, 0.75, 3, 1),
      'K 自适应锁(ratio<0.7 锁3 否则 1)': (p) => lockAdaptive(p, 0.7, 3, 1),
      // 变深度: 逐位判断"这一席还跟第一名同档吗", 同档才锁。不设固定深度。
      'L 变深度锁(>=0.8*top1 才锁, 上限3)': (p) => {
        const s = p.kwScores; let n = 0;
        while (n < 3 && s[n] != null && s[0] && s[n] >= 0.8 * s[0]) n++;
        return lockN(p, n);
      },
    };

    const kwTop = new Map(per.map((p) => [p.q, p.kwAll.slice(0, K)]));
    const report = [];
    for (const [name, fn] of Object.entries(strategies)) {
      let hit = 0, top1 = 0, top3 = 0;
      const lost = [];
      let churn = 0;   // 相对纯关键词 top-8 的改动条数(排序扰动量)
      for (const p of per) {
        const res = fn(p);
        const i = res.indexOf(p.id);
        if (i >= 0) hit++;
        if (i === 0) top1++;
        if (i >= 0 && i < 3) top3++;
        const base = kwTop.get(p.q);
        if (base.includes(p.id) && i < 0) lost.push(`${p.id}/${p.key}`);
        churn += res.filter((id) => !base.includes(id)).length;
      }
      report.push({
        name, hit, of: per.length, pct: Math.round((hit / per.length) * 1000) / 10,
        top1, top3, lost: lost.length, lostIds: lost,
        churnPerQuery: Math.round((churn / per.length) * 10) / 10,
      });
      out({ stage: 's', name, hit, top1, top3, lost: lost.length, churn: Math.round((churn / per.length) * 10) / 10 });
    }
    fs.writeFileSync(process.env.LAB_OUT, JSON.stringify(report, null, 2));
  } catch (e) {
    out({ stage: 'error', error: String((e && e.stack) || e) });
  } finally {
    host.dispose();
    app.exit(0);
  }
});
