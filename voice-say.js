// voice-say.js — 本地 TTS 适配器 (mac: `say` 私有指令 / win: PowerShell System.Speech 原生 SSML)
// 输入: SSML 子集 (见 spec_voice_tts_prosody_annotation_v1_draft.md)
// 输出: 平台原生 TTS 顺序播放 (共享 FIFO 队列防重叠)
// 方向铁律: 本地 TTS · 云端不做 · 见 [[project_butler_voice_tts]]

const { spawn, spawnSync } = require('child_process');

const RATE_BASELINE = 175;   // say 默认 wpm (Tingting 中文合适速度经验值)

// —— 多语/多音色: <voice name="X"> / <lang xml:lang="ja-JP"> 切段 ——
// 音色由 LLM 在 speak 块里自选(默认音色兜底), UI 不再暴露音色选择。

// lang 主标签 → mac say 默认音色 (装了才用, resolveVoice 校验)
const LANG_VOICE = { zh: 'Tingting', yue: 'Sinji', ja: 'Kyoko', en: 'Samantha', ko: 'Yuna', fr: 'Thomas', de: 'Anna', es: 'Mónica' };

// 本机已装音色表 (say -v '?' 一次, 缓存) · lower → 规范名; 同时建 catalog [{name, lang}]
let _installed = null;
let _macCatalog = null;
function installedVoices() {
  if (_installed) return _installed;
  _installed = new Map();
  _macCatalog = [];
  try {
    const out = spawnSync('say', ['-v', '?'], { encoding: 'utf8' }).stdout || '';
    for (const line of out.split('\n')) {
      const m = line.match(/^(.+?)\s{2,}([a-z]{2,3}[_-][A-Za-z]{2,})\s/);   // 名字列(可含空格) + 语言列
      if (m) {
        _installed.set(m[1].trim().toLowerCase(), m[1].trim());
        _macCatalog.push({ name: m[1].trim(), lang: m[2].toLowerCase().replace('_', '-') });
      }
    }
  } catch (_) {}
  return _installed;
}

// Win: SAPI 已装语音异步枚举 (System.Speech 看不见 OneCore 新声, 只列它真读得出来的) · 启动时跑一次
let _winCatalog = null;
function refreshWinVoices() {
  try {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture }",
    ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let buf = '';
    ps.stdout.on('data', (d) => { buf += d.toString(); });
    ps.on('close', () => {
      _winCatalog = buf.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes('|')).map((l) => {
        const i = l.lastIndexOf('|');
        return { name: l.slice(0, i), lang: l.slice(i + 1).toLowerCase() };
      });
    });
    ps.on('error', () => { _winCatalog = []; });
  } catch (_) { _winCatalog = []; }
}
if (process.platform === 'win32') refreshWinVoices();

// 跨平台已装音色目录 [{name, lang}] · win 枚举没回来前返 [] (调用方按"未知"处理)
function voiceCatalog() {
  if (process.platform === 'darwin') { installedVoices(); return _macCatalog || []; }
  if (process.platform === 'win32') return _winCatalog || [];
  return [];
}
// 本机能读的语言主标签, 如 ['zh','ja','en'] · [] = 未知/没枚举完
function availableLangs() {
  const set = new Set();
  for (const v of voiceCatalog()) set.add(String(v.lang).split(/[-_]/)[0]);
  return [...set];
}

// 音色名校验: 没装/不认识 → 回退 fallback, 保底有声
function resolveVoice(name, fallback) {
  if (!name) return fallback;
  return installedVoices().get(String(name).trim().toLowerCase()) || fallback;
}

