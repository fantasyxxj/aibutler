// memory-session-guard.js — memory_section 的 session 级判重, 拦 memory-storm 循环。
//
// 🔴 病根(2026-09-04 用户报"疯狂吐泡泡·一直查记忆"): memory_query 结果里的 [[link]] 指针
// 诱导 AI 一次次 memory_section 展开, 而图有 A↔B 双向边是常态; AI 顺链走时每次都是独立
// MCP 调用, 没有跨调用 visited 集合, 于是 A→B→A→... 走圈, 一轮 20+ memory_* 循环没停。
// 引擎单次 memory_query/走图内部有 visited 挡, 但 AI 手动的多次 section 没挡。
//
// 修法: agent.sessionExpanded (Map<key, {chars, hash}>) 记本 session 已展开的 id, 命中重复
// section 就返"精简回执 + base_hash", 不重发全文。force=true 无视判重(真需要重看)。
// clear/compact 会清空 sessionExpanded —— 新 session 应能重看老 body。
//
// base_hash 是 memory_upsert(传 body)/memory_write 需要的凭证, 精简回执给了 hash 就够。
// 拆出成文件的原因: memory-tools-v2.js 已到 500 行门禁, 不再长。

'use strict';

const txt = (t) => ({ content: [{ type: 'text', text: t }] });

// 命题行永远印在最前: 召回提示只给 slug("not shown — memory_section these"), 而自长节点大多正文为空 ——
// 只回 "(x body is empty)" 时规矩本身一个字都没到模型眼前(10-11 行业版 G2: 召回命中「数值用输入框」却照样纯文字问)。
const claimLine = (w) => (w.claim ? `claim: ${w.claim}\n` : '');

/** wholeBody: (node) => { slug, claim, content, hash, lang }; agent 允许 null(纯函数调用不走判重). */
function sectionOne(agent, wholeBody, node, force) {
  const w = wholeBody(node);
  const key = w.slug || String(node);
  if (!String(w.content).trim()) return `${key}\n${claimLine(w)}(body is empty — the claim above is the whole node)`;
  const seen = agent && agent.sessionExpanded && agent.sessionExpanded.get(key);
  // 正文读过之后被改了(自己刚 upsert 过也算)就照常给全文 + 新 hash —— 精简回执只给"没变"的那种。
  // 10-14 dev: 改完一次再读, 回的是旧 hash, 下一次 upsert 必然撞 hash 不符, 只能 force 重读。
  if (seen && !force && seen.hash === w.hash) {
    return `(${key} already opened this session · body was ${seen.chars} chars · base_hash: ${seen.hash})\n${claimLine(w)}Need to re-read? force=true. Just wanted the hash for memory_upsert / memory_write? that's above and unchanged.`;
  }
  const chars = String(w.content).length;
  if (agent && agent.sessionExpanded) agent.sessionExpanded.set(key, { chars, hash: w.hash });
  return `${key} body (${chars} chars)\nbase_hash: ${w.hash}${w.lang ? `\n⚠️ shown in ${w.lang} (translated) — writing back replaces the SOURCE text` : ''}\n${claimLine(w)}\n${w.content}`;
}

// node 可以是空格分隔的多个: 召回提示一次列好几个 slug 让它展开, 只收一个就逼它挨个调或干脆放弃。
function sectionWithGuard(agent, wholeBody, node, force) {
  const refs = String(node || '').split(/[\s,、]+/).filter(Boolean);
  if (!refs.length) return txt('Pass `node`: a slug or numeric id (space-separated for several).');
  return txt(refs.map((r) => {
    try { return sectionOne(agent, wholeBody, r, force); } catch (e) { return `(${r}: ${e.message})`; }
  }).join('\n\n---\n\n'));
}

module.exports = { sectionWithGuard };
