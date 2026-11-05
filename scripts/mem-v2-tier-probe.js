// mem-v2-tier-probe.js — 选把握度的公式。tier-lab 量的是"阈值切哪里", 这个量的是"用什么当把握度"。
//
// 直接调引擎内部的 _flatScores 拿中间量(cov / disc), 不让这些量污染对外输出。
// 判据只有一个: 哪种组合能把【正例的正确答案】和【负例的头名】分开。分不开的公式, 阈值定在哪都没用。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const CORPUS = process.env.CORPUS || '/tmp/zh-mem-lab/memory';
const QUERIES = process.env.QUERIES || '/tmp/zh-mem-lab/queries.json';
const LAB = path.join(os.tmpdir(), 'mem-v2-tier-probe');

const { MemoryGraphV2 } = require('../core/memory-v2');
const { tokenize } = require('../core/memory');

function parseMd(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^\s*(\w[\w_]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    if (fm[kv[1]] === undefined) fm[kv[1]] = v;
  }
  return { fm, body: m[2] };
}

function build() {
  fs.rmSync(LAB, { recursive: true, force: true });
  fs.mkdirSync(LAB, { recursive: true });
  const g = new MemoryGraphV2(LAB);
  const files = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  const slugToId = new Map();
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
    }
  });
  return { g, slugToId };
}

const FORMULAS = {
  'cov            ': (v) => v.cov,
  'disc           ': (v) => v.disc,
  'segCov         ': (v) => v.segCov,
  'segCov*disc    ': (v) => v.segCov * v.disc,
  'sqrt(segCov*cov)': (v) => Math.sqrt(v.segCov * v.cov),
  'segCov^2       ': (v) => v.segCov * v.segCov,
  '0.7seg+0.3cov  ': (v) => 0.7 * v.segCov + 0.3 * v.cov,
};

const OFF = [
  '番茄炒蛋怎么做才嫩滑 要不要放糖',
  '量子纠缠 贝尔不等式 实验验证',
  '柴犬幼犬疫苗 打第几针 间隔多久',
  '房贷提前还款 等额本息 划不划算',
  '莫奈 睡莲 哪个美术馆收藏',
  '滑雪板 单板 双板 新手选哪个',
  '钢琴考级 车尔尼 练到几号',
  '高血压 低钠盐 有没有用',
  '今天天气怎么样 要不要带伞',
  '这个怎么弄一下 有没有办法',
];

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function main() {
  const { g, slugToId } = build();
  const idx = g._fresh();
  const qs = JSON.parse(fs.readFileSync(QUERIES, 'utf8'));

  const scoreAll = (q) => g._flatScores(idx, tokenize(q));

  // 正例: 每条查询里【正确答案那条】的中间量
  const pos = [];
  for (const item of qs) {
    for (const key of ['q1', 'q2']) {
      if (!item[key]) continue;
      const all = scoreAll(item[key]);
      const want = slugToId.get(item.id);
      const v = all.get(want);
      if (v) pos.push(v);
    }
  }
  // 负例: 每条无关查询里【得分最高那条】的中间量 —— 闭嘴要挡的就是它
  const neg = [];
  for (const q of OFF) {
    const all = scoreAll(q);
    let best = null;
    for (const v of all.values()) if (!best || v.combined > best.combined) best = v;
    if (best) neg.push(best);
  }

  console.log(`正例 ${pos.length} 条 · 负例 ${neg.length} 条\n`);
  console.log('公式             正例p10   正例中位  负例中位  负例max   分离(正例p10 - 负例max)');
  for (const [name, f] of Object.entries(FORMULAS)) {
    const P = pos.map(f), N = neg.map(f);
    const gap = pct(P, 0.1) - pct(N, 0.999);
    console.log(`${name}  ${pct(P, 0.1).toFixed(3)}    ${pct(P, 0.5).toFixed(3)}    ` +
                `${pct(N, 0.5).toFixed(3)}    ${pct(N, 0.999).toFixed(3)}    ${gap >= 0 ? '✅' : '❌'} ${gap.toFixed(3)}`);
  }

  // 最优公式下再看逐阈值表现
  console.log('\n各公式最佳切点(负例全挡住的前提下, 正例能留多少):');
  for (const [name, f] of Object.entries(FORMULAS)) {
    const P = pos.map(f), N = neg.map(f);
    const t = pct(N, 0.999) + 1e-6;
    const keep = P.filter((x) => x >= t).length / (P.length || 1);
    console.log(`${name}  切点 ${t.toFixed(3)} → 正例留存 ${(keep * 100).toFixed(1)}%`);
  }
  g.close();
}

main();
