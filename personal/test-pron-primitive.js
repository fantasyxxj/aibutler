// test-pron-primitive.js — 发音评测(pron 原语 + core/pron-assess.js)。跑法: node test-pron-primitive.js
//
// 守的是「插件能评测, 但 key 只在宿主手里」这句话:
//   ①key 存得进、查得到设没设和哪个区, 读不出原文 ②不给区就拿 key 去各区试, 认出来的区一起存
//   ③评的只能是本包录的那段 ④人格调不到(花的是用户自己的额度)
'use strict';

require('./host-wiring');
const fs = require('fs');
const os = require('os');
const path = require('path');
const commands = require('../core/commands.js');
const bridge = require('../core/record-bridge.js');
const { PkgSecrets } = require('../core/pkg-secrets.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };
const cipher = { available: () => true, encrypt: (t) => Buffer.from('X' + t), decrypt: (b) => b.toString().slice(1) };

function wav(sec) {
  const n = 16000 * sec, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pron-'));
  const seen = [];
  // 假 Azure: 只有 eastasia 认 GOOD 这把 key; 评测回一句固定结果
  const fakeFetch = async (url, opt) => {
    seen.push({ url, headers: opt.headers });
    if (url.includes('/issueToken')) {
      const good = opt.headers['Ocp-Apim-Subscription-Key'] === 'GOOD' && url.startsWith('https://eastasia.');
      return { status: good ? 200 : 401 };
    }
    if (opt.headers['Ocp-Apim-Subscription-Key'] !== 'GOOD') return { status: 401, ok: false };
    return { status: 200, ok: true, json: async () => ({ RecognitionStatus: 'Success', DisplayText: 'Hello world.',
      NBest: [{ PronunciationAssessment: { PronScore: 88.4, AccuracyScore: 90, FluencyScore: 85, CompletenessScore: 100, ProsodyScore: 80 },
        Words: [{ Word: 'hello', PronunciationAssessment: { AccuracyScore: 95, ErrorType: 'None' } },
                { Word: 'world', PronunciationAssessment: { AccuracyScore: 40, ErrorType: 'Mispronunciation' } }] }] }) };
  };
  const vault = new PkgSecrets(path.join(root, 'secrets.bin'), cipher);
  fs.mkdirSync(path.join(root, 'rec', 'pc'), { recursive: true });
  fs.writeFileSync(path.join(root, 'rec', 'pc', 'r1.wav'), wav(1));
  fs.writeFileSync(path.join(root, 'rec', 'pc', 'long.wav'), wav(61));
  fs.mkdirSync(path.join(root, 'rec', 'other'), { recursive: true });
  fs.writeFileSync(path.join(root, 'rec', 'other', 'r2.wav'), wav(1));
  const pronAssess = require('../core/pron-assess.js');
  // 假引擎: 记下收到什么, 回一份 SDK 那样的两段结果给 merge 合并
  const engineSeen = [];
  const fakeEngine = async (o) => {
    engineSeen.push(o);
    if (o.key !== 'GOOD') throw Object.assign(new Error('auth'), { code: 'bad_key' });
    if (pronAssess.wavSec(o.wav) > 30) throw Object.assign(new Error('too long for fake'), { code: 'assess_failed' });
    return pronAssess.merge([
      { DisplayText: 'Hello world.', Duration: 10000000, NBest: [{ PronunciationAssessment: { PronScore: 80, AccuracyScore: 90, FluencyScore: 80, ProsodyScore: 70 },
        Words: [{ Word: 'hello', Offset: 0, Duration: 4000000, PronunciationAssessment: { AccuracyScore: 95, ErrorType: 'None' } },
                { Word: 'world', Offset: 5000000, Duration: 4000000, PronunciationAssessment: { AccuracyScore: 40, ErrorType: 'Mispronunciation' } }] }] },
      { DisplayText: 'Um, yes.', Duration: 30000000, NBest: [{ PronunciationAssessment: { PronScore: 60, AccuracyScore: 70, FluencyScore: 60, ProsodyScore: 50 },
        Words: [{ Word: 'um', Offset: 40000000, Duration: 3000000, PronunciationAssessment: { AccuracyScore: 90, ErrorType: 'None' } },
                { Word: 'yes', Offset: 45000000, Duration: 3000000, PronunciationAssessment: { AccuracyScore: 90, ErrorType: 'None' } }] }] },
    ], pronAssess.wavSec(o.wav));
  };
  const ctx = { pkgSecrets: vault, fetch: fakeFetch, pronEngine: fakeEngine, recordFile: (pkg, id) => bridge.readRecording(path.join(root, 'rec'), pkg, id) };

  commands.pkgCommandsReset && commands.pkgCommandsReset();
  const d = (op, extra = {}) => ({ primitive: 'pron', op, ...extra });
  const reg = commands.registerPackageCommands('pc', {
    status: d('status'), key_set: d('key_set', { ai: true }), key_clear: d('key_clear'), assess: d('assess'),
  });

  console.log('\n[1] 登记');
  ok(reg.added.length === 4, 'pron 原语四条命令都登记得上');
  ok(commands.catalog()['pc.key_set'].ai === false, '写了 ai:true 也只给人按 —— 花的是用户自己的额度');
  ok(commands.notifyAi('pc.assess') === false, '评完默认不叫醒 AI');

  console.log('\n[2] key');
  let r = await commands.run('pc.status', {}, ctx);
  ok(r.ok && r.data.set === false && r.data.regions.includes('japaneast'), '起初没 key, 回区列表给下拉框');
  r = await commands.run('pc.key_set', { key: 'BAD' }, ctx);
  ok(!r.ok && r.code === 'bad_key', '哪个区都不认的 key 不存');
  r = await commands.run('pc.key_set', { key: 'GOOD', region: 'japaneast' }, ctx);
  ok(!r.ok && r.code === 'bad_key', '手选的区不认这把 key 就不存');
  r = await commands.run('pc.key_set', { key: 'GOOD' }, ctx);
  ok(r.ok && r.data.region === 'eastasia', `不给区就自动认出来(${r.data && r.data.region})`);
  r = await commands.run('pc.status', {}, ctx);
  ok(r.ok && r.data.set === true && r.data.region === 'eastasia' && !JSON.stringify(r).includes('GOOD'), 'status 只说设没设和区, 不带 key 原文');

  console.log('\n[3] 评测');
  r = await commands.run('pc.assess', { id: 'r1', text: 'Hello world', lang: 'en-GB' }, ctx);
  ok(r.ok && r.data.score === 65 && r.data.words[1].error === 'Mispronunciation', `分数按每段时长加权合并(${r.data && r.data.score})`);
  const e0 = engineSeen[engineSeen.length - 1];
  ok(e0.region === 'eastasia' && e0.lang === 'en-GB' && e0.reference === 'Hello world' && e0.key === 'GOOD', '按存下的区、给的语言和原文去评, key 由宿主取');
  ok(r.data.heard === 'Hello world. Um, yes.' && r.data.fillers === 1 && r.data.long_pauses === 1, '听到的文字拼起来, 数出 1 个填充词和 1 次 >2 秒停顿');
  r = await commands.run('pc.assess', { id: 'r1', lang: 'en-GB' }, ctx);
  ok(r.ok && engineSeen[engineSeen.length - 1].reference === '', '不给原文 = 自由回答, 照样评');
  r = await commands.run('pc.assess', { id: 'r2', text: 'x' }, ctx);
  ok(!r.ok && r.code === 'recording_not_found', '别的包录的那段评不了');
  r = await commands.run('pc.assess', { id: 'long', text: 'x' }, ctx);
  ok(!r.ok && r.code === 'assess_failed', '引擎报错原样说出来, 不吞');
  r = await commands.run('pc.assess', { id: 'r1', text: 'x', lang: 'english' }, ctx);
  ok(!r.ok && r.code === 'bad_param', '语言要写成 en-US 这种形状');

  console.log('\n[4] 清除');
  await commands.run('pc.key_clear', {}, ctx);
  r = await commands.run('pc.assess', { id: 'r1', text: 'Hello world' }, ctx);
  ok(!r.ok && r.code === 'no_key', '清掉 key 以后评不了, 说清楚');

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${fail ? '❌' : '✅'} test-pron-primitive: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
