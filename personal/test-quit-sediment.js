// test-quit-sediment.js — 退出沉淀不许干等死掉的子进程.
// 病因(2026-08-25 打包版实测): 子进程空闲期死掉后, 退出沉淀的 askOnce 明知管道已断
// (提交 23ms 后就 EPIPE)仍等满 60s deadline, 用户感受是"关了窗口一分钟退不掉且毫无反馈".
// 根因: _flushAskPending() 只接在 认证失效 / _teardownStream / 压缩超时兜底 三条路上,
// 唯独没接【子进程自己死掉】那条 —— 它绕过 teardown, 之前没有任何放行点.
// 记忆: reference_quit_hangs_60s_when_sdk_child_died_outside_teardown
// 手法同 test-empty-turn: _consume(q) 吃任意 async iterable → 直接灌假流, 不起 SDK.
require('./host-wiring');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-quit-sediment-'));
fs.mkdirSync(path.join(tmp, 'memory'), { recursive: true });

const { Butler } = require('../core/agent');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };

function mkAgent() {
  const b = new Butler(tmp, { name: '测试体' });
  b.setCallbacks({
    onText: () => {}, onActivity: () => {}, onTool: () => {}, onToolDone: () => {},
    onUsage: () => {}, onResult: () => {},
  });
  // stub submit: 真 submit 会 ensureStream 起 SDK。askOnce 只要 submit 不抛, 就会一直挂着等 result。
  b.submit = async () => {};
  return b;
}

const tick = () => new Promise((r) => setTimeout(r, 20));

