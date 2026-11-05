// scripts/ja-lab-native.js — 把日文实验库改成【日文写的库】。
//
// 第一版语料的 title/description 是中文(教育包本来就是棒头用中文写的), 于是那一轮测的其实是
// "日文问句 → 中文库" 的跨语言检索, 回答不了"日文库装了模型会不会掉"。
// 这一版把 61 条 title 逐条译成日文, 正文保持原样 —— 只有 description 进向量, 所以决定
// 语义那一路的就是这 61 条译文; 关键词那一路则同时吃 title 与正文。
//
// 🔴 泄题防范: 译文只依据中文原意直译, 不参考 queries.json 里的措辞。问句是棒头几个月前
// 按"真客人怎么说"写的口语短句(「キャンセルで」), 与这些书面语标题本来就不同源。
const fs = require('fs');
const path = require('path');

const SRC = '/tmp/ja-mem-lab/memory';
const OUT = '/tmp/ja-native-lab/memory';

const JA = {
  rest_a_ask_boss_vs_act_alone: '店主への確認が要る場合と自分で判断してよい場合の線引き',
  rest_a_check_backend_before_answer: '不確かなときは先に管理画面を確認する · データを推測しない',
  rest_a_complaint_apologize_then_escalate: 'クレームはまず一報でお詫び, ただちに店主へ引き継ぐ',
  rest_a_customer_service_all_passive: '接客は全て受け身 · 一問一答 · 来た経路へ返す',
  rest_a_fee_only_from_backend: '料金は管理画面の項目のみを根拠にする · 項目が無ければ請求しない',
  rest_a_first_touch_within_5s: '初動は5秒以内 · 一度で完結 · お待ちくださいは禁止',
  rest_a_hard_limit_not_ai_judgment: 'しきい値は具体的な数字で固定する · その場の裁量で決めない',
  rest_a_line_oa_free_stage_priority: 'LINE公式アカウント無料枠ではリッチメニュー・自動応答・友だち追加あいさつを優先',
  rest_a_mirror_language: 'お客様が使った言語に合わせて返す',
  rest_a_never_wipe_prod_data: '本番データは触らない · 投入スクリプトは新規開店時のみ',
  rest_a_no_internal_jargon_to_boss: '店主への報告に社内用語を使わない',
  rest_a_no_progress_narration: '進捗の実況中継をしない',
  rest_a_no_standby_message: '「少々お待ちください」だけのメッセージを送らない',
  rest_a_one_shot_finish: '一度で完結させる · 何度も送らない',
  rest_a_platform_url_first: '外部サービスの操作を案内するときは先に入口URLを渡す',
  rest_a_query_memory_before_action: '動く前に記憶を検索する · 記憶頼みで答えない',
  rest_a_sink_qa_to_memory: '一度聞かれたことは記憶に残す',
  rest_a_verify_ui_before_guide: '外部サービスの画面は変わりやすい · 案内前に現物を確認する',
  rest_a_write_only_what_you_do: 'やることだけ書く · 禁止事項一覧や保険的な記述は削る',
  rest_b_allergies_handling_sop: 'アレルギー対応の手順 · 長期の顧客カルテと今回の予約메모の二層',
  rest_b_anniversary_special_sop: '記念日・誕生日は受け身で対応 · 今回の予約メモのみ, 長期保存して自発的に持ち出さない',
  rest_b_ask_back_wording_convention: '聞き返しの言い回し · 「新しいご依頼」と受け取れる形にし, 同じ予約の変更と誤解させない',
  rest_b_askback_finish_saves_quota: '問いかけで締めると返信が来て次の無料返信枠が使える',
  rest_b_channel_source_match_response: '来たチャネルへ返す · チャネルをまたいで返信しない',
  rest_b_complaint_apologize_escalate_wait: 'クレーム対応の実装 · 一報目はreplyTokenでお詫び, 二報目で店主へ内部連携, 店主の判断を待つ',
  rest_b_conflict_409_offer_two_options: '満席とぶつかったとき · 全件並べず二択を提示する',
  rest_b_faq_from_memory_not_query: 'よくある質問は記憶から即答 · その場で管理画面を引かない',
  rest_b_follow_event_no_first_time_assumption: '友だち追加は初回とは限らない · ブロック解除の再追加もある',
  rest_b_intent_router_first_move: 'お客様のメッセージを受けたときの意図の振り分け表',
  rest_b_late_arrival_sop: '遅刻の手順 · お客様から遅れる連絡が来たら該当予約を特定し店の取り置き方針に従う',
  rest_b_multi_reservation_ask_not_guess: 'どの予約か特定できないときは一覧を添えて聞き返す · 推測や自動選択をしない',
  rest_b_no_show_handling_sop: '無断キャンセル後に問い合わせが来たときの手順 · 店の方針に従い, 項目が無ければ違約金なし',
  rest_b_reservation_cancel_sop: '予約の取り消し手順',
  rest_b_reservation_create_sop: '予約成立までの手順',
  rest_b_reservation_reschedule_sop: '予約の変更手順 · 時間・席・滞在時間 · 予約番号は変わらない',
  rest_b_returning_customer_recognition_sop: '常連のお客様を見分ける手順 · 来店回数を確認し基準に達していれば「おかえりなさい」で迎える',
  rest_b_seat_type_request_sop: '席種のご希望への対応手順 · 全席禁煙の扱いも含む',
  rest_b_three_beat_reflex: '接客の三拍子 · その場で確認 → 判断 → 一度で送る',
  rest_b_three_states_ending: '締め方の三種類 · 受領のご連絡 / 聞き返し / 確認のお伺い',
  rest_b_welcome_template_5_sections: '友だち追加あいさつは5部構成の固定テンプレート · 多言語版は事前に用意しその場で作らない',
  rest_c_bus_exec_apicall_only: "bus_exec は command='apicall' のみ · スキーマ上の sql は不具合",
  rest_c_correlation_id_36_char_limit: 'correlation_id はテーブル定義上36文字以内',
  rest_c_line_reply_token: 'LINEのreplyTokenは60秒の期限 · 無料でpush通数に含まれない',
  rest_c_line_webhook_fanout: 'LINEのwebhookをagent_inboxへ配る仕組み · プラットフォーム構成',
  rest_c_memory_tools_family: 'memory_* 系の道具 · AIが自分用に使うグラフ記憶 · お客様には見せない',
  rest_c_reservation_cancel: '予約の取り消しは PATCH /bus/v1/admin/reservations/{id}/status · 状態変更で行いDELETEは使わない',
  rest_c_reservation_create: '予約の作成は POST /bus/v1/admin/reservations',
  rest_c_reservation_reschedule: '予約の変更は PATCH /bus/v1/admin/reservations/{id}/reschedule · 予約番号は不変, 409のときは available_zones が付く',
  rest_c_reservation_update_party: '人数だけの変更は PATCH /bus/v1/admin/reservations/{id} · 日時変更とは別の窓口',
  rest_c_send_line_flex: 'send_line_flex はリッチなカード送信 · メニュー / 予約カード / 二択ボタン',
  rest_c_send_line_image: 'send_line_image は画像送信 · 料理写真や店内写真',
  rest_c_send_line_sticker: 'send_line_sticker は公式スタンプ送信 · 多用しない, 砕けすぎる',
  rest_c_send_line_text_only_entry: 'send_line がLINEのテキスト送信の唯一の入口',
  rest_c_sql_query_customer_by_line_id: 'SQLでお客様の身元と言語を引く · 友だち追加時の即時照会用',
  rest_c_sql_query_customer_upcoming: 'SQLでお客様の今後の予約を引く · 取り消しや変更の第一手',
  rest_c_sql_query_item_by_keyword: 'SQLで料理を探す · 多言語キーワード · JSON_EXTRACT と LIKE',
  rest_c_sql_query_seat_availability: 'SQLで空席を調べる · WHEREを絞る, 全件取得しない',
  rest_c_talk_peer_async: 'talk_peer は人格間の非同期連絡 · 一方向で送ったら即戻る',
  rest_c_tool_entry_hard_rules: '道具の入口に関する三つの禁止事項 · 404になるのは「使えるはず」という思い込み',
  rest_c_tool_selection_priority: '道具の選び方 · pack の専用ツールを優先し bus_exec の apicall は最後の手段',
  rest_c_utc_jst_conversion: 'UTCと日本時間の換算 · 会話は日本時間, 保存はUTC',
};

fs.rmSync(path.dirname(OUT), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let done = 0, missing = [];
for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith('.md'))) {
  const id = f.replace(/\.md$/, '');
  const text = fs.readFileSync(path.join(SRC, f), 'utf8');
  const ja = JA[id];
  if (!ja) { missing.push(id); continue; }
  // 只换 name 与 description(向量只吃 description), 正文原样保留。
  const body = text.split(/\n---\n/).slice(1).join('\n---\n');
  fs.writeFileSync(path.join(OUT, f),
    `---\nname: ${ja}\ndescription: "${ja.replace(/"/g, "'")}"\nmetadata:\n  type: reference\n  use_count: 1\n---\n${body.replace(/^[\s\S]*?\n/, '')}`);
  done++;
}
console.log('日文化完成:', done, '条 · 未覆盖:', missing.length, missing.join(' '));
