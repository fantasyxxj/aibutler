// record-worklet.js — record 原语的采音: 在音频线程上收, 每 128 个采样原样交给 record-host.js。
// 用 ScriptProcessor 在主线程收的话, 界面一忙(动画 / 出新气泡)就掉帧, 录下来前后缺字(教育版实撞)。
class RecordTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('record-tap', RecordTap);
