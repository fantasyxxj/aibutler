'use strict';
// pron-assess.js — 发音评测: 一段 16kHz mono wav + 原文 + 语言, 交给微软口语评分(Azure Pronunciation Assessment),
// 拿回整段的分和每个词的分。教育版跟读打分和个人版的 pron 原语共用这一份。
//
// key 是用户自己在 Azure 开的, 属于开 key 时选的那个区(之后改不了), 网址里要带区名。
// 用户多半不记得区, 所以 detectRegion 拿 key 去各区换一次临时令牌(issueToken, 不计费), 哪个区认就是哪个。
// 走的是 REST 短音频接口: 一次最多 60 秒。

const REGIONS = [
  'japaneast', 'japanwest', 'eastasia', 'southeastasia', 'koreacentral', 'centralindia', 'australiaeast',
  'eastus', 'eastus2', 'westus', 'westus2', 'westus3', 'centralus', 'northcentralus', 'southcentralus', 'westcentralus',
  'canadacentral', 'brazilsouth', 'northeurope', 'westeurope', 'uksouth', 'francecentral', 'germanywestcentral',
  'switzerlandnorth', 'swedencentral', 'norwayeast', 'italynorth', 'uaenorth', 'qatarcentral', 'southafricanorth',
];
const REGION_RE = /^[a-z0-9]{3,32}$/;
const MAX_SEC = 60;

function wavSec(buf) {
  if (!buf || buf.length < 44) return 0;
  return (buf.length - 44) / (buf.readUInt32LE(28) || 32000);
}

// 这把 key 在这个区认不认: true / false / null(网络不通, 判不了)
async function keyWorksIn(key, region, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
      method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Length': '0' }, signal: AbortSignal.timeout(8000) });
    return r.status === 200 ? true : (r.status === 401 || r.status === 403 ? false : null);
  } catch (_) { return null; }
}

// → 区名, 或 '' (哪个区都不认)。并发试, 先认的赢
async function detectRegion(key, fetchImpl = fetch) {
  return new Promise((resolve) => {
    let left = REGIONS.length, done = false;
    for (const rg of REGIONS) {
      keyWorksIn(key, rg, fetchImpl).then((ok) => {
        if (done) return;
        if (ok === true) { done = true; resolve(rg); return; }
        if (--left === 0) resolve('');
      });
    }
  });
}

/* → { heard, score, accuracy, fluency, completeness, prosody, words:[{word, score, error}] }
   error 是 Azure 的 ErrorType: None / Mispronunciation / Omission(漏读) / Insertion(多读) / … */
