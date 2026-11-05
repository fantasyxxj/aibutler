// record-host.js — record 原语的宿主页侧。主进程(core/record-bridge.js)发 record-op, 这里开麦 / 录 / 停 / 放, 再回话。
// 做法跟教育版话筒(education/app/renderer/mic.js)一样, 因为是同一个问题: 人一按下就开口, 而打开麦克风要时间。
//   · warm: 插件一显示就调。之后每秒看一次, 三条都满足才开着麦(内存里只循环留最近 0.5 秒, 不存不外发):
//     窗口在前台 · 有 warm 过的包的面板在屏幕上(滚走了、卸载了、切到别的标签都算不在) · 2 分钟内有人用过。
//     任一条不满足就关; 面板重新回到屏幕上, 2 分钟从头算。关着的时候按下, 现开麦, 那一次没有前 0.5 秒。
//   · start 时把这 0.5 秒接在最前面; stop 时再多收 0.5 秒才停 —— 最后一个词常常是边说边松手。
//   · 采音走音频线程(record-worklet.js), 交回前降到 16kHz mono —— 评分服务吃的就是这个格式。
// 🔴 到 maxMs 自己停, 录好的先攥在手里等 stop 来取 —— 包忘了 stop, 也不会一直录。
(function () {
  // 个人版 preload 叫 butler, 行业版叫 shopAssistant —— 两版同一份文件
  const api = window.butler || window.shopAssistant;
  if (!api || !api.onRecordOp) return;
  const PRE_SEC = 0.5, TAIL_MS = 500, IDLE_MS = 2 * 60 * 1000;
  let mic = null;          // { stream, ctx, node, ring, rp, live, ready, sr }
  let opening = null;
  let rec = null;          // { chunks, timer }
  let held = null;         // 到点自停后攥着的 wav
  const warmed = new Set();   // warm 过的包 id
  let lastUse = 0, wasShown = false, ticker = null;
  let starting = false;      // 按下后现开麦那一段: 每秒的检查不许在这时关麦(否则窗口不在前台时一按就被关掉)

  async function openMic() {
    if (mic) return mic;
    if (opening) return opening;
    opening = (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const ctx = new AudioContext();
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (_) {} }
      await ctx.audioWorklet.addModule('record-worklet.js');
      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'record-tap');
      const sr = ctx.sampleRate;
      const m = { stream, ctx, node, sr, ring: new Float32Array(Math.round(sr * PRE_SEC)), rp: 0, live: false };
      // 刚打开的麦克风前半秒多送来的全是 0(教育版实测 0.6 秒): 等第一帧真声音到了才算开好
      m.ready = new Promise((ok) => { m.onLive = ok; setTimeout(ok, 1200); });
      node.port.onmessage = ({ data: d }) => {
        if (!m.live) { if (!d.some((x) => x !== 0)) return; m.live = true; m.onLive(); }
        if (rec) { rec.chunks.push(d); return; }
        for (let i = 0; i < d.length; i++) { m.ring[m.rp] = d[i]; m.rp = (m.rp + 1) % m.ring.length; }
      };
      src.connect(node); node.connect(ctx.destination);   // 不接到输出, 音频线程不拉它, process 就不跑
      mic = m;
      return m;
    })();
    try { return await opening; } finally { opening = null; }
  }
  function closeMic() {
    const m = mic; if (!m || rec || starting) return; mic = null;
    m.node.port.onmessage = null;
    try { m.node.disconnect(); } catch (_) {}
    m.stream.getTracks().forEach((t) => t.stop());
    m.ctx.close().catch(() => {});
  }

  const active = () => document.visibilityState === 'visible' && document.hasFocus();
  // warm 过的包有没有一块面板在屏幕上。display:none(别的标签) 的矩形是 0, 也算不在
  function shown() {
    for (const id of warmed) {
      for (const el of document.querySelectorAll('.ui-sandbox')) {
        if (el.dataset.pkg !== id) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight) return true;
      }
    }
    return false;
  }
  function sync() {
    if (rec || starting) return;
    const s = shown();
    if (s && !wasShown) lastUse = Date.now();   // 面板回到屏幕上, 空闲从头算
    wasShown = s;
    if (active() && s && Date.now() - lastUse < IDLE_MS) openMic().catch(() => {});
    else closeMic();
    if (!s && !document.querySelector('.ui-sandbox')) { warmed.clear(); clearInterval(ticker); ticker = null; }
  }
  // 晚一拍再看: 焦点挪进插件框时宿主窗口也会先收到 blur, 那一刻 hasFocus 还没落定
  const later = () => setTimeout(sync, 50);
  window.addEventListener('focus', later); window.addEventListener('blur', later);
  document.addEventListener('visibilitychange', later);

  // Float32 片段(原生采样率) → 16kHz mono 16-bit WAV
  function toWav16k(chunks, sr) {
    const n = chunks.reduce((a, c) => a + c.length, 0);
    const pcm = new Float32Array(n);
    let o = 0; for (const c of chunks) { pcm.set(c, o); o += c.length; }
    const step = sr / 16000, m = Math.floor(n / step);
    const out = new Uint8Array(44 + m * 2), v = new DataView(out.buffer);
    const str = (p, s) => { for (let i = 0; i < s.length; i++) v.setUint8(p + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + m * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true);
    v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, m * 2, true);
    for (let i = 0; i < m; i++) {
      // 区间平均, 顺带当低通用, 比隔点取样少混叠
      const a = Math.floor(i * step), b = Math.min(n, Math.max(a + 1, Math.floor((i + 1) * step)));
      let s = 0; for (let k = a; k < b; k++) s += pcm[k];
      const x = Math.max(-1, Math.min(1, s / (b - a)));
      v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return out;
  }

  async function start(maxMs) {
    if (rec) return;
    held = null;
    const fresh = !mic;
    starting = true;
    let m;
    try { m = await openMic(); await m.ready; } finally { starting = false; }
    // 已经开着: 前 0.5 秒从环里取; 刚打开: 环是空的, 不取
    const pre = fresh ? [] : [Float32Array.from([...m.ring.subarray(m.rp), ...m.ring.subarray(0, m.rp)])];
    rec = { chunks: pre };
    rec.timer = setTimeout(() => { finish(false).catch(() => {}); }, maxMs || 60000);
  }

  // tail = 停之前再多收 0.5 秒(人松手时); 到点自停不用
  async function finish(tail) {
    const r = rec; if (!r || r.closing) return; r.closing = true; clearTimeout(r.timer);
    if (tail) await new Promise((ok) => setTimeout(ok, TAIL_MS));
    rec = null;
    held = toWav16k(r.chunks, mic ? mic.sr : 48000);
    lastUse = Date.now();
    sync();
  }

  async function play(wav) {
    const ac = new AudioContext();
    const buf = await ac.decodeAudioData(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength));
    const src = ac.createBufferSource();
    src.buffer = buf; src.connect(ac.destination);
    src.addEventListener('ended', () => { ac.close().catch(() => {}); });
    src.start();
  }

  // 只读: 真机验「什么时候开着麦」用(CDP 里看), 不给包用 —— 包在沙箱里够不着宿主页
  window.recordHostState = () => ({ mic: !!mic, recording: !!rec, warmed: [...warmed], shown: shown(), idle_ms: Date.now() - lastUse });

  api.onRecordOp(async (m) => {
    const reply = (x) => api.recordReply({ rid: m.rid, ...x });
    try {
      if (m.op === 'warm') {
        if (m.pkg) warmed.add(m.pkg);
        lastUse = Date.now(); wasShown = true;
        if (!ticker) ticker = setInterval(sync, 1000);
        if (active()) await openMic();
        return reply({ ok: true });
      }
      if (m.op === 'start') {
        if (rec) return reply({ ok: false, code: 'record_busy', message: 'already recording' });
        lastUse = Date.now();
        await start(m.maxMs);
        return reply({ ok: true });
      }
      if (m.op === 'stop') {
        await finish(true);
        const wav = held; held = null;
        return reply({ ok: true, wav });
      }
      if (m.op === 'cancel') {
        if (rec) { clearTimeout(rec.timer); rec = null; }
        held = null;
        sync();
        return reply({ ok: true });
      }
      if (m.op === 'play') { await play(m.wav); return reply({ ok: true }); }
      return reply({ ok: false, code: 'bad_decl', message: m.op });
    } catch (e) {
      const message = (e && e.message) || String(e);
      if (e && e.name === 'NotFoundError') reply({ ok: false, code: 'no_mic', message });
      else if (e && e.name === 'NotAllowedError') reply({ ok: false, code: 'mic_denied', message });
      else reply({ ok: false, code: 'record_failed', message });
    }
  });
})();
