// test-memory-migrate.js — 迁移器(v1 .md → v2 DB)
// 真语料由环境变量 BUTLER_REAL_MEMORY 指定, 有就多跑一轮真实规模;
// 没有(别人的机器 / CI)也要能跑, 所以主体用手造的小语料。
// 运行: node test-memory-migrate.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { detectStart, migrate } = require('../core/memory-migrate-v2');
const { MemoryStoreV2, DB_FILE } = require('../core/memory-store-v2');

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { if (ok) { pass++; console.log(`  ✅ ${name}${extra ? ' · ' + extra : ''}`); } else { fail++; console.error(`  ❌ ${name}${extra ? ' · ' + extra : ''}`); } };

const md = (fm, body) => '---\n' + Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')
  + '\nmetadata:\n' + '---\n' + body;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# 交接便条\n- 不该被当成节点');
  fs.writeFileSync(path.join(dir, 'feedback_a.md'), md(
    { name: '甲', description: '甲的一句话', type: 'feedback', importance: 'pinned', created: '2026-01-01', use_count: '7' },
    '正文甲, 连到 [[reference_b]] 和一个不存在的 [[nope_gone]]。\n'));
  fs.writeFileSync(path.join(dir, 'reference_b.md'), md(
    { name: '乙', description: '乙的一句话', type: 'reference', created: '2026-01-02' },
    '正文乙, 回连 [[feedback_a]]。\n'));
  fs.writeFileSync(path.join(dir, 'project_big.md'), md(
    { name: '大块头', description: '大的一句话', type: 'project', created: '2026-01-03' },
    Array.from({ length: 60 }, (_, i) => `第 ${i} 行`).join('\n')));
  fs.writeFileSync(path.join(dir, 'no_type.md'), md({ name: '没归类', description: '缺 type' }, '短正文'));
  fs.mkdirSync(path.join(dir, '_revisions'));
  fs.writeFileSync(path.join(dir, '_revisions', 'feedback_a.jsonl'),
    JSON.stringify({ ts: '2026-02-01 10:00', op: 'update', node_id: 'feedback_a', old_body: '老', new_body: '新' }) + '\n'
    + JSON.stringify({ ts: '2026-02-02 10:00', op: 'update', node_id: 'feedback_a', old_body: '新', new_body: '更新' }) + '\n');
  return dir;
}

console.log('\n=== T1: 起点探测四态 ===');
{
  const d = fixture();
  t('B: 只有 md 没有库', detectStart(d).kind === 'B');
  fs.writeFileSync(path.join(d, 'memory.db'), 'x');
  t('A: v1 库 + md', detectStart(d).kind === 'A');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-empty-'));
  t('empty: 新实例', detectStart(empty).kind === 'empty');
  t('none: 目录都没有', detectStart(path.join(empty, 'nope')).kind === 'none');
}

console.log('\n=== T2: 机械迁 —— 一条不丢 ===');
const dir = fixture();
const r = migrate(dir);
t('迁移成功', r.ok === true, r.problems ? r.problems.join(';') : (r.error || ''));
t('4 个节点(MEMORY.md 不算)', r.stat.nodes === 4, `实得 ${r.stat.nodes}`);
t('对账: 库里节点数 = md 数', r.audit.nodesInDb === r.audit.md);
const store = new MemoryStoreV2(dir);

console.log('\n=== T3: 字段搬对了 ===');
{
  const a = store.nodeBySlug('feedback_a');
  t('slug = 老 id', a && a.slug === 'feedback_a');
  t('title 取 frontmatter 的 name', a.title === '甲');
  t('claim 兜底用 description', a.claim === '甲的一句话');
  t('created 沿用原值', a.created === '2026-01-01');
  t('use_count 沿用原值', a.use_count === 7);
  t('正文进了 body 列', (store.bodiesOf([a.id]).get(a.id) || '').includes('正文甲'));
  t('v1 的 pinned 落到扩展表', store.isPinned(a.id) === true);
  t('档位从 pinned 降回 high(v2 没有 pinned 这个档)', a.importance === 'high');
}

console.log('\n=== T4: 边 —— 悬空的不建, 但要留痕 ===');
{
  const a = store.idOf('feedback_a'), b = store.idOf('reference_b');
  const edges = store.allEdges();
  t('a→b 建上了', edges.some((e) => e.src === a && e.dst === b));
  t('指向不存在节点的边没建', !edges.some((e) => !store.slugOf(e.dst)));
  t('悬空数记下来了', r.stat.dangling === 1, `${r.stat.dangling}`);
  // 断链不再单独记账: 它是当前图的状态, doctor 每次体检重新扫得出来(kind='悬空边')。
}

console.log('\n=== T5: _revisions 并进 history 同一张表 ===');
{
  const a = store.idOf('feedback_a');
  const h = store.historyOf(a, 20);
  t('2 条修订 + 1 条建节点', h.length === 3, `${h.length}`);
  t('迁进来的标了来源', h.some((x) => x.actor === 'v1_revisions'));
  t('原始时间戳没丢', h.some((x) => x.at === '2026-02-01 10:00'));
  t('前后文都在', h.some((x) => x.before === '新' && x.after === '更新'));
}

