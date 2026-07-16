// rate-gate.js — 防幻觉 · Claude 4.x submit-time token bucket 限流 module
//
// 设计文档: /Users/arthur/Program/butler/workspace/anti_hallucination_rate_gate_design_20260713.md
// 版本: v1.1 · 2026-07-13
//
// 用法:
//   const { gateSubmit, TokenBucket, configure } = require('./rate-gate')
//   const r = await gateSubmit({ model, sourceKind, cancelToken, onQueueUpdate })
//   if (r.cancelled) return  // 会话已 kill,不 submit
//   await claude.sendMessage(...)
//
// 桶设计:
// - Opus 4.x 组合桶(4.8/4.7/4.6/4.5 共享 · Anthropic 官方 rate limit 就是组合的)
// - 双桶隔离: user (主动交互) / auto (bothub/tg-native/ask_persona/autonomous)
// - Claude Sonnet/Haiku 暂不 gate
// - ITPM 桶 v1 不加(等飞飞集成时抓一次响应头验证 · Q7)
//
// 参数(v1 · hot-reloadable via configure()):
// - user 桶: capacity 30 · refill 1 token / 2000ms · 稳态 30 RPM
// - auto 桶: capacity 20 · refill 1 token / 3000ms · 稳态 20 RPM

'use strict';

// ── 默认配置 ──
const DEFAULTS = {
  opus_user: { capacity: 30, refillIntervalMs: 2000, name: 'opus-user' },
  opus_auto: { capacity: 20, refillIntervalMs: 3000, name: 'opus-auto' },
  fable_user: { capacity: 30, refillIntervalMs: 2000, name: 'fable-user' },
  fable_auto: { capacity: 20, refillIntervalMs: 3000, name: 'fable-auto' },
};

// ── TokenBucket ──
class TokenBucket {
  constructor({ capacity, refillIntervalMs, name }) {
    this.capacity = capacity;
    this.refillIntervalMs = refillIntervalMs;
    this.name = name;
    this.tokens = capacity;                // 初始满桶(允许 burst)
    this.lastRefillAt = _now();
    this.waiters = [];                     // FIFO 队列
    this._timer = null;
    this._startTimer();
  }

  _startTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this._refill();
      this._notifyWaiters();
    }, 100);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _refill() {
    const now = _now();
    const elapsed = now - this.lastRefillAt;
    const gained = Math.floor(elapsed / this.refillIntervalMs);
    if (gained > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + gained);
      this.lastRefillAt += gained * this.refillIntervalMs;
      this._drainWaiters();
    }
  }

  _drainWaiters() {
    while (this.tokens > 0 && this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w.settled) continue;             // 已 cancel 的跳过
      this.tokens -= 1;
      w.settled = true;
      w.resolve({ ok: true, cancelled: false, waitedMs: _now() - w.since });
    }
  }

  _notifyWaiters() {
    if (!this.waiters.length) return;
    const now = _now();
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      if (w.settled || !w.onUpdate) continue;
      try {
        w.onUpdate({
          waitedMs: now - w.since,
          queuePos: i + 1,
          queueLen: this.waiters.length,
          bucketName: this.name,
          tokensLeft: this.tokens,
        });
      } catch (_) { /* onUpdate 出错不影响 gate */ }
    }
  }

  acquire({ cancelToken, onUpdate } = {}) {
    this._refill();
    // 立即路径: 有 token 直接扣
    if (this.tokens > 0 && this.waiters.length === 0) {
      this.tokens -= 1;
      return Promise.resolve({ ok: true, cancelled: false, waitedMs: 0 });
    }
    // 排队路径
    return new Promise((resolve) => {
      const waiter = { resolve, settled: false, since: _now(), onUpdate, cancelToken };
      this.waiters.push(waiter);
      if (cancelToken && typeof cancelToken.onCancel === 'function') {
        cancelToken.onCancel(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          resolve({ ok: false, cancelled: true, waitedMs: _now() - waiter.since });
        });
      }
    });
  }

  status() {
    this._refill();
    return {
      name: this.name,
      capacity: this.capacity,
      tokens: this.tokens,
      refillIntervalMs: this.refillIntervalMs,
      waiterCount: this.waiters.filter((w) => !w.settled).length,
    };
  }
}

// ── 桶注册表(module-level 单例) ──
const _buckets = {
  opus_user: new TokenBucket(DEFAULTS.opus_user),
  opus_auto: new TokenBucket(DEFAULTS.opus_auto),
  fable_user: new TokenBucket(DEFAULTS.fable_user),
  fable_auto: new TokenBucket(DEFAULTS.fable_auto),
};

// ── 桶分类逻辑 ──
// model 命中 opus-4-x → 走 opus 桶(Anthropic 官方是 Opus 4.x 组合桶)
// model 命中 fable-N → 走独立 fable 桶(Anthropic 对 fable 单独限流, 与 opus 各计 quota)
// sourceKind 决定 user / auto
// 其他 model(sonnet/haiku)直通不 gate
function pickBucket(model, sourceKind) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  if (/claude-opus-4[-_.]?[5678]/.test(m)) {              // Opus 4.5/4.6/4.7/4.8
    return sourceKind === 'user' ? _buckets.opus_user : _buckets.opus_auto;
  }
  if (/claude-fable-\d/.test(m)) {                        // Fable 5+ (独立配额)
    return sourceKind === 'user' ? _buckets.fable_user : _buckets.fable_auto;
  }
  return null;
}

