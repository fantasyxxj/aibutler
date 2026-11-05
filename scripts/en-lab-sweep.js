// scripts/en-lab-sweep.js — 第二轮: 现行显著性门槛(SEMANTIC_MIN_Z=2.8)是照【中文】分布标的,
// 在英语语料上它挡掉了多少真命中? 放宽它会不会反过来冲掉关键词的强命中?
//
// 后一问是硬约束: 2026-08-09 的事故形状就是"扩大候选池的手段参与主排序, 真库 top8 被冲掉 43.8%"。
// 所以每个阈值都同时量两件事 —— 捞回多少(收益) / 挤掉多少原本命中的(代价)。
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const host = require(path.join(ROOT, 'personal', 'embed-host'));
host.registerScheme();

const DIR = '/tmp/en-mem-lab/memory';
const QUERIES = '/tmp/en-mem-lab/gen/queries.json';
const K = 8;
const ZS = [2.8, 2.4, 2.0, 1.6, 1.2, 0.8, 0.0];

function out(o) { process.stdout.write('LAB:' + JSON.stringify(o) + '\n'); }

app.whenReady().then(async () => {
  try {
    host.installProtocol();
    const { MemoryGraph } = require(path.join(ROOT, 'memory'));
    const { normalize } = require(path.join(ROOT, 'core', 'memory-vector'));

    const g = new MemoryGraph(DIR);
    g.setEmbedder(host.embed);
    g.markSemanticOptIn();

    const queries = JSON.parse(fs.readFileSync(QUERIES, 'utf8'));
    const flat = [];
    for (const it of queries) for (const key of ['q1', 'q2']) if (it[key]) flat.push({ id: it.id, key, q: it[key] });

    // 查询向量算一次全程复用
    const vecs = new Map();
    for (const f of flat) {
      const [raw] = await host.embed([`query: ${f.q}`]);
      vecs.set(f.q, normalize(raw));
    }
    out({ stage: 'vecs', n: vecs.size });

    const origHits = g._semanticHits.bind(g);
    const table = [];
    for (const z of ZS) {
      g._semanticHits = (k, opts) => origHits(k, { ...(opts || {}), minZ: z });
      let hit = 0;                 // 目标进 top-8 的查询数
      const lost = [];             // 原本关键词命中、放宽后被挤出去的
      const gained = [];
      for (const f of flat) {
        const kwOnly = g.query(f.q, { k: K, semantic: false });
        const kwIn = kwOnly.some((r) => r.id === f.id);
        g._pendingQueryVec = vecs.get(f.q);
        const fused = g.query(f.q, { k: K, semantic: true });
        g._pendingQueryVec = null;
        const fusedIn = fused.some((r) => r.id === f.id);
        if (fusedIn) hit++;
        if (kwIn && !fusedIn) lost.push(`${f.id}/${f.key}`);
        if (!kwIn && fusedIn) gained.push(`${f.id}/${f.key}`);
      }
      table.push({ z, hit, total: flat.length, pct: Math.round((hit / flat.length) * 1000) / 10, gained: gained.length, lost: lost.length, lostIds: lost, gainedIds: gained });
      out({ stage: 'z', z, hit, of: flat.length, gained: gained.length, lost: lost.length });
    }
    g._semanticHits = origHits;

    // 基线: 纯关键词
    let kwHit = 0;
    for (const f of flat) if (g.query(f.q, { k: K, semantic: false }).some((r) => r.id === f.id)) kwHit++;
    out({ stage: 'baseline', keywordOnly: kwHit, of: flat.length });
    fs.writeFileSync('/tmp/en-mem-lab/sweep.json', JSON.stringify({ keywordOnly: kwHit, total: flat.length, table }, null, 2));
  } catch (e) {
    out({ stage: 'error', error: String((e && e.stack) || e) });
  } finally {
    host.dispose();
    app.exit(0);
  }
});
