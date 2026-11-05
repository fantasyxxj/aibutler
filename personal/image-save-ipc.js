// image-save-ipc.js — 「右键图片 → 另存为」的主进程那一半, 自注册(main.js 只 require 一下)。
//
// 单开文件: main.js 已过行数闸。渲染层给三种来源之一, 存哪儿由用户在系统保存框里定:
//   bytes  — 渲染层自己画好的(内联 SVG / 流程图转出的 png 或 svg 原文)
//   src    — <img> 的 src: file:// 或本机绝对路径照原文件复制, data: 解码, http(s) 由主进程下载
//            (渲染层拿外链图画 canvas 会被跨域污染, 导不出来)
'use strict';

const { ipcMain, dialog, BrowserWindow, net } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILTERS = {
  png: { name: 'PNG', extensions: ['png'] }, svg: { name: 'SVG', extensions: ['svg'] },
  jpg: { name: 'JPEG', extensions: ['jpg', 'jpeg'] }, gif: { name: 'GIF', extensions: ['gif'] },
  webp: { name: 'WebP', extensions: ['webp'] },
};
const MIME_EXT = { 'image/png': 'png', 'image/svg+xml': 'svg', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

function localPath(src) {
  if (src.startsWith('file://')) return decodeURIComponent(src.replace(/^file:\/\/\/?([A-Za-z]:)/, '$1').replace(/^file:\/\//, ''));
  if (src.startsWith('~/')) return path.join(os.homedir(), src.slice(2));
  if (path.isAbsolute(src)) return src;
  return null;
}

// 来源 → { buf, ext }
async function load({ bytes, ext, src }) {
  if (bytes) return { buf: Buffer.from(bytes), ext: ext || 'png' };
  if (!src || typeof src !== 'string') throw new Error('没有图片来源');
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src);
  if (m) return { buf: Buffer.from(m[2] ? m[3] : decodeURIComponent(m[3]), m[2] ? 'base64' : 'utf8'), ext: MIME_EXT[m[1]] || 'png' };
  if (/^https?:\/\//i.test(src)) {
    const r = await net.fetch(src);
    if (!r.ok) throw new Error('下载失败 ' + r.status);
    const type = (r.headers.get('content-type') || '').split(';')[0].trim();
    const urlExt = (path.extname(new URL(src).pathname).slice(1) || '').toLowerCase();
    return { buf: Buffer.from(await r.arrayBuffer()), ext: MIME_EXT[type] || urlExt || 'png' };
  }
  const p = localPath(src);
  if (!p || !fs.existsSync(p)) throw new Error('图片文件不存在');
  return { buf: fs.readFileSync(p), ext: (path.extname(p).slice(1) || 'png').toLowerCase() };
}

ipcMain.handle('save-image', async (e, opt = {}) => {
  try {
    const { buf, ext } = await load(opt);
    const base = String(opt.name || 'image').replace(/\.[a-z0-9]+$/i, '').replace(/[\\/:*?"<>|]/g, '_') || 'image';
    const key = ext === 'jpeg' ? 'jpg' : ext;
    const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
      defaultPath: path.join(os.homedir(), 'Downloads', `${base}.${key}`),
      filters: [FILTERS[key] || { name: key.toUpperCase(), extensions: [key] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, buf);
    return { ok: true, path: r.filePath };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});
