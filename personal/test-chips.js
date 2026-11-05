// test-chips.js — prompt chips 门禁(出厂池 / registry 状态机 / wake 注入 / 前端契约)
// 🔴 隔离: registry 的落盘位置在开发模式是 <repo>/app/personas.json —— 那是真人格数据。
//    本测试把 paths.registryFile 换成临时目录, 并在跑之前断言换成功, 换不成功直接退出不跑。
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const path = require('path');
const os = require('os');

const paths = require('./paths');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-chiptest-'));
const TMP_REG = path.join(TMP, 'personas.json');
const REAL_REG = paths.registryFile();
paths.registryFile = () => TMP_REG;

const registry = require('../core/registry');
if (registry.regFile() !== TMP_REG) {
  console.error('❌ 隔离失败: registry 仍指向真数据', registry.regFile(), '— 中止, 不跑测试');
  process.exit(1);
}
const realBefore = fs.existsSync(REAL_REG) ? fs.statSync(REAL_REG).mtimeMs : null;

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('  PASS ' + label); } else { fail++; console.log('  FAIL ' + label); } };

// ---- A. 出厂池 ----
console.log('\n== 出厂池 config/chips/default.json ==');
const cfg = require('./config-loader');
const pool = cfg.json('chips/default');
const factory = pool.chips;
// 出厂池是【内容】会随产品口径改, 数量不该写死 —— 下面一律用 N 对账, 断言的是行为不是条数
const N = Array.isArray(factory) ? factory.length : 0;
ok(N >= 8, `出厂池够铺一屏(实际 ${N})`);
ok(factory.every((c) => c.id && c.label && c.prompt), '每个都有 id/label/prompt');
ok(new Set(factory.map((c) => c.id)).size === factory.length, 'id 无重复');
const mainCount = factory.filter((c) => c.kind === 'main').length;
ok(mainCount >= 1 && mainCount < N, `有主路径 chip 且不是全部(实际 ${mainCount}/${N})`);
// 出厂 chip 的 label/prompt 是 {ja,en,zh-CN,zh-TW}: 它是用户直接看得见的字符串, 跟界面文案同档。
// 四语齐全是硬要求 —— 缺一语不报错, 症状只是界面切了日文而按钮还挂着中文。
{
  const LANGS = ['zh-CN', 'ja', 'en', 'zh-TW'];
  const miss = [];
  for (const c of factory) {
    for (const f of ['label', 'prompt']) {
      if (typeof c[f] === 'string') { miss.push(`${c.id}.${f}(写死成字符串了)`); continue; }
      for (const L of LANGS) if (!c[f] || !c[f][L]) miss.push(`${c.id}.${f}/${L}`);
    }
  }
  ok(miss.length === 0, '🔴 出厂 chip 的 label/prompt 四语齐全'
    + (miss.length ? ` — 缺 ${miss.length} 处: ${miss.slice(0, 4).join(' , ')}` : ''));
  // prompt 必须是"用户口吻"(第一人称) —— 点一下等于用户自己说了这句话。**逐语言都要成立**:
  // 人称正是译文最容易翻反的地方, 实测 aboutme 的英文按钮面被翻成了 "Tell me about you"(反了)。
  const FIRST_PERSON = { 'zh-CN': /我|帮我/, 'zh-TW': /我|幫我/, ja: /私|ほしい|ください|たい/, en: /\b(I|me|my)\b/i };
  const notMine = [];
  for (const c of factory) {
    for (const L of LANGS) if (!FIRST_PERSON[L].test((c.prompt || {})[L] || '')) notMine.push(`${c.id}/${L}`);
  }
  ok(notMine.length === 0, 'prompt 各语言都是用户口吻(含第一人称)'
    + (notMine.length ? ' — ' + notMine.slice(0, 4).join(' , ') : ''));

  // 切语言时按钮要跟着换。label 是【取的那一刻】按显示语言挑的, 所以光有译文不够 ——
  // 没人触发重取的话, 已经画在屏幕上的按钮会停在旧语言直到重启, 而且完全不报错。
  const chipsUI = fs.readFileSync(path.join(__dirname, 'renderer/chips.js'), 'utf8');
  ok(/onLocaleChanged/.test(chipsUI) && /refresh\(curSid\)/.test(chipsUI),
    '🔴 chips.js 订阅了 onLocaleChanged 并重取(切语言按钮跟着换)');
}

