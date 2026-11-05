// i18n-pick.js — 从一个多语对象 {ja,'zh-CN','zh-TW',en} 里挑出当前语言那一份。
//
// 🔴 全仓唯一实现, 两个运行时共用一份文件(Node 侧 require, renderer 侧 <script> 挂 window)。
//    这段逻辑此前被各自抄了十几遍, 兜底各写各的 —— 有的落 ja, 有的写死 zh-CN, 有的落 en。
//    于是「挑不到当前语言时不许落日语」这条改了一处, 另外十几处照旧, 永远扫不干净。
//    要改兜底规则, 只改这里。
//
// 顺序: 当前语言 → 中文近邻(简繁互兜) → 英语 → 对象里的第一个。
// 🔴 兜底是英语不是日语: 四种语言都是一等公民, 没有主市场。
// 简繁互兜排在英语前面: 对看得懂中文的人, 另一种中文比英文近。

(function () {
  'use strict';

  const ZH_SIBLING = { 'zh-CN': 'zh-TW', 'zh-TW': 'zh-CN' };

  // 字符串原样返回 —— 只有一种语言的包没理由被逼着写成对象。
  function pickLang(dict, locale) {
    if (dict == null) return '';
    if (typeof dict !== 'object') return String(dict);
    const sib = ZH_SIBLING[locale];
    return dict[locale] || (sib ? dict[sib] : '') || dict.en || Object.values(dict)[0] || '';
  }

  // 服务端回的错误只有码和插值, 屏幕上那句话在这边按界面语言查出来 —— 服务端的
  // message 是写给运维看的, 贴上去就是日文界面弹中文。
  // 插值位带序号(`{0}`)而不是裸 `{}`: 各语言语序不同, 位置参数会把值配错对象。
  // 查不到这个码时回空串, 由调用方决定兜底文案 —— 这里编不出比"未知错误"更有用的话。
  function formatErrorText(catalog, code, args, locale) {
    const entry = catalog && catalog[code];
    if (!entry) return '';
    const text = pickLang(entry, locale);
    if (!args || !args.length) return text;
    return text.replace(/\{(\d+)\}/g, (whole, i) => {
      const v = args[Number(i)];
      return v === undefined || v === null ? whole : String(v);
    });
  }

  const api = { pickLang, formatErrorText, ZH_SIBLING };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.I18nPick = api;
})();
