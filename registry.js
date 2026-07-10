// registry.js — 人格登记簿(personas.json): 显式管理所有人格, 不再靠"目录=人格"隐式约定。
// 每条: { id(稳定, 不随目录改名变), name(显示名), homeDir, wakePhrase, isButler(星型中心, 全局唯一),
//        plugins:{tg,bothub}, createdAt }。id 稳定 → 根治"靠 process id / 目录 猜是谁"。
// 迁移: 旧的 wake.txt / tg.json / mcp.json 首次自动并进登记簿(persona.js 读)。
const fs = require('fs');
const path = require('path');
const persona = require('./persona');
const paths = require('./paths');

// 登记簿文件位置: 开发=仓库根/personas.json; 打包=用户数据目录/personas.json。
// 每次解析(不缓存成常量): 首启选目录后 dataDir 会变, 常量会指向旧位置。
function regFile() { return paths.registryFile(); }

function loadRegistry() {
  try {
    const j = JSON.parse(fs.readFileSync(regFile(), 'utf8'));
    if (j && Array.isArray(j.personas)) return j;
  } catch (_) {}
  return { personas: [] };
}
// saveRegistry 三重保护 (2026-07-07 血泪: 一次静默失败让狂人 name+plugins 全丢, 用户重配一遍才恢复):
// 1) 原子写: 先写 .tmp 再 rename → 崩溃中断也不会留下半个损坏文件
// 2) 备份: 每次写前先把现文件 cp 到 .bak → 意外坏了能恢复
// 3) 防呆: reg 结构必须合法 (personas 数组) 且非"清空"操作 (新条数至少不能少于现有 - 1) → 顶掉误传空 reg
function saveRegistry(reg) {
  if (!reg || !Array.isArray(reg.personas)) {
    console.error('[registry] saveRegistry 拒绝: 非法 reg 结构'); return false;
  }
  const REG_FILE = regFile();
  // 打包首启等场景: 数据目录可能还没建 → 先确保父目录在, 否则写盘必失败
  try { fs.mkdirSync(path.dirname(REG_FILE), { recursive: true }); } catch (_) {}
  // 防呆: 现在有 N 条, 新的一次性少了 ≥2 条 → 可疑, 拒
  try {
    if (fs.existsSync(REG_FILE)) {
      const cur = JSON.parse(fs.readFileSync(REG_FILE, 'utf8'));
      if (Array.isArray(cur.personas) && cur.personas.length - reg.personas.length >= 2) {
        console.error(`[registry] saveRegistry 拒绝: 疑似清空 (现${cur.personas.length}→新${reg.personas.length})`);
        return false;
      }
    }
  } catch (_) {}
  const tmp = REG_FILE + '.tmp';
  const bak = REG_FILE + '.bak';
  try {
    if (fs.existsSync(REG_FILE)) { try { fs.copyFileSync(REG_FILE, bak); } catch (_) {} }
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf8');
    fs.renameSync(tmp, REG_FILE);
    return true;
  } catch (e) {
    console.error('[registry] saveRegistry 写盘失败:', REG_FILE, e && e.message);
    try { if (fs.existsSync(bak) && !fs.existsSync(REG_FILE)) fs.copyFileSync(bak, REG_FILE); } catch (_) {}
    try { fs.unlinkSync(tmp); } catch (_) {}
    return false;
  }
}

const resolve = (d) => path.resolve(String(d || '').replace(/\/+$/, ''));
const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^\w一-龥-]+/g, '-').replace(/^-+|-+$/g, '') || 'persona';

function list() { return loadRegistry().personas; }
function get(id) { return loadRegistry().personas.find((p) => p.id === id) || null; }
function getByDir(homeDir) { const r = resolve(homeDir); return loadRegistry().personas.find((p) => resolve(p.homeDir) === r) || null; }

// 生成不与现有 id 冲突的稳定 id(同目录复用旧 id; 不同目录同名则加后缀)
function uniqueId(base, homeDir, personas) {
  const r = resolve(homeDir);
  const existSameDir = personas.find((p) => resolve(p.homeDir) === r);
  if (existSameDir) return existSameDir.id;
  let id = slug(base), n = 1;
  while (personas.some((p) => p.id === id)) { n += 1; id = `${slug(base)}-${n}`; }
  return id;
}

// 插入或更新一条(按 id 或同目录匹配)。返回落库后的条目。
function upsert(entry) {
  const reg = loadRegistry();
  const r = resolve(entry.homeDir);
  let cur = reg.personas.find((p) => p.id === entry.id) || reg.personas.find((p) => resolve(p.homeDir) === r);
  if (cur) { Object.assign(cur, entry, { homeDir: entry.homeDir || cur.homeDir }); }
  else { cur = { createdAt: 0, isButler: false, plugins: {}, ...entry }; reg.personas.push(cur); }
  if (entry.isButler) reg.personas.forEach((p) => { p.isButler = (p === cur); }); // 管家全局唯一
  saveRegistry(reg);
  return cur;
}

