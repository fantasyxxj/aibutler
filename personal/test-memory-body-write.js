// test-memory-body-write.js — 正文写入的四道闸
// 跑法: node personal/test-memory-body-write.js
//
// 取代了 test-memory-section-write.js —— 段的概念已整个撤掉, 那个文件测的 API 全部不存在了。
// 从它那里搬过来仍然成立的两组: hash 往返一致 · 乐观锁不误拒。
//
// 这四道闸各治一件事, 都有实测依据:
//   ① 体积闸卡【单次写入的正文总长】—— 实测 191 条 ≥3000 字符的肥节点里 77% 从没被追加过,
//      平均 5358 字符中 5029 是首次写入自带。病根是一次就写这么长, 判增量拦不到它。
//   ② write 只许改不许加 —— 实测 write 262 次改正文有 251 次(96%)在变长, 平均 +603 字符;
//      同期全量 upsert 平均缩 91 字符。便宜的口子只会被用来加。
//   ③ 段 API 必须真的没了 —— 段是让一条记忆装得下多个命题的凭借。
//   ④ 阈值必须可调 —— 它是要跑一段时间反复调的数, 锁死在代码里等于每调一次要改代码。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { MemoryGraphV2, bodyHardTokens, currentTuning } = require('../core/memory-v2');

// 闸是 token 口径, 而这些用例要精确卡在线上 —— 纯拉丁字符按 4:1 估, 所以一个 token 就是 4 个 x。
const xTokens = (n, ch = 'x') => ch.repeat(Math.ceil(n) * 4);

const dir = path.join(os.tmpdir(), 'butler-mem-bodywrite-' + Date.now());
fs.mkdirSync(dir, { recursive: true });
const g = new MemoryGraphV2(dir);

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { console.log(`  ✓ ${l}`); pass++; } else { console.log(`  ✗ ${l}`); fail++; } };

console.log(`\n体积闸 = ${bodyHardTokens()} token`);

console.log('\n[1] 段 API 已整个撤掉');
ok(typeof g.section === 'undefined', 'section() 没了');
ok(typeof g.sections === 'undefined', 'sections() 没了');
ok(typeof g.supersedeSection === 'undefined', 'supersedeSection() 没了');
ok(typeof g.wholeBody === 'function', 'wholeBody() 还在 —— 读正文的唯一入口');

console.log('\n[2] write 只许改不许加');
g.upsert({ slug: 'reference_target', type: 'reference', claim: '命题: 用来验证正文写入的测试节点',
           body: '原始正文, 一共有这么长的内容在里面, 用来跟改动后做长度对照。' });
const w0 = g.wholeBody('reference_target');
const rShort = g.write({ node: 'reference_target', content: '短一点的正文。', base_hash: w0.hash });
ok(rShort.shrank > 0, `改短放行, 缩了 ${rShort.shrank} 字符`);

let longErr = '';
try {
  g.write({ node: 'reference_target', content: '这是一段明显更长的正文内容, 用来验证不许变长这道闸会不会真的拦住我。',
            base_hash: rShort.hash });
} catch (e) { longErr = e.message; }
ok(/write EDITS, it does not ADD/.test(longErr), '变长被拒');
ok(/memory_upsert/.test(longErr), '报错给了出路(指向 upsert) —— 只说不行的挡门, 下一步只会有人想怎么绕过它');
ok(/different claim/.test(longErr), '报错点出"多半该是另一条命题", 而不是只报数字');

// 🔴 force 解的是乐观锁, 不该顺带解开体积/增长闸 —— 一个开关管两件事, 迟早有人为了绕前者关掉后者。
let forceErr = '';
try {
  g.write({ node: 'reference_target', force: true,
            content: '用 force 也不该能把正文写长, 因为这道闸和乐观锁管的根本是两件不同的事情。' });
} catch (e) { forceErr = e.message; }
ok(/write EDITS, it does not ADD/.test(forceErr), 'force 解不开「不许变长」(它只解乐观锁)');

