// pkg-secrets.js — 插件联网要用的密钥(API key / token), 按「包 + 名字」存在本机金库。
//
// 🔴 只有存 / 查有没有 / 清三个口, **没有读出原文的口** —— 原文只在 net-fetch 发请求那一刻
//    由宿主塞进请求头。能返回给界面, 就等于包里的代码和 AI 都拿得到。
// 包认 decl.pkg(宿主登记时写的), 不认参数 —— A 包按名字取不到 B 包的密钥。
// 加密交给宿主注入的 cipher { available(), encrypt(str) → Buffer, decrypt(Buffer) → str };
// 加密不可用时拒绝保存, 不悄悄退回明文。
'use strict';

const fs = require('fs');
const path = require('path');

const NAME_RE = /^[a-z0-9_-]{1,32}$/;
const MAX_LEN = 8192;

class PkgSecrets {
  constructor(file, cipher) { this.file = file; this.cipher = cipher; }

  _readAll() {
    try { return JSON.parse(this.cipher.decrypt(fs.readFileSync(this.file))); } catch (_) { return {}; }
  }

  _writeAll(all) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, this.cipher.encrypt(JSON.stringify(all)), { mode: 0o600 });
  }

  get(pkg, name) { return (this._readAll()[pkg] || {})[name] || ''; }

  /* 包的命令口: op = status / set / clear。返回给界面的只有「设没设」 */
  handle(pkg, op, args = {}) {
    const name = String(args.name || '');
    if (!NAME_RE.test(name)) return { ok: false, code: 'bad_args', message: 'secret: name 只许小写字母数字 _ -, 最长 32' };
    if (op === 'status') return { ok: true, message: '', data: { name, set: !!this.get(pkg, name) } };
    if (op !== 'set' && op !== 'clear') return { ok: false, code: 'bad_decl', message: 'secret: op 只能是 status / set / clear' };
    if (!this.cipher || !this.cipher.available()) return { ok: false, code: 'no_cipher', message: 'secret: 这台机器的加密不可用, 不保存' };
    const all = this._readAll();
    const mine = { ...(all[pkg] || {}) };
    if (op === 'set') {
      const v = String(args.value || '');
      if (!v || v.length > MAX_LEN) return { ok: false, code: 'bad_args', message: `secret: value 不能为空, 最长 ${MAX_LEN}` };
      mine[name] = v;
    } else delete mine[name];
    if (Object.keys(mine).length) all[pkg] = mine; else delete all[pkg];
    this._writeAll(all);
    return { ok: true, message: '', data: { name, set: op === 'set' } };
  }
}

module.exports = { PkgSecrets };
