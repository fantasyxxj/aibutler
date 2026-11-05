// test-capability-update.js — 版本比较 + 用户侧更新说明渲染。
// 老版本这里卡的是"每发一版必须有 docs/capability_updates/<版本>.md", 那条通道 2026-08-17 已删:
// 给 AI 的一路走出厂知识包同步, 给用户的一路由真实差异渲染 HTML, 都不再需要手写第二份散文。
'use strict';

require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cu = require('../core/capability-update');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log('  ✓', name); }
  catch (e) { fail += 1; console.error('  ✗', name, '\n   ', e.message); }
}

console.log('版本比较');
t('三段数字比大小', () => {
  assert.strictEqual(cu.cmpVersion('0.0.47', '0.0.48'), -1);
  assert.strictEqual(cu.cmpVersion('0.1.0', '0.0.99'), 1);
  assert.strictEqual(cu.cmpVersion('1.0.0', '1.0.0'), 0);
});
t('缺段/非数字段按 0', () => {
  assert.strictEqual(cu.cmpVersion('1', '1.0.0'), 0);
  assert.strictEqual(cu.cmpVersion('', '0.0.1'), -1);
});
t('needsUpdate: 没补过 / 落后 / 已最新', () => {
  assert.ok(cu.needsUpdate('', '0.0.58'));
  assert.ok(cu.needsUpdate('0.0.57', '0.0.58'));
  assert.ok(!cu.needsUpdate('0.0.58', '0.0.58'));
  assert.ok(!cu.needsUpdate('0.0.59', '0.0.58'));
});

console.log('用户侧更新说明');
const NOTES = [
  { version: '0.0.53', items: [{ title: '会画按钮了', detail: '要你选一下的时候直接给控件。' }] },
  { version: '0.0.58', items: [{ title: '升级后自己收拾记忆', detail: '不用你管。' }] },
];

t('一版一段, title 和 detail 都出现', () => {
  const html = cu.renderUpdateHtml({ version: '0.0.58', seenVersion: '0.0.52', personaName: '棒头', notes: NOTES });
  for (const g of NOTES) {
    assert.ok(html.includes('v' + g.version), `缺版本段 ${g.version}`);
    for (const r of g.items) {
      assert.ok(html.includes(r.title), `缺 ${r.title}`);
      assert.ok(html.includes(r.detail), `缺 ${r.detail}`);
    }
  }
});

t('只讲用户能感觉到的, 出厂命题的内部名不出现', () => {
  const html = cu.renderUpdateHtml({ version: '0.0.58', personaName: '棒头', notes: NOTES });
  assert.ok(!/feedback_|reference_/.test(html), '内部 slug 漏进了用户侧');
});

t('区间取版本: 跨版带齐中间每一版, 首装不倒背历史', () => {
  const spanned = cu.pickReleaseNotes('0.0.52', '0.0.58').map((g) => g.version);
  assert.ok(spanned.length > 1, '跨多版应带齐中间版本, 实得: ' + spanned.join(','));
  assert.ok(!spanned.includes('0.0.52'), '用户见过的那版不该再讲一遍');
  assert.deepStrictEqual(cu.pickReleaseNotes('', '0.0.58'), [], '首装不该推历史版本说明');
});

t('HTML 转义: 文案里的尖括号不破坏结构', () => {
  const html = cu.renderUpdateHtml({
    version: '0.0.58', personaName: '棒头',
    notes: [{ version: '0.0.58', items: [{ title: '<script>x</script>', detail: 'a & b < c' }] }],
  });
  assert.ok(!html.includes('<script>x</script>'), '尖括号没转义');
  assert.ok(html.includes('&amp;'), '& 没转义');
});

t('自包含: 没有外链 css/js', () => {
  const html = cu.renderUpdateHtml({ version: '0.0.58', personaName: '棒头', notes: NOTES });
  assert.ok(!/<link[^>]+href=/i.test(html));
  assert.ok(!/<script[^>]+src=/i.test(html));
});

t('落盘: 文件名带版本号, 内容可读', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capupd-'));
  const file = cu.writeUpdateNote(dir, { version: '0.0.58', personaName: '棒头', notes: NOTES });
  assert.ok(file && file.endsWith('update-0.0.58.html'), '文件名不对: ' + file);
  assert.ok(fs.readFileSync(file, 'utf8').includes('会画按钮了'));
  fs.rmSync(dir, { recursive: true, force: true });
});

t('这版用户无感就不落盘(没什么可说就别烦用户)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capupd-'));
  assert.strictEqual(cu.writeUpdateNote(dir, { version: '0.0.58', personaName: '棒头', notes: [] }), null);
  assert.strictEqual(fs.readdirSync(dir).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

t('出厂命题不再流进用户说明(96 条行为准则是给 AI 的)', () => {
  const all = require('./config-loader').json('main/release_notes');
  for (const [v, items] of Object.entries(all)) {
    if (v.startsWith('_')) continue;
    for (const r of items) {
      assert.ok(r.title && r.detail, `${v} 有条目缺 title/detail`);
      assert.ok(!/记忆图|upsert|slug|出厂包|命题/.test(r.title), `${v} 的 title 讲了内部实现: ${r.title}`);
    }
  }
});

t('老通道确实删干净了(目录/模板/paths 入口都不该还在)', () => {
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'docs', 'capability_updates')), 'docs/capability_updates 还在');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'core', 'config', 'wake', 'capability_update.md')), 'wake 模板还在');
  assert.strictEqual(typeof require('./paths').capabilityUpdatesDir, 'undefined', 'paths 还导出 capabilityUpdatesDir');
  const pkg = require('../package.json');
  for (const plat of Object.keys(pkg.build || {})) {
    const res = (pkg.build[plat] || {}).extraResources || [];
    assert.ok(!res.some((x) => x.from === 'docs/capability_updates'), `${plat} 还在打包 capability_updates`);
  }
});

console.log(`\n${pass} 过 / ${fail} 红`);
process.exit(fail ? 1 : 0);
