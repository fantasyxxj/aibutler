// package-inbox.js — bus 上运来的包, 在这里下车。
//
// butler 本来就有一条 bus 通路(消息进进出出)。包不是新造一条路 —— 它就是那条路上的
// 一种消息。所以这里要做的只有一件事: 把「这条是包」从消息流里挑出来, 交给 packages.install,
// 剩下的原样放行。
//
// 🔴 包**不进 AI**。这不是省钱的小聪明, 是这个文件存在的主要理由:
//    走 AI 就变成「每来一个包烧一次模型」, 而且多出「模型看错一个字段就装错包 / 漏装」
//    的余地。装不装、装成功没有, 全部由确定性代码说了算, 模型没有插手的位置。
//    (同一条判据早已定过一次: 手顺翻页 18 步也一次模型都不叫。)
//
// 🔴 这里**不做验签**。验签只有 signing.js 一处, 落地只有 packages.install 一处 ——
//    收货口多一处"看起来也在检查"的代码, 就多一处哪天悄悄和真闸走偏的地方。
//    这个文件对包的内容一无所知, 它只管认出信封、递进去、把结果说清楚。
//
// 两仓(个人版 butler / 行业版 industry-butler)**逐字节同一份**, 跟 signing.js / packages.js
// 一样 —— 经路不同(个人版 agent-bus 轮询 / 行业版双 bus), 但"什么算包、装完怎么算数"必须一致。
'use strict';

const signing = require('./signing');

// 包在 bus 上的名字, 直接复用信封自己的种别 —— 另起一个名字就等于同一件事有两个真相,
// 改了一处忘了另一处的那天, 症状是"包送到了但永远不装", 而且两边看起来都对。
const MSG_KIND = signing.PACKAGE_KIND;   // 'butler.package.v1'

/* 这条消息是不是包。
   判据只看 payload.kind —— 不去猜 text、不去嗅内容。消息的种别是发的人明写的,
   靠猜的话, 哪天有人在聊天里贴一段包的 JSON 就会被当成下发物。 */
function isPackageMsg(m) {
  return !!(m && m.payload && m.payload.kind === MSG_KIND && m.payload.package != null);
}

/* 取出信封文本。bus 那头可能把信封当字符串发, 也可能当对象发(JSON 通道会自然解开一层)。
   两种都收: 对象就再串回去。**这不影响签名** —— 签的是信封里 payload_b64 那段字节,
   信封本身怎么排版、键什么顺序, 一个字都不参与验签(signing.js 开头写死的那条)。 */
function envelopeText(m) {
  const p = m && m.payload && m.payload.package;
  if (typeof p === 'string') return p;
  if (p && typeof p === 'object') {
    try { return JSON.stringify(p); } catch (_) { return null; }
  }
  return null;
}

/* 收一个包(已经确定它是包了)。
   两条 bus 的形状不一样: 个人版的包是消息流里的一条(payload.kind 认出来),
   行业版的包是一个带 type 的事件(路由那层就分好了)。所以真正共用的是这一颗 ——
   宿主各按各的形状认出包, 认出之后走同一个口。
   (让宿主去伪造成另一版的消息形状才能调用, 是把"两版共用"做成了"两版互相将就"。)

   pkg 可以是信封文本, 也可以是已经解开一层的对象 —— **不影响验签**:
   签的是信封里 payload_b64 那段字节, 信封本身怎么排版、键什么顺序都不参与。 */
function installOne(pkg, { install } = {}) {
  const text = typeof pkg === 'string' ? pkg
    : (pkg && typeof pkg === 'object' ? (() => { try { return JSON.stringify(pkg); } catch (_) { return null; } })() : null);
  if (!text) return { ok: false, code: 'malformed', message: '包这一栏是空的或读不出来' };
  if (typeof install !== 'function') return { ok: false, code: 'no_installer', message: '宿主没有接收装包的口' };
  // 落盘可能因磁盘满/权限炸。抛出去会把调用方正在处理的一整批打断, 后面的消息跟着消失。
  try { return install(text); } catch (e) {
    return { ok: false, code: 'install_threw', message: (e && e.message) || String(e) };
  }
}

/* 从一批 bus 消息里把包卸下来。
     msgs    : bus 拿到的消息数组
     install : (envelopeText) => {ok, type, id, version} | {ok:false, code, message}
               宿主注入 —— 这个文件不知道数据目录在哪, 也不该知道。
   返回 { installed, failed, rest }:
     rest = 不是包的消息, 原样交回给宿主的唤醒逻辑(该叫 AI 还是叫)。
     包无论装成功还是失败都**不在 rest 里** —— 装失败也不该丢给 AI:
     它对此无能为力(重签包是我们的事), 只会白烧一轮然后跟用户道歉。 */
function takeFromMessages(msgs, { install } = {}) {
  const installed = [], failed = [], rest = [];
  for (const m of msgs || []) {
    if (!isPackageMsg(m)) { rest.push(m); continue; }

    const r = installOne(m.payload.package, { install });
    if (r && r.ok) installed.push({ id: m.id, type: r.type, pkgId: r.id, version: r.version });
    else failed.push({ id: m.id, code: (r && r.code) || 'unknown', message: (r && r.message) || '装不上' });
  }
  return { installed, failed, rest };
}

module.exports = { MSG_KIND, isPackageMsg, envelopeText, installOne, takeFromMessages };
