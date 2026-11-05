// plugins/bothub-native.js — butler 内在直连 agent-bus (HTTP long-ish polling), 无外部进程。
// 每 endpoint 一个循环独立跑, 挂一个不影响别的 (需求5: 每人格多 endpoint)。
// 收到新消息 → 触发 onWake 回调 (让 butler 直接醒来处理)。
// offset 落盘 (memoryDir/.bothub_offset.json), butler 重启/关重开都记得"处理到哪",
// 不再把 agent-bus 上不断进来的新消息当"没读过"重复拉。
//
// 取件循环本身归 core/bus.js 的 BusPoller; 这个文件留下的是**分级唤醒** ——
// 哪些消息值得把 butler 叫醒, 哪些只推游标就算了。
const fs = require('fs');
const path = require('path');
const { BusEndpoint, BusPoller } = require('../../core/bus');
const { revokeLocalToken } = require('../../core/hub-join');
const { BothubInbox } = require('./bothub-inbox');

// 心跳/无价值消息静默 ack: offset 照推 + 落盘, 但不 wake butler (不消耗上下文, 不打扰)。
// 起步用硬编码规则 (猫猫心跳 5 分钟一次, 一天 288 次太吵); 后期可迁 registry.plugins.bothub.silent_filters 配置化。
const SILENT_PATTERNS = [
  { from_agent: 'dc_cursor_bot', text_starts: '【猫猫·心跳' },
  { text_starts: '【心跳' },   // 通用心跳前缀兜底
];
function isSilentMsg(m) {
  return SILENT_PATTERNS.some((p) =>
    (!p.from_agent  || m.from_agent === p.from_agent) &&
    (!p.text_starts || String(m.text || '').startsWith(p.text_starts))
  );
}

// —— 分级唤醒过滤 (v1 2026-07-17 只给 worker_ant; v2 2026-08-20 作者拍板对所有 endpoint 一视同仁) ——
// silent: 只推 offset 不唤醒 (服务端未读游标不动, 下次真唤醒时无参拉 inbox 一起带出, 不丢)
// immediate: 立即唤醒 — 仅 [P0- (狂人确认: P1 值班协议本义"记录不打扰", 同 wf 15min 再来才升 P0, 立即唤醒反违协议)
// debounce: 其余全部 — 攒 10 分钟或 5 条 (先到为准) 合并成一次 submit
// 兜底: 静默堆积且 6h 无任何唤醒 → 发一次扫尾唤醒
const WAKE_FILTER = {
  silentKinds: ['reply', 'ack', 'heartbeat'],
  silentPrefixes: ['[ACK]', '[REPLY]', '[P2-'],
  immediatePrefixes: ['[P0-'],
  immediateKinds: [],
  debounceMs: 10 * 60 * 1000,
  debounceMax: 5,
  sweepAfterMs: 6 * 3600 * 1000,
};
// 规则按序: 先静默 → 再立即 → 其余 debounce
function classifyBusMsg(m) {
  const kind = String((m.payload && m.payload.kind) || '').toLowerCase();
  const text = String(m.text || '');
  if (WAKE_FILTER.silentKinds.includes(kind)) return 'silent';
  if (WAKE_FILTER.silentPrefixes.some((p) => text.startsWith(p))) return 'silent';
  if (isSilentMsg(m)) return 'silent';   // 沿用全局心跳规则 (猫猫心跳无 payload.kind)
  if (WAKE_FILTER.immediatePrefixes.some((p) => text.startsWith(p))) return 'immediate';
  if (WAKE_FILTER.immediateKinds.includes(kind)) return 'immediate';
  return 'debounce';
}

class BothubNativeChannel {
  // cfg = { endpoints: [{ url, agent, token, poll_interval? }], _offsetDir? }
  // _offsetDir = 保存 .bothub_offset.json 的目录 (main.js 传入 = 人格 memoryDir)
  constructor(cfg, personaName, onLog, onWake) {
    this.cfg = cfg || {};
    this.personaName = personaName || 'persona';
    this.onLog = onLog || (() => {});
    this.onWake = onWake || (() => {});
    this.stopped = false;
    this.offsets = new Map();       // idx → 已 ack 到的最大 id
    this.lastErrors = new Map();
    this.msgCounts = new Map();
    this.startedAt = 0;
    this.pollers = new Map();       // idx → BusPoller
    this.offsetFile = cfg && cfg._offsetDir ? path.join(cfg._offsetDir, '.bothub_offset.json') : null;
    this.auditFile = cfg && cfg._offsetDir ? path.join(cfg._offsetDir, 'bothub_messages.jsonl') : null;
    // 收件箱: 拉到的消息先落这里再推游标, 交付成功才标 done(见 bothub-inbox.js)。没给目录(单测)就不落, 照旧用内存里那批。
    this.inbox = cfg && cfg._offsetDir ? new BothubInbox(path.join(cfg._offsetDir, '.bothub_inbox.json'), this.onLog) : null;
    this.retryTimers = new Map();      // idx → 交付失败后的重交定时器
    this.gradeStates = new Map();      // idx → { pending, silentCount, timer, lastWakeAt }
    this.tuning = { debounceMs: WAKE_FILTER.debounceMs, debounceMax: WAKE_FILTER.debounceMax, sweepAfterMs: WAKE_FILTER.sweepAfterMs, ...((cfg && cfg._tuning) || {}) };
    this._loadOffsets();
  }

