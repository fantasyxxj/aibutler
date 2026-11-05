// test-persist.js — 测: 持久化存/载 + 恢复后 resume 续上 + 图片多模态路径
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const { Butler } = require('../core/agent');
const store = require('../core/chat-store');

const PNG1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

(async () => {
  // 1) 第一个"会话": 发一轮, 记一个只有对话里才知道的暗号
  const b1 = new Butler();
  await b1.runTurn('记住暗号: 紫水晶42。记住了回一个字"好"。', { onText: (t) => process.stdout.write(t) });
  console.log('\n[b1 usage]', JSON.stringify(b1.usage()), 'session', b1.sessionId && b1.sessionId.slice(0, 8));

  // 2) 存盘(模拟关窗口)
  const state = { ...b1.exportState(), messages: [{ role: 'user', text: '记住暗号: 紫水晶42' }] };
  store.save(state);
  console.log('[saved]', store.STATE_FILE);

  // 3) 新 Butler 从盘恢复(模拟重开 app) → resume 上个 session → 问暗号
  const loaded = store.load();
  const b2 = new Butler();
  b2.restore(loaded);
  console.log('[restored] session', b2.sessionId && b2.sessionId.slice(0, 8), '| window', b2.window);
  process.stdout.write('[b2 答暗号] ');
  const r = await b2.runTurn('我刚才让你记的暗号是什么?', { onText: (t) => process.stdout.write(t) });
  console.log('\n[b2 usage]', JSON.stringify(b2.usage()));

  // 4) 图片多模态路径: buildPrompt 应返回 async iterable; 跑一轮真图不崩
  const p = b2.buildPrompt('这是什么颜色的图?', [{ mediaType: 'image/png', base64: PNG1x1 }]);
  console.log('[buildPrompt with img] isAsyncIterable:', typeof p[Symbol.asyncIterator] === 'function');
  process.stdout.write('[图片轮] ');
  const b3 = new Butler();
  const ri = await b3.runTurn('用一句话描述这张图(很小的图)。', {
    attachments: [{ mediaType: 'image/png', base64: PNG1x1 }],
    onText: (t) => process.stdout.write(t),
  });
  console.log('\n[图片轮 ok] usage', JSON.stringify(b3.usage()));
  process.exit(0);
})().catch((e) => { console.error('\nTEST FAIL:', e); process.exit(1); });