// 按 <voice>/<lang> 顶层切段 → [{voice, ssml}] · 相邻同音色合并 · say 一进程一音色, 只能逐段播
function splitVoiceSegments(ssml, defaultVoice) {
  let s = String(ssml || '').replace(/^\s*<speak[^>]*>/i, '').replace(/<\/speak>\s*$/i, '');
  const re = /<voice\s+[^>]*?name="([^"]+)"[^>]*>([\s\S]*?)<\/voice>|<lang\s+[^>]*?xml:lang="([^"]+)"[^>]*>([\s\S]*?)<\/lang>/gi;
  const segs = [];
  const push = (voice, text) => {
    if (!text || !text.trim()) return;
    const prev = segs[segs.length - 1];
    if (prev && prev.voice === voice) prev.ssml += text;
    else segs.push({ voice, ssml: text });
  };
  let last = 0, m;
  while ((m = re.exec(s))) {
    push(defaultVoice, s.slice(last, m.index));
    if (m[1] !== undefined) {
      push(resolveVoice(m[1], defaultVoice), m[2]);
    } else {
      const tag = String(m[3]).trim().toLowerCase();
      const primary = /^zh.*(hk|yue)/.test(tag) ? 'yue' : tag.split(/[-_]/)[0];
      push(resolveVoice(LANG_VOICE[primary], defaultVoice), m[4]);
    }
    last = re.lastIndex;
  }
  push(defaultVoice, s.slice(last));
  return segs;
}
const PBAS_BASELINE = 40;    // say 音高基线 (0-100, 40 是中性)
const VOLM_BASELINE = 1.0;   // say 音量基线 · macOS say 默认 = 满(1.0), 之前设 0.5 会让 soft close 后整体半音量(第二段"声音小很多" bug 根因)

// SSML 子集 → macOS say 私有指令
// 支持 5 原语: <break>, <emphasis>, <prosody rate|pitch|volume>, <sub alias>
// 其他所有 XML 标签一律剥掉 (安全兜底)
function ssmlToSay(ssml) {
  if (!ssml) return '';
  let s = String(ssml);

  // 剥 <speak> 外壳
  s = s.replace(/^\s*<speak[^>]*>/i, '').replace(/<\/speak>\s*$/i, '');

  // <break time="Nms" /> → [[slnc N]]
  s = s.replace(/<break\s+time="(\d+)\s*ms"\s*\/?>/gi, (_, ms) => `[[slnc ${ms}]]`);
  s = s.replace(/<break\s+time="([\d.]+)\s*s"\s*\/?>/gi, (_, sec) => `[[slnc ${Math.round(parseFloat(sec) * 1000)}]]`);

  // <emphasis>...</emphasis> → [[emph +]]...[[emph -]] (say 只有 +/-, level 忽略)
  s = s.replace(/<emphasis[^>]*>([\s\S]*?)<\/emphasis>/gi, (_, inner) => `[[emph +]]${inner}[[emph -]]`);

  // <sub alias="Y">X</sub> → Y (读 alias, 不读原文)
  s = s.replace(/<sub[^>]*\balias="([^"]*)"[^>]*>[\s\S]*?<\/sub>/gi, (_, alias) => alias);

  // <prosody rate/pitch/volume>段</prosody> → 前后包 [[rate N]]/[[pbas M]]/[[volm V]]
  // 嵌套支持: loop 替换直到稳定 (regex 非贪婪从内往外, 每 pass 只吃最内层 · 外层下 pass 抓)
  let prevLen;
  do {
    prevLen = s.length;
    s = s.replace(/<prosody([^>]*)>((?:(?!<prosody)[\s\S])*?)<\/prosody>/gi, (_, attrs, inner) => {
    let open = '', close = '';
    const rateM = attrs.match(/\brate="(\d+)\s*%"/i);
    if (rateM) {
      const wpm = Math.max(80, Math.min(400, Math.round(RATE_BASELINE * parseInt(rateM[1], 10) / 100)));
      open += `[[rate ${wpm}]]`;
      close = `[[rate ${RATE_BASELINE}]]` + close;
    }
    const pitchM = attrs.match(/\bpitch="([+-]?\d+)\s*st"/i);
    if (pitchM) {
      // st (半音) → say pbas (0-100 相对基线). 经验值: 每半音 ≈ ±2 pbas 逼近可听差异
      const st = parseInt(pitchM[1], 10);
      const pbas = Math.max(0, Math.min(99, PBAS_BASELINE + st * 2));
      open += `[[pbas ${pbas}]]`;
      close = `[[pbas ${PBAS_BASELINE}]]` + close;
    }
    const volM = attrs.match(/\bvolume="(loud|soft|x-loud|x-soft|medium|default)"/i);
    if (volM) {
      // 相对基线 1.0 的细微化: soft 只降 25%, x-soft 降 50%. 之前 0.35 掉 65% 太狠(用户反馈"差距太大")
      const map = { 'x-soft': 0.5, soft: 0.75, medium: 1.0, default: 1.0, loud: 1.0, 'x-loud': 1.0 };
      const v = map[volM[1].toLowerCase()] || VOLM_BASELINE;
      open += `[[volm ${v}]]`;
      close = `[[volm ${VOLM_BASELINE}]]` + close;
    }
    return open + inner + close;
    });
  } while (s.length !== prevLen && /<prosody/i.test(s));

  // 兜底: 剥掉所有剩余 XML 标签, 防止未识别标签被读出来
  s = s.replace(/<\/?[^>]+>/g, '');

  // 折叠空白
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// 双通道原语 (TTS 侧): <mute>显示不朗读</mute> → 连内容删; <hidden>朗读不显示</hidden> → 只剥壳留内容
// (UI 侧反向: main.js/renderer.js 删 hidden 内容、剥 mute 壳)
function stripForTts(ssml) {
  return String(ssml || '')
    .replace(/<mute\b[^>]*>[\s\S]*?<\/mute>/gi, ' ')
    .replace(/<\/?hidden\b[^>]*>/gi, '');
}

// 从 assistant finalText 里提取 <speak>...</speak> 块 (可能没有 → 返 null)
// 只提第一个 (LLM 每轮应输出至多一个 speak 块)
function extractSpeakBlock(text) {
  if (!text) return null;
  const m = String(text).match(/<speak[\s\S]*?<\/speak>/i);
  return m ? m[0] : null;
}

// FIFO 队列: 上一句播完再播下一句 · 防重叠
// 未来多人格并发 speak 时可以按 sid 拆多队列, 先单队列跑通
let queue = Promise.resolve();
let currentChild = null;   // 打断用
let stopGen = 0;           // stop() 递增 → 正在逐段播的多音色序列剩余段全部作废

function speak(ssml, opts = {}) {
  ssml = stripForTts(ssml);   // mute 内容不进任何平台的 TTS; Win 侧 System.Speech 不认这俩标签, 必须在 normalize 前删掉
  if (process.platform === 'win32') return speakWin(ssml, opts);
  if (process.platform !== 'darwin') return Promise.resolve({ played: false, reason: 'unsupported-platform' });
  return speakMac(ssml, opts);
}

// —— Windows: PowerShell + System.Speech (SAPI) ——
// SAPI 原生吃标准 SSML(break/emphasis/prosody/sub 都是规范标签, 不用像 say 那样翻译成私有指令);
// SpeakSsml 解析失败(引擎不认某属性等)则 catch 降级读纯文本, 保底有声。
// 安全: 脚本是固定字符串; 正文走 stdin, 语音名走环境变量 → 无命令拼接注入面。
const WIN_PS_SCRIPT = [
  '[Console]::InputEncoding=[System.Text.Encoding]::UTF8;',
  'Add-Type -AssemblyName System.Speech;',
  '$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;',
  '$s.SetOutputToDefaultAudioDevice();',
  'if($env:BUTLER_TTS_VOICE){try{$s.SelectVoice($env:BUTLER_TTS_VOICE)}catch{}};',
  '$t=[Console]::In.ReadToEnd();',
  "if($t -match '^\\s*<speak'){try{$s.SpeakSsml($t)}catch{$s.Speak(($t -replace '<[^>]+>',' '))}}else{$s.Speak($t)}",
].join('');

// lang 主标签 → Win 已装音色名 (从 _winCatalog 按 culture 匹配, 全 tag 优先其次主语言)
function winVoiceForLang(tag) {
  const full = String(tag || '').trim().toLowerCase().replace('_', '-');
  const primary = full.split('-')[0];
  const cat = _winCatalog || [];
  const hit = cat.find((v) => v.lang === full) || cat.find((v) => String(v.lang).split(/[-_]/)[0] === primary);
  return hit ? hit.name : null;
}

// SpeakSsml 要求根节点带 version+xmlns; 模型输出的是裸 <speak> → 补齐。
// System.Speech 只认 SSML 1.0, <lang> 是 1.1 元素 → SpeakSsml 直接抛异常掉纯文本兜底(日语切不了的根因)。
// 转法: 目录有匹配音色 → <voice name="真实名">(确定性); 目录没枚举完 → <voice xml:lang>(SAPI 自挑);
// 目录确认没装该语言 → 剥标签保内容(硬给 xml:lang 会抛异常, 整段 SSML 全丢)。
function normalizeSsmlForWin(ssml) {
  return String(ssml).trim()
    .replace(/<voice\b[^>]*?name="([^"]+)"[^>]*>([\s\S]*?)<\/voice>/gi, (_, name, inner) => {
      // mac 音色名(Kyoko 等)反查语言 → 换成 Win 已装音色, 查不到剥标签保内容
      const n = String(name).trim();
      const isWinName = (_winCatalog || []).some((v) => v.name.toLowerCase() === n.toLowerCase());
      const lang = Object.keys(LANG_VOICE).find((k) => LANG_VOICE[k].toLowerCase() === n.toLowerCase());
      const win = isWinName ? n : (lang && winVoiceForLang(lang));
      return win ? `<voice name="${win.replace(/"/g, '&quot;')}">${inner}</voice>` : inner;
    })
    .replace(/<voice\b(?![^>]*\bname=)[^>]*>([\s\S]*?)<\/voice>/gi, '$1')
    .replace(/<lang\s+[^>]*?xml:lang="([^"]+)"[^>]*>([\s\S]*?)<\/lang>/gi, (_, tag, inner) => {
      const name = winVoiceForLang(tag);
      if (name) return `<voice name="${name.replace(/"/g, '&quot;')}">${inner}</voice>`;
      if (!(_winCatalog || []).length) return `<voice xml:lang="${String(tag).replace(/"/g, '&quot;')}">${inner}</voice>`;
      return inner;
    })
    .replace(/^<speak(?![^>]*xmlns)[^>]*>/i,
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">');
}

