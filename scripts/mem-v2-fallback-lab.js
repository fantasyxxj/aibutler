// mem-v2-fallback-lab.js — 量【兜底交付】的真实收益与代价。
//
// 与 mem-v2-tier-lab.js 的区别: tier-lab 量的是把握度分布(引擎层), 这里量的是
// memory_tools 那一层【真正交给 AI 的东西】—— 够格的 K 条 + 兜底 FALLBACK_MAX 条。
// 两者会得出不同结论: 引擎层"闭嘴掉 10 条答案"在交付层可能被兜底救回来, 反之
// 引擎层看着干净的负例, 也可能在兜底段泄进来一堆杂项。要拍板只能看交付层。
//
// 判据三问:
//   1. 收益 —— 现行闭嘴线丢掉的答案, 兜底救回来几条?
//   2. 代价 —— 库里【真没有】的问题(负例), 兜底段会塞给 AI 几条杂项?
//   3. 中文有没有被拖累 —— 中文负例是有候选的(不像英文零候选), 代价必须单独量。
//
// 纯关键词跑(semantic:false), 与 tier-lab 同口径。语义只会让排序更好, 所以这是下界。
//
// 用法: CORPUS=/tmp/en-mem-lab/memory QUERIES=/tmp/en-mem-lab/gen/queries.json \
//         node scripts/mem-v2-fallback-lab.js

const fs = require('fs');
const path = require('path');
const os = require('os');

const CORPUS = process.env.CORPUS || '/tmp/zh-mem-lab/memory';
const QUERIES = process.env.QUERIES || '/tmp/zh-mem-lab/queries.json';
const NEG = process.env.NEG || '';
const LAB = path.join(os.tmpdir(), 'mem-v2-fallback-lab');

// 与 memory-tools-v2.js 的交付形状保持一致 —— 这两个数改了这里也要改, 否则量的不是真交付
const K = 8;
const FALLBACK_MAX = parseInt(process.env.FALLBACK_MAX || '5', 10);

const { MemoryGraphV2 } = require('../core/memory-v2');

function parseMd(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w_]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    fm[kv[1]] = v;
  }
  const meta = m[1].match(/^\s{2}(\w+):\s*(.*)$/gm) || [];
  for (const line of meta) {
    const kv = line.match(/^\s{2}(\w+):\s*(.*)$/);
    if (kv && fm[kv[1]] === undefined) fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: m[2] };
}

function build() {
  fs.rmSync(LAB, { recursive: true, force: true });
  fs.mkdirSync(LAB, { recursive: true });
  const g = new MemoryGraphV2(LAB);
  const files = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  const slugToId = new Map();
  const linkPairs = [];
  g.store.transaction(() => {
    for (const f of files) {
      const slug = f.replace(/\.md$/, '');
      const { fm, body } = parseMd(fs.readFileSync(path.join(CORPUS, f), 'utf8'));
      const id = g.store.upsertNode({
        slug, title: fm.name || slug, claim: (fm.description || fm.name || slug).slice(0, 2000),
        keywords: '', body, type: fm.type || '',
        importance: fm.importance === 'pinned' ? 'high' : (fm.importance || 'med'),
        created: fm.created || '', last_used: fm.last_used || '',
        use_count: parseInt(fm.use_count || '1', 10) || 1,
      });
      slugToId.set(slug, id);
      if (fm.importance === 'pinned') g.store.setPinned(id, 'lab');
      for (const mm of body.matchAll(/\[\[([a-z0-9_]+)\]\]/g)) linkPairs.push([slug, mm[1]]);
    }
    for (const [a, b] of linkPairs) {
      const s = slugToId.get(a), d = slugToId.get(b);
      if (s && d && s !== d) g.store.addEdge(s, d, 'relates', 'human');
    }
  });
  return { g, slugToId };
}

// 复刻 memory-tools-v2.js 的分层逻辑。要量真交付就必须用同一套分组,
// 直接看 g.query 的返回是量不到的 —— 名额重分配正是发生在工具层。
function deliver(g, q) {
  const all = g.query(q, { k: K + FALLBACK_MAX, minTier: 'low', semantic: false });
  return {
    solid: all.filter((r) => r.tier !== 'low').slice(0, K),
    weak: all.filter((r) => r.tier === 'low').slice(0, FALLBACK_MAX),
  };
}

