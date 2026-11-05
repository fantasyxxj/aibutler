// 出向通道的 MCP 工具: send_tg · bus_exec · bus_admin(send / put_file / get_file)。
//
// 🔴 send_line 那一族(text/image/sticker/flex)已删除。作者 2026-08-24:
//   「不需要有 send_line 这个工具。line 必须通过服务端转发…… 发送 line 其实是 bus 里面的
//     一个功能, 不是一个专门的工具。」
//   实情也确实如此: 那 4 个工具 + 164 行 LineRelayChannel 打的就是 POST /bus/v1/line/send,
//   跟能力包里三行声明式 JSON 表达的是同一件事。要发 LINE 就用包里的 send_line(pack tool)
//   或 bus_exec, 不必在内核里给它开专用通道。
//
// 留在这里的两类: send_tg 不走我们的服务端(直打 Telegram Bot API), 所以它不是 bus;
// bus_admin / bus_exec 都走 core/bus.js 那一份客户端, 只是协议族不同(bothub / v1)。
//
// 作者 2026-08-26 定的文件收发口径仍然成立, 现在住在 bus_admin 的 put_file/get_file 两个 op 里:
//「文件的收发过程本身跟 ai 无关, 程序收下来之后保存好, 告诉 ai 地址就好了」—— AI 只经手
// 【路径】和【asset_id】, 字节流全在程序里走: 不 base64、不进 payload、不让 AI 去 curl。
// 文件内容一旦进上下文, 一张图就能烧掉一轮。
const path = require('path');
const fs = require('fs');
const { cfg } = require('../host');
const { stripSsmlForPlainText } = require('./util');
const { looseShape, gather } = require('./flat-args');

