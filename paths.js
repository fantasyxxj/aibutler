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

const REPO_ROOT = __dirname;               // paths.js 位于仓库根; 仅开发模式用得到
const POINTER_NAME = 'data-location.json'; // 指针文件名(落在引导位)

function isPackaged() { return !!(_app && _app.isPackaged); }

// 引导位: 一个"永远固定、必然可写"的目录, 只用来存指针文件(记住真数据目录在哪)。
// 打包 = 系统标准 userData(苹果/微软保证可写); 开发 = 仓库根。
function bootstrapDir() {
  return isPackaged() ? _app.getPath('userData') : REPO_ROOT;
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
  return isPackaged() ? _app.getPath('userData') : REPO_ROOT;
}

// 真数据基目录:
//   开发 → 仓库根(行为不变)
//   打包 → 指针指定的目录; 没指针(还没首启选过)则系统标准位
let _cached = null;
function dataDir() {
  if (!isPackaged()) return REPO_ROOT;
  if (_cached) return _cached;
  const ptr = readPointer();
  _cached = (ptr && safeExists(ptr)) ? ptr : defaultDataDir();
  return _cached;
}

function safeExists(p) { try { return fs.existsSync(p); } catch (_) { return false; } }

// 首次启动是否还没选过数据目录(打包模式且指针缺失) → main 据此弹选择框
function needsFirstRunChoice() {
  return isPackaged() && !readPointer();
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
// 打包版捆绑了一份自包含 claude 原生二进制(Resources/bin/), 首选它:
//   ① 免"用户没装 claude"的依赖  ② 根治 GUI app 不继承 PATH → 裸 spawn('claude') 找不到 的坑。
// 缺省(开发/未捆绑)再退回常见安装位, 最后靠 PATH。SDK query 的 pathToClaudeCodeExecutable + 登录检测都用它。
function claudeBinName() { return process.platform === 'win32' ? 'claude.exe' : 'claude'; }
function resolveClaudeBin() {
  const name = claudeBinName();
  const os = require('os');
  const cands = [];
  if (isPackaged()) {
    cands.push(path.join(process.resourcesPath, 'bin', name));   // 捆绑首选
  } else {
    // 开发: 若已 stage 了捆绑二进制则用它(便于本地验), 否则走系统安装
    const plat = process.platform === 'darwin' ? 'mac' : (process.platform === 'win32' ? 'win' : 'linux');
    cands.push(path.join(REPO_ROOT, 'build', 'bin', plat, process.arch, name));
  }
  cands.push(
    path.join(os.homedir(), '.claude', 'local', name),
    path.join(os.homedir(), '.local', 'bin', name),   // 官方原生安装器落点(Win/mac/linux 通用), Win 兜底尤其靠它
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  );
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return name;   // 兜底: 靠 PATH(开发机终端启动时能命中)
}

module.exports = {
  isPackaged, bootstrapDir, dataDir, defaultDataDir, needsFirstRunChoice, setDataDir,
  controlDir, registryFile, tabsFile, butlerSelfHome, personasParent, resolveClaudeBin, REPO_ROOT,
};
