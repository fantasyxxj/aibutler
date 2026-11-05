// workflow-progress.js — 工作流的进度印, 落在盘上。
//
// 为什么非落盘不可: 导航按钮本来就发 mark=done|skipped。没有接的地方, 这两个印就是
// 走个过场 —— 屏幕上按了「跳过」, 关掉再开一切如新。会让人以为记下了却没记下的东西,
// 比压根没有这个功能更糟。
//
// 🔴 印只由「人按按钮」产生。不给 AI 开写入口 —— 对话里一句「好像已经弄好了」就把印
// 打上, 等到后面对不上时, 谁也回不到出问题的那一步。这条是从行业版一路守下来的。
'use strict';

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'workflow-progress.json';
const STATUSES = new Set(['done', 'skipped']);

function fileOf(controlDir) { return path.join(controlDir, FILE_NAME); }

// 时间一律本地时区(作者钦定, 禁 UTC): 这个印是给人回头对"哪一步什么时候按的"用的。
function localStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// 读不出来就当空的。进度是附属信息 —— 为了一份读坏的 JSON 让整个引擎起不来, 不值。
function readAll(controlDir) {
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(controlDir), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (_) { return {}; }
}

function create(controlDir) {
  return {
    mark(wfId, stepId, status) {
      if (!STATUSES.has(status)) throw new Error(`workflow-progress: 未知的印 ${status}`);
      const all = readAll(controlDir);
      const one = all[wfId] && typeof all[wfId] === 'object' ? all[wfId] : {};
      one[stepId] = { status, at: localStamp() };
      all[wfId] = one;
      fs.mkdirSync(controlDir, { recursive: true });
      fs.writeFileSync(fileOf(controlDir), JSON.stringify(all, null, 2));
      return one;
    },

    // stepIds 由调用方给 —— 顺序的真相在工作流定义里, 不在这份盘上的记录里。
    // 包升级删掉某一步时, 旧的印会自然落选, 而不会把总数撑大。
    snapshot(wfId, stepIds = []) {
      const one = readAll(controlDir)[wfId] || {};
      let doneCount = 0, skipped = 0, updatedAt = null;
      // 飛ばした一歩は id で持つ。数だけだと「繋がらない」時に疑う場所が特定できない ——
      // 詰まりの原因はたいてい飛ばしたその一歩なので、名前で言えないと役に立たない。
      const skippedIds = [];
      let current = null, resumeAt = null;
      for (const id of stepIds) {
        const rec = one[id] || {};
        const st = rec.status;
        if (st === 'done') doneCount++;
        else if (st === 'skipped') { skipped++; skippedIds.push(id); }
        else if (!current) current = id;
        // 🔴 戻り先は「まだ done でない最初の一歩」—— 飛ばした一歩を跨がない。跨ぐと、全部
        // 飛ばした店主が最後の一枚まで運ばれ、一度も設定していないのに終わりに見える。
        // 既に済ませてある一歩は「跳过」ではなく「做好了」を押す、が使い分け。
        if (!resumeAt && st !== 'done') resumeAt = id;
        if (rec.at && (!updatedAt || rec.at > updatedAt)) updatedAt = rec.at;
      }
      // 飛ばした一歩は「済んだ」ではない。終わりは done が揃った時だけ。
      return { doneCount, skipped, skippedIds, total: stepIds.length, steps: one,
               current, finished: doneCount === stepIds.length && stepIds.length > 0,
               resumeAt, updatedAt };
    },

    file: () => fileOf(controlDir),
  };
}

module.exports = { create, FILE_NAME, fileOf };
