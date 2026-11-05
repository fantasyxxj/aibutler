// scripts/en-lab-build.js — 把 JSON 语料铺成一个独立的英文记忆库(沙箱, 与任何真实记忆无关)。
// 用途: 量「英语场景下语义检索 vs 关键词检索」。中文那次的结论(语义净亏)不能直接外推到英语 ——
// 英语有词形变化和同义替换, 关键词那条路本来就该漏。
const fs = require('fs');
const path = require('path');

const GEN = '/tmp/en-mem-lab/gen';
const DIR = '/tmp/en-mem-lab/memory';

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const files = fs.readdirSync(GEN).filter((f) => f.endsWith('.json') && f !== 'queries.json');
const seen = new Set();
let n = 0;
for (const f of files) {
  let arr;
  try { arr = JSON.parse(fs.readFileSync(path.join(GEN, f), 'utf8')); } catch (e) {
    console.error('SKIP(bad json)', f, String(e).slice(0, 80)); continue;
  }
  for (const e of arr) {
    const id = String(e.id || '').trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const fm = [
      '---',
      `name: ${JSON.stringify(e.title || id)}`,
      `description: ${JSON.stringify(e.description || '')}`,
      `type: ${e.type || 'reference'}`,
      `importance: ${e.importance || 'med'}`,
      'created: 2026-05-01',
      'last_used: 2026-05-01',
      'use_count: 1',
      'status: active',
      '---',
      '',
      String(e.body || ''),
      '',
    ].join('\n');
    fs.writeFileSync(path.join(DIR, `${id}.md`), fm);
    n++;
  }
}
console.log(`BUILT ${n} nodes from ${files.length} pools -> ${DIR}`);
