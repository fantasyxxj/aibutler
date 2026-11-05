// 渲染层的失败必须看得见。跑: node test-render-error-visible.js
//
// 病根(复发两次):
//   2026-08-25 管理窗「导入点不开」—— 渲染层抛异常, 主进程日志一个字都没有, 白猜两轮。
//              当时给 managerWin 补了 console-message 转发, **主窗漏了**。
//   2026-08-26 主窗「流程图卡在"渲染中…"」—— 同一个病: 现场不落盘, 查不出为什么。
//              另外 renderer.js 里 `if (window.mermaid)` 没有 else, await 没有超时,
//              于是"库没加载"和"渲染卡住"两种坏法, 长得都和"还在渲染"一模一样。
//
// 判据统一成一句: **坏了的样子不能和"正在进行"长得一样, 而且必须在磁盘上留下一行。**
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const rend = fs.readFileSync(path.join(__dirname, 'renderer', 'renderer.js'), 'utf8');

console.log('\n=== 每个窗口的渲染层报错都要进主进程日志 ===');
{
  // 实现收进了 core/renderer-diagnostics.js(两个窗口原本各抄一份)。所以守两头:
  // ① 每个窗口都挂上了 ② 那个模块里真的接了这两个事件 —— 少守一头都会漏。
  const diag = fs.readFileSync(path.join(__dirname, '..', 'core', 'renderer-diagnostics.js'), 'utf8');
  for (const win of ['mainWin', 'managerWin']) {
    ok(main.includes(`attachRendererDiagnostics(${win},`),
      `🔴 ${win} 挂了渲染层诊断(漏一个, 那个窗的报错就永远查不到)`);
  }
  ok(diag.includes("on('console-message'"), '🔴 诊断模块接了 console-message');
  ok(diag.includes("on('render-process-gone'"), '🔴 诊断模块接了 render-process-gone(渲染进程整个没了也要留痕)');

  // 行业版那个窗一直没挂, 于是店里的界面包炸了在主进程日志里也是一片空白。
  const ind = fs.readFileSync(path.join(__dirname, '..', 'industry', 'app', 'main.js'), 'utf8');
  ok(/attachRendererDiagnostics\(win,/.test(ind), '🔴 行业版主窗也挂了(店里出事同样要留痕)');
  // 🔴 但**只留痕, 不转给人格**: 店铺管家不能写包也不能改包(常驻提示语明写 You cannot
  // write one yourself), 转给它只会变成店主眼前的一句"出错了"。包只有配信元能修,
  // 所以真正的收件人是运营会社 —— 那条路还没有, 在它出现之前这里必须是两个参数。
  ok(/attachRendererDiagnostics\(win, *'[^']*'\)/.test(ind),
    '🔴 行业版不传第三个参数(改不了包的人收到报错只是噪音)');
}


console.log('\n=== mermaid: 两种坏法都不许伪装成"还在渲染" ===');
{
  const at = rend.indexOf('.mermaid-block');
  const seg = rend.slice(at - 400, at + 1800);
  ok(/!window\.mermaid/.test(seg),
    '🔴 库没加载时有兜底分支(原代码只有 if(window.mermaid), 没 else = 占位符永驻且零报错)');
  ok(/setTimeout[\s\S]{0,200}Promise\.race|Promise\.race[\s\S]{0,300}setTimeout/.test(seg),
    '🔴 render 有超时(不返回时要变成看得见的错, 而不是一直"渲染中…")');
  ok(/console\.error/.test(seg),
    '🔴 渲染失败往 console.error 打一行(配合上面的转发才能落盘)');
  ok(!/if \(window\.mermaid\) \{\s*body\.querySelectorAll\('\.mermaid-block'\)\.forEach\(async/.test(rend),
    '🔴 旧的裸 if(window.mermaid) 写法没有回潮');
}

console.log('\n=== SVG: 消毒失败要显示源码, 不许整块蒸发 ===');
{
  const md = fs.readFileSync(path.join(__dirname, 'renderer', 'md.js'), 'utf8');
  const at = md.indexOf('function svgImg');
  const seg = md.slice(at, at + 700);
  ok(!/return '';/.test(seg), '🔴 svgImg 不再返回空串(空串 = 图凭空消失, 谁都不知道出过事)');
  ok(/console\.error/.test(seg), '🔴 消毒判定不安全时往 console.error 打一行');
  ok(/looksLikeSvg/.test(md) && /xml[\s\S]{0,40}html/.test(md),
    '🔴 围栏语言认 xml/html 不只认 svg(模型第一次常写错, 写错就变成代码块且零报错)');
  ok(/<\\\?xml|<\?xml/.test(md), '🔴 容忍 <svg 前面的 XML 声明/注释前言');
}

console.log('\n=== index.html 引的本地文件必须真的存在 ===');
{
  // 病根 2026-08-26: 单仓拆分把 renderer/ 挪进 personal/, 这里的 ../node_modules 全成了死链,
  // mermaid 和 katex 一起哑掉两天 —— 而浏览器加载不到 script 是不报错的, 只是 window.X 为空。
  const ROOT = path.join(__dirname, '..');
  for (const rel of ['personal/renderer/index.html', 'industry/app/renderer/index.html']) {
    const f = path.join(ROOT, rel);
    if (!fs.existsSync(f)) continue;
    const dir = path.dirname(f);
    const refs = [...fs.readFileSync(f, 'utf8').matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((m) => m[1]).filter((p) => !/^(https?:|data:|butler-embed:|#|\/)/.test(p));
    const dead = refs.filter((p) => !fs.existsSync(path.resolve(dir, p.split(/[?#]/)[0])));
    ok(dead.length === 0, `🔴 ${rel} 没有死链` + (dead.length ? ` —— 断了: ${dead.join(', ')}` : ''));
  }
}

// —— 放最后: 这一节要等 debounce 到期才能判, 汇总只能挂在它里面 ——
console.log('\n=== 沙箱(插件)的报错必须转给人格 —— 那里没有 console, 不转它永远看不见 ===');
{
  const { createSandboxErrorRelay, isSandbox, DEBOUNCE_MS } = require('../core/renderer-diagnostics');
  ok(isSandbox('about:srcdoc') && !isSandbox('file:///x/renderer/renderer.js'),
    '🔴 只认沙箱来的(主界面自己的报错不该去打扰人格)');

  // 2026-08-30 实测那 41 次是同一句话。原样转发 = 41 次模型调用, 刷屏之后人格反而看不见重点。
  const sent = [];
  const relay = createSandboxErrorRelay((t) => { sent.push(t); return Promise.resolve(); }, () => {});
  for (let i = 0; i < 41; i++) relay('TypeError: history.map is not a function', 'about:srcdoc', 44);
  relay('ReferenceError: foo is not defined', 'about:srcdoc', 9);
  relay('主界面自己的错', 'file:///x/renderer.js', 3);
  ok(sent.length === 0, '🔴 不立刻发 —— 一次崩溃常连抛数条, 要等它抛完再一起说');

  setTimeout(() => {
    ok(sent.length === 1, `🔴 41 次同样的错只打扰一次(实得 ${sent.length} 条)`);
    const t = sent[0] || '';
    ok(/×41/.test(t), '🔴 次数一并告诉它 —— 41 次说明在渲染循环里, 1 次说明在初始化, 次数本身是诊断信息');
    ok(/history\.map/.test(t) && /foo is not defined/.test(t), '两种错在同一条里, 没漏');
    ok(!/主界面自己的错/.test(t), '非沙箱来的没混进去');
    ok(/memory_query/.test(t), '🔴 告诉它去哪查怎么修, 不是只甩一句报错');
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  }, DEBOUNCE_MS + 400);
}