console.log('\n[3] 正文为空时 write 拒绝并指向 upsert');
g.upsert({ slug: 'reference_empty', type: 'reference', claim: '命题: 正文是空的节点' });
let emptyErr = '';
try { g.write({ node: 'reference_empty', content: '想直接用 write 写正文' }); }
catch (e) { emptyErr = e.message; }
ok(/write only EDITS an existing body/.test(emptyErr), '空正文 write 被拒, 指向 upsert');

console.log('\n[4] 乐观锁(从段测试搬过来, 换成整条正文口径)');
const cur = g.wholeBody('reference_target');
let noHashErr = '';
try { g.write({ node: 'reference_target', content: '不带凭据就想盖' }); }
catch (e) { noHashErr = e.message; }
ok(/memory_section/.test(noHashErr), '不带 base_hash 被拒, 并告诉你去哪读');

let badHashErr = '';
try { g.write({ node: 'reference_target', content: '凭据是错的', base_hash: 'deadbeef' }); }
catch (e) { badHashErr = e.message; }
ok(/hash differs from the one you supplied/.test(badHashErr), 'hash 对不上被拒');
// 🔴 报错不能预设"有第三方写入" —— 单人库里那个前提永远为假, 会把人推去查并发、查日志。
ok(!/并发|别的人格/.test(badHashErr), '报错没把人往"查并发"的方向推');

console.log('\n[5] 写入返回的 hash 能直接接着改(不误拒)');
const w1 = g.write({ node: 'reference_target', content: '改过一次的正文', base_hash: cur.hash });
const back = g.wholeBody('reference_target');
ok(w1.hash === back.hash, `写返回 ${w1.hash} === 回读 ${back.hash}`);
let chainOk = true;
try { g.write({ node: 'reference_target', content: '再改一次', base_hash: w1.hash }); }
catch (e) { chainOk = false; }
ok(chainOk, '拿写入返回的 hash 直接接着改, 乐观锁不误拒');

console.log('\n[6] 体积闸卡单次写入总长');
let fatErr = '';
try { g.upsert({ slug: 'reference_fat', type: 'reference', claim: '命题: 肥', body: xTokens(bodyHardTokens() + 1) }); }
catch (e) { fatErr = e.message; }
ok(/正文超硬闸/.test(fatErr), '超一个 token 就拒');
// 报错必须点名"推理链", 因为写的人不会自己想到那部分可以删 —— 泛泛说"太长了"他只会删操作细节。
ok(/推理链/.test(fatErr), '报错点名「推理链」这个首要删除目标');
ok(/流水台账/.test(fatErr), '报错仍分流台账型(拆了也会涨回来, 只有搬走才治本)');
ok(!!g.upsert({ slug: 'reference_edge', type: 'reference', claim: '命题: 正好卡线', body: xTokens(bodyHardTokens()) }),
   '正好等于上限放行(闸是 > 不是 >=)');

// 🔴 中英必须是同一把尺子。裸字符口径下同一条知识的英文版约是中文版 1.8 倍字符, 闸因此
// 在英文库上成片误拦、在中文库上形同虚设 —— 换 token 口径就是为了治这个, 所以锁死它。
const refuse = (slug, body) => {
  try { g.upsert({ slug, type: 'reference', claim: '命题: 肥', body }); return ''; }
  catch (e) { return e.message; }
};
ok(/正文超硬闸/.test(refuse('reference_cjk_fat', '中文正文验证同一把尺子'.repeat(200))), '中文正文按 token 量, 拦得住');
ok(/正文超硬闸/.test(refuse('reference_latin_fat', 'an english body on the very same gate '.repeat(200))), '英文正文同一条闸, 一样拦得住');

console.log('\n[7] 阈值可调(从 tuning 读)');
ok(currentTuning().body_hard_tokens === bodyHardTokens(), 'tuning 与引擎取到的是同一个值');
ok(typeof currentTuning().body_hard_tokens === 'number', 'body_hard_tokens 在 tuning 里');

console.log('\n[8] 回执按新口径提示');
const near = g.upsert({ slug: 'reference_near', type: 'reference', claim: '命题: 接近上限',
                        body: xTokens(bodyHardTokens() * 0.7, 'y') });
