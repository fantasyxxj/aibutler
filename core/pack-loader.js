// pack-loader.js — 行业包加载器 (pack protocol v2)。
//
// 一个行业包 = **一个 json 文件**, 装四样: 人格说明 / 记忆 / chips / 首启帮助页。
// 没有目录、没有 manifest 指针、没有 md 源文件 —— 包是激活时按行业下载下来的一份东西,
// 能被下载的只能是一个文件。
//
// 🔴 **下载分两个时机, 范围不同**(作者 2026-09-03 定):
//    激活时  四样全下, 写盘一次。
//    之后升级 **只有记忆**。人格说明 / chips / 首启帮助页一律不再碰 ——
//    首启帮助页第一次打开就消费完了, 再发没有价值; 人格说明和 chips 盖回去会冲掉
//    店主教出来的东西。所以这里只负责"把文件读成对象", 谁该写盘由 boot 决定。
//
// 🔴 **「工具」这个概念在包里不存在**。曾经有过一份 tools.json 道具帐, 声明里写道具的名字,
//    加载时编译成 AI 的工具 —— 那是一层只为查名字而存在的帐面。现在: 画面要叩的端点直接
//    写在插件自己的命令声明里({method,path}); AI 要叩端点走 bus_exec 加一条出厂知识;
//    LINE 这类行业版自己的能力长在行业版源码里, 与装了哪个行业包无关。
//    Core never executes pack code.
const fs = require('fs');

const SUPPORTED_PACK_PROTOCOLS = [2];

// ---- semver range check (supports ">=x.y.z <a.b.c" and "*") — no dependency ----
function semverSatisfies(version, range) {
  if (!range || range === '*') return true;
  const v = version.split('.').map(Number);
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); } return 0; };
  for (const part of range.split(/\s+/)) {
    const m = part.match(/^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/);
    if (!m) continue;
    const [, op = '=', ref] = m;
    const r = ref.split('.').map(Number);
    const c = cmp(v, r);
    if (op === '>=' && c < 0) return false;
    if (op === '<=' && c > 0) return false;
    if (op === '>' && c <= 0) return false;
    if (op === '<' && c >= 0) return false;
    if (op === '=' && c !== 0) return false;
  }
  return true;
}

/** 读一个包文件 → {id, version, displayName, persona, chips, firstRunHelp, memory}。
 *  四样都是可选的: 通用包只有记忆和人格补充, 行业包才四样齐全。 */
function loadPack(packFile, coreVersion) {
  if (!fs.existsSync(packFile)) throw new Error(`行业包文件不存在: ${packFile}`);
  let pack;
  try { pack = JSON.parse(fs.readFileSync(packFile, 'utf8')); }
  catch (e) { throw new Error(`行业包读不了 ${packFile}: ${e.message}`); }

  if (!SUPPORTED_PACK_PROTOCOLS.includes(pack.protocol)) {
    throw new Error(`pack「${pack.id}」协议版本 ${pack.protocol} 不受支持 (core 支持: ${SUPPORTED_PACK_PROTOCOLS.join(',')})`);
  }
  if (!pack.id) throw new Error(`行业包缺 id: ${packFile}`);
  if (coreVersion && !semverSatisfies(coreVersion, pack.core_compat)) {
    throw new Error(`pack「${pack.id}」要求 core ${pack.core_compat}, 当前 ${coreVersion} — 请升级 core 或换 pack 版本`);
  }

  // 出厂快捷按钮。放包里而不是壳里: 「今日の予約一覧」这种入口是行业差异, 按铁律必须落数据侧。
  // core 只认 {id,label,…} 这个通用形状, 不认里面写的是餐厅还是装修。
  // 押した時に起きる事は四通り: prompt = その一言を AI へ / pin = 掲示板へ直に貼る(AI を通らない) /
  // help = 首启帮助页を開く(純 UI, AI を通らない) / setup = 開業準備の不足を程序が引き、AI に案内させる。
  // どれも持たない chip は押しても何も起きない —— 画面に出さない。
  const chips = (Array.isArray(pack.chips) ? pack.chips : [])
    .filter((c) => c && c.id && c.label && (c.prompt || c.pin || c.help || c.setup));

  // 记忆。形状与 `config/onboarding/knowledge/*.json` 逐字相同({bundle_id, version, items})
  // —— 同一条 factory-sync 落盘, 靠 is_factory 与助手自己长出来的知识隔离。字段名叫
  // knowledge 是因为 factory-sync 认的就是这个名字。**包里唯一进升级范围的就是它**。
  const knowledge = pack.memory && Array.isArray(pack.memory.items) ? pack.memory : null;

  return {
    id: pack.id,
    version: pack.version,
    displayName: pack.display_name || pack.id,
    // 这个行业的助手是谁 —— 整份人格说明, 不是往通用骨架上打的补丁。
    // 只在激活那一次写进 persona.md; 之后助手自己怎么改都是它的事, 升级不碰。
    persona: typeof pack.persona === 'string' ? pack.persona : '',
    chips,
    firstRunHelp: pack.first_run_help || null,
    knowledge,
    file: packFile,
  };
}

module.exports = { loadPack, semverSatisfies, SUPPORTED_PACK_PROTOCOLS };