// 🔴 这里【没有队列】。2026-08-17 作者:「那个 review 的合并了吧, 不用特殊做一个事务了」——
// 欠账是当前库的状态不是发生过的事件: 该拆(正文行数)、缺归类(type 空)、断链(边指向不存在)
// doctor 每次体检都能重新扫出来, 预先记一份清单只换来"要标 done / 跳过算不算还完 / 标了没真做"。
// 唯一重算不出来的是「这条命题是拿旧摘要兜底的」(它非空且看着正常), 所以只留 claim_provisional 一个位。
console.log('\n=== T6: 兜底命题打标(不建队列) ===');
{
  const provisional = () => store.db.get('SELECT COUNT(*) AS n FROM nodes WHERE claim_provisional = 1').n;
  t('搬进来的每条命题都标了兜底', provisional() === 4, `${provisional()}`);
  // 🔴 改写命题本身就是"还了这笔账", 不需要谁去标 done —— 标记由 upsertNode 自动落下。
  store.upsertNode({ id: store.idOf('reference_b'), claim: '命题: 乙这条已经被人重写过了' });
  t('命题被改写 → 标记自动清零', provisional() === 3, `${provisional()}`);
  // 反面: 只动正文不动命题的, 账还欠着
  store.upsertNode({ id: store.idOf('feedback_a'), body: '改了正文但没碰命题' });
  t('只改正文不算还账', provisional() === 3, `${provisional()}`);
}
store.close();

console.log('\n=== T7: 不覆盖 v1, 且已迁过就不重迁 ===');
{
  t('v2 库是另一个文件', DB_FILE !== 'memory.db' && fs.existsSync(path.join(dir, DB_FILE)));
  t('迁完了探测成 done', detectStart(dir).kind === 'done');
  const again = migrate(dir);
  t('第二次直接跳过', again.ok === true && again.skipped === true);
  t('临时目录没留下', !fs.existsSync(path.join(dir, '.migrating')));
}

console.log('\n=== T8: 对账不过就不换(失败回滚) ===');
{
  const d = fixture();
  // 造一条读得进来却建不出节点的: claim 和 title 全空且 slug 也空不了 —— 改用注入一个坏 md,
  // 让节点数对不上。最直接的做法是让一个 .md 变成目录(readFileSync 抛错 → skipped)。
  fs.mkdirSync(path.join(d, 'broken.md'));
  const bad = migrate(d);
  t('对账拦下了', bad.ok === false && bad.rolledBack === true);
  t('说得出哪对不上', (bad.problems || []).length > 0, (bad.problems || []).join(';'));
  t('没留下半成品库', !fs.existsSync(path.join(d, DB_FILE)));
  t('临时目录清干净', !fs.existsSync(path.join(d, '.migrating')));
}

console.log('\n=== T9: 真语料(888 条) ===');
{
  const REAL = process.env.BUTLER_REAL_MEMORY || "";
  if (!fs.existsSync(REAL)) {
    console.log('  ⏭  跳过: 本机没有备份语料');
  } else {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-real-'));
    for (const f of fs.readdirSync(REAL)) {
      const src = path.join(REAL, f), dst = path.join(d, f);
      if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true });
      else fs.copyFileSync(src, dst);
    }
    const t0 = Date.now();
    const rr = migrate(d);
    const ms = Date.now() - t0;
    t('真语料迁移成功', rr.ok === true, (rr.problems || [rr.error]).join(';'));
    // 语料目录里有 888 个 .md, 但 persona.md 已进 SKIP_FILES(它是身份档案不是记忆, 每次会话
    // 已经作为 identity 注入了), 所以落库 887。边跟着少一批: persona.md 里的 [[链接]] 不再
    // 发出边(3919→3906), 而原本指向它的两条边变成悬空(95→97)。
    // ⚠️ 再动 SKIP_FILES 就要重算这三个数 —— 它们是「哪些 .md 算记忆」这个判定的镜像。
    t('887 条全到(888 个 md 减掉 persona.md)', rr.stat.nodes === 887, `${rr.stat.nodes}`);
    t('边 3906 + 悬空 97 = 记录在案的 4003', rr.stat.edges + rr.stat.dangling === 4003, `${rr.stat.edges}+${rr.stat.dangling}`);
    t('30 条 pinned 转成扩展表', rr.stat.pinned === 30, `${rr.stat.pinned}`);
    t('351 个修订文件全读了', rr.stat.revFiles === 351, `${rr.stat.revFiles}`);
    t('没有读不进来的文件', rr.stat.skipped.length === 0, rr.stat.skipped.slice(0, 3).join(';'));
    // 首次启动同步跑, 慢了用户就卡在启动画面上。
    t('机械那段够快(<5s)', ms < 5000, `${ms}ms`);
    fs.rmSync(d, { recursive: true, force: true });
  }
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 绿 ${fail} 红`);
process.exit(fail ? 1 : 0);
