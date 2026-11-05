// persona.js — 一个目录 = 一个人格/记忆体。解析记忆目录、加载人设、给空目录脚手架。
const fs = require('fs');
const path = require('path');
const { cfg } = require('./host');
const lang = require('./memory-v2/lang');

// 记忆目录候选(第一个存在的赢); 都没有则默认建第一个
const MEM_CANDIDATES = ['.claude/memory', '.memory', 'memory'];

// 起床语里没名字时的兜底称呼。那句用户看得见, 所以这个词也得跟界面语言走。
const FALLBACK_YOU = { 'zh-CN': '你', 'zh-TW': '你', ja: 'あなた', en: 'you' };

// 解析人格的记忆目录: 显式覆盖 > 候选里第一个存在的 > 默认 .claude/memory
function resolveMemoryDir(homeDir, override) {
  if (override) return path.isAbsolute(override) ? override : path.join(homeDir, override);
  for (const c of MEM_CANDIDATES) {
    const p = path.join(homeDir, c);
    try { if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p; } catch (_) {}
  }
  return path.join(homeDir, MEM_CANDIDATES[0]); // 默认(可能尚未创建)
}

// 确保记忆目录存在 + 有 MEMORY.md 索引(空目录=新人格时脚手架)
function ensureMemory(memoryDir, name) {
  fs.mkdirSync(memoryDir, { recursive: true });
  const idx = path.join(memoryDir, 'MEMORY.md');
  if (!fs.existsSync(idx)) {
    fs.writeFileSync(idx,
      `# 🧠 ${name || 'new persona'} · handoff note (MEMORY.md)\n\n` +
      `> Write only "not done yet / waiting on whom / stuck where"; hard-read at the start of every session.\n` +
      `> **Memory itself lives in the database, not in this file** — for details write a [[node-id]] pointer and\n` +
      `> pull it with memory_query; do not copy bodies in here.\n` +
      `> Behaviour rules and the memory playbook are in your own memory store (loaded at the factory) —\n` +
      `> query them with memory_query, do not repeat them here.\n\n` +
      `## Identity / persona\n(to fill in: who I am · what I'm responsible for · tone · boundaries)\n\n` +
      `## 🔥 Current task\n(empty for now)\n`, 'utf8');
  }
  ensureHooksFile(memoryDir);
  return idx;
}

// 这个人格自己的动作钩子。开箱是**空的** —— 例子放在 `_examples` 里而不是直接生效:
// 哪个动作该被提醒是人格自己的事, 替它预设等于又一次"给所有人定钩子"。
function ensureHooksFile(memoryDir) {
  const p = path.join(memoryDir, 'hooks.json');
  if (fs.existsSync(p)) return p;
  const seed = {
    _note: 'My own action hooks. Each entry = {key, trigger, query}: when a tool call matches `trigger`, `query` is run against my own memory and the hits are handed to me before the call goes through. Move an entry out of _examples into hooks to switch it on. Trigger format is `ToolName[,ToolName…]:regex` — miss the colon and the entry dies silently.',
    hooks: [],
    _examples: [
      { key: 'db_connect', trigger: 'Bash:\\b(psql|mysql|mongosh?|redis-cli|sqlite3|bq)\\b', query: 'database connection environment credentials' },
      { key: 'manual_deploy', trigger: 'Bash:\\b(rsync|scp)\\b|\\bssh\\b.*\\b(systemctl|pm2|docker)\\b', query: 'deploy script one-click server' },
    ],
  };
  try { fs.writeFileSync(p, JSON.stringify(seed, null, 2) + '\n', 'utf8'); } catch (_) {}
  return p;
}

