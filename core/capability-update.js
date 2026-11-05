// capability-update.js — 版本比较 + 用户侧更新说明。
//
// 2026-08-17 作者定案后这个文件换了职责。老做法: 每发一版手写一份 docs/capability_updates/<版本>.md,
// 引擎把它拼进唤醒正文教 AI, 用户读的也是同一份 —— 一份散文两个受众, 而且给 AI 的那一路是一次性的
// (读完随上下文丢掉, 三天后人格不记得这版加了什么, 图里也查不到)。整条通道已删。
//
// 现在给 AI 的那一路走出厂知识包 (factory-sync.js): 升级带的是出厂数据, 程序按 slug 覆盖进记忆图。
// 这里只剩两件事:
//   1) cmpVersion / needsUpdate —— 判断"装的 butler 比这个人格知道的新"。冷启动 hook 和唤醒都要用。
//   2) 用户侧更新说明 —— 只讲**用户自己能感觉到的变化**, 素材来自 config/main/release_notes.json。
//      2026-08-17 作者: "不用讲那么多, 只保留跟用户相关的, 内部变化不写"。先前这里渲染的是出厂知识包
//      的逐条差异, 但那 96 条全是 AI 的行为准则("动手前先查记忆""认错要快且具体")—— 对用户是纯噪音,
//      而且一次升级上百条, 铺出来只会把真正该看的埋掉。所以两路彻底分开: 出厂差异只进唤醒正文给 AI 看,
//      用户这一路按版本读发版说明。某版没写条目 = 那版用户无感, 不打扰。
'use strict';

const fs = require('fs');
const path = require('path');
const { cfg } = require('./host');
const lang = require('./memory-v2/lang');

// 版本比大小: 只认 a.b.c 三段数字, 非数字段按 0 处理(够用 —— 我们自己发版就是三段)。
function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// 该不该补课。分开成纯函数是为了让门禁能直接断言, 不用起 electron。
function needsUpdate(seenVersion, currentVersion) {
  return cmpVersion(seenVersion || '0.0.0', currentVersion) < 0;
}

// 取 (seenVersion, currentVersion] 区间里的发版说明。跨多版升级(棒头 0.0.52 → 0.0.58)要把中间
// 每一版都带上, 否则用户会漏掉自己没见过的那几版。首装(seen 为空)只讲当前版, 不倒背历史。
function pickReleaseNotes(seenVersion, currentVersion) {
  let all;
  try { all = cfg.json('main/release_notes'); } catch (_) { return []; }
  const from = seenVersion || currentVersion;
  return Object.keys(all)
    .filter((v) => !v.startsWith('_'))
    .filter((v) => cmpVersion(v, from) > 0 && cmpVersion(v, currentVersion) <= 0)
    .sort(cmpVersion)
    // 🔴 title/detail 可以是字符串, 也可以是 {zh-CN, zh-TW, ja, en} —— 发版说明是用户看得见的,
    // 跟界面语言走。localize 传字符串原样返回, 所以老条目不用回头改。
    .map((v) => ({
      version: v,
      items: (all[v] || []).map((r) => ({ ...r, title: lang.localize(r.title), detail: lang.localize(r.detail) })),
    }))
    .filter((g) => g.items.length);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 发版说明 → 自包含 HTML。一版一节, 每条出 title + detail。
function renderUpdateHtml({ version, seenVersion, personaName, notes }) {
  const body = (notes || []).map((g) => `
    <section>
      <h2>v${esc(g.version)}<span class="n">${g.items.length}</span></h2>
      <ul>
        ${g.items.map((r) => `<li><b>${esc(r.title)}</b><p>${esc(r.detail)}</p></li>`).join('\n        ')}
      </ul>
    </section>`).join('\n');
  const fromTo = seenVersion ? `${esc(seenVersion)} → ${esc(version)}` : `v${esc(version)}`;
  // 这份 HTML 是拿给用户点开看的 → 四语跟界面语言走(文案在 config/main/update_note_bits.json)。
  const bits = cfg.json('main/update_note_bits');
  const L = (k) => cfg.fill(lang.localize(bits[k]), { name: esc(personaName), version: esc(version) });
  return `<!doctype html>
<html lang="${esc(lang.getLang() || lang.SOURCE_LANG)}"><head><meta charset="utf-8">
<title>${L('html_title')}</title>
<style>
  body{margin:0;padding:40px 20px;background:#f6f7f9;font:15px/1.75 -apple-system,"PingFang SC",sans-serif;color:#1c1f23}
  main{max-width:720px;margin:0 auto;background:#fff;border-radius:14px;padding:36px 40px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  h1{margin:0 0 4px;font-size:22px}
  .sub{margin:0 0 28px;color:#6b7280;font-size:13px}
  h2{margin:28px 0 10px;font-size:15px;color:#374151;border-bottom:1px solid #eceef1;padding-bottom:8px}
  .n{display:inline-block;margin-left:8px;padding:1px 8px;border-radius:10px;background:#eef2f7;color:#6b7280;font-size:12px;font-weight:400}
  ul{margin:0;padding:0;list-style:none}
  li{padding:12px 0;border-bottom:1px solid #f2f4f6}
  li:last-child{border-bottom:none}
  li b{display:block;font-size:14px}
  li p{margin:4px 0 0;color:#4b5563;font-size:13px}
  footer{margin-top:30px;padding-top:18px;border-top:1px solid #eceef1;color:#6b7280;font-size:12.5px}
</style></head>
<body><main>
  <h1>${L('html_h1')}</h1>
  <p class="sub">${fromTo}</p>
${body}
  <footer>${L('html_footer')}</footer>
</main></body></html>`;
}

// 发版说明 → 聊天气泡里那份 markdown(作者 2026-08-17: "不用弹窗, 用我们的模板模式显示")。
// 与 HTML 同源不同体量: 气泡只出 title, 想看每条具体怎么回事点开完整版。
function renderNotesMd(notes) {
  return (notes || [])
    .map((g) => g.items.map((r) => `- ${r.title}`).join('\n'))
    .join('\n');
}

// 落盘。一版一个文件, 同版本重开机直接覆盖(内容由差异算出, 重算即最新)。
// 返回绝对路径给调用方贴给用户点; 写不进去不算错(说明是附赠品, 不该阻断开机)。
function writeUpdateNote(dir, opts) {
  if (!opts || !(opts.notes || []).length) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `update-${opts.version}.html`);
    fs.writeFileSync(file, renderUpdateHtml(opts), 'utf8');
    return file;
  } catch (e) {
    console.error('[cap-update] 更新说明写盘失败:', e && e.message);
    return null;
  }
}

module.exports = { cmpVersion, needsUpdate, pickReleaseNotes, renderUpdateHtml, renderNotesMd, writeUpdateNote };
