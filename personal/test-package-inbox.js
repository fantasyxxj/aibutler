// test-package-inbox.js — bus 收包。跑法: node test-package-inbox.js
//
// 这个门禁盯的不是「包能装上」(那条一眼就看得出坏没坏), 而是几件**看起来一切正常、
// 实际已经坏了**的事:
//   [2] 包有没有混进要交给 AI 的那堆消息 —— 坏了只体现在账单上, 屏幕上一模一样
//   [3] 坏签名的包会不会一边不装、一边还是把消息推给 AI 让它去猜
//   [5] 装一个包会不会顺手把同一批里的聊天消息吃掉 —— 用户永远不知道自己少收了信
//   [6] 认包是不是靠猜内容 —— 靠猜的话, 聊天里贴一段包的 JSON 就能让人装东西
//   [7] 收货口会不会自己长出一套验签 —— 那就有了第二个真相, 迟早和真闸走偏
//   [8] main.js 里卸包是不是排在"AI 忙不忙"判断之前 —— 排到后面就变成越忙越晚装
'use strict';

require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const os = require('os');
const path = require('path');

const packageInbox = require('../core/package-inbox');
const packages = require('../core/packages');
const workflow = require('../core/workflow');
const workflowProgress = require('../core/workflow-progress');

let pass = 0, fail = 0;
const ok = (c, m) => {
  if (c && typeof c.then === 'function') { fail++; console.log(`  ✗ ${m} — ok() 收到了 promise`); return; }
  if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-inbox-'));
const progress = workflowProgress.create(path.join(tmp, 'app'));
const installTo = (dir) => (text) => packages.install(text, { dataDir: dir });

const { SIGNED_PKG } = require('./fixture-package');   // 真私钥签过的包 · 单一真源(手抄会掉字符)

const KIND = packageInbox.MSG_KIND;
const pkgMsg = (id, pkg) => ({ id, from_agent: 'ops', text: '', payload: { kind: KIND, package: pkg } });
const chatMsg = (id, text) => ({ id, from_agent: 'someone', text, payload: { kind: 'chat' } });

/* ─────────── [1] 包名沿用信封自己的种别 ─────────── */
console.log('\n[1] bus 上的包名 = 信封的种别, 不另起一个');
{
  const signing = require('../core/signing');
  ok(KIND === signing.PACKAGE_KIND, `MSG_KIND 就是 signing.PACKAGE_KIND (${KIND})`);
}

/* ─────────── [2] 包不进 AI ─────────── */
console.log('\n[2] 包卸下来装上, 且**不**混进要交给 AI 的消息里');
{
  const dir = fs.mkdtempSync(path.join(tmp, 'a-'));
  const r = packageInbox.takeFromMessages([pkgMsg(1, SIGNED_PKG)], { install: installTo(dir) });
  const why = r.failed.map((f) => `${f.code}: ${f.message}`).join(' / ');
  ok(r.installed.length === 1, `包装上了${r.installed.length ? '' : ' — ' + why}`);
  ok(r.installed[0] && r.installed[0].pkgId === 'demo_lesson' && r.installed[0].type === 'workflow', '认出是 demo_lesson/workflow');
  ok(r.installed[0] && r.installed[0].version === '1.0.0', '版本带出来了');
  ok(r.failed.length === 0, '没有失败项');
  // 这一条是本门禁的核心: 坏了的话屏幕上一切正常, 只有账单变厚。
  ok(r.rest.length === 0, '🔴 包没有出现在交给 AI 的那堆里(整批都是包 → 一次都不叫 AI)');
}

/* ─────────── [3] 坏签名: 不装, 也不丢给 AI ─────────── */
console.log('\n[3] 签名坏掉的包既不落地, 也不推给 AI');
{
  const dir = fs.mkdtempSync(path.join(tmp, 'b-'));
  const env = JSON.parse(SIGNED_PKG);
  // 真篡改: 改 payload 的字节(不是改明文字符串) —— 改明文的话包里存的是 base64, 根本没动到
  const inner = JSON.parse(Buffer.from(env.payload_b64, 'base64').toString('utf8'));
  inner.steps[0].md = { 'zh-CN': '### 被人改过了' };
  env.payload_b64 = Buffer.from(JSON.stringify(inner), 'utf8').toString('base64');

  const r = packageInbox.takeFromMessages([pkgMsg(1, JSON.stringify(env))], { install: installTo(dir) });
  ok(r.installed.length === 0, '改过的包没装上');
  ok(r.failed.length === 1 && r.failed[0].code === 'bad_signature', `落在 bad_signature (实际 ${r.failed[0] && r.failed[0].code})`);
  ok(r.rest.length === 0, '🔴 装不上的包也不推给 AI(它对此无能为力, 只会白烧一轮)');
  ok(!fs.existsSync(path.join(dir, 'packages')) || !fs.readdirSync(path.join(dir, 'packages')).length,
     '盘上一个字节都没落');
}

/* ─────────── [4] 装完当场就能翻页 ─────────── */
console.log('\n[4] 收货 → 装上 → 立刻翻得动(不用重开 app)');
{
  const dir = fs.mkdtempSync(path.join(tmp, 'c-'));
  workflow.reset();
  ok(workflow.ids().length === 0, '起手引擎里什么都没有');

  packageInbox.takeFromMessages([pkgMsg(1, SIGNED_PKG)], { install: installTo(dir) });
  // 宿主收到包之后做的那一步(main.js: loadWorkflowPackages)
  const l = workflow.loadFromPackages(packages.loadAll({ dataDir: dir }), { progress });
  ok(l.loaded.length === 1 && l.loaded[0].id === 'demo_lesson', '引擎当场认得这个手顺');

  const v = workflow.view('demo_lesson', 's1', { locale: 'zh-CN' });
  ok(typeof v === 'string' && v.includes('第一步'), '第一屏画得出来');
  ok(v.includes('{{cmd:wf_go|wf=demo_lesson|to=s2'), '第一屏带着往下翻的按钮');
  const sum = workflow.summary('zh-CN');
  ok(sum.length === 1 && sum[0].firstStep === 's1' && sum[0].title === '示例课',
     '给 AI 的入口信息(标题/第一步)拿得到 —— 通知里要照抄的就是它');
}

/* ─────────── [5] 混批: 包卸下, 信照送 ─────────── */
console.log('\n[5] 一批里既有包又有聊天消息: 各走各的, 谁都不丢');
{
  const dir = fs.mkdtempSync(path.join(tmp, 'd-'));
  const msgs = [chatMsg(1, '在吗'), pkgMsg(2, SIGNED_PKG), chatMsg(3, '晚上吃什么')];
  const r = packageInbox.takeFromMessages(msgs, { install: installTo(dir) });
  ok(r.installed.length === 1, '包装上了');
  ok(r.rest.length === 2, '两条聊天消息一条都没少');
  ok(r.rest[0].id === 1 && r.rest[1].id === 3, '顺序也没乱');
  ok(!r.rest.some(packageInbox.isPackageMsg), '交给 AI 的那堆里没有包');
}

/* ─────────── [6] 认包只看种别, 不猜内容 ─────────── */
console.log('\n[6] 认包只看 payload.kind — 聊天里贴一段包的 JSON 不会被当成下发物');
{
  const dir = fs.mkdtempSync(path.join(tmp, 'e-'));
  const sneaky = chatMsg(1, `你看这个: ${SIGNED_PKG}`);
  const r = packageInbox.takeFromMessages([sneaky], { install: installTo(dir) });
  ok(r.installed.length === 0 && r.failed.length === 0, '一个字都没装');
  ok(r.rest.length === 1, '它就是一条普通聊天消息, 照旧交给 AI');
  ok(!packageInbox.isPackageMsg(sneaky), 'isPackageMsg 不认它');
  ok(!packageInbox.isPackageMsg({ id: 9, payload: { kind: KIND } }), '种别对但没带包 → 也不认(不然会拿 null 去装)');
}

/* ─────────── [7] 收货口自己不验签 ─────────── */
console.log('\n[7] 验签只有一处 — 收货口不许自己长出一套');
{
  const src = require('./kernel-src').readSrc('package-inbox.js');
  ok(!/require\(['"]crypto['"]\)/.test(src), '没有自己 require crypto');
  ok(!/crypto\.verify|verifyBytes\(/.test(src), '没有自己做签名校验');
  ok(!/PUBLIC_KEY/.test(src), '没有自己拿公钥(公钥只焊在 signing.js 一处)');
}

/* ─────────── [8] 信封是对象也收得下 ─────────── */
console.log('\n[8] bus 的 JSON 通道会把信封解开一层 — 对象形态也要收, 且不影响验签');
{
  const dir = fs.mkdtempSync(path.join(tmp, 'f-'));
  const r = packageInbox.takeFromMessages([pkgMsg(1, JSON.parse(SIGNED_PKG))], { install: installTo(dir) });
  ok(r.installed.length === 1 && r.installed[0].pkgId === 'demo_lesson',
     '对象形态的信封照样装得上(签的是 payload_b64 的字节, 与信封怎么排版无关)');

  // 落盘的是信封本身, 重读要能再验一次 —— 否则验签就成了一次性仪式
  const again = packages.loadAll({ dataDir: dir });
  ok(again.accepted.length === 1 && again.rejected.length === 0, '重新从盘上读, 验签照样过');
}

/* ─────────── [9] 装包炸了不会吃掉同批的信 ─────────── */
console.log('\n[9] 装包这一步抛异常(磁盘满/没权限), 同一批后面的消息不能跟着消失');
{
  const r = packageInbox.takeFromMessages(
    [pkgMsg(1, SIGNED_PKG), chatMsg(2, '这条不能丢')],
    { install: () => { throw new Error('磁盘满了'); } },
  );
  ok(r.installed.length === 0, '没装上');
  ok(r.failed.length === 1 && r.failed[0].code === 'install_threw', '记成 install_threw');
  ok(r.failed[0].message.includes('磁盘满'), '原因带出来了');
  ok(r.rest.length === 1 && r.rest[0].id === 2, '🔴 后面那条聊天消息还在(没被异常带走)');
}
{
  const r = packageInbox.takeFromMessages([pkgMsg(1, SIGNED_PKG)], {});
  ok(r.failed.length === 1 && r.failed[0].code === 'no_installer', '宿主没接收货口 → 明说, 不静默丢掉');
}

/* ─────────── [10] main.js: 卸包排在"AI 忙不忙"之前 ─────────── */
console.log('\n[10] 宿主接线: 卸包必须排在 busy 判断之前(排到后面 = 越忙越晚装)');
{
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  ok(/require\(['"]\.\.\/core\/package-inbox['"]\)/.test(src), 'main.js 引了 package-inbox');

  const i = src.indexOf('const pokeBothub = (evt0) =>');
  ok(i > 0, 'pokeBothub 收的是原始事件 evt0');
  const head = src.slice(i, i + 400);
  const iTake = head.indexOf('takePackagesOff(evt0)');
  const iBusy = head.indexOf('isRunning()');
  ok(iTake > 0 && iBusy > 0 && iTake < iBusy, '🔴 先卸包, 再判断 AI 忙不忙');
  ok(/if \(!evt\) return;/.test(head), '整批都是包时直接收工 — 一次都不叫 AI');

  // 装完当场热生效: 少了这一步, 用户得重开 app 才能用, 链子断在最后一米
  ok(/loadWorkflowPackages\(\);[\s\S]{0,400}?workflow\.summary\(currentLocale\(\)\)/.test(src),
     '装上之后当场重跑 loadWorkflowPackages 并取入口信息');
  // 装包整条链(下发→验签→落目录→热生效)都是系统的活, 通知 AI 只是"通知一下"。
  // 🔴 反向断言: 通知里**不许**再出现让 AI 照抄的按钮写法。老文案塞它是因为"提示语冻住了 AI 自己拼不出来",
  // 而 plugin_open 收归系统之后, 界面由 renderPlugin 直接画 —— 让 AI 抄一行标记只剩下改坏它的风险。
  const notice = src.slice(src.indexOf('const flushPkgNotices'), src.indexOf('const takePackagesOff'));
  ok(!/\{\{cmd:/.test(notice), '🔴 装包通知里没有让 AI 照抄的按钮写法');
  ok(/plugin_open/.test(notice), '通知改为指向 plugin_open(界面由系统画, 不用 AI 拼)');
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
console.log(`\n${fail ? '❌' : '✅'} package-inbox: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
