// config-loader.js — 个人版把自己的配置来源链接到内核加载器上。
//
// 内核在 config-loader/factory.js, 它只认一个有序目录数组、不认识 Electron。
// 这里负责把"个人版的来源链是什么"这件宿主知识填进去:
//   [用户数据目录/config, 出厂 config/]   先命中先用
// 行业版接的是另一条链(服务端下发 → 出厂), 内核一个字都不用改。
//
// 用法不变: const cfg = require('./config-loader');
//   cfg.text('wake/preamble')            → 读 config/wake/preamble.md 全文
//   cfg.render('wake/preamble', {name})  → 读 + {{name}} 占位符替换
//   cfg.json('models/list')              → 读 config/models/list.json 解析
const path = require('path');
const paths = require('./paths');
const { createConfigLoader, FACTORY_CONFIG_DIR } = require("../core/config-loader");

// 出厂 config/ 是打进 app.asar 的, 装机版里只读: 想调一句提示语就得重新打包安装, 还中断人干活。
// 提示语恰恰是要跑一段时间反复调的东西, 频次跟代码完全不是一个量级。
// 拿不到数据目录(非 electron / 首启未定位)就退回"只有出厂默认" —— 不更坏, 只是没有覆盖能力。
let userRoot = null;
try { userRoot = path.join(paths.controlDir(), 'config'); } catch (_) {}

// 出厂只有一份, 在 core/config —— **不存在"个人版独有的配置"**: 个人版就是公共全集,
// 行业版才有独有层(industry/config 排在 core 前面覆盖)。所以这条链只有覆盖层 + 出厂。
module.exports = createConfigLoader({
  sources: [userRoot, FACTORY_CONFIG_DIR],
});
