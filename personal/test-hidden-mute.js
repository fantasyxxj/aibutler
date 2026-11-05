// 冒烟: <hidden>/<mute> 双通道原语 — node test-hidden-mute.js
const assert = require('assert');
const vs = require('../core/voice-say');

// —— TTS 侧 ——
const ssml = '<speak>请听题<break time="300ms"/><hidden><lang xml:lang="ja-JP">男の人が話しています。何を買いますか。</lang></hidden><mute>A. りんご B. みかん C. バナナ</mute>选好了告诉我</speak>';
const tts = vs.stripForTts(ssml);
assert(!/mute/.test(tts) && !/りんご/.test(tts), 'mute 内容要从 TTS 删掉');
assert(!/<\/?hidden/.test(tts) && /話しています/.test(tts), 'hidden 剥壳留内容给 TTS');
const segs = vs.splitVoiceSegments(tts, 'Tingting').map((g) => ({ v: g.voice, t: vs.ssmlToSay(g.ssml) }));
assert(segs.some((g) => /話しています/.test(g.t)), '日语段进 say');
assert(!segs.some((g) => /りんご/.test(g.t)), '选项不进 say');
const win = vs.normalizeSsmlForWin(tts);
assert(!/<\/?(hidden|mute)/.test(win), 'Win SSML 不残留非标标签');

// —— UI 侧 —— 与 TTS 侧同住 core/voice-say.js, 直接 require(以前它们埋在 main.js 里, 只能从源码切片跑)
const { stripSsmlTags, makeHiddenStreamFilter } = vs;

const clean = stripSsmlTags(ssml);
assert(!/話しています/.test(clean), 'hidden 内容不显示');
assert(/りんご/.test(clean) && !/<\/?mute/.test(clean), 'mute 剥壳留内容显示');
assert(/请听题/.test(clean) && /选好了告诉我/.test(clean), '普通正文正常显示');

// 流式: hidden 跨 chunk + 标签本身被劈开
const f = makeHiddenStreamFilter();
const chunks = ['请听题<hid', 'den>男の人が', '話しています', '。</hi', 'dden><mute>A. りんご</mute>好'];
const out = chunks.map((c) => f(c)).join('');
assert(!/話し|男の人/.test(out), '流式不闪现 hidden 内容, got: ' + out);
assert(/请听题/.test(out) && /好/.test(out), '流式正文完整, got: ' + out);
assert(/りんご/.test(out), '流式 mute 内容照常显示(壳由 stripSsmlTags 剥), got: ' + out);

// 复位: 上轮没闭合不吞下轮
const f2 = makeHiddenStreamFilter();
f2('<hidden>没闭合');
f2.reset();
assert(f2('新回合正文') === '新回合正文', 'reset 后不吞正文');

// —— 影子拷贝守卫 ——
// renderer 跑在浏览器上下文, require 不了 node 模块, 那两条正则只能在它那儿再写一份(跨 chunk
// 边界漏出的标签靠它收尾剥)。副本消灭不掉, 就用门禁盯着它别漂: 靠人记得同步是靠不住的。
const rsrc = require('fs').readFileSync(__dirname + '/renderer/renderer.js', 'utf8');
for (const [name, re] of [['SSML_TAG_RE', vs.SSML_TAG_RE], ['SSML_HIDDEN_RE', vs.SSML_HIDDEN_RE]]) {
  const m = new RegExp(`const ${name} = (/.*/)[a-z]*;`).exec(rsrc);
  assert(m, `renderer.js 里找不到 ${name} —— 副本没了就把本条守卫一起删掉`);
  assert(m[1].slice(1, -1) === re.source, `${name} 与 core/voice-say.js 漂了:\n  renderer: ${m[1]}\n  core:     /${re.source}/`);
}

console.log('✅ hidden/mute 双通道全过 · renderer 副本未漂');
