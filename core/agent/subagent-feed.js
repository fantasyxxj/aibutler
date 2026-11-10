// 子代理的过程消息(cc 引擎转发、带 parent_tool_use_id): 只露一行「它在干什么」, 不进主聊天。
// 不拦的话它的工具调用会被画成主代理的工具行、逐字输出会追加进主气泡、usage 会覆盖主会话的上下文占用
// —— 作者 11-09 报「子代理一直往屏幕输出, 没法干活」。工具调用照样落 logs/tool_calls, 查账时看得到。
const toolLog = require('./tool-log');

function onSubagentMsg(agent, msg) {
  const content = msg.message && Array.isArray(msg.message.content) ? msg.message.content : [];
  if (msg.type === 'assistant') {
    for (const b of content) {
      if (b && b.type === 'tool_use') {
        toolLog.start(agent.name, b);
        agent._emit('onActivity', `↳ ${agent._describeTool(b)}`);
      }
    }
  } else if (msg.type === 'user') {
    for (const b of content) if (b && b.type === 'tool_result') toolLog.finish(b);
  }
}

module.exports = { onSubagentMsg };
