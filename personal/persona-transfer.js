// persona-transfer.js — 把一个人格整体导出成一个文件, 在另一台机器的 butler 里导入。
//
// 🔴 搬【内容】不搬【容器】(作者 2026-08-19 定的口径, 说了两遍我才懂):
//    「导出人格又不是备份数据库, 是把记忆弄出来写个文件; 导入也是往现有数据库里写东西」
//    所以记忆库【不以 .db 文件进包】, 进包的是 store.exportGraph() 出来的一份记录清单
//    (memory.export.json); 导入端拿本机 schema 新建空库再灌进去。
//    换来的是整串麻烦一次消失: 导出是纯 SELECT(人格开着照导, 不用守卫不用快照)、导入是普通
//    INSERT(不会 database is locked)、目标库天生就是本机版(没有迁移这一步)。
//    详见 [[feedback_transfer_content_not_container_logical_export_over_file_copy]]。
//
// 为什么不引第三方压缩库: 包里实质只有【一份 JSON + 几个文本文件】。为这点东西加一条
// 依赖, 要跟着 electron-builder 的打包配置走一遍, 换来的是一个我们不掌握的格式。自己定容器
// 反而更小更可控 —— 还能把格式版本、来源、校验和写进头部, 导入时先验再落盘。
//
// 容器布局(整体 gzip):
//   MAGIC(16B) | headerLen(4B LE) | header(JSON utf8) | 各文件原始字节按 header.files 顺序拼接
//
// 🔴 三条安全底线, 改的时候别绕过:
//   ① 解包路径必须逐条查 —— 包是从别的机器拿来的文件, `../../.ssh/authorized_keys` 这种
//      条目一旦照着写就是任意文件覆盖(zip slip)。checkRelPath 是唯一入口。
//   ② 凭据不进包。人格身上的明文 token(plugins.tg.bot_token 之类)会跟着包走遍邮件和网盘,
//      而它在新机器上本来就该重配。stripCredentials 摘掉它们并在 manifest 里留个记号。
//   ③ 机器绑定的东西不进包。app/secrets.json 是 safeStorage(Keychain/DPAPI)加密的, 换机器
//      解不开 —— 但它本来就是 app 级而不是人格级, 新机器用自己那份就行, 所以压根不用带。
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { nowLocalISO, todayLocal } = require('../core/memory');

// /2 起记忆走记录清单而不是 .db 文件。不做 /1 兼容: 这功能还没进过任何发行版
// (装机版 0.0.57 里根本没有导出按钮), 世上不存在 /1 的包。
const FORMAT = 'butler-persona/2';
const MAGIC = Buffer.from('BUTLERPERSONA\x00\x01\n', 'binary');   // 16 字节
const EXT = '.butlerpersona';
// 记忆记录清单在包里的文件名。内容 = { nodes, edges, pinned, redlines }, 见 store.exportGraph()
const MEMORY_EXPORT = 'memory.export.json';
const MAX_TOTAL = 2 * 1024 * 1024 * 1024;    // 整包上限 2GB: 超了多半是误把 node_modules 圈进来了

