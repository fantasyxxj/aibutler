// local-api.js — Local Poke API v1: 本机程序通过 HTTP 戳醒指定人格 (2026-08-03)
// 设计稿: docs/design/local_api_v1.md
//
// 与其他 4 条入向通道 (tg / line / bothub / agent-bus) 的关键差异:
//   它们是**人格级**的 (installPlugins(s) 每 session 装一份), 本通道是**进程级单例**
//   —— 一个端口服务所有人格, 人格名走请求参数。因此不进 installPlugins, 由 main.js 在 app ready 后起一次。
//
// 协议就一条: 指定戳醒谁 + 给什么信息 → 投完立即返回。不等回答、不回调、不查状态。
// 安全只靠"绑 127.0.0.1"一层 (作者 2026-08-03: 安全先不用管, 只侦听本地)。
//   ⚠️ 这层假设只在绑回环时成立。将来若要让外部机器调, 必须先补 token 再改绑定, 两件事不能拆开做。
const http = require('http');

const MAX_BODY = 64 * 1024;          // 单请求正文上限, 防止本机脚本一次灌爆
const IDEM_TTL_MS = 10 * 60 * 1000;  // idempotency_key 去重窗口
const IDEM_MAX = 500;                // LRU 容量上限

class LocalApiServer {
  // cfg: { enabled, port }
  // onPoke: async ({persona, text, from}) => { ok, persona, delivered, was_opened } | { ok:false, code, error }
  constructor(cfg, log, onPoke) {
    this.cfg = cfg || {};
    this.log = log || (() => {});
    this.onPoke = onPoke;
    this.server = null;
    this._idem = new Map();   // key -> ts (插入序即 LRU 序)
  }

  start() {
    if (this.server) return { ok: true, port: this.cfg.port, note: '已在运行' };
    const port = Number(this.cfg.port) || 8787;
    try {
      this.server = http.createServer((req, res) => this._handle(req, res));
      this.server.on('error', (e) => {
        this.log(`[local-api] 服务错误: ${e && e.message}`);
        // 端口被占等启动期错误: 收掉半死的 server, 否则下次 start 以为还在跑
        if (e && e.code === 'EADDRINUSE') { try { this.server.close(); } catch (_) {} this.server = null; }
      });
      // 只绑回环: 公网/局域网打不进来
      this.server.listen(port, '127.0.0.1');
      return { ok: true, port };
    } catch (e) {
      this.server = null;
      return { ok: false, error: String(e && e.message) };
    }
  }

  stop() {
    if (!this.server) return;
    try { this.server.close(); } catch (_) {}
    this.server = null;
  }

  status() {
    return { running: !!this.server, port: Number(this.cfg.port) || 8787 };
  }

  // idempotency_key 命中 = 重复投递, 直接丢弃。同时顺手清过期 + 压容量。
  _dupe(key) {
    if (!key) return false;
    const now = Date.now();
    for (const [k, ts] of this._idem) {
      if (now - ts > IDEM_TTL_MS) this._idem.delete(k); else break;   // Map 保插入序, 头部没过期后面就都没过期
    }
    if (this._idem.has(key)) return true;
    this._idem.set(key, now);
    while (this._idem.size > IDEM_MAX) this._idem.delete(this._idem.keys().next().value);
    return false;
  }

  _json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  }

  _handle(req, res) {
    const url = (req.url || '').split('?')[0];
    if (req.method !== 'POST' || url !== '/v1/poke') {
      return this._json(res, 404, { ok: false, error: '只有 POST /v1/poke' });
    }
    let raw = '';
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;
      raw += c;
      if (raw.length > MAX_BODY) { tooBig = true; this._json(res, 413, { ok: false, error: `正文超过 ${MAX_BODY} 字节` }); req.destroy(); }
    });
    req.on('end', async () => {
      if (tooBig) return;
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return this._json(res, 400, { ok: false, error: 'body 不是合法 JSON' }); }
      const persona = String(body.persona || '').trim();
      const text = String(body.text || '').trim();
      if (!persona) return this._json(res, 400, { ok: false, error: '缺 persona' });
      if (!text) return this._json(res, 400, { ok: false, error: '缺 text' });
      const from = String(body.from || '外部程序').trim().slice(0, 60);
      const idem = body.idempotency_key ? String(body.idempotency_key).slice(0, 200) : '';
      if (this._dupe(idem)) {
        this.log(`[local-api] 去重命中 key=${idem} → 丢弃`);
        return this._json(res, 200, { ok: true, persona, delivered: false, deduped: true });
      }
      try {
        const r = await this.onPoke({ persona, text, from });
        if (!r || r.ok === false) return this._json(res, (r && r.code) || 500, { ok: false, error: (r && r.error) || '投递失败' });
        this._json(res, 200, { ok: true, persona: r.persona, delivered: true, was_opened: !!r.was_opened });
      } catch (e) {
        this.log(`[local-api] 投递异常: ${e && e.message}`);
        this._json(res, 500, { ok: false, error: String(e && e.message) });
      }
    });
  }
}

module.exports = { LocalApiServer };
