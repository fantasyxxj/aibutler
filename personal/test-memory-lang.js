// test-memory-lang.js — 出厂记忆多语化的门禁
// 跑法: node test-memory-lang.js
//
// 锁三件事, 一件比一件容易在改动中静默坏掉:
//   ① 跨语言真能查到 —— 而且要有【对照组】。繁体和简体有大量同形字, 拿"出廠 同步"验会
//      被「同步」二字蒙混过关, 看着绿实际译文根本没参与。所以每条断言都配一个同主题、
//      同关键词但【没挂译文】的节点, 它必须查不到。
//   ② 无译文节点分毫不动 —— 检索那套打分公式是实测调出来的, 多语改造只许加不许改。
//      判据不是"还能查到", 是【逐位相同】: 拿同一份查询在有/无 translations 列的两条
//      内容一致的节点上算, score 必须一模一样。
//   ③ 回落链的方向 —— 想要的 → 简繁互替 → 英文 → 源语言。英文排在中文【前面】是作者定的:
//      行业版卖去日本, 店主读得懂英文的概率远高于中文。写反了不会报错, 只会让日本店主
//      看到一句中文, 而那正是这次改造要治的病。
require('./host-wiring');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MemoryGraphV2 } = require('../core/memory-v2');
const lang = require('../core/memory-v2/lang');
const { msg } = require('../core/memory-v2/messages');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-mem-lang-'));
const g = new MemoryGraphV2(dir);

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { console.log(`  ✓ ${l}`); pass++; } else { console.log(`  ✗ ${l}`); fail++; } };

// 填充语料: 不给分母 IDF 会退化。全库只有两三条时 df/N 接近 1, log 比值归零, 所有节点
// 一起掉到 IDF 地板被"闭嘴闸"过滤 —— 那时候连简体基线都查不到, 会被误读成功能坏了。
const FILLER = ['向量检索 语义 相似度', '气泡渲染 markdown 按钮', '网关 令牌 计费 配额',
  '人格 唤醒 上下文 压缩', 'sqlite 事务 外键 悬空边', '测试 门禁 断言 回归',
  '打包 签名 公证 分发', '插件 目录 清单 渲染', 'line 官方账号 频道 权限',
  '订阅 套餐 价格 快照', '日志 落地 快照 会话', '提示语 示例 诱导 禁令',
  '热度 排序 遗忘曲线', '边 关系 扩散 跳数', '红线 触发 拦截 事故',
  '体检 欠账 分批 清洗', '模型 参数 温度 上限', '截图 真机 验证 隔离',
  '部署 脚本 分支 服务器', '备份 退路 回滚 版本'];
FILLER.forEach((k, i) => g.upsert({ slug: `reference_filler_${i}`, type: 'reference',
  title: k.split(' ')[0], claim: `命题: ${k} 的处理口径`, keywords: k }));

const ZH = { title: '出厂同步就是升级',
  claim: '命题: butler 的升级就是出厂知识同步, 按 slug 比对落库',
  keywords: '出厂 同步 升级 知识包' };
const TR = {
  'zh-TW': { title: '出廠同步就是升級', claim: '命題: butler 的升級就是出廠知識同步', keywords: '出廠 升級 知識包' },
  ja: { title: '工場出荷同期がアップグレード', claim: '命題: butler のアップグレードとは出荷時知識の同期である', keywords: '出荷 アップグレード 知識パック' },
  en: { title: 'factory sync is the upgrade', claim: 'Claim: a butler upgrade is a factory knowledge sync', keywords: 'factory upgrade knowledge pack' },
};
g.upsert({ slug: 'reference_with_tr', type: 'reference', ...ZH, translations: JSON.stringify(TR),
  body: '中文正文', body_i18n: JSON.stringify({ ja: '日本語の本文', en: 'English body' }) });
// 对照组: 同主题中文, 没挂译文。非简体查询命中它 = 上面那条的"命中"是同形字蒙的。
g.upsert({ slug: 'reference_no_tr', type: 'reference', title: '知识包比对',
  claim: '命题: 出厂知识按 slug 比对落库时旧的直接被覆盖', keywords: '出厂 知识包 覆盖 比对' });

const hits = (q) => {
  const r = g.query(q, { k: 8, flat: true });
  return Array.isArray(r) ? r : [...(r.hits || []), ...(r.weak || []), ...(r.suspects || [])];
};
const hit = (q, slug) => hits(q).some((h) => h.slug === slug);

console.log('\n[1] 跨语言检索(每条都带对照组)');
for (const [q, note] of [['出廠 升級', '繁体独有字形'], ['アップグレード 出荷', '日文'],
  ['factory upgrade knowledge', '英文']]) {
  ok(hit(q, 'reference_with_tr'), `${note}「${q}」→ 命中挂了译文的那条`);
  ok(!hit(q, 'reference_no_tr'), `  🔴 对照组(同主题中文, 无译文)不命中 —— 证明是译文在起作用`);
}
ok(hit('出厂 升级', 'reference_with_tr') && hit('出厂 升级', 'reference_no_tr'),
  '简体基线: 两条都命中(没把原有中文检索改坏)');

