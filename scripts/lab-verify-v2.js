// scripts/lab-verify-v2.js — 8.4 after 基准: 同一套冻结语料, 打 v2 引擎。
//
// 与 lab-verify.js 严格对齐(同语料 · 同 K · 同判据 · 同产品路径 queryAsync), 只换引擎, 否则不可比。
// 两处 v2 特有, 都必须分开报, 混在一起会得出假结论:
//   · v2 命中的是 slug, 老 id 迁移后就是 slug —— queries.json 的 id 字段直接可比。
//   · v2 默认 minTier='med' 会【主动丢弃低分结果】(3.2 分数不够就闭嘴)。
//     所以同时跑 med(产品真实行为) 和 low(纯排序能力), 前者用来看"闭嘴闭对了没",
//     后者才是与 v1 同口径的排序对比 —— v1 没有闭嘴这回事。
//
// 用法: LAB_MD=/tmp/zh-mem-lab/memory LAB_Q=/tmp/zh-mem-lab/gen/queries.json \
//         electron scripts/lab-verify-v2.js
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const host = require(path.join(ROOT, 'personal', 'embed-host'));
host.registerScheme();

const MD = process.env.LAB_MD;
const QUERIES = process.env.LAB_Q;
const K = 8;

function out(o) { process.stdout.write('LAB:' + JSON.stringify(o) + '\n'); }

app.whenReady().then(async () => {
  let g = null;
  let work = null;
  try {
    host.installProtocol();
    // 冻结语料是 .md 目录, v2 要库 —— 拿真迁移器迁一份到临时目录, 不动原语料。
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-v2-'));
    fs.cpSync(MD, path.join(work, 'memory'), { recursive: true });
    const { migrate } = require(path.join(ROOT, "memory-migrate-v2"));
    const mig = migrate(path.join(work, 'memory'), { persona: 'lab' });
    out({ stage: 'migrate', ...mig });

    const { MemoryGraphV2 } = require(path.join(ROOT, 'memory-v2'));
    g = new MemoryGraphV2(path.join(work, 'memory'));
    g.setEmbedder(host.embed);

    const queries = JSON.parse(fs.readFileSync(QUERIES, 'utf8'));
    const flat = [];
    for (const it of queries) for (const key of ['q1', 'q2']) if (it[key]) flat.push({ id: it.id, key, q: it[key] });

    const rows = [];
    let msKw = 0, msFused = 0;
    for (const f of flat) {
      const want = String(f.id);
      const nameOf = (r) => String(r.slug || r.id || '');
      let t = Date.now();
      const kw = (g.query(f.q, { k: K, semantic: false, minTier: 'low' }) || []).map(nameOf);
      msKw += Date.now() - t;
      t = Date.now();
      const fusedLow = (await g.queryAsync(f.q, { k: K, minTier: 'low' })) || [];
      msFused += Date.now() - t;
      const idsLow = fusedLow.map(nameOf);
      const idsMed = ((await g.queryAsync(f.q, { k: K, minTier: 'med' })) || []).map(nameOf);
      rows.push({
        id: want, key: f.key,
        kw: kw.indexOf(want) + 1 || null,
        fused: idsLow.indexOf(want) + 1 || null,       // 与 v1 同口径(不闭嘴)
        fusedMed: idsMed.indexOf(want) + 1 || null,    // 产品真实行为(会闭嘴)
        n: idsLow.length,
        dup: new Set(idsLow).size !== idsLow.length,
      });
    }
    const sum = (pick) => {
      const hit = rows.filter((r) => r[pick]).length;
      return { hit, of: rows.length, pct: Math.round((hit / rows.length) * 1000) / 10,
               top1: rows.filter((r) => r[pick] === 1).length,
               top3: rows.filter((r) => r[pick] && r[pick] <= 3).length };
    };
    // before 那份的核心验收线: q2(查询词含老 id 关键词)必须仍是全中 —— 掉了就是
    // 数字主键抹掉的信号没被 keywords 补回来。
    const q2 = rows.filter((r) => r.key === 'q2');
    const q1 = rows.filter((r) => r.key === 'q1');
    const seg = (arr, pick) => `${arr.filter((r) => r[pick]).length}/${arr.length}`;
    out({ stage: 'result',
      keyword: sum('kw'), fused: sum('fused'), fusedMed: sum('fusedMed'),
      q1: { kw: seg(q1, 'kw'), fused: seg(q1, 'fused') },
      q2: { kw: seg(q2, 'kw'), fused: seg(q2, 'fused') },
      msPerQuery: { keyword: Math.round(msKw / rows.length), fused: Math.round(msFused / rows.length) },
      dup: rows.filter((r) => r.dup).length,
      short: rows.filter((r) => r.n !== K).length });
    if (process.env.LAB_OUT) fs.writeFileSync(process.env.LAB_OUT, JSON.stringify(rows, null, 2));
  } catch (e) {
    out({ stage: 'error', error: String((e && e.stack) || e) });
  } finally {
    try { if (g) g.close(); } catch (_) {}
    try { if (work) fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
    host.dispose();
    app.exit(0);
  }
});
