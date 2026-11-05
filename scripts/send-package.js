#!/usr/bin/env node
// send-package.js — 把签好名的包投进 bus。发货侧就这一条路。
//
//   node scripts/send-package.js <pkg.json> --to <agent> [--from <agent>]
//                                [--url <bus>] [--token <tok>] [--text "一句话"]
//                                [--dry]
//
// 包里带 op 的(type:'ops' 或任何带 `ops` 的包)另要一条:
//   --smoke <verify/capability-<日>.jsonl>   或   --smoke-waived "<理由>"
// 为什么 → 下面 requireSmoke 的注释。
//
// 规格不是猜的, 是从 bus 自己的 openapi.json 读出来的:
//   POST {bus}/send   body = { from_agent, to_agent, text, payload }   前三个必填
//   认证 = Authorization: Bearer <token>   (与 butler 收消息用的同一把)
// 而 payload 这一格正好就是收货端 package-inbox.isPackageMsg 读的那一格, 严丝合缝。
//
// url/token 不传就从本机登记簿里那条 bothub endpoint 借 —— 收货走哪条 bus, 发货就走哪条,
// 免得两头各填一份、填岔了还查不出来。
'use strict';

const fs = require('fs');
const path = require('path');
const signing = require('../core/signing');
const paths = require('../personal/paths');

function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }
function argOf(argv, name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

/* 🔴 带 op 的包推之前必须跑过一次能力冒烟。
 *
 * 为什么这道闸非有不可: 发版要过七道闸, 而**推包一道都不过** —— 所以「下发一个 op 等于
 * 发一个新版客户端」这句话只在「谁签的」这一维成立, 在「验过没有」那一维完全不成立
 * (设计 5.4 把信任等级说清了, 没说验证等级)。op 在主进程跑、动的是钱和预约, 一个坏 op
 * 推下去的后果与发了个坏版客户端一样, 区别只是它当天就到店里。
 *
 * 凭据取 `verify/capability-<日>.jsonl` 最后那行 `{kind:'done', pass, fail}` —— 那是套件
 * 自己写的, 不是人填的。新鲜度要求 24 小时内: op 是对着**当时那版客户端**验的。
 *
 * 逃生口 `--smoke-waived "<理由>"` 留着(不留会被绕得更难看), 但理由会写进 bus 正文,
 * 跟着这个包永久留在投递记录里 —— 绕过有成本, 且日后查得到是谁在什么理由下绕的。 */
const SMOKE_MAX_AGE_H = 24;
/* 判定だけして**自分では死なない**: 呼び手が die する。門禁から直に呼べる形にしておく
 * —— process.exit する関数は試験で捕まえられず、結果として「静態断言で我慢する」事になる。 */
function requireSmoke(p, argv) {
  if (p.type !== 'ops' && !p.ops) return {};        // op を持たない包は一バイトも変わらない
  const waived = argOf(argv, '--smoke-waived');
  if (waived) {
    return { note: `⚠ smoke waived: ${waived}` };
  }
  const f = argOf(argv, '--smoke');
  if (!f) {
    return { bad: ('这个包里有 op —— 推之前必须跑一次能力冒烟:\n'
      + '    node industry/test/capability/run.js --smoke\n'
      + '  然后 --smoke verify/capability-<日>.jsonl 把凭据带上。\n'
      + '  真要跳过: --smoke-waived "<理由>"(理由会跟着这个包留在 bus 记录里)') };
  }
  if (!fs.existsSync(f)) return { bad: `找不到冒烟凭据: ${f}` };
  let done = null;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o = null; try { o = JSON.parse(line); } catch (_) { continue; }
    if (o && o.kind === 'done') done = o;             // 最後の done を採る(追記式なので複数有り得る)
  }
  if (!done) return { bad: `${f} に完走の印(kind:'done')が無い —— 途中で落ちた回の生ログです` };
  const ageH = (Date.now() - Date.parse(done.t)) / 3600000;
  if (!(ageH >= 0) || ageH > SMOKE_MAX_AGE_H) {
    return { bad: `冒烟が古すぎます(${ageH.toFixed(1)}h 前 · 上限 ${SMOKE_MAX_AGE_H}h)。op は其の時の客體に対して験した物なので、もう一度走らせる` };
  }
  if (done.fail) return { bad: `冒烟が ${done.fail} 項赤いまま(PASS=${done.pass})。赤を片付けてから推す`
    + ` —— 套件自身の欠陥なら套件を直す(赤のまま推す道は --smoke-waived だけ)` };
  return { ok: `冒烟: PASS=${done.pass} FAIL=0 · ${ageH.toFixed(1)}h 前 (${path.basename(f)})` };
}

