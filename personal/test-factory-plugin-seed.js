// test-factory-plugin-seed.js — 出厂插件示例的播种规则.
// 由来(2026-08-25 作者): 安装包里要带一个能跑的插件例子。新装的机器 packages.local/ 是空的,
// plugin_find 只会回「这台机器一个插件都没装」—— 人格没有实物可参照, 用户也看不出插件长什么样。
// 难点全在**什么时候不播**: 这个目录是"自己写的东西"的地盘, 播错了会静默冲掉用户的改动。
require('./host-wiring');
const fs = require('fs');
const os = require('os');
const path = require('path');
const packages = require('../core/packages');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };

// 出厂知识住在三个包里(leaf_core 通用 / personal_common 个人版通用 / butler_extra 管家专属)。
// 🔴 按 slug 找一条必须三个都搜 —— 只读 leaf_core 会在包重划之后静默报"找不到"。
const KB = path.join(__dirname, '..', 'core', 'config', 'onboarding', 'knowledge');
const findSeed = (slug) => {
  for (const f of ['leaf_core.json', 'personal_common.json', 'butler_extra.json']) {
    const p = path.join(KB, f);
    if (!fs.existsSync(p)) continue;
    const hit = (JSON.parse(fs.readFileSync(p, 'utf8')).items || []).find((x) => x.slug === slug);
    if (hit) return hit;
  }
  return null;
};
const mkData = () => fs.mkdtempSync(path.join(os.tmpdir(), 'butler-seed-'));
const localFile = (d, n) => path.join(packages.localDirOf(d), n);

console.log('[1] 出厂目录里真的有示例, 且形状合法(否则后面全是空转)');
{
  const names = fs.readdirSync(packages.FACTORY_PLUGIN_DIR).filter((n) => n.endsWith('.json'));
  ok(names.length >= 1, `core/config/plugins 里有 ${names.length} 个示例`);
  for (const n of names) {
    const j = JSON.parse(fs.readFileSync(path.join(packages.FACTORY_PLUGIN_DIR, n), 'utf8'));
    ok(!!(j.type && j.id && j.version), `${n} 带齐 type/id/version(loadAll 的 checkPayload 要求)`);
    ok(packages.SAFE_NAME.test(j.id) && packages.SAFE_NAME.test(j.type), `${n} 的 type/id 过 SAFE_NAME`);
  }
}

console.log('\n[2] 全新机器 → 播进去, 而且 loadAll 真的读得到');
{
  const d = mkData();
  const r = packages.seedFactoryPlugins(d);
  ok(r.seeded.length >= 1, `播了 ${r.seeded.length} 个`);
  ok(fs.existsSync(localFile(d, 'counter.json')), 'counter.json 落到 packages.local/');
  const all = packages.loadAll({ dataDir: d });
  const hit = all.accepted.find((p) => p.id === 'counter');
  ok(!!hit, 'loadAll 收下了它(说明形状过了校验)');
  ok(hit && hit.local === true, '标记为 local(自写档, 不验签)');
  ok(all.rejected.length === 0, `没有被拒的包(rejected=${all.rejected.length})`);
  fs.rmSync(d, { recursive: true, force: true });
}

console.log('\n[3] 🔴 已经播过 → 不再播; 用户改过的内容【不许】被冲掉');
{
  const d = mkData();
  packages.seedFactoryPlugins(d);
  // 模拟用户/人格改了这个插件
  const f = localFile(d, 'counter.json');
  const mine = JSON.parse(fs.readFileSync(f, 'utf8'));
  mine.title = '我改过的计数器';
  fs.writeFileSync(f, JSON.stringify(mine, null, 2));

  const r2 = packages.seedFactoryPlugins(d);
  ok(r2.seeded.length === 0, '第二次开机不再播');
  const after = JSON.parse(fs.readFileSync(f, 'utf8'));
  ok(after.title === '我改过的计数器', '用户的改动原样留着, 没被出厂版覆盖');
  fs.rmSync(d, { recursive: true, force: true });
}

