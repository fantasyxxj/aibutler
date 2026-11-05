// bus.js — 跟服务端说话的**唯一**一份客户端。
//
// 在这之前两版一共有 13 份各写各的实现(个人版 6 · 行业版 7), 分属两套协议, 光
// `/bus/v1/agent/exec` 的信封就手写了三遍且互不一致。作者 2026-08-24 定案:
//
//   > 发送 line 其实是 bus 里面的一个功能, 不是一个专门的工具。
//   > bus 有两套你一直没统一, 其实最好是统一 …… 本来多个 bus 也是没问题的,
//   > AI 可以跟多个 bus 对接, 根据需求往哪个去发送而已。
//
// 🔴 要统一的是**怎么跟 bus 说话**, 不是 bus 的数量。多目标本来就正常:
//    行业版对着管理平台与业务平台两台服务器, 个人版对着若干个 agent-bus 端点。
//    所以这里的模型是【一份客户端 + 一个有序的目标列表, 第一个是默认】。
//
// 协议族两种, 差异全收在这一个文件里, 对外接口一样:
//   'v1'     业务/预约 bus —— exec 信封(POST /bus/v1/agent/exec) · 裸 REST · seq 游标取件
//   'bothub' agent 间聊天 —— POST {url}/send · after_id 游标取件
'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const KINDS = ['v1', 'bothub'];
const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

// 传文件时报一下类型, 好让收件方知道该怎么开。猜不出就 octet-stream, 不影响传输。
const CONTENT_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.json': 'application/json', '.csv': 'text/csv', '.zip': 'application/zip',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.html': 'text/html',
};
const guessContentType = (name) =>
  CONTENT_TYPES[path.extname(String(name || '')).toLowerCase()] || 'application/octet-stream';

// 从 Content-Disposition 取回原文件名。取不到不是错 —— 调用方自己兜个名字。
function filenameFromDisposition(header) {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) { try { return path.basename(decodeURIComponent(star[1])); } catch (_) { /* 坏编码就当没有 */ } }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? path.basename(plain[1]) : null;
}

// 幂等键: 平台的幂等表硬限 36 字符, uuid 正好 36 —— 别改成带前缀的格式。
// 有 correlation_id 时用它派生, 让同一件事的重试落在同一个键上。
function idemKey(correlationId, command) {
  if (!correlationId) return randomUUID();
  return `${correlationId}-${command || 'x'}`.slice(0, 36);
}

// 平台的断り文句要**保持机器可读**。AI 看文字够了, 但界面得按 code 分支出自己的四语文案 ——
// 平台的 message 是日文写死的, 直接显示的话中文店主只能看见日文。
function errorDetail(text, status) {
  const out = { code: `http_${status}`, message: `HTTP ${status}`, status };
  try {
    const j = JSON.parse(text);
    const d = j.detail || {};
    // 平台の断り文句は素の detail も付けて渡す。ここで拾う数個以外にも
    // 「あと何分 · 何台」のような**数字入りの理由**が乗ってくる場面があり(装机の登録)、
    // 抜き出す側で列挙すると増える度に静かに落ちる。
    if (d && typeof d === 'object' && !Array.isArray(d)) out.raw = d;
    // 管理平台は error, 業務平台は code —— 同じ「拒否の識別子」を別の名で置いている。
    if (d.code || d.error) { out.code = d.code || d.error; out.message = d.message || ''; }
    for (const k of ['capacity_remaining', 'remaining_unit', 'available_zones']) {
      if (d[k] !== undefined) out[k] = d[k];
    }
    const errs = d.errors || (Array.isArray(j.detail) ? j.detail : null);
    if (Array.isArray(errs) && errs.length) {
      out.fields = errs.slice(0, 5).map((e) => ({ at: (e.loc || []).join('.'), why: e.msg || '' }));
    }
  } catch (_) { /* 不是 JSON 就用 HTTP 码兜底 */ }
  return out;
}

function errorText(text, status) {
  const d = errorDetail(text, status);
  const head = d.message ? `${d.code}: ${d.message}` : d.code;
  const fields = d.fields ? ' — ' + d.fields.map((f) => `${f.at}: ${f.why}`).join(' / ') : '';
  return `⚠️ bus 拒绝 (${head})${fields}`;
}

