// test-subagent-feed.js — 子代理的过程不进主聊天。跑: node test-subagent-feed.js
//
// 病根(2026-11-09 作者报「子代理一直往屏幕输出, 没法干活」): cc 引擎把子代理的工具调用和逐字输出
// 带着 parent_tool_use_id 转发过来, 宿主从不看这个字段, 于是它们被当成主代理的工具行 / 正文 / 占用。
// 灌假消息流验行为: 子代理的消息只出一行动态(onActivity), 不出 onTool / onText, 不改上下文占用。
require('./host-wiring');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-subfeed-'));
fs.mkdirSync(path.join(tmp, 'memory'), { recursive: true });

const { Butler } = require('../core/agent');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

function mkAgent() {
  const b = new Butler(tmp, { name: '测试体' });
  const seen = { text: '', tools: [], activity: [], results: 0 };
  b.setCallbacks({
    onText: (t) => { seen.text += t; }, onActivity: (a) => seen.activity.push(a),
    onTool: (t) => seen.tools.push(t.name), onToolDone: () => {},
    onUsage: () => {}, onTextDone: () => {}, onResult: () => { seen.results++; },
  });
  b.submit = async () => {};
  return { b, seen };
}

const P = 'toolu_parent';
const MAIN_U = { input_tokens: 10, cache_read_input_tokens: 1000 };
const SUB_U = { input_tokens: 10, cache_read_input_tokens: 90000 };
async function* stream(...msgs) { for (const m of msgs) yield m; }
const tick = () => new Promise((r) => setTimeout(r, 20));

(async () => {
  console.log('\n=== 子代理的工具调用 / 逐字输出 / 结果都不进主聊天 ===');
  const { b, seen } = mkAgent();
  await b._consume(stream(
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: P, name: 'Agent', input: { description: '查三个目录', prompt: 'x' } }], usage: MAIN_U } },
    { type: 'stream_event', parent_tool_use_id: P, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '子代理在自言自语' } } },
    { type: 'assistant', parent_tool_use_id: P, message: { content: [{ type: 'text', text: '子代理在自言自语' }, { type: 'tool_use', id: 's1', name: 'Grep', input: { pattern: 'foo' } }], usage: SUB_U } },
    { type: 'user', parent_tool_use_id: P, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: 'hit' }] } },
    { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: P, content: '报告' }] } },
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '查完了' }], usage: MAIN_U } },
    { type: 'result', subtype: 'success' },
  ));
  await tick();
  ok(seen.tools.length === 1 && seen.tools[0] === 'Agent', `🔴 主聊天只有主代理的 Agent 一行工具(实得 ${JSON.stringify(seen.tools)})`);
  ok(!seen.text.includes('子代理在自言自语'), '🔴 子代理的逐字输出不追加进主气泡');
  ok(seen.text.includes('查完了'), '主代理自己的话照常出');
  ok(seen.activity.some((a) => a.startsWith('↳ ')), '子代理的工具调用出一行动态(↳ 开头)');
  ok(b.lastInput === 1010, `🔴 上下文占用不被子代理的 usage 覆盖(实得 ${b.lastInput})`);
  ok(seen.results === 1, '整轮照常收尾');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
