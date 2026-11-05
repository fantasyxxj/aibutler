// test-ctx-last.js — v0.0.23 关档前对话原话捕获无头冒烟
// 覆盖 §7 的 2/3 步(单元级) + stale/consumed 门。npm start Electron 5 步待作者 UI 实操。
// 运行: node test-ctx-last.js
require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Butler, hasUnconsumedCtxLast } = require('../core/agent');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-ctxlast-'));
console.log(`[test] tmp home = ${tmpHome}`);

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { if (ok) { pass++; console.log(`  ✅ ${name}${extra ? ' · ' + extra : ''}`); } else { fail++; console.error(`  ❌ ${name}${extra ? ' · ' + extra : ''}`); } };

const butler = new Butler(tmpHome, { name: '测试飞飞' });

// Mock s.convo 通过 setCallbacks 注入 getRecentTurns (main.js 侧真实注入路径)
const mockConvo = [
  { role: 'user', text: '第一句用户消息(远早)', ts: Date.now() - 60_000 * 10 },
  { role: 'assistant', text: '第一句我回复(远早)', ts: Date.now() - 60_000 * 9 },
  { role: 'user', text: '中间还有几轮', ts: Date.now() - 60_000 * 8 },
  { role: 'assistant', text: '中间的回复', ts: Date.now() - 60_000 * 7 },
  { role: 'system', text: '🔔 TG 通知 · 不该入 ctx_last', ts: Date.now() - 60_000 * 6 },   // system 消息应被过滤
  { role: 'user', text: '你自己点关掉再打开不行啊', ts: Date.now() - 60_000 * 2 },   // §0 派单原话场景
  { role: 'assistant', text: '嗯我试试', ts: Date.now() - 60_000 * 1 },
];
const LONG = 'X'.repeat(1500);   // 触发单条截断
const mockConvoWithLong = [...mockConvo, { role: 'user', text: LONG, ts: Date.now() }];

butler.setCallbacks({
  onText: () => {}, onActivity: () => {}, onTool: () => {}, onToolDone: () => {},
  onCompact: () => {}, onUsage: () => {}, onResult: () => {}, onRateLimit: () => {},
  getRecentTurns: (n) => mockConvo
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-n)
    .map((m) => ({ role: m.role, text: m.text, ts: m.ts })),
});

// —— test 1: _captureRecentTurns 落盘 + 结构 ——
console.log('\n=== T1: _captureRecentTurns 落盘 ===');
butler._captureRecentTurns('单元测试');
const ctxPath = path.join(butler.memoryDir, 'ctx_last.json');
t('ctx_last.json 已生成', fs.existsSync(ctxPath), ctxPath);
const raw = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));
t('captured_at 存在', typeof raw.captured_at === 'number' && raw.captured_at > 0);
t('captured_reason = "单元测试"', raw.captured_reason === '单元测试');
t('persona_name = 测试飞飞', raw.persona_name === '测试飞飞');
t('turns 数量 = 6', raw.turns.length === 6, `实际=${raw.turns.length}`);
t('system 消息被过滤', raw.turns.every((x) => x.role === 'user' || x.role === 'assistant'));
t('最后一轮 = "嗯我试试"', raw.turns[raw.turns.length - 1].text === '嗯我试试');
t('倒数第 2 轮 = 派单原话场景', raw.turns[raw.turns.length - 2].text === '你自己点关掉再打开不行啊');
t('无 consumed_at 字段(未消费)', !raw.consumed_at);

// —— test 2: buildWakePayload 注入 "关档前 N 轮" 节 ——
console.log('\n=== T2: buildWakePayload 注入 ===');
const wake1 = butler.buildWakePayload();
t('起床清单含"关档前"标题', wake1.includes('## Last'));
t('含免责说明"别当永久事实"', wake1.includes('Do not treat it as permanent fact'));
t('含派单原话', wake1.includes('你自己点关掉再打开不行啊'));
t('含"对方"角色标签', wake1.includes('**[对方 ·'));
t('含"我"角色标签', wake1.includes('**[我 ·'));
// 语境比清单紧急: 新我第一眼要接上"对方刚才说了啥", 所以排在交接便条前面。
// (原先拿"记忆心法"段当锚点, 那段 2026-08-17 已砍 —— 锚点必须用仍留在正文里的段, 否则 indexOf 返 -1 假红。)
t('位置在交接便条之前', wake1.indexOf('## Last') < wake1.indexOf('handoff note'));

