// channels/ipc.js — 人格编辑「通道」页的测试按钮, 用表单里现填的配置, 不存盘。
// 只发的群机器人: 临时起一个适配器发一条。双向的: 只验凭据(check), 不开长连接 —— 同一个应用
// 开两条长连接, 平台会把消息分给其中一条, 真在跑的那条就漏收了。
// 自注册, main.js 只 require 一下。
'use strict';
const { ipcMain } = require('electron');
const { TYPES } = require('./index');

ipcMain.handle('channel-test', async (_e, { spec, text } = {}) => {
  const T = spec && TYPES[spec.type];
  if (!T) return { ok: false, error: `unknown channel type ${spec && spec.type}` };
  try {
    if (T.dir === 'two') return await T.check(spec);
    const impl = T.create(spec, { log: (m) => console.log(`[channel-test] ${m}`), onMessage: () => {} });
    await impl.start();
    const r = await impl.send({ to: spec.test_to, text: text || 'Butler test message' });
    try { await impl.stop(); } catch (_) {}
    return r;
  } catch (e) { return { ok: false, error: e.message }; }
});
