// run_script 的实现: 一个口把 core/scripts/ 下的脚本列出来、跑起来。
// 🔴 为什么不是「一个功能一个工具」—— 每注册一个工具, 它的 schema 每一轮都在付钱, 而这些
// 活儿多数几天才用一次。一个口 + 用时现列, 把不常用功能的常驻成本压到一份。
// 加新功能 = 往 core/scripts/ 丢一个 .js, 导出 {summary, args, run}, 不用动这里。
// 宿主自己的脚本放在它的目录里, 由 ctx.dirs 带进来(行业版改界面语言这类只属于它的活), 同名时 core 的优先。
// ctx.ownDir = 人格自己写脚本的可写目录(宿主给了才有): 列清单时告诉它往哪写, 改过的文件每次重新加载。
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'scripts');
const SAFE = /^[a-z0-9_-]+$/;

// name → file, core 的目录在前
function scriptFiles(dirs = []) {
  const files = new Map();
  for (const d of [DIR, ...dirs]) {
    let names = [];
    try { names = fs.readdirSync(d).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)).filter((n) => SAFE.test(n)); } catch { continue; }
    for (const n of names) if (!files.has(n)) files.set(n, path.join(d, n + '.js'));
  }
  return files;
}

// 人格自己写的脚本随时会改, 不能吃 require 缓存; 包里的只读, 缓存着无妨
function load(file, ownDir) {
  if (ownDir && file.startsWith(ownDir + path.sep)) delete require.cache[require.resolve(file)];
  return require(file);
}

function listScripts(dirs, ownDir) {
  const files = scriptFiles(dirs);
  const out = [];
  for (const name of [...files.keys()].sort()) {
    try {
      const m = load(files.get(name), ownDir);
      if (m && typeof m.run === 'function') out.push({ name, summary: m.summary || '(没写说明)', args: m.args || {} });
    } catch (e) {
      out.push({ name, summary: `⚠️ 这个脚本加载失败: ${(e && e.message) || e}`, args: {}, broken: true });
    }
  }
  return out;
}

function ownHint(ownDir) {
  return ownDir
    ? `\n\n自己写的脚本放在 ${ownDir}/<名字>.js(名字只用小写字母数字 - _), 导出 { summary, args, run(args, ctx) }, run 返回字符串; 只能 require Node 自带模块。写好下一次调用就在这张单子上; 跟上面重名时上面的优先。`
    : '';
}

function formatList(items, ownDir) {
  if (!items.length) return '这台机器上还没有任何脚本。' + ownHint(ownDir);
  const lines = items.map((it) => {
    const as = Object.entries(it.args).map(([k, v]) => `      ${k} — ${v}`).join('\n');
    return `  · ${it.name} — ${it.summary}${as ? '\n' + as : ''}`;
  });
  return `可以跑的脚本(${items.length} 个) —— 用 run_script(name, args) 跑其中一个:\n${lines.join('\n')}` + ownHint(ownDir);
}

// 自带脚本坏了是程序缺陷: 回执里直接说该怎么跟对方讲 —— 实测助手会改用本机碰巧装着的命令顶上,
// 还把这条野路记成规矩, 换一台机器就没了。自己写的那份坏了, 改它就是。
function broken(msg, file, ownDir) {
  if (ownDir && file.startsWith(ownDir + path.sep)) return `${msg}\n这是你自己写的脚本: ${file}, 改好再跑。`;
  return `${msg}\n这是程序自带的脚本, 坏了属于程序缺陷: 如实告诉对方这个功能暂时用不了, 有上报口(如 admin_bus 的 report_issue)就报上去。替代办法只用程序里本来就有的工具, 这台机器上碰巧装着的命令别的机器没有。`;
}

async function runScript(name, args, ctx) {
  const dirs = (ctx && ctx.dirs) || [];
  const ownDir = (ctx && ctx.ownDir) || null;
  if (!name) return formatList(listScripts(dirs, ownDir), ownDir);
  const n = String(name).trim();
  if (!SAFE.test(n)) return `⚠️ 脚本名只能是小写字母数字和 - _; 收到的是「${n}」`;
  const file = scriptFiles(dirs).get(n);
  if (!file) {
    return `⚠️ 没有叫「${n}」的脚本。\n\n${formatList(listScripts(dirs, ownDir), ownDir)}`;
  }
  let m;
  try { m = load(file, ownDir); } catch (e) { return broken(`⚠️ 脚本「${n}」加载失败: ${(e && e.message) || e}`, file, ownDir); }
  if (!m || typeof m.run !== 'function') return broken(`⚠️ 脚本「${n}」没有导出 run(), 跑不了`, file, ownDir);
  try {
    const r = await m.run(args || {}, ctx);
    return typeof r === 'string' ? r : JSON.stringify(r);
  } catch (e) {
    const msg = `⚠️ 脚本「${n}」跑出错了: ${(e && e.message) || e}`;
    // 参数不对是调用方的事, 照原话回; 缺模块是包没打全
    return e && e.code === 'MODULE_NOT_FOUND' ? broken(msg, file, ownDir) : msg;
  }
}

module.exports = { runScript, listScripts };
