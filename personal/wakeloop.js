// wakeloop.js — 唤醒环路(永存第3柱): 常驻后台盯事件源 → 叫醒人格 Butler → 处理 → 按来源回出去。
// 让管家从"开窗口才在"变成"24/7 常驻、有事自己醒来回你"。headless, 不依赖 Electron 窗口。
// 设计: butler 不重造 TG/bus 协议, 全复用数据中心现成脚本(send_tg.py / agent_bus_send.py / tg_listener 写的 messages.jsonl)。
// 事件源: ①agent-bus(HTTP 轮询 inbox) ②TG(读 messages.jsonl, 人格 tg.json 配 chat_ids/@我)。回复也走那两个脚本。
// 用法: node wakeloop.js <人格目录>   环境: WAKE_AGENT(bus身份, 默认 worker_ant) / DC_ROOT / WAKE_POLL_MS
// 部署配置: 仓根 config.local.json (gitignored) — {"DC_ROOT": "<数据中心根目录>", "BUS_BASE": "<agent-bus API 地址>"};
// 环境变量同名项优先于 config.local.json。两处都没有则启动即失败(fail-fast)。
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { Butler } = require('../core/agent');

const LOCAL_CONF = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.local.json'), 'utf8')); } catch { return {}; }
})();
const conf = (key) => process.env[key] || LOCAL_CONF[key] ||
  (() => { throw new Error(`缺配置 ${key}: 设环境变量或写进 ${path.join(__dirname, 'config.local.json')}`); })();

const HOME = path.resolve(process.argv[2] || process.cwd());
const SELF_AGENT = process.env.WAKE_AGENT || 'worker_ant';
const DC_ROOT = conf('DC_ROOT');
const NOTIFY = path.join(DC_ROOT, '.claude/database/scripts/notify');
const BUS_BASE = conf('BUS_BASE');
const POLL_MS = Number(process.env.WAKE_POLL_MS || 15000);
const CURSOR_FILE = path.join(HOME, '.wakeloop-cursor.json');

// 人格的 TG 绑定(tg.json: {chat_ids:[...], self_mention:"@xxx_bot", title, messages_file?}); 无则不收 TG。
function loadTg() {
  for (const p of [path.join(HOME, 'tg.json'), path.join(HOME, '.claude/memory/tg.json')]) {
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {}
  }
  return null;
}
const TG = loadTg();
const TG_FILE = (TG && TG.messages_file) || path.join(DC_ROOT, '.claude/database/inbox/messages.jsonl');

