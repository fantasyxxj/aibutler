// test-birth-gift.js — 出生礼物 self_identity 必须真的落库.
// 病因(2026-08-25 打包测试版首启实测): giftSelfIdentity(personal/main.js) 一直用 v1 字段名
// (`id` 传语义串 / `description` / `importance:'pinned'`)去调 v2 的 memory.upsert,
// 而 butler.memory 早就是 MemoryGraphV2(core/agent.js:61) —— 三个字段 v2 全不认。
// 抛出的错被 giftSelfIdentity 外面那层 catch 吞掉, 只剩一行日志, 于是**每个新人格的出生礼物
// 都没落库**: 实测库里 182 个节点, self_identity 不存在。
// 记忆: 见 verify/0.1.17.md「出生礼物丢失」那节
require('./host-wiring');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { MemoryGraphV2 } = require('../core/memory-v2');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };

const mkGraph = () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-birth-gift-'));
  return { g: new MemoryGraphV2(tmp), tmp };
};

console.log('[1] 出生礼物按 v2 字段写 → 真的落库, 且真的 pinned');
{
  const { g, tmp } = mkGraph();
  // 与 giftSelfIdentity 现在的调用形状逐字对齐 —— 它改了这里就该跟着改。
  g.upsert({
    slug: 'self_identity',
    type: 'user',
    importance: 'high',
    title: '我是 测试体',
    claim: '命题: 我是 测试体 —— 这条记的是我的身份基础事实与记忆系统用法。',
    body: '出生礼物正文',
  });

  // 直接问库, 不走检索 —— 免得被分词/热度影响判断
  const id = g.store.idOf('self_identity');
  ok(!!id, 'self_identity 节点存在(按 slug 查得到)');
  const node = id ? g.store.node(id) : null;
  ok(!!(node && node.claim), '落库的节点带 claim(v2 的核心字段)');
  // ⚠️ 正文不在 store.node() 里(它只返元数据), 要走 bodiesOf —— 别拿 node().body 判空。
  const body = id ? (g.store.bodiesOf([id]).get(id) || '') : '';
  ok(body.includes('出生礼物正文'), '正文也落了盘, 不是空壳');
  ok(g.store.isPinned(id) === false, '不标 pinned: 身份已在常驻的 persona.md 里');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

console.log('\n[2] 🔴 老的 v1 形状必须【抛错】—— 证明这个 bug 当初为什么会发生');
{
  const { g, tmp } = mkGraph();
  let threw = '';
  try {
    g.upsert({ id: 'self_identity', type: 'user', importance: 'pinned', title: 'x', description: 'y' });
  } catch (e) { threw = String(e && e.message); }
  ok(/数字主键|slug/.test(threw), `v1 的 id 传语义串会被 v2 挡下(报错: ${threw.slice(0, 40)}…)`);

  let threw2 = '';
  try { g.setImportance('self_identity', 'pinned'); } catch (e) { threw2 = String(e && e.message); }
  ok(/pinned/.test(threw2), 'importance 不接受 pinned(它与重要性正交, 要走 setPinned)');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

console.log('\n[3] 源码守卫: giftSelfIdentity 不许再出现 v1 字段');
{
  const raw = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  // 🔴 必须先剥注释再查 —— 修复说明里逐字引用了 v1 的老写法(`importance:'pinned'` 等),
  // 不剥的话源码守卫会被自己的注释误伤, 报一条根本不存在的红。
  const src = raw.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const i = src.indexOf('function giftSelfIdentity');
  const fn = src.slice(i, src.indexOf('\n}', i));
  ok(i > 0, '找得到 giftSelfIdentity');
  ok(/slug:\s*'self_identity'/.test(fn), "用 slug: 'self_identity'(不是 id:)");
  ok(!/\bid:\s*'self_identity'/.test(fn), '没有残留的 v1 `id:` 写法');
  ok(/claim:/.test(fn) && !/description:/.test(fn), '用 claim: 而不是 v1 的 description:');
  ok(!/importance:\s*'pinned'/.test(fn), "没有 importance:'pinned'(v2 已禁)");
  ok(!/setPinned\(/.test(src.slice(i, i + 1600)), '不标 pinned(身份已在常驻的 persona.md 里)');
}

console.log('\n[4] 🔴 出生教材说的世界, 必须跟真发出去的骨架一致');
{
  // 由来(2026-08-25 打包版实测): 教材写「这个文件生下来是空的, 把「🔥 在办区」这一节建出来」,
  // 而 core/persona.js 实际生成的骨架里那节已经存在、且叫「🔥 手头这件」。
  // 后果不是"名字不好看" —— 新人格照教材的措辞去回忆, 就**编出了一份教材里的文件**:
  // 实测它汇报「MEMORY.md 共 18 行, 【🔥 在办区】第 12-14 行已有内容」, 真实文件 11 行、
  // 那节原样写着 (暂空)、全文 "在办区" 出现 0 次。教材与产物不符会直接诱发幻觉汇报。
  const skeleton = fs.readFileSync(path.join(__dirname, '..', 'core', 'persona.js'), 'utf8');
  const m = skeleton.match(/##\s*🔥\s*([^\\\n]+)/);
  ok(!!m, `骨架里找得到 🔥 那一节(实际叫「${m ? m[1].trim() : '?'}」)`);
  const SEC = m ? m[1].trim() : '';

  // 出厂配置只有 core/config 一份 —— 个人版没有独有层, 两版共用, 行业版靠 industry/config 覆盖。
  // (此前 personal/config 存着一份同名拷贝, 于是"改了半天一个字没生效"; 那份已删。)
  const ob = (n) => path.join(__dirname, '..', 'core', 'config', 'onboarding', n);
  // 🔴 逐语言都查。骨架那个节名是英文字面串, 四语教材引用的都得是它 —— 2026-08-30 实测:
  // 从 git 捞回的中文底稿还写着让人格去替换 `(暂空)`, 而产物早已是 `(empty for now)`,
  // 对不上的后果就是这个测试开头讲的那种幻觉汇报。
  const files = {};
  for (const lc of require('../core/memory-v2/lang').LANGS) {
    for (const n of ['experience', 'experience_retry']) files[`core ${n}.${lc}.md`] = ob(`${n}.${lc}.md`);
  }
  files['core knowledge/leaf_core.json'] = ob('knowledge/leaf_core.json');
  files['补做清单 birth.js'] = path.join(__dirname, 'birth.js');
  for (const [label, f] of Object.entries(files)) {
    const t = fs.readFileSync(f, 'utf8');
    if (!/🔥|MEMORY\.md/.test(t)) continue;
    ok(!/在办区/.test(t), `${label} 里没有旧词「在办区」`);
    if (t.includes('🔥')) ok(t.includes(SEC), `${label} 用的是骨架里那个名字「${SEC}」`);
  }

  // 同一类坑的第二处: 两个 tail 让新人格去填 persona.md 的「领域」, 而骨架里那一行的字面
  // 是 `- Domain:`。四语原先各自意译成【我的领域】/【自分の領域】/[My domain], 一个都不在
  // 文件里 —— 找不到的后果不是报错, 是它自己新建一节或者直接汇报"填好了"。
  const DOMAIN_LINE = require('fs')
    .readFileSync(path.join(__dirname, '..', 'core', 'config', 'main', 'persona_skeleton.md'), 'utf8')
    .match(/^- Domain:/m);
  ok(!!DOMAIN_LINE, '骨架里找得到 `- Domain:` 那一行');
  for (const lc of require('../core/memory-v2/lang').LANGS) {
    for (const n of ['experience_leaf_tail', 'experience_butler_tail']) {
      const t = fs.readFileSync(ob(`${n}.${lc}.md`), 'utf8');
      ok(t.includes('`- Domain:`'), `${n}.${lc}.md 指的是骨架里那一行的字面 \`- Domain:\``);
      ok(!/【我的领域】|【我的領域】|【自分の領域】|\[My domain\]/.test(t),
         `${n}.${lc}.md 不再用文件里根本不存在的意译名`);
    }
  }
  {
    // 下面三条是英文措辞的断言, 所以只验英文那份; 四语都在不在由 test-onboarding 守。
    const label = 'core experience.en.md';
    const exp = fs.readFileSync(files[label], 'utf8');
    // 只禁肯定说法。教材里那句 "**not born empty**" 是否定, 正是我们要的, 别误伤。
    ok(!/(?<!not )(?<!not \*\*)born empty/i.test(exp), `${label}: 不再说「文件生下来是空的」(它其实自带骨架)`);
    ok(/not born empty|already has a skeleton/i.test(exp), `${label}: 正面说清了它自带骨架`);
    ok(/say so honestly/i.test(exp), `${label}: 要求「没做成就照实说」—— 堵幻觉汇报`);
  }
}

console.log('\n[5] 🔴 尾段不许无条件宣布"出生结束"—— 引擎随后可能判定没结束');
{
  // 由来(2026-08-25 作者):「这里说结束了, 然后又出来一段」。
  // 尾段原本写死「到这里出生就结束了」, 而 birth.js 的 verifyBirthExperience 会核对图和文件的
  // 真实状态, 缺了就再发一段补做提示 —— 于是用户看到"结束了"之后又冒出一段, 自相矛盾。
  // 判据不是"有没有那句话", 是**它有没有把「要先过核对」这件事说在前面**。
  const ob = (n) => path.join(__dirname, '..', 'core', 'config', 'onboarding', n);
  // 核对预告的职责挪到 experience.md 收尾了 —— 挪走的东西也要有人守, 否则下次重写文案就丢了。
  for (const [label, p] of [['core', ob('experience.en.md')]]) {
    const e = fs.readFileSync(p, 'utf8');
    ok(/verify/i.test(e) && /actual state|actually landed/i.test(e), `${label} experience.md: 预告了「我会核对真实状态」`);
    // 出生教育【一段发完】(作者 2026-08-25:「我要一段」), 所以"先办完自己的事再去见主人"
    // 这个顺序只能靠**段内的文字**钉住, 不靠拆消息。守的就是那句话还在不在。
    ok(/don't flip the order|truly done/i.test(e), `${label} experience.md: 段内讲清了「三件做完才去见主人」`);
  }
  for (const f of ['experience_butler_tail.en.md', 'experience_leaf_tail.en.md']) {
    const t = fs.readFileSync(ob(f), 'utf8');
    // 尾段现在【只在核对通过后才发】(main.js 的编排), 所以它不再承担"预告核对"的职责 ——
    // 那句话挪到了 experience.md 的收尾。这里只守: 别再冒出"到这里出生就结束了"这种
    // 抢在核对之前下结论的话。
    // 守的是"无条件宣布" —— 句首直接说 birth is complete。挂了 Once/After 前提的不算。
    ok(!/(^|[.!?]\s+)birth is (now )?complete/i.test(t), `${f} 不抢在核对之前无条件宣布"出生结束"`);
    ok(/met your owner/i.test(t), `${f} 把"结束"挂在见完主人之后`);
  }
}

console.log(`\n${fail ? '❌' : '✅'} test-birth-gift: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
