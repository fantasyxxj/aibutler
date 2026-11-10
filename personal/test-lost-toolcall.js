// test-lost-toolcall.js — 「工具调用漏成正文」判定 + 补提通道的无头验证。
//
// 这个兜底的误伤代价特别高(让模型把一件已经做成的带副作用的事再做一遍), 而真故障是偶发的、
// 复现不了 —— 所以判定抽成纯函数, 拿**全历史真实样本**当回归集: 2026-09-07 扫过 5579 份
// transcript, 命中"文里有工具调用结构"的 assistant 消息共 8 条(3 条真泄漏 + 5 条我自己在正文
// 里讨论这些标签), 下面 REAL 就是那 8 条的原文片段。取证脚本 scripts/wip/scan-leaked-toolcalls.py。
//
// 🔴 本文件里的标签一律用 IV()/PA() 拼, 不写字面量 —— 写字面量的源码本身就是一次泄漏样本,
//    编辑工具会被自己的标签截断(2026-09-07 实撞)。
require('./host-wiring');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectLostToolCall } = require('../core/agent/lost-toolcall');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

const LT = '<';
const IV = (name) => `${LT}invoke name="${name}">`;
const PA = (name) => `${LT}parameter name="${name}">`;
const CALL = (name, param = 'id') => `${IV(name)}\n${PA(param)}x${LT}/parameter>`;

const TOOLS = new Set(['mcp__butler__bus_exec', 'mcp__butler__memory_upsert', 'Read', 'Bash']);
const UPSERT = 'mcp__butler__memory_upsert';

// 真实样本(取自 leaked-toolcalls.json: XML 前面那 120 字 + 命中处往后 240 字)。
const REAL = [
  { leak: false, why: '9-07 我自己在正文里讨论判据(两个标签各自带反引号)',
    text: `误伤这块得把判据卡严（要求 \`${LT}invoke name=\` 和 \`${LT}parameter name=\` 同时出现，且不在 \`\`\` 代码块里），否则我们像现在这样聊这个话题就会被自己拦下来。` },
  { leak: false, why: '9-05 我在描述现象, 只提了个孤零零的标签',
    text: `末尾出现了一段**没被解析成工具调用、直接当文本吐出来的 \`${LT}invoke>\` 块**。可能是 deepseek 的工具调用漏出。` },
  { leak: false, why: '9-05 同上, 谈的是历史里的残骸',
    text: `历史里还留着一段没发出去就被截断的 \`${LT}invoke>\` 工具调用残骸。\n\n也就是说：**压缩会吃掉半截活。**` },
  { leak: false, why: '9-05 我在讲"写了这个字面量会被当成标签"',
    text: `存记忆时正文里出现了 \`${LT}invoke\`，会被当成工具调用标签。换成全角括号。` },
  { leak: false, why: '9-05 我在给这件事定性, 引用了标签开头',
    text: `那个怪词后面跟的是 \`${LT}invoke name=\`。\n\n这事我基本定性了：不是 butler 的代码问题，是网关侧的翻译漏了。` },
  { leak: true, name: 'mcp__butler__bus_exec', why: '9-05 行业版 deepseek 真泄漏(网关翻译失败)',
    text: `count\n${IV('mcp__butler__bus_exec')}\n${PA('command')}apicall${LT}/parameter>\n${PA('content')}{"sql": "SELECT 1"}${LT}/parameter>` },
  { leak: true, name: UPSERT, why: '9-05 行业版 deepseek 真泄漏(第二例)',
    text: `count\n${IV(UPSERT)}\n${PA('id')}reference_menu_item_photo_url_flow${LT}/parameter>\n${PA('claim')}给菜品配图用四步${LT}/parameter>` },
  { leak: true, name: UPSERT, why: '8-26 个人版 claude-haiku 自己把标签前缀写坏(不经网关)',
    text: `＜anantml:function_calls＞\n${IV(UPSERT)}\n${PA('id')}project_wrote_todo_list_plugin${LT}/parameter>\n${PA('type')}project${LT}/parameter>` },
];

