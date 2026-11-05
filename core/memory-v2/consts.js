// 图记忆 v2 的常量与纯函数。由 memory-v2.js 顶部抽出(内核抽包第 2 步)。
// 这里没有状态、不碰磁盘、不认识宿主 —— 任何应用可以单独 require。
const {
  todayLocal, daysBetween, REC_W, USE_W,
} = require('../memory');
const { tune } = require('./tuning');

const IMP_BASE_V2 = { high: 6.0, med: 3.0, low: 1.0 };
const IMP_HL_V2 = { high: 40, med: 25, low: 10 };

// IDF 地板。触到它 = 这个 gram 全库到处都是, 没有信息量。既用于给 IDF 兜底,
// 也用于把废词 gram 踢出段覆盖的分母 —— 两处必须同一个值, 所以只此一份。
const IDF_FLOOR = 0.15;

// —— 体积: 一条硬闸(拒写), 阈值从 tuning 读 ——
// 🔴 阈值【不能按存量分位数定】—— 那是用病人定义健康。这库里所有正文都是同一个爱写论证的
// AI 写的, 照它的 p90 定闸只会把现状合法化: 旧值 16000 字符就是那么来的, 实测拦不住任何东西
// (肥节点平均 5358 字符, 全部合法)。且实测推翻了旧假设"追加才是体积失控主路径" ——
// 191 条 ≥3000 字符的节点里 77% 从没被追加过, 5358 字符里 5029 是首次写入自带。
// 病根是【一次就写这么长】, 所以闸必须卡单次写入的正文总长。
//
// 950 是按"一个命题 + 怎么用"该有多长定的: 装得下命令、参数、别踩的坑, 装不下推理链。
// 撞闸的出路是拆成原子节点 + [[边]] —— 而那正是想要的方向, 所以这道闸绕不出坏结果。
// 行数闸已废: 一条线够了, 两条线只是多一个要同步的概念。
//
// 🔴 口径是 token 不是字符。裸字符数对中英是两把尺子: 同一条知识的英文正文约是中文版的
// 1.8 倍字符, 于是 1500 字符的闸在中文库上形同虚设、在英文库上成片误拦(实测出厂包
// en 38 条超 / zh-CN 只 2 条)。而正文真正的代价是它占多少上下文, 那本来就该用 token 量。
const bodyHardTokens = () => tune('body_hard_tokens');

// 粗估。CJK 一字约 0.7 token, 拉丁约 4 字符 1 token —— 分开数, 因为混着算
// 会在中文为主的库上系统性低估一倍, 而低估预算等于预算白设。
// 不追求准: 闸是"别让一条知识把上下文吃掉", 差一成不影响它起作用。
function estTokens(s) {
  const t = String(s || '');
  let cjk = 0;
  for (const ch of t) if (ch.charCodeAt(0) > 0x2e80) cjk++;
  return Math.ceil(cjk * 0.7 + (t.length - cjk) / 4);
}

function bodySize(body) {
  const t = String(body || '');
  return {
    lines: t.split('\n').filter((l) => l.trim()).length,
    chars: t.length,
    tokens: estTokens(t),
  };
}

