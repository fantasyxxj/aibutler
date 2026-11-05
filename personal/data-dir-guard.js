// data-dir-guard.js — 数据目录的三道闸。
//
// 为什么单独成文件: main.js 撞着行数闸(只许改不许长), 同仓 first-persona.js / hub-ipc.js 也是这么分出来的。
//
// 🔴 三道闸堵的是同一件事的三个面: **数据目录落在安装根里, 每次升级都会被格式化一次**。
//    NSIS 覆盖安装 = 先跑旧版卸载再装新版, `$INSTDIR` 整体清掉, 住在里面的人格/记忆/登记簿
//    在安装程序眼里都是"上一版留下的垃圾"。2026-09-22 实撞: 数据目录设成 `E:\butler`(同时是
//    安装目录), 覆盖安装后 personas\ 整个消失, 程序照常读到指针、进去发现没登记簿, 于是判定
//    "一个人格都没有"弹创建屏 —— 全程零征兆, 用户唯一能得到的结论是"数据没了"。
//
//    ① ensureSafe            选的时候就拒绝, 并给一个能直接用的安全位置(靠提示和自觉拦不住)
//    ② checkOnBoot           已经中招的人光靠①救不了 —— 每次启动复查, 当场给搬家的机会
//    ③ checkDiscardedPointer 指针指不到时不许静默回落, 指名道姓说出是哪个目录没了
'use strict';

const fs = require('fs');
const path = require('path');
const { app, dialog } = require('electron');
const paths = require('./paths');
const { fmt } = require('./i18n');
const { strings } = require('./i18n-datadir');

const focus = () => { try { app.focus({ steal: true }); } catch (_) {} };

// 目录里有没有真东西。空目录 / 只有 Electron 缓存都不算 —— 判据取登记簿和人格家目录这两样,
// 它们才是"这是一份数据目录"的标志。
function hasData(dir) {
  try {
    if (fs.existsSync(path.join(dir, 'app', 'personas.json'))) return true;
    const p = path.join(dir, 'personas');
    return fs.existsSync(p) && fs.readdirSync(p).length > 0;
  } catch (_) { return false; }
}

// ① 首启选目录时的硬闸。返回一个**保证不在安装根里**的路径, 调用方拿去 setDataDir。
function ensureSafe(chosen, locale) {
  if (!paths.isUnderInstallRoot(chosen)) return chosen;
  const s = strings(locale);
  const fallback = paths.defaultDataDir();
  focus();
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    buttons: [s.in_install_pick, s.in_install_use_default],
    defaultId: 1, cancelId: 1,
    title: s.in_install_title,
    message: fmt(s.in_install_message, { dir: chosen }),
    detail: fmt(s.in_install_detail, { dir: fallback }),
  });
  if (choice === 0) {
    const r = dialog.showOpenDialogSync({ title: s.at_risk_picker,
      defaultPath: fallback, properties: ['openDirectory', 'createDirectory'] });
    // 再选一次还落在安装根里 → 不再纠缠, 直接用默认位。宁可位置不合他意, 也不留一个定时炸弹。
    if (r && r[0] && !paths.isUnderInstallRoot(r[0])) return r[0];
  }
  return fallback;
}

// ② 每次启动复查。已经把数据放进安装根的人, ① 救不了 —— 必须当场给搬走的机会。
// 时机: 要早于任何人格起来(库一开就有写入, 搬到一半会撕裂)。
function checkOnBoot(locale) {
  const cur = paths.dataDir();
  if (!paths.isUnderInstallRoot(cur)) return;
  const s = strings(locale);
  focus();
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    buttons: [s.at_risk_move, s.at_risk_later],
    defaultId: 0, cancelId: 1,
    title: s.at_risk_title,
    message: fmt(s.at_risk_message, { dir: cur }),
    detail: s.at_risk_detail,
  });
  if (choice !== 0) return;
  const r = dialog.showOpenDialogSync({ title: s.at_risk_picker,
    defaultPath: paths.defaultDataDir(), properties: ['openDirectory', 'createDirectory'] });
  if (!r || !r[0]) return;
  const dest = r[0];
  if (paths.isUnderInstallRoot(dest)) { failed(s, s.at_risk_still_unsafe); return; }
  try {
    // 🔴 先整份复制、复制成功了才动指针。中途失败就当什么都没发生 —— 原目录一个字没碰, 指针
    //    还指着它, 下次启动照样再问一次。绝不能出现"指针改了但数据没到"。
    fs.cpSync(cur, dest, { recursive: true, force: true, errorOnExist: false });
    paths.setDataDir(dest);
  } catch (e) {
    console.error('[data-dir-guard] 搬迁失败, 指针未动:', e && e.message);
    failed(s, fmt(s.at_risk_failed, { err: (e && e.message) || '' }));
    return;
  }
  focus();
  dialog.showMessageBoxSync({ type: 'info', buttons: [s.ok],
    title: s.at_risk_done_title,
    message: fmt(s.at_risk_done_message, { dir: dest }),
    detail: fmt(s.at_risk_done_detail, { dir: cur }) });
}

// ③ 指针指向的目录找不到时, 指名道姓地说出来 —— 从前这里静默回落默认位, 表象与全新安装
// 一模一样(登记簿空 → 空状态屏), 而数据好端端躺在原处。
function checkDiscardedPointer(locale) {
  paths.dataDir();                       // 先触发解析, discardedPointer() 才有值
  const lost = paths.discardedPointer();
  if (!lost) return;
  const s = strings(locale);
  focus();
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    buttons: [s.lost_pick, s.lost_ignore],
    defaultId: 0, cancelId: 1,
    title: s.lost_title,
    message: fmt(s.lost_message, { dir: lost }),
    detail: fmt(s.lost_detail, { dir: paths.defaultDataDir() }),
  });
  if (choice !== 0) return;
  const r = dialog.showOpenDialogSync({ title: s.lost_picker, properties: ['openDirectory'] });
  if (r && r[0] && !paths.isUnderInstallRoot(r[0])) paths.setDataDir(r[0]);
}

function failed(s, detail) {
  focus();
  dialog.showMessageBoxSync({ type: 'warning', buttons: [s.ok],
    title: s.at_risk_failed_title, message: s.at_risk_failed_title, detail });
}

// 启动链一次调完: 先认回丢了的指针, 再复查危险位置。顺序不能换 —— 指针都没落定, 谈搬家没有意义。
function checkAll(locale) {
  try { checkDiscardedPointer(locale); } catch (e) { console.error('[data-dir-guard] 指针检查失败:', e && e.message); }
  try { checkOnBoot(locale); } catch (e) { console.error('[data-dir-guard] 危险位置检查失败:', e && e.message); }
}

module.exports = { ensureSafe, checkOnBoot, checkDiscardedPointer, checkAll, hasData };
