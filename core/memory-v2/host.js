// 宿主注入面 —— core 与外界之间唯一的口子(内核抽包第 2 步)。
//
// 记忆体要成为"任何应用都能吃的通用底座", 就不能认识 Electron, 也不能认识 butler 的目录约定。
// 原先它自己去 require('./paths').controlDir() 找数据目录、require('./config-loader') 取文案,
// 那两样都是宿主的东西。现在反过来: 宿主启动时把它们递进来, core 只认接口。
//
// 🔴 两个注入点都是【可选】的。没注入不报错, 只是能力降级:
//   - 没给 dataDir → 标定值只有出厂默认, 没有用户覆盖层
//   - 没给 config  → 文案走代码里的内置兜底
// 这条很重要: 纯 node 脚本 / 测试 / 别的应用可以直接 require 记忆体跑起来, 不需要先搭一套宿主。
const tuning = require('./tuning');

let _cfg = null;

// 宿主的配置层, 需要有 render(key, vars) 方法。传 null 撤销。
function setConfig(c) { _cfg = (c && typeof c.render === 'function') ? c : null; }

// 取当前配置层; 没有就返 null, 调用方走内置兜底。
function cfg() { return _cfg; }

module.exports = {
  setDataDir: tuning.setDataDir,   // 可写数据目录(标定值覆盖层落在这)
  setConfig,
  cfg,
};
