// test-text-done.js — 「文本块一收尾就渲染」这条路的无头回归。
// 手法同 test-empty-turn: _consume 吃假消息流, 不起 SDK。
//
// 2026-08-20 查实: 这条路自进仓起就是死的, 而且完全静默 —— 正文照样会渲染(靠"调工具"和
// "整轮收尾"两条兜底), 只是要多等模型思考那几十秒, 期间用户盯着一坨生 markdown。
// 病因: SDK 的 assistant 消息插在 content_block_start 与 content_block_stop 中间, 而
// 当时在 assistant 分支里清 _blockKinds, 于是文本块真收尾时块类型已被抹成 undefined。
// 下面的消息顺序照抄真实抓到的流水, 顺序错了这个测试就白写。
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-text-done-'));
fs.mkdirSync(path.join(tmp, 'memory'), { recursive: true });

const { Butler } = require('../core/agent');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };

const U = { input_tokens: 10, cache_read_input_tokens: 100 };
const se = (event) => ({ type: 'stream_event', event });
const blockStart = (index, type) => se({ type: 'content_block_start', index, content_block: { type } });
const blockStop = (index) => se({ type: 'content_block_stop', index });
const delta = (index, text) => se({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
const msgStart = () => se({ type: 'message_start' });
const resultMsg = () => ({ type: 'result', subtype: 'success' });
async function* stream(...msgs) { for (const m of msgs) yield m; }
const tick = () => new Promise((r) => setTimeout(r, 20));

function mkAgent() {
  const b = new Butler(tmp, { name: '测试体' });
  const seen = { textDone: 0, tools: [], text: '' };
  b.setCallbacks({
    onText: (t) => { seen.text += t; }, onActivity: () => {},
    onTool: (t) => seen.tools.push(t), onToolDone: () => {}, onUsage: () => {},
    onTextDone: () => { seen.textDone++; }, onResult: () => {},
  });
  return { b, seen };
}

(async () => {
  console.log('[1] 真实流水: assistant 消息夹在 content_block_start / stop 中间, 文本块收尾仍要 onTextDone');
  {
    const { b, seen } = mkAgent();
    await b._consume(stream(
      msgStart(),
      blockStart(0, 'thinking'),
      blockStop(0),
      blockStart(1, 'text'),
      delta(1, '我先说一句'),
      // 🔴 关键: SDK 在这里插一条完整 assistant 消息, 早于下面的 content_block_stop
      { type: 'assistant', message: { content: [{ type: 'text', text: '我先说一句' }], usage: U } },
      blockStop(1),
      resultMsg(),
    ));
    await tick();
    ok(seen.textDone === 1, '🔴 文本块收尾发出了 onTextDone (它一死, 正文就要干等模型思考完才排版)');
    ok(seen.text === '我先说一句', '逐字流照常, 没被重复补发');
  }

  console.log('\n[2] thinking 块收尾不许发 —— 那时正文气泡还是"…"占位, 封口会把脉动占位删掉');
  {
    const { b, seen } = mkAgent();
    await b._consume(stream(msgStart(), blockStart(0, 'thinking'), blockStop(0), resultMsg()));
    await tick();
    ok(seen.textDone === 0, 'thinking 块收尾不发 onTextDone');
  }

  console.log('\n[3] 一轮多条 assistant 消息(说话→调工具→再说话): 两个文本块各发一次');
  {
    const { b, seen } = mkAgent();
    await b._consume(stream(
      msgStart(),
      blockStart(0, 'text'), delta(0, '这就去读'),
      { type: 'assistant', message: { content: [{ type: 'text', text: '这就去读' }], usage: U } },
      blockStop(0),
      blockStart(1, 'tool_use'),
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }], usage: U } },
      blockStop(1),
      // 第二条 assistant 消息: 块号从 0 重新开始, message_start 在这里把映射清干净
      msgStart(),
      blockStart(0, 'text'), delta(0, '读完了'),
      { type: 'assistant', message: { content: [{ type: 'text', text: '读完了' }], usage: U } },
      blockStop(0),
      resultMsg(),
    ));
    await tick();
    ok(seen.textDone === 2, '两个文本块各发一次, 工具块不发');
    ok(seen.tools.length === 1, '工具照常抛出一条');
  }

  console.log('\n[4] 块号跨消息复用时不串味: 上条的 text 不能让下条同号的 tool_use 误发');
  {
    const { b, seen } = mkAgent();
    await b._consume(stream(
      msgStart(), blockStart(0, 'text'), blockStop(0),
      msgStart(), blockStart(0, 'tool_use'), blockStop(0),
      resultMsg(),
    ));
    await tick();
    ok(seen.textDone === 1, '只有真正的文本块那次发了');
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} test-text-done: ${pass} pass / ${fail} fail`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响判定 */ }
  process.exit(fail === 0 ? 0 : 1);
})();
