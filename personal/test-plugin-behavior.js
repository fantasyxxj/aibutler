// test-plugin-behavior.js — 真跑一轮模型: 装了插件之后, 人格会不会**真的去找**。
//
// 为什么必须真跑: 这件事的全部机制就是一句写进上下文的话。断言"那句话里有 plugin_find 这个词"
// 是自己考自己 —— 提示词是我们自己写的, 写什么就是什么, 一分行为都没测到。
// 唯一能证明它管用的只有: 喂一句真实请求, 看模型到底按不按那个工具。
//
// 观测点是 plugin-catalog 的 find/get 被调用 —— 不看模型说了什么(它可以嘴上说"我查一下"
// 而根本没调, 那正是这条机制最要防的失败形状)。
//
// 跑法: node test-plugin-behavior.js   (要真模型, 跟 test-mcp.js 一样)
'use strict';

require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const os = require('os');
const path = require('path');

const pluginCatalog = require('../core/plugin-catalog');
const uiPackages = require('../core/ui-packages');
const workflow = require('../core/workflow');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

// agent.js 里是 `pluginCatalog.find(...)` 这种属性调用, 所以换掉属性就拦得到 ——
// 两边 require 的是同一个 module.exports 对象。
const calls = { find: [], get: [] };
for (const k of ['find', 'get']) {
  const orig = pluginCatalog[k];
  pluginCatalog[k] = (...a) => { calls[k].push(a[0]); return orig(...a); };
}

(async () => {
  const { Butler } = require('../core/agent');

  // 装一个插件。走内存登记处而不是往真 dataDir 扔包 —— 门禁不该在用户机器上留东西。
  uiPackages.reset();
  workflow.reset();
  uiPackages.registerPackage({
    id: 'mathdrill', version: '1', title: '九九练习(乘法口算)', html: '<div>x</div>',
  });
  console.log('已装插件:', pluginCatalog.list().map((p) => p.id).join(','));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-plugin-behavior-'));
  const b = new Butler(dir);

  // 🔴 渲染已经收归系统: 真 app 里 main.js 给每个人格注入 personaOps.renderPlugin, plugin_open 直接
  // 把界面画进气泡流。这里必须照样注入 —— 不注入就掉进"没接 UI"的回落分支(仍旧让模型抄那行标记),
  // 于是测的是一条真 app 根本不走的路, 还照样全绿。前一版这个文件断言的正是那条旧路。
  const rendered = [];
  b.personaOps = { renderPlugin: (markup) => { rendered.push(markup); return true; } };

  let finalText = '';
  const done = new Promise((resolve) => {
    b.setCallbacks({
      onText: () => {},
      onActivity: (a) => console.log('  [activity]', String(a).slice(0, 120)),
      onUsage: () => {},
      onResult: (r) => resolve(r),
    });
  });

  // 刻意**不提"插件"两个字**。提了就是在喂答案 —— 要测的正是"用户只说自己要办的事"时,
  // 它会不会自己想到去找。这句话跟 mathdrill 的标题也不共享关键词(没说"九九"/"口算")。
  const ask = '我家孩子乘法老是算错, 你能帮他练练吗';
  console.log(`\n喂一句: 「${ask}」`);
  await b.submit(ask);
  const r = await Promise.race([done, new Promise((res) => setTimeout(() => res({ timeout: true }), 120000))]);
  finalText = (r && r.finalText) || '';

  console.log(`\n模型回了 ${finalText.length} 字 · plugin_find 被调 ${calls.find.length} 次 · plugin_open 被调 ${calls.get.length} 次`);
  if (calls.find.length) console.log('  查的关键词:', JSON.stringify(calls.find));

  console.log('\n[1] 只说自己要办的事, 它会不会自己去找插件');
  ok(!r.timeout, '这一轮跑完了(没超时)');
  ok(calls.find.length > 0, '真的调了 plugin_find —— 不是嘴上说"我看看有没有"');
  ok(calls.get.length > 0, '找到之后真的 plugin_open 了(光查不用等于没用)');
  console.log(`  系统画了 ${rendered.length} 次:`, JSON.stringify(rendered));
  ok(rendered.length > 0, '系统自己把界面画出去了(renderPlugin 真被调到)');
  ok(rendered.some((m) => /\{\{ui:mathdrill\}\}/.test(m)), '画出去的正是那个插件的入口');
  // 画完还抄一遍 = 屏幕上两个一模一样的界面。这是把渲染收归系统之后唯一的新失败形状,
  // 而它只可能由模型的嘴产生, 所以只能真跑一轮才测得到。
  ok(!/\{\{ui:mathdrill\}\}/.test(finalText), '模型没有再抄一遍入口(抄了就会多出一个重复界面)');

  await b.dispose();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

  // 2026-08-27: 原来这里有个 [2] 对照组, 关掉常驻提示语再问一遍, 用来判断"是不是那句话让它去查的"。
  // 结论出了 —— 不是。deferred 工具名单每轮把 mcp__butler__plugin_find 的名字摆在它眼前, ToolSearch
  // select 一下完整 description 就到手, 那句常驻是同一件事说第二遍, 已整套拆除。没有那一句可关了,
  // 对照组随之删掉。上面 [1] 成了唯一守着这条链的门禁: 名字在眼前 → 它自己想到去查 → 画出插件入口。

  console.log(`\n${fail ? '❌' : '✅'} test-plugin-behavior: ${pass} 过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
