'use strict';
// tool-log.js — 每次工具调用落一行日志: 数据目录/logs/tool_calls/YYYY-MM-DD.jsonl。
//
// 为什么要有: 对话里的工具调用条默认藏了(作者 11-09), 而 API Key 接入的自家引擎原先只在 ctx_sample 里记工具名 ——
// 人格出了岔子, AI 回头查不到「它传了什么参数、工具回了什么」。订阅接入的会话 jsonl 里虽有全量, 两种接入在这儿一个格式。
// 两种引擎都把工具结果作为 user 消息里的 tool_result 块流回来, 所以开头记在 tool_use、收尾记在 tool_result, 按 id 配对。
// 参数和结果各截前 CAP 字(要的是看得出发生了什么, 不是备份); 文件只留 KEEP_DAYS 天。
const fs = require('fs');
const path = require('path');
const { paths } = require('../host');

const CAP = 2000;
const KEEP_DAYS = 14;
const MAX_OPEN = 200;   // 没等到结果的(回合被打断)不能一直攒着

const open = new Map();   // tool_use id → { at, persona, tool, args, t0 }
let prunedDay = '';

const cut = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v == null ? '' : v);
  return s.length > CAP ? `${s.slice(0, CAP)}…(+${s.length - CAP})` : s;
};
// tool_result 的 content 可以是串, 也可以是 [{type:'text',text}|{type:'image',…}] —— 图只记一个占位
const textOf = (c) => (typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((p) => (p && p.type === 'text' ? p.text : `[${(p && p.type) || '?'}]`)).join('\n') : c);

function dir() { return path.join(paths.dataDir(), 'logs', 'tool_calls'); }

function prune(d, today) {
  if (prunedDay === today) return;
  prunedDay = today;
  const limit = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  try { for (const f of fs.readdirSync(d)) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) < limit) fs.unlinkSync(path.join(d, f)); } catch (_) {}
}

function write(rec) {
  try {
    const d = dir();
    fs.mkdirSync(d, { recursive: true });
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    prune(d, day);
    fs.appendFileSync(path.join(d, `${day}.jsonl`), `${JSON.stringify(rec)}\n`);
  } catch (e) { console.log(`[tool-log] 落盘失败: ${e.message}`); }
}

/** assistant 消息里的 tool_use 块 → 记下开头, 等结果。 */
function start(agentName, b) {
  if (!b || !b.id) return;
  if (open.size >= MAX_OPEN) {   // 最老的那条等不到了: 照样留一行, 标明没有结果
    const [id, r] = open.entries().next().value;
    open.delete(id);
    write({ ...r, result: null, error: null, ms: null, note: 'no_result' });
  }
  open.set(b.id, { at: new Date().toISOString(), persona: agentName, tool: b.name, args: cut(b.input || {}), t0: Date.now() });
}

/** user 消息里的 tool_result 块 → 配上开头写一行。 */
function finish(b) {
  if (!b || !b.tool_use_id) return;
  const r = open.get(b.tool_use_id);
  if (!r) return;
  open.delete(b.tool_use_id);
  const { t0, ...rest } = r;
  write({ ...rest, result: cut(textOf(b.content)), error: !!b.is_error, ms: Date.now() - t0 });
}

module.exports = { start, finish, CAP, KEEP_DAYS };
