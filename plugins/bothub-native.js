// plugins/bothub-native.js — butler 内在直连 agent-bus (HTTP long-ish polling), 无外部进程。
// 每 endpoint 一个循环独立跑, 挂一个不影响别的 (需求5: 每人格多 endpoint)。
// 收到新消息 → 触发 onWake 回调 (让 butler 直接醒来处理)。
// offset 落盘 (memoryDir/.bothub_offset.json), butler 重启/关重开都记得"处理到哪",
// 不再把 agent-bus 上不断进来的新消息当"没读过"重复拉。
const fs = require('fs');
const path = require('path');

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
    this.offsetFile = cfg && cfg._offsetDir ? path.join(cfg._offsetDir, '.bothub_offset.json') : null;
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
    });
    return { ok: true, mode: 'native', count: eps.length };
  }

  async _loop(ep, idx) {
    if (!ep.url || !ep.agent) {
      this.lastErrors.set(idx, '缺 url/agent'); this.onLog(`[bothub:${this.personaName}#${idx}]⚠ 缺 url/agent, 停`);
      return;
    }
    // 有落盘 offset 就直接续上, 不 peek。
    // 无 (初次): peek 需要循环拉——agent-bus 分页升序每页 ≤50 条, 一页 max 只是分页 tail 不是真 tail。
    // 一直拉到某页 <PAGE_SIZE 条 (=到达真 tail), 那时 offset 才是真当前 max。全程不触发 wake。
    if (!this.offsets.get(idx)) {
      const PAGE = 50;
      const HARD_CAP = 200;   // 防死循环: 最多拉 200 页 (10000 条历史 = 极限)
      let cur = 0, pages = 0, total = 0;
      try {
        while (pages < HARD_CAP) {
          const url0 = `${ep.url.replace(/\/$/, '')}/inbox?agent=${encodeURIComponent(ep.agent)}&after_id=${cur}`;
          const resp0 = await fetch(url0, { headers: this._headers(ep), signal: AbortSignal.timeout(20000) });
          if (!resp0.ok) throw new Error('HTTP ' + resp0.status);
          const j0 = await resp0.json();
          const msgs0 = j0.messages || [];
          if (!msgs0.length) break;
          const mx = Math.max(...msgs0.map((m) => m.id || 0));
          cur = mx; total += msgs0.length; pages += 1;
          if (msgs0.length < PAGE) break;   // 到 tail
        }
        this.offsets.set(idx, cur); this._saveOffsets();
        this.onLog(`[bothub:${this.personaName}#${idx}] 首启跳积压 → offset=${cur} (${total} 条历史 / ${pages} 页, 不处理)`);
      } catch (e) {
        this.onLog(`[bothub:${this.personaName}#${idx}]⚠ 首启 peek 失败: ${e.message} — 用最后拿到的 offset=${cur} 兜底`);
        if (cur) { this.offsets.set(idx, cur); this._saveOffsets(); }
      }
    } else {
      this.onLog(`[bothub:${this.personaName}#${idx}] 从落盘 offset=${this.offsets.get(idx)} 续上`);
    }

    let backoff = 2000;
    const interval = ep.poll_interval || 15000;
    while (!this.stopped) {
      try {
        const off = this.offsets.get(idx) || 0;
        const url = `${ep.url.replace(/\/$/, '')}/inbox?agent=${encodeURIComponent(ep.agent)}&after_id=${off}`;
        const resp = await fetch(url, { headers: this._headers(ep), signal: AbortSignal.timeout(30000) });
        if (resp.status === 401 || resp.status === 403) {
          this.onLog(`[bothub:${this.personaName}#${idx}]⚠ token 无效 (HTTP ${resp.status}), 停轮询`);
          this.lastErrors.set(idx, 'token 无效'); return;
        }
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const j = await resp.json();
        // 防呆: 只处理 id > 当前 offset 的 (万一 API 返回旧消息就不会死循环)
        const offBefore = this.offsets.get(idx) || 0;
        const msgs = (j.messages || []).filter((m) => (m.id || 0) > offBefore);
        if (msgs.length) {
          // 分离心跳/静默 vs 真消息: 全部推 offset+落盘, 但只有真消息触发 wake
          const silentMsgs = msgs.filter(isSilentMsg);
          const wakeMsgs = msgs.filter((m) => !isSilentMsg(m));
          for (const m of msgs) {
            this.offsets.set(idx, Math.max(this.offsets.get(idx) || 0, m.id || 0));
            this.msgCounts.set(idx, (this.msgCounts.get(idx) || 0) + 1);
          }
          this._saveOffsets();
          if (silentMsgs.length) this.onLog(`[bothub:${this.personaName}#${idx}] 静默ack ${silentMsgs.length} 条心跳 (offset→${this.offsets.get(idx)})`);
          if (wakeMsgs.length) {
            const froms = [...new Set(wakeMsgs.map((m) => m.from_agent || '?'))].join(',');
            this.onLog(`[bothub:${this.personaName}#${idx}] <- ${wakeMsgs.length} 条 from ${froms} (offset→${this.offsets.get(idx)})`);
            try { this.onWake({ endpoint: idx, url: ep.url, agent: ep.agent, count: wakeMsgs.length, offset: this.offsets.get(idx) }); }
            catch (e) { this.onLog(`[bothub:${this.personaName}#${idx}]⚠ onWake 抛错: ${e.message}`); }
          }
        }
        this.lastErrors.set(idx, null);
        backoff = 2000;
        // 无消息等 interval; 有消息立刻再拉 (可能连续来)
        if (!msgs.length) await new Promise((r) => setTimeout(r, interval));
      } catch (e) {
        if (this.stopped) return;
        this.lastErrors.set(idx, e && e.message);
        this.onLog(`[bothub:${this.personaName}#${idx}]⚠ ${e.message} · 退避 ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 120000);
      }
    }
  }

  _headers(ep) {
    const h = { 'accept': 'application/json' };
    if (ep.token) h['authorization'] = `Bearer ${ep.token}`;
    return h;
  }

  async stop() { this.stopped = true; return { ok: true }; }

  status() {
    return {
      mode: 'native', running: !this.stopped && !!this.startedAt,
      endpoints: (this.cfg.endpoints || []).map((ep, i) => ({
        url: ep.url, agent: ep.agent, offset: this.offsets.get(i) || 0,
        msgCount: this.msgCounts.get(i) || 0, lastError: this.lastErrors.get(i) || null,
      })),
    };
  }
}

module.exports = { BothubNativeChannel };
