// test-history-log.js — 聊天日志(只增不改, 按天一个文件)真跑一遍。
//
// 为什么有这条闸: 2026-08-27 之前, 会话只有 `.session.json` 一个**快照**, 落盘时 slice(-400),
// 超出的在那一刻就被永久截掉了 —— 而屏幕上还留着几千条(内存里的 convo 不截断), 于是
// "看得见的历史" 远多于 "存下来的历史", 关掉窗口才发现没了, 没有任何提示。
// 日志这份就是为了让往上翻有东西可翻。它一旦悄悄退化成"只留最近 N 条", 功能就成了空壳,
// 而界面上完全看不出来 —— 所以要在这里守住"只增不改"。
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../core/chat-store');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-hist-'));
const dir = path.join(tmp, 'history');
const at = (day, h, i) => new Date(`${day}T${String(h).padStart(2, '0')}:00:00`).getTime() + i;

console.log('\n== 按天切文件 ==');
{
  store.appendHistory(dir, [
    { role: 'user', text: 'd1-a', ts: at('2026-08-25', 9, 0) },
    { role: 'assistant', text: 'd1-b', ts: at('2026-08-25', 9, 1) },
    { role: 'user', text: 'd2-a', ts: at('2026-08-26', 9, 0) },
  ]);
  const files = fs.readdirSync(dir).sort();
  ok(files.length === 2, `一批跨两天就写两个文件(实际 ${files.join(',')})`);
  ok(files[0] === '2026-08-25.jsonl' && files[1] === '2026-08-26.jsonl', '文件名是日期, 排序即时间序');
  const l1 = fs.readFileSync(path.join(dir, '2026-08-25.jsonl'), 'utf8').trim().split('\n');
  ok(l1.length === 2, '一行一条');
  ok(JSON.parse(l1[0]).text === 'd1-a', '每行是完整 JSON');
}

console.log('\n== 🔴 只增不改: 追加不重写, 老内容一个字不动 ==');
{
  const f = path.join(dir, '2026-08-26.jsonl');
  const before = fs.readFileSync(f, 'utf8');
  store.appendHistory(dir, [{ role: 'assistant', text: 'd2-b', ts: at('2026-08-26', 10, 0) }]);
  const after = fs.readFileSync(f, 'utf8');
  ok(after.startsWith(before), '🔴 新内容只往后接, 原文原样留着(不是读改写)');
  ok(after.trim().split('\n').length === 2, '这天现在两条');
}

console.log('\n== 往上翻: 按时间游标取更早的 ==');
{
  // 现在日志共 4 条, 时间序: d1-a d1-b d2-a d2-b
  const last2 = store.readHistoryBefore(dir, 0, 2);
  ok(last2.length === 2, '没给游标 → 从最新往回取, 要 2 条给 2 条');
  ok(last2[0].text === 'd2-a' && last2[1].text === 'd2-b', `返回按时间正序, 且是最后两条(实际 ${last2.map(m => m.text)})`);

  const older = store.readHistoryBefore(dir, last2[0].ts, 2);
  ok(older.length === 2 && older[0].text === 'd1-a' && older[1].text === 'd1-b',
     `🔴 拿上一页最早那条当游标, 接着往前给两条(实际 ${older.map(m => m.text)})`);

  const across = store.readHistoryBefore(dir, at('2026-08-26', 9, 1), 2);
  ok(across.length === 2 && across[0].text === 'd1-b' && across[1].text === 'd2-a',
     `🔴 一页跨文件也要连得上(实际 ${across.map(m => m.text)})`);

  // 🔴 这条挡的正是丢消息那个 bug: 屏幕上画的可能来自快照(条数与日志对不上),
  //    所以游标必须只认时间, 不许受"屏幕上有几条"影响。
  const byTime = store.readHistoryBefore(dir, at('2026-08-26', 10, 0), 99);   // d2-b 就在这一刻
  ok(byTime.length === 3 && byTime[0].text === 'd1-a' && byTime[2].text === 'd2-a',
     `🔴 只按时间切, 与屏幕上有几条无关(实际 ${byTime.map(m => m.text)})`);
  ok(!store.readHistoryBefore(dir, last2[1].ts, 9).some((m) => m.ts === last2[1].ts),
     '🔴 严格小于游标 —— 等于游标的那条是屏幕上最早那条自己, 收回来会画重复');
}

