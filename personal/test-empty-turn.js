// test-empty-turn.js — 空回合兜底 (只产 thinking 无 text 就 end_turn) 的无头验证.
// 手法: _consume(q) 吃任意 async iterable → 直接灌假消息流, 不起 SDK.
// 病因见 memory: project_butler_empty_turn_thinking_only_drops_lessons_20260807
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-empty-turn-'));
fs.mkdirSync(path.join(tmp, 'memory'), { recursive: true });

const { Butler } = require('../core/agent');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };

function mkAgent() {
  const b = new Butler(tmp, { name: '测试体' });
  const seen = { results: [], activities: [], submits: [] };
  b.setCallbacks({
    onText: () => {}, onActivity: (t) => seen.activities.push(t),
    onTool: () => {}, onToolDone: () => {}, onUsage: () => {},
    onResult: (r) => seen.results.push(r),
  });
  // stub submit: 真 submit 会 ensureStream 起 SDK. 只记调用, 并模拟 submit 的回合重置语义.
  b.submit = async (text, _att, opts = {}) => {
    seen.submits.push({ text, opts });
    ++b._turnSeq;   // 桩保真: 真 submit 入队那一刻就 ++(stream.js)。不涨的话 turn-release 会当成"这一轮没发出去"
    b._turnHadThinking = false;
    if (!opts._emptyTurnRetry) b._emptyTurnRetried = false;
  };
  return { b, seen };
}

const U = { input_tokens: 10, cache_read_input_tokens: 100 };
const thinkingMsg = () => ({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '', signature: 'sig' }], usage: U } });
const textMsg = (t) => ({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: t }], usage: U } });
const resultMsg = (subtype = 'success') => ({ type: 'result', subtype });
async function* stream(...msgs) { for (const m of msgs) yield m; }
const tick = () => new Promise((r) => setTimeout(r, 20));

(async () => {
  console.log('[1] 空回合(只 thinking + end_turn) → 不 emit onResult, 不 resolve askOnce, 自动补提一次');
  {
    const { b, seen } = mkAgent();
    let asked = 'NOT_RESOLVED';
    b._askPending.push((v) => { asked = v; });
    await b._consume(stream(thinkingMsg(), resultMsg()));
    await tick();
    ok(seen.results.length === 0, 'onResult 没被触发 (UI 不会收到空气泡)');
    ok(asked === 'NOT_RESOLVED', 'askOnce 没被 resolve 成空串 (整课/整次沉淀保住了)');
    ok(b._askPending.length === 1, 'askPending 原样留着, 等补提那轮');
    ok(seen.submits.length === 1, '补提了一次');
    ok(seen.submits[0].opts._emptyTurnRetry === true, '补提带 _emptyTurnRetry 标记');
    ok(seen.submits[0].opts.sourceKind === 'auto', '补提走 auto 通道 (不算真人干活)');
    ok(/had thinking/.test(seen.submits[0].text), '补提用的是 config 里的文案');
    ok(!/那现在|上一条原话/.test(seen.submits[0].text), '补提不是原话重发 (原话重发会复现同一输入形态)');
    ok(seen.activities.some((a) => /追问/.test(a)), 'UI 有可见提示, 不静默');
  }

  console.log('\n[2] 补提后正常吐字 → askOnce 拿到真文本 (整课救回来了)');
  {
    const { b, seen } = mkAgent();
    let asked = 'NOT_RESOLVED';
    b._askPending.push((v) => { asked = v; });
    await b._consume(stream(thinkingMsg(), resultMsg()));
    await tick();
    // 补提那轮: 走同一个 _consume 语义, 这次有 text
    b._turnHadThinking = false;
    await b._consume(stream(textMsg('这是补提后的正文'), resultMsg()));
    await tick();
    ok(asked === '这是补提后的正文', 'askOnce 拿到补提轮的正文');
    ok(seen.results.length === 1, 'onResult 触发一次 (补提轮那次)');
    ok(seen.submits.length === 1, '只补提了一次, 没重复补');
  }

  console.log('\n[3] 补提后又空 → 不再补(防打转), 照常收尾但必须有可见警告');
  {
    const { b, seen } = mkAgent();
    let asked = 'NOT_RESOLVED';
    b._askPending.push((v) => { asked = v; });
    await b._consume(stream(thinkingMsg(), resultMsg()));
    await tick();
    b._turnHadThinking = false;   // 补提轮开始
    await b._consume(stream(thinkingMsg(), resultMsg()));
    await tick();
    ok(seen.submits.length === 1, '第二次空回合没有再补提 (限 1 次, 不打转)');
    ok(seen.results.length === 1, '放弃后照常 emit onResult, 流程不卡死');
    ok(asked === '', 'askPending 最终被 resolve (调用方不会永久悬挂)');
    ok(seen.activities.some((a) => /放弃追问/.test(a)), '有放弃提示, 不静默');
  }

  console.log('\n[4] 正常回合(有正文) → 一律不误判');
  {
    const { b, seen } = mkAgent();
    await b._consume(stream(textMsg('正常回答'), resultMsg()));
    await tick();
    ok(seen.submits.length === 0, '没补提');
    ok(seen.results.length === 1 && seen.results[0].finalText === '正常回答', 'onResult 正常带出正文');
  }

  console.log('\n[5] 被打断的空回合 → 不补提 (那是用户主动喊停)');
  {
    const { b, seen } = mkAgent();
    await b._consume(stream(thinkingMsg(), resultMsg('interrupt')));
    await tick();
    ok(seen.submits.length === 0, '没补提');
    ok(seen.results.length === 1 && seen.results[0].interrupted === true, 'onResult 照常带 interrupted');
  }

  console.log('\n[6] 空且没 thinking → 不补提 (不是本 bug 的形状, 别乱补)');
  {
    const { b, seen } = mkAgent();
    await b._consume(stream({ type: 'assistant', message: { content: [], usage: U } }, resultMsg()));
    await tick();
    ok(seen.submits.length === 0, '没补提');
    ok(seen.results.length === 1, 'onResult 照常触发');
  }

  console.log('\n[7] 新的真人回合会重置补提额度 (下次再空还能救)');
  {
    const { b, seen } = mkAgent();
    await b._consume(stream(thinkingMsg(), resultMsg()));
    await tick();
    ok(b._emptyTurnRetried === true, '补提额度已用掉');
    await b.submit('新的真人问题', null, { sourceKind: 'user' });
    ok(b._emptyTurnRetried === false, '真人新回合重置了额度');
    ok(b._turnHadThinking === false, '真人新回合重置了 thinking 标记');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 2 : 0);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