console.log('[1] 全历史 8 条真实样本: 3 条真泄漏全抓到, 5 条讨论全放过');
for (const c of REAL) {
  const got = detectLostToolCall(c.text, TOOLS);
  if (c.leak) ok(got && got.name === c.name, `抓到 — ${c.why}`);
  else ok(got === null, `放过 — ${c.why}`);
}

console.log('\n[2] 构造样本: 三条硬条件各自都要能单独挡住');
{
  const body = CALL(UPSERT);
  ok(detectLostToolCall(body, TOOLS) !== null, '裸的完整调用体 → 抓');
  ok(detectLostToolCall('```\n' + body + '\n```', TOOLS) === null, '① 在 ``` 代码块里 → 放过(我贴例子讨论)');
  ok(detectLostToolCall('围栏没闭合:\n```\n' + body, TOOLS) === null, '① 围栏没闭合 → 后面整段都算代码, 放过');
  ok(detectLostToolCall(CALL('nonexistent_tool'), TOOLS) === null, '② 工具名不在注册表 → 放过');
  ok(detectLostToolCall(body, new Set()) === null, '② 注册表为空(没建流/测试桩) → 一律不判');
  ok(detectLostToolCall(body, null) === null, '② 注册表没传 → 一律不判');
  ok(detectLostToolCall(`${IV(UPSERT)} 这个标签后面必须紧跟着 ${PA('id')}`, TOOLS) === null,
    '③ 两个标签之间夹了人话 → 是在讨论不是在调用, 放过');
  ok(detectLostToolCall(`${LT}ns:invoke name="Read">\n${LT}ns:parameter name="file_path">/tmp/a`, TOOLS) !== null,
    '带命名空间前缀的一样抓(前缀是随机坏掉的, 不认具体是哪个词)');
  ok(detectLostToolCall(`先说一句正常的话。\n${CALL('nonexistent_tool')}\n再来一个:\n${CALL(UPSERT)}`, TOOLS)?.name === UPSERT,
    '一段文里多个调用体 → 认第一个对得上注册表的');
  ok(detectLostToolCall('', TOOLS) === null && detectLostToolCall(null, TOOLS) === null, '空正文 → 不判');
}

console.log('\n[2b] 写成按钮标记的调用: {{cmd:工具名|…}}');
{
  const T = new Set(['mcp__butler__plugin_open', 'mcp__butler__biz_do', 'Read']);
  const CMDS = new Set(['biz_do', 'wf_go', 'menu-book.item_new']);
  const real = '加菜界面を開きます。\n\n{{cmd:plugin_open|name=刺身盛り合わせ|price=1200}}';
  ok(detectLostToolCall(real, T, CMDS)?.name === 'mcp__butler__plugin_open', '🔴 11-09 C1 原文: 工具名写成按钮 → 抓, 报全名');
  ok(detectLostToolCall(real, T, CMDS)?.via === 'cmd', '命中来源标成 cmd');
  ok(detectLostToolCall('{{cmd:plugin_open}}', T, CMDS) !== null, '不带参数的也抓');
  ok(detectLostToolCall('{{cmd:biz_do|op=item_new|label=加菜}}', T, CMDS) === null, '名字同时是命令的(biz_do) → 合法按钮, 放过');
  ok(detectLostToolCall('{{cmd:wf_go|wf=line_setup}} {{cmd:menu-book.item_new}}', T, CMDS) === null, '命令目录里的按钮 → 放过');
  ok(detectLostToolCall('{{cmd:not_a_tool|x=1}}', T, CMDS) === null, '既不是工具也不是命令 → 不归这里管, 放过');
  ok(detectLostToolCall('写法是 `{{cmd:plugin_open|name=…}}`', T, CMDS) === null, '反引号里讨论 → 放过');
  ok(detectLostToolCall(real, T) === null, '命令目录没传 → 不判这种漏法(分不开合法按钮)');
}

