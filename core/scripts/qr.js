// 二维码: 文本 → 一张黑白 png 落到 attachments/, 回绝对路径。
// 🔴 必须白底黑块 + 留 4 格静默区 —— 聊天气泡底色是深的, 透明背景或没有静默区的码扫不出来。
// PNG 用 Node 自带 zlib 现编(8bit 灰度), 不为一张黑白图再拖依赖。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let CRC = null;
function crc32(b) {
  if (!CRC) {
    CRC = new Int32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); CRC[i] = c; }
  }
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// raw = 每行 1 个 filter 字节(0) + width 个像素字节(0=黑 255=白)
function pngGray(raw, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0;               // 位深 8 · 颜色类型 0(灰度)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = {
  summary: '把网址或一段文字做成二维码图片(png), 回一个路径贴进回复就能显示',
  args: {
    text: '要编码的内容, 网址就原样传网址(必填)',
    size: '图片边长像素, 不填是 240, 要印名片或海报传 480',
  },
  run({ text, size }, ctx) {
    const s = String(text == null ? '' : text).trim();
    if (!s) throw new Error('text 是空的, 没有内容可以编码');

    const qrcode = require('qrcode-generator');
    const qr = qrcode(0, 'M');            // 0=自动选最小够用的版本 · M=中等纠错(遮挡 15% 仍可读)
    qr.addData(s);
    qr.make();

    const n = qr.getModuleCount(), margin = 4;
    const px = Math.max(120, Math.min(1024, Number(size) || 240));
    const cell = Math.max(2, Math.floor(px / (n + margin * 2)));
    const side = cell * (n + margin * 2);

    const raw = Buffer.alloc((side + 1) * side, 0xff);
    for (let y = 0; y < side; y++) raw[y * (side + 1)] = 0;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      const x0 = (c + margin) * cell, y0 = (r + margin) * cell;
      for (let y = y0; y < y0 + cell; y++) {
        const at = y * (side + 1) + 1 + x0;
        raw.fill(0x00, at, at + cell);
      }
    }

    // attachments/ 是界面能照路径显示、也是 attach_local_file 唯一收的目录
    const dir = path.join(ctx.homeDir, 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `qr-${Date.now().toString(36)}.png`);
    fs.writeFileSync(file, pngGray(raw, side, side));

    return `✅ 二维码已生成 · 内容「${s.length > 60 ? s.slice(0, 60) + '…' : s}」· ${side}×${side}px\n`
      + `🔴 把这个路径贴进你的回复(裸路径, 不加 markdown 链接语法), 界面会显示成图片, 对方点一下能打开所在文件夹:\n${file}`;
  },
};
