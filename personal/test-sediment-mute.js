// test-sediment-mute.js — 自言自语那几轮(清空前沉淀 · 保活心跳)不上屏, 而且静音只管显示、不吞状态。
// 手法与 test-empty-turn 同: _consume(q) 直接灌假消息流, 不起 SDK。
//
// 病史(都守在这里, 详见 core/agent/turn-mute.js 文件头):
//  ① 静音是实例级布尔开关 → 被上一轮的 result 提前复位, 沉淀轮那句英文口令照样上屏。
//  ② 先置 Infinity 全局待认领 → 真人在闸口按的回车把静音抢到自己头上, 整轮被掐死(2026-09-27)。
//  ③ 拿 _turnSeq(数提交) 追 _resultSeq(数结果) → 连续几句被合成一轮后两数错位, 静音闩死(2026-09-27)。
//  ④ 给③加"最多罩 2 个结果"的上界 → 紧跟心跳的那一轮被整轮吞掉: 回复不上屏不进记录,
//     它登记的压缩也一起丢(2026-10-09, 上下文挂在 40% 一整夜)。
//  ⑤ "一轮开始时认领此前入队的全部提交" → SDK 读走消息到我们看见 init 之间有窗口, 窗口里入队的
//     心跳被上一轮多认领走, 自己那一轮反而出声(2026-10-09 dev 实撞)。
// 现行: 按 CLI 的 --replay-user-messages 回放对账(core/agent/turn-mute.js)。
require('./host-wiring');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-sediment-mute-'));
fs.mkdirSync(path.join(tmp, 'memory'), { recursive: true });

const { Butler } = require('../core/agent');
const turnMute = require('../core/agent/turn-mute');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };

const U = { input_tokens: 10, cache_read_input_tokens: 100 };
const textMsg = (t) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }], usage: U } });
const resultMsg = () => ({ type: 'result', subtype: 'success' });
// CLI 开始处理某条提交时带原 uuid 回发的那条消息
const replay = (uuid) => ({ type: 'user', isReplay: true, uuid, message: { role: 'user', content: [] } });
// 消息之间可以插一个回调 —— 模拟"这一轮已经开始了, 这时又有人提交"
async function* stream(...items) { for (const m of items) { if (typeof m === 'function') await m(); else yield m; } }

// 真 submit 会 ensureStream 起 SDK。这里只留入队那一刻的登记 —— 与 stream.js 那段必须一致,
// 底下有源码门禁盯着别漂。返回这条提交的 uuid, 测试拿它造回放。
let uid = 0;
function fresh(name) {
  const b = new Butler(tmp, { name });
  const shown = [], ended = [];
  b.setCallbacks({
    onText: () => {}, onActivity: () => {}, onTool: () => {}, onToolDone: () => {},
    onUsage: () => {}, onResult: (r) => shown.push(r.finalText),
    onTurnEnd: (d) => ended.push(d),   // 不在 UI_EVENTS 里 → 静音轮也收得到
  });
  b.submit = async (text, _att, opts = {}) => {
    const uuid = `u${++uid}`;
    ++b._turnSeq;
    const hb = typeof text === 'string' && text.startsWith('[[HEARTBEAT]]');
    const continuation = !!(opts._emptyTurnRetry || opts._forceSediment || opts._redlineRetry || opts._lostToolRetry);
    turnMute.noteSubmit(b, uuid, continuation ? b._turnMuted : !!(opts._mute || hb));
    return uuid;
  };
  const shownHas = (frag) => shown.some((t) => String(t).includes(frag));
  return { b, shown, ended, shownHas };
}
const HB = '[[HEARTBEAT]] keepalive';