// undici 的 e.message 恒是 "fetch failed" —— 真因只在 e.cause 里。不把它带出来,
// 连不上 / 被拒绝 / 超时 / 证书错 / DNS 不通在日志里长得一模一样, 排查全靠猜。
function unreachable(e) {
  const msg = `${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`;
  return { ok: false, error: `⚠️ bus 不可达: ${msg}`, detail: { code: 'unreachable', message: msg } };
}

// 取件失败分两种: token 坏了(重试一万次还是坏的, 只会把日志刷满) vs 一时不通(该退避重试)。
// 标记在异常上, 让轮询循环能分辨。**只给状态码不给措辞** —— 说法由调用方定
// (行业版那台机器整机日语)。
function authAwareError(status) {
  const err = new Error(`HTTP ${status}`);
  if (status === 401 || status === 403) err.authFailed = true;
  return err;
}

class BusEndpoint {
  // spec = { id, kind, base_url, token, agent?, label?, wait?, poll_interval?, inbox_path? }
  constructor(spec = {}) {
    this.id = String(spec.id || 'default');
    this.kind = KINDS.includes(spec.kind) ? spec.kind : 'v1';
    this.base_url = trimSlash(spec.base_url);
    this.token = spec.token || null;
    this.agent = spec.agent || null;          // 本机在这条 bus 上的身份(取件/发件都要报)
    this.label = spec.label || this.id;
    this.wait = Math.min(spec.wait || 25, 25);
    this.pollInterval = spec.poll_interval || 3000;
    // 同一套 v1 协议下取件口不止一个: 通用事件在 /bus/v1/agent/inbox, LINE 的在
    // /bus/v1/line/inbox(事件形状一样, 只是上游分了两张表)。
    this.inboxPath = spec.inbox_path || '/bus/v1/agent/inbox';
  }

  get ok() { return !!this.base_url; }

