'use strict';
// day-opener.js — 当天第一条真人消息前多垫一段: 先查一遍对方快到期 / 没做完的事, 值得提就提一件。
// 同一个名额也给「每天主动开口」(takeDayGreet): 对方还没说话, 人格先开口。
// 一天只垫一次(记在记忆库 meta 的 day_opener_last), 不进常驻 —— 常驻每轮付费, 这段一天付一次。
// 开关在 main/day_opener.json(行业版覆盖成关: 店主一天第一句多半是在办正事, 插一件旧事是打扰)。
const { cfg } = require('../host');
const { todayLocal, addDays } = require('../memory');
const { HAS_EXTERNAL_TEXT } = require('./util');

// 命题里写着明天到 3 天后日期的条目(对方自己的, 不含出厂)。检索不懂「明天」= 哪个日期, 这一步由程序算。
// 不含今天: 今天的日期多半只是「这条是今天记的」(当天开销之类), 不是一件要来的事。
function datedSoon(st, today, n = 3) {
  if (!st.db || typeof st.db.all !== 'function') return [];
  const days = Array.from({ length: n }, (_, i) => addDays(today, i + 1));
  const where = days.map(() => 'claim LIKE ?').join(' OR ');
  return st.db.all(`SELECT slug, claim FROM nodes WHERE status='active' AND is_factory=0 AND (${where})`
    + ' ORDER BY id DESC LIMIT 3', days.map((d) => `%${d}%`)) || [];
}

// 两个入口共用: 今天还没用过名额就取 textKey 那段文案 + 快到期条目, 并记下今天已用。
// gate(today) 返回假 = 今天还轮不到(不占名额)。
function take(agent, textKey, gate) {
  let conf;
  try { conf = cfg.json('main/day_opener'); } catch (_) { return ''; }
  if (conf.enabled === false) return '';
  const st = agent && agent.memory && agent.memory.store;
  if (!st || typeof st.getMeta !== 'function') return '';
  try {
    const today = todayLocal();
    if (st.getMeta('day_opener_last') === today || (gate && !gate(conf, today))) return '';
    // 文案与开关不能同名: config-loader 的 json()/text() 共用一个按 key 的缓存, 同名会互相顶
    let body = cfg.text(textKey).trim() + '\n';
    const soon = datedSoon(st, today);
    if (soon.length) body += `(Dated in the next 3 days in your memory:\n${soon.map((r) => `- ${r.slug}: ${r.claim}`).join('\n')})\n`;
    st.setMeta('day_opener_last', today);   // 读成功了才记, 否则读失败那天就白丢了
    return body;
  } catch (e) {
    console.error(`[day-opener] ${agent.name} 失败(跳过): ${e && e.message}`);
    return '';
  }
}

function takeDayOpener(agent, srcKind, isHeartbeatPing) {
  if (!HAS_EXTERNAL_TEXT(srcKind) || isHeartbeatPing) return '';
  return take(agent, 'main/day_opener_text');
}

// 每天主动开口: 当天第一次启动, 或开着过夜到了 greet_hour 点, 人格先说一句 —— 谁先到谁说。
// 与上面共用 day_opener_last, 所以一天只说一次: 先开了口, 对方第一句就不再垫; 对方先说了, 就不再开口。
// 谁有资格开口(只管家 · 没被 reminder 暂停)由宿主判, 这里只管今天轮不轮得到。
function takeDayGreet(agent, bootDay, now = new Date()) {
  return take(agent, 'main/day_greet_text', (conf, today) =>
    conf.greet !== false && (bootDay === today || now.getHours() >= (Number(conf.greet_hour) || 9)));
}

// 出生那天已经见过主人(出生教育最后一段就是招呼), 当天的名额算用掉, 否则招呼完十几秒又开一次口。
function markOpenedToday(agent) {
  const st = agent && agent.memory && agent.memory.store;
  try { if (st && typeof st.setMeta === 'function') st.setMeta('day_opener_last', todayLocal()); }
  catch (e) { console.error(`[day-opener] ${agent && agent.name} 记今天已开口失败: ${e && e.message}`); }
}

module.exports = { takeDayOpener, takeDayGreet, markOpenedToday };