console.log('\n[4] 🔴 用户删掉它 → 不许自己长回来(删除也是一种表态)');
{
  const d = mkData();
  packages.seedFactoryPlugins(d);
  fs.unlinkSync(localFile(d, 'counter.json'));
  const r3 = packages.seedFactoryPlugins(d);
  ok(r3.seeded.length === 0, '删掉之后再开机也不播');
  ok(!fs.existsSync(localFile(d, 'counter.json')), '它确实没长回来');
  fs.rmSync(d, { recursive: true, force: true });
}

console.log('\n[5] 同名文件已存在(用户自己先写了一个) → 让路, 不覆盖');
{
  const d = mkData();
  packages.ensureLocalDir(d);
  fs.writeFileSync(localFile(d, 'counter.json'),
    JSON.stringify({ type: 'ui', id: 'counter', version: '9.9.9', title: '我自己的' }, null, 2));
  const r4 = packages.seedFactoryPlugins(d);
  ok(!r4.seeded.includes('counter.json'), '同名已存在就不播');
  const keep = JSON.parse(fs.readFileSync(localFile(d, 'counter.json'), 'utf8'));
  ok(keep.version === '9.9.9', '用户那份原样留着');
  fs.rmSync(d, { recursive: true, force: true });
}

console.log('\n[5.5] 🔴 出厂示例的配色: 不许自己编颜色, 底色文字色必须成对');
{
  // 2026-08-25 作者:「你这配色你告诉我你学过？」—— 我把一份**通篇不写 color、全靠继承**的
  // 插件当出厂示例发了出去。沙箱是深色主题(--bg:#1e1e28, 文字浅色), 而它写的是浅色底
  // (#fafafc / 按钮 #fff) 却不写文字色 → 数字几乎看不见、按钮文字**完全消失**。
  // 讽刺的是同一天我刚修过沙箱"只给 color 不给底色"的白底白字, 出厂知识里也有这条。
  // ⟹ 出厂示例是别人照着学的样板, 它自己违规的杀伤力比普通插件大得多, 必须有门禁。
  const TOKENS = /var\(--(bg|panel|panel-2|line|field|text|muted|brand|brand-hi|accent|ok|warn|danger|radius|radius-sm)\)/;
  for (const n of fs.readdirSync(packages.FACTORY_PLUGIN_DIR).filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(fs.readFileSync(path.join(packages.FACTORY_PLUGIN_DIR, n), 'utf8'));
    const css = String(j.css || '');
    if (!css) continue;
    const hard = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    ok(hard.length === 0, `${n}: 没有硬编码颜色(沙箱已给全 token, 自己编正是白底白字的来源)${hard.length ? ' — 残留: ' + hard.join(',') : ''}`);
    ok(TOKENS.test(css), `${n}: 确实用了设计 token`);
    // 成对: 凡是自己设了 background 的规则, 同一条规则里必须也设 color。
    const unpaired = [];
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const sel = m[1].trim(); const body = m[2];
      if (!/(^|;|\s)background\s*:/.test(body)) continue;
      if (/(^|;|\s)color\s*:/.test(body)) continue;
      if (/:hover|:active|:focus/.test(sel)) continue;      // 交互态只改底色是常见且安全的
      unpaired.push(sel);
    }
    ok(unpaired.length === 0,
       `${n}: 设了底色的规则都同时设了文字色${unpaired.length ? ' — 落单: ' + unpaired.join(' / ') : ''}`);
  }
}

