// first-run.js — 首次启动落定数据目录。
//
// 不再弹框问(作者 2026-11-06 定, 首启压到两屏): 语言跟系统走, 空状态屏第一屏右上角就能改,
// 改了才落盘 —— 出生教育读的是建人格那一刻的语言, 所以在那一屏改就来得及。数据目录直接用
// 系统标准位并写下指针; 人格资料放哪在空状态屏第二屏的「高级」里还能换。
//
// 指针必须在任何登记簿/人格读写之前写好: settings.json 住在 `dataDir()/app/` 下。
'use strict';

const paths = require('./paths');

// 返回 null: 没有替用户选语言, main.js 那句「选了就落盘」自然跳过。
function run() {
  if (!paths.needsFirstRunChoice()) return null;   // 开发模式 / 已有指针 → 跳过
  try {
    paths.setDataDir(require('./data-dir-guard').ensureSafe(paths.defaultDataDir(), null));
  } catch (e) {
    console.error('[firstRun] setDataDir 失败:', e && e.message);
    paths.setDataDir(paths.defaultDataDir());
  }
  return null;
}

module.exports = { run };