// —— test 3: consumed_at 打戳 & 二次调用跳过 ——
console.log('\n=== T3: consumed_at 门防重放 ===');
const raw2 = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));
t('T2 后 consumed_at 已打戳', typeof raw2.consumed_at === 'number' && raw2.consumed_at > 0);
const wake2 = butler.buildWakePayload();
t('二次 wake 不再注入"关档前"节', !wake2.includes('## Last'));

// —— test 4: stale 48h 门 ——
console.log('\n=== T4: stale 48h 门 ===');
const staleCtx = { ...raw, captured_at: Date.now() - 49 * 3600 * 1000, consumed_at: undefined };
delete staleCtx.consumed_at;
fs.writeFileSync(ctxPath, JSON.stringify(staleCtx, null, 2));
const wake3 = butler.buildWakePayload();
t('49h 旧 ctx 被 stale 门拦下', !wake3.includes('## Last'));
const staleAfter = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));
t('stale 命中时不打 consumed_at', !staleAfter.consumed_at);   // 没进注入分支就不打戳

// —— test 5: 单条超长截断 ——
console.log('\n=== T5: 单条超长截断 (1200 char) ===');
butler.setCallbacks({
  onText: () => {}, onActivity: () => {}, onTool: () => {}, onToolDone: () => {},
  onCompact: () => {}, onUsage: () => {}, onResult: () => {}, onRateLimit: () => {},
  getRecentTurns: (n) => mockConvoWithLong
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-n)
    .map((m) => ({ role: m.role, text: m.text, ts: m.ts })),
});
butler._captureRecentTurns('长条测试');
const rawLong = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));
const lastTurn = rawLong.turns[rawLong.turns.length - 1];
t('超长条被截断(<1500)', lastTurn.text.length < 1500, `截后长=${lastTurn.text.length}`);
t('截后保头 800', lastTurn.text.startsWith('X'.repeat(800)));
t('含"原话中略"标记', lastTurn.text.includes('original truncated'));

// —— test 6: hasUnconsumedCtxLast 三态 (唐伯虎 2 审建议抽出的函数) ——
console.log('\n=== T6: hasUnconsumedCtxLast 三态 ===');
// 先建一个新的 tmp memoryDir 隔离干扰
const tmpMemForFn = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-ctxlast-fn-'));
t('T6a 无文件 → false', hasUnconsumedCtxLast(tmpMemForFn) === false);
// 正常态: 新写一份 fresh ctx_last
const fresh = { captured_at: Date.now(), captured_reason: 't6', persona_name: 'x', session_id: null,
  turns: [{ role: 'user', text: 'a', ts: Date.now() }, { role: 'assistant', text: 'b', ts: Date.now() }] };
fs.writeFileSync(path.join(tmpMemForFn, 'ctx_last.json'), JSON.stringify(fresh, null, 2));
t('T6b 新鲜未消费 → true', hasUnconsumedCtxLast(tmpMemForFn) === true);
// consumed 态
fs.writeFileSync(path.join(tmpMemForFn, 'ctx_last.json'), JSON.stringify({ ...fresh, consumed_at: Date.now() }, null, 2));
t('T6c consumed_at 已打戳 → false', hasUnconsumedCtxLast(tmpMemForFn) === false);
// stale 态
fs.writeFileSync(path.join(tmpMemForFn, 'ctx_last.json'), JSON.stringify({ ...fresh, captured_at: Date.now() - 49 * 3600 * 1000 }, null, 2));
t('T6d 49h 旧 → false', hasUnconsumedCtxLast(tmpMemForFn) === false);
// 空 turns 态
fs.writeFileSync(path.join(tmpMemForFn, 'ctx_last.json'), JSON.stringify({ ...fresh, turns: [] }, null, 2));
t('T6e 空 turns → false', hasUnconsumedCtxLast(tmpMemForFn) === false);
// 坏 JSON 态
fs.writeFileSync(path.join(tmpMemForFn, 'ctx_last.json'), '{ not json');
t('T6f 坏 JSON → false (吞异常)', hasUnconsumedCtxLast(tmpMemForFn) === false);
try { fs.rmSync(tmpMemForFn, { recursive: true, force: true }); } catch (_) {}

// —— 清理 ——
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
console.log(`\n=== 汇总 ===\n通过: ${pass} · 失败: ${fail}`);
process.exit(fail ? 1 : 0);
