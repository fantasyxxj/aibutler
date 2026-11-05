// ui-state.js — 沙箱里的界面包自己要记住的东西, 落在盘上。
//
// 沙箱是个什么都没有的世界: 没有 localStorage(不同源)、没有 fs。所以它想记住
// 「上次做到第几题」「哪几张卡已经背熟」, 只能喊一声让宿主替它存。
//
// 🔴 一个包一个抽屉。互相看不见 —— 包之间不该有办法互相读写, 否则一个包就能
// 改掉另一个包记下的进度, 而两个包的作者永远查不出是谁干的。
//
// 🔴 这不是记忆。记什么、要不要合并、跟三个月前那条冲不冲突, 是判断题, 归 AI
// (作者 2026-08-13: 「memory 有必要吗, 本身就是 AI 来控制这个」)。这里只是
// 包自己的数据, 存了就存了, 不进 AI 的认知。
'use strict';

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'ui-state.json';
// 单个包的上限。沙箱那侧已经挡过一道(renderer/sandbox.js checkState),
// 这里再挡一次 —— 界面不是防线, 而这一侧才是真正碰盘的人。
const MAX_BYTES = 64 * 1024;

function fileOf(controlDir) { return path.join(controlDir, FILE_NAME); }

// 读坏了当空的。存的是"上次做到哪"这类附属信息, 为一份坏 JSON 让整个界面起不来不值。
function readAll(controlDir) {
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(controlDir), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (_) { return {}; }
}

function create(controlDir) {
  return {
    read(pkgId) {
      const v = readAll(controlDir)[String(pkgId)];
      return v === undefined ? null : v;
    },

    // 返回 { ok } 或 { ok:false, message } —— 静默丢弃会让包下次读不到自己存的东西,
    // 而它无从知道是没存上还是存错了。
    write(pkgId, value) {
      const id = String(pkgId || '');
      if (!id) return { ok: false, message: 'ui-state: 没有包 id' };
      let text;
      try { text = JSON.stringify(value); } catch (_) {
        return { ok: false, message: 'ui-state: 存不成 JSON' };
      }
      if (text == null) return { ok: false, message: 'ui-state: 内容是空的' };
      if (text.length > MAX_BYTES) {
        return { ok: false, message: `ui-state: 太大了(${text.length} > ${MAX_BYTES})` };
      }
      const all = readAll(controlDir);
      all[id] = value;
      fs.mkdirSync(controlDir, { recursive: true });
      fs.writeFileSync(fileOf(controlDir), JSON.stringify(all, null, 2));
      return { ok: true };
    },

    file: () => fileOf(controlDir),
  };
}

module.exports = { create, FILE_NAME, fileOf, MAX_BYTES };
