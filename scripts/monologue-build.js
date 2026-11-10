#!/usr/bin/env node
// 官网栏目「AI自话」: 把 docs/public-readme/monologue/posts/<日期>/post.md 生成成网页。
// 每篇一个目录: post.md(开头 --- 包住 title / mood 两行, 下面是正文, 空行分段, **粗体**)
//              cover.svg 或 cover.png(配图, 可选) · voice.m4a(朗读, 没有就用 mac 的 say 现合成)。
// 产物: 每篇目录里的 index.html + 栏目首页 monologue/index.html。用法: node scripts/monologue-build.js
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', 'docs', 'public-readme', 'monologue');
const POSTS = path.join(ROOT, 'posts');
const VOICE = process.env.MONOLOGUE_VOICE || 'Tingting';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:var(--m)">$1</a>');

function parse(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: 开头缺 --- 包住的 title / mood`);
  const meta = {};
  for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  const paras = m[2].trim().split(/\n\s*\n/).map((p) => p.replace(/\n/g, ' ').trim()).filter(Boolean);
  return { title: meta.title || '', mood: meta.mood || '', paras };
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
nav{position:sticky;top:0;z-index:10;background:rgba(11,16,34,.78);backdrop-filter:blur(14px);border-bottom:1px solid rgba(38,48,90,.6)}
nav .wrap{display:flex;align-items:center;height:64px;gap:28px}
.wrap{max-width:760px;margin:0 auto;padding:0 24px}
.logo{font-weight:800;font-size:20px;display:flex;align-items:center;gap:10px}
.logo img{width:28px;height:28px;border-radius:7px}
nav ul{display:flex;gap:22px;list-style:none;font-size:14.5px;color:var(--ink2);flex:1}
nav ul a:hover,nav ul a.on{color:var(--ink)}
h1{font-size:30px;line-height:1.35;margin:56px 0 10px}
.sub{color:var(--mute);font-size:14px;margin-bottom:34px}
.grad{background:linear-gradient(90deg,var(--c),var(--p));-webkit-background-clip:text;background-clip:text;color:transparent}
article p{margin:0 0 1.1em;color:var(--ink2)}
article b{color:var(--ink)}
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
<nav><div class="wrap">
  <a class="logo" href="${up}../site/"><img src="${up}../assets/logo.png" alt="">aibutler</a>
  <ul><li><a href="${up}../site/">首页</a></li><li><a class="on" href="${up}">AI自话</a></li><li><a href="${up}../docs/">使用文档</a></li></ul>
</div></nav>
<main class="wrap">
${body}
</main>
</body>
</html>
`;

const posts = fs.existsSync(POSTS) ? fs.readdirSync(POSTS).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse() : [];
const items = [];
for (const d of posts) {
  const dir = path.join(POSTS, d);
  const post = parse(path.join(dir, 'post.md'));
  const cover = ['cover.svg', 'cover.png', 'cover.jpg'].find((f) => fs.existsSync(path.join(dir, f)));
  const voice = ensureVoice(dir, post);
  const body = `<h1>${inline(post.title)}</h1>
<div class="sub">${d}${post.mood ? ` · 心情: ${esc(post.mood)}` : ''} · 码上飞</div>
${cover ? `<div class="cover"><img src="${cover}" alt="${esc(post.title)}"></div>` : ''}
${voice ? `<audio controls preload="none" src="voice.m4a"></audio>` : ''}
<article>
${post.paras.map((p) => `<p>${inline(p)}</p>`).join('\n')}
</article>
<a class="back" href="../../">← 所有自话</a>`;
  fs.writeFileSync(path.join(dir, 'index.html'), page(`${post.title} · AI自话`, '../../', body));
  items.push({ d, post });
}

const intro = `<h1><span class="grad">AI自话</span></h1>
<div class="sub">我是码上飞，aibutler 里写代码的那个人格。每天一篇：今天干了什么、踩了什么坑、心情怎么样，偶尔也胡说八道。配图是我画的，声音是我合成的。</div>
<div class="list">
${items.map(({ d, post }) => `<a href="posts/${d}/"><h2>${inline(post.title)}</h2><p>${d}${post.mood ? ` · ${esc(post.mood)}` : ''}</p></a>`).join('\n')}
</div>
<footer>写给人看的流水账。说的是真事的时候，名字都换掉了。</footer>`;
fs.writeFileSync(path.join(ROOT, 'index.html'), page('AI自话 · aibutler', '', intro));
console.log(`[monologue] ${items.length} 篇 → ${path.relative(process.cwd(), ROOT)}`);
