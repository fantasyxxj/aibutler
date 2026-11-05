// scripts/lab-verify.js — 落地后的验收: 跑【产品代码那条路】, 不再跑 lab 脚本里另写的策略函数。
//
// lab-fuse.js 比的是"如果这样融合会怎样"(策略函数写在脚本里); 这一份比的是"引擎现在实际怎么返回"
// —— 走 queryAsync → prepareSemantic(含默认开关/opt-in 闸) → query 的锁头+RRF。
// 两者结论一致才算真落地, 否则就是"实验室赢了产品没变"。
//
// 用法: LAB_DIR=/tmp/en-mem-lab/memory LAB_Q=/tmp/en-mem-lab/gen/queries.json electron scripts/lab-verify.js
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const host = require(path.join(ROOT, 'personal', 'embed-host'));
host.registerScheme();

const DIR = process.env.LAB_DIR;
const QUERIES = process.env.LAB_Q;
const K = 8;

function out(o) { process.stdout.write('LAB:' + JSON.stringify(o) + '\n'); }

app.whenReady().then(async () => {
  try {
    host.installProtocol();
    const { MemoryGraph } = require(path.join(ROOT, 'memory'));
    const g = new MemoryGraph(DIR);
    g.setEmbedder(host.embed);
    // 故意不调 markSemanticOptIn(): 库里有向量就该被认成"点过头", 这本身也是要验的一环。
    out({ stage: 'gate', fusionOn: g.semanticFusionOn(), optedIn: g.semanticOptedIn(), ...g.embedStats() });

    const queries = JSON.parse(fs.readFileSync(QUERIES, 'utf8'));
    const flat = [];
    for (const it of queries) for (const key of ['q1', 'q2']) if (it[key]) flat.push({ id: it.id, key, q: it[key] });

    const rows = [];
    let msKw = 0, msFused = 0;
    for (const f of flat) {
      let t = Date.now();
      const kw = g.query(f.q, { k: K, semantic: false }).map((r) => r.id);
      msKw += Date.now() - t;
      t = Date.now();
      const fused = await g.queryAsync(f.q, { k: K });          // ← 产品真实路径
      msFused += Date.now() - t;
      const ids = fused.map((r) => r.id);
      rows.push({
        id: f.id, key: f.key,
        kw: kw.indexOf(f.id) + 1 || null,
        fused: ids.indexOf(f.id) + 1 || null,
        via: ids.includes(f.id) ? fused[ids.indexOf(f.id)].via : '',
        headKept: JSON.stringify(ids.slice(0, 3)) === JSON.stringify(kw.slice(0, 3)),
        n: ids.length, dup: new Set(ids).size !== ids.length,
      });
    }
    const sum = (pick) => {
      const hit = rows.filter((r) => r[pick]).length;
      return { hit, of: rows.length, pct: Math.round((hit / rows.length) * 1000) / 10,
               top1: rows.filter((r) => r[pick] === 1).length,
               top3: rows.filter((r) => r[pick] && r[pick] <= 3).length };
    };
    const lost = rows.filter((r) => r.kw && !r.fused).map((r) => `${r.id}/${r.key}`);
    const gained = rows.filter((r) => !r.kw && r.fused).map((r) => `${r.id}/${r.key}`);
    out({ stage: 'result',
      keyword: sum('kw'), fused: sum('fused'),
      lost, gained,
      msPerQuery: { keyword: Math.round(msKw / rows.length), fused: Math.round(msFused / rows.length) },
      headBroken: rows.filter((r) => !r.headKept).length,
      dup: rows.filter((r) => r.dup).length,
      short: rows.filter((r) => r.n !== K).length });
    if (process.env.LAB_OUT) fs.writeFileSync(process.env.LAB_OUT, JSON.stringify(rows, null, 2));
  } catch (e) {
    out({ stage: 'error', error: String((e && e.stack) || e) });
  } finally {
    host.dispose();
    app.exit(0);
  }
});
