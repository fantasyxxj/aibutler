// run_script 的实现: 一个口把 core/scripts/ 下的脚本列出来、跑起来。
// 🔴 为什么不是「一个功能一个工具」—— 每注册一个工具, 它的 schema 每一轮都在付钱, 而这些
// 活儿多数几天才用一次。一个口 + 用时现列, 把不常用功能的常驻成本压到一份。
// 加新功能 = 往 core/scripts/ 丢一个 .js, 导出 {summary, args, run}, 不用动这里。
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'scripts');
const SAFE = /^[a-z0-9_-]+$/;

function listScripts() {
  let names = [];
  try {
    names = fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)).filter((n) => SAFE.test(n)).sort();
  } catch { return []; }
  const out = [];
  for (const name of names) {
    try {
      const m = require(path.join(DIR, name + '.js'));
      if (m && typeof m.run === 'function') out.push({ name, summary: m.summary || '(没写说明)', args: m.args || {} });
    } catch (e) {
      out.push({ name, summary: `⚠️ 这个脚本加载失败: ${(e && e.message) || e}`, args: {}, broken: true });
    }
  }
  return out;
}

function formatList(items) {
  if (!items.length) return '这台机器上还没有任何脚本。';
  const lines = items.map((it) => {
    const as = Object.entries(it.args).map(([k, v]) => `      ${k} — ${v}`).join('\n');
    return `  · ${it.name} — ${it.summary}${as ? '\n' + as : ''}`;
  });
  return `可以跑的脚本(${items.length} 个) —— 用 run_script(name, args) 跑其中一个:\n${lines.join('\n')}`;
}

async function runScript(name, args, ctx) {
  if (!name) return formatList(listScripts());
  const n = String(name).trim();
  if (!SAFE.test(n)) return `⚠️ 脚本名只能是小写字母数字和 - _; 收到的是「${n}」`;
  const file = path.join(DIR, n + '.js');
  if (!fs.existsSync(file)) {
    return `⚠️ 没有叫「${n}」的脚本。\n\n${formatList(listScripts())}`;
  }
  let m;
  try { m = require(file); } catch (e) { return `⚠️ 脚本「${n}」加载失败: ${(e && e.message) || e}`; }
  if (!m || typeof m.run !== 'function') return `⚠️ 脚本「${n}」没有导出 run(), 跑不了`;
  try {
    const r = await m.run(args || {}, ctx);
    return typeof r === 'string' ? r : JSON.stringify(r);
  } catch (e) {
    return `⚠️ 脚本「${n}」跑出错了: ${(e && e.message) || e}`;
  }
}

module.exports = { runScript, listScripts };
