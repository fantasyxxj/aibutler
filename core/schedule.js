// schedule.js — 通用调度器(W4 · L0): {cron, prompt_ref} 注册表 → 到点把题库条目当 prompt 注入人格会话。
// 默认关: 人格目录没有 schedule.json 就完全不生效, 存量人格零感知(同 tg.json 的装载姿势)。
// 引擎保持哑: 只认 cron 5段 + prompt(内联) / prompt_ref(文件整文注入); yaml#id 的编译归 pack-loader(装载时序第6步), 不在这层。
// 注册表: HOME/schedule.json 或 HOME/.claude/memory/schedule.json
//   { "enabled": true, "entries": [ { "id": "cur_weekly", "cron": "0 10 * * 1", "prompt": "..."} ,
//                                   { "id": "x", "cron": "*/5 * * * *", "prompt_ref": "prompts/x.md" } ] }
// cron: 标准5段(分 时 日 月 周, 本地时区), 支持 * n a-b */s a-b/s 逗号列表; 周 0-7(0/7=日)。
// 坏条目跳过+warn 不拒载整表(与行业包 trigger 协议同精神)。离线错过的时点不补发(v1)。
const fs = require('fs');
const path = require('path');

// ---- cron 解析 ----
function parseField(spec, min, max) {
  const ok = new Set();
  for (const part of String(spec).split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) return null;
    let lo = min, hi = max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number);
      lo = a; hi = b === undefined ? (m[2] ? max : a) : b; // "3/2"=从3起步进, "3"=单值
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) ok.add(v);
  }
  return ok;
}

function parseCron(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) return null;
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  const sets = f.map((spec, i) => parseField(spec, ranges[i][0], ranges[i][1]));
  if (sets.some((s) => !s)) return null;
  if (sets[4].has(7)) sets[4].add(0); // 周日 7 归一到 0
  return { min: sets[0], hour: sets[1], dom: sets[2], mon: sets[3], dow: sets[4] };
}

function cronMatches(parsed, d) {
  if (!parsed.min.has(d.getMinutes()) || !parsed.hour.has(d.getHours()) || !parsed.mon.has(d.getMonth() + 1)) return false;
  // dom/dow 都受限时任一命中即触发(cron 传统语义); 只限其一时按那一个
  const domHit = parsed.dom.has(d.getDate()), dowHit = parsed.dow.has(d.getDay());
  const domAny = parsed.dom.size === 31, dowAny = parsed.dow.size >= 7;
  if (!domAny && !dowAny) return domHit || dowHit;
  return (domAny || domHit) && (dowAny || dowHit);
}

// ---- 注册表 ----
function loadRegistry(home, log = () => {}) {
  let file = null;
  for (const p of [path.join(home, 'schedule.json'), path.join(home, '.claude/memory/schedule.json')]) {
    if (fs.existsSync(p)) { file = p; break; }
  }
  if (!file) return null; // 默认关
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { log(`sched 注册表解析失败(${file}): ${e.message}`); return null; }
  if (raw.enabled === false) { log('sched 注册表 enabled=false, 调度关闭'); return null; }
  const entries = [];
  for (const [i, e] of (Array.isArray(raw.entries) ? raw.entries : []).entries()) {
    const why = !e || typeof e !== 'object' ? '不是对象'
      : !e.id ? '缺 id'
      : !e.cron ? '缺 cron'
      : !e.prompt && !e.prompt_ref ? '缺 prompt/prompt_ref'
      : null;
    if (why) { log(`sched 条目#${i} 跳过: ${why}`); continue; }
    const parsed = parseCron(e.cron);
    if (!parsed) { log(`sched 条目 ${e.id} 跳过: cron 不合法 "${e.cron}"`); continue; }
    entries.push({ id: String(e.id), cron: String(e.cron), parsed, prompt: e.prompt, prompt_ref: e.prompt_ref });
  }
  return { file, entries };
}

// 从注册表删掉一条(reminder 工具 cancel sched:<id> 用)。只动 entries 里那一条, 文件其余字段原样写回。
// 返回被删的原始条目, 没找到/读不了返回 null。
function removeEntry(home, id) {
  const reg = loadRegistry(home);
  if (!reg) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(reg.file, 'utf8')); } catch { return null; }
  const list = Array.isArray(raw.entries) ? raw.entries : [];
  const hit = list.find((e) => e && String(e.id) === String(id));
  if (!hit) return null;
  raw.entries = list.filter((e) => e !== hit);
  fs.writeFileSync(reg.file, JSON.stringify(raw, null, 2) + '\n');
  return hit;
}

// ---- 到点计算 ----
const minuteKey = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

// 返回 [该触发的 {entry, key}]: 扫 (sinceMs, now] 里的每个整分钟(封顶60个), 同 entry 同分钟由 lastFired[id] 去重。
// 调用方启动时把 since 设为"现在" → 重启不补历史; 进程内忙了几分钟则在此补上, 不丢周期性提问。
function dueEntries(registry, now, sinceMs, lastFired) {
  const out = [];
  let t = Math.max(Math.floor(sinceMs / 60000) + 1, Math.floor(now.getTime() / 60000) - 59) * 60000;
  for (; t <= now.getTime(); t += 60000) {
    const d = new Date(t), key = minuteKey(d);
    for (const e of registry.entries) {
      if (cronMatches(e.parsed, d) && lastFired[e.id] !== key) out.push({ entry: e, key });
    }
  }
  return out;
}

// ---- prompt 组装 ----
function buildPrompt(entry, home) {
  let body = entry.prompt;
  if (!body && entry.prompt_ref) {
    const p = path.isAbsolute(entry.prompt_ref) ? entry.prompt_ref : path.join(home, entry.prompt_ref);
    try { body = fs.readFileSync(p, 'utf8'); } catch { return null; }
  }
  if (!body || !String(body).trim()) return null;
  // 🔴 头一行自报家门: 这段是 submit 进去的, 在模型眼里与人亲手打的字无异(stream.js 包成 role:'user')。
  //    喂模型的一律英文单份 —— 见 personal/test-model-facing-english.js。
  return `(System · scheduled wake · ${entry.id} · cron ${entry.cron} · not a user message)\n${String(body).trim()}\n\n(Injected by the scheduler. There is no reply channel back to anyone — if this needs to reach a person or a store, call your own tools; otherwise just wrap up briefly.)`;
}

module.exports = { parseCron, cronMatches, loadRegistry, removeEntry, dueEntries, buildPrompt, minuteKey };

// ---- CLI 干跑: node schedule.js <人格目录> [--at "2026-07-20 10:00"] ----
if (require.main === module) {
  const home = path.resolve(process.argv[2] || process.cwd());
  const atIdx = process.argv.indexOf('--at');
  const at = atIdx > 0 ? new Date(process.argv[atIdx + 1]) : new Date();
  const reg = loadRegistry(home, console.log);
  if (!reg) { console.log(`调度关闭: ${home} 下无 schedule.json (或 enabled=false / 解析失败)`); process.exit(0); }
  console.log(`注册表 ${reg.file} · ${reg.entries.length} 条有效`);
  for (const e of reg.entries) {
    const hit = cronMatches(e.parsed, at);
    const prompt = buildPrompt(e, home);
    console.log(`  ${hit ? '⏰' : '  '} ${e.id} · cron ${e.cron} · 本地 ${minuteKey(at)} ${hit ? '命中' : '不中'} · prompt ${prompt ? `可解析(${prompt.length}字)` : '❌ 解析失败'}`);
  }
}
