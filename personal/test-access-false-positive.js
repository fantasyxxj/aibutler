// test-access-false-positive.js — 「接入故障」误判的行为回归。跑: node test-access-false-positive.js
//
// 病根(2026-08-28 店小二实撞): consume.js 判「这一轮是不是接入故障」本该只用结构信号
// (msg.is_error / 有没有逐字流过), 正文正则只用来分「是哪一类」。但 streamed 读的是
// _deltaText, 而它在【每条】assistant 消息处理完就被清空 —— 判定发生在 result, 也就是
// 最后一条 assistant 消息之后, 于是 streamed 恒为 false, 结构闸从来没拦过一次, 真正在
// 定罪的一直是那条正则。平时没人发现, 因为普通回复不会出现 "access token";
// 而 LINE 手顺每条回复都在说 "Channel Access Token", 命中 /access token/i → 每轮必挂起,
// 回合不 emit onResult → 气泡永远停在流式生文本, markdown 和 {{cmd:}} 按钮全不生效。
//
// 老门禁(test-auth-login.js)断言的是源码里有没有 `msg.is_error === true || !streamed`
// 这行字 —— 闸失效了它照样绿。所以这里改成灌假消息流验行为。
require('./host-wiring');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-access-fp-'));
fs.mkdirSync(path.join(tmp, 'memory'), { recursive: true });

const { Butler } = require('../core/agent');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

function mkAgent() {
  const b = new Butler(tmp, { name: '测试体' });
  const seen = { results: [], auth: [] };
  b.setCallbacks({
    onText: () => {}, onActivity: () => {}, onTool: () => {}, onToolDone: () => {},
    onUsage: () => {}, onTextDone: () => {},
    onResult: (r) => seen.results.push(r),
    onAuthExpired: (d) => seen.auth.push(d),
  });
  b.submit = async () => {};
  return { b, seen };
}

const U = { input_tokens: 10, cache_read_input_tokens: 100 };
const delta = (t) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
const asst = (t) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }], usage: U } });
const toolMsg = (name) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name, input: { a: 1 } }], usage: U } });
const result = (extra = {}) => ({ type: 'result', subtype: 'success', ...extra });
async function* stream(...msgs) { for (const m of msgs) yield m; }
const tick = () => new Promise((r) => setTimeout(r, 20));

(async () => {
  console.log('\n=== 模型自己逐字说出的话, 再像报错也不能判成接入故障 ===');
  {
    // 实撞原文: LINE 手顺里必然出现 "Channel Access Token"
    const text = '平台这边已经拿到了 Bot User ID，但 Channel Secret、Access Token、LIFF ID 还缺。';
    const { b, seen } = mkAgent();
    await b._consume(stream(delta(text), asst(text), result()));
    await tick();
    ok(seen.auth.length === 0, '🔴 正文含 "Access Token" 但逐字流过 → 不挂起(否则每轮 LINE 手顺必挂)');
    ok(seen.results.length === 1, '🔴 onResult 照常触发(不触发的话气泡永远停在生文本, 按钮不生效)');
  }
  {
    const { b, seen } = mkAgent();
    const text = '那个报错写着 401, 一般是 OAuth access token 过期了, 你重登一下试试。';
    await b._consume(stream(delta(text), asst(text), result()));
    await tick();
    ok(seen.auth.length === 0 && seen.results.length === 1,
      '🔴 模型在【讨论】登录失效(401/OAuth/access token 三词齐全)也不挂起自己');
  }

  console.log('\n=== 中间夹工具调用(多条 assistant 消息)照样算流过 ===');
  {
    // 这一条正是老实现踩空的形状: 工具那条 assistant 消息把 _deltaText 清了,
    // 于是 result 那一刻看不见前面流过字。
    const { b, seen } = mkAgent();
    const text = '先查一下 Channel Access Token 填了没有。';
    await b._consume(stream(delta(text), asst(text), toolMsg('mcp__butler__get_line_config'),
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      result()));
    await tick();
    ok(seen.auth.length === 0, '🔴 文本块之后又来了工具消息, 仍然算这一轮流过字');
    ok(seen.results.length === 1, 'onResult 照常触发');
  }

  console.log('\n=== 真故障还要拦得住: CLI 整块塞进来的报错没有逐字流 ===');
  {
    const { b, seen } = mkAgent();
    b._authRetried = true;   // 跳过"先当抖动重试一次", 直接看定罪
    await b._consume(stream(asst('API Error: 401 OAuth access token expired'), result()));
    await tick();
    ok(seen.auth.length === 1 && seen.auth[0].kind === 'oauth_expired',
      '🔴 没有 text_delta 的整块 401 仍判 oauth_expired(这道闸不能为了少误判就废掉)');
    ok(seen.results.length === 0, '真故障那一轮对用户折叠, 不 emit onResult');
  }
  {
    const { b, seen } = mkAgent();
    b._authRetried = true;
    const err = 'API Error: 429 rate_limit_error';
    await b._consume(stream(delta(err), asst(err), result({ is_error: true })));
    await tick();
    ok(seen.auth.length === 1 && seen.auth[0].kind === 'quota',
      '🔴 CLI 自报 is_error 时, 即便流过字也照判(两条结构信号是并联的)');
  }

  console.log('\n=== 回合之间不许串味 ===');
  {
    const { b, seen } = mkAgent();
    b._authRetried = true;
    await b._consume(stream(delta('正常一轮'), asst('正常一轮'), result()));
    await b._consume(stream(asst('Not logged in · Please run /login'), result()));
    await tick();
    ok(seen.auth.length === 1,
      '🔴 上一轮流过字不能让下一轮跟着免检(标记必须在 result 处清)');
  }

  // 解除挂起的唯一入口曾经只是横幅上的重登按钮, 而配额那类根本不给按钮 → 误判即等于只能重启 app。
  console.log('\n=== 挂起不等于哑掉: 人再发话要放行 ===');
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../core/agent/stream.js'), 'utf8');
    const at = src.indexOf('if (this._authBlocked)');
    const seg = src.slice(at, at + 900);
    ok(/if \(!_replayable\)[\s\S]{0,200}?return;/.test(seg), '🔴 只挡没人在场的自动轮(心跳/自愈轮空转会一直烧钱)');
    ok(/this\._authBlocked = false/.test(seg), '🔴 真消息进来必须解除挂起 —— 人按回车就是重试意愿');
    ok(/_teardownStream/.test(seg), '🔴 解除时要拆流: 故障后子进程多半已死, 不拆等于白试');
    ok(/kind: 'cleared'/.test(seg), '🔴 解除要发信号 —— 横幅挂着"用不了"却又能对话, 用户没法判断状态');
    const mainSrc = require('fs').readFileSync(require('path').join(__dirname, 'main.js'), 'utf8');
    ok(/sendUI\(kind === 'cleared' \? 'auth-ok'/.test(mainSrc), "🔴 cleared 要转成 auth-ok(renderer 认这个信号摘横幅)");
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
