// registry.js — 人格登记簿(personas.json): 显式管理所有人格, 不再靠"目录=人格"隐式约定。
// 每条: { id(稳定, 不随目录改名变), name(显示名), homeDir, wakePhrase, isButler(星型中心, 全局唯一),
//        plugins:{tg,bothub}, createdAt }。id 稳定 → 根治"靠 process id / 目录 猜是谁"。
// 迁移: 旧的 tg.json / mcp.json 首次自动并进登记簿(persona.js 读); wake.txt 已废(2026-07-27)。
const fs = require('fs');
const path = require('path');
const persona = require('./persona');
const { paths } = require('./host');
// 🔴 时间戳一律本地时区, 禁 UTC(作者 2026-08-15 钦定)。toISOString() 会把晚上写成"昨天",
// 而 chip 的 first_seen 直接决定"摆了几天没人碰", 差一天就会提前提醒用户清理。
const { nowLocalISO } = require('./memory');

// 技能分档。放这儿是因为两条建人格的路都要用它: AI 的 persona_admin(op='create') 与
// 界面的 create-persona-ui —— 分开定义必然漂开, 而漂开的表现是"从哪建的决定了它会什么"。
// 事务型只留定时/轮询/查资料; 写代码那批默认不给(每轮跟着系统提示走, 不写代码的人格白付)。
// 关掉的只是流程模板不是本事: 没有 code-review 照样能读 diff 挑毛病。要用再 tune 开回来。
const BASE_SKILLS = ['schedule', 'loop', 'deep-research'];
const DEV_SKILLS = [...BASE_SKILLS, 'code-review', 'review', 'security-review', 'verify', 'run',
  'simplify', 'init', 'claude-api', 'update-config', 'keybindings-help', 'fewer-permission-prompts'];

// 登记簿文件位置: 开发=仓库根/personas.json; 打包=用户数据目录/personas.json。
// 每次解析(不缓存成常量): 首启选目录后 dataDir 会变, 常量会指向旧位置。
function regFile() { return paths.registryFile(); }

// 🔴 "文件不在" 与 "文件在却读不出来" 必须分开: 前者是全新安装, 空登记簿就是正确答案; 后者一旦
// 也回空, 启动链会把它当成"一个人格都没有"弹出创建初始人格屏 —— 用户看到的是数据全没了, 而
// 真相只是一个文件没解析成功。saveRegistry 每次写前都留了 .bak, 以前读这边从不看它一眼。
function loadRegistry() {
  const file = regFile();
  if (!fs.existsSync(file)) return { personas: [] };
  let err = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && Array.isArray(j.personas)) return j;
    err = new Error('personas 不是数组');
  } catch (e) { err = e; }
  try {
    const j = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
    if (j && Array.isArray(j.personas)) {
      console.error(`[registry] 登记簿读取失败(${err && err.message}), 已回退到备份: ${file}.bak`);
      return j;
    }
  } catch (_) {}
  throw new Error(`登记簿损坏且备份不可用: ${file} (${err && err.message})`);
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
  const wakePhrase = ''; // 2026-07-27 干掉 wake.txt 磁盘冗余: 首次登记不再读磁盘, 后续 UI/opts 显式赋值
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
    plugins: { mcp: mcpServers, tg: tgPlugin, buses: [] },
    createdAt: opts.createdAt || 0,
  };
  return upsert(entry);
}