function speakWin(ssml, opts = {}) {
  const raw = String(ssml || '').trim();
  if (!raw) return Promise.resolve({ played: false, reason: 'empty' });
  const payload = /^<speak/i.test(raw) ? normalizeSsmlForWin(raw) : raw;
  // 语音名: mac 专属名(Tingting)在 Win 无意义 → 不传, 用系统默认语音(中文 Win 通常是 Huihui)
  const voice = opts.voice && !/^tingting$/i.test(String(opts.voice).trim()) ? String(opts.voice).trim() : '';
  queue = queue.then(() => new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_PS_SCRIPT], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { ...process.env, BUTLER_TTS_VOICE: voice },
      windowsHide: true,
    });
    currentChild = child;
    let errBuf = '';
    child.stderr.on('data', (d) => { errBuf += d.toString(); });
    child.on('close', (code) => {
      if (currentChild === child) currentChild = null;
      resolve({ played: code === 0, code, err: errBuf.trim() || null });
    });
    child.on('error', (e) => {
      if (currentChild === child) currentChild = null;
      resolve({ played: false, err: String(e && e.message) });
    });
    child.stdin.end(payload, 'utf8');
  }));
  return queue;
}

// 单段播放: 一个 say 进程一个音色
function playMacSegment(voice, text) {
  return new Promise((resolve) => {
    const child = spawn('say', ['-v', voice], { stdio: ['pipe', 'ignore', 'pipe'] });
    currentChild = child;
    let errBuf = '';
    child.stderr.on('data', (d) => { errBuf += d.toString(); });
    child.on('close', (code) => {
      if (currentChild === child) currentChild = null;
      resolve({ played: code === 0, code, err: errBuf.trim() || null });
    });
    child.on('error', (e) => {
      if (currentChild === child) currentChild = null;
      resolve({ played: false, err: String(e && e.message) });
    });
    child.stdin.end(text);   // stdin 传文本, 免命令行长度/特殊字符限制
  });
}

