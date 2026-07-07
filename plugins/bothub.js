// plugins/bothub.js — bothub / agent-bus 插件 dispatcher。
// v2 (2026-07-07): 删 python 托管方案, native JS 直抓 (plugins/bothub-native.js)。
// mode:
//   'native' → butler 内 JS 轮询 agent-bus (支持每人格多 endpoint), 收到新消息触发 onWake
//   'off'    → 缺省
const { BothubNativeChannel } = require('./bothub-native');

class BothubPlugin {
  constructor(cfg, personaName, onLog, onWake) {
    this.cfg = cfg || {};
    this.personaName = personaName || 'persona';
    this.onLog = onLog || (() => {});
    this.onWake = onWake || (() => {});
    this.impl = null;
  }

  get mode() {
    if (this.cfg.mode) return this.cfg.mode;
    return (this.cfg.enabled && Array.isArray(this.cfg.endpoints) && this.cfg.endpoints.length) ? 'native' : 'off';
  }

  start(homeDir) {
    if (this.impl) return { ok: true, note: '已在跑' };
    if (this.mode !== 'native') return { ok: true, mode: this.mode };
    this.impl = new BothubNativeChannel(this.cfg, this.personaName, this.onLog, this.onWake);
    return this.impl.start();
  }

  async stop() {
    if (!this.impl) return { ok: true };
    const r = await this.impl.stop();
    this.impl = null;
    return r;
  }

  status() {
    if (!this.impl) return { mode: this.mode, running: false, endpoints: [] };
    return this.impl.status();
  }
}

module.exports = { BothubPlugin };