  _headers(extra) {
    const h = { ...(extra || {}) };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async _fetch(url, opts, timeoutMs = 20000) {
    const resp = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    const text = await resp.text();
    return { resp, text };
  }

  // —— 出向 ① exec 信封 ——
  // 平台只开 /bus/v1/agent/exec 一个口子时用它: 真实调用包进 {command, content} 里送。
  // retries: 只给**自动**投递用(handler 回报失败了没人重来)。AI 手动调的那条路留 0 ——
  // 它自己看得见错误, 静默重试只会让它以为发过了。幂等键整轮复用, 重试不会变成两笔。
  async exec({ command, content, correlationId = null, timeoutMs = 30000, retries = 0 } = {}) {
    if (this.kind !== 'v1') return { ok: false, error: `bus「${this.id}」不是 v1 协议, 没有 exec` };
    const key = idemKey(correlationId, command);
    let last = null;
    for (let i = 0; i <= retries; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1500 * i));
      try {
        const { resp, text } = await this._fetch(`${this.base_url}/bus/v1/agent/exec`, {
          method: 'POST',
          headers: this._headers({ 'Content-Type': 'application/json', 'Idempotency-Key': key }),
          body: JSON.stringify({ command, content, correlation_id: correlationId }),
        }, timeoutMs);
        if (!resp.ok) {
          last = { ok: false, error: errorText(text, resp.status), detail: errorDetail(text, resp.status) };
          if (resp.status < 500 && resp.status !== 429) break;   // 4xx(除限流) 重试也还是那个答案
          continue;
        }
        // 信封只是运输壳, 要的是里面那件东西
        let out = text;
        try {
          const j = JSON.parse(text);
          if (j && Object.prototype.hasOwnProperty.call(j, 'result')) out = JSON.stringify(j.result);
        } catch (_) { /* 不是 JSON 就原样给 */ }
        return { ok: true, text: String(out) };
      } catch (e) {
        last = unreachable(e);
      }
    }
    return last;
  }

  // —— 出向 ② 裸 REST ——
  // 平台把每个 endpoint 都开出来时用它(pack 声明 transport:direct 走这条)。
  async call({ method = 'GET', path = '/', query = null, body = null, idempotency = false, timeoutMs = 20000 } = {}) {
    let url = this.base_url + path;
    const opts = { method, headers: this._headers() };
    if (method === 'GET') {
      const qs = Object.entries(query || {}).filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    } else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body || {});
      if (idempotency) opts.headers['Idempotency-Key'] = randomUUID();
    }
    // 🔴 连接池竞态: undici 复用 keep-alive 连接, 而服务端(uvicorn 默认 5 秒)可能早把它关了。
    // 复用到那条死连接 = ECONNRESET, 长得和「服务真的不可达」一模一样, 但重发一次就成。
    // 只给 GET 重发 —— 它幂等, 重发不会变成两笔。POST 宁可报错也不能盲目重试。
    // 实际踩到: boot 里 activate(POST) 之后要初始化人格, 隔了好几秒才查 readiness(GET),
    // 那条连接早被对面回收了 —— 于是店铺状态永远取不到, 而日志只说「不可达」。
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { resp, text } = await this._fetch(url, opts, timeoutMs);
        if (!resp.ok) return { ok: false, error: errorText(text, resp.status), detail: errorDetail(text, resp.status) };
        return { ok: true, text };
      } catch (e) {
        const code = (e.cause && e.cause.code) || '';
        const stale = code === 'ECONNRESET' || code === 'UND_ERR_SOCKET'
          || /socket hang up|other side closed/i.test((e.cause && e.cause.message) || '');
        if (method === 'GET' && stale && attempt === 0) continue;
        return unreachable(e);
      }
    }
  }

  // —— 出向 ③ 给另一个 agent 发一句话(bothub 协议) ——
  // 判成功看返回 id 而不是 ok: 心跳/ACK 前缀会被服务端静默 drop(id=null, dropped=silent);
  // 30 分钟内同 (from,to,text) 三元组重发会被去重(dedup=true, id 指向原消息)。
  async send({ to, text, payload = {} } = {}) {
    if (this.kind !== 'bothub') return { ok: false, error: `bus「${this.id}」不是 bothub 协议, 没有 send` };
    if (!this.agent) return { ok: false, error: `bus「${this.id}」缺 agent(本机身份), 发不出去` };
    if (!to || !String(to).trim()) return { ok: false, error: 'to 必填' };
    if (!text || !String(text).trim()) return { ok: false, error: 'text 必填' };
    try {
      const { resp, text: body } = await this._fetch(`${this.base_url}/send`, {
        method: 'POST',
        headers: this._headers({ 'Content-Type': 'application/json', accept: 'application/json' }),
        body: JSON.stringify({ from_agent: this.agent, to_agent: String(to).trim(),
                               text: String(text).trim(), payload: payload || {} }),
      });
      let j = {};
      try { j = JSON.parse(body); } catch (_) { /* 空体也算数, 看状态码 */ }
      if (!resp.ok) {
        // FastAPI 校验失败的 detail 是数组, 不序列化就打成 [object Object]
        let detail = (j && (j.detail || j.error)) || '';
        if (detail && typeof detail === 'object') detail = JSON.stringify(detail).slice(0, 300);
        return { ok: false, error: `⚠️ 发送失败: HTTP ${resp.status}${detail ? ' ' + detail : ''}` };
      }
      if (j.dropped === 'silent') return { ok: true, text: '✅ 已发(心跳/ACK 前缀, 服务端静默 drop 不入队)' };
      if (j.dedup) return { ok: true, text: `✅ 已发(30 分钟内同 (from,to,text) 重发, 服务端去重 → id=${j.id})` };
      return { ok: true, text: `✅ 已发 id=${j.id != null ? j.id : '?'}` };
    } catch (e) {
      return unreachable(e);
    }
  }

  // —— 出向 ③ 传文件 ——
  // 字节流走独立端点, **不进 send 的 payload**: payload 是 JSON, 塞 base64 体积涨 33%,
  // 而且那串东西最终会落进收件 AI 的上下文。文件收发跟 AI 无关 —— 它只该拿到一个 id。
  // 流式上传而不是整个读进内存: 一个大文件就能把 Electron 主进程顶爆。
  async putFile({ path: filePath, to, filename = null } = {}) {
    if (this.kind !== 'bothub') return { ok: false, error: `bus「${this.id}」不是 bothub 协议, 没有文件通道` };
    if (!filePath) return { ok: false, error: 'path 必填' };
    if (!to || !String(to).trim()) return { ok: false, error: 'to 必填' };
    if (!fs.existsSync(filePath)) return { ok: false, error: `文件不存在: ${filePath}` };
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return { ok: false, error: `这是个目录不是文件: ${filePath}` };
    const name = filename || path.basename(filePath);
    const q = `to_agent=${encodeURIComponent(String(to).trim())}&filename=${encodeURIComponent(name)}`
            + `&content_type=${encodeURIComponent(guessContentType(name))}`;
    try {
      // duplex:'half' 是 Node 拿流当 body 的硬要求, 不传会直接抛 TypeError。
      const resp = await fetch(`${this.base_url}/asset?${q}`, {
        method: 'POST',
        headers: this._headers({ 'Content-Type': 'application/octet-stream' }),
        body: Readable.toWeb(fs.createReadStream(filePath)),
        duplex: 'half',
        signal: AbortSignal.timeout(300000),      // 大文件慢, 5 分钟
      });
      const body = await resp.text();
      let j = {}; try { j = JSON.parse(body); } catch (_) { /* 看状态码 */ }
      if (!resp.ok) {
        const detail = (j && (j.detail || j.error)) || body.slice(0, 200);
        return { ok: false, error: `⚠️ 上传失败: HTTP ${resp.status}${detail ? ' ' + detail : ''}` };
      }
      return { ok: true, id: j.id, size: j.size, filename: j.filename || name };
    } catch (e) {
      return { ok: false, error: `⚠️ 上传出错: ${e.message}` };
    }
  }

  // 取文件: 落盘后把**本地绝对路径**交出去 —— AI 用 Read 打开就行, 字节不经过它。
  async getFile({ id, saveDir } = {}) {
    if (this.kind !== 'bothub') return { ok: false, error: `bus「${this.id}」不是 bothub 协议, 没有文件通道` };
    if (id == null || id === '') return { ok: false, error: 'id 必填' };
    try {
      const resp = await fetch(`${this.base_url}/asset/${encodeURIComponent(id)}`, {
        headers: this._headers(), signal: AbortSignal.timeout(300000),
      });
      if (!resp.ok) {
        const body = await resp.text();
        let j = {}; try { j = JSON.parse(body); } catch (_) { /* 看状态码 */ }
        // FastAPI 校验失败的 detail 是数组, 不序列化就打成 [object Object]
        let detail = (j && (j.detail || j.error)) || '';
        if (detail && typeof detail === 'object') detail = JSON.stringify(detail).slice(0, 300);
        return { ok: false, error: `⚠️ 下载失败: HTTP ${resp.status}${detail ? ' ' + detail : ''}` };
      }
      const name = filenameFromDisposition(resp.headers.get('content-disposition')) || `asset-${id}`;
      fs.mkdirSync(saveDir, { recursive: true });
      // 同名不覆盖: 两条消息各带一个 report.pdf, 后到的把先到的冲掉是静默丢数据。
      let full = path.join(saveDir, name);
      if (fs.existsSync(full)) {
        const ext = path.extname(name), base = path.basename(name, ext);
        full = path.join(saveDir, `${base}-${id}${ext}`);
      }
      await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(full));
      return { ok: true, path: full, size: fs.statSync(full).size };
    } catch (e) {
      return { ok: false, error: `⚠️ 下载出错: ${e.message}` };
    }
  }

  // —— 入向: 取件 ——
  // 两族的游标语义不同(v1 是 seq, bothub 是消息 id 的 after_id), 这里统一成
  // { items:[{cursor, type, payload, raw}], nextCursor } —— 调用方只管"处理完再推进"。
  async poll({ cursor = 0, limit = 20, timeoutMs = null } = {}) {
    const agentQ = this.agent ? `agent=${encodeURIComponent(this.agent)}&` : '';
    if (this.kind === 'bothub') {
      const url = `${this.base_url}/inbox?${agentQ}after_id=${cursor || 0}`;
      const { resp, text } = await this._fetch(url, { headers: this._headers() }, timeoutMs || 30000);
      if (!resp.ok) throw authAwareError(resp.status);
      const j = JSON.parse(text || '{}');
      // 防呆: 只认 id 比当前游标大的, 万一服务端返回旧消息也不会死循环
      const msgs = (j.messages || []).filter((m) => (m.id || 0) > (cursor || 0));
      return {
        items: msgs.map((m) => ({ cursor: m.id, type: 'message', payload: m, raw: m })),
        nextCursor: msgs.length ? Math.max(...msgs.map((m) => m.id || 0)) : cursor,
      };
    }
    const url = `${this.base_url}${this.inboxPath}?${agentQ}cursor=${cursor || 0}&wait=${this.wait}&limit=${limit}`;
    const { resp, text } = await this._fetch(url, { headers: this._headers() },
                                             timeoutMs || (this.wait + 10) * 1000);
    if (!resp.ok) throw authAwareError(resp.status);
    const j = JSON.parse(text || '{}');
    const evs = j.events || [];
    return {
      items: evs.map((ev) => ({ cursor: ev.seq, type: ev.type, payload: ev.payload || {}, raw: ev })),
      nextCursor: evs.length ? evs[evs.length - 1].seq : cursor,
    };
  }
}