console.log('\n== 到头了就是空数组(界面靠这个判断"没有更早的了") ==');
{
  ok(store.readHistoryBefore(dir, at('2026-08-25', 0, 0), 100).length === 0, '游标早于全部 → 空');
  ok(store.readHistoryBefore(dir, 1, 100).length === 0, '游标是极早的数 → 空, 不报错');
  ok(store.readHistoryBefore(path.join(tmp, 'nope'), 0, 100).length === 0, '目录不存在 → 空, 不抛');
}

console.log('\n== 坏行不能毁掉一整段 ==');
{
  fs.appendFileSync(path.join(dir, '2026-08-26.jsonl'), '{这不是json\n', 'utf8');
  const r = store.readHistoryBefore(dir, 0, 10);
  ok(r.length === 4, `坏行跳过, 其余 4 条照常读出来(实际 ${r.length})`);
}

console.log('\n== 🔴 快照那份仍然截断, 日志这份不许截断 ==');
{
  const snap = path.join(tmp, '.session.json');
  const many = Array.from({ length: store.MAX_MSGS + 50 }, (_, i) => ({ role: 'user', text: 'm' + i, ts: at('2026-08-27', 9, i) }));
  store.save(snap, { sessionId: 'x', messages: many });
  ok(JSON.parse(fs.readFileSync(snap, 'utf8')).messages.length === store.MAX_MSGS,
     `快照按 MAX_MSGS(${store.MAX_MSGS}) 截断 —— 它是"开窗口秒开"用的, 不是历史`);

  const dir2 = path.join(tmp, 'history2');
  store.appendHistory(dir2, many);
  ok(store.readHistoryBefore(dir2, 0, 9999).length === many.length,
     `🔴 日志一条不少(${many.length} 条) —— 这里一旦跟着截断, 往上翻就成了空壳`);
}

console.log('\n== 与 main.js 的接线 ==');
{
  const MAIN = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  // convo.push 散在十几处, 逐处补写必漏; 所以日志必须收在 persist 这一个口子上, 并且按差量写
  ok(/const persist = \(\) => \{[\s\S]{0,400}?appendHistory\(/.test(MAIN),
     '🔴 日志追加收在 persist 里(convo.push 有十几处, 逐处补写迟早漏一处)');
  ok(/convo\.slice\(logged\)/.test(MAIN), '按"已写到第几条"算差量 —— 只 push 没 persist 的下次会补上');
  ok(/appendHistory\([\s\S]{0,120}?filter\(\(m\) => m && m\.display !== ''\)/.test(MAIN),
     "display:'' 的机器标记不进日志(它当初就没画给人看)");
  ok(/logged = convo\.length;\s+\/\/ 游标按 convo 走/.test(MAIN),
     '游标按 convo 长度走, 不按真写进去几条(否则被滤掉的会被反复重读)');
  ok(/ipcMain\.handle\('history-page'/.test(MAIN), '有 history-page 这个 IPC 供往上翻');
  // 🔴 翻页必须按时间游标, 不许按条数。按条数的前提是"屏幕上那 N 条 ≡ 日志尾部那 N 条",
  //    而屏幕是拿快照画的、日志 8-27 才上线 —— 前提不成立, 表现就是中间整段消息看不到。
  ok(/history-page'[\s\S]{0,300}?readHistoryBefore\(s\.historyDir, Number\(before\)/.test(MAIN),
     '🔴 history-page 走时间游标 readHistoryBefore(before), 不是 skip 条数');
  ok(!/readHistoryTail|Number\(skip\)/.test(MAIN), '🔴 skip 那套条数分页不许留在代码里');
  ok(/get-history'[\s\S]{0,400}?convo\.slice\(-n\)/.test(MAIN),
     '🔴 开标签只回最近 n 条(内存 convo 一整程不截断, 整包过 IPC 是白花的序列化)');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