  // 落盘 offset 到 memoryDir/.bothub_offset.json (butler 重启不丢)
  // 结构: { "<endpointUrl>|<agent>": maxId, ... } — 用 url+agent 做 key, endpoint 顺序变了也能对上
  _loadOffsets() {
    if (!this.offsetFile) return;
    try {
      if (!fs.existsSync(this.offsetFile)) return;
      const j = JSON.parse(fs.readFileSync(this.offsetFile, 'utf8'));
      (this.cfg.endpoints || []).forEach((ep, i) => {
        const k = `${ep.url}|${ep.agent}`;
        if (typeof j[k] === 'number') this.offsets.set(i, j[k]);
      });
    } catch (_) {}
  }
  _saveOffsets() {
    if (!this.offsetFile) return;
    try {
      const j = {};
      (this.cfg.endpoints || []).forEach((ep, i) => {
        const off = this.offsets.get(i);
        if (off) j[`${ep.url}|${ep.agent}`] = off;
      });
      fs.mkdirSync(path.dirname(this.offsetFile), { recursive: true });
      fs.writeFileSync(this.offsetFile, JSON.stringify(j, null, 2), 'utf8');
    } catch (e) { this.onLog(`[bothub:${this.personaName}]⚠ offset 落盘失败: ${e.message}`); }
  }

  start() {
    if (this.stopped) return { ok: false, error: '已停止' };
    if (this.startedAt) return { ok: true, note: '已在跑' };
    const eps = Array.isArray(this.cfg.endpoints) ? this.cfg.endpoints : [];
    if (!eps.length) return { ok: true, note: '无 endpoint, 不启' };
    this.startedAt = Date.now();
    eps.forEach((ep, i) => {
      // offset 优先级: 落盘持久值(_loadOffsets 已恢复) > peek 拿到的当前 max > 0
      // 有落盘值 = butler 之前处理到这里了, 直接续上不重跑
      if (!this.offsets.has(i)) this.offsets.set(i, 0);
      this._loop(ep, i).catch((e) => this.onLog(`[bothub:${this.personaName}#${i}]⚠ loop 崩溃: ${e && e.message}`));
      // 上次没交出去的(攒批中 / 人格忙时挂起 / 交付失败时关了 app): 一开门就补交。
      const left = this.inbox ? this.inbox.pending(this._epKey(i)).length : 0;
      if (left) this._flush(ep, i, left, `补交上次没交出去的 ${left} 条`, 'batched', []);
    });
    return { ok: true, mode: 'native', count: eps.length };
  }

  async _loop(ep, idx) {
    if (!ep.url || !ep.agent) {
      this.lastErrors.set(idx, '缺 url/agent'); this.onLog(`[bothub:${this.personaName}#${idx}]⚠ 缺 url/agent, 停`);
      return;
    }
    const endpoint = new BusEndpoint({
      id: ep.id || `bothub${idx}`, kind: 'bothub', base_url: ep.url,
      token: ep.token, agent: ep.agent, poll_interval: ep.poll_interval,
    });
    if (!this.offsets.get(idx)) await this._skipBacklog(endpoint, idx);
    else this.onLog(`[bothub:${this.personaName}#${idx}] 从落盘 offset=${this.offsets.get(idx)} 续上`);
    if (this.stopped) return;

    const poller = new BusPoller({
      endpoint,
      tag: `bothub:${this.personaName}#${idx}`,
      onLog: this.onLog,
      auditFile: this.auditFile,
      // offset 不是"一个文件一个数": 多 endpoint 共用一份 JSON, 所以自己接管读写。
      loadCursor: () => this.offsets.get(idx) || 0,
      saveCursor: (c) => { this.offsets.set(idx, c); this._saveOffsets(); },
      // 整批交付而不是逐条: 唤不唤醒要看这一批里有没有 P0、够不够攒满, 逐条看不出来。
      onBatch: (items) => {
        this.lastErrors.set(idx, null);
        this._process(ep, idx, items.map((it) => it.payload));
      },
      // P0 SLA: 3s (原 15s → avg 7.5s 超了 5s 目标 · 狂人 2026-07-20 派单)。有消息不等, 立刻再拉。
      idleMs: ep.poll_interval || 3000,
      // 🔴 token 失效(后台撤了 / 本地那份坏了)时把本地那份也清掉 —— 不清的话面板一直显示
      // 「已连接」而实际一条都收不到, 用户连重新申请的入口都没有。清掉后它回到「申请」那屏。
      onError: (e) => {
        if (!e || e.phase !== 'auth') return;
        const r = revokeLocalToken(ep.agent);
        if (r && r.cleared) {
          this.onLog(`[bothub:${this.personaName}#${idx}] token 已失效, 本地那份也清了 —— 面板回到「申请」`);
        }
      },
    });
    this.pollers.set(idx, poller);
    const r = poller.start();
    if (!r.ok) { this.lastErrors.set(idx, r.error); this.onLog(`[bothub:${this.personaName}#${idx}]⚠ 启动失败: ${r.error}`); }
  }

