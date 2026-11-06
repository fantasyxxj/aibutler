// channels/index.js — 人格的统一消息通道(作者 2026-11-06 定: 通道做成同一个适配器口, 配好的
// 通道人格想往哪发就往哪发)。
//
// 配置在 personas.json 的 plugins.channels: [{ id, type, label, enabled, ...各类型字段 }]。
// Telegram(plugins.tg) 与 AIHUB(plugins.buses) 仍走各自的老路, 这里只管新接的类型。
//
// 每种类型一个适配器模块, 导出 { dir: 'two'|'send', create(cfg, ctx) }; create 返回
//   { start(): Promise|void, stop(): Promise|void, status(): {...}, send({ to, text }): Promise<{ok, error?, note?}> }
// 双向的收到消息调 ctx.onMessage({ from_id, from_name, chat_id, chat_name, text }), 宿主负责
// 交给人格。只发的(群 webhook)没有收件, 也就没有 chat 可回 —— send 时 to 可以不填。
// 双向的模块另导出 check(cfg): 只验凭据不连长连接, 给「检查凭据」按钮用。共用底座在 socket.js。
'use strict';
const path = require('path');
const fs = require('fs');

const TYPES = {
  dingtalk_hook: require('./webhook').dingtalk,
  feishu_hook: require('./webhook').feishu,
  wecom_hook: require('./webhook').wecom,
  feishu_bot: require('./feishu'),
  dingtalk_bot: require('./dingtalk'),
  discord: require('./discord'),
  slack: require('./slack'),
};
const TYPE_NAMES = {
  dingtalk_hook: 'DingTalk group bot', feishu_hook: 'Feishu group bot', wecom_hook: 'WeCom group bot',
  feishu_bot: 'Feishu app bot', dingtalk_bot: 'DingTalk app bot', discord: 'Discord bot', slack: 'Slack app',
};

class ChannelHost {
  // stateFile: 人格记忆目录下一份小 json, 记每条通道最后跟谁说过话 —— 人格说「发到飞书」不带对象时就发给他
  constructor({ personaName, log, stateFile, onMessage }) {
    this.personaName = personaName || 'persona';
    this.log = log || (() => {});
    this.stateFile = stateFile;
    this.onMessage = onMessage || null;
    this.running = new Map();   // id → { spec, impl, dir }
    this.state = {};
    try { this.state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch (_) { this.state = {}; }
  }

  async install(specs) {
    await this.stopAll();
    for (const spec of (Array.isArray(specs) ? specs : [])) {
      if (!spec || !spec.id || spec.enabled === false) continue;
      const T = TYPES[spec.type];
      if (!T) { this.log(`[channel:${this.personaName}] 不认识的通道类型 ${spec.type}, 跳过 ${spec.id}`); continue; }
      const ctx = {
        log: (m) => this.log(`[channel:${this.personaName}:${spec.id}] ${m}`),
        onMessage: (rec) => this._inbound(spec, rec),
      };
      try {
        const impl = T.create(spec, ctx);
        this.running.set(spec.id, { spec, impl, dir: T.dir });
        await impl.start();
        ctx.log(`✅ 已启动 (${spec.type})`);
      } catch (e) { this.log(`[channel:${this.personaName}:${spec.id}] 启动失败: ${e && e.message}`); }
    }
  }

  async stopAll() {
    for (const { impl } of this.running.values()) { try { await impl.stop(); } catch (_) {} }
    this.running.clear();
  }

  // 给 send_message 工具看的清单: 人格不带 channel 时就把这张表还给它
  list() {
    return [...this.running.values()].map(({ spec, dir }) => ({
      id: spec.id, type: spec.type, typeName: TYPE_NAMES[spec.type] || spec.type, label: spec.label || '',
      direction: dir === 'two' ? 'two-way' : 'send-only', lastChat: (this.state[spec.id] || {}).chat_id || null,
    }));
  }

  status() {
    const out = {};
    for (const [id, { impl }] of this.running) { try { out[id] = impl.status(); } catch (e) { out[id] = { error: e.message }; } }
    return out;
  }

  async send(id, { to, text } = {}) {
    const r = this.running.get(id);
    if (!r) return { ok: false, error: `no channel "${id}"` };
    const target = to != null && to !== '' ? String(to) : (this.state[id] || {}).chat_id;
    if (r.dir === 'two' && !target) return { ok: false, error: `channel "${id}" needs "to": nobody has messaged it yet, so there is no chat to default to` };
    return r.impl.send({ to: target, text: String(text || '') });
  }

  _inbound(spec, rec) {
    if (rec && rec.chat_id != null) {
      this.state[spec.id] = { chat_id: String(rec.chat_id), at: Date.now() };
      try { fs.mkdirSync(path.dirname(this.stateFile), { recursive: true }); fs.writeFileSync(this.stateFile, JSON.stringify(this.state)); } catch (_) {}
    }
    if (this.onMessage) this.onMessage({ ...rec, channel: spec.id, type: spec.type, typeName: TYPE_NAMES[spec.type] || spec.type, label: spec.label || '' });
  }
}

module.exports = { ChannelHost, TYPES, TYPE_NAMES };