function main() {
  const { g, slugToId } = build();
  const qs = JSON.parse(fs.readFileSync(QUERIES, 'utf8'));
  console.log(`语料 ${Object.keys(g.store.allNodes()).length} 节点 · 交付形状 够格${K} + 兜底${FALLBACK_MAX}\n`);

  let inSolid = 0, rescued = 0, lost = 0, total = 0;
  let solidSum = 0, weakSum = 0;
  const rescuedRows = [], lostRows = [];
  // 要判"负例凭什么够格", 光比 conf 没用 —— conf 是 segCov×disc, 得看是哪个因子在虚高。
  const ansSeg = [], ansDisc = [], negSeg = [], negDisc = [];
  const { tokenize } = require('../core/memory');
  const pctl = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);

  for (const item of qs) {
    for (const key of ['q1', 'q2']) {
      const q = item[key];
      if (!q) continue;
      total++;
      const want = slugToId.get(item.id);
      const { solid, weak } = deliver(g, q);
      solidSum += solid.length; weakSum += weak.length;
      const av = g._flatScores(g._fresh(), tokenize(q)).get(want);
      if (av) { ansSeg.push(av.segCov || 0); ansDisc.push(av.disc || 0); }
      if (solid.some((r) => r.id === want)) inSolid++;
      else if (weak.some((r) => r.id === want)) {
        rescued++;
        rescuedRows.push(`    ${key} ${item.id} (把握度 ${weak.find((r) => r.id === want).confidence})`);
      } else {
        lost++;
        lostRows.push(`    ${key} ${item.id}`);
      }
    }
  }

  const p = (n) => `${(n / total * 100).toFixed(1)}%`;
  console.log(`=== 正例 ${total} 条 ===`);
  console.log(`  够格段命中     ${inSolid}  ${p(inSolid)}   ← 现行行为(闭嘴线之上)`);
  console.log(`  🔴 兜底救回     ${rescued}  ${p(rescued)}   ← 兜底带来的净增益`);
  console.log(`  仍然丢失       ${lost}  ${p(lost)}   ← 兜底也救不了(压根没进候选)`);
  console.log(`  ─────────────────────`);
  console.log(`  兜底后总召回   ${inSolid + rescued}  ${p(inSolid + rescued)}`);
  if (rescuedRows.length) console.log(`\n  救回的:\n${rescuedRows.join('\n')}`);
  if (lostRows.length) console.log(`\n  仍丢失的:\n${lostRows.join('\n')}`);
  console.log(`\n  平均每次交付: 够格 ${(solidSum / total).toFixed(1)} 条 + 兜底 ${(weakSum / total).toFixed(1)} 条`);

  // 负例才是兜底的代价所在。英文负例零候选 = 兜底免费; 中文负例有候选 = 要单独量。
  const negFile = NEG || path.join(path.dirname(QUERIES), 'negatives.json');
  let negs = [];
  if (fs.existsSync(negFile)) {
    try { negs = JSON.parse(fs.readFileSync(negFile, 'utf8')); } catch { negs = []; }
  }
  if (!Array.isArray(negs) || !negs.length) {
    negs = ['番茄炒蛋怎么做才嫩滑 要不要放糖', '量子纠缠 贝尔不等式 实验验证',
            '柴犬幼犬疫苗 打第几针 间隔多久', '房贷提前还款 等额本息 划不划算',
            '莫奈 睡莲 哪个美术馆收藏', '滑雪板 单板 双板 新手选哪个',
            '钢琴考级 车尔尼 练到几号', '高血压 低钠盐 有没有用'];
  }
  negs = negs.map((n) => (typeof n === 'string' ? n : n.q)).filter(Boolean);

  let negSolid = 0, negWeak = 0, negSilent = 0;
  for (const q of negs) {
    const { solid, weak } = deliver(g, q);
    negSolid += solid.length; negWeak += weak.length;
    if (!solid.length && !weak.length) negSilent++;
    // 负例凭什么够格, 只能看拆解 —— conf = segCov × disc, 光看合成分推不出是哪个因子在虚高
    const sc = g._flatScores(g._fresh(), tokenize(q));
    for (const r of solid) {
      const v = sc.get(r.id) || {};
      negSeg.push(v.segCov || 0); negDisc.push(v.disc || 0);
    }
    if (process.env.DEBUG_NEG && solid.length) {
      console.log(`\n  ← ${q}`);
      for (const r of solid.slice(0, 3)) {
        const v = sc.get(r.id) || {};
        console.log(`     ${r.confidence}  segCov=${(v.segCov || 0).toFixed(3)} disc=${(v.disc || 0).toFixed(3)}`
          + ` via=${r.via}  ${r.slug}`);
      }
    }
  }
  console.log(`\n=== 负例 ${negs.length} 条(库里真没有) —— 这是兜底的代价 ===`);
  console.log(`  平均塞给 AI: 够格 ${(negSolid / negs.length).toFixed(1)} 条 + 兜底 ${(negWeak / negs.length).toFixed(1)} 条`);
  console.log(`  完全闭嘴(明说库里没有): ${negSilent}/${negs.length}`);
  console.log(`  → 兜底代价 = 每次多扫 ${(negWeak / negs.length).toFixed(1)} 行命题`);

  // 🔴 两个因子分开看。如果负例的 disc 和正例一样高(碰巧撞上稀有 gram 就能满分),
  // 那能分开两堆的只剩 segCov —— 也就是"你问的几个概念这条讲到了几个"。
  const row = (n, a) => `  ${n}  p10=${pctl(a, .1).toFixed(3)} 中位=${pctl(a, .5).toFixed(3)} p90=${pctl(a, .9).toFixed(3)}`;
  console.log(`\n=== 两个因子谁分得开(正例 ${ansSeg.length} · 负例够格条目 ${negSeg.length}) ===`);
  console.log(row('正例 segCov', ansSeg));
  console.log(row('负例 segCov', negSeg));
  console.log(row('正例 disc  ', ansDisc));
  console.log(row('负例 disc  ', negDisc));
}

main();
// 显式退出: 打开的 sqlite 句柄会让事件循环空转不退, 串行跑多套语料时后一套永远轮不上
// (表现是"前一套结果都打完了, 进程还挂着 0% CPU")。
process.exit(0);