// ---- B~D. registry 状态机 ----
console.log('\n== registry chip 状态机 ==');
const HOME = path.join(TMP, 'persona-a');
fs.mkdirSync(HOME, { recursive: true });
const entry = registry.upsert({ id: 'tester', name: '测试人格', homeDir: HOME });
ok(registry.resolveChips('tester').length === N, `新人格拿到全部 ${N} 个出厂 chip`);

// 🔴 2026-08-17 作者统一个人版/行业版口径, 取消"点过即焚": 点一下只计数, 按钮留在原地。
// 出厂那批从"一次性脚手架"改成"安装时下发的模板", 和自定义那批同一套行为。
ok(registry.bumpChip('tester', 'howto') === 1, '点一下 → 计数 1');
ok(registry.resolveChips('tester').length === N, `🔴 点过之后按钮还在(仍 ${N} 个), 不再点过即焚`);
ok(registry.resolveChips('tester').some((c) => c.id === 'howto'), '点过的那个仍在列表里');
ok(registry.bumpChip('tester', 'howto') === 2, '再点 → 计数累加到 2(不是幂等)');
registry.bumpChip('tester', 'tts');
ok(registry.resolveChips('tester').length === N, '点了两个不同的, 一个都没少');

// 全点一遍也不会消失 —— 这正是旧语义被推翻的地方
for (const c of factory) registry.bumpChip('tester', c.id);
ok(registry.resolveChips('tester').length === N, `🔴 全点一遍仍是 ${N} 个(旧语义会清空)`);

// 用量与清理建议: 判据是"从没用过 + 摆够久", 且只建议不自动删
registry.touchChipSeen('tester');
const usage = registry.chipUsage('tester');
ok(usage.rows.length === N, `chipUsage 覆盖全部 ${N} 个按钮`);
ok(usage.rows.find((r) => r.id === 'howto').count === 3, 'howto 累计 3 次(2 次 + 全点那轮 1 次)');
ok(usage.stale.length === 0, '刚上架的一个都不算 stale(摆的天数不够)');
// 造一个"摆了很久且从没被点过"的: 时间倒推 30 天
const reg0 = JSON.parse(fs.readFileSync(path.join(TMP, 'personas.json'), 'utf8'));
const e0 = reg0.personas.find((p) => p.id === 'tester');
const old = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 19);
e0.chips.stats.howto = { count: 0, first_seen: old };
fs.writeFileSync(path.join(TMP, 'personas.json'), JSON.stringify(reg0, null, 2));
const usage2 = registry.chipUsage('tester');
ok(usage2.stale.some((r) => r.id === 'howto'), '从没点过 + 摆了 30 天 → 进 stale 建议清单');
ok(registry.resolveChips('tester').length === N, '🔴 进了建议清单也【不会】被自动删掉 —— 只提醒用户');

// ---- E~F. AI 自定义池 ----
console.log('\n== update_prompt_chips 写入(清洗 + 与出厂池叠加) ==');
const r = registry.setCustomChips('tester', [
  { id: 'daily', icon: '📊', label: '汇总昨天进展', prompt: '把我昨天的进展汇总一下。' },
  { id: 'nolabel', prompt: '缺 label 的应该被丢掉' },
  { label: '缺 prompt 的也丢', icon: '🙈' },
  { id: 'long', label: '这个标签特别特别特别特别特别长超过二十个字应该被截断', prompt: '测截断' },
  { label: '没给图标', prompt: '应该补默认图标' },
]);
ok(r.ok, 'setCustomChips 返回 ok');
ok(r.chips.length === 3, `只留下合法的 3 条(实际 ${r.chips.length})`);
ok(r.chips.every((c) => c.label.length <= 20), 'label 超长被截到 ≤20');
ok(r.chips.find((c) => c.label === '没给图标').icon === '💡', '缺 icon 补默认 💡');
const after = registry.resolveChips('tester');
ok(after.length === N + 3, `出厂 ${N} + 自定义 3(出厂那批不再会被点没)`);

