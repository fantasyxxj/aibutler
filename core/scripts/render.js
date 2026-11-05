// 把一段 HTML 画成 png: 菜单图 · 海报 · 卡片 · 营业时间牌这类要排版的东西。
// 🔴 用的是本机字体, 所以中日文照常显示 —— 服务端那边没有 CJK 字体, 画出来是方块,
//    要出带字的图一律在这边画。
// 渲染在离屏 BrowserWindow 里(脚本跑在主进程, 所以拿得到)。data: URL 加载, 没有 node 权限。
const fs = require('fs');
const path = require('path');

const DEFAULT_W = 1200;
const MAX_W = 2500;
const MAX_H = 4000;

// 系统里一定有的中日文字体栈。写死在这里而不是让调用方每次自己拼 ——
// 漏了 CJK 字体名的后果是英文正常、日文回落到别的字体, 看着只是"有点怪"。
const FONT_STACK = '-apple-system, "PingFang SC", "Hiragino Sans", "Hiragino Kaku Gothic ProN",'
  + ' "Noto Sans CJK JP", "Microsoft YaHei", sans-serif';

function wrap(html, width) {
  return `<!doctype html><meta charset="utf-8"><style>
 *{box-sizing:border-box}
 html,body{margin:0;padding:0;width:${width}px;font-family:${FONT_STACK}}
</style>${html}`;
}

// 画一张图并落盘, 回 { file, png, width, height }。
// run() 之外单独导出, 是因为调用方常常要的是**字节本身**(比如把菜单图直接传给 LINE),
// 而 run() 回的是给人看的一段话, 从里面抠路径既绕又脆。
async function drawPng({ html, width, height, name }, ctx) {
  const body = String(html == null ? '' : html).trim();
  if (!body) throw new Error('html 是空的, 没有内容可以画');

  let electron;
  try { electron = require('electron'); } catch (e) { electron = null; }
  const BrowserWindow = electron && electron.BrowserWindow;
  if (!BrowserWindow) {
    throw new Error('这个脚本要在装机端里跑(需要 Electron 主进程), 命令行直接跑没有渲染器');
  }
  if (electron.app && electron.app.whenReady) await electron.app.whenReady();

  const W = Math.max(200, Math.min(MAX_W, Number(width) || DEFAULT_W));
  // 🔴 不给高度时先把视口压到最矮再量: `scrollHeight` 取的是 max(内容, 视口),
  // 一开始就开 600 高的窗口, 内容只有 450 也会量成 600, 底下白出一片。
  const win = new BrowserWindow({
    width: W,
    height: Number(height) ? Math.max(40, Math.min(MAX_H, Number(height))) : 80,
    show: false,
    webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true },
  });

  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(wrap(body, W)));
    // 不给高度就按内容量一次再截, 否则底下会留一片背景色或者把内容切掉
    if (!Number(height)) {
      const h = await win.webContents.executeJavaScript(
        'Math.ceil(Math.max(document.body.scrollHeight, document.documentElement.scrollHeight))');
      win.setContentSize(W, Math.max(40, Math.min(MAX_H, h || 600)));
    }
    // 离屏渲染是异步上屏的, 不等一下会截到白屏
    await new Promise((r) => setTimeout(r, 400));
    const img = await win.capturePage();
    const png = img.toPNG();
    const size = img.getSize();

    const dir = path.join(ctx.homeDir, 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(name || 'render').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'render';
    const file = path.join(dir, `${safe}-${Date.now().toString(36)}.png`);
    fs.writeFileSync(file, png);

    return { file, png, width: size.width, height: size.height };
  } finally {
    // 🔴 不能在这里同步 destroy: 离屏窗口拆得太急, 紧接着建的下一个离屏窗口
    // loadURL 会直接 ERR_FAILED(-2) —— 表现是"第一张画得出, 第二张必失败"。
    setTimeout(() => { try { win.destroy(); } catch (e) { /* 已经没了就算了 */ } }, 50);
  }
}

module.exports = {
  summary: '把一段 HTML 画成图片(png) —— 菜单图/海报/卡片这类要排版的东西, 中日文都能出',
  args: {
    html: '要画的 HTML(必填)。可以带 <style>, 字体已经配好不用自己指定, 写 CSS 排版即可',
    width: '画布宽度像素, 不填是 1200',
    height: '画布高度像素; 不填按内容自动量高',
    name: '文件名前缀, 不填是 render',
  },
  drawPng,
  async run(args, ctx) {
    const { file, png, width, height } = await drawPng(args, ctx);
    return `✅ 画好了 · ${width}×${height}px · ${(png.length / 1024).toFixed(0)}KB\n`
      + `🔴 把这个路径贴进你的回复(裸路径, 不加 markdown 链接语法), 界面会显示成图片:\n${file}`;
  },
};
