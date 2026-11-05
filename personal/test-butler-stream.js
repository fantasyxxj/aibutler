// test-butler-stream.js — 无头验证新 Butler(持久流式 + 插话 + 压缩)
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const { Butler } = require('../core/agent');

(async () => {
  const b = new Butler();

  console.log('===== 轮1 =====');
  const r1 = await b.runTurn('一句话: 1+1 等于几?', { onText: (t) => process.stdout.write(t) });
  console.log(`\n  usage=${r1.usage.pct}% interrupted=${r1.interrupted} model=${b.model} win=${b.window}`);

  console.log('\n===== 轮2 (同一持久流) =====');
  const r2 = await b.runTurn('一句话: 我上一句问了啥?', { onText: (t) => process.stdout.write(t) });
  console.log(`\n  usage=${r2.usage.pct}% interrupted=${r2.interrupted}`);

  console.log('\n===== 插话打断 =====');
  const pA = b.runTurn('用 Bash sleep 2 五次(各一条命令), 报数 1到5。', { onText: (t) => process.stdout.write('[A]' + t) });
  await new Promise((r) => setTimeout(r, 3000));
  console.log('\n  >>> 中途插话 B: 改问猫的英文');
  const pB = b.runTurn('别管上面了。一句话: 猫用英文怎么说?', { onText: (t) => process.stdout.write('[B]' + t) });
  const [rA, rB] = await Promise.all([pA, pB]);
  console.log(`\n  A.interrupted=${rA.interrupted}  B.interrupted=${rB.interrupted}  B答="${(rB.finalText || '').slice(0, 30)}"`);

  console.log('\n===== 压缩 =====');
  const c = await b.doCompact('冒烟');
  console.log(`  ok=${c.ok} 摘要=${c.summary ? c.summary.length : 0}字 session重置=${b.sessionId === null} usage=${b.usage().pct}%`);

  console.log('\n===== 压缩后续接(重建流 + 交接摘要) =====');
  const r3 = await b.runTurn('一句话: 你还在吗?', { onText: (t) => process.stdout.write(t) });
  console.log(`\n  usage=${r3.usage.pct}% interrupted=${r3.interrupted}`);

  const ok = !r1.interrupted && !r2.interrupted && rA.interrupted && !rB.interrupted && c.ok && !r3.interrupted;
  console.log(`\n${ok ? '✅ 全部通过' : '⚠️ 有异常, 看上面'}`);
  process.exit(ok ? 0 : 2);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
