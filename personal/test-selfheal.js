// test-selfheal.js — Level 1 自愈链路验证(不起 Electron/插件, 直接实例化 Butler 走真实 SDK)
// 验证: ① 正常轮次跑通 ② 沉淀卡住(hardCap 掐断) + keepContextOnSedimentFail → 在 deadline 内返回
//        ok:false 且上下文保命, _clearing settle, onCompact start/done 都发出(UI 不留假"整理中")
//        ③ 撤掉掐断后再 submit 正常(ensureStream 自动重建=自愈) ④ 沉淀失败但不保命 → 照样清空
//        ⑤ 真整理: 沉淀真写进图/便条, 会话清空, 且不再产生交接摘要。
//
// 🔴 断言的是"整理记忆·清空重启"这套语义, 不是旧的满仓 resume 出摘要:
//    成功 = sediment.ok(图或便条真长出东西) + sessionId 归零 + pendingHandoff 恒 null。
//    doCompact 现在只是 doClearWithSediment 的兼容别名, 它收不了 opts, 所以本测试直接调后者。
// 跑法: /usr/local/bin/node test-selfheal.js   (需已登录 claude)
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Butler } = require('../core/agent');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'selfheal-'));
const log = (...a) => console.log('[test]', ...a);
let failed = 0;
const assert = (cond, name) => { if (cond) log(`✅ ${name}`); else { failed++; log(`❌ ${name}`); } };

(async () => {
  const b = new Butler(HOME, { name: '自愈测试员' });
  const compactPhases = [];
  b.setCallbacks({
    onText: () => {},
    onUsage: () => {},
    onCompact: (s) => { compactPhases.push(s.phase); log(`onCompact: ${s.phase}`); },
    onResult: () => {},
  });

  // ① 正常轮次
  log('① 正常轮次: submit + 等 result …');
  const r1 = await b.askOnce('只回复两个字: 收到', 90000);
  assert(/收到/.test(r1), `正常轮次拿到回复 (${JSON.stringify(r1.slice(0, 30))})`);
  const sessBefore = b.sessionId;
  assert(!!sessBefore, `session 已建立 (${sessBefore})`);

  assert(typeof b.doCompact === 'function', 'doCompact 兼容别名还在(老触发端都还在调它)');

  // ② 沉淀掐断 + 保命: hardCap 1.5s 让沉淀那轮必定收不了尾, 走 keepContextOnSedimentFail 分支。
  //    掐的是真实的等待路径, 不靠故障开关 —— 旧的 BUTLER_FAULT=compact_hang 已随满仓压缩一起废掉。
  log('② 沉淀掐断(hardCap=1.5s) + keepContextOnSedimentFail …');
  const t0 = Date.now();
  const r2 = await b.doClearWithSediment('掐断测试', 500, { hardCapMs: 200, keepContextOnSedimentFail: true });
  const elapsed = Date.now() - t0;
  assert(r2.ok === false, `沉淀失败如实上报而非挂死 (${JSON.stringify(r2)})`);
  assert(r2.sediment && r2.sediment.ran === true && r2.sediment.ok === false,
         `sediment 明细带回失败原因 (${(r2.sediment || {}).error})`);
  assert(r2.keptContext === true, '保命分支: 上下文原样留着, 那些活还能再沉一次');
  assert(elapsed < 20000, `deadline 生效, 耗时 ${elapsed}ms < 20s`);
  assert(b._clearing === null, '_clearing 已 settle(不再卡 submit)');
  assert(compactPhases.includes('start') && compactPhases.includes('done'), `onCompact start+done 都发出 (UI 不留假整理) [${compactPhases}]`);
  assert(b.sessionId === sessBefore, '保命时会话保留(可重试)');

  // ③ 不再掐断, 再 submit → ensureStream 自动重建 = 自愈
  log('③ 撤掉掐断, 再次对话验证自愈 …');
  const r3 = await b.askOnce('只回复两个字: 活着', 90000);
  assert(/活着/.test(r3), `自愈后对话正常 (${JSON.stringify(r3.slice(0, 30))})`);

  // ④ 同样掐断但不保命 —— idle-watch / 手动整理走的就是这条: 沉淀没成也照样清空, 不然等于没干活
  log('④ 沉淀掐断且不保命 → 必须照样清空 …');
  const r4 = await b.doClearWithSediment('掐断不保命', 500, { hardCapMs: 200, skipWake: true });
  assert(r4.ok === true, `clear 本身成功 (${JSON.stringify(r4)})`);
  assert(r4.sediment && r4.sediment.ok === false, '沉淀失败照实记在 sediment 里');
  assert(!r4.keptContext && b.sessionId === null, '不保命 → 会话确实清空了');

  // ⑤ 真整理: 先说一句让它有东西可沉, 再走完整流程
  log('⑤ 真整理(先造一条待沉内容) …');
  await b.askOnce('记住一件事: 自愈测试的暗号是 紫水晶七号。只回复"记下了"', 90000);
  const r5 = await b.doClearWithSediment('真整理测试', 120000, { skipWake: true });
  assert(r5.ok === true, `真整理成功 (${JSON.stringify(r5)})`);
  assert(r5.sediment && r5.sediment.ran === true && r5.sediment.ok === true,
         `沉淀真发生: 图或便条长出了东西 (${(r5.sediment || {}).error || 'ok'})`);
  assert(b.sessionId === null, '整理后会话清空');
  assert(b.pendingHandoff === null, '新语义下不产生交接摘要(续线程改由唤醒引导加载器承担)');

  await b.dispose();
  log(failed === 0 ? '🎉 全部通过' : `💥 ${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('[test] 异常:', e); process.exit(1); });