// 取件循环。原先四份长轮询(个人版 line-relay / agent-bus / bothub-native · 行业版 bus-inbox)
// 各写各的循环、退避、401 判定、游标落盘 —— 一模一样的骨架抄了四遍, 改一处 bug 要改四个地方。
// 真正的差异只有两处: **从哪条 bus 取**(endpoint) 和 **取到之后干什么**(onItem/onBatch),
// 所以只留这两个口子。
//
// 🔴 水位在**处理完之后**才推进: 崩在半路时宁可重投一次, 也不能丢件。
class BusPoller {
  // opts = { endpoint, tag, onLog, onError?, onItem | onBatch, auditFile?, cursorFile?,
  //          loadCursor?, saveCursor?, idleMs? }
  //   onItem(item)   逐条交付, 每条处理完推一次水位 (at-least-once)
  //   onBatch(items) 整批交付 (bothub 的分级唤醒要看整批才能决定唤不唤醒), 批后推一次
  //   loadCursor/saveCursor 给游标不是"一个文件存一个数"的场合 (bothub 多 endpoint 共用一份 JSON)
  //   onError({tag, phase, message, fatal})  取件/交付出错时叫一声。phase: auth|poll|deliver。
  //     日志里那句 `⚠ …` 只有守在屏幕前的人看得见 —— 要让上游(行业版的故障上报)也知道,
  //     就得有个回调口, 靠调用方去 grep 日志文本是把措辞当接口用。
  constructor(opts = {}) {
    this.ep = opts.endpoint || null;
    this.tag = opts.tag || 'bus';
    this.onLog = opts.onLog || (() => {});
    this.onError = opts.onError || null;
    this.onItem = opts.onItem || null;
    this.onBatch = opts.onBatch || null;
    this.auditFile = opts.auditFile || null;
    this.cursorFile = opts.cursorFile || null;
    this._load = opts.loadCursor || null;
    this._save = opts.saveCursor || null;
    // 空批之后至少歇一下, 下限在引擎兜底而不是靠每个调用点记得传 —— 三个 v1 长轮询调用点
    // (行业版 bus-inbox · 个人版 agent-bus/line-relay) 一个都没传, 等于把"不空转"整个押在
    // 服务端真的 hold 上。哪天换个立刻返回空批的 bus 实现, 这个循环就是满速打请求。
    // 长轮询本来就是 hold 满 25 秒才返空批, 多歇 1 秒对延迟没有可观察的影响。
    this.idleMs = Math.max(opts.idleMs || 0, 1000);  // bothub 那种短轮询自己传更大的值
    this.cursor = 0;
    this.stopped = false;
    this.startedAt = 0;
    this.lastError = null;
    this.msgCount = 0;
  }

