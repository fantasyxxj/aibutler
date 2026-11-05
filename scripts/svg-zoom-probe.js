// scripts/svg-zoom-probe.js — 在真 Chromium 里验"图里的动画控制按钮, 放大之后还灵不灵"。
//
// 存在的理由: jsdom 完全不实现 SMIL, 纯 node 门禁对这件事一个字都验不到。而放大是把 svg 节点
// **搬**进 lightbox, svg 一离开文档 Chromium 就拆掉它的 SMIL 时间容器, 重新插入时容器会重建 ——
// 但 begin="按钮id.click" 这类事件型条件不跟着重新解析, 于是放大后播放键全哑。
//
// 🔴 判定必须看图形**真的动了没有**(animVal 位移), 不能用 getStartTime() 非空。
//    动画一旦跑过一次, getStartTime() 就永远非空, 拿它判"这一次点击灵不灵"是恒真断言 ——
//    2026-08-20 第一版探针就栽在这, 三条路径全绿, 而作者手上照样点不动。
// 🔴 每条路径都要用**新画的一张图**, 不能几条路径共用一张: 上一条点出来的位移会让下一条假绿。
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

// 图里两条动画: box 靠按钮启停(事件型), auto 自己一直跑(时间型)。
// 后者是防回归用的 —— 修 A 不许把 B 打回从头再播一遍。
const SVG = `
<span class="md-svg-wrap"><svg id="pic" viewBox="0 0 120 60" xmlns="http://www.w3.org/2000/svg">
  <rect id="playBtn" x="2" y="2" width="30" height="16" fill="#456"/>
  <rect id="box" x="40" y="10" width="20" height="20" fill="#4af">
    <animate id="an" attributeName="x" from="40" to="90" dur="2s" begin="playBtn.click" fill="freeze"/>
  </rect>
  <rect id="auto" x="0" y="40" width="10" height="10" fill="#fa4">
    <animate attributeName="x" from="0" to="100" dur="10s" begin="0s" fill="freeze"/>
  </rect>
</svg></span>`;

// renderer.js 里 lightbox + SVG 放大那一整段, 原文取用
function zoomSource() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'personal', 'renderer', 'renderer.js'), 'utf8');
  const a = src.indexOf('// lightbox 单例');
  const b = src.indexOf('document.body.appendChild(_lightboxEl);');
  if (a < 0 || b < 0) throw new Error('renderer.js 里找不到 lightbox 那一段, 切片规则要跟着改');
  return src.slice(a, src.indexOf('\n}', b) + 2);
}

const PAGE = '<!doctype html><html><body><div id="wrap"></div></body></html>';

const script = (zoomSrc) => `(async () => {
  const t = () => 'zoom';
  ${zoomSrc}
  const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // 每条路径重画一张干净的图, 免得上一条的位移污染下一条。
  // 🔴 画完必须等一拍: innerHTML 刚落地就点, SMIL 时间容器还没起来, 那次点击会被丢掉 ——
  //    表现是对照组位移 0, 看着像"连不放大都坏了", 其实只是探针自己抢跑。
  const fresh = async () => {
    document.getElementById('wrap').innerHTML = ${JSON.stringify(SVG)};
    await raf();
    return document.querySelector('#wrap svg');
  };
  const xNow = () => document.getElementById('box').x.animVal.value;
  const click = () => document.getElementById('playBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  // 点一下, 等 300ms, 看方块到底挪了没有 —— 这才是"按钮还灵不灵"的唯一证据
  const clickMoves = async () => { const before = xNow(); click(); await wait(300); return +(xNow() - before).toFixed(2); };

  const r = {};

  // A 对照: 什么都不做, 直接点。这条必须动, 不动说明探针自己坏了
  await fresh();
  r.a_plain = await clickMoves();

  // B 作者的路径: 放大 → 放大态**不点** → 关掉 → 回到消息流里再点
  const svgB = await fresh();
  openSvgLightbox(svgB);
  await raf();
  closeLightbox();
  await raf();
  r.b_backHome = document.querySelector('#wrap svg') === svgB;
  r.b_zoomThenClick = await clickMoves();

  // C 放大态点一次, 关掉之后再点一次 —— 两次都得灵
  const svgC = await fresh();
  openSvgLightbox(svgC);
  await raf();
  r.c_whileZoomed = await clickMoves();
  closeLightbox();
  await raf();
  r.c_afterClose = await clickMoves();

  // D 来回放大两趟, 看重绑扛不扛得住反复搬运
  const svgD = await fresh();
  openSvgLightbox(svgD); await raf(); closeLightbox(); await raf();
  openSvgLightbox(svgD); await raf(); closeLightbox(); await raf();
  r.d_twoRoundTrips = await clickMoves();

  // E 防回归: 自动播放的那条(begin="0s")跑了一会儿之后放大再关掉, 不许被打回从头。
  //   autoRewound 为 true 就是修出了新 bug —— 用户翻看一张早就播完的图, 关掉放大后动画突然重演。
  const svgE = await fresh();
  const autoX = () => document.getElementById('auto').x.animVal.value;
  // 🔴 必须**轮询到它真的动起来**再取基线, 不能 wait 一个固定时长就读。
  //    实测 wait(600) 读回来是 0(时间容器起步比挂钟晚), 而基线 0 会让下面
  //    autoRewound 那条判据永远不成立 —— 守卫恒假, 回归了也报不出来。
  //    (本段整体是模板字符串, 注释里不许出现反引号和 dollar-brace, 会把脚本截断)
  //    光 setTimeout 轮询是不够的: show:false 的窗口不产帧, animVal 就一直停在 0,
  //    直到放大那一下强制重绘才猛地同步过去。每轮必须逼出一帧再读。
  for (let i = 0; i < 60 && autoX() < 1; i++) { await wait(50); await raf(); }
  const beforeZoom = autoX();
  openSvgLightbox(svgE); await raf(); closeLightbox(); await raf();
  r.e_autoBefore = +beforeZoom.toFixed(2);
  r.e_autoAfter = +autoX().toFixed(2);
  r.e_autoRewound = autoX() < beforeZoom - 0.5;

  return r;
})()`;

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 400, height: 300 });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
    const r = await w.webContents.executeJavaScript(script(zoomSource()));
    process.stdout.write('PROBE:' + JSON.stringify({ ok: true, ...r }) + '\n');
  } catch (e) {
    process.stdout.write('PROBE:' + JSON.stringify({ ok: false, error: String(e && e.message) }) + '\n');
  }
  app.exit(0);
});