// 不进包的东西。分三类, 理由各不相同 —— 别合并成一张表, 合并之后就没人记得为什么了。
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'logs', 'dist', 'build', '.cache', '__pycache__',
  // 消息附件: 用户发给人格的图片等。跟着 .session.json 一起留下 —— 逐字对话都不带了,
  // 单独带一堆没有上下文的附件只是把包撑大, 而且同样是隐私。
  'attachments',
]);
const SKIP_FILES = new Set([
  '.DS_Store', 'Thumbs.db',
  // 🔴 记忆库文件本身不进包 —— 搬的是记忆内容不是数据库。
  //   · memory.v2.db: 由 MEMORY_EXPORT 那份记录清单取代(调用方必须给, 否则 packPersona 直接炸)
  //   · memory.db(v1): v1 的真源本来就是 .md 文件, 库只是派生索引, 导入端第一次开自己重建
  // 顺带堵掉一个隐私漏: 库里的 utterances 表是逐字原话流水, 拷 .db 会把它整个带走 ——
  // 而同性质的 .session.json 早就因为隐私排除了, 等于前门关了后门开着。
  'memory.v2.db', 'memory.db',
  // 可重建的缓存: 带上只是让包大一圈(600KB+), 导入后第一次检索自己会重建
  'memory_index.json',
  // 运行状态: 换机器后毫无意义, 带过去反而让新实例以为自己接着上次跑
  '.bothub_offset.json', '.opentabs.json', 'data-location.json',
  // 聊天记录: 隐私。人格的"记忆"在记忆库里, 逐字聊天记录不是身份的一部分
  'line_messages.jsonl',
  // 🔴 .session.json = 上一次会话的完整 messages + sessionId。三条理由都是硬的:
  //    ① 它是逐字对话历史(实测 banto 那份 177KB), 隐私
  //    ② 用户在对话里粘过的 token/key 全在里面 —— 实测该文件命中 token/Bearer/key
  //    ③ sessionId 换机器无意义, 带过去只会让新实例以为自己接着上次跑
  //    人格的记忆在 memory.v2.db 里, 那才是要搬的东西。
  '.session.json',
]);
// SQLite 的临时伴生文件。带上会和主库对不上号, 导入后可能被当成未提交事务回滚掉
const SKIP_SUFFIX = ['-journal', '-wal', '-shm', '.log', '.tmp', '.lock'];

// 🔴 后缀表对【文件和目录一视同仁】。原先 isDir 分支直接 return, 后缀表对目录完全失效 ——
// 而 `memory.v2.db.lock` 恰恰是个目录, 于是 `.lock` 那条规则对它一个字都没起作用。
// 这类"锁/临时"名字本来就不分文件还是目录, 按名字判就该按名字判到底。
function shouldSkip(name, isDir) {
  if (SKIP_SUFFIX.some((s) => name.endsWith(s))) return true;
  return isDir ? SKIP_DIRS.has(name) : SKIP_FILES.has(name);
}

// 🔴 zip slip 防线。包来自别的机器, 里面的路径是不可信输入。
// 只放行"相对、不含 ..、不含盘符、不含反斜线"的路径; 拿不准一律拒绝整个包而不是跳过这一条 ——
// 静默跳过会让导入结果看着成功实则缺文件, 那比直接失败更难查。
function checkRelPath(rel) {
  const p = String(rel || '');
  if (!p || p.length > 1024) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  if (p.includes('\\')) return false;
  if (p.includes('\0')) return false;
  return !p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '');
}

// 递归收集要打包的文件。symlink 不跟随: 跟随等于把链接目标(可能在人格目录之外)也卷进包里。
function collectFiles(rootDir) {
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (shouldSkip(e.name, e.isDirectory())) continue;
      const abs = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { walk(abs, rel); continue; }
      if (!e.isFile()) continue;
      let st;
      try { st = fs.statSync(abs); } catch (_) { continue; }
      out.push({ path: rel, size: st.size, abs });
    }
  };
  walk(rootDir, '');
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));   // 稳定顺序: 同一人格导两次字节一致
  return out;
}

