// quick-create.js — 一句话建人格: 人格管理「新建」顶上那个框(renderer/quick-create-ui.js)交来一句描述,
// 这里把「帮我建一个人格: …」当成用户的话递进管家的对话并切过去, 由管家用 persona_admin(op='create') 建。
// 名字 · 头像 · 领域(onboardingExtra) · 要不要写代码都由管家按这句话定 —— 走的是管家自己的模型和接入,
// 不另写一套跨厂家的单次调用; 「一句话描述就直接建、不追问」写在出厂知识 reference_tool_persona_admin_create。
// main.js 撞行数闸, 牵着会话与 UI 的几样由 init 注入(取值器, 调用时才取)。
'use strict';

const { ipcMain } = require('electron');
const registry = require('../core/registry');
const i18n = require('./i18n');

function init(deps) {
  ipcMain.handle('quick-create-persona', async (_e, { text = '' } = {}) => {
    const d = deps();
    const desc = String(text).trim();
    const S = i18n.uiStrings(d.currentLocale());
    if (!desc) return { ok: false, error: S.mgr_quick_empty };
    const b = registry.list().find((p) => p.isButler);
    if (!b) return { ok: false, error: S.mgr_quick_no_butler };
    const wasOpen = !!d.sessionFor(d.sidOf(b.homeDir));
    const o = d.openPersonaByRef(b.homeDir);   // 切到管家那一页
    if (!o.ok) return o;
    const s = d.sessionFor(o.sid);
    const msg = i18n.fmt(S.quick_create_msg, { text: desc });
    // 刚开的标签渲染层还在建, 等一下再出气泡, 否则这条气泡找不到标签
    if (!wasOpen) await new Promise((r) => setTimeout(r, 400));
    d.sendUI('user-echo', { sid: o.sid, text: msg });
    s.convo.push({ role: 'user', text: msg, ts: Date.now() });
    d.markActivity(s);
    const w = d.mainWin();
    if (w && !w.isDestroyed()) { w.show(); w.focus(); }
    s.butler.submit(msg).catch((e) => console.error('[quick-create] 递给管家失败:', e && e.message));
    console.log(`[quick-create] 一句话建人格 → ${b.name}: ${desc.slice(0, 80)}`);
    return { ok: true, butler: b.name };
  });
}

module.exports = { init };