// —— 迁移: 三段各写各的 bus 配置 → 一张有序的 buses 表 ——
// 老形状 plugins.line / plugins.agent_bus 是**界面根本产生不了**的: 管理面板只画 tg 和
// bothub 两块, 那两段只能手工改 personas.json, 于是实机上八个人格里只有一台被手动补过。
// 界面配不出来的配置等于不存在, 所以收敛成一张表 —— 表里每条都能在界面上加。
//
// 表是有序的, **第一个是默认**(不点名就发它)。顺序沿用老代码灌进去的顺序, 别调换:
// 已经在用的那台机器上, 不点名的调用现在打给谁, 迁完还得是谁。
//   kind  = 怎么跟这条 bus 说话 (v1 信封 / bothub 聊天)
//   inbox = 收到的件谁处理 (line=客人消息 / agent_bus=handler 分派 / bothub=分级唤醒 / 无=只发不收)
function migrateBuses(plugins) {
  if (!plugins || Array.isArray(plugins.buses)) return null;
  const out = [];
  const ab = plugins.agent_bus;
  if (ab && ab.bus_base_url && ab.store_token) {
    out.push({ id: 'agent_bus', kind: 'v1', label: '中央大脑 bus', base_url: ab.bus_base_url,
               token: ab.store_token, agent: ab.agent, wait: ab.wait, inbox: 'agent_bus' });
  }
  const ln = plugins.line;
  if (ln && ln.bus_base_url && ln.store_token) {
    out.push({ id: 'line', kind: 'v1', label: '店铺 bus(LINE 收发 · 行业包工具)',
               base_url: ln.bus_base_url, token: ln.store_token, wait: ln.wait, inbox: 'line' });
  }
  const bh = plugins.bothub || {};
  ((bh.endpoints) || []).forEach((ep, i) => {
    if (!ep || !ep.url || !ep.agent) return;
    out.push({ id: ep.id || (i ? `bothub${i + 1}` : 'bothub'), kind: 'bothub',
               label: ep.label || `bothub · ${ep.agent}`, base_url: ep.url, token: ep.token,
               agent: ep.agent, poll_interval: ep.poll_interval,
               // mode=off 是"配着但先别收" —— 配置留着, 取件不起。
               inbox: bh.mode === 'native' ? 'bothub' : false });
  });
  return out;
}

// 盘上那份老配置折成新表并写回。跑过一次就干净了 —— 老字段一并删掉, 免得两份并存时
// 有人改了没生效的那一份。
function ensureBuses(id) {
  const reg = loadRegistry();
  const p = reg.personas.find((x) => x.id === id);
  if (!p) return null;
  if (!p.plugins) p.plugins = {};
  const migrated = migrateBuses(p.plugins);
  if (!migrated) return p.plugins.buses || [];
  p.plugins.buses = migrated;
  delete p.plugins.line;
  delete p.plugins.agent_bus;
  delete p.plugins.bothub;
  saveRegistry(reg);
  return migrated;
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

// —— 升级补课: 每个人格记住"我已经知道到哪个版本的能力了" ——
// 存人格条目而非记忆图: 这是引擎元数据(谁补过课), 不是人格自己的知识; 放图里会被它当普通记忆改掉。
// 空值 = 从没补过课(老人格首次跑到新版本), 由 buildWakePayload 决定补哪些。
function getCapabilitySeen(id) {
  const p = get(id);
  return (p && p.capabilitySeenVersion) || '';
}
function setCapabilitySeen(id, version) {
  const reg = loadRegistry();
  const p = reg.personas.find((x) => x.id === id);
  if (!p) return false;
  p.capabilitySeenVersion = String(version || '');
  return saveRegistry(reg);
}

// —— Local Poke API 配置(登记簿顶层 localApi 块, 进程级不属于任何人格) ——
// 设计稿 docs/design/local_api_v1.md §11. 默认关: 新通道不该未经明示就开着端口。
// 端口按 dev/prod 分开: 开发实例与已安装的正式版会同时在跑, 共用一个端口必然抢占失败。
const PORT_PROD = 8787;
const PORT_DEV = 8788;
function defaultPort() { return paths.isPackaged() ? PORT_PROD : PORT_DEV; }
const LOCAL_API_DEFAULTS = { enabled: false };
function getLocalApi() {
  const reg = loadRegistry();
  return { ...LOCAL_API_DEFAULTS, port: defaultPort(), ...(reg.localApi || {}) };
}
function setLocalApi(patch = {}) {
  const reg = loadRegistry();
  const next = { ...LOCAL_API_DEFAULTS, port: defaultPort(), ...(reg.localApi || {}) };
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.port !== undefined) {
    const p = Number(patch.port);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) return { ok: false, error: '端口须是 1024-65535 的整数' };
    next.port = p;
  }
  reg.localApi = next;
  if (!saveRegistry(reg)) return { ok: false, error: '写登记簿失败' };
  return { ok: true, localApi: next };
}

