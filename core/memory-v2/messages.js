// 引擎吐给调用方的文案(报错 + 写入回执)。从 write.js 里搬出来的, 不是新写的。
//
// 🔴 为什么是单语英文, 没有回落链: 2026-08-30 作者定「程序里给 AI 看的文本一口气全改英文,
// 两版共用一套, 以后不要再多套」—— 内核是 personal/ 和 industry/ 共用的, 行业版卖给日本店主,
// 内核里躺着中文就是问题。原先按显示语言在中/英之间挑一份的机制连同 zh-CN 那半整个撤掉了。
// 分界在【受众】不在语言: 模型读的 → 英文一套; 店主/用户读的(界面文案、记忆内容) → 照旧多语。
//
// 🔴 为什么落在引擎里而不是 core/config/main/*.json: 记忆引擎刻意能脱离外壳独活
// (CODE_INDEX 里 core/memory-v2/host.js 那条: 注入点可选)。搬进 config 就等于给引擎
// 加了一个必须注入的依赖, 拿它单跑测试要先搭宿主。

// 每条一个 key。占位符写 {名字}, 由 vars 填。
const M = {
  tag_leak: 'The value of parameter "{field}" contains a tool-call tag ({tag}) — this call\'s arguments were not '
    + 'separated properly, so the fields after it were most likely swallowed whole into this one string.\n'
    + 'Call again, passing each argument separately.\n'
    + '⚠️ Unguarded this fails silently: the tool returns success and the receipt even echoes the content '
    + 'back to you, yet not one character of the lost fields reached the database.\n'
    + '(If you really need that literal in the body, use fullwidth angle brackets or inline code.)',

  imp_is_not_pinned: 'pinned is no longer an importance value; use setPinned() — it is orthogonal to importance',

  imp_bad: 'importance must be high/med/low, got: {got}',

  node_not_found: 'node not found: {ref}',

  rename_needs_both: 'renameSlug requires both the old and the new slug',

  upsert_needs_ref: 'upsert requires an id or a slug',

  provisional_bad: 'provisional must be 0 (settled) / 1 (migration placeholder) / 2 (tentative, under discussion), got: {got}',

  new_needs_claim: 'a new node must have a claim — memory is built on assertions that can be judged true or false, not summaries',

  new_project_needs_exit: 'a new project_* node must set exit_criteria (what counts as done), otherwise it becomes a zombie '
    + 'project that shows "in progress" forever.',

  upsert_body_needs_hash: 'Node "{ref}" already has a {chars}-character body; passing body replaces it wholesale.\n'
    + 'Read it first: memory_section(node="{ref}") to get base_hash, then pass that back.\n'
    + '🔴 If you only want to change the claim/keywords, DO NOT pass body — omitted fields are left '
    + 'untouched, so there is no need to rewrite the body.\n'
    + 'To overwrite unconditionally, pass force_overwrite=true.',

  hash_mismatch: 'The body\'s current hash differs from the one you supplied (yours {given} ≠ current {current}).\n'
    + 'It changed after you read it — read it again with memory_section, merge, then write. '
    + 'Overwriting directly would eat that edit.',

  write_needs_node: 'write requires node',

  write_needs_content: 'write requires content (to clear the body pass an empty string — that is an explicit intent)',

  write_body_empty: 'Node "{ref}" has an empty body — write only EDITS an existing body.\n'
    + 'To write a body for the first time use memory_upsert(id="{ref}", body="…").',

  write_needs_hash: 'Node "{ref}" already has a {chars}-character body; write replaces it wholesale.\n'
    + 'Read it first: memory_section(node="{ref}") to get base_hash, then pass that back.\n'
    + 'This gate guards against "thought I was appending, actually wiped it" — it happened once, '
    + 'two nodes lost their content instantly.\n'
    + 'To overwrite unconditionally, pass force=true.',

  write_is_edit_not_add: 'write EDITS, it does not ADD: new content is {next} characters > original {cur}.\n'
    + 'To add content to this memory use memory_upsert(id, body=…, base_hash=…) — a full rewrite that '
    + 'faces the {limit}-token size gate head-on.\n'
    + '⚠️ If you only meant to reword something and it grew, you added new content along the way — think '
    + 'separately about whether that part belongs in this memory. Usually it is a different claim and '
    + 'should be a new node linked with [[edges]].',

  append_needs_parent: 'append requires parent_id',

  append_needs_section: 'append requires section',

  link_self: 'a node cannot link to itself',

  endpoint_missing: 'endpoint does not exist',

  // ── 写入回执。不拦截, 只提示 —— 每条都有触发条件, 干净的写入零提示是设计不是遗漏。
  note_claim_has_date: '📌 There is a date in the claim line — is it part of the claim itself? ("after 8-11 the name banto '
    + 'is void" is; "8-16 done: section writes removed" is not, that is a chronicle). If not, drop the '
    + 'date and rewrite.',

  note_body_many_dates: '📌 {n} dates in the body — which of them are change history? The body holds only the explanation '
    + 'and usage of this claim. Before/after text is already stored in full in history and can be '
    + 'recovered with memory_revisions, so deleting it loses nothing.',

  note_body_near_limit: '📌 Body is {tokens} tokens / limit {limit} — nearly full. Delete the "how I originally proved '
    + 'this true" part first: reasoning chains, comparisons and trade-offs are useful during the '
    + 'conversation (to reach agreement) but become dead weight once the claim is settled. What should '
    + 'remain is only how to use it.',

  // 🔴 下面这些 📌 是写给人格看的, 不是写给它正在服务的人。10-11 行业版实测: 不打这个头时,
  // 店小二把「Does this body carry…?」当成店主在问它, 当场对店主回了一句 body/base_hash 的话, 正事没办。
  notes_head: '(Internal note on that save — for you only, not for the person you are talking to. '
    + 'Act on it silently if it applies, never mention it in your reply, and carry on with their request.)',

  note_body_restates_claim: '📌 Does this body carry information the claim does not already state? — what is worth writing is '
    + 'commands, paths, parameters, and when it does not apply. If it just restates the claim in other '
    + 'words, **leaving it empty is better**: most nodes should have an empty body anyway.',
};

function fill(tpl, vars) {
  if (!vars) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (whole, k) => (vars[k] === undefined ? whole : String(vars[k])));
}

// key 拼错时不静默吐一个空串 —— 那会变成"报错内容是空的"这种最难查的失败。
function msg(key, vars) {
  const entry = M[key];
  if (!entry) return `[memory] missing message key: ${key}`;
  return fill(entry, vars);
}

module.exports = { msg, MESSAGES: M };
