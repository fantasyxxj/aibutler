#!/usr/bin/env node
// mem-v2-dropin-test.js — 验证 MemoryGraphV2 能【原样顶替】v1 实例。
// 用法: node scripts/mem-v2-dropin-test.js
//
// 为什么单测这件事: agent.js / main.js / persona.js / birth.js 会直接调引擎上的方法,
// 这些调用不经过 MCP 工具层。少一个方法, 前面所有测试照样全绿, 而 dev 一起来就崩 ——
// 失败点还会离真正的原因很远(报在某个 wake 流程里)。所以按【调用点清单】逐个点名。

const fs = require('fs');
const path = require('path');
const { MemoryGraph } = require('../core/memory');
const { MemoryGraphV2 } = require('../core/memory-v2');

const DIR = '/tmp/mem-v2-dropin-test';
fs.rmSync(DIR, { recursive: true, force: true });

const results = [];
const t = (name, fn) => {
  try { const d = fn(); results.push({ ok: true, name, detail: d || '' }); }
  catch (e) { results.push({ ok: false, name, detail: e.message }); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

// 从代码里实际 grep 出来的调用点, 不是凭印象列的。
const CALLED_BY_HOST = [
  'ensureReady', 'hot', 'recent', 'pinnedAll', 'touch', 'query', 'upsert', 'append',
  'neighbors', 'timeline', 'doctor', 'setImportance', 'linkBidirectional',
  'conflictCandidates', 'conflictSettle', 'conflictScanDue', 'conflictMarkScanned',
  'revisions', 'hasNode', 'queryWithSuspects', 'prepareSemantic', 'queryAsync',
  'setEmbedder', 'hasEmbedder', 'kickEmbed', 'embedPending', 'embedStats',
  'markSemanticOptIn', 'semanticOptedIn', 'semanticFusionOn', 'setSemanticFusion',
];

t('宿主会调的方法, v2 一个不少', () => {
  const g = new MemoryGraphV2(DIR);
  const missing = CALLED_BY_HOST.filter((m) => typeof g[m] !== 'function');
  g.close();
  assert(!missing.length, `v2 缺: ${missing.join(', ')}`);
  return `${CALLED_BY_HOST.length} 个方法齐`;
});

t('v1 也有这些方法(说明清单没写错)', () => {
  const g = new MemoryGraph('/tmp/mem-v1-probe');
  const missing = CALLED_BY_HOST.filter((m) => typeof g[m] !== 'function');
  fs.rmSync('/tmp/mem-v1-probe', { recursive: true, force: true });
  // v1 没有 setEmbedModel 之类 v2 新增的, 反过来 v1 独有的也不该出现在清单里
  assert(!missing.length, `清单里有 v1 也没有的方法(说明我列错了): ${missing.join(', ')}`);
  return '清单已用 v1 反证';
});

// 行业版(industry-butler)的宿主调用点。内核统一后 v2 要同时顶住两个宿主, 所以两份清单都得过。
// butler v1 没有 originOf(那是行业版长出来的), 故这份不做"v1 反证"。
const CALLED_BY_INDUSTRY_HOST = [
  'build', 'query', 'queryWithSuspects', 'neighbors', 'touch', 'hasNode', 'originOf',
  'hot', 'pinnedAll', 'pinnedAudit', 'recent', 'timeline', 'doctor', 'revisions',
  'upsert', 'append', 'linkBidirectional', 'zombies',
];

t('行业版宿主会调的方法, v2 一个不少', () => {
  const g = new MemoryGraphV2(DIR);
  const missing = CALLED_BY_INDUSTRY_HOST.filter((m) => typeof g[m] !== 'function');
  g.close();
  assert(!missing.length, `v2 缺: ${missing.join(', ')}`);
  return `${CALLED_BY_INDUSTRY_HOST.length} 个方法齐`;
});

t('originOf: 无此节点 null · 缺省 local · 平台下发 platform', () => {
  const g = new MemoryGraphV2(DIR);
  assert(g.originOf('ref_不存在的东西') === null, '不存在的节点该返回 null');
  g.upsert({ slug: 'ref_自己长的', title: '本地', type: 'reference', claim: '命题: 人格自己写的东西缺省算本地' });
  assert(g.originOf('ref_自己长的') === 'local', '没传 provenance 该缺省 local');
  g.upsert({ slug: 'ref_平台下发的', title: '平台', type: 'reference', provenance: 'platform',
             claim: '命题: 教育包灌进来的知识标 platform' });
  assert(g.originOf('ref_平台下发的') === 'platform', '传了 platform 该存住');
  g.close();
  return '三态都对';
});

t('🔴 平台知识被改写即降级 override(否则升级会冲掉店里的经验)', () => {
  const g = new MemoryGraphV2(DIR);
  // 人格自己改平台那条: 没传 provenance, 引擎该自动把它踢出下发批次
  g.upsert({ slug: 'ref_平台下发的', body: '店里改写过的正文' });
  assert(g.originOf('ref_平台下发的') === 'override', `平台节点被改写后该是 override, 实际 ${g.originOf('ref_平台下发的')}`);
  // 反过来: 本地节点再 upsert 不该被这条逻辑碰到, 也不该被清空
  g.upsert({ slug: 'ref_自己长的', body: '又改了一次' });
  assert(g.originOf('ref_自己长的') === 'local', 'local 节点不该被动到');
  // 教育包重新下发时显式传 platform, 该能覆盖回去
  g.upsert({ slug: 'ref_自己长的', provenance: 'platform' });
  assert(g.originOf('ref_自己长的') === 'platform', '显式传值该压过自动判定');
  g.close();
  return 'platform→override 自动, local 不受影响, 显式传值优先';
});

// 工具注册了 ≠ AI 调得动: SDK 还要工具名出现在 allowedTools 白名单里。这两层分别在
// memory-tools-v2.js 和宿主的白名单常量里, 谁也不认识谁 —— 加了工具忘了加白名单, 前面
// 所有工具测试照样全绿, 而人格实际调用时报"工具不存在"。所以按名字对一遍。
t('🔴 v2 每个工具都在宿主白名单里(注册 ≠ 放行)', () => {
  const toolSrc = fs.readFileSync(path.join(__dirname, '..', 'memory-tools-v2.js'), 'utf8');
  const names = [...new Set([...toolSrc.matchAll(/tool\(\s*'(memory_[a-z_]+)'/g)].map((m) => m[1]))];
  assert(names.length >= 19, `工具名没抓全, 只抓到 ${names.length} 个`);
  const hosts = [
    ['butler/agent.js', path.join(__dirname, '..', 'agent.js')],
    ['行业版/core/agent-core.js', path.join(__dirname, '..', '..', 'industry-butler', 'core', 'agent-core.js')],
  ];
  const bad = [];
  for (const [label, p] of hosts) {
    if (!fs.existsSync(p)) continue;            // 只装了 butler 的机器上跳过行业版
    const src = fs.readFileSync(p, 'utf8');
    const miss = names.filter((n) => !src.includes(`mcp__butler__${n}`));
    if (miss.length) bad.push(`${label} 缺 ${miss.join('/')}`);
  }
  assert(!bad.length, bad.join(' · '));
  return `${names.length} 个工具, 宿主白名单齐`;
});

t('无 embedder 时语义链路静默降级, 不抛错', async () => {
  const g = new MemoryGraphV2(DIR);
  g.upsert({ slug: 'ref_smoke', title: '冒烟', type: 'reference', claim: '命题: 没有 embedder 也不该炸' });
  const release = await g.prepareSemantic('冒烟');
  release();
  g.kickEmbed();                       // 没 embedder 应直接返回而不是抛
  const s = g.embedStats();
  const r = g.query('冒烟', { semantic: true });
  g.close();
  assert(r.length === 1, '纯关键词路径应照常工作');
  assert(s.model === null || s.model === '', '不该凭空冒出模型');
  return '降级正常';
});

t('ensureReady / build 可重复调用且不炸', () => {
  const g = new MemoryGraphV2(DIR);
  const a = g.ensureReady(); const b = g.build();
  g.close();
  assert(a.nodes === b.nodes, '两次统计应一致');
  return `nodes=${a.nodes}`;
});

// 🔴 断言 .due 而不是裸值: 宿主写的是 conflictScanDue().due(v1 的契约)。
// 老断言写成 `=== true` 是拿 v2 自己的形状当标准, 于是把"裸 boolean"锁成了正确 ——
// 而真机上那句 `true.due` 得 undefined, 冲突体检在 v2 下永远不注入且不报错。
// drop-in 测试的判据只有一个: **v1 怎么被调用的, v2 就得怎么答得上来**。
t('conflictScanDue 形状与 v1 一致({due}, 不是裸 boolean)', () => {
  const g = new MemoryGraphV2(DIR);
  const r = g.conflictScanDue();
  assert(r && typeof r === 'object', '返回必须是对象 —— 宿主取的是 .due');
  assert(r.due === true, '空库首次应判定该扫');
  g.conflictMarkScanned();
  assert(g.conflictScanDue().due === false, '刚扫完不该又判该扫');
  g.close();
  return '调度状态可持久 · 形状对齐 v1';
});

t('queryWithSuspects 返回 {results, suspects} 两段', () => {
  const g = new MemoryGraphV2(DIR);
  const r = g.queryWithSuspects('冒烟');
  g.close();
  assert(Array.isArray(r.results) && Array.isArray(r.suspects), `形状不对: ${JSON.stringify(Object.keys(r))}`);
  return `results=${r.results.length} suspects=${r.suspects.length}`;
});

// dev 实跑抓到的: agent.js 设了 this.memory.actor, 但只有 append/supersede 记得往 store 传,
// upsert 漏传 —— 同一份修订历史里一半记名一半匿名, 而且要翻 DB 才看得见。
// 兜底改在引擎层(actor || this.actor), 这里锁住三个写入口都认它。
t('🔴 修订历史记名: 三个写入口都认 graph.actor', () => {
  const g = new MemoryGraphV2(DIR);
  g.actor = '码上飞';
  const a = g.upsert({ slug: 'ref_记名', title: '记名', type: 'reference', claim: '命题: 修订得记是谁改的' });
  g.upsert({ slug: 'ref_记名', body: '改一次正文' });
  g.append({ parent_id: a.id, section: '补充', body: '补一段', reason: '测试' });
  const ops = {};
  for (const r of g.revisions(a.id, { limit: 20 })) ops[r.op] = r.actor;
  g.close();
  const anon = Object.entries(ops).filter(([, who]) => who !== '码上飞');
  assert(!anon.length, `这些 op 没记上名: ${JSON.stringify(anon)}`);
  assert(ops.create && ops.upsert && ops.append, `三种 op 没齐: ${JSON.stringify(Object.keys(ops))}`);
  return `create/upsert/append 都记名`;
});

t('🔴 唤醒注入取值在两版上都拿得到内容', () => {
  const memLine = (m) => `- ${m.slug || m.id} — ${m.claim || m.description}`;
  const g = new MemoryGraphV2(DIR);
  g.setPinned(g.resolve('ref_smoke'), '测试');
  const line = memLine(g.pinnedAll()[0]);
  const hotLine = memLine(g.hot(1)[0]);
  g.close();
  assert(line.includes('ref_smoke') && line.includes('命题'), `pinned 行取空了: ${line}`);
  assert(hotLine.includes('命题'), `hot 行取空了: ${hotLine}`);
  return line.slice(0, 46) + '…';
});

(async () => {
  // 上面有一个 async 用例, 等事件循环把它跑完再汇总
  await new Promise((r) => setTimeout(r, 50));
  const pass = results.filter((r) => r.ok).length;
  console.log('');
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  console.log(`\n${pass}/${results.length} 通过`);
  process.exit(pass === results.length ? 0 : 1);
})();
