// test-lost-args.js — 工具入参丢成 {} 时, 原始分片必须留得下来。
// 手法同 test-text-done: _consume 吃假消息流, 不起 SDK。
//
// 背景: SDK 只把【拼装后】的 input 交给我们, 拼失败就静默回落成 {}, 模型真正吐出的几百 token
// 谁也没见过 —— 于是无从判断是生成侧吐了非法 JSON 还是传输侧没拼上 (2026-08-23 查了 88k 次
// 调用也只能看出"哪些工具在丢", 看不出"丢的是什么")。这条路接住 input_json_delta 补上那个缺口。
//
// 🔴 消息顺序照抄真实流水: assistant 消息夹在 content_block_start 与 content_block_stop 中间。
// 顺序错了这个测试就白写 —— 它要守的恰恰是"没 stop 之前不许落盘"(那时分片还没收全)。
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-lost-args-'));
fs.mkdirSync(path.join(tmp, 'memory'), { recursive: true });

// ⚠️ 不许 paths.setDataDir(tmp): 非打包时 dataDir() 直接返回 devDataDir(), 覆盖根本不生效,
// 却会往 ~/.butler-dev 写一个指向临时目录的 data-location.json 当垃圾留下。落点只能就着真实的来。
const paths = require('./paths');
const { Butler } = require('../core/agent');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };

const U = { input_tokens: 10, cache_read_input_tokens: 100 };
const se = (event) => ({ type: 'stream_event', event });
const msgStart = () => se({ type: 'message_start' });
const toolStart = (index, id, name) => se({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name } });
const argDelta = (index, partial_json) => se({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
const blockStop = (index) => se({ type: 'content_block_stop', index });
const asstTool = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }], usage: U } });
const resultMsg = () => ({ type: 'result', subtype: 'success' });
async function* stream(...msgs) { for (const m of msgs) yield m; }
const tick = () => new Promise((r) => setTimeout(r, 20));

// 落点是真实的 dataDir, 那里可能有真实跑出来的样本 —— 只认本测试自己那几个 block id, 别的一律不碰。
const dumpDir = path.join(paths.dataDir(), 'logs', 'lost_args');
const MINE = /-toolu_(bad|drop|none|late)\.json$/;
const dumps = () => { try { return fs.readdirSync(dumpDir).filter((f) => MINE.test(f)); } catch (e) { return []; } };
const readDump = (f) => JSON.parse(fs.readFileSync(path.join(dumpDir, f), 'utf8'));
const clearDumps = () => { for (const f of dumps()) { try { fs.unlinkSync(path.join(dumpDir, f)); } catch (e) { /* 清不掉不影响判定 */ } } };

function mkAgent() {
  const b = new Butler(tmp, { name: '测试体' });
  b.setCallbacks({
    onText: () => {}, onActivity: () => {}, onTool: () => {}, onToolDone: () => {},
    onUsage: () => {}, onTextDone: () => {}, onResult: () => {},
  });
  return b;
}

