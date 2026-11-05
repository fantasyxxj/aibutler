// 标定值 —— 检索打分的全部可调参数, 唯一真源。由 memory-v2.js 顶部抽出(内核抽包第 2 步)。
//
// 两级: 出厂默认(内核目录, 装机版打在 app.asar 里只读) ← 用户覆盖(宿主注入的数据目录, 可写)。
// 标定值是"要跑一段时间反复调"的东西, 锁在只读包里等于每调一个数就得重新打包安装。
// 逐键合并而不是整份替换: 覆盖文件只写关心的那几个数, 其余照出厂走。
// 读不到就整份回落内置默认 —— 配置缺失不该让检索炸掉。
//
// 🔴 抽包时改掉的一件事: 原先这里直接 require('./paths').controlDir() 找数据目录,
// 那是 butler 的目录约定, core 不能认识它。改成宿主注入 —— 见 setDataDir。
// 没有宿主注入时只有出厂默认, 不报错(检索照跑, 只是没有覆盖能力)。
const fs = require('fs');
const path = require('path');

const FILE = 'memory-tuning.json';
const FACTORY_DIR = path.join(__dirname, '..');   // 出厂默认所在(内核根)

// 内置默认只此一份。写在 json 和这里两处的话, 删掉配置文件后行为会悄悄变成另一套。
// 判据(照抄本文件 _doc): **只放"改了是松紧变了"的数, 不放"改了是逻辑变了"的数**。
// 所以召回给什么粒度(主键+命题行 vs 全文)、孤证不立的 need=2、IDF_FLOOR
// 都不进这里 —— 那些改了是换一套行为, 该由测试锁死。
//
// 🔴 body_hard_tokens 是【改判进来的】: 体积闸原先按"改了是逻辑变了"整组排除在外。
// 但闸从三条线(软行数/硬行数/硬字符)收成一条之后, 它就只剩松紧含义 ——
// 950 还是 1500 不改变任何行为分支。而它恰恰是最需要跑一段时间反复调的数:
// 定太松形同虚设(旧值 16000 实测拦不住任何东西), 定太紧则把人逼去绕道。
// ⚠️ 代价明写: 人格自己也能改这个数把闸调松。接受它 —— 改了会打 [tuning] 覆盖生效
// 日志留痕, 比给一个隐蔽的 force 开关让人无声绕过要好。
//
// 🔴 自动召回的注入分档线**刻意不在这里**: 直接用 tier_hi。它的原注释逐字写着
// 「≥此值 = 高档, 当事实直接注入」—— 线本来就有, 只是从没人去用它。
// 再造一个 recall_inject_floor 等于同一件事两个真源, 迟早各调各的。
const TUNING_DEFAULTS = {
  tier_hi: 0.55, tier_mid: 0.15, sem_floor: 0.74, sem_ceil: 0.90, fallback_conf: 0.08,
  default_k: 8, fallback_max: 5, co_edge_min_weight: 2, co_touch_max_batch: 6,
  pre_query_threshold: 110,
  recall_inject_max: 3, recall_inject_budget: 240,
  recall_hint_max: 3, recall_hint_floor: 0.3,
  provisional_batch: 5, recall_used_window: 20, superseded_penalty: 0.5,
  body_hard_tokens: 950,
  family_sat_count: 1,
  graph_slots: 2,
  dup_hint_cos: 0.96,
  conflict_cos_in: 0.955, conflict_cos_link_ok: 0.96, conflict_cos_weight: 30,
};

let _dataDir = null;   // 宿主注入的可写数据目录; null = 只有出厂默认
let TUNING = load();

function read(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }

function load() {
  const base = read(path.join(FACTORY_DIR, FILE)) || {};
  const ov = _dataDir ? read(path.join(_dataDir, FILE)) : null;
  if (ov) console.log('[tuning] 覆盖生效:', Object.keys(ov).filter((k) => !k.startsWith('_')).join(','));
  return ov ? { ...base, ...ov } : base;
}

// 只认数字。写错类型(比如填成字符串 "0.15")时回落默认, 而不是让 NaN 悄悄污染整条打分链。
// 每次调用现读 TUNING —— 拆包前这些值是模块级 let, reloadTuning() 就地改写;
// 拆成多文件后若各自 import 一份数值就会变成快照, 热改当场失效, 所以一律走这个函数。
const tune = (k) => (typeof TUNING[k] === 'number' ? TUNING[k] : TUNING_DEFAULTS[k]);

// 重新读盘并就地生效。标定器改完一个数要能当场验, 否则每调一次就得重启一次进程。
function reloadTuning() {
  TUNING = load();
  return currentTuning();
}

// 工具层(memory-tools-v2.js)的 k / 兜底条数 / 查重挡门线也从这里取, 免得配置散成两份。
// 先摊 TUNING 原始值(带上 json 里的自定义键), 再用 tune() 覆盖掉受类型校验的那几个。
function currentTuning() {
  return { ...TUNING_DEFAULTS, ...TUNING,
    tier_hi: tune('tier_hi'), tier_mid: tune('tier_mid'),
    sem_floor: tune('sem_floor'), sem_ceil: tune('sem_ceil'),
    fallback_conf: tune('fallback_conf'), co_edge_min_weight: tune('co_edge_min_weight'),
    co_touch_max_batch: tune('co_touch_max_batch') };
}

// 宿主注入数据目录。改完文件就生效, 不用重启 app。提示语那边(config-loader)本来就是热的,
// 标定值不热的话「改配置」这件事会一半要重启一半不要 —— 那种不一致迟早坑人。
function setDataDir(dir) {
  _dataDir = dir || null;
  reloadTuning();
  watch();
  return currentTuning();
}

// 监听目录而不是文件: 编辑器多是"写临时文件再 rename", 直接盯文件会在第一次保存后失联。
let _watchers = [];
let _t = null;
function watch() {
  for (const w of _watchers) { try { w.close(); } catch (_) {} }
  _watchers = [];
  for (const d of [FACTORY_DIR, _dataDir]) {
    if (!d) continue;
    try {
      if (!fs.existsSync(d)) continue;
      const w = fs.watch(d, (_e, fn) => {
        if (fn !== FILE) return;
        if (_t) clearTimeout(_t);
        _t = setTimeout(() => { _t = null; try { reloadTuning(); console.log('[tuning] 已热读'); } catch (_) {} }, 120);
        _t.unref && _t.unref();
      });
      w.on('error', () => {});
      // 🔴 unref: 监听器不能把进程吊住。拆包前它就是吊住的 —— app 里看不出来(Electron 自有循环),
      // 但任何"require 记忆体跑一段就退出"的纯 node 脚本都会挂死在结尾, 而那恰恰是
      // "任何应用都能吃记忆体"的常见吃法。unref 之后热读照常, 只是不再单独撑着循环。
      w.unref && w.unref();
      _watchers.push(w);
    } catch (_) { /* 监听不上只退回"改完要重启", 不更坏, 不该炸 */ }
  }
}
watch();

module.exports = { tune, reloadTuning, currentTuning, setDataDir, TUNING_DEFAULTS };