// 缺省档是 permanent: 不写 lifetime 的自定义 chip 点过也不消失(老行为一个字不能变)
registry.bumpChip('tester', 'daily');
ok(registry.resolveChips('tester').some((c) => c.id === 'daily'), '自定义 chip 点过仍在');
ok(registry.chipUsage('tester').rows.find((r) => r.id === 'daily').count === 1, '自定义 chip 一样有计数');
ok(r.chips.find((c) => c.id === 'daily').lifetime === 'permanent', '没写 lifetime 的落库成 permanent');

// ---- E2. 增量: 改一颗不动其余几颗 ----
// 病根是这两件事叠一起: 只能整套替换 + 用量表只回 id/label, 于是"加一颗"变成凭印象重编整排,
// 其余按钮的 prompt 每次都被改写。所以既要能 merge, 用量表也要回得出原文。
console.log('\n== 增量 merge / remove ==');
const uFull = registry.chipUsage('tester').rows.find((x) => x.id === 'daily');
ok(uFull.prompt === '把我昨天的进展汇总一下。', '🔴 用量表回得出 prompt 原文(改按钮前读得到)');
ok(uFull.icon === '📊' && uFull.lifetime === 'permanent' && uFull.source === 'custom',
   '用量表回得出 icon/lifetime/来源池');
ok(registry.chipUsage('tester').rows.find((x) => x.id === 'howto').source === 'factory',
   '出厂那批标 source=factory(改之前知道它不归自己管)');
const rm1 = registry.setCustomChips('tester', [
  { id: 'newone', icon: '🆕', label: '新加的', prompt: '这是新加的一颗。' },
], { mode: 'merge' });
ok(rm1.ok && rm1.chips.length === 4, `merge 只加不减: 3 → 4(实际 ${rm1.chips.length})`);
ok(rm1.chips.find((c) => c.id === 'daily').prompt === '把我昨天的进展汇总一下。',
   '🔴 没提到的那颗 prompt 一个字没动');
const rm2 = registry.setCustomChips('tester', [
  { id: 'daily', icon: '📈', label: '汇总昨天进展', prompt: '换成新的问法。' },
], { mode: 'merge' });
ok(rm2.chips.find((c) => c.id === 'daily').prompt === '换成新的问法。', 'merge 按 id 覆盖同一颗');
ok(rm2.chips.length === 4, '覆盖不改变总数');
ok(rm2.chips[0].id === 'daily', '🔴 覆盖后位置不变(按钮不会在屏幕上跳位)');
const rm3 = registry.setCustomChips('tester', [], { mode: 'merge', remove: ['newone'] });
ok(rm3.chips.length === 3 && !rm3.chips.some((c) => c.id === 'newone'), 'remove 按 id 摘掉一颗');
ok(registry.resolveChips('tester').some((c) => c.id === 'howto'),
   '🔴 merge 传空数组【不是】清屏 —— 出厂那批还在');

// ---- E3. 便签档(lifetime:once + group): 点一个, 整组消失 ----
console.log('\n== 便签 chip: 点了就作废, 同组一起撤 ==');
const HOME_N = path.join(TMP, 'persona-note');
fs.mkdirSync(HOME_N, { recursive: true });
registry.upsert({ id: 'tester-n', name: '测试人格N', homeDir: HOME_N });
const rn = registry.setCustomChips('tester-n', [
  { id: 'cloze29', label: '背单词·改29条', prompt: '背单词填空题改 29 条', lifetime: 'once', group: 'cloze' },
  { id: 'cloze19', label: '背单词·只改19条', prompt: '背单词填空题只改 19 条', lifetime: 'once', group: 'cloze' },
  { id: 'clozelist', label: '背单词·先看清单', prompt: '先给我看清单', lifetime: 'once', group: 'cloze' },
  { id: 'other', label: '别组的便签', prompt: '这是另一个问题', lifetime: 'once', group: 'logdir' },
  { id: 'keep', label: '永久按钮', prompt: '这个不该被撤' },
  { id: 'bogus', label: '档位拼错的', prompt: '应该退回 permanent', lifetime: 'ONCE!!' },
]);
ok(rn.chips.find((c) => c.id === 'cloze29').group === 'cloze', 'group 落库了');
ok(rn.chips.find((c) => c.id === 'bogus').lifetime === 'permanent',
   '🔴 认不出的档位退回 permanent —— 拼错字不能让按钮自己消失');
