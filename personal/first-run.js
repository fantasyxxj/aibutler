// first-run.js — 首次启动的两个对话框: ① 选界面语言 ② 选数据保存位置。
//
// 从 personal/main.js 搬出来的(那份只许改不许长)。作者 2026-09-20 定的规矩是「碰到改哪里,
// 就把那个函数迁出去」—— 不专门排一轮大重构, 每次碰哪块就带走哪块。
//
// 两个必须是一对: ①的返回值不落盘, 因为 settings.json 住在 `dataDir()/app/` 下, 而数据目录
// 是②才选的。①就写会写进默认位置, 用户接着自选了别的文件夹 → 那份设置成了孤儿, 重启读不回来。
// 落盘的时机在 setDataDir 之后, 见 main.js 的 whenReady。
'use strict';

const { app, dialog } = require('electron');
const paths = require('./paths');
const i18n = require('./i18n');

// —— ① 选界面语言。仅打包模式且没选过时弹, 排在所有对话框最前面。——
//
// 系统语言 ≠ 想用的语言(在日本用日文 mac 的中国人、公司发的英文 Windows…), 所以要真问一次。
// 装的时候问不了: mac 的 dmg 根本没有安装向导, 拖进 Applications 就结束了。
//
// 出生教育也读这个语言 → 英文用户的管家, 出生时学的 21 条记忆就是英文的。
function chooseLanguage() {
  if (!paths.needsFirstRunChoice()) return null;   // 开发模式 / 已选过 → 跳过
  const c = i18n.firstRunLanguageChoices(app.getLocale());
  // この画面の文言だけは OS の推測で描く(まだ選んでもらっていない)。外してもボタンには
  // 各言語が自分の名前を自分の文字で出しているので、読めないということにはならない。
  const s = i18n.uiStrings(c.guess);
  try {
    try { app.focus({ steal: true }); } catch (_) {}
    const pick = dialog.showMessageBoxSync({
      type: 'question',
      buttons: c.labels,
      defaultId: c.defaultIndex, cancelId: c.defaultIndex,
      title: s.firstrun_lang_title,
      message: s.firstrun_lang_message,
      detail: s.firstrun_lang_detail,
    });
    return c.ids[pick] || c.guess;
  } catch (_) { return c.guess; }
}

// —— ② 让用户选数据保存位置(默认系统标准位, 可自选躲开 C 盘)。仅打包模式且没选过时弹。——
// locale = 上一步选的语言(没弹过则 null → 落到默认中文)。
function chooseDataDir(locale) {
  if (!paths.needsFirstRunChoice()) return;   // 开发模式 / 已选过 → 跳过
  const s = i18n.uiStrings(locale);
  let chosen = paths.defaultDataDir();
  try {
    try { app.focus({ steal: true }); } catch (_) {}
    const choice = dialog.showMessageBoxSync({
      type: 'question',
      buttons: [s.firstrun_dir_default, s.firstrun_dir_pick],
      defaultId: 0, cancelId: 0,
      title: s.firstrun_dir_title,
      message: s.firstrun_dir_message,
      detail: i18n.fmt(s.firstrun_dir_detail, { dir: paths.defaultDataDir() }),
    });
    if (choice === 1) {
      // 🔴 不给 defaultPath 的话, Windows 会让选择器停在这个进程上次用过的位置 —— 用户刚用安装
      // 程序装完, 那个位置就是安装目录, 一按确定数据目录就成了安装目录。2026-09-22 的事故正是如此。
      const r = dialog.showOpenDialogSync({ title: s.firstrun_dir_picker_title, defaultPath: paths.defaultDataDir(), properties: ['openDirectory', 'createDirectory'] });
      if (r && r[0]) chosen = r[0];
    }
  } catch (_) {}
  try {
    paths.setDataDir(require('./data-dir-guard').ensureSafe(chosen, locale));   // 落在安装根里就拒绝, 换个安全位置
  } catch (e) {
    // 选的位置建不了目录(权限/只读盘等) → 人话提示 + 落回默认位, 别把原始堆栈甩给用户
    console.error('[firstRun] setDataDir 失败:', e && e.message);
    try { app.focus({ steal: true }); } catch (_) {}
    dialog.showMessageBoxSync({
      type: 'warning', title: s.firstrun_dir_fail_title,
      message: s.firstrun_dir_fail_message,
      detail: i18n.fmt(s.firstrun_dir_fail_detail, { chosen, err: e && e.message, dir: paths.defaultDataDir() }),
      buttons: [s.firstrun_ok],
    });
    paths.setDataDir(paths.defaultDataDir());
  }
}

// 两步一趟跑完, 返回选定的语言(调用方还要拿它落盘 + 喂出生教育)。顺序不能换。
function run() {
  const locale = chooseLanguage();
  chooseDataDir(locale);
  return locale;
}

module.exports = { chooseLanguage, chooseDataDir, run };