const log = (m) => {
  const _n = new Date();
  const _hms = `${String(_n.getHours()).padStart(2, '0')}:${String(_n.getMinutes()).padStart(2, '0')}:${String(_n.getSeconds()).padStart(2, '0')}`;
  console.log(`[wake ${_hms}] ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 跑现成 python 脚本(取 token / 发 bus / 发 TG)
function py(args) {
  return new Promise((resolve, reject) => {
    execFile('python3', args, { cwd: DC_ROOT, timeout: 30000 },
      (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim()));
  });
}
const getToken = () => py(['-c', `import sys;sys.path.insert(0,'${NOTIFY}');from agent_bus_send import get_token;print(get_token())`]);
const replyBus = (to, text) => py([path.join(NOTIFY, 'agent_bus_send.py'), '--to', to, '--from-agent', SELF_AGENT, '--text', text]);
const replyTg = (chatId, text) => py([path.join(NOTIFY, 'send_tg.py'), '--to', String(chatId), '--plain', '--title', (TG && TG.title) || '全能管家', '--body', text]);

async function pollBus(afterId, token) {
  const r = await fetch(`${BUS_BASE}/inbox?agent=${encodeURIComponent(SELF_AGENT)}&after_id=${afterId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`inbox HTTP ${r.status}`);
  return (await r.json()).messages || [];
}
// 读 messages.jsonl 里 update_id 更新、且"是发给本人格"的 TG 消息(群里必 @我; 私聊都算; 跳过自己发的)
function pollTg(afterId) {
  if (!TG) return [];
  let lines; try { lines = fs.readFileSync(TG_FILE, 'utf8').trim().split('\n'); } catch { return []; }
  const chats = TG.chat_ids || []; const mention = TG.self_mention || '';
  const out = [];
  for (const ln of lines) {
    let m; try { m = JSON.parse(ln); } catch { continue; }
    if (!m || (m.update_id || 0) <= afterId || !m.text) continue;
    if (!chats.includes(m.chat_id)) continue;
    if (m.chat_id < 0 && !(mention && String(m.text).includes(mention))) continue; // 群: 必 @我
    out.push(m);
  }
  return out;
}

const loadCursor = () => { try { const c = JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8')); return { bus: c.bus || 0, tg: c.tg || 0, sched: c.sched || {} }; } catch { return { bus: 0, tg: 0, sched: {} }; } };
const saveCursor = (c) => { try { fs.writeFileSync(CURSOR_FILE, JSON.stringify(c), 'utf8'); } catch (_) {} };
const maxId = (arr, k) => arr.reduce((m, x) => Math.max(m, x[k] || 0), 0);

// 驱动 Butler: submit 一条 → 等下个 onResult(串行, FIFO 对应)。返回 finalText。
function makeAsk(butler) {
  let pending = null;
  butler.setCallbacks({
    onText: () => {}, onUsage: () => {}, onActivity: (a) => log(`  ·活动: ${a}`),
    onResult: ({ finalText, interrupted }) => { if (pending && !interrupted) { const p = pending; pending = null; p(finalText || ''); } },
  });
  return (text) => new Promise((resolve) => { pending = resolve; butler.submit(text); });
}

// 处理一批事件: 逐条唤醒→回。srcLabel 只为日志; reply(m, text) 负责发回。
async function handle(msgs, ask, cursor, cursorKey, idKey, promptOf, reply, srcLabel) {
  for (const m of msgs) {
    cursor[cursorKey] = Math.max(cursor[cursorKey], m[idKey] || 0);
    log(`${srcLabel} #${m[idKey]}: ${String(m.text).slice(0, 70)}`);
    let out = ''; try { out = await ask(promptOf(m)); } catch (e) { log(`  处理失败: ${e.message}`); }
    if (out && out.trim()) { try { await reply(m, out.trim()); log(`  ↩ 已回 (${out.trim().length}字)`); } catch (e) { log(`  回复失败: ${e.message}`); } }
    saveCursor(cursor);
  }
}

async function main() {
  const butler = new Butler(HOME);
  const ask = makeAsk(butler);
  const token = await getToken();
  let cursor = loadCursor();
  if (!cursor.bus && !cursor.tg) {                 // 首启: 不吃历史积压, cursor 设为当前最大
    cursor = { ...cursor, bus: maxId(await pollBus(0, token), 'id'), tg: maxId(pollTg(0), 'update_id') };
    saveCursor(cursor);
    log(`首启跳积压 → cursor bus=${cursor.bus} tg=${cursor.tg}`);
  }
  // 定时任务不归这里: schedule.json / reminders.json 统一由 core/idle-watcher.js 的巡检驱动(两版 app 内),
  // 这边再跑一份会把同一条发两遍(各存各的游标, 互相看不见)。
  log(`唤醒环路上线: 人格=${butler.name} bus=${SELF_AGENT} TG=${TG ? (TG.chat_ids || []).join(',') : '未配'} 轮询=${POLL_MS}ms`);

  for (;;) {
    try {
      const bus = (await pollBus(cursor.bus, token)).filter((m) => m.from_agent !== SELF_AGENT);
      await handle(bus, ask, cursor, 'bus', 'id',
        (m) => `[agent-bus · 来自 ${m.from_agent}]\n${m.text}\n\n(别的 agent 发来的, 你的回复会自动 bus 回给 ${m.from_agent}, 简洁直接。)`,
        (m, t) => replyBus(m.from_agent, t), 'bus');
      const tg = pollTg(cursor.tg);
      await handle(tg, ask, cursor, 'tg', 'update_id',
        (m) => `[TG · 来自 ${m.from_name}, chat ${m.chat_id}]\n${m.text}\n\n(你的回复会自动 send_tg 发回该 chat。直接写要回的内容。)`,
        (m, t) => replyTg(m.chat_id, t), 'TG');
    } catch (e) { log(`轮询错误: ${e.message}`); }
    await sleep(POLL_MS);
  }
}

main().catch((e) => { log(`致命: ${e.stack || e.message}`); process.exit(1); });
