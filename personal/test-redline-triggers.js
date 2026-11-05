'use strict';
// 红线触发模式门禁 —— 守的是「一条红线立得住吗」, 不是它拦得对不对。
//
// 为什么非有不可: trigger_pattern 写错是【静默】的 —— parseTrigger 返回 null,
// 动作侧和输出侧双双 continue, 红线安静地永不生效, 不报错不告警。
// 2026-08-26 实测库里三条红线全是这么死的(两条写 `memory_upsert` 漏了冒号,
// 一条直接写中文句子)。比没有红线更坏: 以为程序兜着, 于是不再自己留神。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { matchRedlines, validateTrigger, parseTrigger } = require('../core/redline-guard');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS', msg); } else { fail++; console.log('  FAIL', msg); } };

function redlinesOf(packPath) {
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    // redline:{off:true} 是撤下的红线(factory-sync 据此从装机端摘掉), 不算在表里
    if (o.slug && o.redline && !o.redline.off) out.push({ node_id: o.slug, slug: o.slug, ...o.redline });
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(JSON.parse(fs.readFileSync(packPath, 'utf8')));
  return out;
}

console.log('=== 出厂包里每一条红线都必须立得住 ===');
// 出厂包只有一份(core/config)。个人版没有独有配置层, 两版共用这份, 行业版靠 industry/config 覆盖。
const packs = [
  path.join(__dirname, '../core/config/onboarding/knowledge/leaf_core.json'),
];
for (const p of packs) {
  if (!fs.existsSync(p)) continue;
  const rls = redlinesOf(p);
  ok(rls.length > 0, `${path.basename(path.dirname(path.dirname(path.dirname(p))))} 包里有红线 (${rls.length} 条)`);
  for (const r of rls) {
    const v = validateTrigger(r.trigger_pattern);
    ok(v.ok, `  ${r.slug} 触发模式可解析${v.ok ? '' : ' —— ' + v.reason}`);
    ok(!!String(r.correct_action || '').trim(), `  ${r.slug} 填了正确做法`);
  }
}

console.log('=== 包里不许有悬空边 ===');
// 改一个 slug 而漏改指向它的 edges.to, 会留下连不到东西的边 —— 静默, 只有翻库才看得见。
for (const p of packs) {
  if (!fs.existsSync(p)) continue;
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const slugs = new Set(); const edges = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (o.slug && o.claim) slugs.add(o.slug);
    if (Array.isArray(o.edges)) for (const e of o.edges) if (e && e.to) edges.push([o.slug, e.to]);
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(d);
  const dangling = edges.filter(([, to]) => !slugs.has(to));
  const tag = p.includes('/core/') ? 'core' : 'personal';
  ok(dangling.length === 0,
    `${tag} 包无悬空边 (节点 ${slugs.size} · 边 ${edges.length})` +
    (dangling.length ? ` —— ${dangling.length} 条: ` + dangling.map(([a, b]) => `${a}→${b}`).join(' , ') : ''));
}

console.log('=== 两版出厂包必须同源 ===');
// 作者 2026-08-27 定: 「出厂记忆我们都一个版本, 都装进去。只是行业版的我们的行业知识加一条,
// 暂时不对他开放开发能力而已」—— 两版差异走【功能闸】, 不靠从知识包里抽条目。
// 这道闸是补的: 2026-08-26 一天之内漏了两次(今天新加的两条 + 更早那批配色三条全只进了 personal),
// 后果是 core 里一条"你可以自己写插件"链向三个不存在的配色规矩 —— 静默, 只有翻库才看得见。
if (fs.existsSync(packs[0]) && fs.existsSync(packs[1])) {
  const idx = (p) => {
    const m = new Map();
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      if (o.slug && o.claim) m.set(o.slug, o.claim);
      for (const k of Object.keys(o)) walk(o[k]);
    };
    walk(JSON.parse(fs.readFileSync(p, 'utf8')));
    return m;
  };
  const pm = idx(packs[0]); const cm = idx(packs[1]);
  const onlyP = [...pm.keys()].filter((s) => !cm.has(s));
  const onlyC = [...cm.keys()].filter((s) => !pm.has(s));
  const diff = [...pm.keys()].filter((s) => cm.has(s) && cm.get(s) !== pm.get(s));
  ok(onlyP.length === 0, `personal 没有 core 缺的条目${onlyP.length ? ' —— 缺: ' + onlyP.join(' , ') : ''}`);
  ok(onlyC.length === 0, `core 没有 personal 缺的条目${onlyC.length ? ' —— 缺: ' + onlyC.join(' , ') : ''}`);
  ok(diff.length === 0, `同名条目命题一致${diff.length ? ' —— 不一致: ' + diff.join(' , ') : ''}`);
}

