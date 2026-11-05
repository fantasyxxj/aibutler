'use strict';
// record-bridge.js — record 原语的主进程侧: 把 start / stop / cancel / play 转给宿主页去做, 录好的落盘。
//
// 为什么要转一手: 麦克风只在宿主页(安全上下文)里拿得到, 插件沙箱里没有;
// 而命令在主进程里跑。宿主页那头是 renderer/record-host.js, 两头用一问一答的 IPC 对上。
// 🔴 本文件不 require electron —— ipcMain 由宿主注入, 两版共用, 纯 node 下也测得动。
//
// 录音按包分目录: <dir>/<包id>/<id>.wav, 每个包只留最近 KEEP 段。
const fs = require('fs');
const path = require('path');

const KEEP = 20;
const ID_RE = /^[0-9a-z-]{1,40}$/;

function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
       + `-${Math.random().toString(36).slice(2, 6)}`;
}

// wav 头里读采样率和数据长度, 算出秒数。头不对就按 16k mono 16bit 估。
function durationSec(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return 0;
  const byteRate = buf.readUInt32LE(28) || 32000;
  return Math.round(((buf.length - 44) / byteRate) * 10) / 10;
}

function prune(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).sort(); } catch (_) { return; }
  for (const f of names.slice(0, Math.max(0, names.length - KEEP))) {
    try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
  }
}

/** ipcMain = 宿主的 ipcMain; dir() = 录音根目录。返回 forSender(webContents) → ctx.record。 */
function create({ ipcMain, dir }) {
  const pending = new Map();
  let seq = 0;
  let owner = null;   // 正在录的是哪个包。同一时刻只有一路麦克风

  ipcMain.handle('record-reply', (_e, m = {}) => {
    const p = pending.get(m.rid);
    if (!p) return;
    pending.delete(m.rid);
    clearTimeout(p.timer);
    p.resolve(m);
  });

  function ask(wc, msg, timeoutMs) {
    return new Promise((resolve) => {
      const rid = ++seq;
      const timer = setTimeout(() => {
        pending.delete(rid);
        resolve({ ok: false, code: 'record_timeout', message: '宿主页没应' });
      }, timeoutMs);
      pending.set(rid, { resolve, timer });
      try { wc.send('record-op', { rid, ...msg }); } catch (e) {
        pending.delete(rid); clearTimeout(timer);
        resolve({ ok: false, code: 'no_window', message: e.message });
      }
    });
  }

  function pkgDir(pkg) { return path.join(dir(), pkg); }

  return function forSender(wc) {
    return async (op, { pkg, maxSec, id } = {}) => {
      if (!wc || (wc.isDestroyed && wc.isDestroyed())) return { ok: false, code: 'no_window', message: '没有可录音的窗口' };
      if (op === 'warm') {
        // 第一次会弹系统麦克风授权框, 等久一点
        const r = await ask(wc, { op: 'warm', pkg }, 120000);
        return r.ok ? { ok: true, data: {} } : r;
      }
      if (op === 'start') {
        if (owner && owner !== pkg) return { ok: false, code: 'record_busy', message: '别的插件正在录音' };
        // 第一次会弹系统麦克风授权框, 人看完再点要时间, 所以等久一点
        const r = await ask(wc, { op: 'start', pkg, maxMs: maxSec * 1000 }, 120000);
        if (r.ok) owner = pkg;
        return r.ok ? { ok: true, data: { max_sec: maxSec } } : r;
      }
      if (op === 'cancel') {
        if (owner !== pkg) return { ok: true, data: {} };
        owner = null;
        const r = await ask(wc, { op: 'cancel' }, 10000);
        return r.ok ? { ok: true, data: {} } : r;
      }
      if (op === 'stop') {
        if (owner !== pkg) return { ok: false, code: 'not_recording', message: '没有在录音' };
        owner = null;
        const r = await ask(wc, { op: 'stop' }, 30000);   // 宿主页松手后还要多收 0.5 秒
        if (!r.ok) return r;
        if (!r.wav || !r.wav.length) return { ok: false, code: 'not_recording', message: '没录到声音' };
        const buf = Buffer.from(r.wav);
        const d = pkgDir(pkg);
        fs.mkdirSync(d, { recursive: true });
        const rid = newId();
        const file = path.join(d, `${rid}.wav`);
        fs.writeFileSync(file, buf);
        prune(d);
        return { ok: true, data: { id: rid, path: file, duration_sec: durationSec(buf) } };
      }
      if (op === 'play') {
        if (!ID_RE.test(String(id || ''))) return { ok: false, code: 'bad_param', message: 'play 要给 id' };
        const file = path.join(pkgDir(pkg), `${id}.wav`);
        if (!fs.existsSync(file)) return { ok: false, code: 'recording_not_found', message: `没有这段录音: ${id}` };
        const buf = fs.readFileSync(file);
        const r = await ask(wc, { op: 'play', wav: new Uint8Array(buf) }, 10000);
        return r.ok ? { ok: true, data: { id, duration_sec: durationSec(buf) } } : r;
      }
      return { ok: false, code: 'bad_decl', message: `record: 没有 ${op}` };
    };
  };
}

/* 读本包录过的一段(pron 原语送去评测用)。id 不合规或文件不在 → null */
function readRecording(root, pkg, id) {
  if (!ID_RE.test(String(id || '')) || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(String(pkg || ''))) return null;
  try { return fs.readFileSync(path.join(root, pkg, `${id}.wav`)); } catch (_) { return null; }
}

module.exports = { create, readRecording, durationSec, KEEP };
