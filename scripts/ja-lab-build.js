// scripts/ja-lab-build.js — 用行业版餐饮教育包搭一个【日文】记忆库 + 查询集。
//
// 为什么用它: 日文语料一直是空白, 而"装了语义模型日文会不会掉"必须有实测。
// 这份教育包是现成的真日文内容(61 条)且自带 问句→期望id 的测试集(173 句), 不用我造题 ——
// 我自己造日文题会不自觉地把节点里的词抄进问句, 那是泄题。
const fs = require('fs');
const path = require('path');

const SRC = process.env.KNOWLEDGE_DIR || '';
const OUT = '/tmp/ja-mem-lab';
const PACKS = ['A_business_rules.md', 'B_customer_service_sop.md', 'C_banto_tools_playbook.md'];
const TESTS = ['tests/test_set_holdout.md', 'tests/test_set_holdout_v2.md', 'tests/test_set_customer_wording.md'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'memory'), { recursive: true });

// 一条知识 = 一个 yaml 头(```yaml ... ```) + 紧随其后到下一条之前的正文。
const nodes = [];
for (const p of PACKS) {
  const text = fs.readFileSync(path.join(SRC, p), 'utf8');
  const parts = text.split(/^```yaml$/m);
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const endFence = chunk.indexOf('```');
    if (endFence < 0) continue;
    const head = chunk.slice(0, endFence);
    const body = chunk.slice(endFence + 3).split(/^## /m)[0];   // 到下一条标题为止
    const id = (head.match(/^id:\s*(\S+)/m) || [])[1];
    const title = (head.match(/^title:\s*(.+)$/m) || [])[1];
    const tags = (head.match(/^tags:\s*\[(.*)\]/m) || [])[1] || '';
    if (!id || !title) continue;
    nodes.push({ id, title: title.trim(), tags: tags.trim(), body: body.trim() });
  }
}

// description 用 title + tags: 与真记忆库的形状对齐(向量只喂 description, 见 VECTOR_TAG 那段)。
for (const n of nodes) {
  const desc = `${n.title}${n.tags ? ' · ' + n.tags.replace(/,/g, ' ') : ''}`.replace(/"/g, "'");
  fs.writeFileSync(path.join(OUT, 'memory', `${n.id}.md`),
    `---\nname: ${n.title.replace(/\n/g, ' ')}\ndescription: "${desc}"\nmetadata:\n  type: reference\n  use_count: 1\n---\n${n.body}\n`);
}

// 查询集: 只留【期望 id 真的在库里】的行, 并按文字把日文挑出来 —— 测试集是日中英混编的。
const ids = new Set(nodes.map((n) => n.id));
const seen = new Set();
const rows = [];
for (const t of TESTS) {
  for (const line of fs.readFileSync(path.join(SRC, t), 'utf8').split('\n')) {
    const m = line.match(/^(.+?)\s*→\s*(rest_\S+)\s*$/);
    if (!m) continue;
    const q = m[1].trim(), id = m[2].trim();
    if (!ids.has(id)) continue;                       // 期望 id 已不存在(教育包改过) → 这题作废
    const key = q + '|' + id;
    if (seen.has(key)) continue;                      // 三份测试集之间有重复句
    seen.add(key);
    const kana = (q.match(/[぀-ヿ]/g) || []).length;
    const han = (q.match(/[㐀-鿿]/g) || []).length;
    const latin = (q.match(/[A-Za-z]/g) || []).length;
    // 有假名 = 日文(汉字单独出现无法区分中日, 假名才是判据)
    rows.push({ id, q, lang: kana > 0 ? 'ja' : (han > 0 ? 'zh' : (latin > 0 ? 'en' : '?')) });
  }
}
const ja = rows.filter((r) => r.lang === 'ja');
// 与中英两个语料的格式对齐(q1/q2), 这里每条一句就只填 q1
fs.writeFileSync(path.join(OUT, 'queries.json'), JSON.stringify(ja.map((r) => ({ id: r.id, q1: r.q })), null, 1));

const byLang = rows.reduce((a, r) => ((a[r.lang] = (a[r.lang] || 0) + 1), a), {});
console.log('知识节点:', nodes.length, '| 测试句总数:', rows.length, '| 分语言:', JSON.stringify(byLang));
console.log('日文查询集已出:', path.join(OUT, 'queries.json'), '共', ja.length, '句');
console.log('覆盖到的节点数:', new Set(ja.map((r) => r.id)).size, '/', nodes.length);