ok((near.notes || []).some((n) => /how I originally proved this true/.test(n)), '接近上限时提示删论证');
const dated = g.upsert({ slug: 'reference_dated', type: 'reference', claim: '命题: 带一堆日期',
                         body: '2026-08-01 改了 A\n2026-08-02 又改成 B\n2026-08-03 最后定成 C' });
ok((dated.notes || []).some((n) => /change history/.test(n)), '日期密集时提示这是变化史');
ok((dated.notes || []).some((n) => /explanation and usage/.test(n)), '提示语用的是新口径「说明和用法」');

console.log('\n[8.5] 正文像是在复述命题 → 提示留空');
// 样本取自真机: haiku 人格沉的那条, 127 字符纯散文, 正文把 claim 换个说法又讲了一遍。
const echoNote = g.upsert({ slug: 'reference_echo', type: 'reference',
  claim: '命题: 第一次醒来后按 hot→query→touch→upsert 走一遍, 既验证记忆系统又固化新理解',
  body: '从热知识出发问一个不确定的问题, 查到规则, 标注它真的帮到自己, 再沉下属于自己的结论。这样既确认了图记忆在线, 也让第一个动作本身成为一次演练。' });
ok((echoNote.notes || []).some((n) => /leaving it empty is better/.test(n)), '短且无命令/路径的正文 → 提示留空');

// 🔴 不许常亮: 带命令或路径的正文是真用法, 一个字都不该被提示。实测全库触发率 2/1392。
const opsNote = g.upsert({ slug: 'reference_ops', type: 'reference',
  claim: '命题: 改行业版模型只需改 subscription 的 shop_config 再重起装机端',
  body: '```bash\nssh server "mysql -e \\"update ib_prod.subscription set ...\\""\n```\n改 shop_profile 没用, 下发读的是 subscription 那份冻结副本。' });
ok(!(opsNote.notes || []).some((n) => /留空更好/.test(n)), '带命令/路径的正文不提示(那是真用法)');

console.log('\n[9] 工具调用的标签漏进字段值 → 硬拦(静默失败里最坏的一种)');
// 样本取自真机: dev 实例里一个全新人格出生第一天就踩了 —— 它想传 claim + body 两个参数,
// 分隔符没写对, body 连标签一起被当成 claim 收下, LENGTH(body)=0 而 claim 里塞着一整篇正文。
// 工具当时返回的是成功。两个不同人格、两种不同写法各踩一次, 所以这是工具层的洞不是谁不小心。
const LEAKED = '顺带给快查表腾一个坑。</claim>\n<parameter name="body">## 发现的经过\n出生第一天…';
let leakErr = '';
try { g.upsert({ slug: 'reference_leak', type: 'reference', claim: LEAKED }); }
catch (e) { leakErr = e.message; }
ok(/contains a tool-call tag/.test(leakErr), 'claim 里混进标签 → 拒');
ok(/fails silently/.test(leakErr), '报错点明这是静默失败(否则下次还会以为写成功了)');
ok(/passing each argument separately/.test(leakErr), '报错给了出路');

let leakBody = '';
try { g.upsert({ slug: 'reference_leak2', type: 'reference', claim: '命题: 正常', body: '<parameter name="keywords">x' }); }
catch (e) { leakBody = e.message; }
ok(/contains a tool-call tag/.test(leakBody), 'body 里混进标签也拒(带 antml: 前缀的写法一样认)');

let contentLeak = '';
try { g.write({ node: 'reference_target', content: '改短</claim>', base_hash: g.wholeBody('reference_target').hash }); }
catch (e) { contentLeak = e.message; }
ok(/contains a tool-call tag/.test(contentLeak), 'write 的 content 也拦');

// 🔴 不能误伤: 记忆里本来就有讲"参数怎么传"的知识, 它们会正常提到这些词。
const innocent = g.upsert({ slug: 'reference_innocent', type: 'reference',
  claim: '命题: 调工具时把参数标签写成 parameter 而漏掉 antml: 前缀, 该参数会被静默丢弃',
  body: '正文里提到 body / claim / parameter 这些词都不该被拦, 判据是【尖括号开头】。' });
ok(!!innocent.id, '正文里出现 parameter/claim/body 这些词但没有尖括号 → 放行, 不误伤');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} memory-body-write: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
