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

const DIR = '/tmp/en-mem-lab/memory';
const QUERIES = '/tmp/en-mem-lab/gen/queries.json';
const K = 8;
const DEEP = 5000;

function out(o) { process.stdout.write('LAB:' + JSON.stringify(o) + '\n'); }

function rrf(kwIds, semIds, { C = 60, k = K, semWeight = 1 } = {}) {
  const s = new Map();
  kwIds.forEach((id, i) => s.set(id, (s.get(id) || 0) + 1 / (C + i + 1)));
  semIds.forEach((id, i) => s.set(id, (s.get(id) || 0) + semWeight / (C + i + 1)));
  return [...s.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => id);
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
      const kwAll = g.query(f.q, { k: DEEP, semantic: false }).map((r) => r.id);
      const [raw] = await host.embed([`query: ${f.q}`]);
      const qv = normalize(raw);
      const semAll = entries.map((e) => ({ id: e.id, score: cosine(qv, e.vec) }))
        .sort((a, b) => b.score - a.score).map((x) => x.id);
      per.push({ ...f, kwAll, semAll, qv });
    }

    const strategies = {
      'A 纯关键词(现行默认)': (p) => p.kwAll.slice(0, K),
      'B 纯语义': (p) => p.semAll.slice(0, K),
      'C RRF C=60': (p) => rrf(p.kwAll, p.semAll, { C: 60 }),
      'D RRF C=10': (p) => rrf(p.kwAll, p.semAll, { C: 10 }),
      'E RRF C=60 语义半权': (p) => rrf(p.kwAll, p.semAll, { C: 60, semWeight: 0.5 }),
      'F RRF 语义只取 top20': (p) => rrf(p.kwAll, p.semAll.slice(0, 20), { C: 60 }),
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
    fs.writeFileSync('/tmp/en-mem-lab/fuse.json', JSON.stringify(report, null, 2));
  } catch (e) {
    out({ stage: 'error', error: String((e && e.stack) || e) });
  } finally {
    host.dispose();
    app.exit(0);
  }
});
