// 断流重试的宿主一侧(core/agent/consume.js): 灌假消息流, 不起模型。
//   ① 引擎要重发(api_retry.retry_delay_ms > 0) → 撤掉这一步流出的半截字, 回复只留重发后的那份
//   ② 重试次数用尽、最后一次没状态码 + 报错消息带 error 字段 → 换成给人看的一句, 不露英文 API Error
//   ③ 人格在正常回复里谈到这句报错(没有 error 字段) → 原样显示, 不替换不拦截
'use strict';
require('./host-wiring');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-retry-'));
const { Butler } = require('../core/agent');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

function mkAgent() {
  const b = new Butler(tmp, { name: '测试体' });
  const seen = { text: '', discards: 0, steps: 0, results: [], auth: [] };
  b.setCallbacks({
    onText: (t) => { seen.text += t; }, onActivity: () => {}, onTool: () => {}, onToolDone: () => {},
    onUsage: () => {}, onTextDone: () => {},
    onStepStart: () => { seen.steps++; }, onTextDiscard: () => { seen.discards++; },
    onResult: (r) => seen.results.push(r), onAuthExpired: (d) => seen.auth.push(d),
  });
  b.submit = async () => {};
  return { b, seen };
}
const U = { input_tokens: 10, cache_read_input_tokens: 100 };
const start = () => ({ type: 'stream_event', event: { type: 'message_start', message: {} } });
const delta = (t) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
const asst = (t, error) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }], usage: U }, ...(error ? { error } : {}) });
const retry = (attempt, delay) => ({ type: 'system', subtype: 'api_retry', attempt, max_retries: 6, retry_delay_ms: delay, error_status: null, error: 'unknown' });
const result = (extra = {}) => ({ type: 'result', subtype: 'success', ...extra });
async function* stream(...msgs) { for (const m of msgs) yield m; }
const tick = () => new Promise((r) => setTimeout(r, 20));

(async () => {
  console.log('\n=== ① 重发前撤掉半截字 ===');
  {
    const { b, seen } = mkAgent();
    await b._consume(stream(start(), delta('收到，这就'), retry(1, 1000), start(), delta('定好了。'), asst('定好了。'), result()));
    await tick();
    ok(seen.discards === 1, '要重发时发一次 onTextDiscard');
    ok(seen.results.length === 1 && seen.results[0].finalText === '定好了。', `回复只留重发后那份(实际: ${JSON.stringify(seen.results[0] && seen.results[0].finalText)})`);
    ok(seen.auth.length === 0, '不挂起人格');
  }
  {
    const { b, seen } = mkAgent();
    await b._consume(stream(start(), delta('半截'), retry(6, 0), asst('API Error: x', 'unknown'), result({ is_error: true })));
    await tick();
    ok(seen.discards === 0, 'retry_delay_ms 为 0(不再重发)时不撤字');
  }

  console.log('\n=== ② 重试用尽: 换成给人看的一句 ===');
  {
    const { b, seen } = mkAgent();
    const raw = 'API Error: No output generated. The model stream ended without a finish chunk.';
    await b._consume(stream(retry(1, 1000), retry(2, 2000), retry(3, 4000), retry(4, 8000), retry(5, 16000), retry(6, 0), asst(raw, 'unknown'), result({ is_error: true })));
    await tick();
    const fin = seen.results[0] ? seen.results[0].finalText : '';
    ok(!/API Error/.test(seen.text) && !/API Error/.test(fin), `界面和回复里都不露英文原文(实际: ${JSON.stringify(fin)})`);
    ok(/6/.test(fin), '提示里带重试次数');
  }
  {
    const { b, seen } = mkAgent();
    await b._consume(stream(retry(1, 0), asst('API Error: 400 bad request', 'invalid_request'), result({ is_error: true })));
    await tick();
    ok(/API Error: 400/.test(seen.text), '不是重试用尽(第 1 次就判不可重试)的报错照原样显示');
  }

  console.log('\n=== ③ 人格谈到这句报错不算出错 ===');
  {
    const { b, seen } = mkAgent();
    const text = '你看到的「API Error: No output generated. The model stream ended without a finish chunk.」是网关断流。';
    await b._consume(stream(start(), delta(text), asst(text), result()));
    await tick();
    ok(seen.results.length === 1 && seen.results[0].finalText === text, '正常回复原样显示, 不替换');
    ok(seen.auth.length === 0 && seen.discards === 0, '不挂起、不撤字');
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} ${pass} passed, ${fail} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
