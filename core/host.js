// core/host.js — core 与宿主之间唯一的口子。
//
// 这里是**大脑那一侧**的插座。记忆不走这条线, 它有自己的 memory-v2/host.js, 且那边的注入点
// 刻意做成可选 —— 记忆能脱离外壳被纯 node 脚本直接吃, 大脑不能。
//
// core 要成为"任何应用都能吃的通用底座", 就不能认识 Electron, 不能认识 butler 的目录约定,
// 也不能认识"个人版/行业版"。凡是环境相关的东西, 宿主启动时递进来。
//
// 两版的差别全部收敛到这一次 install 里:
//   个人版  config 来源链 = [用户目录覆盖, personal/config]  —— 用户改得动
//   行业版  config 来源链 = [服务端下发, industry 出厂]      —— 彻底下发, 店主改不动
// ⚠️ 两条链的"出厂"各是各的目录, **都不是 core/config**: 个人版刻意不挂 core 兜底层
//    (挂了 whichFile 的 factoryRoot 会误判成"每个 key 都被覆盖", 覆盖层诊断整片失真)。
//    所以要调个人版的提示语, 改 personal/config/, 改 core/config/ 不生效。
//
// 🔴 没注入就抛错, **不静默降级**。降级会把"宿主忘了注入"变成"提示语莫名其妙变了"——
// 那是最难查的一类故障: 代码是新的、包是新的, 只有行为不对。要炸就在启动那一刻炸。
// (L1 记忆体是例外, 见 memory-v2/host.js: 它的两个注入点刻意做成可选, 好让纯 node 脚本直接吃。)

const slots = {
  config: null,      // 配置加载器实例, 需有 text/render/fill/json/jsonOptional/whichFile
  paths: null,       // 宿主的路径解析(dataDir / appVersion / resolveClaudeBin / …)
  secrets: null,     // 加密凭据存取(Electron safeStorage 之类)
  settings: null,    // app 级设置读写
  voice: null,       // 本机语音能力(availableLangs …)
  proxy: null,       // 出网代理(要塞进子进程环境变量)
  embedder: null,    // 语义向量算子(个人版靠 Electron 隐藏窗口跑 wasm 推理, 拆不进 core)
  selfGuard: null,   // 分发版源码锁(把 butler 自己的程序挡在人格够不着的地方)
  i18n: null,        // 界面文案表(uiStrings / DEFAULT_LOCALE) —— 两版各有各的语言架构
  uiCheck: null,     // 界面包载荷校验。**必须与沙箱那侧是同一个函数**, 所以由宿主把它递进来,
                     // 而不是 core 自己抄一份判据(抄一份 = 两边迟早判得不一样)
};

function install(impl = {}) {
  for (const [k, v] of Object.entries(impl)) {
    if (!(k in slots)) throw new Error(`core/host: 不认识的注入点 ${k}`);
    slots[k] = v;
  }
}

function need(name) {
  const v = slots[name];
  if (!v) throw new Error(`core/host: 宿主没注入 ${name} —— 在启动时调 host.install({ ${name}: … })`);
  return v;
}

// 取到的是"当下"那一份, 所以宿主可以晚一点注入, 也可以中途换掉。
const lazy = (name) => new Proxy({}, {
  get: (_t, k) => {
    const impl = need(name);
    const v = impl[k];
    return typeof v === 'function' ? v.bind(impl) : v;
  },
});

module.exports = {
  install,
  has: (name) => !!slots[name],
  cfg: lazy('config'),
  paths: lazy('paths'),
  secrets: lazy('secrets'),
  settings: lazy('settings'),
  voice: lazy('voice'),
  proxy: lazy('proxy'),
  embedder: lazy('embedder'),
  selfGuard: lazy('selfGuard'),
  i18n: lazy('i18n'),
  uiCheck: lazy('uiCheck'),
};
