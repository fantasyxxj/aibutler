// plugins/bothub-inbox.js — bothub 收件箱: 消息拉到就先落本地, 交到人格手上才算数。
//
// 为什么要有它: 取件循环拉到一批就推游标并落盘(服务端认为读过了), 而攒批(最多 10 分钟)
// 和人格忙时挂起的消息原先只在内存里 —— 这段时间关 app / 关人格 / 热切换, 消息就没了,
// 服务端也不会再给。现在顺序是: 先写进这里 → 再推游标; 交付成功才标 done, 没交出去的下次补交。
//
// 存成人格 memoryDir/.bothub_inbox.json(一个人格一份, 多 endpoint 共用, 按 "url|agent" 分):
//   { items: [{ ep, id, msg, at, done }] }   done = 交付成功的时刻, null = 还没交出去
// inflight 只在内存: 已经交出去、submit 还没回音的那批 —— 防同一批被两次唤醒各带一遍。
// 进程一死 inflight 自然清空, 那批仍是 done=null, 下次启动会被补交(宁可重一次, 不丢)。
const fs = require('fs');
const path = require('path');

const KEEP_DONE_MS = 7 * 24 * 3600 * 1000;   // 交付过的留 7 天备查, 再老就清

class BothubInbox {
  constructor(file, onLog) {
    this.file = file;
    this.onLog = onLog || (() => {});
    this.items = [];
    this.inflight = new Set();
    this._load();
  }

  static key(ep, id) { return `${ep}#${id}`; }

  _load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.items = Array.isArray(j.items) ? j.items : [];
    } catch (e) { this.onLog(`[bothub-inbox]⚠ 读收件箱失败(当空的用): ${e.message}`); }
  }

  // 先写临时文件再改名: 写到一半断电, 留下的是旧的完整文件, 不是半截 JSON。
  _save() {
    const cutoff = Date.now() - KEEP_DONE_MS;
    this.items = this.items.filter((it) => !it.done || it.done >= cutoff);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ items: this.items }), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  // 落盘失败要抛 —— 调用方据此不推游标, 让服务端下次再给。
  add(ep, msgs) {
    const have = new Set(this.items.map((it) => BothubInbox.key(it.ep, it.id)));
    let n = 0;
    for (const m of msgs) {
      if (!m || m.id == null || have.has(BothubInbox.key(ep, m.id))) continue;
      this.items.push({ ep, id: m.id, msg: m, at: Date.now(), done: null });
      n += 1;
    }
    if (n) this._save();
    return n;
  }

  // 还没交出去、也不在途中的, 按 id 升序。
  pending(ep) {
    return this.items
      .filter((it) => it.ep === ep && !it.done && !this.inflight.has(BothubInbox.key(ep, it.id)))
      .sort((a, b) => a.id - b.id)
      .map((it) => it.msg);
  }

  // 拿走一批去交付: 标在途, 返回一个 settle(ok) —— ok 就标 done 落盘, 否则放回去等下次。
  claim(ep, msgs) {
    const keys = msgs.map((m) => BothubInbox.key(ep, m.id));
    keys.forEach((k) => this.inflight.add(k));
    let settled = false;
    return (ok) => {
      if (settled) return;
      settled = true;
      keys.forEach((k) => this.inflight.delete(k));
      if (!ok) return;
      const set = new Set(keys), now = Date.now();
      for (const it of this.items) if (set.has(BothubInbox.key(it.ep, it.id))) it.done = now;
      try { this._save(); } catch (e) { this.onLog(`[bothub-inbox]⚠ 标已交付落盘失败: ${e.message}`); }
    };
  }
}

module.exports = { BothubInbox };