(async () => {
  console.log('[沉淀轮静音]');
  {
    const { b, ended, shownHas } = fresh('测试体');
    const u1 = await b.submit('用户这轮');
    let sedimentReply = null, say, u2;
    // 第 1 轮已经在跑, 这时决定清空 → 沉淀那条提交排到它后面
    await b._consume(stream(replay(u1), textMsg('真回合说的话'), () => {
      say = (async () => {
        u2 = await b.submit('(沉淀提示词)', undefined, { _mute: true, sourceKind: 'auto' });
        return new Promise((res) => b._askPending.push(res));
      })().then((v) => { sedimentReply = v; });
    }, resultMsg()));
    await say;
    ok(sedimentReply === '真回合说的话', '前提复现: 沉淀的 askOnce 被上一轮的 result 提前解开了');
    ok(shownHas('真回合说的话'), '真回合照常上屏');
    await b._consume(stream(replay(u2), textMsg('nothing to save'), resultMsg()));
    ok(!shownHas('nothing to save'), '🔴 沉淀轮的英文口令不上屏');
    ok(ended[ended.length - 1].muted === true, '沉淀轮照发 onTurnEnd 且标 muted(渲染层的 busy 靠它复位)');
    const u3 = await b.submit('下一句真话');
    await b._consume(stream(replay(u3), textMsg('我回来了'), resultMsg()));
    ok(shownHas('我回来了') && ended[ended.length - 1].muted === false, '之后照常上屏, onTurnEnd 标 muted:false');
  }

  console.log('\n[2026-10-09 那一夜: 心跳之后的提醒轮]');
  {
    const { b, shown, ended, shownHas } = fresh('一夜体');
    // 真人连续两句被合成一轮(老判法的错位就从这里来)
    const a = await b.submit('第一句'); const c = await b.submit('第二句');
    await b._consume(stream(replay(a), replay(c), textMsg('合起来答'), resultMsg()));
    for (let i = 0; i < 3; i++) {
      const h = await b.submit(HB, undefined, { sourceKind: 'auto' });
      await b._consume(stream(replay(h), textMsg('ok'), resultMsg()));
    }
    ok(!shown.includes('ok'), '心跳的 "ok" 一次都不上屏');
    const n = await b.submit('(存记忆提醒)', undefined, { sourceKind: 'auto' });
    await b._consume(stream(replay(n), () => { b.compactRequested = '模型自己登记的压缩'; }, textMsg('已存好'), resultMsg()));
    ok(shownHas('已存好'), '🔴 紧跟心跳的提醒轮照常上屏、进对话记录(老代码在这里整轮被吞)');
    const last = ended[ended.length - 1];
    ok(last.muted === false && last.compactReason === '模型自己登记的压缩', '🔴 登记的压缩随 onTurnEnd 交给宿主执行');
  }

  console.log('\n[静音只管显示, 不吞状态]');
  {
    const { b, ended, shownHas } = fresh('状态体');
    const h = await b.submit(HB, undefined, { sourceKind: 'auto' });
    await b._consume(stream(replay(h), () => { b.compactRequested = '心跳轮里过了阈值'; }, textMsg('ok'), resultMsg()));
    ok(!shownHas('ok'), '心跳轮正文不上屏');
    ok(ended[0].muted === true && ended[0].compactReason === '心跳轮里过了阈值', '🔴 静音轮登记的压缩照样交出去(onTurnEnd 不受静音影响)');
  }

  console.log('\n[dev 实撞的窗口: 上一轮刚开始时心跳入队]');
  {
    const { b, shownHas } = fresh('窗口体');
    const u = await b.submit('真人这句');
    const h = await b.submit(HB, undefined, { sourceKind: 'auto' });   // SDK 已读走真人那句、我们还没看见它开始
    await b._consume(stream(replay(u), textMsg('回真人'), resultMsg()));
    await b._consume(stream(replay(h), textMsg('ok'), resultMsg()));
    ok(shownHas('回真人'), '真人那一轮上屏');
    ok(!shownHas('ok'), '🔴 心跳自己那一轮仍然静音(回放说了它属于第二轮, 不会被第一轮多认领走)');
  }

  console.log('\n[合成一轮 · 轮中插话 · 认不出的回放]');
  {
    const { b, shownHas } = fresh('合成体');
    const h = await b.submit(HB, undefined, { sourceKind: 'auto' });
    const u = await b.submit('你在吗');
    await b._consume(stream(replay(h), replay(u), textMsg('在的'), resultMsg()));
    ok(shownHas('在的'), '🔴 心跳与真人合成一轮 → 出声(老宿主的 heartbeat_pending 短路会把它吞掉)');

    const h2 = await b.submit(HB, undefined, { sourceKind: 'auto' });
    const u2 = await b.submit('合成时只回放了最后一条');
    await b._consume(stream(replay(u2), textMsg('也在'), resultMsg()));
    ok(shownHas('也在') && !b._pendingSubs.some((x) => x.uuid === h2), '只回放后一条时, 排在前面的按 FIFO 一并出队、这一轮出声');

    // 轮中途 CLI 把真人那句读进来
    const { b: b2, shownHas: has2 } = fresh('插话体');
    const s2 = await b2.submit('(沉淀提示词)', undefined, { _mute: true, sourceKind: 'auto' });
    const hu2 = await b2.submit('真人插话');
    await b2._consume(stream(replay(s2), textMsg('独白'), replay(hu2), textMsg('回你'), resultMsg()));
    ok(has2('回你'), '🔴 静音轮中途回放出一句真人的话 → 从这里放开, 回他的话上屏');

    const { b: b3, shownHas: has3 } = fresh('无回放体');
    await b3._consume(stream(textMsg('CLI 自己起的一轮'), resultMsg()));
    ok(has3('CLI 自己起的一轮'), '没有回放的轮默认出声(安全侧)');
    await b3.submit(HB, undefined, { sourceKind: 'auto' });
    await b3._consume(stream(replay('认不出的'), textMsg('ok?'), resultMsg()));
    ok(has3('ok?'), '回放的 uuid 认不出 → 保守当作出声(宁可多显示一句, 不吞)');
  }

  console.log('\n[补提轮沿用被扣住那一轮]');
  {
    const { b, shownHas } = fresh('补提体');
    const h = await b.submit(HB, undefined, { sourceKind: 'auto' });
    turnMute.onReplay(b, h);                                   // 心跳那一轮开始了, 结果被扣住(continue, 未收尾)
    const r = await b.submit('(补提)', undefined, { sourceKind: 'auto', _emptyTurnRetry: true });
    await b._consume(stream(replay(r), textMsg('ok'), resultMsg()));
    ok(!shownHas('ok'), '补提出来的回复沿用心跳那一轮的静音');
    const h2 = await b.submit(HB, undefined, { sourceKind: 'auto' });
    await b._consume(stream(replay(h2), textMsg('ok2'), resultMsg()));
    ok(!shownHas('ok2'), '下一次心跳照样静音');
  }

  console.log('\n[拆流]');
  {
    const { b } = fresh('拆流体');
    const h = await b.submit(HB, undefined, { sourceKind: 'auto' });
    turnMute.onReplay(b, h);
    await b.submit(HB, undefined, { sourceKind: 'auto' });   // 排在队里, 流一拆就没了
    b._flushAskPending();
    await b._teardownStream().catch(() => {});
    ok(b._turnMuted === false && b._pendingSubs.length === 0, '拆流: 静音放开, 没回放的提交一并丢掉(不记到新流头上)');
  }

  console.log('\n[源码门禁]');
  const rd = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const src = rd('core', 'agent', 'stream.js');
  const csrc = rd('core', 'agent', 'consume.js');
  ok(/extraArgs: \{ 'replay-user-messages': null \}/.test(src), '🔴 子进程开着 --replay-user-messages(静音对账的唯一依据)');
  ok(/parent_tool_use_id: null, uuid: crypto\.randomUUID\(\)/.test(src), '每条用户消息带 uuid(回放靠它认是哪一条)');
  ok(/this\._queue\.push\(_msg\);\s*[\s\S]{0,200}?\+\+this\._turnSeq;[\s\S]{0,400}?turnMute\.noteSubmit\(this, _msg\.uuid, _continuation \? this\._turnMuted : !!\(opts\._mute \|\| isHeartbeatPing\), opts\.turnMeta\)/.test(src),
     '入队之后登记: 心跳与 _mute 是静音提交, 补提沿用被扣住那一轮');
  ok(/const _continuation = !!\(opts\._emptyTurnRetry \|\| opts\._forceSediment \|\| opts\._redlineRetry \|\| opts\._lostToolRetry\)/.test(src),
     '四种补提(与 consume.js 的四条不放行路一一对应)');
  ok(/if \(msg\.type === 'user' && msg\.isReplay\) \{ turnMute\.onReplay\(this, msg\.uuid\); continue; \}/.test(csrc),
     '🔴 回放在消费循环里先截住对账并跳过(它不是工具结果)');
  ok(!/_muteUntilSeq|_muteArmedAtResult|claimTurn/.test(src + csrc + rd('core', 'agent.js') + rd('core', 'agent', 'turn-release.js') + rd('core', 'agent', 'compact.js')),
     '🔴 猜轮次的老判法(计数追赶 / 开轮时全认领)已彻底拆掉');
  ok(/turnMute\.endTurn\(this\)/.test(csrc), 'consume 收尾时结束这一轮的静音');
  ok(/this\._emit\('onTurnEnd', \{ interrupted, muted: _wasMuted, compactReason, held \}\)/.test(csrc) && !/'onResult', \{[^}]*compactReason/.test(csrc),
     '🔴 压缩信号走 onTurnEnd, 不再挂在会被静音掐掉的 onResult 上');
  ok(/askOpts: \{[^}]*_mute: true/.test(rd('core', 'agent', 'compact.js')), '沉淀轮自己带 _mute 提交');
  const asrc = rd('core', 'agent.js');
  const msrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const uiset = (asrc.match(/const UI_EVENTS = new Set\(\[[\s\S]*?\]\)/) || [''])[0];
  ok(uiset && !/onTurnEnd/.test(uiset) && !/onTasks/.test(uiset), '🔴 onTurnEnd 与 onTasks 不在 UI_EVENTS 里(一个是收尾信号, 一个是状态)');
  ok(/this\._emit\('onTurnEnd'/.test(src), '流被拆掉那条路也发 onTurnEnd');
  const turnEnd = msrc.slice(msrc.indexOf('onTurnEnd: ({'), msrc.indexOf('onResult: async'));
  ok(/heartbeat_pending = false/.test(turnEnd) && /last_heartbeat_ts = Date\.now\(\)/.test(turnEnd)
     && /sendUI\('turn-result'/.test(turnEnd) && /runTurnEndCompact\(compactReason\)/.test(turnEnd),
     '🔴 宿主 onTurnEnd: 复位心跳标记 · 补空 turn-result · 执行登记的压缩');
  ok(!/if \(s\.heartbeat_pending\) return/.test(msrc), '宿主不再另设 heartbeat_pending 短路(心跳与真人合成一轮时会吞掉回真人的话)');
  const imain = rd('industry', 'app', 'main.js');
  const icb = imain.slice(imain.indexOf('rt.agent.setCallbacks({'));
  const icbBody = icb.slice(0, icb.indexOf('\n  });'));
  ok(/onTurnEnd: \(\{ muted, torn, compactReason, held \}\)[\s\S]*doClearWithSediment\(compactReason\)/.test(icbBody),
     '🔴 行业版宿主同样在 onTurnEnd 执行压缩, 而且 onTurnEnd 写在 setCallbacks({...}) 里面(写在外面会被当成标签语句, 从没注册上)');
  const isrc = rd('core', 'idle-watcher.js');
  ok(!/\n\s*return sendHeartbeat\(s\);/.test(isrc) && /KEEPALIVE 未送达/.test(isrc), '心跳送不出去要落一行日志');

  console.log('\n[提交随带的 meta 跟着回放进轮(行业版: 这一轮是哪位客人)]');
  {
    const tm = require('../core/agent/turn-mute.js');
    const b = {};
    tm.noteSubmit(b, 'a', false, { lineGuest: 'U1' });
    tm.noteSubmit(b, 'b', false, { lineGuest: 'U2' });
    tm.onReplay(b, 'a');
    ok(JSON.stringify(b._turnMetas) === '[{"lineGuest":"U1"}]', '第一轮只带回放进来的那条的 meta');
    tm.endTurn(b);
    ok(b._turnMetas.length === 0, '收尾清空, 不漏到下一轮');
    tm.onReplay(b, 'b');
    ok(b._turnMetas.length === 1 && b._turnMetas[0].lineGuest === 'U2', '排在后面的那条进下一轮');
    tm.endTurn(b);
    tm.noteSubmit(b, 'c', false, { lineGuest: 'U3' });
    tm.noteSubmit(b, 'd', false, { lineGuest: 'U4' });
    tm.onReplay(b, 'd');
    ok(b._turnMetas.length === 2, '几条合成一轮 → 两位都在(宿主据此判认不出是谁)');
    tm.dropTurn(b);
    ok(b._turnMetas.length === 0, '拆流也清空');
  }

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();
