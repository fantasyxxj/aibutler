// scripts/embed-backfill.js — 给一个记忆目录补齐语义向量(在真 Electron 里跑)。
// 用法: electron scripts/embed-backfill.js <memoryDir> [--query "问句"]
// 存在的理由: 补向量必须有推理环境, 而推理只在渲染进程里跑得起来 —— 所以这件事没法用纯 node 做。
const { app } = require('electron');
const path = require('path');

const host = require(path.join(__dirname, '..', 'personal', 'embed-host'));
host.registerScheme();

const args = process.argv.slice(2).filter((a) => !a.startsWith('--inspect'));
const dir = args.find((a) => !a.startsWith('--'));
const qIdx = args.indexOf('--query');
const query = qIdx >= 0 ? args[qIdx + 1] : null;

app.whenReady().then(async () => {
  try {
    host.installProtocol();
    const { MemoryGraph } = require(path.join(__dirname, '..', 'memory'));
    const g = new MemoryGraph(dir);
    g.setEmbedder(host.embed);
    g.ensureReady();

    const before = g.embedStats();
    console.log(`[backfill] ${dir}`);
    console.log(`[backfill] 节点 ${before.total} · 已有向量 ${before.embedded} · 待补 ${before.pending}`);
    const t0 = Date.now();
    let lastPct = -1;
    const r = await g.embedPending({
      batch: 16,
      onProgress: ({ done, total }) => {
        const pct = Math.floor(done / total * 100);
        if (pct >= lastPct + 10) { lastPct = pct; console.log(`[backfill]   ${done}/${total} (${pct}%)`); }
      },
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[backfill] 完成: 新增 ${r.embedded} 条向量, 耗时 ${secs}s`);
    console.log(`[backfill] 库: ${JSON.stringify(g.store.stats())}`);

    if (query) {
      const rows = await g.queryAsync(query, { k: 8 });
      console.log(`\n[query] "${query}"`);
      for (const x of rows) console.log(`  [${x.score} ${x.via}] ${x.id}\n      ${x.description.slice(0, 60)}`);
    }
    g.store.close();
  } catch (e) {
    console.error('[backfill] 失败:', (e && e.stack) || e);
    host.dispose(); app.exit(1); return;
  }
  host.dispose();
  app.exit(0);
});