async function assess({ wav, reference, lang = 'en-US', key, region, fetchImpl = fetch }) {
  if (!key || !REGION_RE.test(String(region || ''))) throw Object.assign(new Error('no key'), { code: 'no_key' });
  if (wavSec(wav) > MAX_SEC) throw Object.assign(new Error(`longer than ${MAX_SEC}s`), { code: 'too_long' });
  const pa = Buffer.from(JSON.stringify({
    ReferenceText: reference, GradingSystem: 'HundredMark', Granularity: 'Phoneme', Dimension: 'Comprehensive',
    EnableMiscue: true, EnableProsodyAssessment: lang === 'en-US',
  })).toString('base64');
  const url = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`
            + `?language=${encodeURIComponent(lang)}&format=detailed`;
  const res = await fetchImpl(url, { method: 'POST', body: wav, signal: AbortSignal.timeout(30000), headers: {
    'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
    'Pronunciation-Assessment': pa, Accept: 'application/json' } });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`azure ${res.status}`), { code: 'bad_key' });
  if (!res.ok) throw Object.assign(new Error(`azure ${res.status}`), { code: 'assess_failed' });
  const j = await res.json();
  const n = j.NBest && j.NBest[0];
  if (!n) return { heard: '', score: 0, words: [], status: j.RecognitionStatus };
  const p = n.PronunciationAssessment || n;   // 新旧两种返回形状都认
  const r = (x) => (x == null ? null : Math.round(x));
  return {
    heard: j.DisplayText || '', score: r(p.PronScore) || 0, accuracy: r(p.AccuracyScore), fluency: r(p.FluencyScore),
    completeness: r(p.CompletenessScore), prosody: r(p.ProsodyScore),
    words: (n.Words || []).map((w) => {
      const q = w.PronunciationAssessment || w;
      return { word: w.Word, score: r(q.AccuracyScore) || 0, error: q.ErrorType || 'None' };
    }),
  };
}

/* 连续识别版(微软 Speech SDK): 自由回答和长段朗读用这个。REST 短音频那条遇到 2 秒多的停顿就当说完了,
   后面的话评不到, 没有原文时也不给分(11-02 实测); SDK 连续识别跨停顿接着认, 没有原文也给准确/流利/韵律。
   reference 为空 = 自由回答。返回在 assess 的形状上多了: words[].offset_ms/dur_ms · duration_sec · wpm ·
   long_pauses(词与词之间 > 2 秒) · fillers(um/uh/er… 的次数) · segments。分数按每段时长加权合并。
   SDK 只有个人版装了(package.json), 所以在这里才 require —— 没装的版本调不到这条, 也不会开机就崩。 */
const FILLERS = new Set(['um', 'uh', 'er', 'erm', 'ah', 'hmm', 'mm', 'えー', 'えーと', 'えっと', 'あの', 'あのー', 'うーん']);
const LONG_PAUSE_MS = 2000;
const TICK = 10000;   // SDK 的时间单位是 100 纳秒

function stripWavToPcm(buf) {
  // SDK 只认最规整的 44 字节头; 我们自己录的就是这个形状, 别处来的照数据块重封一次
  if (buf.toString('ascii', 36, 40) === 'data') return buf;
  const i = buf.indexOf('data', 12, 'ascii');
  if (i < 0) return buf;
  const pcm = buf.subarray(i + 8);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function merge(segs, totalSec) {
  const words = [];
  const acc = { accuracy: 0, fluency: 0, completeness: 0, prosody: 0, score: 0 };
  const has = { prosody: false, completeness: false };
  let wsum = 0;
  for (const j of segs) {
    const n = j.NBest && j.NBest[0];
    if (!n) continue;
    const p = n.PronunciationAssessment || {};
    const w = Math.max(1, j.Duration || 1);
    wsum += w;
    acc.accuracy += (p.AccuracyScore || 0) * w; acc.fluency += (p.FluencyScore || 0) * w; acc.score += (p.PronScore || 0) * w;
    if (p.CompletenessScore != null) { acc.completeness += p.CompletenessScore * w; has.completeness = true; }
    if (p.ProsodyScore != null) { acc.prosody += p.ProsodyScore * w; has.prosody = true; }
    for (const x of n.Words || []) {
      const q = x.PronunciationAssessment || {};
      words.push({ word: x.Word, score: Math.round(q.AccuracyScore || 0), error: q.ErrorType || 'None',
                   offset_ms: Math.round((x.Offset || 0) / TICK), dur_ms: Math.round((x.Duration || 0) / TICK) });
    }
  }
  const avg = (k) => (wsum ? Math.round(acc[k] / wsum) : 0);
  const spoken = words.filter((w) => w.error !== 'Omission');
  let long = 0;
  for (let i = 1; i < spoken.length; i++) {
    if (spoken[i].offset_ms - (spoken[i - 1].offset_ms + spoken[i - 1].dur_ms) > LONG_PAUSE_MS) long++;
  }
  const fillers = spoken.filter((w) => FILLERS.has(String(w.word).toLowerCase())).length;
  const content = spoken.filter((w) => !FILLERS.has(String(w.word).toLowerCase())).length;
  return {
    heard: segs.map((j) => j.DisplayText || '').filter(Boolean).join(' '),
    score: avg('score'), accuracy: avg('accuracy'), fluency: avg('fluency'),
    completeness: has.completeness ? avg('completeness') : null, prosody: has.prosody ? avg('prosody') : null,
    words, duration_sec: Math.round(totalSec * 10) / 10,
    wpm: totalSec > 0 ? Math.round(content / (totalSec / 60)) : 0,
    long_pauses: long, fillers, segments: segs.length,
  };
}

async function assessStream({ wav, reference = '', lang = 'en-US', key, region, timeoutMs = 180000 }) {
  if (!key || !REGION_RE.test(String(region || ''))) throw Object.assign(new Error('no key'), { code: 'no_key' });
  const sdk = require('microsoft-cognitiveservices-speech-sdk');
  const sc = sdk.SpeechConfig.fromSubscription(key, region);
  sc.speechRecognitionLanguage = lang;
  sc.outputFormat = sdk.OutputFormat.Detailed;
  sc.setProperty('SpeechServiceResponse_PostProcessingOption', 'None');   // 留住 um/uh, 流利度要数它们
  const audio = sdk.AudioConfig.fromWavFileInput(stripWavToPcm(wav));
  const rec = new sdk.SpeechRecognizer(sc, audio);
  const pc = new sdk.PronunciationAssessmentConfig(reference, sdk.PronunciationAssessmentGradingSystem.HundredMark,
    sdk.PronunciationAssessmentGranularity.Phoneme, !!reference);
  if (lang === 'en-US' || lang === 'en-GB') pc.enableProsodyAssessment = true;
  pc.applyTo(rec);
  const segs = [];
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return; done = true; clearTimeout(timer);
      rec.stopContinuousRecognitionAsync(() => rec.close(), () => rec.close());
      if (err) reject(err); else resolve(merge(segs, wavSec(wav)));
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('timeout'), { code: 'assess_failed' })), timeoutMs);
    rec.recognized = (_s, e) => {
      if (e.result.reason !== sdk.ResultReason.RecognizedSpeech) return;
      try { segs.push(JSON.parse(e.result.properties.getProperty(sdk.PropertyId.SpeechServiceResponse_JsonResult))); } catch (_) {}
    };
    rec.canceled = (_s, e) => {
      if (e.reason === sdk.CancellationReason.EndOfStream) return finish();
      const auth = e.errorCode === sdk.CancellationErrorCode.AuthenticationFailure;
      finish(Object.assign(new Error(e.errorDetails || 'canceled'), { code: auth ? 'bad_key' : 'assess_failed' }));
    };
    rec.sessionStopped = () => finish();
    rec.startContinuousRecognitionAsync(() => {}, (err) => finish(Object.assign(new Error(String(err)), { code: 'assess_failed' })));
  });
}

module.exports = { assess, assessStream, merge, detectRegion, keyWorksIn, wavSec, REGIONS, MAX_SEC };
