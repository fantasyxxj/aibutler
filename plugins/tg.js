// plugins/tg.js — TG 插件 dispatcher: 根据 mode 挂对应实现。
// v2 (2026-07-07): 删 python 托管方案 (managed spawn), butler 内在直抓才是正道 (知秋定)。
// mode:
//   'native' → butler JS long polling 直连 TG (plugins/tg-native.js), 通道在 butler 肚子里
//   'off'    → 该人格不启 TG (缺省)
const path = require('path');
const { TgNativeChannel } = require('./tg-native');

class TgPlugin {
  // memoryDir: 人格记忆目录, 用来给 in_file 计算默认值
  // onMessage(record): 每条新消息落盘后触发 (v2 · 拉到消息直接唤醒 butler, 不再靠 main.js 盯水位线)
  constructor(cfg, personaName, onLog, memoryDir, onMessage) {
    this.cfg = { ...(cfg || {}) };
    this.personaName = personaName || 'persona';
    this.onLog = onLog || (() => {});
    this.onMessage = onMessage || null;
    this.impl = null;   // TgNativeChannel 或 null
    // 默认 in_file: 人格 memoryDir 下的 tg_inbox.jsonl, 跟 memory_index.json 同目录
    // 显式配了就用配的; 没配 + 有 memoryDir 就落默认。仍缺 → tg-native.js start 时会报错
    if (!this.cfg.in_file && memoryDir) {
      this.cfg.in_file = path.join(memoryDir, 'tg_inbox.jsonl');
    }
  }

  get mode() { return this.cfg.mode || (this.cfg.enabled ? 'native' : 'off'); }

  start(homeDir) {
    if (this.impl) return { ok: true, note: '已在跑' };
    if (this.mode !== 'native') return { ok: true, mode: this.mode };
    this.impl = new TgNativeChannel(this.cfg, this.personaName, this.onLog, this.onMessage);
    return this.impl.start();
  }

  async stop() {
    if (!this.impl) return { ok: true };
    const r = await this.impl.stop();
    this.impl = null;
    return r;
  }

  status() {
    if (!this.impl) return { mode: this.mode, running: false };
    return this.impl.status();
  }
}

module.exports = { TgPlugin };