function remove(id) {
  const reg = loadRegistry();
  const i = reg.personas.findIndex((p) => p.id === id);
  if (i < 0) return false;
  reg.personas.splice(i, 1); saveRegistry(reg); return true;
}

// 指定某人格为管家(星型中心), 其余清除
function setButler(id) {
  const reg = loadRegistry();
  let found = false;
  reg.personas.forEach((p) => { p.isButler = (p.id === id); if (p.id === id) found = true; });
  if (found) saveRegistry(reg);
  return found;
}

// —— 叶子↔叶子直连授权白名单(星型例外, 需用户授权; 持续到撤销) ——
// 存 registry 顶层 peerLinks: [[idA,idB], ...](id 升序存, 无向对)。
function _pairKey(a, b) { return [a, b].sort(); }
function grantPeer(refA, refB) {
  const A = resolveRef(refA), B = resolveRef(refB);
  if (!A || !B) return { ok: false, error: '人格未找到: ' + (!A ? refA : refB) };
  if (A.id === B.id) return { ok: false, error: '不能给同一个人格授权直连' };
  const reg = loadRegistry();
  if (!Array.isArray(reg.peerLinks)) reg.peerLinks = [];
  const [x, y] = _pairKey(A.id, B.id);
  if (!reg.peerLinks.some((p) => p[0] === x && p[1] === y)) reg.peerLinks.push([x, y]);
  saveRegistry(reg);
  return { ok: true, a: A.name, b: B.name };
}
function revokePeer(refA, refB) {
  const A = resolveRef(refA), B = resolveRef(refB);
  if (!A || !B) return { ok: false, error: '人格未找到: ' + (!A ? refA : refB) };
  const reg = loadRegistry();
  if (!Array.isArray(reg.peerLinks)) reg.peerLinks = [];
  const [x, y] = _pairKey(A.id, B.id);
  reg.peerLinks = reg.peerLinks.filter((p) => !(p[0] === x && p[1] === y));
  saveRegistry(reg);
  return { ok: true, a: A.name, b: B.name };
}
function arePeersLinked(idA, idB) {
  const reg = loadRegistry();
  if (!Array.isArray(reg.peerLinks)) return false;
  const [x, y] = _pairKey(idA, idB);
  return reg.peerLinks.some((p) => p[0] === x && p[1] === y);
}

// 确保某目录在登记簿里(不在则从现有约定文件迁移建条)。返回条目。
function ensureEntry(homeDir, opts = {}) {
  const exist = getByDir(homeDir);
  if (exist) return exist;
  const reg = loadRegistry();
  const memoryDir = persona.resolveMemoryDir(homeDir);
  const name = opts.name || persona.personaName(homeDir);
  const id = uniqueId(name, homeDir, reg.personas);
  const wakePhrase = persona.loadWakePhrase(homeDir, memoryDir, name);
  const mcpServers = persona.loadMcpServers(homeDir, memoryDir);
  // 旧 tg.json → plugins.tg (v2: mode 语义); 首次迁移 mode='off' 保安全,
  // 让用户在管理 UI 里补 bot_token 后手动改成 'native' 才开抓 (避免无 token 状态下瞎跑)。
  let tgPlugin = { mode: 'off' };
  try {
    const fs = require('fs');
    for (const p of [require('path').join(memoryDir, 'tg.json'), require('path').join(homeDir, 'tg.json')]) {
      if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        tgPlugin = { mode: 'off', in_file: j.in_file, chat_ids: j.chat_ids };   // v2: 不再迁 tools_dir (已废)
        break;
      }
    }
  } catch (_) {}
  const entry = {
    id, name, homeDir: resolve(homeDir), wakePhrase,
    isButler: !!opts.isButler,
    plugins: { mcp: mcpServers, tg: tgPlugin, bothub: { mode: 'off', endpoints: [] } },
    createdAt: opts.createdAt || 0,
  };
  return upsert(entry);
}

// 若还没有任何管家, 就把 preferDir(通常=第一个打开的人格) 设为管家, 保证 open/create 工具可用。
function ensureButler(preferDir) {
  const reg = loadRegistry();
  if (reg.personas.some((p) => p.isButler)) return get(reg.personas.find((p) => p.isButler).id);
  const target = (preferDir && getByDir(preferDir)) || reg.personas[0];
  if (!target) return null;
  setButler(target.id);
  return get(target.id);
}

// 解析人格引用(id / 显示名 / 目录) → 条目
function resolveRef(ref) {
  if (!ref) return null;
  const reg = loadRegistry();
  return reg.personas.find((p) => p.id === ref)
      || reg.personas.find((p) => p.name === ref)
      || reg.personas.find((p) => resolve(p.homeDir) === resolve(ref))
      || null;
}

module.exports = {
  regFile, loadRegistry, saveRegistry, list, get, getByDir,
  upsert, remove, setButler, ensureEntry, ensureButler, resolveRef, slug,
  grantPeer, revokePeer, arePeersLinked,
};
