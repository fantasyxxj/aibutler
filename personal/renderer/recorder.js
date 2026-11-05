// recorder.js — Web Audio 录 16kHz mono PCM + WAV 封包 (零外部依赖, 直接喂 whisper.cpp)
// 暴露: window.audioRecorder = { start(), stop() -> Uint8Array WAV, cancel() }
// whisper-cli 只吃 flac/mp3/ogg/wav; 用原生 MediaRecorder 出的 webm/opus 得转; PCM→WAV 手写最省事。
(function () {
  let ac = null, src = null, proc = null, stream = null, chunks = null, active = false;

  async function start() {
    if (active) return;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    const track = stream.getAudioTracks()[0];
    console.log('[recorder/DEBUG] track settings:', track && track.getSettings());
    // 用设备原生采样率, 避免 AudioContext 强制 16000 时 MediaStreamSource 静音
    ac = new AudioContext();
    console.log('[recorder/DEBUG] ac.sampleRate=', ac.sampleRate, 'state=', ac.state);
    if (ac.state === 'suspended') { try { await ac.resume(); } catch (_) {} }
    src = ac.createMediaStreamSource(stream);
    proc = ac.createScriptProcessor(4096, 1, 1);
    chunks = [];
    let logged = 0;
    proc.onaudioprocess = (e) => {
      const ch = e.inputBuffer.getChannelData(0);
      if (logged < 3) {
        let mx = 0; for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > mx) mx = a; }
        console.log('[recorder/DEBUG] frame', logged, 'len=', ch.length, 'peak=', mx.toFixed(4));
        logged++;
      }
      chunks.push(new Float32Array(ch));
    };
    src.connect(proc);
    proc.connect(ac.destination);   // Chrome 要接到 destination 才会调 onaudioprocess
    active = true;
  }

  async function stop() {
    if (!active) return null;
    active = false;
    try { proc.disconnect(); src.disconnect(); } catch (_) {}
    try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    const sr = ac.sampleRate;   // 用实际采样率 (可能 48000/44100), whisper.cpp 自己会内部重采样
    try { await ac.close(); } catch (_) {}
    // 拼所有帧
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Float32Array(total);
    let o = 0;
    for (const c of chunks) { pcm.set(c, o); o += c.length; }
    chunks = null;
    return encodeWav(pcm, sr);
  }

  function cancel() {
    if (!active) return;
    active = false;
    try { proc.disconnect(); src.disconnect(); } catch (_) {}
    try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { ac.close(); } catch (_) {}
    chunks = null;
  }

  // Float32 [-1..1] → 16-bit PCM WAV (mono, 16kHz)
  function encodeWav(pcm, sr) {
    const n = pcm.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    let p = 0;
    const wStr = (s) => { for (let i = 0; i < s.length; i++) v.setUint8(p++, s.charCodeAt(i)); };
    const w32 = (x) => { v.setUint32(p, x, true); p += 4; };
    const w16 = (x) => { v.setUint16(p, x, true); p += 2; };
    wStr('RIFF'); w32(36 + n * 2); wStr('WAVE');
    wStr('fmt '); w32(16); w16(1); w16(1); w32(sr); w32(sr * 2); w16(2); w16(16);
    wStr('data'); w32(n * 2);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      v.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      p += 2;
    }
    return new Uint8Array(buf);
  }

  window.audioRecorder = { start, stop, cancel, get active() { return active; } };
})();
