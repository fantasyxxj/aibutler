// scripts/lab-crosslang.js — 唯一没测过的角度: 用【英文问句】去查【中文记忆库】。
// 关键词路在这种场景必然接近 0(中文节点里没有英文原词), 语义是跨语言对齐的 ——
// 如果语义有不可替代的价值, 只会在这里显出来。
// 用法: LAB_DIR=/tmp/zh-mem-lab/memory electron scripts/lab-crosslang.js
const { app } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const host = require(path.join(ROOT, 'personal', 'embed-host'));
host.registerScheme();

const DIR = process.env.LAB_DIR;
const K = 8;

// 每条 = 英文问句 + 期望命中的中文节点 id
const CASES = [
  ['pydantic settings env prefix is silently ignored', 'reference_pydantic_settings_no_prefix_silently_ignores_prefixed_env'],
  ['should each shop have its own LIFF app or share one', 'reference_liff_app_scope_customer_per_shop_admin_platform_level'],
  ['never kill the user running processes', 'feedback_never_kill_user_processes_2026_07_27'],
  ['bump the version number before repackaging', 'feedback_bump_version_before_repackage_2026_07_24'],
  ['always show the full clickable file path when delivering a file', 'feedback_deliver_file_must_show_clickable_path'],
  ['keep replies short, say blockers first', 'feedback_say_blockers_first_and_keep_replies_short'],
  ['verify the artifact really contains the new code before shipping', 'feedback_verify_artifact_contains_new_code_before_delivery'],
  ['the bus only transports messages, processing belongs to the receiver', 'feedback_bus_only_transports_processing_belongs_to_receiver_2026_07_23'],
];

function out(o) { process.stdout.write('XL:' + JSON.stringify(o) + '\n'); }

app.whenReady().then(async () => {
  try {
    host.installProtocol();
    const { MemoryGraph } = require(path.join(ROOT, 'memory'));
    const g = new MemoryGraph(DIR);
    g.setEmbedder(host.embed);

    const rows = [];
    for (const [q, want] of CASES) {
      const kw = g.query(q, { k: K, semantic: false }).map((r) => r.id);
      const fused = (await g.queryAsync(q, { k: K })).map((r) => r.id);
      rows.push({
        q: q.slice(0, 40),
        exists: !!g._fresh().nodes[want],
        kw: kw.indexOf(want) + 1 || null,
        fused: fused.indexOf(want) + 1 || null,
      });
    }
    const n = rows.filter((r) => r.exists).length;
    out({ stage: 'result', rows,
      kwHit: rows.filter((r) => r.kw).length, fusedHit: rows.filter((r) => r.fused).length, of: n,
      missingNodes: rows.filter((r) => !r.exists).map((r) => r.q) });
  } catch (e) {
    out({ stage: 'error', error: String((e && e.stack) || e) });
  } finally {
    host.dispose();
    app.exit(0);
  }
});