console.log('\n[2] 无译文节点逐位不变');
// 同一份内容写两条, 一条挂译文一条不挂, 拿【只有中文能命中】的查询打分。
// 译文那条的中文变体与对照条内容相同, 所以两者分数必须相等 —— 多语改造若污染了单语路径
// (比如把各语言拼成一个大 haystack), 挂译文那条的分会虚高, 这条断言当场变红。
g.upsert({ slug: 'reference_twin_plain', type: 'reference',
  title: '孪生对照', claim: '命题: 孪生节点用来验打分没被多语改造污染', keywords: '孪生 对照 打分 污染' });
g.upsert({ slug: 'reference_twin_tr', type: 'reference',
  title: '孪生对照', claim: '命题: 孪生节点用来验打分没被多语改造污染', keywords: '孪生 对照 打分 污染',
  translations: JSON.stringify({ ja: { title: '双子の対照', claim: '命題: 双子ノードは採点の汚染を検証する', keywords: '双子 対照 採点' } }) });
const twin = hits('孪生 污染');
const a = twin.find((h) => h.slug === 'reference_twin_plain');
const b = twin.find((h) => h.slug === 'reference_twin_tr');
ok(a && b, '孪生两条都查得到');
ok(a && b && a.score === b.score,
  `🔴 挂译文不改变中文查询的得分 (无译文 ${a && a.score} vs 有译文 ${b && b.score})`);
ok(a && b && a.confidence === b.confidence, '把握度也逐位相同');

console.log('\n[3] 显示挑选与回落链');
const node = g.store.nodeBySlug('reference_with_tr');
ok(lang.pick(node, 'ja').lang === 'ja', 'ja → 拿日文那份');
ok(lang.pick(node, 'zh-TW').lang === 'zh-TW', 'zh-TW → 拿繁体那份');
ok(lang.pick(node, 'zh-CN').lang === 'zh-CN', 'zh-CN → 源语言(节点本体)');
ok(lang.pick(node, 'ko').lang === 'zh-CN', '没有的语言 → 回落到源语言');
ok(lang.fallbackChain('ja').indexOf('en') < lang.fallbackChain('ja').indexOf('zh-CN'),
  '🔴 回落链里英文排在中文前面(日本店主读得懂英文的概率远高于中文)');
ok(lang.fallbackChain('zh-TW')[1] === 'zh-CN', '繁体的第一顺位兜底是简体, 不是英文(汉字大部分读得懂)');
ok(lang.normalizeLang('zh-Hant') === 'zh-TW' && lang.normalizeLang('zh_HK') === 'zh-TW',
  'zh-Hant / zh_HK 都归到 zh-TW');
ok(lang.normalizeLang('ja-JP') === 'ja' && lang.normalizeLang('en-US') === 'en', '带地区码的也认');

console.log('\n[4] 正文译文走冷路(不在 NODE_COLS 里)');
ok(node.body_i18n === undefined,
  '🔴 nodeBySlug 不返回 body_i18n —— 它与 body 同档, 常驻内存量正比于节点数');
const cold = g.store.db.get('SELECT body, body_i18n FROM nodes WHERE slug = ?', ['reference_with_tr']);
ok(lang.pickBody(cold, 'ja') === '日本語の本文', '显式读冷列后 ja 拿到日文正文');
ok(lang.pickBody(cold, 'ko') === '中文正文', '没有的语言 → 回落 body 本体');

console.log('\n[5] 报错文案恒英文, 与显示语言无关');
const before = lang.getLang();
const noHan = (s) => !/[一-龥]/.test(s);
for (const code of ['', 'zh-CN', 'ja', 'zh-TW', 'en']) {
  lang.setLang(code);
  ok(noHan(msg('write_needs_hash', { ref: 'x', chars: 9 })),
    `🔴 显示语言=${code || '(未设)'} → 报错仍是英文, 一个汉字都没有`);
}
ok(msg('write_needs_hash', { ref: 'abc', chars: 9 }).includes('abc'), '占位符被填上了');
ok(msg('no_such_key_at_all').includes('missing message key'), 'key 拼错时明说缺失, 不静默吐空串');
lang.setLang(before);

console.log('\n[6] 坏译文不许拖垮全图');
g.upsert({ slug: 'reference_bad_tr', type: 'reference', title: '坏译文',
  claim: '命题: 译文 JSON 写坏时该当没有译文', keywords: '坏 译文 容错', translations: '{不是合法 JSON' });
let threw = null;
try { hits('坏 译文'); } catch (e) { threw = e.message; }
ok(!threw, `坏 JSON 不抛异常${threw ? ` (抛了: ${threw.slice(0, 40)})` : ''}`);
ok(hit('坏 译文', 'reference_bad_tr'), '坏译文的节点照样能按源语言查到');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? '❌' : '✅'} test-memory-lang: ${pass} 过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
