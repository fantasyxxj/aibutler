// scripts/en-lab-run.js — 英语场景下「语义检索 vs 关键词检索」实测。在真 Electron 里跑(wasm 推理)。
//
// 背景: 2026-08-13 中文真库(747 节点)实测语义一次都没赢过关键词, 于是默认关。作者指出那个结论
// 是中文特有的 —— 中文词形不变, CJK 2-gram 一切就全命中; 英语有词形变化(package/packaging)和
// 同义替换(kill/terminate), 关键词那条路本来就该漏。所以要在英语语料上重量一次。
//
// 判据不是"语义有没有排进去", 而是【语义单独赢】: 关键词漏掉(top-8 之外)而语义捞回来。
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const host = require(path.join(ROOT, 'personal', 'embed-host'));
host.registerScheme();

const DIR = '/tmp/en-mem-lab/memory';
const QUERIES = '/tmp/en-mem-lab/gen/queries.json';
const K = 8;                    // 真实检索的返回条数
const DEEP = 5000;              // 量排名时取的深度(要能看到 #100 这种烂排名)

function out(o) { process.stdout.write('LAB:' + JSON.stringify(o) + '\n'); }

app.whenReady().then(async () => {
  try {
    host.installProtocol();
    const { MemoryGraph } = require(path.join(ROOT, 'memory'));
    const { normalize, cosine } = require(path.join(ROOT, 'core', 'memory-vector'));

    const g = new MemoryGraph(DIR);
    g.setEmbedder(host.embed);
    g.markSemanticOptIn();

    const stats0 = g.embedStats();
    out({ stage: 'corpus', nodes: stats0.total, pending: stats0.pending });

    // 全量补向量(配方 = 现行的 title+description)
    const t0 = Date.now();
    let guard = 0;
    for (;;) {
      const r = await g.embedPending({ batch: 16 });
      if (!r.embedded || ++guard > 200) break;
      if (g.embedStats().pending === 0) break;
    }
    const st = g.embedStats();
    out({ stage: 'embedded', have: st.have, pending: st.pending, secs: Math.round((Date.now() - t0) / 1000) });

    const entries = g.store.allVectors(g.embedModel);
    const queries = JSON.parse(fs.readFileSync(QUERIES, 'utf8'));

    const rows = [];
    for (const item of queries) {
      for (const key of ['q1', 'q2']) {
        const q = item[key];
        if (!q) continue;

        // —— 关键词路(现行默认: 语义关) ——
        const kw = g.query(q, { k: DEEP, semantic: false });
        const rKw = kw.findIndex((r) => r.id === item.id);

        // —— 语义路(纯向量全排名) ——
        const [raw] = await host.embed([`query: ${q}`]);
        const qv = normalize(raw);
        const scored = entries.map((e) => ({ id: e.id, score: cosine(qv, e.vec) }))
          .sort((a, b) => b.score - a.score);
        const rSem = scored.findIndex((r) => r.id === item.id);

        // —— 显著性 z(引擎实际用来决定语义要不要出手的判据) ——
        const at = (f) => scored[Math.min(scored.length - 1, Math.floor(scored.length * f))].score;
        const p50 = at(0.5), p90 = at(0.1), spread = p90 - p50;
        const zOf = (s) => (spread > 0 ? (s - p50) / spread : 0);

        // —— 融合路(引擎真实行为: 关键词 top-K + 语义留席) ——
        g._pendingQueryVec = qv;
        const fused = g.query(q, { k: K, semantic: true });
        g._pendingQueryVec = null;
        const rFused = fused.findIndex((r) => r.id === item.id);

        rows.push({
          id: item.id, key, q,
          kw: rKw < 0 ? null : rKw + 1,
          sem: rSem < 0 ? null : rSem + 1,
          fused: rFused < 0 ? null : rFused + 1,
          semTopZ: Number(zOf(scored[0].score).toFixed(2)),
          semSelfZ: rSem < 0 ? null : Number(zOf(scored[rSem].score).toFixed(2)),
          semTopId: scored[0].id,
          fusedVia: rFused < 0 ? '' : (fused[rFused].via || ''),
        });
      }
    }
    out({ stage: 'rows', rows });
    fs.writeFileSync('/tmp/en-mem-lab/result.json', JSON.stringify(rows, null, 2));
  } catch (e) {
    out({ stage: 'error', error: String((e && e.stack) || e) });
  } finally {
    host.dispose();
    app.exit(0);
  }
});
