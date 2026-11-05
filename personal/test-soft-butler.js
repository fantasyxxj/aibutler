// test-soft-butler.js — 无头验证软模型: setCallbacks + submit(不打断) + 软插话 + 压缩
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const { Butler } = require('../core/agent');

(async () => {
  const b = new Butler();
  let onResultCb = null;
  b.setCallbacks({
    onText: (t) => process.stdout.write(t),
    onUsage: () => {},
    onResult: (r) => { if (onResultCb) { const f = onResultCb; onResultCb = null; f(r); } },
  });
  const nextResult = () => new Promise((res) => { onResultCb = res; });

  console.log('=== 轮1 ===');
  let p = nextResult(); await b.submit('一句话: 1+1 等于几?'); const r1 = await p;
  console.log(`\n  r1="${(r1.finalText || '').slice(0, 20)}" busy=${b.isRunning()}`);

  console.log('\n=== 轮2 (同持久流) ===');
  p = nextResult(); await b.submit('一句话: 我上一句问了啥?'); const r2 = await p;
  console.log(`\n  r2="${(r2.finalText || '').slice(0, 30)}"`);

  console.log('\n=== 软插话(不打断) ===');
  p = nextResult();
  await b.submit('用 Bash 依次 sleep 1 五次(各一条命令), 每次完只输出一个数字 1到5, 别一条命令搞定。');
  await new Promise((r) => setTimeout(r, 2500));
  console.log('\n  >>> 软插话: 停, 改成只回一个词 DOG');
  await b.submit('停! 忽略数数。只回一个词: DOG');
  const r3 = await p;
  console.log(`\n  r3.finalText="${(r3.finalText || '').slice(0, 50)}" interrupted=${r3.interrupted}`);

  console.log('\n=== 压缩 ===');
  const c = await b.doCompact('测试');
  console.log(`  ok=${c.ok} 摘要=${c.summary ? c.summary.length : 0} reset=${b.sessionId === null}`);

  console.log('\n=== 压缩后续接 ===');
  p = nextResult(); await b.submit('一句话: 你还在吗?'); const r4 = await p;
  console.log(`\n  r4="${(r4.finalText || '').slice(0, 20)}"`);

  const softOk = /DOG/i.test(r3.finalText || '');
  console.log(`\n${softOk && c.ok && r4.finalText ? '✅ 软插话+压缩+续接 全通过' : '⚠️ 检查上面'} (软插话改道=${softOk})`);
  process.exit(softOk && c.ok ? 0 : 2);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
