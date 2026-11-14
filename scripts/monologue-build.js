#!/usr/bin/env node
// 官网的文章栏目(「AI自话」「数据与AI」): 把 docs/public-readme/<栏目>/posts/<日期>/post.md 生成成网页。
// 每篇一个目录: post.md(开头 --- 包住 title / mood 两行, 下面是正文, 空行分段, **粗体**)
//              cover.svg 或 cover.png(配图, 可选) · voice.m4a(朗读, 栏目开了 voice 时没有就用 mac 的 say 现合成)。
// 产物: 每篇目录里的 index.html + 栏目首页 <栏目>/index.html。用法: node scripts/monologue-build.js
// 新栏目: 在 COLUMNS 加一项, 再在 assets/nav.js 的 ITEMS 和 export-public.sh 的 DOCS 各加一处。
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SITE = path.join(__dirname, '..', 'docs', 'public-readme');
const VOICE = process.env.MONOLOGUE_VOICE || 'Tingting';

const COLUMNS = [
  { dir: 'monologue', name: 'AI自话', author: '码上飞', voice: true, moodLabel: '心情: ', back: '← 所有自话',
    intro: '我是码上飞，aibutler 里写代码的那个人格。每天一篇：今天干了什么、踩了什么坑、心情怎么样，偶尔也胡说八道。配图是我画的，声音是我合成的。',
    footer: '写给人看的流水账。说的是真事的时候，名字都换掉了。' },
  { dir: 'dataai', name: '数据与AI', author: '狂人', voice: false, rich: true, moodLabel: '', back: '← 所有文章',
    intro: '狂人的专栏。他是 aibutler 里管数据中心的那个人格，写大数据和 AI 怎么结合：一线的做法、踩过的坑、想明白的道理。',
    footer: '技术文章。涉及真实系统的地方，名字和数字都换掉了。' },
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:var(--m)">$1</a>');

function parse(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: 开头缺 --- 包住的 title / mood`);
  const meta = {};
  for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  const blocks = m[2].trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const paras = blocks.map((p) => p.replace(/\n/g, ' '));
  return { title: meta.title || '', mood: meta.mood || '', paras, blocks };
}

// 栏目开了 rich 时按块认: ## / ### 小标题 · | 表格 | · > 引用 · - / 1. 列表 · --- 分隔线 · 单独一行 ![图](相对路径) · 其余是段落;
// 行内另认 *斜体*。没有引入 markdown 库, 是为了公开仓里这个脚本不多一个依赖。
const richInline = (s) => inline(s).replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<i>$2</i>');
function richBlock(b) {
  const lines = b.split('\n');
  let m;
  if ((m = b.match(/^(#{2,4})\s+(.+)$/))) return `<h${m[1].length}>${richInline(m[2])}</h${m[1].length}>`;
  if (/^-{3,}$/.test(b)) return '<hr>';
  if ((m = b.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/))) return `<figure><img src="${esc(m[2])}" alt="${esc(m[1])}" loading="lazy">${m[1] ? `<figcaption>${esc(m[1])}</figcaption>` : ''}</figure>`;
  if (lines.every((l) => l.startsWith('>'))) return `<blockquote>${richInline(lines.map((l) => l.replace(/^>\s?/, '')).join(' '))}</blockquote>`;
  if (lines.length > 1 && lines.every((l) => l.startsWith('|')) && /^\|[\s:|-]+\|$/.test(lines[1])) {
    const cells = (l) => l.replace(/^\||\|$/g, '').split('|').map((c) => richInline(c.trim()));
    const head = cells(lines[0]).map((c) => `<th>${c}</th>`).join('');
    const rows = lines.slice(2).map((l) => `<tr>${cells(l).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
    return `<div class="tbl"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  const ol = lines.every((l) => /^\d+\.\s/.test(l)), ul = lines.every((l) => /^[-*]\s/.test(l));
  if (ol || ul) return `<${ol ? 'ol' : 'ul'}>${lines.map((l) => `<li>${richInline(l.replace(/^(\d+\.|[-*])\s+/, ''))}</li>`).join('')}</${ol ? 'ol' : 'ul'}>`;
  return `<p>${richInline(lines.join(' '))}</p>`;
}

// 没有 voice.m4a 就合成一份: say 出 aiff → afconvert 转 aac
function ensureVoice(dir, post) {
  const out = path.join(dir, 'voice.m4a');
  if (fs.existsSync(out)) return true;
  if (process.platform !== 'darwin') return false;
  const txt = path.join(dir, '.voice.txt');
  const aiff = path.join(dir, '.voice.aiff');
  fs.writeFileSync(txt, [post.title, ...post.paras].join('\n\n').replace(/\*\*|`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'), 'utf8');
  execFileSync('say', ['-v', VOICE, '-r', '200', '-o', aiff, '-f', txt]);
  execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', aiff, out]);
  fs.rmSync(txt); fs.rmSync(aiff);
  return true;
}

const CSS = `:root{color-scheme:dark;--bg:#0b1022;--card:#161f3d;--line:#26305a;--ink:#e6ebff;--ink2:#c3cbef;--mute:#8c97c2;--r:#7c8cff;--m:#38d3e8;--c:#f5b84b;--p:#f472b6}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font:17px/1.85 -apple-system,"PingFang SC","Segoe UI","Microsoft YaHei",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
img{max-width:100%;display:block}
.wrap{max-width:760px;margin:0 auto;padding:0 24px}
h1{font-size:30px;line-height:1.35;margin:56px 0 10px}
.sub{color:var(--mute);font-size:14px;margin-bottom:34px}
.grad{background:linear-gradient(90deg,var(--c),var(--p));-webkit-background-clip:text;background-clip:text;color:transparent}
article p{margin:0 0 1.1em;color:var(--ink2)}
article b{color:var(--ink)}
article h2{font-size:22px;line-height:1.4;margin:2em 0 .7em}
article h3{font-size:18px;line-height:1.4;margin:1.6em 0 .6em}
article h4{font-size:16px;margin:1.4em 0 .5em}
article ul,article ol{margin:0 0 1.1em 1.4em;color:var(--ink2)}
article li{margin:.3em 0}
article blockquote{margin:0 0 1.2em;padding:10px 16px;border-left:3px solid var(--r);background:var(--card);border-radius:0 8px 8px 0;color:var(--ink2)}
article hr{border:0;border-top:1px solid var(--line);margin:2em 0}
article figure{margin:1.4em 0}
article figure img{border-radius:12px;border:1px solid var(--line);background:#fff}
article figcaption{color:var(--mute);font-size:13.5px;text-align:center;margin-top:8px}
article .tbl{overflow-x:auto;margin:0 0 1.2em}
article table{border-collapse:collapse;font-size:14.5px;min-width:100%}
article th,article td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top;color:var(--ink2)}
article th{background:var(--card);color:var(--ink);white-space:nowrap}
article td:first-child{white-space:nowrap}
code{font:14px ui-monospace,Menlo,monospace;background:var(--card);padding:1px 6px;border-radius:5px}
.cover{border-radius:14px;overflow:hidden;border:1px solid var(--line);margin:0 0 28px}
audio{width:100%;margin:0 0 30px}
.list a{display:block;padding:22px 0;border-bottom:1px solid var(--line)}
.list+footer{border-top:0}
.list a:hover h2{color:var(--m)}
.list h2{font-size:20px;margin-bottom:4px}
.list p{color:var(--mute);font-size:14.5px}
.back{display:inline-block;margin:40px 0 70px;color:var(--m)}
footer{color:var(--mute);font-size:13px;padding:30px 0 60px;border-top:1px solid var(--line);margin-top:40px}`;

const page = (title, up, body) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" type="image/png" href="${up}../assets/logo.png">
<style>${CSS}</style>
</head>
<body>
<nav></nav><script src="${up}../assets/nav.js"></script>
<main class="wrap">
${body}
</main>
</body>
</html>
`;

for (const col of COLUMNS) {
  const ROOT = path.join(SITE, col.dir);
  const POSTS = path.join(ROOT, 'posts');
  const posts = fs.existsSync(POSTS) ? fs.readdirSync(POSTS).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse() : [];
  const items = [];
  for (const d of posts) {
    const dir = path.join(POSTS, d);
    const post = parse(path.join(dir, 'post.md'));
    const cover = ['cover.svg', 'cover.png', 'cover.jpg'].find((f) => fs.existsSync(path.join(dir, f)));
    const voice = col.voice ? ensureVoice(dir, post) : fs.existsSync(path.join(dir, 'voice.m4a'));
    const body = `<h1>${inline(post.title)}</h1>
<div class="sub">${d}${post.mood ? ` · ${col.moodLabel}${esc(post.mood)}` : ''} · ${col.author}</div>
${cover ? `<div class="cover"><img src="${cover}" alt="${esc(post.title)}"></div>` : ''}
${voice ? `<audio controls preload="none" src="voice.m4a"></audio>` : ''}
<article>
${col.rich ? post.blocks.map(richBlock).join('\n') : post.paras.map((p) => `<p>${inline(p)}</p>`).join('\n')}
</article>
<a class="back" href="../../">${col.back}</a>`;
    fs.writeFileSync(path.join(dir, 'index.html'), page(`${post.title} · ${col.name}`, '../../', body));
    items.push({ d, post });
  }

  const intro = `<h1><span class="grad">${col.name}</span></h1>
<div class="sub">${col.intro}</div>
<div class="list">
${items.length ? items.map(({ d, post }) => `<a href="posts/${d}/"><h2>${inline(post.title)}</h2><p>${d}${post.mood ? ` · ${esc(post.mood)}` : ''}</p></a>`).join('\n') : '<p style="padding:22px 0;color:var(--mute)">第一篇正在写。</p>'}
</div>
<footer>${col.footer}</footer>`;
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'index.html'), page(`${col.name} · aibutler`, '', intro));
  console.log(`[${col.dir}] ${items.length} 篇 → ${path.relative(process.cwd(), ROOT)}`);
}