// ── 主入口 ──
// gateSubmit({ model, sourceKind, cancelToken, onQueueUpdate })
// return { ok, cancelled, waitedMs, gated, bucketName }
async function gateSubmit({ model, sourceKind, cancelToken, onQueueUpdate } = {}) {
  const bucket = pickBucket(model, sourceKind);
  if (!bucket) return { ok: true, cancelled: false, waitedMs: 0, gated: false };
  const r = await bucket.acquire({ cancelToken, onUpdate: onQueueUpdate });
  return { ...r, gated: true, bucketName: bucket.name };
}

// ── 配置 hot-reload(Q6/Q7/Q8 参数调整不重启) ──
// configure({ opus_user: { capacity: 40, refillIntervalMs: 1500 }, ... })
function configure(cfg = {}) {
  for (const key of Object.keys(cfg)) {
    if (!_buckets[key]) continue;
    const oldBucket = _buckets[key];
    const merged = { ...DEFAULTS[key], ...cfg[key], name: oldBucket.name };
    const newBucket = new TokenBucket(merged);
    // 迁移未 settle 的 waiter 到新桶(保连续性)
    for (const w of oldBucket.waiters) {
      if (!w.settled) newBucket.waiters.push(w);
    }
    oldBucket.stop();
    _buckets[key] = newBucket;
  }
  return getStatus();
}

function getStatus() {
  return Object.fromEntries(Object.entries(_buckets).map(([k, b]) => [k, b.status()]));
}

function _reset() {                        // 单测/接入调试用
  for (const k of Object.keys(_buckets)) _buckets[k].stop();
  _buckets.opus_user = new TokenBucket(DEFAULTS.opus_user);
  _buckets.opus_auto = new TokenBucket(DEFAULTS.opus_auto);
  _buckets.fable_user = new TokenBucket(DEFAULTS.fable_user);
  _buckets.fable_auto = new TokenBucket(DEFAULTS.fable_auto);
}

function _now() { return Date.now(); }

// ── CancelToken 辅助类(接入方也可自造,只要有 onCancel(fn) 方法) ──
class CancelToken {
  constructor() {
    this._cancelled = false;
    this._handlers = [];
  }
  cancel() {
    if (this._cancelled) return;
    this._cancelled = true;
    for (const h of this._handlers) { try { h(); } catch (_) { /* ignore */ } }
    this._handlers = [];
  }
  onCancel(fn) {
    if (this._cancelled) { try { fn(); } catch (_) { /* ignore */ } return; }
    this._handlers.push(fn);
  }
  get cancelled() { return this._cancelled; }
}

module.exports = {
  gateSubmit,
  configure,
  getStatus,
  TokenBucket,
  CancelToken,
  pickBucket,
  DEFAULTS,
  _reset,
};

