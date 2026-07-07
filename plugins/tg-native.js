// plugins/tg-native.js — butler 内在直抓 Telegram (long polling), 无外部进程。
// 老方案(Python tg_listener.py 子进程)已弃, 通道在 butler 肚子里更干净。
// TG 提供两种收消息方式:
//   1) long polling: getUpdates?offset&timeout=25 → 我们用这个(本地无公网入口)
//   2) webhook: TG 主动 POST 到你的公网 URL → 需要 HTTPS 证书, 不适合本地
// 消息落到 in_file (messages.jsonl, 兜底副本 + 兼容 tg_pending.py 老脚本行格式),
// v2 (2026-07-07): 每条落盘后同时触发 onMessage(record) 回调, main.js 里直接 butler.submit 唤醒人格,
//   不再靠 startTgWatch 4s 盯水位线 (延迟从 0-4s 降到网络 RTT 级)。
const fs = require('fs');
const path = require('path');

class TgNativeChannel {
  // cfg = { bot_token, in_file, chat_ids?, allow_from? }
  // onMessage(record): 每条新消息落盘后触发, 供上层直接 submit 到 butler (v2 代替 startTgWatch 4s 盯水位线)
  constructor(cfg, personaName, onLog, onMessage) {
    this.cfg = cfg || {};
    this.personaName = personaName || 'persona';
    this.onLog = onLog || (() => {});
    this.onMessage = onMessage || null;
    this.stopped = false;
    this.offset = 0;
    this.startedAt = 0;
    this.lastError = null;
    this.msgCount = 0;
  }

  // 从 in_file 现有内容读初始 offset (延续水位线, 不重收旧消息)
  _loadInitialOffset() {
    try {
      if (!this.cfg.in_file || !fs.existsSync(this.cfg.in_file)) return;
      const txt = fs.readFileSync(this.cfg.in_file, 'utf8').trim();
      if (!txt) return;
      for (const ln of txt.split('\n')) {
        try { const m = JSON.parse(ln); if (m && m.update_id > this.offset) this.offset = m.update_id; } catch (_) {}
      }
    } catch (_) {}
  }

  start() {
    if (this.stopped) return { ok: false, error: '已停止' };
    if (this.startedAt) return { ok: true, note: '已在跑' };
    if (!this.cfg.bot_token) return { ok: false, error: '缺 bot_token' };
    if (!this.cfg.in_file) return { ok: false, error: '缺 in_file' };
    this._loadInitialOffset();
    this.startedAt = Date.now();
    this.onLog(`[tg-native:${this.personaName}] ▶ 启动 native long polling · in_file=${this.cfg.in_file} · 初始 offset=${this.offset}`);
    this._loop().catch((e) => this.onLog(`[tg-native:${this.personaName}]⚠ loop 崩溃: ${e && e.message}`));
    return { ok: true, mode: 'native' };
  }

  // long polling 主循环: 网络错误指数退避; TG 400/401 (token 错) 停; 其他 backoff
  async _loop() {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        const url = `https://api.telegram.org/bot${this.cfg.bot_token}/getUpdates?offset=${this.offset + 1}&timeout=25`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(35000) });
        if (resp.status === 401 || resp.status === 404) {
          this.onLog(`[tg-native:${this.personaName}]⚠ token 无效 (HTTP ${resp.status}), 停止轮询`);
          this.stopped = true; this.lastError = 'token 无效'; return;
        }
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const j = await resp.json();
        if (!j.ok) throw new Error(j.description || 'TG API error');
        for (const u of (j.result || [])) {
          if (u.update_id > this.offset) this.offset = u.update_id;
          this._appendMessage(u);
        }
        this.lastError = null;
        backoff = 1000;
      } catch (e) {
        if (this.stopped) return;
        this.lastError = e && e.message;
        this.onLog(`[tg-native:${this.personaName}]⚠ ${this.lastError} · 退避 ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  }

  // 把 TG update 写成 messages.jsonl 里的一行 (格式跟 tg_listener.py 一致 → tg_pending.py 直接能读)
  _appendMessage(u) {
    const m = u.message || u.channel_post || u.edited_message;
    if (!m || !m.chat) return;
    // chat_id 白名单过滤 (缺省=全放行)
    if (Array.isArray(this.cfg.chat_ids) && this.cfg.chat_ids.length && !this.cfg.chat_ids.includes(m.chat.id)) return;
    // allow_from 用户白名单 (可选)
    if (Array.isArray(this.cfg.allow_from) && this.cfg.allow_from.length && m.from && !this.cfg.allow_from.includes(m.from.id)) return;
    const record = {
      ts: m.date, iso: new Date(m.date * 1000).toISOString().slice(0, 19),
      update_id: u.update_id,
      from_id: (m.from && m.from.id) || null,
      from_name: (m.from && (m.from.username || m.from.first_name)) || '',
      chat_id: m.chat.id,
      text: m.text || m.caption || '',
      reply_to: (m.reply_to_message && m.reply_to_message.message_id) || null,
      file_path: null,   // TODO: 图片附件 file_id → 下载。暂略, 保持 v1 简单。
    };
    try {
      fs.mkdirSync(path.dirname(this.cfg.in_file), { recursive: true });
      fs.appendFileSync(this.cfg.in_file, JSON.stringify(record) + '\n', 'utf8');
      this.msgCount += 1;
      const preview = record.text.slice(0, 40).replace(/\n/g, ' ');
      this.onLog(`[tg-native:${this.personaName}] in <- ${record.from_name}(${record.from_id}) "${preview}"`);
      // v2: 落盘成功后直接触发上层 (让 main.js callback submit 到 butler)
      // fire-and-forget: 一批 update 里的多条并发 submit, butler.submit 是 queue-based 自己排队
      if (this.onMessage) {
        try { this.onMessage(record); } catch (e) {
          this.onLog(`[tg-native:${this.personaName}]⚠ onMessage 回调抛异常: ${e.message}`);
        }
      }
    } catch (e) {
      this.onLog(`[tg-native:${this.personaName}]⚠ 写 in_file 失败: ${e.message}`);
    }
  }

  async stop() { this.stopped = true; return { ok: true }; }

  status() {
    return {
      mode: 'native', running: !this.stopped && !!this.startedAt,
      offset: this.offset, startedAt: this.startedAt,
      msgCount: this.msgCount, lastError: this.lastError,
      in_file: this.cfg.in_file || null,
    };
  }
}

module.exports = { TgNativeChannel };
