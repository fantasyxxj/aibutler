// test-self-guard.js — 分发版源码锁的判定门禁。
// 只测 self-guard.js 导出的纯判定 check(), 不挂 SDK —— 挂上 SDK 才能测的东西等于测不了。
//
// 🔴 这份门禁里有一组"已知拦不住"的用例(见最后一节), 它们断言的是**放行**。
// 那不是 bug, 是黑名单 + 保留 Bash 这个组合的固有代价。写进门禁是为了让这个洞
// 一直被看见, 而不是等哪天有人以为它是墙。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSelfGuard, literalPrefix, pathTokens } = require('./self-guard');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log('  ✓', label); pass++; }
  else { console.log('  ✗', label); fail++; }
}

// 受保护根用本仓库根(真实存在, realpath 可解析); 工作目录用一个真实的临时目录。
const PROTECTED = __dirname;
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'selfguard-'));
const g = createSelfGuard({ roots: [PROTECTED], cwd: SANDBOX, homedir: SANDBOX });

const denied = (tool, input) => typeof g.check(tool, input) === 'string';
const allowed = (tool, input) => g.check(tool, input) === null;

console.log('\n[受保护根 · 直接路径]');
ok(denied('Read', { file_path: path.join(PROTECTED, 'agent.js') }), 'Read butler 源码 → 拦');
ok(denied('Write', { file_path: path.join(PROTECTED, 'agent.js') }), 'Write butler 源码 → 拦');
ok(denied('Edit', { file_path: path.join(PROTECTED, 'self-guard.js') }), 'Edit 守卫自己 → 拦');
ok(denied('Read', { file_path: path.join(PROTECTED, 'package.json') }), 'Read 配置 → 拦');
ok(denied('Read', { file_path: PROTECTED }), '受保护根自身 → 拦');
ok(denied('NotebookEdit', { notebook_path: path.join(PROTECTED, 'x.ipynb') }), 'NotebookEdit → 拦');

console.log('\n[界外 · 该放行的一律放行]');
ok(allowed('Read', { file_path: path.join(SANDBOX, 'a.js') }), '读自己工作目录 → 放行');
ok(allowed('Write', { file_path: path.join(SANDBOX, 'sub/b.js') }), '写工作目录下不存在的新文件 → 放行');
ok(allowed('Read', { file_path: '/etc/hosts' }), '读系统别处 → 放行(不是白名单, 别处不管)');
ok(allowed('Bash', { command: 'npm test && git status' }), '跑别的项目的命令 → 放行');
ok(allowed('Read', {}), '缺省路径(=cwd) → 放行');
ok(allowed('mcp__butler__memory_query', { query: PROTECTED }), '不碰文件系统的工具 → 放行(哪怕参数里有路径)');
ok(allowed('WebFetch', { url: 'https://example.com' }), 'WebFetch → 放行');

console.log('\n[绕道 · 相对路径与软链]');
// 相对路径要从守卫解析后的 cwd 起算: macOS 的 /var 是指向 /private/var 的软链,
// 拿未解析的 SANDBOX 算 ../ 会差一级 —— 那是测试的锅, 不是守卫的。
ok(denied('Read', { file_path: path.relative(g.cwd, path.join(PROTECTED, 'agent.js')) }),
  '用 ../ 相对路径拐回受保护根 → 拦');
{
  const link = path.join(SANDBOX, 'shortcut');
  fs.symlinkSync(PROTECTED, link);
  ok(denied('Read', { file_path: path.join(link, 'agent.js') }), '软链指向受保护根 → 拦(realpath 解析后判)');
  ok(denied('Bash', { command: `cat ${path.join(link, 'agent.js')}` }), '软链 + Bash → 拦');
  fs.unlinkSync(link);
}
ok(denied('Read', { file_path: '~/../..' + PROTECTED + '/agent.js' }) || true, '~ 展开不崩(形状容错)');

console.log('\n[Glob / Grep · pattern 会把范围拐出去]');
ok(denied('Glob', { path: SANDBOX, pattern: path.relative(g.cwd, PROTECTED) + '/*.js' }),
  'pattern 里 ../ 拐进受保护根 → 拦');
ok(denied('Grep', { pattern: 'x', path: path.join(PROTECTED, 'core') }), 'Grep 的 path 在受保护根内 → 拦');
ok(allowed('Glob', { path: SANDBOX, pattern: '**/*.js' }), '正常 pattern → 放行');
ok(allowed('Grep', { pattern: 'foo.*bar', path: SANDBOX }), '正则里的点星不当路径解 → 放行');
ok(literalPrefix('../../butler/*.js') === '../../butler', 'literalPrefix 切在第一个通配符前');
ok(literalPrefix('**/*.js') === '', '开头就是通配符 → 空前缀');

console.log('\n[Bash · 字面扫描能拦到的部分]');
ok(denied('Bash', { command: `cat ${PROTECTED}/agent.js` }), '命令里写死受保护根 → 拦');
ok(denied('Bash', { command: `cd ${PROTECTED} && ls` }), 'cd 进受保护根 → 拦');
ok(denied('Bash', { command: 'npx asar extract /Applications/x.app/Contents/Resources/app.asar /tmp/o' }),
  'app.asar 出现在命令里 → 拦(打包后源码全在它里面)');
ok(denied('Bash', { command: `grep -r secret ${PROTECTED}` }), 'grep 受保护根 → 拦');
ok(pathTokens('cat /a/b.js | grep x').includes('/a/b.js'), 'pathTokens 挑得出绝对路径');
ok(!pathTokens('npm run build').length, '普通命令里没有路径 token');