// —— prompt chips(输入框上方快捷按钮 · 每人格独立) ——
// 存人格条目里 chips: { used: [chipId...], custom: [...], stats: { id: {count, first_seen} } }。
//
// 🔴 2026-08-17 作者统一了个人版/行业版的口径, **取消了「点过即焚」**:
//   「安装下发设定的 chip, 个人版、行业版每个行业都会不一样, 每个有自己的模板。但是更新机制都一样,
//     不需要点一下就消失这种, 都统一按照策略保留或者调整。从来没用过的, 一段时间之后提醒用户去掉,
//     用的多的功能可以总结加上去」
//
// 所以: **模板各不同(内容), 机制只有一套(行为)**。
//   · 点一下 = 计数 +1, 按钮**留在原地**。原先的一次性脚手架语义作废。
//   · `used` 仍在, 但只装【显式退休】的 —— 用户说「清掉」或 AI 主动换掉。不再由"点过"填充。
//   · 退休判据是"从没用过 + 装了够久" → 只**提醒用户**, 绝不自动删(改用户看得见的东西必须他点头)。
// 寿命三档(2026-08-21 作者: 「不是说你的三档不对, 而是那些 chip 应该用哪档的问题」)。
// 档位是每个 chip 建的时候自己挑的属性 —— 上面 08-17 那条定的是【出厂那批挑永久档】, 不是把档位取消。
//   · permanent  默认。点过不消失, 只计数。出厂那批全是这档。
//   · once       便签: 点完就撤, 同 group 的一起撤。装"待用户拍板的问题", 拍完这问题就不存在了。
//   · until_done 程序不动它, 跟 permanent 表现一样。存这个字段只为让 AI 自己看得见"这按钮是临时的,
//                事情办完该由我撤" —— 我上下文清空重启之后, 屏幕上那颗按钮不会自己解释它是临时的。
//                没做成程序行为是因为"办完了没有"没有任何程序判据, 谁也算不出来。
const CHIP_LIFETIMES = ['permanent', 'once', 'until_done'];
const CHIP_RESIDENT_MAX = 12;
function _factoryChipIds() {
  try {
    const j = require('./host').cfg.json('chips/default');
    return (j && Array.isArray(j.chips) ? j.chips : []).map((c) => c && c.id).filter(Boolean);
  } catch (e) { console.error('[registry] 出厂 chip 池读取失败:', e && e.message); return []; }
}

function _chipState(entry) {
  const c = (entry && entry.chips) || {};
  return {
    used: Array.isArray(c.used) ? c.used : [],
    custom: Array.isArray(c.custom) ? c.custom : [],
    // stats 按 id 存 { count, first_seen }。first_seen 不是 last_used ——
    // 作者 2026-08-14 否掉的是"记最后一次用的时间"; 而"这按钮摆了多久没人碰"必须知道它何时上架,
    // 否则"一段时间之后提醒"根本无从谈起。两者不冲突。
    stats: (c.stats && typeof c.stats === 'object') ? c.stats : {},
  };
}
// 当前该显示的 chip 列表 = 出厂池(去掉已退休的) + AI 自定义池。
// 出厂池读不到不炸(chip 是锦上添花, 不该拖垮开窗)。
function resolveChips(id) {
  const entry = get(id);
  if (!entry) return [];
  const { used, custom } = _chipState(entry);
  let factory = [];
  try {
    const j = require('./host').cfg.json('chips/default');
    // 🔴 出厂 chip 的 label/prompt/desc 可以写成 {ja,en,zh-CN,zh-TW}, 这里按显示语言挑一份。
    // 它是【出厂就带、用户直接看得见】的字符串, 跟界面文案同档 —— 写死中文的后果是界面切成
    // 日文而输入框上方还挂着五个中文按钮。人格自己写的 chip 不在此列(那是它写给自己的),
    // localize 收到字符串原样返回, 所以自定义那批一个字都不变。
    const { localize } = require('./memory-v2/lang');
    factory = (j && Array.isArray(j.chips) ? j.chips : [])
      .filter((c) => !used.includes(c.id))
      .map((c) => ({ ...c, label: localize(c.label), prompt: localize(c.prompt),
        ...(c.desc ? { desc: localize(c.desc) } : {}) }));
  } catch (e) { console.error('[registry] 出厂 chip 池读取失败(跳过):', e && e.message); }
  return [...factory, ...custom];
}

