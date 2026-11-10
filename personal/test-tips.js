// test-tips.js — 启动小贴士(renderer/tips.js): 四语条目齐、每条有图有示例、每页都有那句「直接问你的人格」,
// 没人格 / 关了不弹, 第一次固定第 1 条, 接线(主窗口载入 · IPC · 系统设置开关)都在。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const R = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

function load(butler) {
  const listeners = {};
  const win = { butler, addEventListener: (ev, fn) => { listeners[ev] = fn; } };
  const shown = [];
  const doc = { getElementById: () => null };
  vm.runInNewContext(R('renderer/tips.js'), { window: win, document: doc, console });
  win.tips.show = (at) => shown.push(at);   // 只看 maybeShow 的决定, 不画 DOM
  return { win, shown, listeners };
}

(async () => {
  const { win } = load({});
  const { T, ART } = win.tips;
  ok(ART.length === 8, `8 张插画(${ART.length})`);
  for (const lang of ['zh-CN', 'zh-TW', 'en', 'ja']) {
    const P = T[lang];
    ok(P && P.tips.length === ART.length, `${lang}: 条数和插画一样多`);
    ok(P && P.tips.every((x) => x.length === 3 && x.every((s) => typeof s === 'string' && s.trim())), `${lang}: 每条都有标题 · 说明 · 示例`);
    ok(P && P.ask && P.tryIt && P.next && P.close && P.never, `${lang}: 固定那句和按钮文案齐`);
  }
  ok(/直接问你的人格/.test(T['zh-CN'].ask), '固定那句讲的是「直接问你的人格」');

  // maybeShow 的决定: 没人格不弹 · 关了不弹 · 第一次固定第 1 条并记已看 · 之后随机
  const run = async (personas, st) => {
    const set = [];
    const b = { listPersonas: async () => ({ personas }), getTips: async () => st, setTips: async (p) => { set.push(p); return { ok: true }; }, getLocale: async () => ({ locale: 'zh-CN' }) };
    // load() 里换掉的 show 只在 window.tips 上, maybeShow 闭包调的是原 show —— 换成拦截 document.body
    let painted = 0;
    const ctx = { window: { butler: b, addEventListener() {} }, console,
      document: { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({ set innerHTML(_) {}, querySelector: () => ({ addEventListener() {}, set textContent(_) {}, set innerHTML(_) {}, set title(_) {} }), addEventListener() {} }), body: { appendChild: () => { painted++; } }, addEventListener() {} } };
    vm.runInNewContext(R('renderer/tips.js'), ctx);
    await ctx.window.tips.maybeShow();
    return { painted, set };
  };
  let r = await run([], { on: true, seen: false });
  ok(r.painted === 0, '没人格(空状态屏)不弹');
  r = await run([{ id: 'a' }], { on: false, seen: true });
  ok(r.painted === 0, '勾了以后不再显示就不弹');
  r = await run([{ id: 'a' }], { on: true, seen: false });
  ok(r.painted === 1 && r.set.some((p) => p.seen === true), '第一次弹, 并记下看过');
  r = await run([{ id: 'a' }], { on: true, seen: true });
  ok(r.painted === 1 && !r.set.length, '之后照常弹');

  const src = R('renderer/tips.js');
  ok(/show\(st\.seen \? undefined : 0\)/.test(src), '第一次固定第 1 条, 之后随机');
  ok(/getElementById\('input'\)/.test(src) && !/send\(/.test(src), '「试试」只填输入框, 不替用户发');
  ok(/<script src="tips\.js"><\/script>/.test(R('renderer/index.html')), '主窗口载入 tips.js');
  const ipc = R('theme-ipc.js');
  ok(/'get-tips'/.test(ipc) && /'set-tips'/.test(ipc) && /'show-tips'/.test(ipc), '主进程有 get/set/show-tips');
  ok(/id="tips-on"/.test(R('renderer/settings.html')) && /id="tips-now"/.test(R('renderer/settings.html')) && /showTips\(/.test(R('renderer/settings-ui.js')), '系统设置「通用」有开关和「现在看一条」');

  console.log(`\n${fail ? '❌' : '✅'} test-tips: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