(async () => {
  console.log('[1] 正常调用: 分片拼得出、input 非空 → 一个字都不许落盘');
  {
    clearDumps();
    const b = mkAgent();
    await b._consume(stream(
      msgStart(),
      toolStart(0, 'toolu_ok', 'mcp__butler__memory_upsert'),
      argDelta(0, '{"id":"ref_a",'), argDelta(0, '"claim":"命题: 正常"}'),
      asstTool('toolu_ok', 'mcp__butler__memory_upsert', { id: 'ref_a', claim: '命题: 正常' }),
      blockStop(0),
      resultMsg(),
    ));
    await tick();
    ok(dumps().length === 0, '正常调用不落盘(否则每次调用的全部参数都要写一遍盘)');
    ok(b._argFrags.size === 0, '正常调用的分片当场释放, 不驻留内存');
  }

  console.log('\n[2] 分片拼不成合法 JSON → 落盘, 且原文一字不改地留下来');
  {
    clearDumps();
    const b = mkAgent();
    const head = '{"id":"ref_b","claim":"命题: 半截';
    await b._consume(stream(
      msgStart(),
      toolStart(0, 'toolu_bad', 'mcp__butler__memory_upsert'),
      argDelta(0, head),
      asstTool('toolu_bad', 'mcp__butler__memory_upsert', {}),
      blockStop(0),
      resultMsg(),
    ));
    await tick();
    const fs1 = dumps();
    ok(fs1.length === 1, '落了一个文件');
    const rec = readDump(fs1[0]);
    ok(rec.reason === 'parse_failed', `理由是 parse_failed (实得 ${rec.reason})`);
    ok(rec.raw === head, '原始分片原样保留 —— 这就是整条路存在的意义');
    ok(!!rec.parse_error, '带上了解析报错, 判生成侧还是传输侧要靠它');
    ok(rec.tool === 'mcp__butler__memory_upsert' && rec.persona === '测试体', '带上了工具名与人格');
  }

  console.log('\n[3] 分片拼得出合法 JSON, 但 SDK 交上来的 input 还是空 → 也要落(第三种病)');
  {
    clearDumps();
    const b = mkAgent();
    await b._consume(stream(
      msgStart(),
      toolStart(0, 'toolu_drop', 'mcp__butler__memory_touch'),
      argDelta(0, '{"ids":"a b c"}'),
      asstTool('toolu_drop', 'mcp__butler__memory_touch', {}),
      blockStop(0),
      resultMsg(),
    ));
    await tick();
    const fs3 = dumps();
    ok(fs3.length === 1 && readDump(fs3[0]).reason === 'assembled_but_dropped',
       '理由是 assembled_but_dropped(分片没问题, 是拼好的结果被丢了)');
    ok(readDump(fs3[0]).raw === '{"ids":"a b c"}', '正文照样留住, 可以直接拿去重放');
  }

  console.log('\n[4] 一个 input_json_delta 都没来过 → 记成 no_fragments(病灶在更上游)');
  {
    clearDumps();
    const b = mkAgent();
    await b._consume(stream(
      msgStart(),
      toolStart(0, 'toolu_none', 'mcp__butler__memory_upsert'),
      asstTool('toolu_none', 'mcp__butler__memory_upsert', {}),
      blockStop(0),
      resultMsg(),
    ));
    await tick();
    const fs4 = dumps();
    ok(fs4.length === 1 && readDump(fs4[0]).reason === 'no_fragments', '理由是 no_fragments');
    ok(readDump(fs4[0]).raw === '', '没有分片就是没有, 不许编');
  }

  console.log('\n[5] 🔴 assistant 早于 stop 到达时, 不许在半截上落盘');
  {
    clearDumps();
    const b = mkAgent();
    // assistant 报了空 input, 但此刻分片才来了一半 —— 后半截在 stop 之前还会到。
    await b._consume(stream(
      msgStart(),
      toolStart(0, 'toolu_late', 'mcp__butler__memory_upsert'),
      argDelta(0, '{"id":"ref_c","cla'),
      asstTool('toolu_late', 'mcp__butler__memory_upsert', {}),
      argDelta(0, 'im":"命题: 后半截"}'),
      blockStop(0),
      resultMsg(),
    ));
    await tick();
    const fs5 = dumps();
    ok(fs5.length === 1, '仍然落了盘(input 确实是空的)');
    ok(readDump(fs5[0]).raw === '{"id":"ref_c","claim":"命题: 后半截"}',
       '存下来的是【收全之后】的完整分片, 不是 assistant 到达那一刻的半截');
  }

  console.log('\n[6] 没 id 的旧式 tool_use 块不许把这条路搞崩(老测试里就有这种)');
  {
    clearDumps();
    const b = mkAgent();
    await b._consume(stream(
      msgStart(),
      se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use' } }),
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }], usage: U } },
      blockStop(0),
      resultMsg(),
    ));
    await tick();
    ok(dumps().length === 0, '没 id 就跟踪不了, 安静跳过而不是崩掉');
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} test-lost-args: ${pass} pass / ${fail} fail`);
  clearDumps();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响判定 */ }
  process.exit(fail === 0 ? 0 : 1);
})();
