// i18n-quit.js — 关闭 butler 那层遮罩的文案(四种语言)。
//
// 单独成文件是因为 i18n.js 已过 500 行上限的行数门禁, 跟 i18n-zh-TW.js 拆出去是同一个理由。
//
// 🔴 这几句话有一条硬口径: **不许说"没存下来"**。看门狗判死只代表我们不等了, 人格多半正在
// 把记忆写完(2026-09-24 实测: 判死之后 CLI 侧照样写完了)。把"我等不及了"说成"它失败了"
// 是在对用户撒谎, 而用户据此按下的"强制关闭"才真的会丢活。
module.exports = (UI) => {
  const add = (loc, s) => { if (UI[loc]) Object.assign(UI[loc], s); };

  add('zh-CN', {
    sediment_writing: '正在写第 {n} 条记忆',
    sediment_using: '正在用 {tool}',
    sediment_thinking: '还在想，一个字还没落下',
    sediment_queued: '还有 {n} 个排在后面',
    sediment_notice_title: '还没存完',
    sediment_notice_busy: '它还在写 —— 写完会自己关闭，这个框不用管',
    sediment_notice_stuck: '这些活还在上下文里没丢，下次开起来还能再存一次',
    sediment_btn_wait: '先别关，让它写完',
    sediment_btn_force: '不等了，强制关闭',
  });

  add('zh-TW', {
    sediment_writing: '正在寫第 {n} 條記憶',
    sediment_using: '正在用 {tool}',
    sediment_thinking: '還在想，一個字還沒落下',
    sediment_queued: '還有 {n} 個排在後面',
    sediment_notice_title: '還沒存完',
    sediment_notice_busy: '它還在寫 —— 寫完會自己關閉，這個框不用管',
    sediment_notice_stuck: '這些活還在上下文裡沒丟，下次開起來還能再存一次',
    sediment_btn_wait: '先別關，讓它寫完',
    sediment_btn_force: '不等了，強制關閉',
  });

  add('en', {
    sediment_writing: 'Writing memory #{n}',
    sediment_using: 'Using {tool}',
    sediment_thinking: 'Still thinking — nothing written yet',
    sediment_queued: '{n} more waiting their turn',
    sediment_notice_title: 'Not finished saving',
    sediment_notice_busy: 'Still writing — it will close itself when done, you can ignore this',
    sediment_notice_stuck: 'None of this is lost: it stays in context and can be saved next launch',
    sediment_btn_wait: 'Leave it open, let it finish',
    sediment_btn_force: 'Close now without waiting',
  });

  add('ja', {
    sediment_writing: '記憶を {n} 件目まで書いています',
    sediment_using: '{tool} を使っています',
    sediment_thinking: 'まだ考えています — 一文字も出ていません',
    sediment_queued: 'あと {n} 件が順番待ちです',
    sediment_notice_title: 'まだ保存し終わっていません',
    sediment_notice_busy: 'まだ書いています —— 終わったら自分で閉じます。この枠は放っておいて大丈夫です',
    sediment_notice_stuck: '作業は消えていません。文脈にそのまま残っていて、次に起動すればもう一度保存できます',
    sediment_btn_wait: 'まだ閉じない（書き終わらせる）',
    sediment_btn_force: '待たずに強制終了',
  });
};