// 超限拒写。🔴 报错必须给【出路】而不是只说"不行" —— 只说不行的挡门, 我下一步只会去想怎么绕过它。
// force 是给迁移器和出厂包灌入留的口: 那两条路是整批搬运既有内容, 不该被治理闸拦住。
function checkBodyLimit(body, { force = false, slug = '' } = {}) {
  if (force) return;
  const { tokens } = bodySize(body);
  const limit = bodyHardTokens();
  if (tokens <= limit) return;
  throw new Error(
    `正文超硬闸(${tokens} token, 上限 ${limit})${slug ? `: ${slug}` : ''}\n` +
    `正文只装【这条命题的说明和用法】。到这个体积, 装进去的要么不止一个命题, 要么混进了论证过程。\n` +
    // 🔴 先点名论证: 实测正文膨胀的主体不是编年史也不是追加, 是"当初怎么说服自己这条为真"的
    // 推理链。它在对话当下有价值(达成一致), 命题一旦确立就是死重 —— 而写的人不会自己想到删它。
    `⚠️ 先删这两类: ① 当初怎么证明它为真的推理链、对照、权衡 —— 说服已经完成了 ` +
    `② 变化史 —— 改动前后原文 history 全量存着, memory_revisions 捞得回来, 删了不丢。\n` +
    // 台账与命题要分开开方子: 命题型拆完会收敛, 台账型永远单调增长, 拆完照样涨回来。
    `⚠️ 再问一句: 这条需要你定期回来追加一行吗? 需要的话它是【流水台账】不是命题 —— ` +
    `把数字挪进数据库/脚本现算, 记忆里只留结论。拆它没有用, 拆完还会涨回来。\n` +
    `确属一叠命题, 三条出路: (a) 拆成几个原子节点, 用 [[边]] 连起来(推荐) ` +
    `(b) 只留结论在 claim, 过程不留 (c) 确属整批搬运(迁移/出厂包)传 force=true`);
}

// 命题行超注入预算 = 这条知识**永远进不了自动召回**: 注入循环第一条就超预算就整个停下,
// 一条都不给, 而 recall_log 照样记它命中 —— 静默到只看日志会以为人格收到了。
// 🔴 闸线就用注入预算本身: 限额定在那里, 写入端就该知道有这回事, 否则等于让人写一条注定
// 送不出去的知识, 全程没有任何提示。而且它专挑"AI 不会想到自己去查"的那类知识下手 ——
// 行为约束、反直觉禁令只有自动召回这一条通路, 走不通就等于这条知识不存在。
function checkClaimLimit(claim, { slug = '', lang = '' } = {}) {
  const limit = tune('recall_inject_budget');
  const cost = estTokens(`- #999 ${slug} ${claim}`);
  if (cost <= limit) return;
  throw new Error(
    `命题行超注入预算(${cost} token, 上限 ${limit})${slug ? `: ${slug}` : ''}${lang ? ` [${lang}]` : ''}\n`
    + '这么长的命题行**一个字都注入不进上下文**, 而检索日志照样记它命中 —— 写完看不出任何异常。\n'
    + '⚠️ 命题行是索引不是说明书: 只装【一句可判真假的断言 + 照着就能写对的最小完整形状】'
    + '(最常用的那个参数、正确的例子); 参数全表、边界、罕见分支搬进 body。\n'
    + '⚠️ 但别把高频参数也搬走 —— 人格拿到命题行就直接动手, 不会去展开正文, 搬进正文等于删掉。');
}

function semConf(cos) {
  const floor = tune('sem_floor'), ceil = tune('sem_ceil');
  return Math.max(0, Math.min(1, (cos - floor) / (ceil - floor)));
}

function tierOf(conf) {
  if (conf >= tune('tier_hi')) return 'high';
  if (conf >= tune('tier_mid')) return 'med';
  return 'low';
}


// pinned 不加分: 它已常驻在系统提示里, 召回排序与它无关。
function hotnessV2(importance, lastUsed, useCount) {
  const imp = (importance || 'low').toLowerCase();
  const base = IMP_BASE_V2[imp] != null ? IMP_BASE_V2[imp] : 1.0;
  const hl = IMP_HL_V2[imp] != null ? IMP_HL_V2[imp] : 14;
  const d = daysBetween(lastUsed || todayLocal(), todayLocal());
  const recency = hl > 0 ? Math.exp(-d / hl) : 0;
  const uc = Math.max(0, useCount || 0);
  return Math.round((base + REC_W * recency + USE_W * Math.log(1 + uc)) * 1000) / 1000;
}

module.exports = {
  IMP_BASE_V2, IMP_HL_V2, IDF_FLOOR,
  bodyHardTokens,
  bodySize, checkBodyLimit, checkClaimLimit, estTokens, semConf, tierOf, hotnessV2,
};
