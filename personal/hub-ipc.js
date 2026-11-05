// hub-ipc.js — 连公网 hub 那条路的 IPC 口, 自注册(main.js 只 require 一下)。
//
// 单独一个文件不是为了好看: main.js 已经 3000 多行撞了行数闸, 新功能一律另起文件。
//
// 🔴 人格级: 一个人格一个 hub 身份, 所以 apply / state / claim 三个口**都**带 personaId。
// 老口径是进程级(一台机器只申请一次), 但那样第二个人格申请时会被服务端按 install_id
// resume 到第一个人格那条申请上, 结果是所有人格都申请不了。
'use strict';

const { app, ipcMain } = require('electron');
const hubJoin = require('../core/hub-join');
const registry = require('../core/registry');

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

async function claimAndStart(personaId) {
  const r = await hubJoin.claim(personaId);
  if (r && r.ok && r.granted && _onClaimed) {
    try { await _onClaimed(personaId, { agent: r.agent }); } catch (e) { console.error('[hub-claim] 起收件循环失败:', e && e.message); }
  }
  return r;
}
ipcMain.handle('hub-claim', async (_e, { personaId } = {}) => claimAndStart(personaId));

// 自动领取(作者 2026-11-05 定): 申请过、还没接通的人格, 后台定时替用户点「检查」, 批下来就当场接通,
// 不用人再回来点。凭的是本地 claim_secret, 只能查自己这条申请; 服务端只给密钥错计数, 轮询不会被锁。
// 被拒 / 过期 / 已领走就不再查 —— 那些状态再查多少次也不会变。
const AUTO_CLAIM_MS = 3 * 60 * 1000;
const WAITING = new Set(['', 'pending', 'approved']);
const hubConnected = (p) => ((p.plugins && p.plugins.buses) || []).some((b) => b && b.kind === 'bothub' && b.token);
let _polling = false;
async function autoClaimOnce() {
  if (_polling) return;
  _polling = true;
  try {
    for (const p of registry.list()) {
      const st = hubJoin.getState(p.id);
      if (!st.apply_id || !WAITING.has(st.status) || hubConnected(p)) continue;
      const r = await claimAndStart(p.id).catch((e) => ({ ok: false, error: e && e.message }));
      if (r.granted) console.log(`[hub-auto-claim] ${p.name} 申请 #${st.apply_id} 已批, 自动接通为 ${r.agent}`);
      else if (!r.ok) console.log(`[hub-auto-claim] ${p.name} 申请 #${st.apply_id} 查询失败: ${r.error}`);
    }
  } finally { _polling = false; }
}
app.whenReady().then(() => {
  setTimeout(autoClaimOnce, 20000);
  setInterval(autoClaimOnce, AUTO_CLAIM_MS);
});
ipcMain.handle('hub-dismiss', async () => hubJoin.dismiss());

module.exports = { onClaimed, autoClaimOnce };
