// test-record-primitive.js — 插件录音(record 原语 + core/record-bridge.js)。跑法: node test-record-primitive.js
//
// 守的是「插件能录音, 但录的东西只归它自己」这句话:
//   ①做什么只从声明的 op 读, 人格调不到 ②录好的落在本包目录, 只交回 id/path/秒数
//   ③play 只认 id, A 包放不了 B 包的录音 ④同一时刻只有一个包占着麦克风
'use strict';

require('./host-wiring');
const fs = require('fs');
const os = require('os');
const path = require('path');
const commands = require('../core/commands.js');
const bridge = require('../core/record-bridge.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

// 一秒 16k mono 的 wav
function wav1s() {
  const n = 16000, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return new Uint8Array(b);
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const sent = [];
  // 假宿主页: 收到 record-op 就照常回话
  const wc = {
    isDestroyed: () => false,
    send: (ch, m) => {
      sent.push(m);
      setImmediate(() => handlers['record-reply'](null, { rid: m.rid, ok: true, wav: m.op === 'stop' ? wav1s() : undefined }));
    },
  };
  const forSender = bridge.create({ ipcMain, dir: () => root });
  const ctx = { record: forSender(wc) };

  commands.pkgCommandsReset && commands.pkgCommandsReset();
  const decl = (op, extra = {}) => ({ primitive: 'record', op, ...extra });
  const r = commands.registerPackageCommands('ielts', {
    rec: decl('start', { max_sec: 999, ai: true }), warm: decl('warm'), stop: decl('stop'), play: decl('play'), cancel: decl('cancel'),
    bad: decl('listen'),
  });
  commands.registerPackageCommands('other', { play: decl('play'), rec: decl('start') });

  console.log('\n[1] 登记');
  ok(r.added.includes('ielts.rec') && r.added.includes('ielts.stop'), 'record 原语的命令登记得上');
  ok(commands.catalog()['ielts.rec'].ai === false, '写了 ai:true 也只给人按 —— 人格开不了麦克风');
  ok(commands.notifyAi('ielts.stop') === false, '录完默认不叫醒 AI');

  console.log('\n[2] 录一段');
  const w = await commands.run('ielts.warm', {}, ctx);
  ok(w.ok && sent[0].op === 'warm', '先 warm: 宿主页提前开麦');
  sent.length = 0;
  const s1 = await commands.run('ielts.rec', {}, ctx);
  ok(s1.ok && s1.data.max_sec === 300, '开始录; 声明的 999 秒被压到 300');
  ok(sent[0].op === 'start' && sent[0].maxMs === 300000, '宿主页收到的到点自停是 300 秒');
  const busy = await commands.run('other.rec', {}, ctx);
  ok(!busy.ok && busy.code === 'record_busy', '别的包这时候抢不到麦克风');
  const st = await commands.run('ielts.stop', {}, ctx);
  ok(st.ok && /^[0-9a-z-]+$/.test(st.data.id) && st.data.duration_sec === 1, `停下交回 id 和秒数(${st.data && st.data.duration_sec}s)`);
  ok(st.ok && st.data.path === path.join(root, 'ielts', `${st.data.id}.wav`) && fs.existsSync(st.data.path), 'wav 落在本包目录');
  const again = await commands.run('ielts.stop', {}, ctx);
  ok(!again.ok && again.code === 'not_recording', '没在录时 stop 说清楚');

  console.log('\n[3] 回放');
  const p1 = await commands.run('ielts.play', { id: st.data.id }, ctx);
  ok(p1.ok && sent[sent.length - 1].op === 'play' && sent[sent.length - 1].wav.length === 44 + 32000, '按 id 回放, 字节送到宿主页');
  const p2 = await commands.run('other.play', { id: st.data.id }, ctx);
  ok(!p2.ok && p2.code === 'recording_not_found', '别的包拿同一个 id 放不了');
  const p3 = await commands.run('ielts.play', { id: '../other/x' }, ctx);
  ok(!p3.ok && p3.code === 'bad_param', 'id 里带路径直接拒');

  console.log('\n[4] 其它');
  const b = await commands.run('ielts.bad', {}, ctx);
  ok(!b.ok && b.code === 'bad_decl', '声明里写错 op 报 bad_decl');
  const no = await commands.run('ielts.rec', {}, {});
  ok(!no.ok && no.code === 'no_record', '宿主没接录音时说清楚, 不假装录了');
  const nowin = await bridge.create({ ipcMain: { handle() {} }, dir: () => root })(null)('start', { pkg: 'ielts', maxSec: 5 });
  ok(!nowin.ok && nowin.code === 'no_window', '没有窗口(人格那条路)录不了');
  for (let i = 0; i < bridge.KEEP + 3; i++) {
    await commands.run('ielts.rec', {}, ctx); await commands.run('ielts.stop', {}, ctx);
  }
  ok(fs.readdirSync(path.join(root, 'ielts')).length === bridge.KEEP, `每包只留最近 ${bridge.KEEP} 段`);

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${fail ? '❌' : '✅'} test-record-primitive: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