console.log('\n[3] 接进消费循环: 命中就不放行, 追一条补提让它重调');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-lost-tool-'));
fs.mkdirSync(path.join(tmp, 'memory'), { recursive: true });
const { Butler } = require('../core/agent');

function mkAgent() {
  const b = new Butler(tmp, { name: '测试体' });
  const seen = { results: [], activities: [], submits: [] };
  b.setCallbacks({
    onText: () => {}, onActivity: (t) => seen.activities.push(t),
    onTool: () => {}, onToolDone: () => {}, onUsage: () => {},
    onResult: (r) => seen.results.push(r),
  });
  b._knownToolNames = TOOLS;
  b.submit = async (text, _att, opts = {}) => {
    seen.submits.push({ text, opts });
    ++b._turnSeq;   // 桩保真: 真 submit 入队那一刻就 ++(stream.js)。不涨的话 turn-release 会当成"这一轮没发出去"
    if (!opts._lostToolRetry) b._lostToolRetried = false;
  };
  return { b, seen };
}

const U = { input_tokens: 10, cache_read_input_tokens: 100 };
const textMsg = (t) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }], usage: U } });
const resultMsg = (subtype = 'success') => ({ type: 'result', subtype });
async function* stream(...msgs) { for (const m of msgs) yield m; }
const tick = () => new Promise((r) => setTimeout(r, 20));

(async () => {
  {
    const { b, seen } = mkAgent();
    await b._consume(stream(textMsg(`我这就去存。\n${CALL(UPSERT)}`), resultMsg()));
    await tick();
    ok(seen.results.length === 0, '不 emit onResult (这一轮结论建在空气上, 不放行)');
    ok(seen.submits.length === 1, '补提了一次');
    ok(seen.submits[0].opts._lostToolRetry === true, '补提带 _lostToolRetry 标记');
    ok(seen.submits[0].opts.sourceKind === 'auto', '补提走 auto 通道');
    ok(seen.submits[0].text.includes(UPSERT), '补提文案点名是哪个工具没调成');
    ok(/never actually went out/.test(seen.submits[0].text), '补提用的是 config 里的文案');
    ok(seen.activities.length > 0, 'UI 有可见提示 —— 作者要的就是"让它知道自己砍空了"');
  }

  console.log('\n[4] 正常回合 / 只是在讨论标签 → 一律不误判');
  {
    const { b, seen } = mkAgent();
    await b._consume(stream(textMsg(`判据要求 \`${LT}invoke name=\` 和 \`${LT}parameter name=\` 紧挨着。`), resultMsg()));
    await tick();
    ok(seen.submits.length === 0, '没补提');
    ok(seen.results.length === 1, 'onResult 照常触发');
  }

  console.log('\n[5] 补提后又漏 → 不再补(防打转)');
  {
    const { b, seen } = mkAgent();
    await b._consume(stream(textMsg(CALL(UPSERT)), resultMsg()));
    await tick();
    b._cur = '';
    await b._consume(stream(textMsg(CALL(UPSERT)), resultMsg()));
    await tick();
    ok(seen.submits.length === 1, '第二次没有再补提 (限 1 次)');
    ok(seen.results.length === 1, '放弃后照常 emit onResult, 流程不卡死');
  }

  console.log('\n[6] 被打断的回合 → 不补提 (那是用户主动喊停)');
  {
    const { b, seen } = mkAgent();
    await b._consume(stream(textMsg(CALL(UPSERT)), resultMsg('interrupt')));
    await tick();
    ok(seen.submits.length === 0, '没补提');
    ok(seen.results.length === 1 && seen.results[0].interrupted === true, 'onResult 照常带 interrupted');
  }

  console.log('\n[7] 没有注册表(建流前) → 一律不判, 绝不瞎猜');
  {
    const { b, seen } = mkAgent();
    b._knownToolNames = null;
    await b._consume(stream(textMsg(CALL(UPSERT)), resultMsg()));
    await tick();
    ok(seen.submits.length === 0, '没补提');
    ok(seen.results.length === 1, 'onResult 照常触发');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 2 : 0);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
