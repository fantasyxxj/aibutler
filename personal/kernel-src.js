// 源码文本入口 —— 给那批"直接 grep 源码"的测试用。
// 它们守的是代码里必须/不许出现某种写法(如"建 query 时取的是人格偏好, 不掺 access"),
// 这种断言只能对着源码文本做。而这类断言最脆: 路径写死在测试里, 文件一挪就变成
// "切空了还全绿" —— 一个字都没守住却看不出来。所以**解析收在这一处**, 以后再挪只改这里。
//
// 2026-08-24 内核抽包: 引擎从单文件变成"主壳 + 同名目录", 随后又整体搬进 core/。
// 两次变动都只动了本文件。
const fs = require('fs');
const path = require('path');

// 一个源文件现在可能住在 core/ 也可能还在仓根(宿主侧)。按这个顺序找, 找不到就报出去 ——
// 静默返回空串会让所有 grep 断言当场变成"没找到就是没违规", 那是最坏的假绿。
const ROOTS = [path.join(__dirname, '..', 'core'), __dirname];

function resolveSrc(rel) {
  for (const r of ROOTS) {
    const p = path.join(r, rel);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`kernel-src: 找不到源文件 ${rel}(找过 core/ 与仓根)`);
}

// 读一个源文件的全文。测试里凡是 readFileSync(__dirname, 'x.js') 的都该换成这个。
const readSrc = (rel) => fs.readFileSync(resolveSrc(rel), 'utf8');

// 一个引擎 = 主壳 `<name>.js` + 它拆出的同名目录(目录可以还不存在, 拆包是分步做的)。
function engineSource(name) {
  const shell = resolveSrc(`${name}.js`);
  const dir = path.join(path.dirname(shell), name);
  const parts = [fs.readFileSync(shell, 'utf8')];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
      parts.push(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
  }
  return parts.join('\n');
}

const kernelSource = () => engineSource('agent');

module.exports = { kernelSource, engineSource, readSrc, resolveSrc };
