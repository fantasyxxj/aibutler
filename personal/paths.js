// paths.js — 数据基目录解析中枢（release 数据分离的核心）。
// 开发模式(electron . 跑仓库): 数据基目录 = 仓库根 → 一切行为跟以前一模一样, 调试专用。
// 打包模式(release .app/.exe): 安装目录只读, 数据必须落"用户数据目录"。
//   默认 = 系统标准位 app.getPath('userData') (mac: ~/Library/Application Support/butler; win: %APPDATA%\butler)。
//   用户可在首次启动时自选目录(躲开 C 盘等) → 选择结果写进"引导位"里的指针文件 data-location.json。
// 之后每次启动: 先读指针知道真数据目录在哪, 登记簿/唐伯虎/标签状态全落那儿。
const path = require('path');
const fs = require('fs');

let _app = null;
try { _app = require('electron').app; } catch (_) { /* 非 electron(测试/CLI)环境, 无 app */ }

const REPO_ROOT = path.resolve(__dirname, '..');  // paths.js 在 personal/ 下, 仓库根在上一级; 只用来定位源码, 不再当数据目录
const POINTER_NAME = 'data-location.json'; // 指针文件名(落在引导位)

// 开发模式的数据目录, 刻意放在仓库之外。原先是仓库根, 后果是 dev 人格的 cwd 落在
// personas/<id> —— 仓库内。它有文件工具, 而源码锁只装在 locked 包里, 于是它和我并发改
// 同一份源码: 2026-08-21 02:16 实撞过一次, commands.js 两边的改动一起丢了。
// BUTLER_DATA_DIR 可覆盖, 用于并存多套 dev 数据。
function devDataDir() {
  const dir = process.env.BUTLER_DATA_DIR
    ? path.resolve(process.env.BUTLER_DATA_DIR)
    : path.join(require('os').homedir(), '.butler-dev');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function isPackaged() { return !!(_app && _app.isPackaged); }
// 开发机模拟全新安装: BUTLER_SIMULATE_INSTALL=1 时数据目录照打包版走指针(首启选语言、选目录),
// 引导位和默认位仍是 dev 数据目录 —— 配 BUTLER_DATA_DIR 指一个空目录, 就跟刚装完一样。
// 同一个开关也让 core/cc-sdk-install.js 把仓里的 Claude SDK 当没有。
function simulateInstall() { return !isPackaged() && process.env.BUTLER_SIMULATE_INSTALL === '1'; }

// 引导位: 一个"永远固定、必然可写"的目录, 只用来存指针文件(记住真数据目录在哪)。
// 打包 = 系统标准 userData(苹果/微软保证可写); 开发 = 仓库外的 dev 数据目录。
function bootstrapDir() {
  return isPackaged() ? _app.getPath('userData') : devDataDir();
}
function pointerFile() { return path.join(bootstrapDir(), POINTER_NAME); }

function readPointer() {
  try {
    const j = JSON.parse(fs.readFileSync(pointerFile(), 'utf8'));
    if (j && typeof j.dataDir === 'string' && j.dataDir) return j.dataDir;
  } catch (_) {}
  return null;
}

// 系统标准默认数据目录(打包时的兜底)
function defaultDataDir() {
  return isPackaged() ? _app.getPath('userData') : devDataDir();
}

// 真数据基目录:
//   开发 → 仓库外的 dev 数据目录
//   打包 → 指针指定的目录; 没指针(还没首启选过)则系统标准位
// 🔴 "指针从来没写过"(全新安装)与"指针写着某个目录、而那个目录现在找不到"是两回事: 后者一旦
// 也悄悄回落到默认位, 用户看到的是登记簿空、空状态屏、默认人格目录 —— 一模一样的"全新安装"表象,
// 而他的数据好端端躺在原处。把被丢弃的那个路径记下来, 让启动链能指名道姓地告诉他是哪个目录没了。
let _cached = null;
let _discardedPtr = null;
function dataDir() {
  if (!isPackaged() && !simulateInstall()) return devDataDir();
  if (_cached) return _cached;
  const ptr = readPointer();
  if (ptr && !safeExists(ptr)) {
    _discardedPtr = ptr;
    console.error(`[paths] 数据目录指针指向的目录不存在, 已回落默认位: ${ptr} → ${defaultDataDir()}`);
  }
  _cached = (ptr && safeExists(ptr)) ? ptr : defaultDataDir();
  return _cached;
}

// 本次启动有没有因为"目录找不到"丢掉过指针。null = 没有。调用方据此提示用户, 别让他当成全新安装。
function discardedPointer() { return _discardedPtr; }

function safeExists(p) { try { return fs.existsSync(p); } catch (_) { return false; } }

// 首次启动是否还没选过数据目录(打包模式且指针缺失) → main 据此弹选择框
function needsFirstRunChoice() {
  return (isPackaged() || simulateInstall()) && !readPointer();
}

// 记下用户选的数据目录(写指针 + 清缓存, 下次 dataDir() 立即生效)
function setDataDir(dir) {
  const abs = path.resolve(dir);
  // Win 上对盘符根(D:\)mkdir 即使带 recursive 也报 EPERM → 已存在就不建
  if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
  fs.mkdirSync(bootstrapDir(), { recursive: true });
  fs.writeFileSync(pointerFile(), JSON.stringify({ dataDir: abs }, null, 2), 'utf8');
  _cached = abs;
  return abs;
}

// —— 各类数据文件/目录的落点 ——
// 总控目录: app 级、persona-neutral(登记簿/标签/全局设置)。跟"谁是管家"无关 → 管家角色可随意转移,
// 总控数据永远在这, 不跟着管家走。放 dataDir/app 下, 明确不属于任何人格。
function controlDir() { return path.join(dataDir(), 'app'); }
function registryFile() { return path.join(controlDir(), 'personas.json'); }   // 登记簿: 创建了几个人格
function tabsFile() { return path.join(controlDir(), '.opentabs.json'); }        // 运行状态: 开了哪些标签
// 内置第一个人格(butler-self, 显示名"管家"): 只是普通一员, 放 personas/ 下, 不再"拥有"数据目录。
function personasParent() { return path.join(dataDir(), 'personas'); }
function butlerSelfHome() { return path.join(personasParent(), 'butler-self'); }

// —— claude 可执行文件解析 ——
// 打包版只认应用自己的 claude, 不碰系统里另装的(版本未必对得上 SDK, 作者 2026-11-05 定):
//   用户在系统设置里自己下载的那份(core/cc-sdk-install.js); 老版本安装包捆绑在 Resources/bin/ 的那份。
// 都没有就返回捆绑位(不存在), spawn 时如实报找不到, 不退去系统 PATH。
// 开发机才退回常见安装位和 PATH。SDK query 的 pathToClaudeCodeExecutable + 登录检测都用它。
function claudeBinName() { return process.platform === 'win32' ? 'claude.exe' : 'claude'; }
function resolveClaudeBin() {
  const name = claudeBinName();
  const os = require('os');
  const cands = [];
  try { const b = require('../core/cc-sdk-install').binPath(dataDir()); if (b) cands.push(b); } catch (_) {}
  if (isPackaged()) {
    const bundled = path.join(process.resourcesPath, 'bin', name);
    return cands[0] || bundled;
  }
  // 开发: 若已 stage 了捆绑二进制则用它(便于本地验), 否则走系统安装
  const plat = process.platform === 'darwin' ? 'mac' : (process.platform === 'win32' ? 'win' : 'linux');
  cands.push(
    path.join(REPO_ROOT, 'build', 'bin', plat, process.arch, name),
    path.join(os.homedir(), '.claude', 'local', name),
    path.join(os.homedir(), '.local', 'bin', name),   // 官方原生安装器落点(Win/mac/linux 通用)
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  );
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return name;   // 兜底: 靠 PATH(开发机终端启动时能命中)
}

// 当前版本。app.getVersion() 本质也是读 package.json, 这里直接读, 好让非 electron 环境(门禁)也能跑。
function appVersion() {
  try { return require('../package.json').version || '0.0.0'; } catch (_) { return '0.0.0'; }
}

// —— 分发版(源码锁)判定 ——
// 分发版 = 交给别人用的包: 人格能写别的代码、搞别的项目, 但读不到也改不了 butler 自己。
// 刻意做成【构建期烙进 package.json 的 flavor】而不是运行时探测 app.isPackaged ——
// 因为作者自己装的也是打包版, 而我(码上飞)要在那个包里改 butler 源码。按 isPackaged 判
// 等于把开发者自己也锁死。BUTLER_LOCKED 只是给测试用的旁路, 不影响正式判定。
function isLockedBuild() {
  if (process.env.BUTLER_LOCKED === '1') return true;
  try { return require('../package.json').butlerFlavor === 'locked'; } catch (_) { return false; }
}

// 安装根: mac = X.app(Contents/Resources 上两层); win = 装机目录(exe 所在层)。
// 开发模式没有"安装根"这回事 → null, 调用方据此跳过一切与它相关的判断。
function installRoot() {
  if (!isPackaged()) return null;
  try {
    return process.platform === 'darwin'
      ? path.resolve(process.resourcesPath, '..', '..')
      : path.dirname(_app.getPath('exe'));
  } catch (_) { return null; }
}

// 🔴 数据目录落在安装根里 = 每次升级都会被格式化一次: NSIS 覆盖安装 = 先跑旧版卸载再装新版,
// `$INSTDIR` 整体清掉, 住在里面的人格/记忆/登记簿在安装程序眼里都是"上一版留下的垃圾"。
// 2026-09-22 实撞: 数据目录设成 `E:\butler`(同时是安装目录), 覆盖安装后 personas\ 整个消失,
// 程序照常读到指针、进去发现没有登记簿, 于是判定"一个人格都没有"弹创建屏 —— 全程零征兆。
function isUnderInstallRoot(p) {
  const root = installRoot();
  if (!root || !p) return false;
  const a = path.resolve(root);
  const b = path.resolve(String(p));
  if (a === b) return true;
  return b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

// 分发版里禁止人格触碰的目录。取黑名单(而非行业版那种家目录白名单), 因为个人版必须
// 允许人格去动任意别的项目 —— 白名单在这里等于把主要功能一起锁掉。
function selfGuardRoots() {
  const out = [];
  if (isPackaged()) {
    out.push(process.resourcesPath);                              // 捆绑的 claude 二进制
    try { out.push(_app.getAppPath()); } catch (_) {}             // app.asar —— 源码全在这里面
    out.push(installRoot());
  } else {
    out.push(REPO_ROOT);                                          // 开发模式: 仓库根(便于本地验)
  }
  // 总控目录(登记簿 personas.json / 凭据 secrets.json / 数据指针)。它是 persona-neutral 的,
  // 没有任何人格需要直接读文件 —— 管家改登记簿走 MCP 工具, 不走 fs。
  try { out.push(controlDir()); } catch (_) {}
  return out.filter(Boolean);
}

module.exports = {
  isPackaged, bootstrapDir, dataDir, defaultDataDir, needsFirstRunChoice, setDataDir, discardedPointer,
  controlDir, registryFile, tabsFile, butlerSelfHome, personasParent, resolveClaudeBin, REPO_ROOT,
  appVersion, isLockedBuild, selfGuardRoots, installRoot, isUnderInstallRoot,
};
