#!/usr/bin/env node
// 出生知识包「第二遍」: 逐条评是不是真常用 → 定 pinned 成员 + 冷启动 seed_use_count。
// 一次性改包脚本, 可重复跑(幂等)。判据见 reference_pinned_is_most_used_not_most_important。
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'personal', 'config', 'onboarding', 'knowledge');

// ── pinned: 只有 2 条。快查表的价值来自稀缺性, 不来自覆盖率。
// 判据是「翻查频次 × 每次翻查成本」, 且必须是 schema/起床清单都不携带的具体事实。
const PINNED = {
  reference_docs_root_manuals_and_skills:
    '文档根路径 —— 要翻手册时的唯一入口, 没有别的地方带着它, 记不住就只能满盘找',
  feedback_reply_to_the_channel_it_came_from:
    '每一条回话都要判一次, 且代码不兜底(见 feedback_channel_choice_is_not_coded), 判错等于发错人',
};

// ── seed_use_count: 解冷启动排序。全 1 会让 hot() 退化成字母序。
// 上限刻意压到 4: 人格自己真实用几次就能盖过出厂估计, 出厂值不该压住真实频次。
const DAILY = new Set([
  'feedback_sink_criterion_is_novelty_not_importance',
  'feedback_sink_fragments_never_batch',
  'feedback_query_memory_before_acting',
  'feedback_wake_first_action_is_memory_hot',
  'feedback_memory_is_a_snapshot_verify_against_reality',
  'feedback_character_verify_before_speaking',
  'feedback_done_means_verified_done',
  'feedback_three_kinds_of_matter_three_handlings',
  'feedback_reply_to_the_channel_it_came_from',
  'feedback_context_is_disposable_memory_is_storage',
  'feedback_touch_when_truly_used',
  'feedback_dedupe_query_top3_before_upsert',
  'feedback_upsert_overwrites_body_it_does_not_append',
  'reference_four_id_prefixes',
  'reference_one_node_one_thing',
  'reference_docs_root_manuals_and_skills',
  'reference_this_is_a_multi_persona_system',
  'feedback_do_it_yourself_if_it_is_within_reach',
]);

const BACKGROUND = new Set([
  'reference_semantic_model_runs_locally',
  'reference_keepalive_is_a_money_saving_move',
  'reference_keepalive_breaks_even_at_ten_times',
  'reference_i_run_inside_the_butler_desktop_app',
  'reference_markdown_renders_but_channels_differ',
  'reference_message_timestamp_is_engine_stamped',
  'reference_doc_paths_are_relative_to_the_docs_root',
  'reference_no_reply_yet_is_not_failure',
  'reference_channel_tools_exist_only_when_configured',
  'reference_arbitration_only_changes_metadata_and_is_undoable',
  'reference_memory_md_constraint_is_bytes_not_lines',
  'reference_persona_home_dir_defaults',
  'reference_a_persona_can_be_renamed_and_rescoped_anytime',
  'reference_first_persona_holds_the_roster',
  'reference_auto_compact_has_four_triggers',
  'reference_never_compact_mid_turn',
  'feedback_tune_by_observing_yourself_not_by_guessing',
  'reference_context_usage_is_the_authoritative_number',
  'feedback_closing_words_need_no_reply',
  'reference_timeseries_content_one_per_day_index_only',
  'feedback_dedupe_guard_only_catches_near_copies',
]);

// 按行插入而不是 JSON.stringify 回写: 包里 edges 是紧凑单行, 整体序列化会把每条边
// 摊成 4 行, 制造一个没法 review 的巨大 diff。
let pinnedHit = 0;
const tally = { 4: 0, 2: 0, 1: 0 };

for (const f of ['leaf_core', 'butler_extra']) {
  const p = path.join(DIR, f + '.json');
  const raw = fs.readFileSync(p, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    // 幂等: 先扔掉上一次跑出来的行, 再重新插
    if (/^\s*"(seed_use_count|pinned)"\s*:/.test(line)) continue;
    out.push(line);
    const m = line.match(/^(\s*)"slug"\s*:\s*"([^"]+)"\s*,\s*$/);
    if (!m) continue;
    const [, indent, slug] = m;
    const seed = DAILY.has(slug) ? 4 : BACKGROUND.has(slug) ? 1 : 2;
    tally[seed] += 1;
    out.push(`${indent}"seed_use_count": ${seed},`);
    if (PINNED[slug]) {
      out.push(`${indent}"pinned": { "reason": ${JSON.stringify(PINNED[slug])} },`);
      pinnedHit += 1;
    }
  }
  const text = out.join('\n');
  JSON.parse(text); // 写回去之前先自证还是合法 JSON
  fs.writeFileSync(p, text);
  console.log(`${f}: 已写`);
}

const missing = Object.keys(PINNED).length - pinnedHit;
console.log(`seed 分布 4=${tally[4]} · 2=${tally[2]} · 1=${tally[1]} · pinned=${pinnedHit}`);
if (missing) { console.error(`🔴 有 ${missing} 条 pinned slug 在包里找不到 —— 名字打错了`); process.exit(1); }
