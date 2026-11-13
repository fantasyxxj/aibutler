// side-state.js — 每人格一份的「侧栏状态」: 布局选了上下还是左右, 以及用户让人格收藏的回复(界面上叫「收藏夹」)。
//
// 为什么挂上去的东西要自己存一份正文, 而不是只记「跳回第几条消息」:
//   屏幕上最多留 400 条(renderer.js SCREEN_MSG_CAP), 长期干活时原消息早被裁掉了 ——
//   只存指针, 用户点开就是一片空。所以一条 = { 标题, 正文原文, 时刻 }, 原消息在不在都看得了。
//
// 落盘: controlDir/side/<sid 的 sha1 前 16 位>.json, 一个人格一个文件(sid 是绝对路径, 不能直接当文件名)。
// 增删都在主进程这侧做, 渲染层只发「加一条 / 删一条」—— 不让渲染层整份回写, 两个动作挨着发也不会互相覆盖。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ITEMS = 200;          // 再多就不是「重要」了; 超了从最老的丢
const MAX_TEXT = 20000;         // 单条正文上限(字符), 防一条把文件撑爆
const LAYOUTS = new Set(['tb', 'lr']);

function create(controlDir) {
  const dir = () => path.join(typeof controlDir === 'function' ? controlDir() : controlDir, 'side');
  const fileOf = (sid) => path.join(dir(), crypto.createHash('sha1').update(String(sid || '')).digest('hex').slice(0, 16) + '.json');

  function read(sid) {
    try {
      const j = JSON.parse(fs.readFileSync(fileOf(sid), 'utf8'));
      return {
        layout: LAYOUTS.has(j.layout) ? j.layout : 'tb',
        items: Array.isArray(j.items) ? j.items : [],
      };
    } catch (_) { return { layout: 'tb', items: [] }; }
  }
  function write(sid, st) {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(fileOf(sid), JSON.stringify({ sid, layout: st.layout, items: st.items }, null, 2), 'utf8');
  }

  function setLayout(sid, layout) {
    if (!LAYOUTS.has(layout)) return read(sid);
    const st = read(sid);
    st.layout = layout;
    if (layout === 'lr') st.items.forEach((x) => { x.seen = true; });   // 切到左右 = 看见了, 角标清零
    write(sid, st);
    return st;
  }

  function add(sid, { title, text, ts } = {}) {
    const t = String(title || '').trim().slice(0, 120);
    if (!t) return null;
    const st = read(sid);
    const item = {
      id: `m${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
      ts: Number(ts) || Date.now(),
      title: t,
      text: String(text || '').slice(0, MAX_TEXT),
      seen: st.layout === 'lr',
    };
    st.items.push(item);
    if (st.items.length > MAX_ITEMS) st.items = st.items.slice(-MAX_ITEMS);
    write(sid, st);
    return item;
  }

  function remove(sid, id) {
    const st = read(sid);
    const n = st.items.length;
    st.items = st.items.filter((x) => x.id !== id);
    if (st.items.length !== n) write(sid, st);
    return st;
  }

  function markSeen(sid) {
    const st = read(sid);
    if (st.items.some((x) => !x.seen)) { st.items.forEach((x) => { x.seen = true; }); write(sid, st); }
    return st;
  }

  return { read, setLayout, add, remove, markSeen, fileOf };
}

// 主进程接线。sid 由渲染层报, 只拿来算文件名(哈希过), 碰不到任意路径。
function wire({ ipcMain, controlDir }) {
  const s = create(controlDir);
  const safe = (fn) => async (_e, a = {}) => { try { return fn(a); } catch (e) { return { error: String(e && e.message || e) }; } };
  ipcMain.handle('side-read', safe(({ sid }) => s.read(sid)));
  ipcMain.handle('side-layout', safe(({ sid, layout }) => s.setLayout(sid, layout)));
  ipcMain.handle('mark-add', safe(({ sid, title, text, ts }) => ({ item: s.add(sid, { title, text, ts }) })));
  ipcMain.handle('mark-del', safe(({ sid, id }) => s.remove(sid, id)));
  ipcMain.handle('marks-seen', safe(({ sid }) => s.markSeen(sid)));
  return s;
}

module.exports = { create, wire, MAX_ITEMS };
