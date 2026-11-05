// scripts/lab-dump.js — 把每条查询的两路原始排名 + 关键词分数缓存成 JSON。
//
// 为什么要单独一步: 策略选型要扫几十种规则, 而每扫一次都重跑一遍 wasm 推理是纯浪费
// (推理占 99% 的时间, 而它的输出跟策略无关)。dump 一次, 后面用纯 node 扫到饱。
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const host = require(path.join(ROOT, 'personal', 'embed-host'));
host.registerScheme();

const DIR = process.env.LAB_DIR;
const QUERIES = process.env.LAB_Q;
const OUT = process.env.LAB_OUT;
const DEEP = 5000;

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
      const [raw] = await host.embed([`query: ${f.q}`]);
      const qv = normalize(raw);
      const sem = entries.map((e) => ({ id: e.id, score: cosine(qv, e.vec) })).sort((a, b) => b.score - a.score);
      per.push({
        id: f.id, key: f.key, q: f.q,
        // 只留前 200 名: 策略最多看 top-8, 200 名之外对任何 RRF 都不可能翻身, 但文件小 20 倍。
        kwAll: kwRaw.slice(0, 200).map((r) => r.id),
        kwScores: kwRaw.slice(0, 200).map((r) => r.score),
        kwTotal: kwRaw.length,
        semAll: sem.slice(0, 200).map((r) => r.id),
        semScores: sem.slice(0, 200).map((r) => Math.round(r.score * 10000) / 10000),
      });
    }
    fs.writeFileSync(OUT, JSON.stringify(per));
    process.stdout.write(`LAB:{"stage":"dump","n":${per.length},"out":"${OUT}"}\n`);
  } catch (e) {
    process.stdout.write('LAB:' + JSON.stringify({ stage: 'error', error: String((e && e.stack) || e) }) + '\n');
  } finally {
    host.dispose();
    app.exit(0);
  }
});
