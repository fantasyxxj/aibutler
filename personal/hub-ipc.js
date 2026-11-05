// hub-ipc.js — 连公网 hub 那条路的 IPC 口, 自注册(main.js 只 require 一下)。
//
// 单独一个文件不是为了好看: main.js 已经 3000 多行撞了行数闸, 新功能一律另起文件。
//
// 🔴 人格级: 一个人格一个 hub 身份, 所以 apply / state / claim 三个口**都**带 personaId。
// 老口径是进程级(一台机器只申请一次), 但那样第二个人格申请时会被服务端按 install_id
// resume 到第一个人格那条申请上, 结果是所有人格都申请不了。
'use strict';

const { ipcMain } = require('electron');
const hubJoin = require('../core/hub-join');

ipcMain.handle('hub-state', async (_e, { personaId } = {}) => {
  const st = hubJoin.getState(personaId);
  return { applyId: st.apply_id, status: st.status, asked: st.asked, ownerName: st.owner_name, shouldPrompt: hubJoin.shouldPrompt() };
});
ipcMain.handle('hub-apply', async (_e, opt = {}) => hubJoin.apply(opt));
// 🔴 取到 token 只是把通道写进登记簿, 收件循环不会自己起来 —— 起循环的 installPlugins 只有
// 「打开人格」和「保存人格(热切换)」两个入口, claim 一个都不碰。不在这儿补一刀, 用户看着
// 「已连接」却一条消息都收不到, 直到他重启 butler。宿主在 require 时把那一刀注册进来。
let _onClaimed = null;
function onClaimed(fn) { _onClaimed = fn; }

ipcMain.handle('hub-claim', async (_e, { personaId } = {}) => {
  const r = await hubJoin.claim(personaId);
  if (r && r.ok && r.granted && _onClaimed) {
    try { await _onClaimed(personaId); } catch (e) { console.error('[hub-claim] 起收件循环失败:', e && e.message); }
  }
  return r;
});
ipcMain.handle('hub-dismiss', async () => hubJoin.dismiss());

module.exports = { onClaimed };
