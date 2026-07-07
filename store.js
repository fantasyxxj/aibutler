// store.js — 会话持久化: 每轮把对话+session_id+usage 存盘, 启动时载回。
// 多人格: 每个人格自己的状态文件(路径由调用方给, 通常在其记忆目录旁)。
const fs = require('fs');

const MAX_MSGS = 400; // 只留最近 N 条渲染历史, 防文件无限涨

// state 形状: { sessionId, model, window, lastInput, pendingHandoff, messages:[{role,text,ts}] }
function load(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!s || typeof s !== 'object') return null;
    return s;
  } catch (e) {
    return null;
  }
}

function save(file, state) {
  try {
    const trimmed = {
      ...state,
      messages: Array.isArray(state.messages) ? state.messages.slice(-MAX_MSGS) : [],
    };
    fs.writeFileSync(file, JSON.stringify(trimmed), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { load, save };
