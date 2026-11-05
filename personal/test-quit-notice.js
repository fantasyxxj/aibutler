// test-quit-notice.js — 退出遮罩上那条通知: 判死之后不许再说"没存下来"就把用户拦住。
//
// 病因(2026-09-24 实测): 沉淀看门狗判死之后, 人格**照样把记忆写完了** —— CLI 侧的 jsonl 有回话,
// butler 侧从某刻起零落盘。停的不是它的活, 是 butler 自己的耳朵。而当时的界面是一个同步阻塞的
// 二选一框, 说的是"没存下来", 于是: ① 它撒了谎 ② 后台真写完了也没人能替用户把框收掉。
//
// 这份门禁守三件事:
//   ① 判死之后要接着看, 它自己停手 = 活干完了 = 通知自己收掉(settled), 不用用户点任何东西
//   ② 用户永远有出口: 强制关闭(force) / 先别关(cancel), 两条都不许被后台等待吞掉
//   ③ 等待没有超时 —— "等多久算死"正是判错过的那件事, 不许再引入第二个计时器来重犯
'use strict';
const fs = require('fs');
const path = require('path');

const QS = require('./quit-sediment');
const { waitUntilSettled, noticeAndWait, answerQuitNotice } = QS;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// 假人格: waitUntilSettled 只看 isRunning(), 进度只看 _lastToolName / _turnMemoryWrites
const mk = (sid, name, running, extra = {}) => ({
  sid, name,
  s: { butler: { isRunning: () => running.v, _lastToolName: extra.tool || '', _turnMemoryWrites: extra.memWrites || 0 } },
});

(async () => {
  console.log('\n[1] 都停手了 → 当场收工, 不用等');
  {
    const r = await waitUntilSettled([mk('a', '甲', { v: false })]);
    ok(r.done === true, '没人在跑 → done');
  }

  console.log('\n[2] 🔴 判死之后接着等: 它还在写就不返回, 写完自己收掉');
  {
    const running = { v: true };
    const items = [mk('a', '甲', running, { memWrites: 2, tool: 'memory_upsert' })];
    let settled = 'NOT_YET';
    const ticks = [];
    const p = waitUntilSettled(items, { onTick: (b) => ticks.push(b) }).then((r) => { settled = r; });
    await tick(120);
    ok(settled === 'NOT_YET', '它还在写的时候, 等待不返回(不许当场宣布失败)');
    ok(ticks.length > 0 && ticks[0][0].memWrites === 2 && ticks[0][0].tool === 'memory_upsert',
       '🔴 等待期间把"它正在干什么"报出去了 —— 不报的话界面上就是个不动的框, 和死机一样');
    running.v = false;            // 后台写完了
    await p;
    ok(settled && settled.done === true, '🔴 它自己停手 → 等待结束(这就是通知被后台收掉的那一刻)');
  }

  console.log('\n[3] 用户等不及: shouldStop 一成立就让路, 不许被后台等待吞掉');
  {
    const running = { v: true };   // 一直在跑, 只能靠 shouldStop 出来
    let stop = false;
    const p = waitUntilSettled([mk('a', '甲', running)], { shouldStop: () => stop });
    await tick(60);
    stop = true;
    const r = await p;
    ok(r.done === false && r.forced === true, 'shouldStop → forced 出口');
  }

  console.log('\n[4] noticeAndWait 三个出口');
  {
    // 4a 后台自己干完 → settled
    const running = { v: true };
    const sent = [];
    const p = noticeAndWait([{ x: mk('a', '甲', running), r: { ok: false, error: '判定卡住' } }],
                            (d) => sent.push(d));
    await tick(60);
    ok(sent.some(d => d.phase === 'notice'), '先把通知发上屏');
    ok(sent.find(d => d.phase === 'notice').failed[0].error === '判定卡住', '通知里带着真实原因');
    ok(sent.some(d => d.phase === 'notice-alive'), '通知挂着期间持续报活体信号');
    running.v = false;
    ok(await p === 'settled', '🔴 后台写完 → settled(界面上那条通知自己消失, 用户什么都没点)');
  }
  {
    // 4b 用户按强制关闭 → force
    const running = { v: true };
    const p = noticeAndWait([{ x: mk('a', '甲', running), r: { ok: false, error: 'x' } }], () => {});
    await tick(40);
    answerQuitNotice('force');
    ok(await p === 'force', '按强制关闭 → force');
  }
  {
    // 4c 用户按先别关 → cancel
    const running = { v: true };
    const p = noticeAndWait([{ x: mk('a', '甲', running), r: { ok: false, error: 'x' } }], () => {});
    await tick(40);
    answerQuitNotice('cancel');
    ok(await p === 'cancel', '按先别关 → cancel(调用方据此 cancelQuit + endQuit)');
  }

  console.log('\n[5] 🔴 结构守卫');
  {
    const src = fs.readFileSync(path.join(__dirname, 'quit-sediment.js'), 'utf8');
    ok(!/setTimeout\([^)]*\)[^;]*(?:reject|throw)/.test(src.slice(src.indexOf('async function waitUntilSettled'))),
       '🔴 等待里没有第二个计时器 —— "等多久算死"正是判错过的那件事, 不许重犯');

    const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    const quitPart = main.slice(main.indexOf('async function runQuitFlow'), main.indexOf('async function runQuitFlow') + 2200);
    ok(!/没存下来/.test(main),
       '🔴 "没存下来"这句话已经从代码里消失 —— 判死只代表我们不等了, 说成失败是撒谎');
    ok(/noticeAndWait\(/.test(quitPart) && !/showMessageBoxSync[\s\S]{0,400}强制关闭/.test(quitPart),
       '🔴 退出链的失败分支走通知, 不再是同步阻塞的二选一框');
    ok(/cancelQuit\(dirtyItems\)[\s\S]{0,40}endQuit\(\)/.test(quitPart),
       '先别关 → shuttingDown 摘干净且退出链解锁, 人格要完整恢复不能只退一半');

    const i18n = fs.readFileSync(path.join(__dirname, 'i18n-quit.js'), 'utf8');
    const locales = ['zh-CN', 'zh-TW', 'en', 'ja'];
    ok(locales.every(l => i18n.includes(`add('${l}'`)), '四种界面语言都给了文案');
    const keys = ['sediment_writing', 'sediment_notice_title', 'sediment_btn_wait', 'sediment_btn_force'];
    ok(keys.every(k => (i18n.match(new RegExp(k, 'g')) || []).length === 4), '每个键四种语言都不缺');
  }

  console.log(`\n${fail ? '❌' : '✅'} test-quit-notice: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