  _loadCursor() {
    if (this._load) { this.cursor = this._load() || 0; return; }
    if (!this.cursorFile) return;
    try {
      if (fs.existsSync(this.cursorFile)) {
        this.cursor = parseInt(fs.readFileSync(this.cursorFile, 'utf8').trim(), 10) || 0;
      }
    } catch (_) { /* 读不出来就从 0 开始, 大不了重投 */ }
  }

  _saveCursor() {
    if (this._save) { this._save(this.cursor); return; }
    if (!this.cursorFile) return;
    try { fs.writeFileSync(this.cursorFile, String(this.cursor)); } catch (_) {}
  }

  // 上报口炸了不能连累取件 —— 报故障的那条路自己出故障, 是最不该停掉通道的时候。
  _tell(phase, message, fatal) {
    if (!this.onError) return;
    try { this.onError({ tag: this.tag, phase, message: String(message || ''), fatal: !!fatal }); }
    catch (e) { this.onLog(`[${this.tag}] ⚠ onError 回调自己炸了: ${e && e.message}`); }
  }

  _audit(raw) {
    if (!this.auditFile) return;
    try {
      fs.mkdirSync(path.dirname(this.auditFile), { recursive: true });
      fs.appendFileSync(this.auditFile, JSON.stringify(raw) + '\n', 'utf8');
    } catch (e) {
      this.onLog(`[${this.tag}] ⚠ 写审计日志失败: ${e.message}`);
    }
  }

