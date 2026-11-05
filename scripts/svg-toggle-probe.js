// scripts/svg-toggle-probe.js — 验"同一个按钮点一下启、再点一下停"在 SMIL 里到底做不做得到。
//
// 为什么必须实测: begin 和 end 挂同一个事件时, SMIL 规范规定 end 实例时间必须晚于当前 begin 才算数,
// 同一时刻产生的 end 会被丢弃 —— 但"第二次点击同时产生新 begin 和有效 end"该谁赢, 规范留了余地,
// 各引擎实现不一。只能在真 Chromium 里打出来。
//
// 判定一律看图形真实位移(animVal), 不看 getStartTime —— 那玩意跑过一次就永远非空, 是恒真断言。
const { app, BrowserWindow } = require('electron');

// 三种写法, 各自独立一套按钮+方块, 互不干扰。dur 拉长到 10s, 免得动画自己跑完混进判定。
const VARIANTS = [
  { key: 'a_plain', attrs: '' },
  { key: 'b_whenNotActive', attrs: 'restart="whenNotActive"' },
  { key: 'c_never', attrs: 'restart="never"' },
];

const svgFor = (v, i) => `
  <rect id="btn${i}" x="2" y="${i * 18 + 2}" width="20" height="14" fill="#456"/>
  <rect id="box${i}" x="30" y="${i * 18 + 2}" width="10" height="14" fill="#4af">
    <animate id="an${i}" attributeName="x" from="30" to="130" dur="10s"
             begin="btn${i}.click" end="btn${i}.click" fill="freeze" ${v.attrs}/>
  </rect>`;

// D 方案: 单键 toggle 走不通时的替代 —— 播放键和停止键**叠在同一个位置**, 用 <set> 轮流显隐,
// 用户看到的就是一个键在 ▶/■ 之间切换。set 的 to 值在 begin~end 期间生效, end 后自动回落原值,
// 正好天然成对, 不用自己管状态。
const SVG_D = `
  <rect id="pbtn" x="2" y="60" width="20" height="14" fill="#2f5d8a">
    <set attributeName="display" to="none" begin="pbtn.click" end="sbtn.click"/>
  </rect>
  <rect id="sbtn" x="2" y="60" width="20" height="14" fill="#8a2f2f" display="none">
    <set attributeName="display" to="inline" begin="pbtn.click" end="sbtn.click"/>
  </rect>
  <rect id="boxD" x="30" y="60" width="10" height="14" fill="#5ec27a">
    <animate attributeName="x" from="30" to="130" dur="10s"
             begin="pbtn.click" end="sbtn.click" fill="freeze"/>
  </rect>
  <rect id="boxE" x="30" y="76" width="10" height="14" fill="#5ec27a">
    <animate attributeName="x" values="30;130;30" dur="8s"
             begin="pbtn.click" end="sbtn.click" repeatCount="indefinite"/>
  </rect>`;

// F 方案 = 教材现在教的写法, 也是作者手上那张图用的: 两个**各自独立、都可见**的按钮,
// 动画循环播放。测它是为了确认"循环动画到底停不停得住"跟叠加隐藏无关。
const SVG_F = `
  <rect id="fplay" x="2" y="92" width="20" height="14" fill="#2f5d8a"/>
  <rect id="fstop" x="26" y="92" width="20" height="14" fill="#8a2f2f"/>
  <rect id="boxF" x="60" y="92" width="10" height="14" fill="#fa9a4a">
    <animate attributeName="x" values="60;130;60" dur="8s"
             begin="fplay.click" end="fstop.click" repeatCount="indefinite"/>
  </rect>`;

const SVG = `<svg id="pic" viewBox="0 0 160 110" xmlns="http://www.w3.org/2000/svg">
${VARIANTS.map(svgFor).join('')}${SVG_D}${SVG_F}
</svg>`;

const PAGE = '<!doctype html><html><body><div id="wrap"></div></body></html>';

