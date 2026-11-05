#!/usr/bin/env node
// 提交完立刻提示该更新哪个功能点节点, 把漂移限制在一次提交之内。
// 只提醒不拦截 —— 真正的拦截在下一次 pre-commit。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DB = process.env.CODEMAP_DB ||
  path.join(process.env.HOME, 'Program/app/.claude/memory/memory.v2.db');
if (!fs.existsSync(DB)) process.exit(0);

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim();
const sh = (a) => execFileSync('git', a, { cwd: REPO }).toString();
const head = sh(['rev-parse', '--short', 'HEAD']).trim();
const files = sh(['diff', '--name-only', 'HEAD~1', 'HEAD']).split('\n')
  .filter((f) => f && /\.(js|mjs|cjs|py|sql)$/.test(f));
if (!files.length) process.exit(0);

const raw = execFileSync('sqlite3', [DB,
  "SELECT slug || '\t' || body FROM nodes WHERE status='active' AND body LIKE '%<!--codemap%'"]).toString();
const toRe = (g) => new RegExp('^' + g.trim()
  .replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\*\*/g, ' ').replace(/\*/g, '[^/]*').replace(/ /g, '.*') + '$');

const hit = new Set();
for (const line of raw.split('\n')) {
  const tab = line.indexOf('\t');
  if (tab < 0) continue;
  const m = /<!--codemap\s+owns=(\S+)\s+synced=(\w+)\s*-->/.exec(line.slice(tab + 1));
  if (!m) continue;
  const globs = m[1].split(',');
  if (files.some((f) => globs.some((g) => toRe(g).test(f))) && m[2] !== head) {
    hit.add(line.slice(0, tab));
  }
}
if (!hit.size) process.exit(0);

console.log('\ncodemap: 这次提交动了下面这些功能点, 现在更新节点并把 synced 改成 ' + head + ':');
for (const s of hit) console.log('  ' + s);
console.log('  (不更新的话, 下次碰同一批文件的提交会被 pre-commit 拦住)\n');