class McpChannelsMixin {
  _channelTools({ tool, z, D }) {
    // v2 (2026-07-07): send_tg — 通过 Telegram Bot API 直接发消息, 废掉 python send_tg.py 依赖。
    // bot_token 从 registry.plugins.tg.bot_token 走 setTgConfig 注入, 每人格独立。
    const sendTg = tool(
      'send_tg',
      D.send_tg,
      { chat_id: z.union([z.string(), z.number()]).describe('目标聊天 ID (私聊: 用户 id; 群: 负数群 id)'),
        text: z.string().describe('消息正文'),
        plain: z.boolean().optional().describe('true = 禁 Markdown, 保留特殊字符; 缺省 false = Markdown 解析'),
        reply_to: z.number().optional().describe('引用某条消息 (对方 message_id)'),
        attach: z.string().optional().describe('本地文件绝对路径; text 作 caption。图片(jpg/png/gif/webp)按图发, 对方能直接看; 其余按文件发') },
      async ({ chat_id, text, plain, reply_to, attach }) => {
        if (!this.tgBotToken) {
          return { content: [{ type: 'text', text: '⚠️ send_tg 不可用: 该人格未配 tg bot_token' }] };
        }
        // 出口物理门: 无条件剥 SSML 标签 (TG 永不朗读, 有标签就是脏字符串)
        text = stripSsmlForPlainText(text);
        // 网络类失败自动重试(undici 首次 DNS/TLS 抖动 / TG 5xx / 429 rate limit); 4xx 立刻返回不重试
        // [[feedback_transient_failure_retry_before_root_change]]: 3 次尝试, 线性退避 500ms/1500ms
        const doFetch = async (url, opts) => {
          const delays = [0, 500, 1500];   // 3 次尝试: 立刻 / 500ms 后 / 1500ms 后
          let lastErr = null;
          for (let i = 0; i < delays.length; i++) {
            if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
            try {
              const resp = await fetch(url, opts);
              // 5xx 或 429 视为可重试; 4xx (401/400) 是永久性错误立刻返回
              if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
                lastErr = new Error(`HTTP ${resp.status}`);
                if (i < delays.length - 1) continue;
                return resp;   // 最后一次即使 5xx 也返回, 上层解析 body
              }
              return resp;
            } catch (e) {
              lastErr = e;
              if (i < delays.length - 1) continue;
              throw lastErr;
            }
          }
          throw lastErr;
        };
        try {
          const parseMode = plain ? undefined : 'Markdown';
          let resp;
          if (attach) {
            if (!fs.existsSync(attach)) return { content: [{ type: 'text', text: `⚠️ attach 文件不存在: ${attach}` }] };
            const buf = fs.readFileSync(attach);
            // 🔴 multipart 手工拼, 不用 FormData —— proxy.js 把 globalThis.fetch 换成了 npm undici
            // 那个实例, 而 FormData/Blob 仍是 Node 内建的类。npm undici 认不出内建 FormData, 于是
            // 整个 body 被静默丢掉, TG 回 "there is no document in the request"(图片同理, sendPhoto
            // 失败后退回 sendDocument, 所以报的也是 document)。只经手 Buffer 就跟谁家的 fetch 都无关。
            const post = (method, field) => {
              const boundary = '----butler' + Math.random().toString(16).slice(2);
              const parts = [];
              const fld = (name, value) => parts.push(Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
              fld('chat_id', String(chat_id));
              fld('caption', text);
              if (parseMode) fld('parse_mode', parseMode);
              if (reply_to) fld('reply_to_message_id', String(reply_to));
              parts.push(Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="${field}";`
                + ` filename="${path.basename(attach).replace(/"/g, '')}"\r\n`
                + 'Content-Type: application/octet-stream\r\n\r\n', 'utf8'));
              parts.push(buf);
              parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
              return doFetch(`https://api.telegram.org/bot${this.tgBotToken}/${method}`, {
                method: 'POST',
                headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
                body: Buffer.concat(parts),
              });
            };
            const isImage = /\.(jpe?g|png|gif|webp)$/i.test(attach);
            resp = isImage ? await post('sendPhoto', 'photo') : await post('sendDocument', 'document');
            if (isImage) {
              // TG 对 sendPhoto 有像素与体积上限, 超限的图退回按文件发, 否则对方什么都收不到
              const j0 = await resp.clone().json().catch(() => null);
              if (j0 && !j0.ok) resp = await post('sendDocument', 'document');
            }
          } else {
            const payload = { chat_id, text };
            if (parseMode) payload.parse_mode = parseMode;
            if (reply_to) payload.reply_to_message_id = reply_to;
            resp = await doFetch(`https://api.telegram.org/bot${this.tgBotToken}/sendMessage`, {
              method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
            });
          }
          const j = await resp.json();
          if (!j.ok) return { content: [{ type: 'text', text: `⚠️ TG API 拒: ${j.description || j.error_code || 'unknown'}` }] };
          return { content: [{ type: 'text', text: `✅ 已发 chat=${chat_id} message_id=${j.result && j.result.message_id}` }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `⚠️ send_tg 3 次重试全失败: ${e.message}` }] };
        }
      }
    );
    // —— bus_admin: bothub 那条 bus 上的四件事(按名字找人 / 发消息 / 发文件 / 取文件)并成一个口 ——
    // 分法依据是真实频次(6149 份 transcript): send 169 次 · put_file 4 次 · get_file 1 次,
    // 三件合计 174 次, 远低于留独立的 bus_exec(506) 与 send_tg(512) —— 热路径每次多包一层
    // args 是白付的 token, 冷路径并起来省的是每轮都在付的常驻工具位。
    //
    // 🔴 每个 op 都必须在说明里逐个点名。并进来之前它们各自的工具名就是触发信号(「我要发文件」
    //    → 看见 bus_put_file), 名字消失而说明只写「bus 相关的其它操作」的话, 这个能力对 AI
    //    就等于不存在了。见 memory_admin 那次的教训。
    const BUS_OPS = {
      // to_agent 要的是号(agent-6d79), 人只知道名字。号在 hub 批准时发, 本人名字是申请时填的。
      find: { req: ['name'], opt: ['bus'],
        hint: 'name 写对方本人的名字或人格名, 写一部分也行。查到号再用 op=\'send\' 发给他。',
        run: async (a, ep) => {
          const r = await ep.call({ method: 'GET', path: '/agents', query: { name: String(a.name).trim() } });
          if (!r.ok) return `⚠️ 查找失败: ${r.error}`;
          let list = [];
          try { list = (JSON.parse(r.text).agents) || []; } catch (_) { return '⚠️ 查找失败: hub 回的不是 JSON'; }
          if (!list.length) return `没找到名字里含「${a.name}」的人 —— 对方可能还没在 hub 上登记本人名字。`;
          const lines = list.map((x) => `- ${x.agent_name} · 本人 ${x.owner_name || '(没登记)'} · 人格 ${x.display_name || '-'}`
            + (x.last_seen_at ? ` · 最近在线 ${String(x.last_seen_at).slice(0, 16).replace('T', ' ')}` : ''));
          return `找到 ${list.length} 个:\n${lines.join('\n')}${list.length > 1 ? '\n不止一个时让用户挑, 别自己猜。' : ''}`;
        } },
      send: { req: ['to_agent', 'text'], opt: ['payload', 'bus'],
        hint: 'to_agent 写 "all" 是广播。payload 是给对方的结构化数据。',
        run: async (a, ep) => {
          // 平铺参数里没声明的 payload 常被模型写成 JSON 字符串, 原样转发服务端回 422(它要 dict)
          let payload = a.payload;
          if (typeof payload === 'string') {
            try { payload = payload.trim() ? JSON.parse(payload) : {}; } catch (_) { return `⚠️ payload 不是合法 JSON: ${payload.slice(0, 80)}`; }
          }
          if (payload != null && (typeof payload !== 'object' || Array.isArray(payload))) return '⚠️ payload 要写成对象, 如 {"asset_id": 31}';
          // 出口物理门: 同 send_tg, 出向文本永不朗读, SSML 标签无条件剥掉。
          const r = await ep.send({ to: a.to_agent, text: stripSsmlForPlainText(a.text), payload });
          return r.ok ? r.text : r.error;
        } },
      put_file: { req: ['file_path', 'to_agent'], opt: ['bus'],
        hint: 'file_path 是本地绝对路径; 字节流全在程序里走, 不要自己 base64 或 curl。',
        run: async (a, ep) => {
          const r = await ep.putFile({ path: a.file_path, to: a.to_agent });
          if (!r.ok) return r.error;
          return `✅ 已上传 asset_id=${r.id} (${r.filename}, ${r.size} 字节)\n`
            + `告诉对方: 发消息时把 payload 写成 {"asset_id": ${r.id}}, 他用 op='get_file' 取。`;
        } },
      get_file: { req: ['asset_id'], opt: ['bus'],
        hint: 'asset_id 是对方消息里给的那个值。',
        run: async (a, ep) => {
          const r = await ep.getFile({ id: a.asset_id, saveDir: path.join(this.homeDir, 'downloads') });
          return r.ok ? `✅ 已存到 ${r.path} (${r.size} 字节) —— 要看内容用 Read 打开它。` : r.error;
        } },
    };
    const busAdmin = tool(
      'bus_admin',
      D.bus_admin,
      looseShape(z, { op: z.enum(Object.keys(BUS_OPS)) }),
      async (input) => {
        const { op } = input;
        const args = gather(input, ['op']);
        const spec = BUS_OPS[op];
        const a = args || {};
        const missing = spec.req.filter((k) => a[k] === undefined || a[k] === null);
        if (!args || missing.length) {
          return { content: [{ type: 'text', text:
            `op='${op}' 需要 ${spec.req.map((k) => `${k}=…`).join(', ')}${spec.opt.length ? ` · 可选 ${spec.opt.join(', ')}` : ''}`
            + `${missing.length && args ? `\n缺: ${missing.join(', ')}` : ''}\n${spec.hint}` }] };
        }
        const ep = a.bus ? this.buses.get(a.bus) : this.buses.all().find((b) => b.kind === 'bothub');
        if (!ep) {
          return { content: [{ type: 'text', text: a.bus
            ? `⚠️ 没有名为「${a.bus}」的 bus。现有:\n${this.buses.describe()}`
            : '⚠️ 这台机器没有配 bothub 协议的 bus' }] };
        }
        return { content: [{ type: 'text', text: String(await spec.run(a, ep)) }] };
      }
    );
    // 往某条 bus 投一次调用。**发 LINE、查预约这类事都是它** —— 那些不是"专门的工具",
    // 就是 bus 上的一个 command(作者 2026-08-24)。装了能力包的话优先用包里那些名字明确的
    // 工具, 这个是给"包里没有、但服务端有"的情况留的口子。
    const busExec = tool(
      'bus_exec',
      D.bus_exec,
      looseShape(z, { command: z.string().describe('要执行的 command(如 apicall); 这次调用的内容直接写在后面, apicall 是 method=…, path=…, query=…|body=…'),
        bus: z.string().optional().describe('往哪条 bus 发(缺省=第一条)'),
        correlation_id: z.string().optional().describe('把这次调用跟某件事关联起来; 重试时传同一个值才会被服务端当成同一次') }),
      async (input) => {
        const { command, bus, correlation_id } = input;
        // 旧写法 content={…} 照收
        const { content: legacy, ...flat } = input;
        const content = { ...((legacy && typeof legacy === 'object') ? legacy : {}), ...(gather(flat, ['command', 'bus', 'correlation_id']) || {}) };
        const ep = this.buses.get(bus);
        if (!ep) {
          return { content: [{ type: 'text', text: `⚠️ ${bus ? `没有名为「${bus}」的 bus` : '这台机器没有配任何 bus'}。现有:\n${this.buses.describe()}` }] };
        }
        if (ep.kind !== 'v1') {
          return { content: [{ type: 'text', text: `⚠️ bus「${ep.id}」是 ${ep.kind} 协议, 只能 send_bothub, 不能 exec` }] };
        }
        const r = await ep.exec({ command, content, correlationId: correlation_id || null });
        return { content: [{ type: 'text', text: r.ok ? String(r.text).slice(0, 30000) : r.error }] };
      }
    );
    return { sendTg, busExec, busAdmin };
  }
}

module.exports = McpChannelsMixin;