/* 登记簿里第一条 bothub bus。找不到不猜, 让人显式传。 */
function endpointFromRegistry() {
  const f = path.join(paths.dataDir(), 'personas.json');
  if (!fs.existsSync(f)) return null;
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; }
  const list = Array.isArray(j) ? j : (j.personas || []);
  for (const e of list) {
    for (const b of ((e && e.plugins && e.plugins.buses) || [])) {
      if (b && b.kind === 'bothub' && b.base_url) return { url: b.base_url, token: b.token, via: e.name };
    }
  }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  const file = argv[0];
  if (!file || file.startsWith('--')) die('用法: send-package.js <pkg.json> --to <agent>');
  if (!fs.existsSync(file)) die(`找不到包: ${file}`);

  const to = argOf(argv, '--to');
  if (!to) die('--to <agent> 必填: 这个包要投给谁');
  const from = argOf(argv, '--from', 'shipper');

  const text = fs.readFileSync(file, 'utf8');

  // 出货前自验一遍。坏包不该上 bus —— 上了也只是在对面静静地装不上,
  // 而那头的报错日志在别人机器上, 比在这里多绕一整圈。
  const r = signing.openPackage(text);
  if (!r || !r.ok) die(`这个包自己验不过 (${(r && r.code) || 'unknown'}): ${(r && r.message) || ''}`);
  const p = r.payload || {};
  // title 可能是多语言对象 {zh-CN, ja, en} —— 直接塞进模板会印成 [object Object]
  const title = (t) => (typeof t === 'string' ? t : (t && (t['zh-CN'] || t.ja || t.en || Object.values(t)[0])) || '');
  const shown = title(p.title);
  console.log(`包: ${p.type}.${p.id}@${p.version}  ${shown ? `「${shown}」` : ''}`);

  // 🔴 op を持つ包は冒烟の凭据が無いと先へ進まない。bus へ出る前に止める ——
  // 出てしまえば止める手は無い(店側は届いた物を装う)。
  const sm = requireSmoke(p, argv);
  if (sm.bad) die(sm.bad);
  if (sm.ok) console.log(sm.ok);
  if (sm.note) console.log(`⚠ 能力冒烟を飛ばします: ${sm.note.replace(/^⚠ smoke waived: /, '')}`);
  const waiveNote = sm.note || null;

  const reg = endpointFromRegistry();
  const url = argOf(argv, '--url', reg && reg.url);
  const token = argOf(argv, '--token', reg && reg.token);
  if (!url) die('没有 bus 地址: 传 --url, 或在登记簿里配一条 bothub endpoint');
  if (reg && !argv.includes('--url')) console.log(`bus: ${url}  (借自登记簿「${reg.via}」)`);

  // 🔴 坑(狂人 2026-08-20 给的实践): bus 有个 30 分钟去重窗, (from_agent, to_agent, text) 三元组
  // 全等就静默吃掉。插件包最需要重发的场合恰恰是"上一次没装上要再来一次" —— 正文一模一样,
  // 于是重试永远发不出去而且毫无迹象。所以默认正文带包指纹 + 秒级时间戳: 指纹让人一眼看出是哪个包,
  // 时间戳保证正常重试不被吞。
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const fp = require('crypto').createHash('sha256').update(text).digest('hex').slice(0, 8);
  const body = {
    from_agent: from,
    to_agent: to,
    // 冒烟を飛ばした時は理由を正文へ焼き込む —— 投递記録に残る形にしてある(上の requireSmoke)。
    text: argOf(argv, '--text', `装个插件: ${shown || p.id} · ${fp} · ${stamp}`)
      + (waiveNote ? ` · ${waiveNote}` : ''),
    // 🔴 kind 取 signing.PACKAGE_KIND 而不是写死字符串: 收货端认的是同一个常量,
    // 哪天版本号变了两头一起变, 不会一边改一边忘。
    payload: { kind: signing.PACKAGE_KIND, package: text },
  };

  if (argv.includes('--dry')) {
    console.log('--dry: 不发, 只把要发的东西打出来');
    console.log(JSON.stringify({ ...body, payload: { ...body.payload, package: `<${text.length} 字节信封>` } }, null, 2));
    return;
  }

  const endpoint = `${String(url).replace(/\/$/, '')}/send`;
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  const resp = await fetch(endpoint, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const out = await resp.text();
  if (!resp.ok) die(`bus 不收 (HTTP ${resp.status}): ${out.slice(0, 300)}`);

  // 🔴 坑(狂人 2026-08-20): ok 恒为 true, **id 是 null 才是真没发出去**(服务端对某些正文前缀
  // 按设计静默丢弃, 返回 {ok:true, id:null, dropped:'silent'})。只看 ok 会把丢件当成功报上去。
  let j = null;
  try { j = JSON.parse(out); } catch (_) {}
  if (j && j.id == null) die(`bus 把它静默丢了 (dropped=${j.dropped || '?'}): ${out.slice(0, 200)}`);

  console.log(`✓ 已投递 ${from} → ${to}  id=${j ? j.id : '?'}`);
}

/* CLI として起動された時だけ走る。門禁は requireSmoke を直に呼ぶので、require した
   だけで die(process.exit) に落ちない事が要る。 */
if (require.main === module) main().catch((e) => die(e && e.message ? e.message : String(e)));

module.exports = { requireSmoke, SMOKE_MAX_AGE_H };
