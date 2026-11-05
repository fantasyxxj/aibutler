// plugins/line-relay.js — LINE 收件通道(长轮询)。**只收不发。**
//
// 拓扑(2026-07-16): LINE webhook 落在 VPS 的 bus 上(这台机器在 NAT 后面收不到),
// 所以这里像 tg-native.js 轮询 getUpdates 那样, 长轮询 GET /bus/v1/line/inbox。
//
// 出向不在这里 —— 发 LINE 是 bus 上的一个 command, 由能力包声明的工具或 bus_exec 投递
// (作者 2026-08-24: 「发送 line 其实是 bus 里面的一个功能, 不是一个专门的工具」)。
// 循环/退避/游标落盘也不在这里, 那是 core/bus.js 的 BusPoller 的事。这个文件只剩
// **LINE 事件长什么样**这一件本地知识。
//
// cfg = { bus_base_url, store_token, in_file, wait? }
//   in_file: JSONL 审计副本, 游标水位存在它旁边的 .cursor
const { BusEndpoint, BusPoller } = require('../../core/bus');

class LineRelayChannel {
  constructor(cfg, personaName, onLog, onMessage) {
    this.cfg = cfg || {};
    this.personaName = personaName || 'persona';
    this.onLog = onLog || (() => {});
    this.onMessage = onMessage || null;
    this.poller = null;
    this.stopped = false;
  }

  start() {
    if (this.stopped) return { ok: false, error: '已停止' };
    if (this.poller) return { ok: true, note: '已在跑' };
    if (!this.cfg.bus_base_url) return { ok: false, error: '缺 bus_base_url' };
    if (!this.cfg.store_token) return { ok: false, error: '缺 store_token' };
    if (!this.cfg.in_file) return { ok: false, error: '缺 in_file' };

    const ep = new BusEndpoint({
      id: 'line', kind: 'v1', base_url: this.cfg.bus_base_url,
      token: this.cfg.store_token, wait: this.cfg.wait,
      inbox_path: '/bus/v1/line/inbox',
    });
    this.poller = new BusPoller({
      endpoint: ep,
      tag: `line-relay:${this.personaName}`,
      onLog: this.onLog,
      auditFile: this.cfg.in_file,
      cursorFile: this.cfg.in_file + '.cursor',
      onItem: (it) => this._deliver(it.raw),
    });
    const r = this.poller.start();
    return r.ok ? { ok: true, mode: 'relay' } : r;
  }

  async _deliver(ev) {
    const tStart = Date.now();
    this.onLog(`[LATENCY] handle_start eid=${ev.event_id} seq=${ev.seq} type=${ev.type}`);
    const record = {
      seq: ev.seq, event_id: ev.event_id, type: ev.type,
      line_user_id: ev.line_user_id, is_owner: !!ev.is_owner,
      iso: ev.timestamp, text: (ev.payload && ev.payload.text) || '',
      payload: ev.payload || {}, fallback_sent: !!ev.fallback_sent,
    };
    const preview = (record.text || `[${record.type}]`).slice(0, 40).replace(/\n/g, ' ');
    this.onLog(`[line-relay:${this.personaName}] in <- ${record.is_owner ? '店主' : record.line_user_id} "${preview}"${record.fallback_sent ? ' (已发兜底)' : ''}`);
    if (this.onMessage) {
      const ret = this.onMessage(record);
      if (ret && typeof ret.then === 'function') await ret;
    }
    this.onLog(`[LATENCY] handle_done eid=${ev.event_id} dt_handle=${Date.now() - tStart}ms`);
  }

  status() {
    const s = this.poller ? this.poller.status() : { running: false, cursor: 0, msgCount: 0, lastError: null };
    return { mode: 'relay', ...s };
  }

  async stop() {
    this.stopped = true;
    if (this.poller) await this.poller.stop();
    return { ok: true };
  }
}

module.exports = { LineRelayChannel };
