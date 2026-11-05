// test-ensurestream-lock.js — ensureStream 单飞锁(promise 去重)验证。gitignored, 证据用。
// 复现 2026-07-17 双分身事故: 并发两次 ensureStream, 旧版建两条流, 新版只建一条。
// 不起真 SDK: monkeypatch _ensureStreamInner 为慢速计数器, 只测锁语义。
// 跑法: /usr/local/bin/node test-ensurestream-lock.js
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const assert = require('assert');
const { Butler } = require('../core/agent');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkAgent() {
  // 不走构造器(要 homeDir 等), 只取原型上的 ensureStream + 最小状态
  const a = Object.create(Butler.prototype);
  a.name = 'test';
  a._q = null;
  a._ensuring = null;
  a._innerCalls = 0;
  a._ensureStreamInner = async function () {
    this._innerCalls += 1;
    await sleep(80);            // 模拟 loadSdk/buildMcp 的 await 窗口 (事故里两条消息隔 1ms 挤进这窗口)
    this._q = { fake: this._innerCalls };
  };
  return a;
}

(async () => {
  let pass = 0, fail = 0;
  const t = (name, ok) => { ok ? (pass++, console.log(`✅ ${name}`)) : (fail++, console.log(`❌ ${name}`)); };

  // ① 事故复现路径: 隔 1ms 两次并发调用 → 只建一条流
  {
    const a = mkAgent();
    const p1 = a.ensureStream();
    await sleep(1);
    const p2 = a.ensureStream();
    await Promise.all([p1, p2]);
    t('并发两次(隔1ms) → _ensureStreamInner 只跑 1 次', a._innerCalls === 1);
    t('流已建立 (_q 存在)', !!a._q);
  }

  // ② 同 tick 并发 10 次 → 仍只建一条
  {
    const a = mkAgent();
    await Promise.all(Array.from({ length: 10 }, () => a.ensureStream()));
    t('同 tick 并发 10 次 → 只跑 1 次', a._innerCalls === 1);
  }

  // ③ 建完之后再调 = 幂等直接返回, 不重建
  {
    const a = mkAgent();
    await a.ensureStream();
    await a.ensureStream();
    t('建完再调 → 幂等不重建', a._innerCalls === 1);
    t('锁已释放 (_ensuring 清空)', a._ensuring === null);
  }

  // ④ 建流失败 → 锁释放, 下次可重试 (自愈不被锁卡死)
  {
    const a = mkAgent();
    let first = true;
    a._ensureStreamInner = async function () {
      this._innerCalls += 1;
      await sleep(20);
      if (first) { first = false; throw new Error('boom'); }
      this._q = { fake: true };
    };
    await assert.rejects(() => a.ensureStream(), /boom/);
    t('失败后锁释放', a._ensuring === null);
    await a.ensureStream();
    t('失败后可重试成功 (共跑 2 次)', a._innerCalls === 2 && !!a._q);
  }

  // ⑤ 失败瞬间的并发者拿到同一个 rejection (不会一个成功一个失败地岔开建流)
  {
    const a = mkAgent();
    a._ensureStreamInner = async function () {
      this._innerCalls += 1;
      await sleep(50);
      throw new Error('boom2');
    };
    const results = await Promise.allSettled([a.ensureStream(), a.ensureStream()]);
    t('并发共享同一 rejection', results.every((r) => r.status === 'rejected') && a._innerCalls === 1);
  }

  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();
