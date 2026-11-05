// test-agent.js — 无头冒烟测: 验证 Agent SDK 复用订阅认证 + 真 usage 提取(不需 Electron)
// 跑: node test-agent.js
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const { Butler } = require('../core/agent');

(async () => {
  const b = new Butler();
  console.log('--- turn 1: 发一句话 ---');
  const r1 = await b.runTurn('用一句话确认你在, 并说你是谁。', {
    onText: (t) => process.stdout.write(t),
    onUsage: (u) => { /* 静默, 末尾看最终 */ },
  });
  console.log('\n[usage]', JSON.stringify(r1.usage));
  console.log('[model]', b.model, '| window', b.window, '| session', b.sessionId ? b.sessionId.slice(0, 8) : null);

  console.log('\n--- turn 2: 多轮(resume)看上下文涨 ---');
  const r2 = await b.runTurn('我上一句问了你什么? 一句话复述。', {
    onText: (t) => process.stdout.write(t),
  });
  console.log('\n[usage]', JSON.stringify(r2.usage));

  console.log('\n--- 手动压缩 doCompact ---');
  const c = await b.doCompact('冒烟测试');
  console.log('[compacted ok]', c.ok, '| 摘要长度', c.summary ? c.summary.length : 0);
  console.log('[压缩后 usage]', JSON.stringify(b.usage()), '| session 已重置:', b.sessionId === null);
  process.exit(0);
})().catch((e) => { console.error('SMOKE FAIL:', e); process.exit(1); });