// 登记簿条目里哪些跟着人格走, 哪些留在原机器。
// 跟着走的是"这个人格是谁": 名字/头像/模型/快捷按钮。
// 留下的是"它在这台机器上的处境": id(新机器另发)、homeDir(路径不一样)、isButler(管家全局唯一,
// 导进来就当管家会把新机器原本的管家挤掉)、以及所有凭据。
// 🔴 一層ずつ下まで剥がす。配列の中にも入る —— plugins.buses は**表**で、
// 一条ごとに token を持つ。最外層だけ見ていると各条の token がそのまま包に入る。
// 剥がす深さは設定の形に追随させる: 形は増えるし変わるので「一層の物」と決め打たない。
function scrub(v, at, stripped) {
  if (Array.isArray(v)) return v.map((x, i) => scrub(x, `${at}[${i}]`, stripped));
  if (!v || typeof v !== 'object') return v;
  const clean = {};
  for (const [pk, pv] of Object.entries(v)) {
    // 一律按名字判, 不按白名单 —— 插件是会加的, 加一个新插件时忘了更新白名单就等于泄一次密。
    if (/token|secret|key|password|credential/i.test(pk)) { stripped.push(`${at}.${pk}`); continue; }
    clean[pk] = scrub(pv, `${at}.${pk}`, stripped);
  }
  return clean;
}

function stripCredentials(entry) {
  const e = entry || {};
  const plugins = {};
  const stripped = [];
  for (const [k, v] of Object.entries(e.plugins || {})) {
    if (!v || typeof v !== 'object') continue;
    plugins[k] = scrub(v, k, stripped);
  }
  return {
    persona: {
      name: e.name || '', avatar: e.avatar || '', model: e.model || '',
      chips: e.chips || undefined, plugins,
      createdAt: e.createdAt || 0,
    },
    stripped,
  };
}

// 目录里有没有 v2 记忆库。用来兜住"忘了给记录清单"这个错 —— 库文件已经在 SKIP_FILES 里,
// collectFiles 看不见它, 所以这里单独扫一遍。深度封顶防意外大树。
function hasV2Db(root) {
  const walk = (dir, depth) => {
    if (depth > 4) return false;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return false; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && walk(path.join(dir, e.name), depth + 1)) return true; continue; }
      if (e.name === 'memory.v2.db') return true;
    }
    return false;
  };
  return walk(root, 0);
}

// —— 打包 ——
// opts.extraFiles: { 相对路径: Buffer } —— 不在磁盘上、由调用方现造的文件。记忆记录清单
// (MEMORY_EXPORT)就是这么进包的: 它是从库里 SELECT 出来的, 磁盘上没有对应文件。
function packPersona(homeDir, entry, opts = {}) {
  const root = path.resolve(homeDir);
  if (!fs.existsSync(root)) throw new Error(`人格目录不存在: ${root}`);
  const files = collectFiles(root);
  const extra = opts.extraFiles || {};
  // 🔴 有 v2 库却没给记录清单 = 这个包里没有记忆。宁可现在炸, 也不要导出一个"看着成功、
  //    导入后人格失忆"的包 —— 那种错要等到对面打开人格才发现, 而那时源机器可能已经不在手边。
  if (hasV2Db(root) && !Object.keys(extra).some((k) => k === MEMORY_EXPORT || k.endsWith(`/${MEMORY_EXPORT}`))) {
    throw new Error(`这个人格有 v2 记忆库, 但没有提供 ${MEMORY_EXPORT} —— 调用方必须先 store.exportGraph()`);
  }
  const extraList = Object.entries(extra).map(([rel, buf]) => {
    if (!checkRelPath(rel)) throw new Error(`不安全的路径: ${rel}`);
    return { path: rel, buf: Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8') };
  });
  if (!files.length && !extraList.length) throw new Error('这个人格目录里没有可导出的文件');
  const total = files.reduce((n, f) => n + f.size, 0) + extraList.reduce((n, f) => n + f.buf.length, 0);
  if (total > MAX_TOTAL) throw new Error(`内容过大(${Math.round(total / 1048576)}MB), 超过 ${MAX_TOTAL / 1073741824}GB 上限`);

  const { persona, stripped } = stripCredentials(entry);
  const blobs = [];
  const list = [];
  const hash = crypto.createHash('sha256');
  // 磁盘文件和现造文件混在一起排序: 同一人格导两次字节一致, 与来源无关
  const all = [...files.map((f) => ({ path: f.path, abs: f.abs })), ...extraList]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const f of all) {
    const buf = f.buf || fs.readFileSync(f.abs);
    hash.update(buf);
    blobs.push(buf);
    list.push({ path: f.path, size: buf.length });
  }
  const header = {
    format: FORMAT,
    exportedAt: nowLocalISO(),
    butlerVersion: opts.butlerVersion || '',
    persona,
    // 记忆是怎么带的。导入端拿它判断该不该建库灌数据, 也给用户一个"带了多少条"的实数
    memory: opts.memory || null,
    // 导入端拿它给用户一句实话: 哪些东西没跟过来, 得自己重配
    strippedCredentials: stripped,
    files: list,
    sha256: hash.digest('hex'),
  };
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(headerBuf.length, 0);
  return zlib.gzipSync(Buffer.concat([MAGIC, lenBuf, headerBuf, ...blobs]));
}

