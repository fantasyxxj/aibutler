// plugins/agent-bus.js — 中央大脑通道: 取件 + 按事件类型分派 handler。
//
// 拓扑(2026-07-19 β定案): 业务平台把任务型意图(translate.request 等)投到 VPS 的 bus 上,
// 这里长轮询取件, 按 ev.type 找 ../handlers/ 里的处理函数; handler 干完活通过
// ctx.send(command, content, corr) 把结果投回去(bus 的 /agent/exec 信封)。
//
// 循环/退避/游标/信封都不在这个文件里 —— 那些是 core/bus.js 的事。这里只剩
// **事件怎么分派给 handler** 这一件本地知识。
//
// cfg = { bus_base_url, store_token, agent, in_file, wait?, handlers }
//   agent    : 本机在这条 bus 上的名字(如 "butler-store-1"), 取件时按它过滤
//   in_file  : JSONL 审计副本, 游标水位存在它旁边的 .cursor
const { BusEndpoint, BusPoller } = require('../../core/bus');

class AgentBusChannel {
  constructor(cfg, personaName, onLog, handlers) {
    this.cfg = cfg || {};
    this.personaName = personaName || 'persona';
    this.onLog = onLog || (() => {});
    this.handlers = handlers || {};
    this.ep = null;
    this.poller = null;
    this._stopped = false;
  }

  // 取件状态住在 poller 里, 这几个是同一份状态的快捷读法(status() 里也有同样的值)。
  get stopped() { return this._stopped || !!(this.poller && this.poller.stopped); }
  get cursor() { return this.poller ? this.poller.cursor : 0; }
  get lastError() { return this.poller ? this.poller.lastError : null; }

  start() {
    if (this.stopped) return { ok: false, error: '已停止' };
    if (this.poller) return { ok: true, note: '已在跑' };
    if (!this.cfg.bus_base_url) return { ok: false, error: '缺 bus_base_url' };
    if (!this.cfg.store_token) return { ok: false, error: '缺 store_token' };
    if (!this.cfg.agent) return { ok: false, error: '缺 agent (如 butler-store-1)' };
    if (!this.cfg.in_file) return { ok: false, error: '缺 in_file' };

    this.ep = new BusEndpoint({
      id: 'agent_bus', kind: 'v1', base_url: this.cfg.bus_base_url,
      token: this.cfg.store_token, agent: this.cfg.agent, wait: this.cfg.wait,
    });
    this.poller = new BusPoller({
      endpoint: this.ep,
      tag: `agent-bus:${this.personaName}`,
      onLog: this.onLog,
      auditFile: this.cfg.in_file,
      cursorFile: this.cfg.in_file + '.cursor',
      onItem: (it) => this._dispatch(it.raw),
    });
    const r = this.poller.start();
    return r.ok ? { ok: true, mode: 'agent-bus' } : r;
  }

  async _dispatch(ev) {
    const type = ev.type;
    const payload = ev.payload || {};
    const handler = this.handlers[type];
    if (!handler) {
      this.onLog(`[agent-bus:${this.personaName}] ⓘ seq=${ev.seq} type=${type} 无 handler, 跳过`);
      return;
    }
    const corr = payload.correlation_id || null;
    this.onLog(`[agent-bus:${this.personaName}] in <- seq=${ev.seq} type=${type}${corr ? ' corr=' + corr : ''}`);
    const ctx = {
      onLog: this.onLog,
      agent: this.cfg.agent,
      send: (command, content, correlationId) => this.send(command, content, correlationId),
    };
    try {
      await handler(payload, ctx);
    } catch (e) {
      this.onLog(`[agent-bus:${this.personaName}]⚠ handler ${type} 抛异常: ${e && e.message}`);
      // 失败也得让对面停止等待, 但目前 bus 上没有回报失败的 command ——
      // 管理端 UI 有 60s 超时窗口兜着, 这里只留下日志。
      if (corr) this.onLog(`[agent-bus:${this.personaName}] corr=${corr} 无回报, 管理端会超时`);
    }
  }

  // handler 回报: 自动投递没人补发, 所以带重试(幂等键整轮复用, 不会变成两笔)。
  async send(command, content, correlationId) {
    if (!this.ep) return { ok: false, error: '通道未启动' };
    const r = await this.ep.exec({ command, content, correlationId: correlationId || null, retries: 2 });
    if (r.ok) {
      this.onLog(`[agent-bus:${this.personaName}] out -> /exec ${command}${correlationId ? ' corr=' + correlationId : ''}`);
      return { ok: true, result: r.text };
    }
    this.onLog(`[agent-bus:${this.personaName}]⚠ /exec 失败: ${r.error}`);
    return { ok: false, error: r.error };
  }

  status() {
    const s = this.poller ? this.poller.status() : { running: false, cursor: 0, msgCount: 0, lastError: null };
    return { mode: 'agent-bus', ...s, agent: this.cfg.agent };
  }

  async stop() {
    this._stopped = true;
    if (this.poller) await this.poller.stop();
    return { ok: true };
  }
}

module.exports = { AgentBusChannel };