  _epKey(idx) { const ep = (this.cfg.endpoints || [])[idx] || {}; return `${ep.url}|${ep.agent}`; }

  // 一批新消息落地: 先写进收件箱, 再推 offset+落盘, 再走分级唤醒。
  // 🔴 顺序不能反: 游标一推, 服务端就不会再给这批; 收件箱写失败就抛, BusPoller 不推游标、退避后重拉。
  _process(ep, idx, msgs) {
    if (this.inbox) this.inbox.add(this._epKey(idx), msgs.filter((m) => classifyBusMsg(m) !== 'silent'));
    for (const m of msgs) {
      this.offsets.set(idx, Math.max(this.offsets.get(idx) || 0, m.id || 0));
      this.msgCounts.set(idx, (this.msgCounts.get(idx) || 0) + 1);
    }
    this._saveOffsets();
    return this._processGraded(ep, idx, msgs);
  }

  // 首启跳积压: agent-bus 分页升序每页 ≤50 条, 一页的 max 只是**分页 tail** 不是真 tail。
  // 一直拉到某页不满 (=真 tail) 才算数。全程只推 offset, 不唤醒。
  async _skipBacklog(endpoint, idx) {
    const PAGE = 50;
    const HARD_CAP = 200;   // 防死循环: 最多 200 页 (10000 条历史 = 极限)
    let cur = 0, pages = 0, total = 0;
    try {
      while (pages < HARD_CAP && !this.stopped) {
        const { items, nextCursor } = await endpoint.poll({ cursor: cur });
        if (!items.length) break;
        cur = nextCursor; total += items.length; pages += 1;
        if (items.length < PAGE) break;
      }
      this.offsets.set(idx, cur); this._saveOffsets();
      this.onLog(`[bothub:${this.personaName}#${idx}] 首启跳积压 → offset=${cur} (${total} 条历史 / ${pages} 页, 不处理)`);
    } catch (e) {
      this.onLog(`[bothub:${this.personaName}#${idx}]⚠ 首启 peek 失败: ${e.message} — 用最后拿到的 offset=${cur} 兜底`);
      if (cur) { this.offsets.set(idx, cur); this._saveOffsets(); }
    }
  }

  _gradeState(idx) {
    let st = this.gradeStates.get(idx);
    if (!st) { st = { pending: 0, pendingMsgs: [], silentCount: 0, timer: null, lastWakeAt: Date.now() }; this.gradeStates.set(idx, st); }
    return st;
  }