console.log('\n[5.6] 🔴 出厂知识里那份"整份拷走改"的范本, 自己必须先做对配色');
{
  // 2026-08-25 作者:「颜色这个问题, 不是你重写这么简单吧, 得 ai 会写吧」——
  // 一查: 知识里三条都写对了(用 token / 底色文字色成对 / 有范本可拷), 但那份**被指着说
  // "整份拷走改"的范本, 自己一个 var(--) 都没有**, 还带个 #c00。
  // 于是 AI 照范本写 → 不用 token → 加了底色就白底白字。**范本压过规则**, 因为照抄比记规矩容易。
  // ⟹ 范本自己不合规, 等于知识指着一个错的样子说"照这个来"。
  // 🔴 三个包一起找 —— 2026-09-12 的包重划把插件那族下放到 personal_common, 只读
  // leaf_core 的话这几条会"找不到"而报红, 而知识其实一个字没少。
  for (const it of [findSeed('reference_plugin_minimal_working_example')]) {
    const label = 'core';
    ok(!!it, `${label}: 找得到最小范本那条知识`);
    if (!it) continue;
    const body = String(it.body || '');
    ok(/var\(--/.test(body), `${label} 范本: 用了设计 token`);
    const hard = (body.match(/#[0-9a-fA-F]{3,8}\b/g) || [])
      .filter((c) => !/^#(1e1e28|262633|2c2c3c|15151d|34344a|e6e6ef|8a8aa5|3b5bdb|4a6bff|f0b000|4ade80|f87171)$/i.test(c));
    ok(hard.length === 0, `${label} 范本: css 里没有自编颜色${hard.length ? ' — 残留: ' + hard.join(',') : ''}(token 表里那些十六进制是说明文字, 不算)`);
  }
  // 🔴 配色规矩住在【写插件那条知识】里, 不在别处。作者 2026-08-25 连着定了三次位置:
  //   ✗ 常驻系统提示 —— 「常驻个屁啊, 又不是总做插件, 常驻就得占用 token」
  //   ✗ plugin_open  —— 「这里【用】插件, 又不是【开发】插件」, 用现成插件的人改不了 css
  //   ✓ 「加一个记忆关于插件开发的就好了, 这里就告诉他怎么开发, 怎么配色」
  // 位置对了才有用: AI 想写插件时查的就是这条, 一定读得到。
  for (const entry of [findSeed('reference_you_can_write_your_own_plugin')]) {
    const label = 'core';
    ok(!!entry, `${label}: 找得到"你可以自己写插件"这条入口知识`);
    if (!entry) continue;
    const b = String(entry.body || '');
    // 守的是【教没教会怎么搭】, 不是某个字面量写法。作者 2026-08-25:「怎么就别弄颜色, 颜色肯定
    // 要弄的, 我让你一个基本支持, 颜色应该怎么搭配」—— 我第一版写成"什么都不设最安全", 是躲问题。
    ok(/--panel/.test(b) && /--muted/.test(b) && /--brand/.test(b) && /--line/.test(b),
       `${label} 入口知识: 给了各处该用哪个 token(panel/muted/brand/line)`);
    ok(/成对|同时设/.test(b) && /background/.test(b), `${label} 入口知识: 讲了底色文字色成对`);
    ok(/一屏只有一个|分层/.test(b), `${label} 入口知识: 给了搭配规矩(层次 / 一个主色), 不只是禁令`);
    ok(/不写十六进制|别现调|自编/.test(b), `${label} 入口知识: 明说别自己编颜色`);
    const tos = (entry.edges || []).map((e) => e.to);
    ok(tos.includes('reference_plugin_minimal_working_example'), `${label} 入口知识: 连到了可拷的范本`);
  }
  // 反向: 这些规矩不许再跑回"每轮付钱"和"用插件"那两个位置
  const sp = fs.readFileSync(path.join(__dirname, '..', 'core', 'agent', 'system-prompt.js'), 'utf8');
  ok(!/var\(--text\)/.test(sp), '常驻系统提示里【没有】配色规矩');
  const mt = fs.readFileSync(path.join(__dirname, '..', 'core', 'agent', 'mcp-tools.js'), 'utf8');
  ok(!/lintPluginCss/.test(mt), 'plugin_open(用插件的路径)里【没有】开发者才需要的检查');
}

console.log('\n[6] 术语撇清: 别让模型把「插件」当成 Claude Code 插件市场');
{
  // 由来(2026-08-25 作者): 「一说插件, 他以为是 claude code 市场的插件, 而不是系统本身的插件」。
  // 模型跑在 Claude Agent SDK 里, 系统提示自带 plugins/skills/marketplace, "插件"的先验被那边占着 ——
  // 所以必须在**它读得到的地方**明写这不是同一回事。文案重写时最容易把这句撇清弄丢, 故立门禁。
  // 2026-08-27 常驻提示语拆了之后, plugin_find 的描述是【唯一】的说明来源, 这两条只剩它守。
  const desc = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'core', 'config', 'tools', 'descriptions.json'), 'utf8'));
  // 大小写不敏感 —— 描述里这句在句首写成 "Nothing to do with…", 而这道闸守的是
  // 「有没有把话说清」, 不是某个字母的大小写。
  const disambiguates = (s) => /Claude Code/i.test(s) && /nothing to do/i.test(s);
  ok(disambiguates(desc.plugin_find), 'plugin_find 的描述里点明了「跟 Claude Code 插件市场无关」');
  const defines = (s) => /drawn.*into.*conversation/.test(s);
  ok(defines(desc.plugin_find),
     '正面给了定义(一块画进这个对话窗口的界面), 不是只否定不定义');
}

console.log('\n[7] 配色体检必须真接在装载链上 —— 只定义不调用 = 白写');
// 血泪: lintPluginCss 2026-08-25 就写好了, 注释里宣称"配色规矩改在它写完打开看那一刻给",
// 但**全仓零调用点**, 一直是死代码。2026-08-27 全新人格写番茄钟, 硬编码 11 个色值、
// var(--token) 用 0 处、浅色底做进深色 app, 没有任何一处拦它。所以这里守的不是"函数对不对",
// 是"这根线接没接上" —— 前者早就对了, 错的一直是后者。
{
  const d = mkData();
  packages.ensureLocalDir(d);
  const mk = (id, css) => fs.writeFileSync(localFile(d, id + '.json'),
    JSON.stringify({ type: 'ui', id, version: '1.0.0', title: id, css, html: '<div>x</div>', js: '' }));

  mk('dirty', '.wrap{background:#fafafc;color:#d0d0d8} .btn{background:#4CAF50;color:#fff}');
  mk('clean', '.wrap{background:var(--panel);color:var(--text)}');
  mk('unpaired', '.only-bg{background:var(--panel)}');

  const got = packages.loadAll({ dataDir: d }).accepted.filter((x) => x.local);
  const byId = Object.fromEntries(got.map((x) => [x.id, x]));
  ok(got.length === 3, `三份都装上了(装得上但有毛病不该被拒收) — 实得 ${got.length}`);
  ok(Array.isArray(byId.clean && byId.clean.lint), 'loadLocal 给每份都挂了 lint 字段(不是只给脏的)');
  ok(byId.clean.lint.length === 0, '全用 var(--token) 的 → 零投诉');
  const dirtyMsg = (byId.dirty.lint || []).join(' ');
  ok(byId.dirty.lint.length > 0, '硬编码色值的 → 有投诉');
  ok(/#fafafc/i.test(dirtyMsg) && /var\(--/.test(dirtyMsg),
     '投诉里既点名了违规色值, 也给了该用的 token(只骂不给替代 = 它还是不知道怎么改)');
  ok((byId.unpaired.lint || []).some((m) => /背景色却没设文字色|成对/.test(m)),
     '只设背景不设文字色的 → 单独有一条(那是"看不清"的头号来源)');

  // 🔴 装载链接上了还不够, 得有人把话说给人格听 —— 否则又是一条"跑了但没人看见"的检查
  const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  ok(/\.lint\b/.test(mainSrc), 'main.js 真的读了 lint 字段(不是挂上就没人管)');
  ok(/🎨/.test(mainSrc), 'packages.local 变动的回执里会把配色问题说出来');
  ok(/\+\$\{\(x\.lint \|\| \[\]\)\.length\}/.test(mainSrc) || /lint \|\| \[\]\)\.length/.test(mainSrc),
     'lint 计入变更 key —— 改完颜色再放一次才会有"这回干净了"的回执, 否则人格不知道自己改对没');
  // 🔴 首次接线当场踩的坑: 报的是"目录里所有带毛病的", 人格收到 11 份投诉, 把 counter /
  // approval-form / addition-drill 这些历史堆积全改了一遍 —— 那些不是它写的。
  // packages.local 是全机共用的地盘,「目录里有脏的」和「你刚写了脏的」完全是两回事。
  ok(/_localPkgLintSeen/.test(mainSrc), '只投诉本次新出现的毛病(有 seen 集合去重), 不是每次把全目录倒一遍');
  ok(/_localPkgLintSeen = new Set\(boot\.ok/.test(mainSrc),
     '开机时已存在的毛病记成"已知"不投诉 —— 那是上一辈子留下的, 不是这个人格干的');
  ok(/Only touch the named file/.test(mainSrc), '话里明说了只许改点名那份, 别顺手大扫除');
}

console.log(`\n${fail ? '❌' : '✅'} test-factory-plugin-seed: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
