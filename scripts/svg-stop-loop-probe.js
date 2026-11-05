// scripts/svg-stop-loop-probe.js — 回答一个问题: **循环播放的 SMIL 动画, 怎么才能用按钮停住?**
//
// 2026-08-20 实测发现教材教的写法是坏的: repeatCount="indefinite" 的动画,
// end="停止键.click" 完全不生效, 点了照跑(位移 6.89 → 6.89)。而同样的 end 对一次性动画是灵的,
// 所以病根在"循环"上, 不在事件解析上。这个探针逐个试候选写法, 找出真能停的那个。
//
// 判定看 animVal 真实位移: 点完等 400ms, 位移 <0.5 才叫停住。
const { app, BrowserWindow } = require('electron');

// 每个候选一套独立的 播放键/停止键/方块, 互不干扰
const LOOP = 'values="60;130;60" dur="8s" repeatCount="indefinite"';
const CANDIDATES = [
  { key: 'freeze', anim: `${LOOP} fill="freeze"` },
  { key: 'repeatDur', anim: 'values="60;130;60" dur="8s" repeatDur="indefinite"' },
  { key: 'finiteRepeat', anim: 'values="60;130;60" dur="8s" repeatCount="999"' },
  { key: 'oneShotBaseline', anim: 'from="60" to="130" dur="20s" fill="freeze"' },
  // freeze 能停住但停完起不来 —— 试显式 restart 能不能把重播救回来
  { key: 'freezeRestartAlways', anim: `${LOOP} fill="freeze" restart="always"` },
  { key: 'freezeRestartWhenNotActive', anim: `${LOOP} fill="freeze" restart="whenNotActive"` },
];

const rowFor = (c, i) => `
  <rect id="p${i}" x="2"  y="${i * 18 + 2}" width="18" height="14" fill="#2f5d8a"/>
  <rect id="s${i}" x="24" y="${i * 18 + 2}" width="18" height="14" fill="#8a2f2f"/>
  <rect id="b${i}" x="60" y="${i * 18 + 2}" width="10" height="14" fill="#4af">
    <animate attributeName="x" ${c.anim} begin="p${i}.click" end="s${i}.click"/>
  </rect>`;

// 另一条路: 动画交给 CSS(默认 paused), SMIL 只负责在根节点上切一个属性, CSS 属性选择器接管播放状态。
// 若成立, 这是唯一能做到**真暂停·原地续播·无限次切换**的写法 —— SMIL 的 end 只会终止, 不会暂停。
const CSS_ROW_Y = CANDIDATES.length * 18 + 6;
const SVG_CSS = `
  <style>
    #cssbox { animation: slide 8s linear infinite; animation-play-state: paused; }
    svg[data-run="1"] #cssbox { animation-play-state: running; }
    #clsbox { animation: slide 8s linear infinite; animation-play-state: paused; }
    svg.run #clsbox { animation-play-state: running; }
    #refbox { animation: slide 8s linear infinite; }
    @keyframes slide { from { transform: translateX(0px); } to { transform: translateX(70px); } }
  </style>
  <rect id="cp" x="2"  y="${CSS_ROW_Y}" width="18" height="14" fill="#2f5d8a"/>
  <rect id="cs" x="24" y="${CSS_ROW_Y}" width="18" height="14" fill="#8a2f2f"/>
  <rect id="cssbox" x="60" y="${CSS_ROW_Y}" width="10" height="14" fill="#5ec27a"/>
  <rect id="clsbox" x="60" y="${CSS_ROW_Y + 16}" width="10" height="14" fill="#5ec27a"/>
  <rect id="refbox" x="60" y="${CSS_ROW_Y + 32}" width="10" height="14" fill="#888"/>
  <set attributeName="data-run" to="1" begin="cp.click" end="cs.click"/>
  <set attributeName="class" to="run" begin="cp.click" end="cs.click"/>`;

const SVG = `<svg viewBox="0 0 160 ${CSS_ROW_Y + 20}" xmlns="http://www.w3.org/2000/svg">
${CANDIDATES.map(rowFor).join('')}${SVG_CSS}
</svg>`;

const PAGE = '<!doctype html><html><body><div id="wrap"></div></body></html>';

const script = `(async () => {
  const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  document.getElementById('wrap').innerHTML = ${JSON.stringify(SVG)};
  await raf();

  const keys = ${JSON.stringify(CANDIDATES.map((c) => c.key))};
  const out = {};
  for (let i = 0; i < keys.length; i++) {
    const box = document.getElementById('b' + i);
    const x = () => box.x.animVal.value;
    const tap = async (id) => {
      const before = x();
      document.getElementById(id).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await wait(400);
      return +Math.abs(x() - before).toFixed(2);
    };
    const idle = await (async () => { const b = x(); await wait(400); return +Math.abs(x() - b).toFixed(2); })();
    const played = await tap('p' + i);
    const stopped = await tap('s' + i);
    const replayed = await tap('p' + i);
    out[keys[i]] = {
      idle, played, stopped, replayed,
      // 要的是全套: 没点不动 → 点播放跑 → 点停真停 → 还能再播
      works: idle < 0.5 && played > 1 && stopped < 0.5 && replayed > 1,
    };
  }
  // —— CSS play-state 方案 —— 位移走 transform, 得量屏幕坐标而不是 x.animVal
  const cssbox = document.getElementById('cssbox');
  const cx = () => cssbox.getBoundingClientRect().left;
  const tapC = async (id) => {
    const b = cx();
    document.getElementById(id).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(400);
    return +Math.abs(cx() - b).toFixed(2);
  };
  const cIdle = await (async () => { const b = cx(); await wait(400); return +Math.abs(cx() - b).toFixed(2); })();
  const cPlay = await tapC('cp');
  const cStop = await tapC('cs');
  const cReplay = await tapC('cp');
  const cStop2 = await tapC('cs');
  out.cssPlayState = {
    idle: cIdle, played: cPlay, stopped: cStop, replayed: cReplay, stoppedAgain: cStop2,
    works: cIdle < 0.5 && cPlay > 1 && cStop < 0.5 && cReplay > 1 && cStop2 < 0.5,
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