// 人设文件实际落在哪一份(记忆目录优先, 人格目录兜底); 都没有则 null。
// 单独拆出来是为了热读 —— 拿得到路径才拿得到 mtime。
function personaFile(homeDir, memoryDir) {
  for (const p of [path.join(memoryDir, 'persona.md'), path.join(homeDir, 'persona.md')]) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

// 加载人设文本(纯人设/系统提示): persona.md 优先, 没有则 null(调用方用默认身份)
function loadPersona(homeDir, memoryDir) {
  const p = personaFile(homeDir, memoryDir);
  if (!p) return null;
  try { return fs.readFileSync(p, 'utf8').trim(); } catch (_) { return null; }
}

// 人格名: 目录basename(简单可靠; 以后可从 persona.md frontmatter 取)
function personaName(homeDir) { return path.basename(homeDir.replace(/\/+$/, '')) || homeDir; }

// 时间一律本地时区(作者钦定, 禁 UTC): persona.md 的 created 原来带 Z, 是 UTC 时刻。
function localStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// 出生礼物: 建 persona.md 骨架。已存在不覆盖。
// 这是 agent.js appendSystemPrompt 的 identity 真源, 缺则回落"全能管家"默认(小游自称管家的根因)。
// 9.4: 骨架正文外置到 config —— 它原来硬编码在这儿, 里面点名的工具名逃过了
// test-tool-catalog 那道"config 里点名的工具必须真实存在"的闸门, 工具一改名新生儿就学到一个不存在的工具。
// packPersona: 行业包带来的人格说明("这个行业的助手是谁")。给了就用它当骨架 ——
// 通用骨架长的是"全能管家", 那不是一家店该开门见到的人。**只在这一刻写这一次**:
// 之后助手自己怎么改都是它的事, 包升级不再碰这个文件(升级范围里只有记忆)。
function ensurePersonaFile(homeDir, memoryDir, name, wakePhrase, packPersona) {
  const p = path.join(memoryDir, 'persona.md');
  if (fs.existsSync(p)) return p;
  const vars = { name, now: localStamp(), memoryDir, wakePhrase: wakePhrase || '(默认)' };
  const text = packPersona
    ? String(packPersona).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m))
    : cfg.render('main/persona_skeleton', vars);
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

// 2026-08-13 作者定案: 不再把人格记忆软链进 CC 项目条目 (~/.claude/projects/<slug>/memory)。
// 老做法(P6c ensureCcSymlink)让 CC 的 auto-memory 顺着软链把 MEMORY.md 又自动装一遍 → 同一份索引进两次上下文,
// 且 CC 那份有 24.4KB 截断上限(实测 3 个人格已在丢尾巴)。更要命的是它只在出生时建一次、失败只进日志,
// 老人格(唐伯虎)压根没有 → 整整一类静默失败。现在 butler 独占加载 MEMORY.md, CC 会话里就没有人格记忆。
// 唤醒语默认句: 注册表(personas.json.wakePhrase)是唯一真源, 空/缺省时用此默认。
// (2026-07-27 干掉了 wake.txt 磁盘冗余 · 老 wake.txt 文件保留在各人格目录不再被读)
// 🔴 这句用户在聊天窗里看得见, 所以跟界面语言走(四语在 config/main/wake_phrase.json)。
// 唤醒正文里其余那些只有模型读得到的段落一律英文单份, 两者别混。
function defaultWakePhrase(name) {
  const tpl = lang.localize(cfg.json('main/wake_phrase'));
  return cfg.fill(tpl, { name: name || lang.localize(FALLBACK_YOU) });
}

// 该人格要启用的外部 MCP server 名单(mcp.json: {"servers":["dc-platform"]}); 缺省 []。
// 名字对应 ~/.claude.json 的 mcpServers.<name>。让"数据专家"人格接上 dc-platform 工具,
// 中央管家等普通人格不接(上下文干净、不被 200k 工具 schema 灌满)。
function loadMcpServers(homeDir, memoryDir) {
  for (const p of [path.join(memoryDir, 'mcp.json'), path.join(homeDir, 'mcp.json')]) {
    try {
      if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(j.servers)) return j.servers.filter((s) => typeof s === 'string');
      }
    } catch (_) {}
  }
  return [];
}

module.exports = { MEM_CANDIDATES, resolveMemoryDir, ensureMemory, ensureHooksFile, loadPersona, personaFile, personaName, loadMcpServers, defaultWakePhrase, ensurePersonaFile };
