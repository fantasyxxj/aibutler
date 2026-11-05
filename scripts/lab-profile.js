// scripts/lab-profile.js — 把一次 queryAsync 的 131ms 拆开, 看每一段各花多少。
// 用法: LAB_DIR=/tmp/zh-mem-lab/memory electron scripts/lab-profile.js
const { app } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const host = require(path.join(ROOT, 'personal', 'embed-host'));
host.registerScheme();

const DIR = process.env.LAB_DIR;
const K = 8;
// LAB_Q 给了就用 lab-verify 的同一份查询集(口径对齐, 否则两边数字没法比)
const QS = process.env.LAB_Q ? (() => {
  const items = JSON.parse(require('fs').readFileSync(process.env.LAB_Q, 'utf8'));
  const f = [];
  for (const it of items) for (const key of ['q1', 'q2']) if (it[key]) f.push(it[key]);
  return f;
})() : [
  'pydantic 前缀读不到环境变量',
  'LIFF 每店一个还是平台共用',
  '记忆检索融合怎么改的',
  '打包前要不要先 bump 版本号',
  '席位模型 单位数 每单位座位数',
  'banto 改名 BIZ 前缀',
  '行业版 AI 能不能读自己源码',
  'LINE 公式アカウント 注册 SMS',
];

function out(o) { process.stdout.write('PROF:' + JSON.stringify(o) + '\n'); }
const ms = (t) => Math.round((Number(process.hrtime.bigint() - t) / 1e6) * 10) / 10;

app.whenReady().then(async () => {
  try {
    host.installProtocol();
    const { MemoryGraph } = require(path.join(ROOT, 'memory'));
    const { cosine } = require(path.join(ROOT, 'core', 'memory-vector'));
    const g = new MemoryGraph(DIR);
    g.setEmbedder(host.embed);
    out({ stage: 'gate', fusionOn: g.semanticFusionOn(), optedIn: g.semanticOptedIn(), ...g.embedStats() });

    // 冷: 隐藏窗口 + 模型首次加载
    let t = process.hrtime.bigint();
    await host.embed(['query: warmup']);
    out({ stage: 'cold_embed_first_call_ms', ms: ms(t) });

    // 全库向量从 SQLite 读出来一次(memory.js 里有 _vecCache, 只付一次)
    t = process.hrtime.bigint();
    const vecs = g.store.allVectors(g.embedModel);
    out({ stage: 'allVectors_ms', ms: ms(t), n: vecs.length, dim: vecs[0] && vecs[0].vec.length });

    const rows = [];
    for (const q of QS) {
      // ① 查询向量(wasm 前向 + IPC 往返)
      let t1 = process.hrtime.bigint();
      const v = (await host.embed([`query: ${q}`]))[0];
      const msEmbed = ms(t1);

      // ② 全库余弦 + 排序(纯 CPU)
      t1 = process.hrtime.bigint();
      vecs.map((e) => ({ id: e.id, score: cosine(v, e.vec) })).sort((a, b) => b.score - a.score);
      const msCos = ms(t1);

      // ③ 关键词那一路
      t1 = process.hrtime.bigint();
      g.query(q, { k: K, semantic: false });
      const msKw = ms(t1);

      // ③' 全表 LIKE 兜底(语义一有货就被无条件触发的那一段)
      const { tokenize } = require(path.join(ROOT, 'memory'));
      t1 = process.hrtime.bigint();
      const nBody = g._bodyHitIds(g._fresh(), tokenize(q)).size;
      const msBody = ms(t1);

      // ④ 端到端(产品真实路径)
      t1 = process.hrtime.bigint();
      await g.queryAsync(q, { k: K });
      const msTotal = ms(t1);

      rows.push({ q: q.slice(0, 14), msEmbed, msCos, msKw, msBody, nBody, msTotal });
    }
    const avg = (f) => Math.round((rows.reduce((s, r) => s + r[f], 0) / rows.length) * 10) / 10;
    out({ stage: 'result', rows,
      avg: { embed: avg('msEmbed'), cosine: avg('msCos'), keyword: avg('msKw'),
             bodyLike: avg('msBody'), total: avg('msTotal') } });
  } catch (e) {
    out({ stage: 'error', error: String((e && e.stack) || e) });
  } finally {
    host.dispose();
    app.exit(0);
  }
});
