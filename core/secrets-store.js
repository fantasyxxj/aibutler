// secrets-store.js — 需要加密落盘的凭据(API key 等)。文件位置由宿主给(个人版 数据目录 app/secrets.json · 教育版 数据目录 secrets.json)。
// 从 personal/secrets.js 抽出, 好让教育版共用同一份。
//
// 为什么不塞进 settings.json: 那个是明文 JSON, 用户会手改、出错时也会被整份打进日志。
// key 走 Electron safeStorage 加密 → 密文 base64 落盘, 单独一份文件。
// 后端各平台不同: macOS=Keychain · Windows=DPAPI(绑当前 Windows 用户账户) · Linux=libsecret/kwallet。
//
// 加密不可用时**拒绝保存**, 不悄悄退回明文 —— 用户以为存好了、实际躺在明文里, 比直接报错危险得多。
'use strict';

const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

// file: () => 绝对路径。惰性取, 宿主的数据目录可能晚于 require 才定。
function create(file) {
  function available() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      // Linux 没 keyring 时 Electron 回退 basic_text(硬编码密钥), isEncryptionAvailable() 照样返回 true。
      // 那是混淆不是加密, 视同不可用 —— 否则上面"拒绝保存"那道闸在 Linux 上永远不触发。
      // getSelectedStorageBackend 是 Linux-only API, 别的平台不调。
      if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
        if (safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
      }
      return true;
    } catch (_) { return false; }
  }

  function readAll() {
    try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch (_) { return {}; }
  }

  function get(key) {
    const box = readAll()[key];
    if (!box) return '';
    try { return safeStorage.decryptString(Buffer.from(box, 'base64')); } catch (_) { return ''; }
  }

  // 'none' 没存 · 'ok' 能解开 · 'stale' 盒子在但解不开。
  // stale 是真会发生的: DPAPI 密文绑 Windows 用户账户+机器, 重装系统/换用户/绿色版拷去别的机器就作废;
  // mac 换钥匙串同理。光看"盒子在不在"会让 UI 显示「已存 key」而实际取到空串 → 静默退回订阅模式, 用户蒙在鼓里。
  function status(key) {
    if (!readAll()[key]) return 'none';
    return get(key) ? 'ok' : 'stale';
  }

  function has(key) { return status(key) === 'ok'; }

  function set(key, plain) {
    if (!available()) return { ok: false, error: 'encryption_unavailable' };
    const all = readAll();
    if (plain) all[key] = safeStorage.encryptString(String(plain)).toString('base64');
    else delete all[key];
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(all, null, 2), 'utf8');
    try { fs.chmodSync(f, 0o600); } catch (_) {}
    return { ok: true };
  }

  return { get, set, has, status, available, file };
}

module.exports = { create };
