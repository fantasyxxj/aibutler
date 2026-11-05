// fixture-package.js — 门禁共用的「真私钥签过的包」。
//
// 为什么单独一个文件: 这份 base64 曾经被我手抄进第二个门禁, 掉了 4 个字符 —— 结果是
// 验签失败, 而报出来的错是 bad_signature, 看起来像"验签逻辑坏了", 排查方向整个是反的。
// 签名过的东西没有"抄得差不多"这回事, 所以它只能有一份。
//
// 🔴 门禁**不依赖私钥存在**: 签名在我们这台机器上做过一次, 结果焊在这里,
//    任何一台机器上都能跑门禁。私钥只有我们有(~/.butler-signing/), 不进仓库。
'use strict';

const SIGNED_PKG = JSON.stringify({
  kind: 'butler.package.v1',
  alg: 'ed25519',
  key_id: 'brk1',
  payload_b64: 'ewogICJ0eXBlIjogIndvcmtmbG93IiwKICAiaWQiOiAiZGVtb19sZXNzb24iLAogICJ2ZXJzaW9uIjogIjEuMC4wIiwKICAidGl0bGUiOiB7ICJ6aC1DTiI6ICLnpLrkvovor74iLCAiamEiOiAi44K144Oz44OX44Or5o6I5qWtIiwgImVuIjogIkRlbW8gbGVzc29uIiB9LAogICJzdGVwcyI6IFsKICAgIHsgImlkIjogInMxIiwgIm1kIjogeyAiemgtQ04iOiAiIyMjIOesrOS4gOatpVxu5YWI55yL6L+Z6YeM44CCIiwgImphIjogIiMjIyDkuIDmrannm65cbuOBvuOBmuOBk+OBk+OAgiIgfSB9LAogICAgeyAiaWQiOiAiczIiLCAibWQiOiAiIyMjIOesrOS6jOatpVxu5YaN55yL6L+Z6YeM44CCIiB9LAogICAgeyAiaWQiOiAiczMiLCAibWQiOiB7ICJ6aC1DTiI6ICIjIyMg56ys5LiJ5q2lXG7mlLblsL7jgIIiLCAiZW4iOiAiIyMjIFN0ZXAgM1xuV3JhcCB1cC4iIH0gfQogIF0KfQo=',
  sig_b64: 'Q4ArJBw2feZiERzfnQRLZxxAbhVmRaoH5ZZtsFTEdUL4lW/H3NFbtXOAV+yv4y/Fa8AT/Lg2D6Cxn/KK/N6UDA==',
});

module.exports = { SIGNED_PKG };
