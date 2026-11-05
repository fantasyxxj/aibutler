// memory-migrate-v2.js — v1(.md 散文件 + v1 库) → v2(DB 即真源) 的迁移器。
//
// 🔴 这是一个【功能】, 跑在用户装完新版第一次启动的时候, 不是我在开发机上手工搬一遍。
//    所以它必须自己探测起点、自己对账、失败自己回滚 —— 装机在外的实例状态各不相同,
//    没有人在旁边看着它跑。
//
// 🔴 分两段, 第二段必须有 AI 参与(2026-08-16 作者定):
//    段一 机械迁(本文件)  —— 一条不丢地搬【形式】: 字段改名、[[链接]] 换成数字边、
//                            _revisions/*.jsonl 并进 history。全程零 token。
//    段二 判断调整(AI)    —— 搬不动的是【语义】: 命题怎么写、大节点拆成几条、哪两条是同一件事。
//                            机械那段只给这批标一个 claim_provisional 位, 交给定期体检反复戳。
//    所以本文件的产出不是"迁完了", 是"迁完了 + 这些还欠人看一眼"。
//    ⚠️ 一个反面走法已被否掉: 拿 description 当命题然后就不管了。那等于永远不补 ——
//       兜底一旦能用, 就没有任何力量再去改它。故凡是兜底来的命题, 一律打标。
//    ⚠️ 另一个走法也被否掉了(2026-08-17 作者「那个 review 的合并了吧, 不用特殊做一个事务」):
//       曾经有过 review_queue 一张欠账表 + take/settle/skip 一套流程。它解的是假问题 ——
//       欠账是【当前库的状态】不是【发生过的事件】, 肥大/孤儿/缺归类每次体检现算即可,
//       预先记清单只换来"要标 done、要防复活、标了 done 却没真做"。详见 memory-schema-v2.sql。

const fs = require('fs');
const path = require('path');
const { canon, parseFrontmatter, TYPE_DEFAULT_IMP, SKIP_FILES, SKIP_LINK, nowLocalISO } = require('./memory');
const { MemoryStoreV2, DB_FILE } = require('./memory-store-v2');

// ── 起点探测 ───────────────────────────────────────────────────
// 装机在外的实例状态不一: 有的是老用户(md 满地 + v1 库), 有的是刚装的空壳。
// 探测在前、决定路径在后 —— 反过来(先假设是老用户再兜底)会在空实例上留下一堆空表和假日志。
function detectStart(memoryDir) {
  const dir = path.resolve(memoryDir);
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (!fs.existsSync(dir)) return { kind: 'none', reason: '记忆目录不存在' };
  let mds = [];
  try { mds = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !SKIP_FILES.has(f)); } catch (_) {}
  if (has(DB_FILE)) return { kind: 'done', reason: '已经是 v2', mds: mds.length };
  if (!mds.length) return { kind: 'empty', reason: '没有任何 .md, 新实例直接建空 v2 库', mds: 0 };
  return {
    kind: has('memory.db') ? 'A' : 'B',
    reason: has('memory.db') ? '老用户: v1 库 + md' : '只有 md 没有库(装机后没跑过 v1)',
    mds: mds.length,
  };
}

