// persona.js — 一个目录 = 一个人格/记忆体。解析记忆目录、加载人设、给空目录脚手架。
const fs = require('fs');
const path = require('path');
const os = require('os');

// 记忆目录候选(第一个存在的赢); 都没有则默认建第一个
const MEM_CANDIDATES = ['.claude/memory', '.memory', 'memory'];

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
      `# 🧠 ${name || '新人格'} · 记忆索引 (MEMORY.md)\n\n` +
      `> 每会话开头加载。一条记忆一个 .md(带 frontmatter), 写完在此加一行指针。\n\n` +
      `## 身份 / 人设\n(待填: 我是谁 · 职责 · 口吻 · 边界)\n\n` +
      `## 记忆条目\n(暂空 —— 随使用逐步积累)\n`, 'utf8');
  }
  return idx;
}

// 加载人设文本(纯人设/系统提示): persona.md 优先, 没有则 null(调用方用默认身份)
function loadPersona(homeDir, memoryDir) {
  for (const p of [path.join(memoryDir, 'persona.md'), path.join(homeDir, 'persona.md')]) {
    try { if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim(); } catch (_) {}
  }
  return null;
}

// 人格名: 目录basename(简单可靠; 以后可从 persona.md frontmatter 取)
function personaName(homeDir) { return path.basename(homeDir.replace(/\/+$/, '')) || homeDir; }

// 出生礼物: 建 persona.md 骨架(身份/口吻/边界留空, LLM/用户填)。已存在不覆盖。
// 这是 agent.js appendSystemPrompt 的 identity 真源, 缺则回落"全能管家"默认(小游自称管家的根因)。
function ensurePersonaFile(homeDir, memoryDir, name, wakePhrase) {
  const p = path.join(memoryDir, 'persona.md');
  if (fs.existsSync(p)) return p;
  const now = new Date().toISOString();
  fs.writeFileSync(p, `---
name: ${name}
type: persona
created: ${now}
---

# 我是 ${name}

**我叫 ${name}。这是我自己独立的 butler 人格会话,有我自己的记忆图、自己的成长路径。**
**当有人问"你是谁", 我答"我是 ${name}", 不答"我是 Claude/AI 助手/通用管家"。**

## 我的领域
(还没明确 — 我在自己的经历里慢慢定型。也可以让创建者/管家告诉我。)

## 我的口吻
自然、直接、简洁。会用记忆图记住我经历的事、遇到的人、踩过的坑。

## 我的边界
不做我记忆里明确"不做"的事; 拿不准就先问, 不擅自扩大范围。

## 我的记忆系统
- 图记忆目录: \`${memoryDir}\`
- 索引: MEMORY.md
- 出生第一件档案: self_identity (pinned, memory_hot 排第一)
- 用: memory_hot 看最近在忙啥 / memory_query 查旧知识 / memory_upsert 沉淀新知识 / memory_touch 强化用过的

## 出生
- 建于: ${now}
- 唤醒语: ${wakePhrase || '(默认)'}

---
> 这份 persona.md 是**我自己的身份档案**, butler 每次加载会话都会把它作为 identity 注入系统提示。
> 我可以随时改自己 — 想成为怎样的 ${name}, 我自己写。
`, 'utf8');
  return p;
}

// 出生礼物: 落 wake.txt 到磁盘(如果 spec 传了唤醒语)。已存在不覆盖。
function ensureWakeFile(homeDir, memoryDir, wakePhrase) {
  if (!wakePhrase) return null;
  const p = path.join(memoryDir, 'wake.txt');
  if (fs.existsSync(p)) return p;
  fs.writeFileSync(p, wakePhrase, 'utf8');
  return p;
}

// CC 集成: 把人格的 .claude/memory 软链到 ~/.claude/projects/<slug>/memory 让 CC 会话共享同一份图记忆。
// slug 规则跟 CC 一致: 绝对路径把 / 换成 -, 前置一个 -。跨 OS: mac/linux 用 symlink, Windows 用 junction。
// 已存在真目录(用户手动建过 CC 项目)不动 → 只在无冲突时创建。
function ensureCcSymlink(homeDir, memoryDir) {
  try {
    const slug = '-' + path.resolve(homeDir).replace(/^\//, '').replace(/\//g, '-');
    const ccProjectDir = path.join(os.homedir(), '.claude', 'projects', slug);
    fs.mkdirSync(ccProjectDir, { recursive: true });
    const link = path.join(ccProjectDir, 'memory');
    if (fs.existsSync(link)) {
      const st = fs.lstatSync(link);
      if (st.isSymbolicLink()) return { ok: true, note: 'existing symlink' };
      return { ok: false, error: 'CC 项目 memory 已是真目录, 不覆盖: ' + link };
    }
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(path.resolve(memoryDir), link, type);
    return { ok: true, link, target: memoryDir };
  } catch (e) { return { ok: false, error: String(e && e.message) }; }
}

// 唤醒语(加载规则): 压缩自愈/叫醒时接在"(系统自动·压缩后自愈)…"之后发给该人格的那句。
// wake.txt 有则用(如数据专家=加载数据专家续线程); 缺省=喊名字+载记忆续线程(通用人格)。
// 未来注册表(personas.json)落地后, 该字段由注册表提供、此文件读取作为回退。
function loadWakePhrase(homeDir, memoryDir, name) {
  for (const p of [path.join(memoryDir, 'wake.txt'), path.join(homeDir, 'wake.txt')]) {
    try { if (fs.existsSync(p)) { const t = fs.readFileSync(p, 'utf8').trim(); if (t) return t; } } catch (_) {}
  }
  return `起床啦, ${name || '你'}。请载入你的记忆(读 MEMORY.md / 用图记忆检索)续上压缩前的线程, 该干嘛干嘛。`;
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

module.exports = { MEM_CANDIDATES, resolveMemoryDir, ensureMemory, loadPersona, personaName, loadMcpServers, loadWakePhrase, ensurePersonaFile, ensureWakeFile, ensureCcSymlink };