  start() {
    if (this.stopped) return { ok: false, error: '已停止' };
    if (this.startedAt) return { ok: true, note: '已在跑' };
    if (!this.ep || !this.ep.ok) return { ok: false, error: '缺 bus base_url' };
    if (!this.ep.token) return { ok: false, error: '缺 token' };
    this._loadCursor();
    this.startedAt = Date.now();
    this.onLog(`[${this.tag}] ▶ 取件开始 · ${this.ep.base_url} · cursor=${this.cursor}`);
    this._loop().catch((e) => this.onLog(`[${this.tag}] ⚠ loop 崩溃: ${e && e.message}`));
    return { ok: true };
  }

  async _loop() {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        const { items, nextCursor } = await this.ep.poll({ cursor: this.cursor });
        if (this.onBatch) {
          if (items.length) {
            for (const it of items) this._audit(it.raw);
            this.msgCount += items.length;
            await this.onBatch(items);
          }
          if (nextCursor !== this.cursor) { this.cursor = nextCursor; this._saveCursor(); }
        } else {
          for (const it of items) {
            this._audit(it.raw);
            this.msgCount += 1;
            try {
              await this.onItem(it);
            } catch (e) {
              // 收件方炸了不能停掉整条通道: 一件毒消息堵死所有人, 损失比丢一件大。
              this.onLog(`[${this.tag}] ⚠ 交付失败 cursor=${it.cursor}: ${e && e.message}`);
              this._tell('deliver', `cursor=${it.cursor} type=${it.type}: ${e && e.message}`, false);
            }
            this.cursor = it.cursor;
            this._saveCursor();
          }
        }
        this.lastError = null;
        backoff = 1000;
        if (!items.length && this.idleMs) await new Promise((r) => setTimeout(r, this.idleMs));
      } catch (e) {
        if (this.stopped) return;
        if (e && e.authFailed) {
          this.onLog(`[${this.tag}] ⚠ token 无效 (${e.message}), 取件停止`);
          this.stopped = true;
          this.lastError = 'token 无效';
          // 通道就此停住, 不会再有下一次退避来提醒谁 —— 所以这一声必须发出去。
          this._tell('auth', `token 无效 (${e.message}), 取件停止`, true);
          return;
        }
        this.lastError = e && e.message;
        this.onLog(`[${this.tag}] ⚠ ${this.lastError} · 退避 ${backoff}ms`);
        this._tell('poll', this.lastError, false);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  }

  status() {
    return {
      running: !!this.startedAt && !this.stopped,
      cursor: this.cursor, msgCount: this.msgCount, lastError: this.lastError,
    };
  }

  async stop() { this.stopped = true; return { ok: true }; }
}

// 有序的 bus 目标表。**第一个是默认** —— 只配了一个的那一版(行业版起步时)什么都不用改,
// 不指定 bus 就是它。
class BusRegistry {
  constructor(specs = []) {
    this.list = (Array.isArray(specs) ? specs : [])
      .filter((s) => s && s.base_url)
      .map((s) => (s instanceof BusEndpoint ? s : new BusEndpoint(s)));
  }

  get size() { return this.list.length; }
  ids() { return this.list.map((b) => b.id); }
  all() { return [...this.list]; }
  get default() { return this.list[0] || null; }

  // 不给 id = 用默认那条。给了但找不到 → null(让调用方报"没有这条 bus", 而不是悄悄发错地方)。
  get(id) {
    if (!id) return this.default;
    return this.list.find((b) => b.id === id) || null;
  }

  // 给 AI 看的一览: 有哪几条、各自什么协议、能干什么。
  describe() {
    if (!this.list.length) return '(这台机器没有配任何 bus)';
    return this.list.map((b, i) => {
      const acts = b.kind === 'bothub' ? 'send' : 'exec / call';
      return `- \`${b.id}\`${i === 0 ? ' (默认)' : ''} · ${b.label} · ${b.kind} · ${acts}`;
    }).join('\n');
  }
}

module.exports = { BusEndpoint, BusRegistry, BusPoller, errorDetail, errorText, KINDS };
