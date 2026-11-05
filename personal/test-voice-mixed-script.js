// test-voice-mixed-script.js — 日中混在の本文を、どの音色で読むか。
// 跑法: node personal/test-voice-mixed-script.js
//
// 🔴 この層が在る理由: 2026-09-28 作者が「日本語と中国語が混ざっているのに中国語音色で
//    全部読み上げられる」を実際に聞いた。原因は mac 側の音色決定が **硬編碼の名前表**
//    (LANG_VOICE.ja = 'Kyoko') だけで、入っていなければ既定音色に落ちる事。客の機械に何が
//    入っているかは `say -v '?'` で訊けるのだから、名前ではなくカタログから選ぶ。
//    判据は二つ: ① 日本語の段が日本語音色に回るか ② その音色が無い機械では**読まないか**。
const V = require('../core/voice-say.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

// ① かなの有無で切れるか
const segs = V.splitByScript('予約を承りました。已经记下了。');
ok(segs.length === 2, 'かなの段と中文の段に切れる');
ok(segs[0].lang === 'ja' && /予約/.test(segs[0].text), '前段は日本語と判る');
ok(segs[1].lang === null && /已经/.test(segs[1].text), '後段は判定を保留(既定音色に任せる)');

// ② 漢字だけの文は触らない —— 日中どちらとも取れる物を決め付けない
ok(V.splitByScript('刺身盛合')[0].lang === null, '漢字だけの段は ja と決め付けない');

// ③ 音色は名前決め打ちではなく、本機のカタログから選ぶ
V._setMacCatalogForTest([{ name: 'Tingting', lang: 'zh-cn' }, { name: 'Otoya', lang: 'ja-jp' }]);
ok(V.macVoiceForLang('ja-JP') === 'Otoya', 'Kyoko が無ければ同じ言語の Otoya を拾う');
ok(V.macVoiceForLang('zh-CN') === 'Tingting', '中国語は Tingting');

V._setMacCatalogForTest([{ name: 'Kyoko', lang: 'ja-jp' }, { name: 'Tingting', lang: 'zh-cn' }]);
ok(V.macVoiceForLang('ja') === 'Kyoko', '第一候補が入っていればそれを使う');

// ④ 日本語音色が一つも無い機械では null —— 呼び出し側はこの段を読み飛ばす
V._setMacCatalogForTest([{ name: 'Tingting', lang: 'zh-cn' }]);
ok(V.macVoiceForLang('ja') === null, '日本語音色が無ければ null(既定音色で代読しない)');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