// ── 段一: 机械迁 ───────────────────────────────────────────────
// dryRun=true 时只算不写盘(除了临时库), 用来在真换之前先看对账数。
function migrate(memoryDir, opts = {}) {
  const dir = path.resolve(memoryDir);
  const log = opts.log || (() => {});
  const start = detectStart(dir);
  if (start.kind === 'done' || start.kind === 'none') return { ok: true, skipped: true, start };

  // 先在旁边的临时目录里整个建好, 全过了才搬到正式位置。中途崩掉留下的是临时目录,
  // 下次启动整个删掉重来 —— 正式库要么是老的、要么是完整的新的, 不存在"迁了一半"。
  const target = path.join(dir, DB_FILE);
  const tmpDir = path.join(dir, '.migrating');
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, DB_FILE);

  const store = new MemoryStoreV2(tmpDir);
  const stat = {
    start: start.kind, mdFound: 0, nodes: 0, edges: 0, dangling: 0,
    revFiles: 0, revRows: 0, pinned: 0, queued: 0, skipped: [],
  };
  try {
    store.db;   // getter: 建库 + 灌 schema + 开外键
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !SKIP_FILES.has(f)).sort();
    stat.mdFound = files.length;

    // ── 1. 节点。先全部建出来再连边: [[链接]] 指向的节点可能排在后面, 一趟走完必然漏一半。
    const bySlug = new Map();       // slug → 数字 id
    const linksOf = new Map();      // slug → [dst slug]
    store.transaction(() => {
      for (const f of files) {
        const abs = path.join(dir, f);
        let text;
        try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { stat.skipped.push(`${f}: 读不了 ${e.message}`); continue; }
        const [fm, body] = parseFrontmatter(text);
        const slug = canon(path.basename(f, '.md'));
        const type = (fm.type || '').toLowerCase();
        // v1 的 pinned 是 importance 的一个取值, v2 里它是独立的扩展表 —— 档位要落回 high,
        // 否则 CHECK 约束外的脏值会一路带进新库。
        const rawImp = (fm.importance || TYPE_DEFAULT_IMP[type] || 'low').toLowerCase();
        const isPinned = rawImp === 'pinned';
        // 🔴 命题是兜底的: description 当初是为了检索写的一句话摘要, 不是"可判真假的陈述"。
        // 这里必须给个值(claim NOT NULL), 但同时无条件进队列 —— 见文件头那条反面走法。
        const claim = (fm.description || fm.name || slug).slice(0, 500);
        const id = store.upsertNode({
          slug,
          title: fm.name || slug,
          claim,
          body,
          type,
          importance: isPinned ? 'high' : rawImp,
          status: (fm.status || 'active').toLowerCase(),
          scope: fm.scope || '',
          is_factory: (fm.origin || '') === 'birth' ? 1 : 0,
          exit_criteria: fm.exit_criteria || '',
          review_due: fm.review_due || '',
          created: fm.created || '',
          last_used: fm.last_used || fm.created || '',
          use_count: parseInt(fm.use_count || 1, 10) || 1,
        }, { actor: 'migrate', op: 'migrate' });
        bySlug.set(slug, id);
        stat.nodes++;
        if (isPinned) {
          // pinned 与红线在 v1 是同一个格子, v2 里是两张可重叠的表。哪些其实是"一旦用到必须遵守"
          // 的红线, 是判断不是规则 —— 交给 AI(体检的 legacy_backlog 会把这批一起端出来)。
          store.setPinned(id, '迁移自 v1 importance=pinned');
          stat.pinned++;
        }
        const dsts = [];
        const seen = new Set();
        for (const mm of body.matchAll(/\[\[([A-Za-z0-9_\-]+)\]\]/g)) {
          const d = canon(mm[1]);
          if (d === slug || SKIP_LINK.has(d) || seen.has(d)) continue;
          seen.add(d); dsts.push(d);
        }
        linksOf.set(slug, dsts);
      }
    });
    log(`节点 ${stat.nodes} 条`);

    // ── 2. 边。指向不存在节点的悬空边【不建】, 但要留下线索 ——
    //    悄悄丢掉等于把"我以为连着的东西其实早断了"这个事实也一起丢了。
    store.transaction(() => {
      for (const [src, dsts] of linksOf) {
        const sid = bySlug.get(src);
        for (const d of dsts) {
          const did = bySlug.get(d);
          if (!did) { stat.dangling++; continue; }
          if (store.addEdge(sid, did, 'relates', 'human')) stat.edges++;
        }
      }
    });
    log(`边 ${stat.edges} 条(悬空 ${stat.dangling} 条未建)`);

    // ── 3. 修订史并入 history。v1 那套 _revisions/*.jsonl 是旁路模块, 与图脱节;
    //    v2 里它和 write 产生的历史同表同格式, 从此只有一处历史。
    const revDir = path.join(dir, '_revisions');
    if (fs.existsSync(revDir)) {
      const revs = fs.readdirSync(revDir).filter((f) => f.endsWith('.jsonl'));
      stat.revFiles = revs.length;
      store.transaction(() => {
        for (const rf of revs) {
          const slug = canon(path.basename(rf, '.jsonl'));
          const nid = bySlug.get(slug);
          if (!nid) { stat.skipped.push(`_revisions/${rf}: 找不到对应节点`); continue; }
          const lines = fs.readFileSync(path.join(revDir, rf), 'utf8').split('\n').filter((l) => l.trim());
          for (const line of lines) {
            let r;
            try { r = JSON.parse(line); } catch (_) { continue; }
            store.addHistory({
              node_id: nid, op: r.op || 'update', field: 'body',
              before: r.old_body || '', after: r.new_body || '',
              actor: 'v1_revisions', at: r.ts || null,
            });
            stat.revRows++;
          }
        }
      });
    }
    log(`修订 ${stat.revRows} 条(来自 ${stat.revFiles} 个文件)`);

    // ── 4. 兜底命题打标。搬进来的 claim 全是拿 v1 的 description 顶上的, 一条也没人判过真假。
    //    🔴 这里【不建队列】(2026-08-17 作者: 合并掉, 不用特殊做一个事务)。欠账是当前库的
    //    状态不是发生过的事件: 肥大/孤儿/缺归类 体检每次现算, 唯独"命题是兜底的"看内容判不出来,
    //    所以只留这一个位。之后由定期体检的 legacy_backlog 反复戳, 改一条清一条, 没人要标 done。
    store.transaction(() => {
      const ids = [...bySlug.values()];
      store.markClaimProvisional(ids);
      stat.queued = ids.length;
    });
    log(`兜底命题 ${stat.queued} 条待判(交给定期体检反复戳, 不建队列)`);

    // ── 4.5 向量。不搬会让老用户的语义检索【永久死掉】, 而且完全静默:
    //    semanticOptedIn() 的判据是"库里有向量", 而后台补向量的 kickEmbed() 又要求已 optedIn
    //    —— 迁完 0 向量 = 不算开过 = 永远不补 = 永远 0 向量。鸡生蛋, 自己解不开。
    //    两张表只差主键(v1 是 slug, v2 是数字 id), 其余列一模一样, 直接搬。
    //    src_hash 一并搬: 内容没变的立刻可用, 变了的照常被判过期后台重算, 两种都不会错。
    stat.vectors = 0;
    try {
      const v1db = path.join(dir, 'memory.db');
      if (fs.existsSync(v1db)) {
        store.db.exec(`ATTACH DATABASE '${v1db.replace(/'/g, "''")}' AS v1`);
        try {
          const rows = store.db.all('SELECT id, dim, vec, model, src_hash, embedded_at FROM v1.vectors');
          store.transaction(() => {
            for (const r of rows) {
              const nid = bySlug.get(canon(r.id));
              if (!nid) continue;
              store.db.run(
                `INSERT OR REPLACE INTO vectors(node_id,dim,vec,model,src_hash,embedded_at)
                 VALUES(?,?,?,?,?,?)`,
                [nid, r.dim, r.vec, r.model, r.src_hash, r.embedded_at || null]);
              stat.vectors++;
            }
          });
          // 搬过向量 = 这个用户当初开过语义检索。把结论写死, 别再让它靠"数一数有没有向量"去推断。
          if (stat.vectors) store.setMeta('semantic_optin', nowLocalISO());
        } finally { try { store.db.exec('DETACH DATABASE v1'); } catch (_) {} }
      }
    } catch (e) {
      // 向量搬不过来只是慢(后台会重算), 不该让整条迁移回滚。
      stat.skipped.push(`vectors: ${e.message}`);
    }
    log(`向量 ${stat.vectors} 条`);

    // ── 5. 对账。数不对就不换, 宁可留在 v1 上。
    const audit = {
      md: stat.mdFound, nodesInDb: store.nodeCount(),
      edgesInDb: store.allEdges().length, historyInDb: store.historyCount(),
      pending: store.db.get('SELECT COUNT(*) AS n FROM nodes WHERE claim_provisional = 1').n,
    };
    const problems = [];
    if (audit.nodesInDb !== stat.mdFound) problems.push(`节点数 ${audit.nodesInDb} ≠ md 数 ${stat.mdFound}`);
    if (audit.edgesInDb !== stat.edges) problems.push(`边数 ${audit.edgesInDb} ≠ 建边数 ${stat.edges}`);
    // history 除了迁进来的修订, 还有 upsertNode 每建一条节点自动记的一行 create
    if (audit.historyInDb !== stat.revRows + stat.nodes) {
      problems.push(`历史 ${audit.historyInDb} ≠ 修订 ${stat.revRows} + 建节点 ${stat.nodes}`);
    }
    store.setMeta('migrated_from', start.kind);
    store.setMeta('migrated_md_count', String(stat.mdFound));
    store.close();

    const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} };
    if (problems.length) { cleanup(); return { ok: false, rolledBack: true, problems, stat, audit, start }; }
    if (opts.dryRun) { cleanup(); return { ok: true, dryRun: true, stat, audit, start }; }
    fs.renameSync(tmp, target);
    cleanup();
    return { ok: true, stat, audit, start, dbPath: target };
  } catch (e) {
    try { store.close(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    return { ok: false, rolledBack: true, error: e.message, stat, start };
  }
}

module.exports = { detectStart, migrate };
