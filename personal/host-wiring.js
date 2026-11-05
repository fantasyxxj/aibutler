// host-wiring.js — 个人版把自己的宿主能力接到 core 上。**这一版唯一的接线处。**
//
// core 不认识 Electron、不认识目录约定、不认识"个人版/行业版"(见 core/host.js), 所以每个
// 入口进程都必须先接线。入口不只有 main.js —— 每个直接 require core 模块的测试也是入口。
// 接线只写这一份, 两边共用: app 和测试接的是同一套, 才不会出现"测试里对、真机里错"。
//
// 行业版会有它自己的一份 wiring(来源链换成服务端下发, 语音/通道换成它那套), core 一个字不改。
const path = require('path');
const paths = require('./paths');
const cfg = require('./config-loader');

// 🔴 secrets 顶层就 `require('electron').safeStorage`, 没有兜底 —— 直接 require 会让不带
// electron 的测试进程当场炸。所以这里递进去的是个惰性壳子: 真取凭据时才加载。
// (调用方 agent/env.js 整段包在 try/catch 里, 拿不到就退回订阅继续能用。)
const secrets = { get: (k) => require('./secrets').get(k) };

require('../core/host').install({
  config: cfg,                                   // 来源链 [用户目录覆盖, 出厂], 见 config-loader.js
  paths,
  secrets,
  settings: require('./settings'),
  voice: require('../core/voice-say'),
  proxy: require('./proxy'),
  i18n: require('./i18n.js'),
  // 沙箱那侧导出的同一个校验函数(renderer/sandbox.js 在浏览器里当 script 加载, 在 node 里可 require)
  uiCheck: { checkUiPayload: (p) => require('./renderer/sandbox.js').checkUiPayload(p) },
  selfGuard: { create: require('./self-guard').createSelfGuard },
  // 个人版的向量算子 = 隐藏窗口跑 wasm 推理(embed-host) + 模型落地探测(memory-embed)。
  // 两样都惰性取: 不带 electron 的进程 require 得到但用不着, 调用方全包在 try/catch 里。
  embedder: {
    embed: (...a) => require('../core/embed/host').embed(...a),
    detect: () => require('../core/embed/model').detect(),
  },
});

// 显示语言要在【接线那一刻】就定下来, 不能等渲染层来问 get-locale ——
// 起床语和出生教育按它选语言, 而冷启动唤醒 / 定时任务都可能跑在开窗之前。
// 这里只认用户明确选过的那个值; 没选过留空, 由 main.js 的 currentLocale() 再拿 OS 语言补
// (那一步要 electron, headless 测试进程走不到)。
require('../core/memory-v2/lang').setLang(require('./settings').read().language || '');

// 检索用的同义词表也是宿主的出厂配置, 用记忆体自带的注入点递进去。
require('../core/memory').setAliasesFile(path.join(__dirname, '..', 'core', 'config', 'main', 'memory_aliases.json'));

// L1 记忆体另有一份【可选】注入面: 没注入不报错只降级, 好让纯 node 脚本直接吃记忆体。
// 这里补上, 是为了让个人版拿到用户覆盖层和外置文案。
const memoryHost = require('../core/memory-v2/host');
memoryHost.setDataDir(paths.controlDir());   // 标定值覆盖层落在数据目录
memoryHost.setConfig(cfg);                   // 外置文案(pinned 退休四问等), 拿不到走内置兜底

module.exports = { cfg, paths };