// ────────────────────────────────────────────────────────
// self-test: node rate-gate.js
// ────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const assert = require('assert');
    let passed = 0, total = 0;
    const t = async (name, fn) => {
      total++;
      try { await fn(); console.log(`✔ ${name}`); passed++; }
      catch (e) { console.error(`✗ ${name}: ${e.message}\n${e.stack}`); }
    };

    // 1. pickBucket 分类
    await t('pickBucket · Opus 4.8 user → opus_user', () => {
      const b = pickBucket('claude-opus-4-8', 'user');
      assert.strictEqual(b.name, 'opus-user');
    });
    await t('pickBucket · Opus 4.7 auto → opus_auto (组合桶)', () => {
      const b = pickBucket('claude-opus-4-7', 'auto');
      assert.strictEqual(b.name, 'opus-auto');
    });
    await t('pickBucket · Opus 4.6/4.5 也算组合桶', () => {
      assert.strictEqual(pickBucket('claude-opus-4-6', 'user').name, 'opus-user');
      assert.strictEqual(pickBucket('claude-opus-4-5', 'user').name, 'opus-user');
    });
    await t('pickBucket · Sonnet 直通不 gate', () => {
      assert.strictEqual(pickBucket('claude-sonnet-4-6', 'user'), null);
    });
    await t('pickBucket · Haiku 直通不 gate', () => {
      assert.strictEqual(pickBucket('claude-haiku-4-5', 'auto'), null);
    });
    await t('pickBucket · 未知 model 直通', () => {
      assert.strictEqual(pickBucket('gpt-4', 'user'), null);
    });

    // 2. TokenBucket 基本 acquire
    await t('TokenBucket · 满桶立即拿 token', async () => {
      const b = new TokenBucket({ capacity: 3, refillIntervalMs: 100, name: 'test1' });
      const r = await b.acquire();
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.waitedMs, 0);
      assert.strictEqual(b.tokens, 2);
      b.stop();
    });

    // 3. TokenBucket 桶空排队 + refill 后放行
    await t('TokenBucket · 桶空排队 · refill 后依序放行', async () => {
      const b = new TokenBucket({ capacity: 2, refillIntervalMs: 150, name: 'test2' });
      // 拿光 2 个
      await b.acquire();
      await b.acquire();
      assert.strictEqual(b.tokens, 0);
      // 3 个排队
      const promises = [b.acquire(), b.acquire(), b.acquire()];
      const start = Date.now();
      const results = await Promise.all(promises);
      const elapsed = Date.now() - start;
      // 至少要 3 次 refill(每次 ~150ms) · 允许一些 slack
      assert.ok(results.every((r) => r.ok && !r.cancelled), 'all should succeed');
      assert.ok(elapsed >= 400, `expected >=400ms, got ${elapsed}ms`);
      // 顺序: waitedMs 递增
      assert.ok(results[0].waitedMs <= results[1].waitedMs);
      assert.ok(results[1].waitedMs <= results[2].waitedMs);
      b.stop();
    });

    // 4. cancelToken 立即释放不占坑
    await t('TokenBucket · cancelToken 立即释放不占坑', async () => {
      const b = new TokenBucket({ capacity: 1, refillIntervalMs: 10000, name: 'test3' });
      await b.acquire();     // 桶空
      const ct = new CancelToken();
      const pending = b.acquire({ cancelToken: ct });
      setTimeout(() => ct.cancel(), 50);
      const r = await pending;
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.cancelled, true);
      assert.ok(r.waitedMs >= 40 && r.waitedMs < 200, `waitedMs=${r.waitedMs}`);
      // waiter 数应清 0(下次 refill 时清理 settled)
      b.stop();
    });

    // 5. onQueueUpdate 100ms tick 收到
    await t('TokenBucket · onQueueUpdate 排队期间收到 update', async () => {
      const b = new TokenBucket({ capacity: 1, refillIntervalMs: 500, name: 'test4' });
      await b.acquire();
      const updates = [];
      const p = b.acquire({ onUpdate: (info) => updates.push(info) });
      await p;
      assert.ok(updates.length >= 2, `expected >=2 updates, got ${updates.length}`);
      assert.ok(updates.every((u) => u.bucketName === 'test4'));
      assert.ok(updates.every((u) => u.queuePos === 1));
      b.stop();
    });

    // 6. gateSubmit 非 Opus 直通 waitedMs=0 gated=false
    await t('gateSubmit · Sonnet 直通 gated=false', async () => {
      _reset();
      const r = await gateSubmit({ model: 'claude-sonnet-4-6', sourceKind: 'user' });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.gated, false);
      assert.strictEqual(r.waitedMs, 0);
    });

    // 7. gateSubmit Opus 4.8 user 从满桶拿
    await t('gateSubmit · Opus 4.8 user 满桶立取 gated=true', async () => {
      _reset();
      const r = await gateSubmit({ model: 'claude-opus-4-8', sourceKind: 'user' });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.gated, true);
      assert.strictEqual(r.bucketName, 'opus-user');
      assert.strictEqual(r.waitedMs, 0);
    });

    // 8. user / auto 桶隔离
    await t('gateSubmit · user 桶排队时 auto 桶不受影响', async () => {
      _reset();
      // 手工降低 user 桶容量 + 拉长 refill 让它慢
      configure({ opus_user: { capacity: 1, refillIntervalMs: 5000 } });
      await gateSubmit({ model: 'claude-opus-4-8', sourceKind: 'user' });   // 拿光 user
      // user 桶已空 · 现在 auto 桶还是满的 · auto submit 应立即通过
      const rAuto = await gateSubmit({ model: 'claude-opus-4-8', sourceKind: 'auto' });
      assert.strictEqual(rAuto.ok, true);
      assert.strictEqual(rAuto.bucketName, 'opus-auto');
      assert.ok(rAuto.waitedMs < 50, `expected <50ms, got ${rAuto.waitedMs}`);
    });

    // 9. configure hot-reload 参数调整
    await t('configure · 热调容量 · getStatus 反映新值', () => {
      _reset();
      configure({ opus_user: { capacity: 50, refillIntervalMs: 1000 } });
      const s = getStatus();
      assert.strictEqual(s.opus_user.capacity, 50);
      assert.strictEqual(s.opus_user.refillIntervalMs, 1000);
    });

    // 10. cancelToken 中断 gateSubmit
    await t('gateSubmit · cancelToken 中断排队', async () => {
      _reset();
      configure({ opus_user: { capacity: 1, refillIntervalMs: 10000 } });
      await gateSubmit({ model: 'claude-opus-4-8', sourceKind: 'user' });   // 拿光
      const ct = new CancelToken();
      const pending = gateSubmit({ model: 'claude-opus-4-8', sourceKind: 'user', cancelToken: ct });
      setTimeout(() => ct.cancel(), 30);
      const r = await pending;
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.cancelled, true);
      assert.strictEqual(r.bucketName, 'opus-user');
    });

    console.log(`\n${passed}/${total} passed`);
    _reset();
    process.exit(passed === total ? 0 : 1);
  })();
}
