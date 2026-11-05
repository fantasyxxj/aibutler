// mem-v2-tier-lab.js — 量三分档的两个切点, 不拍脑袋。
//
// 做法: 拿冻结语料(/tmp/zh-mem-lab/memory 895 条 md)机械灌进一个临时 v2 库, 跑 12 条查询
// × 2 种问法(长句 / 短词), 每条查询都有手写的正确答案。然后看:
//   正确答案那条的把握度分布  vs  同一次查询里其它条目的把握度分布
// 两堆分开得越干净, 阈值就越好定。切点取"答案很少掉到它下面, 而杂项大多在它下面"的位置。
//
// ⚠️ 这里的灌库是 lab 用的机械搬运(claim 暂用 description 兜底), **不是迁移器**。
// 迁移器要做起点探测/命题生成/对账回滚, 那是另一件事, 且作者定了最后开发。
// 这里只需要"形状对"的语料来量分布。

const fs = require('fs');
const path = require('path');
const os = require('os');

const CORPUS = process.env.CORPUS || '/tmp/zh-mem-lab/memory';
const QUERIES = process.env.QUERIES || '/tmp/zh-mem-lab/queries.json';
const LAB = path.join(os.tmpdir(), 'mem-v2-tier-lab');

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
      const claim = (fm.description || fm.name || slug).slice(0, 2000);
      const id = g.store.upsertNode({
        slug, title: fm.name || slug, claim, keywords: '', body,
        type: fm.type || '', importance: fm.importance === 'pinned' ? 'high' : (fm.importance || 'med'),
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

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function main() {
  const { g, slugToId } = build();
  console.log(`语料 ${Object.keys(g.store.allNodes()).length} 节点 / ${g.store.allEdges().length} 边`);

  const qs = JSON.parse(fs.readFileSync(QUERIES, 'utf8'));
  const answerConf = [];      // 正确答案那条的把握度
  const otherConf = [];       // 同次查询里其它条目的把握度
  const rows = [];
  let answerMissing = 0;

  for (const item of qs) {
    for (const key of ['q1', 'q2']) {
      const q = item[key];
      if (!q) continue;
      // minTier:'low' = 本次不过滤, 因为要看的正是【被过滤那部分长什么样】
      const res = g.query(q, { k: 20, minTier: 'low', semantic: false });
      const want = slugToId.get(item.id);
      const hit = res.find((r) => r.id === want);
      if (hit) answerConf.push(hit.confidence); else answerMissing++;
      for (const r of res) if (r.id !== want) otherConf.push(r.confidence);
      rows.push({ q: key, id: item.id, rank: hit ? res.indexOf(hit) + 1 : 0,
                  conf: hit ? hit.confidence : null,
                  top: res[0] ? res[0].confidence : 0 });
    }
  }

  console.log('\n每条查询: 正确答案的名次与把握度');
  for (const r of rows) {
    console.log(`  ${r.q}  #${r.rank || '未召回'}  conf=${r.conf == null ? '-' : r.conf.toFixed(3)}  (本次最高 ${r.top.toFixed(3)})  ${r.id}`);
  }

  console.log(`\n正确答案 ${answerConf.length} 条(${answerMissing} 条没召回) · 其它条目 ${otherConf.length} 条`);
  const show = (name, a) => console.log(
    `  ${name}: min=${pct(a, 0).toFixed(3)} p10=${pct(a, 0.1).toFixed(3)} p25=${pct(a, 0.25).toFixed(3)} ` +
    `中位=${pct(a, 0.5).toFixed(3)} p75=${pct(a, 0.75).toFixed(3)} p90=${pct(a, 0.9).toFixed(3)} max=${pct(a, 0.999).toFixed(3)}`);
  show('答案 ', answerConf);
  show('杂项 ', otherConf);

  console.log('\n候选切点: 每个阈值下, 答案留下几成 / 杂项砍掉几成');
  for (const t of [0.02, 0.03, 0.05, 0.08, 0.10, 0.12, 0.15, 0.20, 0.25, 0.30, 0.34, 0.40, 0.50]) {
    const keepA = answerConf.filter((x) => x >= t).length / (answerConf.length || 1);
    const cutO = otherConf.filter((x) => x < t).length / (otherConf.length || 1);
    console.log(`  ${t.toFixed(2)}  答案留存 ${(keepA * 100).toFixed(1)}%   杂项砍掉 ${(cutO * 100).toFixed(1)}%`);
  }

  // 🔴 负例才是闭嘴要挡的东西。上面那半只能回答"别砍掉答案", 回答不了"什么时候该一条都不给" ——
  // 库里根本没有的话题, 现在引擎照样用热度和正文 LIKE 凑满 k 条端上来。
  const OFF = [
    '番茄炒蛋怎么做才嫩滑 要不要放糖',
    '量子纠缠 贝尔不等式 实验验证',
    '柴犬幼犬疫苗 打第几针 间隔多久',
    '房贷提前还款 等额本息 划不划算',
    '莫奈 睡莲 哪个美术馆收藏',
    '滑雪板 单板 双板 新手选哪个',
    '钢琴考级 车尔尼 练到几号',
    '高血压 低钠盐 有没有用',
  ];
  console.log('\n负例(库里没有这些): 本次最高把握度');
  const offTop = [];
  for (const q of OFF) {
    const res = g.query(q, { k: 8, minTier: 'low', semantic: false });
    const top = res[0] ? res[0].confidence : 0;
    offTop.push(top);
    console.log(`  ${top.toFixed(3)}  ${res.length} 条  ${res[0] ? res[0].slug : '(空)'}  ← ${q}`);
  }
  const ansTop = rows.map((r) => r.top);
  console.log(`\n  负例最高分: 中位=${pct(offTop, 0.5).toFixed(3)} p90=${pct(offTop, 0.9).toFixed(3)} max=${pct(offTop, 0.999).toFixed(3)}`);
  console.log(`  正例最高分: min=${pct(ansTop, 0).toFixed(3)} p10=${pct(ansTop, 0.1).toFixed(3)} 中位=${pct(ansTop, 0.5).toFixed(3)}`);
  console.log('\n整批闭嘴线(top1 低于它就一条都不给): 正例误伤 / 负例挡住');
  for (const t of [0.010, 0.015, 0.020, 0.025, 0.030, 0.040, 0.050]) {
    const bad = ansTop.filter((x) => x < t).length;
    const blocked = offTop.filter((x) => x < t).length;
    console.log(`  ${t.toFixed(3)}  正例被误闭嘴 ${bad}/${ansTop.length}   负例正确闭嘴 ${blocked}/${offTop.length}`);
  }

  // —— 端到端: 用引擎现行默认(minTier='med')再跑一遍, 看真实交付形状 ——
  const { TIER_HI, TIER_MID } = require('../core/memory-v2');
  console.log(`\n=== 端到端(默认档 minTier=med · 高档线 ${TIER_HI} · 闭嘴线 ${TIER_MID}) ===`);
  let lost = 0, kept = 0, hiN = 0, medN = 0, totalOut = 0;
  for (const item of qs) {
    for (const key of ['q1', 'q2']) {
      if (!item[key]) continue;
      const res = g.query(item[key], { k: 8, semantic: false });
      const want = slugToId.get(item.id);
      const hit = res.find((r) => r.id === want);
      if (hit) { kept++; if (hit.tier === 'high') hiN++; else medN++; } else lost++;
      totalOut += res.length;
    }
  }
  console.log(`  正确答案: 留下 ${kept}(高档 ${hiN} / 中档 ${medN}) · 被闭嘴掉 ${lost}`);
  console.log(`  平均每次交付 ${(totalOut / rows.length).toFixed(1)} 条(原先恒定给满 8 条)`);
  let offOut = 0, offHi = 0, offEmpty = 0;
  for (const q of OFF) {
    const res = g.query(q, { k: 8, semantic: false });
    offOut += res.length;
    offHi += res.filter((r) => r.tier === 'high').length;
    if (!res.length) offEmpty++;
  }
  console.log(`  负例: 平均交付 ${(offOut / OFF.length).toFixed(1)} 条 · 其中高档 ${offHi} 条 · 完全闭嘴 ${offEmpty}/${OFF.length} 次`);
  g.close();
}

main();
