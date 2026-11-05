// chat-store.js — 会话持久化: 每轮把对话+session_id+usage 存盘, 启动时载回。两版共用。
// 路径全由调用方给: 个人版一人格一份(在其记忆目录旁), 行业版只有一个人格。
//
// 两份东西, 职责不同, 别混:
//   .session.json  —— 会话状态 + 最近 400 条的**快照**。开窗口只读它, 秒开, 不碰日志。
//   history/*.jsonl —— 只增不改的**日志**, 按天一个文件。往上翻历史时才读。
// 2026-08-27 之前只有前者, 于是"超过 400 条的对话在落盘那一刻就被永久截掉了" ——
// 屏幕上还留着几千条(内存里的 convo 不截断), 让人误以为存着, 关掉窗口才发现没了。
const fs = require('fs');
const path = require('path');

const MAX_MSGS = 400; // 快照只留最近 N 条, 防文件无限涨(日志那份不截断)

// state 形状: { sessionId, model, window, lastInput, pendingHandoff, messages:[{role,text,ts}] }
function load(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!s || typeof s !== 'object') return null;
    return s;
  } catch (e) {
    return null;
  }
}

function save(file, state) {
  try {
    const trimmed = {
      ...state,
      messages: Array.isArray(state.messages) ? state.messages.slice(-MAX_MSGS) : [],
    };
    fs.writeFileSync(file, JSON.stringify(trimmed), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

// ---- 聊天日志(只增不改, 按天一个文件) ----
// 一行一条 JSON: 追加只是 append 一行, 不读不改不重写 —— 写入代价与历史长度无关。
// 按天切: 单文件不会长到读不动, 往上翻时从今天倒着翻, 天然就是分页。
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const dayOf = (ts) => {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function appendHistory(dir, msgs) {
  if (!dir || !Array.isArray(msgs) || !msgs.length) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 一批里可能跨天(比如零点前后), 按天分组各写各的文件
    const byDay = new Map();
    for (const m of msgs) {
      if (!m) continue;
      const day = dayOf(m.ts);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(JSON.stringify(m));
    }
    for (const [day, lines] of byDay) {
      fs.appendFileSync(path.join(dir, day + '.jsonl'), lines.join('\n') + '\n', 'utf8');
    }
    return true;
  } catch (e) {
    return false;
  }
}

// 取【比 beforeTs 更早】的最后 limit 条, 按时间正序返回。beforeTs 省略 = 从最新往回取。
//
// 🔴 用游标(时间戳)不用条数(skip)。老写法是"从日志尾部跳过屏幕上已有的 N 条", 它成立的前提是
// 【屏幕上那 N 条 ≡ 日志尾部那 N 条】—— 而这个前提根本不成立:
//   ① 开窗时屏幕是拿 `.session.json` 快照画的, 快照与日志是两份独立的东西;
//   ② 日志功能 2026-08-27 才上线, 之前快照里攒的消息永远不会补写进日志
//      (`logged = convo.length` 起手就把它们记成"已写过");
//   ③ display:'' 的机器标记进快照不进日志。
// 实测某人格: 快照 400 条覆盖 8/9~9/1, 日志只有 73 条覆盖 8/31~9/1, 327 条对不上 ——
// 于是 skip 恒偏, 屏幕最早那条明明是 8/20 的, 往前数 200 条却落在 8/31, 中间整段被跳过。
// 症状是"往上拉, 上一条从今天早上跳到昨天下午"。
// 游标没有这个前提: 问的是"比这条更早的", 屏幕上画的是什么来源都不影响。
function readHistoryBefore(dir, beforeTs, limit) {
  const out = [];
  if (!dir || !(limit > 0)) return out;
  let files;
  try { files = fs.readdirSync(dir).filter((f) => DAY_FILE.test(f)).sort(); }
  catch (e) { return out; }
  // 0 和 undefined 都当"没有游标"= 从最新开始。用 Number.isFinite 而不是 || ——
  // beforeTs 传 0 时 || 会退回 Infinity, 语义正好是"全都要", 与"从头开始"撞不到一起纯属侥幸。
  const cut = Number.isFinite(beforeTs) && beforeTs > 0 ? beforeTs : Infinity;
  for (let i = files.length - 1; i >= 0 && out.length < limit; i--) {
    // 文件名就是日期: 整个文件都不比游标早的话连读都不用读(日志按天切, 天然有序)
    if (cut !== Infinity && files[i].slice(0, 10) > dayOf(cut)) continue;
    let lines;
    try { lines = fs.readFileSync(path.join(dir, files[i]), 'utf8').split('\n'); }
    catch (e) { continue; }
    for (let j = lines.length - 1; j >= 0 && out.length < limit; j--) {
      if (!lines[j]) continue;
      let m;
      try { m = JSON.parse(lines[j]); } catch (e) { continue; }  // 坏行跳过, 不让一行毁掉整段
      if (!m) continue;
      // 严格小于: 等于游标的就是屏幕上最早那条自己, 收进来会画出一条重复的
      if (!(Number(m.ts) < cut)) continue;
      out.push(m);
    }
  }
  return out.reverse();
}

// 单次搜索最多读进内存多少条 —— 够不够得着比快不快重要, 但也不能让一次查把主线程占住。
// 到顶就停, 并在结果里把 scanTruncated 标出来: 截断了却不说, 调用方会拿"没找到"当"没发生过"。
const MAX_SCAN = 50000;

// 按关键词搜本人格的聊天日志。返回**最新**的 limit 条, 并**始终**带上 total ——
// 🔴 total 不是装饰: 命中 100 条只回 10 条时, 调用方必须知道自己拿的是一角而不是全貌。
// 静默截断踩过一次(talk_peer 长消息两端都无标记, 发送方以为发完了), 这里不重演。
//
// 先 AND(全部词都出现)。AND 一条都没有才回落 OR, 并把 matched 改成 'any' 告诉调用方口径变了 ——
// 不回落的话, 多给一个词就可能把真有的结果筛成零, 而"零结果"会被读成"从来没聊过"。
function searchHistory(dir, opts = {}) {
  const terms = (opts.terms || []).map((t) => String(t || '').toLowerCase()).filter(Boolean);
  const limit = Math.max(1, Math.min(Number(opts.limit) || 10, 50));
  const clip = Math.max(80, Math.min(Number(opts.clip) || 400, 2000));
  const before = Number.isFinite(opts.before) && opts.before > 0 ? opts.before : Infinity;
  const empty = { total: 0, returned: 0, truncated: false, scanTruncated: false, matched: 'all', hits: [] };
  if (!dir || !terms.length) return empty;

  let files;
  try { files = fs.readdirSync(dir).filter((f) => DAY_FILE.test(f)).sort(); }
  catch (e) { return empty; }

  // 时间正序读进来, 相邻两条才好当上下文取。从最新的文件往回读, 到量就停。
  const all = [];
  let scanTruncated = false;
  for (let i = files.length - 1; i >= 0; i--) {
    if (all.length >= MAX_SCAN) { scanTruncated = true; break; }
    if (before !== Infinity && files[i].slice(0, 10) > dayOf(before)) continue;
    let lines;
    try { lines = fs.readFileSync(path.join(dir, files[i]), 'utf8').split('\n'); }
    catch (e) { continue; }
    const day = [];
    for (const ln of lines) {
      if (!ln) continue;
      let m; try { m = JSON.parse(ln); } catch (e) { continue; }   // 坏行跳过, 不让一行毁掉整段
      if (m && typeof m.text === 'string' && Number(m.ts) < before) day.push(m);
    }
    all.unshift(...day);
  }

  const hay = all.map((m) => String(m.text).toLowerCase());
  const pick = (mode) => {
    const idx = [];
    for (let i = 0; i < all.length; i++) {
      const h = hay[i];
      const ok = mode === 'all' ? terms.every((t) => h.includes(t)) : terms.some((t) => h.includes(t));
      if (ok) idx.push(i);
    }
    return idx;
  };
  let matched = 'all';
  let idx = pick('all');
  if (!idx.length && terms.length > 1) { idx = pick('any'); matched = 'any'; }

  const total = idx.length;
  const take = idx.slice(-limit);            // 最新优先: 同一件事反复聊过, 最近那次通常是最终口径
  const cut = (t) => (t.length > clip ? t.slice(0, clip) + ` …[+${t.length - clip}]` : t);
  const hits = take.map((i) => ({
    ts: all[i].ts || 0,
    role: all[i].role,
    text: cut(String(all[i].text)),
    prev: all[i - 1] ? { role: all[i - 1].role, text: cut(String(all[i - 1].text)) } : null,
    next: all[i + 1] ? { role: all[i + 1].role, text: cut(String(all[i + 1].text)) } : null,
  }));
  return { total, returned: hits.length, truncated: total > hits.length, scanTruncated, matched, hits };
}

module.exports = { load, save, appendHistory, readHistoryBefore, searchHistory, MAX_MSGS };
