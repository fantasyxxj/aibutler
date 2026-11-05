// scripts/embed-probe.js — 在真 Electron 里跑一次语义推理, 把结果打到 stdout 供门禁判读。
// 存在的理由: 协议注册时机 / CORS / wasm 路径这几样, 纯 node 门禁一个都验不到,
// 而它们恰恰是最容易在打包后才炸的地方(feedback_gates_green_is_not_real_machine_works)。
const { app } = require('electron');
const path = require('path');

const host = require(path.join(__dirname, '..', 'personal', 'embed-host'));
host.registerScheme();

function out(o) { process.stdout.write('PROBE:' + JSON.stringify(o) + '\n'); }

app.whenReady().then(async () => {
  try {
    host.installProtocol();
    const { cosine } = require(path.join(__dirname, '..', 'core', 'memory-vector'));
    const texts = [
      'query: 怎么提交代码',
      'query: 怎么提交代码',
      'passage: git commit 把改动提交到仓库',
      'passage: 今天午饭吃的是拉面',
    ];
    const v = await host.embed(texts);
    out({
      ok: true,
      dim: v[0].length,
      selfSim: Number(cosine(v[0], v[1]).toFixed(4)),
      related: Number(cosine(v[0], v[2]).toFixed(4)),
      unrelated: Number(cosine(v[0], v[3]).toFixed(4)),
    });
  } catch (e) {
    out({ ok: false, error: String((e && e.stack) || e) });
  } finally {
    host.dispose();
    app.exit(0);
  }
});
