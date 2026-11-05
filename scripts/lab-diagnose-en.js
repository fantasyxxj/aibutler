// scripts/lab-diagnose-en.js — 英语那 7 条"只有语义捞得回来"的记忆, 到底是哪种病?
//   (a) 关键词【完全零命中】 → 真语义鸿沟, 非模型不可
//   (b) 命中了但【排不进 top-8】 → 排序/权重问题, 不下模型也可能救
// 这两种的解法完全不同, 不量清楚就会买错药。
// 用法: LAB_DIR=/tmp/en-mem-lab/memory LAB_Q=/tmp/en-mem-lab/gen/queries.json electron scripts/lab-diagnose-en.js
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const host = require(path.join(ROOT, 'personal', 'embed-host'));
host.registerScheme();

const DIR = process.env.LAB_DIR;
const QUERIES = process.env.LAB_Q;

function out(o) { process.stdout.write('DX:' + JSON.stringify(o) + '\n'); }

app.whenReady().then(async () => {
  try {
    host.installProtocol();
    const { MemoryGraph, tokenize } = require(path.join(ROOT, 'memory'));
    const g = new MemoryGraph(DIR);
    g.setEmbedder(host.embed);

    const items = JSON.parse(fs.readFileSync(QUERIES, 'utf8'));
    const flat = [];
    for (const it of items) for (const key of ['q1', 'q2']) if (it[key]) flat.push({ id: it.id, key, q: it[key] });

    const rows = [];
    for (const f of flat) {
      // 关键词【全序】(不截断), 看目标真实位次
      const full = g.query(f.q, { k: 9999, semantic: false }).map((r) => r.id);
      const pos = full.indexOf(f.id) + 1 || null;
      const fused = (await g.queryAsync(f.q, { k: 8 })).map((r) => r.id);
      rows.push({
        id: f.id, key: f.key, q: f.q.slice(0, 46),
        kwPos: pos,               // null = 关键词全序里根本没有它 = 零命中
        kwPool: full.length,
        fusedPos: fused.indexOf(f.id) + 1 || null,
        terms: tokenize(f.q).map((t) => t.t).join(' '),
      });
    }
    const gained = rows.filter((r) => (!r.kwPos || r.kwPos > 8) && r.fusedPos);
    out({ stage: 'gained_detail', n: gained.length, rows: gained });
    out({ stage: 'summary',
      zeroHit: gained.filter((r) => !r.kwPos).length,
      rankedButBuried: gained.filter((r) => r.kwPos && r.kwPos > 8).map((r) => ({ id: r.id, key: r.key, kwPos: r.kwPos })) });
  } catch (e) {
    out({ stage: 'error', error: String((e && e.stack) || e) });
  } finally {
    host.dispose();
    app.exit(0);
  }
});