registry.bumpChip('tester-n', 'cloze29');
const nAfter = registry.resolveChips('tester-n').map((c) => c.id);
ok(!nAfter.includes('cloze29'), '点过的便签自己撤走了');
ok(!nAfter.includes('cloze19') && !nAfter.includes('clozelist'), '🔴 同 group 的另外两个一起撤走(整组消失)');
ok(nAfter.includes('other'), '🔴 别的 group 不受影响');
ok(nAfter.includes('keep'), '永久档的没被撤');
ok(nAfter.includes('bogus'), '退回 permanent 的那个也没被撤');
ok(registry.chipUsage('tester-n').rows.every((x) => x.id !== 'cloze29'), '撤走后不再出现在用量表里');
ok(nAfter.length === N + 3, `撤掉一组 3 个后剩 出厂${N}+自定义3(实际 ${nAfter.length})`);

// 换新人格互不影响
const HOME_B = path.join(TMP, 'persona-b');
fs.mkdirSync(HOME_B, { recursive: true });
registry.upsert({ id: 'tester-b', name: '测试人格B', homeDir: HOME_B });
ok(registry.resolveChips('tester-b').length === N, `另一个人格仍是全新 ${N} 个(每人格独立)`);

// ---- F2. 全清(retireFactory): 用户说"把按钮清掉"时出厂那批也得退休 ----
console.log('\n== 全清含出厂池 ==');
const HOME_C = path.join(TMP, 'persona-c');
fs.mkdirSync(HOME_C, { recursive: true });
registry.upsert({ id: 'tester-c', name: '测试人格C', homeDir: HOME_C });
registry.setCustomChips('tester-c', [{ id: 'x1', icon: '🔧', label: '自定义一', prompt: '干活' }]);
ok(registry.resolveChips('tester-c').length === N + 1, `出厂 ${N} + 自定义 1`);
// 🔴 "传空 = 全清"由 registry 这一层保证, 不靠调用方记得传 retireFactory。
// 判断散在调用方就会出现"默认值说一套、真实调用做另一套"(行业版那边正是这么矛盾了很久)。
registry.setCustomChips('tester-c', []);
ok(registry.resolveChips('tester-c').length === 0, '🔴 只传空数组也全清 —— 用户说"清掉"指的是整个屏幕');
registry.setCustomChips('tester-c', [{ id: 'x1', icon: '🔧', label: '自定义一', prompt: '干活' }]);
ok(registry.resolveChips('tester-c').length === 1, '清空后再加, 出厂批不会自己回来(只剩新加那 1 个)');
registry.setCustomChips('tester-c', [], { retireFactory: false });
ok(registry.resolveChips('tester-c').length === 0, '显式 retireFactory=false 仍可覆盖默认(出厂批早已退休, 故仍为 0)');
registry.setCustomChips('tester-c', [{ id: 'x2', icon: '✨', label: '清空后再加', prompt: '来一个' }]);
const afterClear = registry.resolveChips('tester-c');
ok(afterClear.length === 1 && afterClear[0].id === 'x2', '清空后仍能加新按钮, 出厂那批不复活');

// ---- G. wake 注入 ----
console.log('\n== wake 注入一行 ==');
const line = cfg.render('wake/chips_heading', { count: 3, list: 'A · B · C' });
ok(!line.includes('{{'), 'chips_heading 无未替换模板变量');
ok(line.includes('3') && line.includes('A · B · C'), '数量和清单都渲染进去了');
ok(line.trim().split('\n').filter((s) => s.trim()).length === 1, '就一行(作者: 成本一行字)');
const agentSrc = require('./kernel-src').kernelSource();
ok(/wake\/chips_heading/.test(agentSrc), 'buildWakePayload 真的注入了 chips_heading');
ok(/update_prompt_chips/.test(agentSrc), 'agent.js 注册了 update_prompt_chips');
// 认 buildAllowedTools 的函数体, 不认某个局部变量叫什么 —— 变量名改一次这条断言就瞎一次。
const allowBody = (agentSrc.split('\n  buildAllowedTools(')[1] || '').slice(0, 3000);   // 锚定【定义】不是调用点
ok(/update_prompt_chips/.test(allowBody),
   '🔴 update_prompt_chips 在 allowedTools 白名单里(否则调了扑空)');