console.log('=== 校验器自己 ===');
ok(!validateTrigger('memory_upsert').ok, '漏冒号 → 拒(这就是历史上那三条死掉的写法)');
ok(!validateTrigger('要给用户回话/发消息之前').ok, '写成自然语言 → 拒');
// 🔴 写错和不写是两回事: 写错的人以为自己写对了, 不写的人知道自己没写。
// 不是所有命题都能正则表达(违反形态是"遗漏"的那类根本没有可匹配的动作),
// 拿"能不能正则"去否决一条命题就是让机制阉割内容 —— 所以留空照收, 只是如实说明程序不拦。
const empty = validateTrigger('');
ok(empty.ok && empty.enforced === false, '空 → 收, 但 enforced=false(只标严重性, 程序不拦)');
ok(/程序拦不住/.test(empty.reason || ''), '空的时候要把"拦不住"这句话说出来, 不许静默');
ok(validateTrigger('Bash:x').enforced === true, '合法模式 → enforced=true');
ok(!validateTrigger('Bash:').ok, '冒号后为空 → 拒');
ok(!validateTrigger('Bash:[').ok, '正则语法错 → 拒');
ok(validateTrigger('Bash:\\brm\\s+-rf').ok, '合法动作侧 → 收');
ok(validateTrigger('output:我是 Claude').ok, '合法输出侧 → 收');
ok(validateTrigger('*:secret').ok, '通配工具 → 收');

console.log('=== 拦该拦的, 放该放的 ===');
const RL = redlinesOf(packs[0]);
const hit = (n, i) => matchRedlines(RL, n, i).map((r) => r.slug);
// 10-14 撤下(4b99a5f): 工具本身已拒绝不带 base_hash 的整段覆盖, 每次写 body 都提醒只是噪音
ok(!hit('mcp__butler__memory_upsert', { id: 'x', body: 'hi' })
  .includes('feedback_upsert_is_partial_not_overwrite'), 'upsert 传 body → 不再提醒(这条红线已撤下)');
ok(hit('mcp__butler__memory_upsert', { id: 'x', claim: '新命题' }).length === 0,
  '🔴 只改 claim 不传 body → 不拦(这正是那条规矩的本意, 拦了就等于教反)');
ok(hit('mcp__butler__memory_upsert', { id: 'x', claim: 'c', links: 'foo bar' }).length === 0,
  'links 参数走的是正路 → 不拦');
ok(hit('mcp__butler__memory_upsert', { id: 'x', body: 'see [[foo]]' })
  .includes('feedback_no_parsable_double_brackets_in_memory_body'), '正文里写可解析双括号 → 提醒');
ok(hit('mcp__butler__memory_write', { node: 'x', content: 'see [[foo]]' })
  .includes('feedback_no_parsable_double_brackets_in_memory_body'), '段级写入同样守');
ok(hit('Bash', { command: 'ls' }).length === 0, '不相干的工具 → 不拦');

console.log('=== MCP 工具真名带前缀, 写裸名匹不到 ===');
const bare = [{ node_id: 1, slug: 'bare', trigger_pattern: 'memory_upsert:"body"', correct_action: 'x', level: 'warn' }];
ok(matchRedlines(bare, 'mcp__butler__memory_upsert', { body: 'hi' }).length === 0,
  '工具名写 memory_upsert 匹不到 mcp__butler__memory_upsert —— 立红线时必须写全名');

console.log(`\n${fail ? '❌' : '✅'} test-redline-triggers: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
