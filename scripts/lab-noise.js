// scripts/lab-noise.js — 残留风险测量: 库里【没有答案】的问题, 融合会往 top-8 里塞多少噪音?
//
// 召回测试只回答"该找到的能不能找到", 不回答"不该出现的会不会挤进来"。RRF 没有阈值, 语义那一路
// 对任何查询都会贡献分数 —— 所以必须单独量: 无答案查询下, 结果里有几条是纯粹被语义塞进来的。
// 这是真实代价, 因为 top-8 会整段进 AI 的上下文, 混进无关记忆等于给它喂错料。
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const host = require(path.join(ROOT, 'personal', 'embed-host'));
host.registerScheme();

const DIR = process.env.LAB_DIR;
const K = 8;
const DEEP = 5000;
const QS = JSON.parse(process.env.LAB_NOISE_QS);

function out(o) { process.stdout.write('LAB:' + JSON.stringify(o) + '\n'); }

function rrf(kwIds, semIds, { C = 10, k = K } = {}) {
  const s = new Map();
  kwIds.forEach((id, i) => s.set(id, (s.get(id) || 0) + 1 / (C + i + 1)));
  semIds.forEach((id, i) => s.set(id, (s.get(id) || 0) + 1 / (C + i + 1)));
  return [...s.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => id);
}

app.whenReady().then(async () => {
  try {
    host.installProtocol();
    const { MemoryGraph } = require(path.join(ROOT, 'memory'));
    const { normalize, cosine } = require(path.join(ROOT, 'core', 'memory-vector'));
    const g = new MemoryGraph(DIR);
    g.setEmbedder(host.embed);
    const entries = g.store.allVectors(g.embedModel);

    for (const q of QS) {
      const kwAll = g.query(q, { k: DEEP, semantic: false }).map((r) => r.id);
      const [raw] = await host.embed([`query: ${q}`]);
      const qv = normalize(raw);
      const semAll = entries.map((e) => ({ id: e.id, score: cosine(qv, e.vec) }))
        .sort((a, b) => b.score - a.score).map((x) => x.id);

      const lock = kwAll.slice(0, 3);
      const rest = rrf(kwAll, semAll, { C: 10, k: K + 3 }).filter((id) => !lock.includes(id));
      const gRes = lock.concat(rest).slice(0, K);
      const kwTop = kwAll.slice(0, K);
      // 被语义塞进来的 = 出现在融合结果里, 但关键词那一路整个 top-8 都没有它
      const injected = gRes.filter((id) => !kwTop.includes(id));
      out({ q, kwFound: kwAll.length, kwTop8: kwTop.length, injected: injected.length, injectedIds: injected.slice(0, 4) });
    }
  } catch (e) {
    out({ stage: 'error', error: String((e && e.stack) || e) });
  } finally {
    host.dispose();
    app.exit(0);
  }
});
