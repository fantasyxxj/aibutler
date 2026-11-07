// test-pinned-too-long.js — 上限(120 字)出来之前钉上的超长常驻: 体检趁它还钉着报出来, 出厂条目被拦时告诉人格另存短版
require('./host-wiring');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MemoryGraphV2 } = require('../core/memory-v2');
const factory = require('../core/factory-sync');
const { checkupFindings } = require('../core/checkup-gate');
const { cfg } = require('../core/host');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ' + l); } else { fail++; console.log('  FAIL ' + l); } };
const long = '用户从 Telegram 找我, 回话就调 send_tg 发回那个聊天(chat_id 从来消息里原样抄); '.repeat(3);
const g = new MemoryGraphV2(fs.mkdtempSync(path.join(os.tmpdir(), 'butler-pinlong-')));
factory.syncFactory(g, { name: 't', log: () => {}, items: [
  { slug: 'feedback_factory_long', type: 'feedback', importance: 'high', title: 'f', claim: long, keywords: 'tg' }] });
g.upsert({ slug: 'feedback_own_long', type: 'feedback', importance: 'high', title: 'o', claim: long, keywords: 'tg', links: ['feedback_factory_long'] });
// 模拟上限出来之前就钉上的两条: 绕过 setPinned 的字数闸
for (const s of ['feedback_factory_long', 'feedback_own_long']) g.store.setPinned(g.resolve(s), 'old');

console.log('\n== 体检报出来 ==');
const rep = g.doctor();
ok(rep.pinned_too_long === 2, `doctor 数出 2 条超长常驻(${rep.pinned_too_long})`);
const fs1 = checkupFindings(rep);
ok(fs1.some((x) => x.key === 'pinned_too_long' && /2 pinned claims are over/.test(x.label)), '体检发现里有 pinned_too_long');
ok(!checkupFindings({ pinned: 2, quota: 10, pinned_too_long: 0 }).some((x) => x.key === 'pinned_too_long'), '没有超长就不报');
for (const lc of ['', '.zh-CN', '.zh-TW', '.ja']) {
  const t = fs.readFileSync(path.join(__dirname, '..', `core/config/main/checkup_nudge${lc}.md`), 'utf8');
  ok(/pinned claims are over the length cap/.test(t) && /on=false/.test(t), `checkup_nudge${lc || '(en)'} 教了怎么改短`);
}

console.log('\n== 撤下后再钉 ==');
g.store.unpin(g.resolve('feedback_factory_long'));
let msg = '';
try { g.setPinned('feedback_factory_long', 'again'); } catch (e) { msg = e.message; }
ok(/at most 120/.test(msg) && /shipped knowledge/.test(msg) && /links='feedback_factory_long'/.test(msg), '出厂条目被拦: 提示另存短版并连回它');
g.store.unpin(g.resolve('feedback_own_long'));
msg = '';
try { g.setPinned('feedback_own_long', 'again'); } catch (e) { msg = e.message; }
ok(/at most 120/.test(msg) && !/shipped knowledge/.test(msg), '自己的条目被拦: 只叫它改短, 不带出厂那段');
ok(!/\{\{/.test(cfg.render('main/pinned_too_long_factory', { max: 120, len: 150, slug: 'x' })), '出厂那段文案占位都填上了');

console.log('\n== 改短后照常钉 ==');
g.upsert({ slug: 'feedback_tg_short', type: 'feedback', importance: 'high', title: 's', claim: '用户从 Telegram 找我, 回话就调 send_tg 发回那个聊天。', keywords: 'tg', links: ['feedback_factory_long'] });
ok(!!g.setPinned('feedback_tg_short', 'short'), '短版能钉上');

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