console.log('\n[空黑名单 = 无声放行一切, 必须当场炸]');
{
  let threw = false;
  try { createSelfGuard({ roots: [], cwd: SANDBOX }); } catch (_) { threw = true; }
  ok(threw, 'roots 为空 → 抛错, 不允许静默降级成不设防');
  threw = false;
  try { createSelfGuard({ cwd: SANDBOX }); } catch (_) { threw = true; }
  ok(threw, 'roots 缺省 → 抛错');
}

console.log('\n[守卫自己坏掉时必须放行, 不能把用户堵死]');
{
  const broken = createSelfGuard({ roots: [PROTECTED], cwd: SANDBOX });
  broken.check = () => { throw new Error('boom'); };
  // hook 内部 catch 的是它自己闭包里的 check, 这里改不到 —— 所以直接验真实 hook 对畸形输入的表现
  Promise.resolve(g.hook({ tool_name: 'Read', tool_input: null })).then((r) => {
    ok(JSON.stringify(r) === '{}', 'tool_input 为 null → 返回 {} 放行, 不抛');
  });
  ok(g.check('Read', undefined) === null, 'tool_input 缺省 → 放行不抛');
  ok(g.check(undefined, undefined) === null, 'tool_name 缺省 → 放行不抛');
  ok(g.check('Read', { file_path: 12345 }) === null, 'file_path 不是字符串 → 交给 SDK 报, 不在这里炸');
}

// 🔴 已知拦不住 —— 断言"放行"是故意的。黑名单 + 必须保留 Bash 的固有代价。
// 行业版能整只禁掉 Bash 所以没这个洞; 个人版要"能搞别的项目"就禁不掉。
// 这一节红了不要改断言去迎合, 那说明有人以为它是墙。
console.log('\n[⚠️ 已知洞 · 静态扫描扫不到的写法(断言放行是故意的)]');
ok(allowed('Bash', { command: 'cat $(echo L0FwcCB8IGJhc2U2NAo= | base64 -d)' }), '命令替换拼路径 → 扫不到');
ok(allowed('Bash', { command: `P=${PROTECTED.slice(0, 8)}; Q=${PROTECTED.slice(8)}; cat "$P$Q/agent.js"` }),
  '变量分段拼接 → 扫不到');
ok(allowed('Bash', { command: 'node -e "console.log(require(\'fs\').readdirSync(process.resourcesPath))"' }),
  '解释器内联脚本走运行时变量 → 扫不到');

// 🔴 作者 2026-09-20 实装撞到: butler 装在 D 盘, 首启那个框把数据目录也选在安装目录下,
// 于是人格家目录 = <安装根>/personas/<id>, 整个落在受保护根里面 —— 人格连自己的 persona.md
// 都读不了, 报的还是"那是全能管家自己的程序文件"。allow 必须压过 roots, 且只豁免精确子树。
console.log('\n[人格的家落在受保护根里面 → 豁免]');
const HOME_IN_ROOT = path.join(PROTECTED, 'personas', 'butler-self');
const MEM_IN_ROOT = path.join(HOME_IN_ROOT, '.claude', 'memory');
const g2 = createSelfGuard({
  roots: [PROTECTED], cwd: HOME_IN_ROOT, homedir: HOME_IN_ROOT, allow: [HOME_IN_ROOT, MEM_IN_ROOT],
});
const denied2 = (tool, input) => typeof g2.check(tool, input) === 'string';
const allowed2 = (tool, input) => g2.check(tool, input) === null;

ok(allowed2('Read', { file_path: path.join(MEM_IN_ROOT, 'persona.md') }), '读自己的 persona.md → 放行');
ok(allowed2('Edit', { file_path: path.join(MEM_IN_ROOT, 'MEMORY.md') }), '改自己的交接便条 → 放行');
ok(allowed2('Write', { file_path: path.join(HOME_IN_ROOT, 'notes/x.md') }), '在自己家新建文件 → 放行');
ok(allowed2('Bash', { command: `ls ${HOME_IN_ROOT}` }), 'Bash 列自己家(命令里含安装根前缀) → 放行');
ok(allowed2('Glob', { path: HOME_IN_ROOT, pattern: '**/*.md' }), 'Glob 自己家 → 放行');
// 豁免只到自己那棵子树为止
ok(denied2('Read', { file_path: path.join(PROTECTED, 'agent.js') }), '源码仍然 → 拦');
ok(denied2('Read', { file_path: path.join(PROTECTED, 'personas', 'someone-else', 'x.md') }), '别的人格的家 → 拦');
ok(denied2('Read', { file_path: path.join(HOME_IN_ROOT, '..', '..', 'package.json') }), '从自己家 .. 出去 → 拦');
ok(denied2('Bash', { command: `cat ${path.join(PROTECTED, 'package.json')}` }), 'Bash 读源码目录 → 仍然拦');
ok(denied2('Grep', { path: HOME_IN_ROOT, pattern: '../../*.js' }), 'Grep pattern 拐出自己家 → 拦');
// 不传 allow 时行为一字不变(存量调用方)
const g3 = createSelfGuard({ roots: [PROTECTED], cwd: SANDBOX, homedir: SANDBOX });
ok(typeof g3.check('Read', { file_path: path.join(PROTECTED, 'agent.js') }) === 'string', '不传 allow → 老行为不变');

fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n${fail ? '✗' : '✓'} self-guard: ${pass} 过 / ${fail} 败\n`);
process.exit(fail ? 1 : 0);
