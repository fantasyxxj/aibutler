// test-teardown-generation.js — 拆流的"代"隔离验证。gitignored, 证据用。
// 复现 2026-08-25 双会话事故: clear() 只等 teardown 15s, 超时后照样建新流, 而那半截还在跑的
// teardown 继续读写 this._q/_ac → 掐死新流、放走老子进程, 两个会话同时往一个窗口说话。
// 不起真 SDK: 全部句柄用假对象, 只测代际归属语义。
// 跑法: /usr/local/bin/node personal/test-teardown-generation.js
require('./host-wiring');
const { Butler } = require('../core/agent');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkAgent() {
  const a = Object.create(Butler.prototype);
  a.name = 'test';
  a._q = null; a._queue = null; a._ac = null; a._consumerDone = null;
  a._askPending = [];
  a._gateCancelToken = { cancel() {} };
  a._emit = () => {};
  return a;
}

function mkStream(tag, opts = {}) {
  const ac = { aborted: false, abort() { this.aborted = true; } };
  return {
    tag, ac,
    q: { tag, interrupt: async () => {} },
    queue: { closed: false, close() { this.closed = true; } },
    done: opts.doneRejects ? Promise.reject(new Error('boom')).catch(() => { throw new Error('boom'); }) : Promise.resolve(),
  };
}

(async () => {
  let pass = 0, fail = 0;
  const t = (name, ok) => { ok ? (pass++, console.log(`✅ ${name}`)) : (fail++, console.log(`❌ ${name}`)); };

  // ① 摘牌必须发生在第一个 await 之前 —— 否则慢 teardown 期间 ensureStream 看不到"没流"
  {
    const a = mkAgent();
    const s = mkStream('old');
    a._q = s.q; a._queue = s.queue; a._ac = s.ac;
    a._consumerDone = sleep(50);
    const p = a._teardownStream();
    t('进门同步摘牌 (_q 立刻为 null, 不等任何 await)', a._q === null && a._queue === null);
    await p;
    t('正常收尾也 abort 掉子进程 (不留孤儿)', s.ac.aborted === true);
  }

  // ② 事故主路径: teardown 拆不动 → 期间新流已建 → 不许误伤新流
  {
    const a = mkAgent();
    const oldS = mkStream('old');
    a._q = oldS.q; a._queue = oldS.queue; a._ac = oldS.ac;
    let rejectDone;
    a._consumerDone = new Promise((_, rj) => { rejectDone = rj; });
    const p = a._teardownStream();
    await sleep(10);
    // clear() 超时弃等 → 新流建起来, 全套句柄易主
    const newS = mkStream('new');
    a._q = newS.q; a._queue = newS.queue; a._ac = newS.ac; a._consumerDone = Promise.resolve();
    rejectDone(new Error('老流拆不动'));   // 老 teardown 这才走到 abort 分支
    await p;
    t('老 teardown 只 abort 老流', oldS.ac.aborted === true);
    t('老 teardown 不 abort 新流', newS.ac.aborted === false);
    t('老 teardown 不抹新流的 _q/_queue', a._q === newS.q && a._queue === newS.queue);
  }

  // ③ 孤儿消费循环: 流已易主就停嘴, 且不许清新流的状态
  {
    const a = mkAgent();
    a._busy = true; a._cur = ''; a._deltaText = '';
    let emits = 0;
    a._emit = () => { emits += 1; };
    a._logUtterance = () => {}; a._evalMemoryNudge = () => {};
    const oldQ = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'S1' };
      await sleep(20);
      yield { type: 'system', subtype: 'init', session_id: 'S1' };   // 易主之后到的这条不该被处理
      await sleep(20);
    })();
    a._q = oldQ;
    const consuming = a._consume(oldQ);
    await sleep(10);
    const newQ = { tag: 'new' };
    a._q = newQ; a._queue = { tag: 'newQueue' }; a._busy = true;
    await consuming;
    t('易主后消费循环退出', true);
    t('孤儿循环不清新流的 _q', a._q === newQ && a._queue !== null);
    t('孤儿循环不把新流的 _busy 掀掉', a._busy === true);
    t('易主后 sessionId 不再被老流覆写', a.sessionId === 'S1');   // 第一条(还持牌时)写的, 第二条被闸挡住
    t('易主后不再往界面 emit', emits === 0);
  }

  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();