// 点一下: 计数 +1。按钮留不留在原地看它自己挑的寿命档(见 _chipState 上方那段)。
// 出厂的和 AI 自定义的只有"内容从哪来"的区别 —— 出厂那批一律永久档, 所以表现仍是点过不消失。
function bumpChip(id, chipId) {
  const reg = loadRegistry();
  const entry = reg.personas.find((p) => p.id === id);
  if (!entry || !chipId) return 0;
  const st = _chipState(entry);
  const s = st.stats[chipId] || { count: 0, first_seen: nowLocalISO() };
  s.count = (s.count || 0) + 1;
  // once 档: 点完就撤。同 group 的一起撤 —— 一组就是一个问题的几个互斥答案,
  // 拍了板剩下那些选项就不存在了, 留在屏幕上只会被误点成"又问了一遍"。
  const hit = st.custom.find((c) => c && c.id === chipId);
  const custom = (hit && hit.lifetime === 'once')
    ? st.custom.filter((c) => c.id !== chipId && !(hit.group && c.group === hit.group))
    : st.custom;
  entry.chips = { used: st.used, custom, stats: { ...st.stats, [chipId]: s } };
  return saveRegistry(reg) ? s.count : 0;
}

// 上架时间戳补登记。放在"取列表"这一步而不是"装上"那一步: 出厂池是配置文件, 改文件就会多出新按钮,
// 没有一个"安装事件"可以挂钩; 而列表每次开窗都取, 第一次见到就是它对用户可见的起点。
function touchChipSeen(id) {
  const reg = loadRegistry();
  const entry = reg.personas.find((p) => p.id === id);
  if (!entry) return false;
  const st = _chipState(entry);
  const stats = { ...st.stats };
  let changed = false;
  for (const c of resolveChips(id)) {
    if (!c || !c.id) continue;
    if (!stats[c.id]) { stats[c.id] = { count: 0, first_seen: nowLocalISO() }; changed = true; }
  }
  if (!changed) return true;
  entry.chips = { used: st.used, custom: st.custom, stats };
  return saveRegistry(reg);
}