const D = require('../core/config/tools/descriptions.json');
ok(!!D.update_prompt_chips, 'descriptions.json 有 update_prompt_chips 描述');
// 两种模式都得讲到: 只讲 replace, "加一颗"就会变成凭印象重编整排(最容易踩的坑);
// 只讲 merge 则没人知道怎么清空 —— 清空只有 replace + 空数组这一个入口。
ok(/merge/.test(D.update_prompt_chips) && /full set/i.test(D.update_prompt_chips),
   '描述同时讲清了增量(merge)和整套替换(replace)两条路');
ok(/full definition/i.test(D.get_chip_usage),
   'get_chip_usage 描述讲明回的是完整定义(改按钮前要先读得到原文)');

// ---- H. 教法归工具描述(手册已废: 知识全进记忆, 工具用法的真源是 schema 描述) ----
console.log('\n== 工具描述(唯一真源) ==');
const chipDocs = String(D.update_prompt_chips) + String(D.get_chip_usage || '');
ok(/persist after clicking|permanent, they persist/i.test(chipDocs),
   '描述讲了出厂 chip 点过不消失(统一口径)');
ok(/only remind, never delete it yourself/i.test(chipDocs),
   '🔴 描述写明"看用量→提醒用户, 不自己删"');

// ---- I. 前端契约 ----
console.log('\n== 前端契约 ==');
const html = fs.readFileSync(path.join(__dirname, 'renderer/index.html'), 'utf8');
ok(html.includes('id="chipbar"'), 'index.html 有 #chipbar 容器');
// 认 <script src=…> 而不是裸文件名: 注释里提一句 "renderer.js" 就足以让
// indexOf 版本假红, 而这条守的本来就是 script 标签的先后。
ok(html.indexOf('src="chips.js"') > 0 && html.indexOf('src="chips.js"') < html.indexOf('src="renderer.js"'),
   'chips.js 在 renderer.js 之前加载(renderer 里要用 window.chipsUI)');
const chipsSrc = fs.readFileSync(path.join(__dirname, 'renderer/chips.js'), 'utf8');
ok(/window\.chipsUI\s*=/.test(chipsSrc), 'chips.js 暴露 window.chipsUI');
ok(/emitUserMessage/.test(chipsSrc), '点击走现成 emitUserMessage(不重复实现发送)');
const rSrc = fs.readFileSync(path.join(__dirname, 'renderer/renderer.js'), 'utf8');
for (const m of ['chipsUI.refresh', 'chipsUI.setDisabled', 'chipsUI.paintFor']) {
  ok(rSrc.includes(m), `renderer.js 接了 ${m}`);
}
const preSrc = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
for (const m of ['getChips', 'bumpChip', 'onChipsChanged']) {
  ok(preSrc.includes(m), `preload 暴露 ${m}`);
}
const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
ok(/ipcMain\.handle\('get-chips'/.test(mainSrc), "main.js 有 get-chips handler");
ok(/ipcMain\.handle\('chip-bump'/.test(mainSrc), "main.js 有 chip-bump handler");
ok(/getChips:/.test(mainSrc) && /setChips:/.test(mainSrc), 'personaOps 注入了 getChips/setChips');
ok(/chips-changed/.test(mainSrc), 'AI 改完推 chips-changed 让界面重渲');

// ---- J. 别弄脏真数据 ----
console.log('\n== 数据隔离 ==');
const realAfter = fs.existsSync(REAL_REG) ? fs.statSync(REAL_REG).mtimeMs : null;
ok(realBefore === realAfter, `真 personas.json 未被改动 (${REAL_REG})`);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