  // 分级过滤: silent 静默 / immediate 立即 / debounce 攒批
  _processGraded(ep, idx, msgs) {
    const st = this._gradeState(idx);
    const immediateMsgs = [], debouncedMsgs = [];
    let silent = 0;
    for (const m of msgs) {
      const c = classifyBusMsg(m);
      if (c === 'silent') silent += 1;
      else if (c === 'immediate') immediateMsgs.push(m);
      else debouncedMsgs.push(m);
    }
    if (silent) {
      st.silentCount += silent;
      this.onLog(`[bothub:${this.personaName}#${idx}] 静默ack ${silent} 条 (累积 ${st.silentCount}, offset→${this.offsets.get(idx)})`);
    }
    if (immediateMsgs.length) {   // 立即唤醒顺带清空 debounce 积压 (msgs 一起带出, AI 一看即答不用二次 GET)
      const pending = st.pendingMsgs.slice();
      const all = pending.concat(debouncedMsgs, immediateMsgs);
      this._flush(ep, idx, all.length, 'P0/P1/actionable', 'immediate', all);
      return;
    }
    if (debouncedMsgs.length) {
      st.pending += debouncedMsgs.length;
      st.pendingMsgs.push(...debouncedMsgs);
      if (st.pending >= this.tuning.debounceMax) {
        this._flush(ep, idx, st.pending, `攒满 ${this.tuning.debounceMax} 条`, 'batched', st.pendingMsgs.slice());
      } else {
        this.onLog(`[bothub:${this.personaName}#${idx}] debounce 攒 ${st.pending} 条 (满 ${this.tuning.debounceMax} 条或 ${Math.round(this.tuning.debounceMs / 60000)}min 触发)`);
        if (!st.timer) {
          st.timer = setTimeout(() => {
            st.timer = null;
            if (st.pending && !this.stopped) this._flush(ep, idx, st.pending, 'debounce 到点', 'batched', st.pendingMsgs.slice());
          }, this.tuning.debounceMs);
          if (st.timer.unref) st.timer.unref();
        }
      }
      return;
    }
    // 纯静默批: 堆积且长时间无任何唤醒 → 扫尾唤醒兜底 (无实体 msgs, 只发 count 提示)
    if (silent && st.silentCount > 0 && Date.now() - st.lastWakeAt >= this.tuning.sweepAfterMs) {
      this._flush(ep, idx, st.silentCount, `${Math.round(this.tuning.sweepAfterMs / 3600000)}h 扫尾`, 'sweep', []);
    }
  }

  // kind: 'immediate' (P0/actionable · main.js 里走 _bypassRateGate) / 'batched' (debounce 攒批) / 'sweep' (扫尾) — 传到 onWake 让上层决定 rate-gate 策略
  // msgs: 实体消息数组 (含 id/from_agent/text/payload); sweep 时可为空数组
  _flush(ep, idx, count, why, kind, msgs) {
    const st = this._gradeState(idx);
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    st.pending = 0; st.pendingMsgs = []; st.silentCount = 0; st.lastWakeAt = Date.now();
    // 有收件箱时交付的是收件箱里**所有**还没交出去的, 不只是内存里攒的这批 —— 上次失败放回去的也一起带上。
    let ack = () => {};
    if (this.inbox && kind !== 'sweep') {
      const key = this._epKey(idx);
      msgs = this.inbox.pending(key);
      if (!msgs.length) return;
      count = msgs.length;
      const settle = this.inbox.claim(key, msgs);
      ack = (ok) => {
        settle(ok);
        if (!ok) this._retryLater(ep, idx);
      };
    }
    this.onLog(`[bothub:${this.personaName}#${idx}] 唤醒(${why}) ${count} 条 (offset→${this.offsets.get(idx)}, kind=${kind || 'batched'})`);
    this._wake(ep, idx, Math.max(count, 1), kind || 'batched', msgs || [], ack);
  }

  // 交付没成(submit 抛错 / 被挡下没进队列): 消息已放回收件箱, 过一会儿再交一次。
  _retryLater(ep, idx) {
    if (this.stopped || this.retryTimers.get(idx)) return;
    const t = setTimeout(() => {
      this.retryTimers.delete(idx);
      if (!this.stopped) this._flush(ep, idx, 0, '上次交付没成, 重交', 'batched', []);
    }, this.tuning.retryMs || 60 * 1000);
    if (t.unref) t.unref();
    this.retryTimers.set(idx, t);
  }

  // ack(ok): 上层交付有了结果就调一次 —— ok 才在收件箱里标已交付, 否则放回去重交。没收件箱时是空函数。
  _wake(ep, idx, count, kind, msgs, ack) {
    ack = ack || (() => {});
    try { this.onWake({ endpoint: idx, url: ep.url, agent: ep.agent, count, offset: this.offsets.get(idx), kind: kind || 'batched', msgs: msgs || [], ack }); }
    catch (e) { this.onLog(`[bothub:${this.personaName}#${idx}]⚠ onWake 抛错: ${e.message}`); ack(false); }
  }

  async stop() {
    this.stopped = true;
    for (const p of this.pollers.values()) await p.stop();
    for (const st of this.gradeStates.values()) if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
    return { ok: true };
  }

  status() {
    return {
      mode: 'native', running: !this.stopped && !!this.startedAt,
      endpoints: (this.cfg.endpoints || []).map((ep, i) => ({
        url: ep.url, agent: ep.agent, offset: this.offsets.get(i) || 0,
        msgCount: this.msgCounts.get(i) || 0, lastError: this.lastErrors.get(i) || null,
        ...(this.gradeStates.has(i) ? { gradePending: this.gradeStates.get(i).pending, gradeSilent: this.gradeStates.get(i).silentCount } : {}),
      })),
    };
  }
}

module.exports = { BothubNativeChannel, classifyBusMsg, WAKE_FILTER };