// —— 读包(只解析校验, 不落盘) ——
function readPackage(buf) {
  let raw;
  try { raw = zlib.gunzipSync(buf); } catch (_) { throw new Error('文件损坏或不是人格包(解压失败)'); }
  if (raw.length < MAGIC.length + 4 || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('这不是一个人格包');
  }
  const headerLen = raw.readUInt32LE(MAGIC.length);
  const headStart = MAGIC.length + 4;
  if (headerLen <= 0 || headStart + headerLen > raw.length) throw new Error('人格包头部损坏');
  let header;
  try { header = JSON.parse(raw.subarray(headStart, headStart + headerLen).toString('utf8')); }
  catch (_) { throw new Error('人格包头部不是合法 JSON'); }
  if (header.format !== FORMAT) throw new Error(`不支持的包格式: ${header.format || '(缺失)'} —— 本版认识 ${FORMAT}`);

  const files = new Map();
  let off = headStart + headerLen;
  const hash = crypto.createHash('sha256');
  for (const f of header.files || []) {
    if (!checkRelPath(f.path)) throw new Error(`包里有不安全的路径, 已拒绝: ${f.path}`);
    const size = Number(f.size);
    if (!Number.isInteger(size) || size < 0 || off + size > raw.length) throw new Error(`人格包内容截断于: ${f.path}`);
    const b = raw.subarray(off, off + size);
    hash.update(b);
    files.set(f.path, b);
    off += size;
  }
  // 校验和放在最后: 前面每一步都是"能不能读", 这一步是"读到的对不对"。
  if (header.sha256 && hash.digest('hex') !== header.sha256) throw new Error('人格包校验和不符, 内容可能已损坏');
  return { header, files };
}

// —— 落盘 ——
// 目录必须是空的或不存在。往一个已有人格的目录里解包 = 两个人格的记忆库对冲, 而且没法回滚。
function installFiles(files, targetDir) {
  const root = path.resolve(targetDir);
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error(`目标目录非空: ${root}`);
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, buf] of files) {
    if (!checkRelPath(rel)) throw new Error(`不安全的路径: ${rel}`);   // 二次把关: 这个函数可能被单独调用
    const abs = path.join(root, rel);
    // 即使路径查过一遍, 落盘前再确认它真的在 root 里面 —— 便宜, 且挡得住上面漏掉的构造
    if (!abs.startsWith(root + path.sep)) throw new Error(`不安全的路径: ${rel}`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
  }
  return root;
}

function suggestFileName(name) {
  const base = String(name || 'persona').trim().replace(/[^\w一-龥.-]+/g, '-').replace(/^-+|-+$/g, '') || 'persona';
  const day = todayLocal();
  return `${base}-${day}${EXT}`;
}

module.exports = {
  FORMAT, EXT, MAGIC, MAX_TOTAL, MEMORY_EXPORT,
  packPersona, readPackage, installFiles, suggestFileName,
  collectFiles, stripCredentials, checkRelPath, shouldSkip, hasV2Db,
};
