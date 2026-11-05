// test-code-index.js — 守住代码地图: 新增源文件必须在 CODE_INDEX.md 里登记。
//
// 为什么要门禁: CODE_INDEX.md 自己文件头就写着「新增/删除/重命名/职责变化 → 同步更新这里」,
// 而 2026-08-20 实测它只收录了 14 个文件 / 实际 50+ —— 那条铁律事实上没人执行, 于是索引烂到
// 不能用, 找文件只能全库 grep(作者 2026-08-20:「找任何一个东西, 都得所有的代码去扫描, 多笨啊」)。
//
// 靠自觉维护的索引一定会烂, 因为**漏登记不会报错**: 加了个文件不写进去, 当天什么事都不会发生,
// 只是三个月后没人知道那个文件是干嘛的。所以只能由门禁来管。
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

// CODE_INDEX.md 是**全仓**代码地图, 条目路径一律相对仓根(core/x.js · personal/x.js)。
const REPO = path.join(__dirname, '..');
const INDEX = path.join(REPO, 'CODE_INDEX.md');
const text = fs.readFileSync(INDEX, 'utf8');

// 表格里登记了哪些文件。一行可能并列多个(`a/b.js` / `c.js` / `d.js` —— 后几个省略了目录),
// 所以取整行的全部反引号条目, 不带 `/` 的按行内第一个条目的目录解析。
// 只抓第一个会把并列行的后几个judgment成"没登记", 逼人把合并行拆开写。
const listed = new Set();
for (const row of text.split('\n')) {
  if (!row.startsWith('|')) continue;
  const cells = row.split('|');
  const toks = [...(cells[1] || '').matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  if (!toks.length) continue;
  const base = toks[0].includes('/') ? path.posix.dirname(toks[0]) : '';
  for (const t of toks) listed.add(t.includes('/') || !base ? t : `${base}/${t}`);
}

// 实际有哪些源文件。递归扫下列根, 排除 test-*(门禁自己) 和 scripts/(一次性实验脚本, 不是产品代码)。
// 🔴 门禁覆盖范围必须与 CODE_INDEX 声称的范围一致 —— 靶子比声称范围小, 断言就恒真,
//    而空过的门禁比没有门禁更糟(它让人以为查过了)。2026-08-26 之前这里只有 personal/,
//    于是表里 64 条 core/ 条目从来没人验, 烂了也没人知道。
// 服务端 Python 两棵树(industry/platform · industry/biz)按子树登记不按文件, 故不在此列;
// 它们的文件级保鲜由 scripts/codemap-gate.js + 记忆图功能点节点负责。
const ROOTS = ['core', 'personal', 'industry/core', 'industry/app', 'industry/tools'];
// vendor/ 是原样搬进来的第三方库(onnxruntime-common · transformers), 不是我们的代码 —— 索引它没有意义,
// 而且它随上游升级整批换掉, 逼人同步会让门禁天天红。
const SKIP_DIRS = new Set(['node_modules', 'test', 'vendor', '.git']);
const actual = [];
const walk = (rel) => {
  let entries = [];
  try { entries = fs.readdirSync(path.join(REPO, rel), { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(`${rel}/${e.name}`);
      continue;
    }
    if (!e.name.endsWith('.js')) continue;
    if (e.name.startsWith('test-')) continue;
    actual.push(`${rel}/${e.name}`);
  }
};
for (const r of ROOTS) walk(r);

console.log(`\n[1] 每个源文件都登记了 (实际 ${actual.length} 个 · 表里 ${listed.size} 条)`);
{
  const missing = actual.filter((f) => !listed.has(f));
  ok(missing.length === 0,
     missing.length ? `这些文件没登记进 CODE_INDEX.md: ${missing.join(', ')}` : '一个不漏');
}

console.log('\n[2] 登记的文件都还在 (删了文件要顺手清掉那一行)');
{
  // 凡是带 `/` 的条目都当路径验(.js · .py · 以 `/` 结尾的子树行都要真存在), 不再只验 .js ——
  // 服务端两棵树按子树登记, 只验 .js 等于那些行改名/搬走了也没人管。
  // 不带 `/` 的裸名(package.json 之类)跳过: 无法判断它该在哪一层。
  const ghosts = [...listed].filter((f) => f.includes('/') && !fs.existsSync(path.join(REPO, f)));
  ok(ghosts.length === 0, ghosts.length ? `这些条目指向不存在的文件: ${ghosts.join(', ')}` : '没有幽灵条目');
}

console.log('\n[2.5] 配置文件也得登记');
{
  // 🔴 配置文件比 .js 更该守: 改错一个字不报错, 只是行为悄悄变了; 而改错【哪一份】连"文件不存在"
  //    这种提示都没有 —— 2026-08-27 踩过(两份同名 leaf_core.json, 改的是不生效的那份, 同步日志报"未变")。
  //    登记粒度是**目录**: 一行一个目录, 单元格里把该目录下的文件名列全。
  const CFG_ROOTS = ['core/config', 'industry/config'];
  const cfgFiles = [];
  const walkCfg = (rel) => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(REPO, rel), { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.isDirectory()) { walkCfg(`${rel}/${e.name}`); continue; }
      if (/\.(md|json)$/.test(e.name)) cfgFiles.push(`${rel}/${e.name}`);
    }
  };
  for (const r of CFG_ROOTS) walkCfg(r);

  const rows = text.split('\n').filter((l) => l.startsWith('|'));
  const covered = (f) => {
    const dir = path.posix.dirname(f), base = path.posix.basename(f);
    // 整条路径直接登记了, 或者所在目录登记了【且同一行列出了这个文件名】
    return rows.some((r) => r.includes(`\`${f}\``)
      || ((r.includes(`\`${dir}/\``) || r.includes(`\`${dir}\``)) && r.includes(base)));
  };
  const missCfg = cfgFiles.filter((f) => !covered(f));
  ok(missCfg.length === 0,
     missCfg.length ? `这些配置文件没登记(共 ${missCfg.length}): ${missCfg.slice(0, 10).join(', ')}${missCfg.length > 10 ? ' …' : ''}`
                    : `配置文件一个不漏 (${cfgFiles.length} 个)`);
}

console.log('\n[3] 超 500 行的都标了 🔺');
// 铁律是"单文件 ≤500 行, 超出按职责拆分"。现实是有 8 个已经超了。
// 门禁不拦超行(那会一上来就红成一片), 但要求**标出来** —— 欠账可以欠, 不能装作没有。
{
  const unmarked = [];
  for (const f of actual) {
    const n = fs.readFileSync(path.join(REPO, f), 'utf8').split('\n').length;
    if (n <= 500) continue;
    const row = text.split('\n').find((l) => l.startsWith(`| \`${f}\``));
    if (row && !row.includes('🔺')) unmarked.push(`${f}(${n}行)`);
  }
  ok(unmarked.length === 0, unmarked.length ? `超 500 行却没标 🔺: ${unmarked.join(', ')}` : '欠的账都摆在明处');
}

console.log(`\n${fail ? '❌' : '✅'} test-code-index: ${pass} 过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
