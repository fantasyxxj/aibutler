// test-markdown.js — md.js 的纯渲染门禁(不碰 DOM、不碰 widgets 的那一半)。
// 跑法: node test-markdown.js
//
// 从 test-widgets.js 拆出来的: 那边是"在真 DOM 里按下去发生了什么", 要 jsdom;
// 这边只是"文本进、HTML 出", 造个最小 window 就够。两件事混在一个文件里, 结果是
// test-widgets.js 长到 587 行撞了 500 行上限, 连补一条断言都加不进去。
//
// 行业版对应的是 industry/test/test-markdown.js。两版 md.js 是各自的副本, 所以
// 同一个坑要在两边各守一次 —— 一边改另一边不改, 是最难发现的那类坏法。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}`); fail++; }
};

const sandbox = { window: { MD_I18N: { diagram_rendering: '正在画…', open_file: '点击打开:' } } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'renderer', 'md.js'), 'utf8'), sandbox);
const renderMarkdown = sandbox.window.renderMarkdown;

console.log('\n[1] md 层: 控件躲开表格切列和行内 markdown');
{
  const html = renderMarkdown('| 项 | 值 |\n|---|---|\n| 距离 | {{in:km|type=number}} |');
  ok(html.includes('<table>'), '表格照常渲染');
  ok(html.includes('data-kind="in" data-spec="km|type=number"'),
     '单元格里的控件没被 | 当列分隔符切碎(抠占位排在表格解析之前)');
  ok((html.match(/<td>/g) || []).length === 2, '那一行仍是两列(控件里的 | 没多切出一列)');
  ok(renderMarkdown('```\n{{in:x}}\n```').includes('{{in:x}}'), '代码块里的写法保持成给人看的文本');
  // 模型会把正文第一行挤在开围栏那一行。认不出来的话 ``` 会当普通字符漏到用户屏幕上(行业版实际漏过)。
  const packed = renderMarkdown('```- 第一行正文\n- 第二行\n```');
  ok(!packed.includes('```'), '🔴 开围栏后跟着非语言名时, 反引号不许漏到屏幕上');
  ok(packed.includes('<pre><code>') && packed.includes('第一行正文'),
     '挤在围栏那行的正文当第一行留住, 不当 info string 丢掉');
}

console.log('\n[2] md 层: 下划线不参与强调(作者 2026-08-17, 故意偏离 CommonMark)');
{
  // 正文遍地是 memory_upsert / feedback_xxx_yyy / __init__ 这类标识符。CommonMark 认 _斜_ 和 __粗__,
  // 于是标识符会被吃成 <em>/<strong> —— 断成两截且下划线本身消失。这里锁住"只认星号"。
  for (const src of ['_internal_name 开头', '节点 _abc_ 被引用', '__init__ 是构造函数',
                     'memory_upsert 和 memory_query', 'feedback_release_notes_only_what_user_can_feel']) {
    const out = renderMarkdown(src);
    ok(!/<em>|<strong>/.test(out), `下划线没被当强调: ${src}`);
    ok(out.includes(src.split(' ')[0]), `标识符原样保留: ${src.split(' ')[0]}`);
  }
  const star = renderMarkdown('*斜* 和 **粗**');
  ok(/<em>斜<\/em>/.test(star) && /<strong>粗<\/strong>/.test(star), '星号写法照常有效');
}

console.log('\n[3] 加粗/斜体包着的链接仍然点得动');
{
  // AI 爱写 **https://…**。星号既不是空白也不是标点, 不放进前缀集合的话整条 URL 不匹配,
  // 等 ** 变成 <strong> 就成了点不动的黑体死链(2026-08-29 行业版实机发现, 两版同源同病)。
  const boldLink = renderMarkdown('**https://example.com/a**');
  ok(/<strong>/.test(boldLink), '🔴 加粗的链接: 粗体还在');
  ok(/<a href="https:\/\/example\.com\/a"/.test(boldLink), '🔴 加粗的链接: 仍然点得动');
  ok(!/example\.com\/a\*/.test(boldLink), '🔴 加粗的链接: 星号没被吃进 URL');
  const emLink = renderMarkdown('*https://example.com/b*');
  ok(/<em>/.test(emLink) && /<a href="https:\/\/example\.com\/b"/.test(emLink), '斜体的链接也点得动');
  const inBold = renderMarkdown('**看 https://example.com/c 这里**');
  ok(/<strong>/.test(inBold) && /<a href="https:\/\/example\.com\/c"/.test(inBold), '粗体中间夹的 URL 也点得动');
  // 回归: 裸 URL 和尾随句读的老行为不能被上面的改动带坏
  ok(/<a href="https:\/\/example\.com\/d"/.test(renderMarkdown('见 https://example.com/d 这里')), '裸 URL 照常成链');
  const dot = renderMarkdown('见 https://example.com/e。');
  ok(/<a href="https:\/\/example\.com\/e"/.test(dot) && /<\/a>。/.test(dot), '尾随句号吐回正文, 不被吃进链接');
  ok(!/filepath/.test(renderMarkdown('见 https://example.com/f')), 'https:// 的 "s:/" 不被当成盘符路径');
  // URL 修了, 路径这条当时漏了(2026-09-11 作者实机发现): **/Users/…** 同样是点不动的黑体死链
  const boldPath = renderMarkdown('**/Users/me/a.html**');
  ok(/<strong>/.test(boldPath), '🔴 加粗的路径: 粗体还在');
  ok(/data-path="\/Users\/me\/a\.html"/.test(boldPath), '🔴 加粗的路径: 仍然点得动');
  ok(!/a\.html\*/.test(boldPath), '🔴 加粗的路径: 星号没被吃进路径');
  ok(/data-path="~\/note\.md"/.test(renderMarkdown('**~/note.md**')), '加粗的 ~/ 路径也点得动');
  const inBoldPath = renderMarkdown('**看 /Users/me/b.txt 这里**');
  ok(/<strong>/.test(inBoldPath) && /data-path="\/Users\/me\/b\.txt"/.test(inBoldPath), '粗体中间夹的路径也点得动');
  const zhPath = renderMarkdown('/Users/me/工作报告_L2_周报.md');
  ok(/data-path="\/Users\/me\/工作报告_L2_周报\.md"/.test(zhPath), '回归: 路径里的下划线不被当斜体');
}

console.log(`\n${fail ? '❌' : '✅'} test-markdown: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