(async () => {
  console.log('[1] 子进程死掉(消费循环抛错) → 挂起的 askOnce 当场放行, 不等 deadline');
  {
    const b = mkAgent();
    let asked = 'NOT_SETTLED';
    // deadline 给足 60s(和真实退出沉淀一致)。修复前这里必然要等满 60s 才 reject;
    // 修复后消费循环一死就放行, 20ms 内就该有结果。
    const p = b.askOnce('沉淀一下', 60000, { sourceKind: 'auto' })
      .then((v) => { asked = { resolved: v }; })
      .catch((e) => { asked = { rejected: String(e && e.message) }; });
    await tick();
    ok(asked === 'NOT_SETTLED', '灌流之前 askOnce 还挂着(前提成立)');

    async function* dyingStream() { throw new Error('Claude Code process exited with code 143'); }
    // 直接调 _consume 时没有 ensureStream 那层 .catch, 所以测试自己接住。
    const t0 = Date.now();
    await b._consume(dyingStream()).catch(() => {});
    // 🔴 必须对【时间】断言, 不能只等 p settle: askOnce 带 60s deadline, 没修复的话它也会
    // settle —— 只是 60 秒之后。`await p` 写在断言前, 这个测试就变成"慢但照样绿"的假守卫。
    // 所以拿一个短计时器跟它赛跑, 谁先到算谁。
    const raced = await Promise.race([p.then(() => 'settled'), tick().then(() => 'still_pending')]);
    const dt = Date.now() - t0;

    ok(raced === 'settled', `消费循环一死, askOnce 当场放行(实测 ${dt}ms) —— 修复前此处要等满 60s`);
    ok(b._askPending.length === 0, '挂起队列已清空, 没有残留的 resolver');
    ok(b._q === null, '_q 已置空 —— sedimentOne 的 `b._q` 守卫据此跳过后续沉淀');
  }

  console.log('\n[2] 🔴 反向守卫: 流【正常】收尾【不许】放行 —— 空回合补提全靠这个语义');
  {
    // 放行点如果放宽成"只要 _consume 结束就放行", 这条会红。
    // 理由: 流正常收尾后 submit 会 ensureStream 重建, _askPending 挂在 this 上跨流存活,
    // 新流的 result 照样接得住它。一律放行 = 把整课/整次沉淀无声丢掉(见 test-empty-turn)。
    const b = mkAgent();
    const p = b.askOnce('沉淀一下', 60000, { sourceKind: 'auto' }).catch(() => {});
    await tick();
    async function* quietStream() { /* 一条消息都不产就正常结束 */ }
    await b._consume(quietStream());
    const raced = await Promise.race([p.then(() => 'settled'), tick().then(() => 'still_pending')]);
    ok(raced === 'still_pending', '正常收尾后 askOnce 仍挂着, 等重建的流来接');
    ok(b._askPending.length === 1, '挂起队列原样留着(跨流存活)');
  }

  console.log('\n[2.5] 🔴 不验存没存下东西: 只有这一轮没跑完(超时/抛错)才算失败 —— 作者 9-23 定');
{
  // 原先拿「节点数没涨且 MEMORY.md 没变」判失败, 分不清 真没沉 / 无事可沉 / 更新了已有节点(节点数不涨)。
  // 10-08 作者关一个人格标签, 就被这个判定弹了「沉淀失败」、上下文也没清。
  const mk = (ask) => {
    const b = mkAgent();
    b.sessionId = 'sess-1'; b._q = {};
    b.memory = { hot: () => [{ id: 1 }] };                 // 图一个节点都不涨
    b.askOnce = ask;
    b.clear = async () => { b._cleared = true; return { ok: true, reason: 'x', droppedUsrMsgs: 0 }; };
    b._captureRecentTurns = () => {};
    return b;
  };
  for (const reply of ['已沉淀', 'nothing to save']) {
    const b = mk(async () => reply);
    const r = await b.doClearWithSediment('关闭人格', 60000, { skipWake: true, keepContextOnSedimentFail: true });
    ok(r.sediment && r.sediment.ran === true && r.sediment.ok === true,
       `回「${reply}」、图没涨 → 判成功(更新已有节点时节点数本来就不涨)`);
    ok(b._cleared === true, `  …并照常清空(「${reply}」)`);
  }
  const dead = mk(async () => { throw new Error('timeout'); });
  const r = await dead.doClearWithSediment('关闭人格', 60000, { skipWake: true, keepContextOnSedimentFail: true });
  ok(r.sediment && r.sediment.ok === false && /timeout/.test(r.sediment.error), '这一轮真没跑完 → 才判失败');
  ok(r.keptContext === true && dead._cleared !== true, '🔴 失败时【没有清空】—— 活还在上下文里');
  ok(!/_sedimentSnapshot|did not actually happen/.test(fs.readFileSync(path.join(__dirname, '..', 'core', 'agent', 'compact.js'), 'utf8')),
     '「图和便条没变就判没沉」那段判定不许回来');
}

console.log('\n[2.56] 🔴 清空前要等它真的闲下来, 不能 askOnce 一返回就清');
{
  // askOnce 是被"下一个 result"解开的, 它分不清哪个 result 对应哪次提交。点关闭时人格正在回话,
  // 那一轮的 result 立刻解开了沉淀的等待, 真正的沉淀在后面那轮才做 —— 这时清空就掐掉了它。
  const b = mkAgent();
  b.sessionId = 's'; b._q = {};
  let busy = true, clearedWhileBusy = null;
  b.memory = { hot: () => [] };
  b.isRunning = () => busy;
  b.askOnce = async () => { setTimeout(() => { busy = false; }, 500); return '已沉淀'; };
  b.clear = async () => { clearedWhileBusy = busy; return { ok: true, reason: 'x', droppedUsrMsgs: 0 }; };
  b._captureRecentTurns = () => {};
  await b.doClearWithSediment('退出 butler', 60000, { skipWake: true, keepContextOnSedimentFail: true });
  ok(clearedWhileBusy === false, '等它闲下来才清空(不等就会掐掉还在写的那一轮)');
}

console.log('\n[2.57] 🔴 还在干活就不许判死 —— 只有停止活动了才认超时');
{
  // 作者 2026-08-25:「如果真在干活, 不能强制啊, 要是死了才能强制吧」。
  // askOnce 自带的 deadline 到点就 reject, 分不清"卡死"和"正在认真写记忆"。
  const mk = ({ busyMs, replyAtMs }) => {
    const b = mkAgent();
    b.sessionId = 's'; b._q = {};
    let n = 1; const t0 = Date.now();
    b.memory = { hot: () => Array.from({ length: n }, (_, i) => ({ id: i })) };
    b.isRunning = () => Date.now() - t0 < busyMs;
    b.askOnce = () => new Promise((res) => {
      if (replyAtMs === null) return;                       // 永远不回 = 卡住
      setTimeout(() => { n += 1; res('已沉淀'); }, replyAtMs);
    });
    b.clear = async () => ({ ok: true, reason: 'x', droppedUsrMsgs: 0 });
    b._captureRecentTurns = () => {};
    return b;
  };

  // deadline 只有 300ms, 但它一直忙到 1200ms 才回 —— 不许因为"到点了"就判死
  const busy = mk({ busyMs: 1200, replyAtMs: 1200 });
  const t1 = Date.now();
  const r1 = await busy.doClearWithSediment('退出 butler', 300,
    { skipWake: true, keepContextOnSedimentFail: true, hardCapMs: 5000 });
  ok(r1.sediment && r1.sediment.ok === true,
     `一直在干活 → 耐心等到它做完(${Date.now() - t1}ms), 没在 300ms 就判死`);

  // 早早就不忙了, 却一直不回 = 真卡住 → 该判死
  const dead = mk({ busyMs: 100, replyAtMs: null });
  const r2 = await dead.doClearWithSediment('退出 butler', 400,
    { skipWake: true, keepContextOnSedimentFail: true, hardCapMs: 5000 });
  ok(r2.sediment && r2.sediment.ok === false, '停止活动且一直没回音 → 判定卡住(该报失败)');
  ok(/停止活动|卡住/.test(r2.sediment.error || ''), `报错说清了是"停了还不回音"(${(r2.sediment.error || '').slice(0, 30)}…)`);
}

console.log('\n[2.58] 🔴 首字之后要另起一段计时 —— 一段式上限会被"排队等首字"吃光');
{
  // 2026-09-13 实测: 三人格并发沉淀时首字就等了 159s, 180s 的总上限只剩 21s 干活, 于是一次
  // 正常的沉淀被判超时。首字前后是两笔账: 前面兜"连一个字都吐不出来", 后面留给真正写记忆。
  // 第三个参数 workTillMs = "开口后一直在产出到这一刻", 照搬真实 tool loop 每步刷新活体信号。
  const mk = (firstAtMs, replyAtMs, workTillMs = 0) => {
    const b = mkAgent();
    b.sessionId = 's'; b._q = {};
    let n = 1;
    b.memory = { hot: () => Array.from({ length: n }, (_, i) => ({ id: i })) };
    b.isRunning = () => true;   // 真实现场就是这样: 干等首字期间 isRunning() 一直为真, deadline 一次都不触发
    b.askOnce = () => {
      const p = new Promise((res) => {
        if (firstAtMs !== null) setTimeout(() => { b._firstOutputAt = Date.now(); b._lastOutputAt = Date.now(); }, firstAtMs);
        if (workTillMs) { const iv = setInterval(() => { b._lastOutputAt = Date.now(); }, 100); setTimeout(() => clearInterval(iv), workTillMs); }
        if (replyAtMs !== null) setTimeout(() => { n += 1; res('已沉淀'); }, replyAtMs);
      });
      return p;
    };
    b.clear = async () => ({ ok: true, reason: 'x', droppedUsrMsgs: 0 });
    b._captureRecentTurns = () => {};
    return b;
  };
  const late = mk(900, 1400);
  const r1 = await late.doClearWithSediment('退出 butler', 300,
    { skipWake: true, keepContextOnSedimentFail: true, hardCapMs: 600, idleKillMs: 2000 });
  ok(r1.sediment && r1.sediment.ok === true,
     '首字 900ms 才来(超过 600ms 的首字上限), 但开口后干得利索 → 成功; 一段式会在 600ms 把它砍掉');

  const mute = mk(null, null);
  const t2 = Date.now();
  const r2 = await mute.doClearWithSediment('退出 butler', 300,
    { skipWake: true, keepContextOnSedimentFail: true, hardCapMs: 600, idleKillMs: 2000 });
  const dt2 = Date.now() - t2;
  ok(r2.sediment && r2.sediment.ok === false, '一个字都吐不出来 → 首字上限照样兜住, 不会变成"永远不退"');
  ok(dt2 < 2000, `而且是按首字那段的上限砍的(${dt2}ms), 没白等首字之后那段预算`);

  // 🔴 2026-09-24 老师实撞: 沉淀写了 4 分多钟(几条 upsert + 改便条), 被"离首字多久"的总时长上限
  // 砍成卡死, 而它在被判死之后照样把记忆写完了。判死只许认"停手", 不许认"干得久"。
  const busy = mk(200, 1600, 1500);
  const r3 = await busy.doClearWithSediment('退出 butler', 300,
    { skipWake: true, keepContextOnSedimentFail: true, hardCapMs: 600, idleKillMs: 500 });
  ok(r3.sediment && r3.sediment.ok === true,
     '开口后连续产出 1.5s(远超 500ms 判死线) → 不许砍; 按"离首字多久"算的老逻辑必砍');
}

console.log('\n[2.6] 源码守卫: 失败必须往上报, 不许再吞回 catch 里');
{
  // 2026-09-13: sedimentOne 从 main.js 搬进 quit-sediment.js(main.js 已过 500 行上限)
  const src = fs.readFileSync(path.join(__dirname, 'quit-sediment.js'), 'utf8');
  const i = src.indexOf('async function sedimentOne');
  const fn = src.slice(i, src.indexOf('\n}', i));
  ok(/sediment/.test(fn) && /ok:\s*false/.test(fn),
     'sedimentOne 会根据沉淀结果返回 ok:false —— 那个警告框才不是死代码');
  const cs = fs.readFileSync(path.join(__dirname, '..', 'core', 'agent', 'compact.js'), 'utf8');
  ok(/keepContextOnSedimentFail/.test(cs), '支持"这一轮没跑完就别清空"');
}

console.log('\n[3] 源码守卫: 放行点接在 _consume 的 finally 上, 且 _consumerDone 挂了 catch');
  {
    const consumeSrc = fs.readFileSync(path.join(__dirname, '..', 'core', 'agent', 'consume.js'), 'utf8');
    // finally 段落: 从 '} finally {' 到该块结束, 必须含 _flushAskPending。
    const fin = consumeSrc.slice(consumeSrc.lastIndexOf('} finally {'));
    ok(/if \(died\) this\._flushAskPending\(\)/.test(fin),
       '_consume 的 finally 里是【有条件】放行(if died), 不是无条件 —— 无条件会打死空回合补提');

    const streamSrc = fs.readFileSync(path.join(__dirname, '..', 'core', 'agent', 'stream.js'), 'utf8');
    ok(/_consumerDone\s*=\s*this\._consume\(q\)\s*\.catch\(/.test(streamSrc),
       '_consumerDone 挂了 .catch —— 子进程死掉不再冒成 unhandledRejection');
    // 反向守卫: 别用"把 deadline 改小"来糊弄。60000 是退出沉淀的真实 deadline, 改小只是把
    // 干等 60s 变成干等 N s, 没解决"明知断了还等"。
    const mainSrc = fs.readFileSync(path.join(__dirname, 'quit-sediment.js'), 'utf8');
    // 这条原本写死"deadline 必须还是 60000", 立意是「别拿调大数字当解法」。
    // 2026-08-25 作者把它定到 3 分钟, 立意本身仍然成立, 所以改成守**立意**:
    //   ① deadline 收敛成一个具名常量(不是散在四处的魔法数字, 改一处就全改)
    //   ② 而且【只有停止活动才认超时】—— 真在干活就一直等, 这才是不靠调数字解决问题的证据
    ok(/const SEDIMENT_DEADLINE_MS = \d+/.test(mainSrc) && !/'退出 butler', 60000/.test(mainSrc),
       'deadline 收敛成具名常量, 不再是散落的魔法数字');
    const compactSrc = fs.readFileSync(path.join(__dirname, '..', 'core', 'agent', 'compact.js'), 'utf8');
    ok(/_askUntilDoneOrDead/.test(compactSrc) && /isRunning\(\)/.test(compactSrc),
       '🔴 真在干活就不判死(只有停止活动了才认超时) —— 光调大数字不算解决');
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${fail ? '❌' : '✅'} test-quit-sediment: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