// 使用情况 + 清理建议。给 AI 看的, 由它挑时机跟用户提 —— **不自动删**。
// 判据是作者 2026-08-17 定的两条: 从没用过的(count=0)摆够久了就提醒去掉; 用得多的可以总结出新按钮。
// 🔴 行里带**完整定义**(prompt/icon/lifetime/group), 不只是 id+label: 改一颗按钮要先读得到其余那些
// 原样是什么, 否则只能凭印象重编 —— 那正是"加一个按钮却把别的改坏"的成因。
function chipUsage(id, { staleDays = 14 } = {}) {
  const entry = get(id);
  if (!entry) return { rows: [], stale: [] };
  const { stats, custom } = _chipState(entry);
  const customIds = new Set(custom.map((c) => c && c.id));
  const now = Date.now();
  const rows = resolveChips(id).map((c) => {
    const s = stats[c.id] || {};
    const days = s.first_seen ? Math.floor((now - Date.parse(s.first_seen)) / 86400000) : 0;
    return { id: c.id, label: c.label, count: s.count || 0, days: Number.isFinite(days) ? days : 0,
             icon: c.icon || '💡', prompt: c.prompt || '', lifetime: c.lifetime || 'permanent',
             ...(c.group ? { group: c.group } : {}),
             source: customIds.has(c.id) ? 'custom' : 'factory' };
  });
  return { rows, stale: rows.filter((r) => r.count === 0 && r.days >= staleDays) };
}
// AI 侧整体替换自定义池。默认不动出厂池的 used 记录。
// opts.retireFactory=true → 出厂池也一起退休(全标已用)。用户说「把这些按钮清掉」时他指的是
// 屏幕上所有按钮, 不分池子 —— 只清 custom 会让他看着原样、以为 AI 没照做(2026-08-09 唐伯虎真踩过)。
// opts.mode='merge' → 按 id 增量: 传进来的覆盖同 id 的, 没提到的原样留着, 新 id 追加在后面。
// opts.remove=[id…] → 摘掉这几颗; 出厂的 id 记进 used(单颗退休), 自定义的从池里删。两者可同用。
// opts.keep=[id…] → 用户看过、说留着: 上架时间重记为现在, 再满 14 天没人点才会再被体检提出来。
// 🔴 常驻(非 once)最多 CHIP_RESIDENT_MAX 颗, 超了整次不写 —— 便签点完就撤, 不占名额。
// 🔴 增量模式下"传空 = 全清"那条【不成立】: merge 传空数组的意思是"这次没有要改的",
//    不是"把屏幕清空"。清空仍走 replace + 空数组这条唯一入口。
function setCustomChips(id, chips, opts = {}) {
  const reg = loadRegistry();
  const entry = reg.personas.find((p) => p.id === id);
  if (!entry) return { ok: false, error: '人格未找到: ' + id };
  const merging = (opts && opts.mode) === 'merge';
  const removeIds = Array.isArray(opts && opts.remove) ? opts.remove.map(String) : [];
  const clean = (Array.isArray(chips) ? chips : []).map((c, i) => {
    const lt = String((c && c.lifetime) || '');
    const g = String((c && c.group) || '').slice(0, 40);
    return {
      id: String((c && c.id) || `custom${i + 1}`).slice(0, 40),
      icon: String((c && c.icon) || '💡').slice(0, 4),
      label: String((c && c.label) || '').slice(0, 20),
      prompt: String((c && c.prompt) || ''),
      // 认不出的档位一律退回 permanent: 寿命只有 once 一档会让屏幕上的东西自己消失,
      // 拼错个字就把按钮悄悄点没了, 比"该撤的没撤"难查得多。
      lifetime: CHIP_LIFETIMES.includes(lt) ? lt : 'permanent',
      ...(g ? { group: g } : {}),
    };
  }).filter((c) => c.label && c.prompt);
  // 增量: 老池按 id 覆盖/摘除, 再把没见过的追加在尾巴上(顺序稳定, 屏幕上按钮不会跳位)。
  const incoming = new Map(clean.map((c) => [c.id, c]));
  const final = merging
    ? [..._chipState(entry).custom
         .filter((c) => c && !removeIds.includes(c.id))
         .map((c) => incoming.get(c.id) || c),
       ...clean.filter((c) => !_chipState(entry).custom.some((o) => o && o.id === c.id))]
    : clean;
  let used = _chipState(entry).used;
  const factoryIds = _factoryChipIds();
  const retireIds = removeIds.filter((x) => factoryIds.includes(x));
  if (retireIds.length) used = [...new Set([...used, ...retireIds])];
  // 🔴 "传空 = 全清"由这一层保证, 不靠调用方记得传 retireFactory —— 判断散在外面就会
  // 出现"默认值说一套、真实调用做另一套"(行业版那边就这么矛盾了很久)。
  // 传空数组 = 用户要"屏幕上一个按钮都没有"; 只清自定义的话出厂批还亮着, 他会以为没照做。
  const retireFactory = (opts && opts.retireFactory !== undefined) ? !!opts.retireFactory
    : (!merging && clean.length === 0);
  if (retireFactory) used = [...new Set([...used, ...factoryIds])];
  const resident = factoryIds.filter((x) => !used.includes(x)).length
    + final.filter((c) => c.lifetime !== 'once').length;
  const st0 = _chipState(entry);
  const before = factoryIds.filter((x) => !st0.used.includes(x)).length
    + st0.custom.filter((c) => c && c.lifetime !== 'once').length;
  if (resident > CHIP_RESIDENT_MAX && resident > before) {   // 老用户已超的不卡减法
    return { ok: false, error: `resident chips would be ${resident}, max ${CHIP_RESIDENT_MAX} (once notes not counted) — remove some first` };
  }
  const stats = { ..._chipState(entry).stats };
  const keepIds = Array.isArray(opts && opts.keep) ? opts.keep.map(String) : [];
  for (const k of keepIds) stats[k] = { ...(stats[k] || {}), count: (stats[k] && stats[k].count) || 0, first_seen: nowLocalISO() };
  entry.chips = { used, custom: final, stats };
  if (!saveRegistry(reg)) return { ok: false, error: '写登记簿失败' };
  return { ok: true, chips: final };
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
  migrateBuses, ensureBuses,
  grantPeer, revokePeer, arePeersLinked,
  getLocalApi, setLocalApi,
  getCapabilitySeen, setCapabilitySeen,
  resolveChips, bumpChip, touchChipSeen, chipUsage, setCustomChips,
  BASE_SKILLS, DEV_SKILLS,
};