const script = `(async () => {
  const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  document.getElementById('wrap').innerHTML = ${JSON.stringify(SVG)};
  await raf();

  const variants = ${JSON.stringify(VARIANTS.map((v) => v.key))};
  const out = {};

  for (let i = 0; i < variants.length; i++) {
    const box = document.getElementById('box' + i);
    const btn = document.getElementById('btn' + i);
    const x = () => box.x.animVal.value;
    // 点一下, 等 400ms, 看方块挪了多少。>0 = 在跑, ~0 = 停着
    const tap = async () => { const b = x(); btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await wait(400); return { moved: +(x() - b).toFixed(2), at: +x().toFixed(2) }; };

    const t1 = await tap();   // 第1下: 期望跑起来
    const t2 = await tap();   // 第2下: 期望停住
    const t3 = await tap();   // 第3下: 期望再跑 —— 且要看清是接着跑还是倒回起点重来
    out[variants[i]] = {
      tap1_moved: t1.moved, tap2_moved: t2.moved, tap3_moved: t3.moved,
      xAfter1: t1.at, xAfter2: t2.at, xAfter3: t3.at,
      // 判据: 第1下动 + 第2下停 + 第3下又动 = 真 toggle
      isToggle: t1.moved > 1 && Math.abs(t2.moved) < 0.5 && t3.moved > 1,
      // 第3下如果 x 掉回 30 附近, 说明是"从头重播"而不是"接着跑"
      tap3RestartsFromHead: t3.at < t2.at,
    };
  }
  // —— D: 叠加双键 ——
  const shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
  const boxD = document.getElementById('boxD');
  const xD = () => boxD.x.animVal.value;
  const boxE = document.getElementById('boxE');
  const xE = () => boxE.x.animVal.value;
  const tapD = async (id) => {
    const b = xD(), bE = xE();
    document.getElementById(id).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(400);
    return { moved: +(xD() - b).toFixed(2), loopMoved: +Math.abs(xE() - bE).toFixed(2), play: shown('pbtn'), stop: shown('sbtn') };
  };
  const d0 = { play: shown('pbtn'), stop: shown('sbtn') };   // 初始: 只该看见播放键
  const d1 = await tapD('pbtn');   // 点播放: 该跑起来, 且键换成 ■
  const d2 = await tapD('sbtn');   // 点停止: 该停住, 且键换回 ▶
  const d3 = await tapD('pbtn');   // 再点播放: 第二轮还得灵
  const d4 = await tapD('sbtn');   // 再点停止
  out.d_stackedButtons = {
    init: d0, tap1_play: d1, tap2_stop: d2, tap3_play: d3, tap4_stop: d4,
    // 全程判据: 初始只见播放键 → 跑+换键 → 停+换回 → 第二轮照样跑 → 照样停
    works: d0.play && !d0.stop
        && d1.moved > 1 && !d1.play && d1.stop
        && Math.abs(d2.moved) < 0.5 && d2.play && !d2.stop
        && d3.moved > 1 && !d3.play && d3.stop
        && Math.abs(d4.moved) < 0.5 && d4.play && !d4.stop,
    // 循环动画(values+repeatCount=indefinite)那条独立算: 两轮启停都得灵
    loopWorks: d1.loopMoved > 1 && d2.loopMoved < 0.5 && d3.loopMoved > 1 && d4.loopMoved < 0.5,
  };

  // —— F: 教材写法, 两个独立可见按钮 + 循环动画 ——
  const boxF = document.getElementById('boxF');
  const xF = () => boxF.x.animVal.value;
  const tapF = async (id) => {
    const b = xF();
    document.getElementById(id).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(400);
    return +Math.abs(xF() - b).toFixed(2);
  };
  const fIdle = await (async () => { const b = xF(); await wait(400); return +Math.abs(xF() - b).toFixed(2); })();
  const fPlay = await tapF('fplay');
  const fStop = await tapF('fstop');
  const fPlay2 = await tapF('fplay');
  out.f_separateButtonsLoop = {
    idleBeforeAnyClick: fIdle,   // 没点之前就该是 0, 不是 0 说明它自己在跑, 后面全不算数
    afterPlay: fPlay, afterStop: fStop, afterPlayAgain: fPlay2,
    stopActuallyStops: fStop < 0.5,
    works: fIdle < 0.5 && fPlay > 1 && fStop < 0.5 && fPlay2 > 1,
  };

  return out;
})()`;

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 400, height: 300 });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
    const r = await w.webContents.executeJavaScript(script);
    process.stdout.write('PROBE:' + JSON.stringify({ ok: true, ...r }) + '\n');
  } catch (e) {
    process.stdout.write('PROBE:' + JSON.stringify({ ok: false, error: String(e && e.message) }) + '\n');
  }
  app.exit(0);
});
