// channels/wire.js — 把统一通道接到一个打开着的人格会话上(main.js 的 installPlugins 调, 热切换也走这里)。
// 单开文件是因为 main.js 早已过行数闸。
'use strict';
const path = require('path');
const { ChannelHost } = require('./index');

// handoff: 人格没打开时守候(dormant-wake.js)起的那个 ChannelHost 和它攒下的消息 —— 接手同一条连接, 不断线重连
async function wireChannels(s, entry, { cfg, log, handoff }) {
  const specs = (entry && entry.plugins && entry.plugins.channels) || [];
  const onMessage = (rec) => {
    const preview = String(rec.text || '').slice(0, 2000);
    s.convo.push({ role: 'system', text: `🔔 ${rec.typeName} 消息 from ${rec.from_name || rec.from_id} (${rec.channel}): ${preview.slice(0, 40)}`, ts: Date.now() });
    s.persist();
    s.butler.submit(
      cfg.render('inbox/channel_single', { typeName: rec.typeName, channel: rec.channel, fromName: rec.from_name || 'anon', fromId: rec.from_id, chatId: rec.chat_id, preview }),
      [], { sourceKind: 'inbox', rawText: String(rec.text || '') }
    ).catch((e) => console.error('[channel-onmessage]', e && e.message));
  };
  if (!s.channels && handoff) {
    s.channels = handoff.host;
    s.channels.onMessage = onMessage;
    s.butler.setChannelHost(s.channels);
    handoff.buf.forEach(onMessage);
    return;
  }
  if (!s.channels) {
    s.channels = new ChannelHost({
      personaName: s.butler.name, log,
      stateFile: path.join(s.butler.memoryDir, 'channels_state.json'),
      onMessage,
    });
  }
  await s.channels.install(specs);
  s.butler.setChannelHost(s.channels);
}

module.exports = { wireChannels };