function speakMac(ssml, opts = {}) {
  const defVoice = resolveVoice(opts.voice, 'Tingting');
  const segs = splitVoiceSegments(ssml, defVoice)
    .map((g) => ({ voice: g.voice, text: ssmlToSay(g.ssml) }))
    .filter((g) => g.text);
  if (!segs.length) return Promise.resolve({ played: false, reason: 'empty' });

  const gen = stopGen;   // 捕获当前代: stop() 后剩余段不播 (kill 只杀得掉当前进程, 后续段要靠这个挡)
  queue = queue.then(async () => {
    let last = { played: false, reason: 'stopped' };
    for (const g of segs) {
      if (gen !== stopGen) return { played: false, reason: 'stopped' };
      last = await playMacSegment(g.voice, g.text);
    }
    return last;
  });
  return queue;
}

// 打断当前播放 + 清队列 (人格切/interrupt/清空时用)
function stop() {
  stopGen += 1;   // 多音色序列剩余段作废
  if (currentChild) {
    try { currentChild.kill('SIGTERM'); } catch (_) {}
    currentChild = null;
  }
  queue = Promise.resolve();
}

module.exports = { speak, stop, extractSpeakBlock, stripForTts, ssmlToSay, splitVoiceSegments, resolveVoice, voiceCatalog, availableLangs, normalizeSsmlForWin, _setWinCatalogForTest: (c) => { _winCatalog = c; } };
