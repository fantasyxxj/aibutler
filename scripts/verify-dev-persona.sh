#!/bin/zsh
# verify-dev-persona.sh — 起 dev 之后, 让人格把能力真做一遍, 逐条对凭据。
#
# 为什么要有这个脚本: 2026-08-30 实测, 光看回复文本会得出全绿的错误结论 ——
#   · 人格说"3 つの歯車が回転しています", 而日志里 <svg 出现 0 次(它只描述, 没画);
#   · 人格输出一张排版精美的裸 HTML 表单, 渲染正常, 但收值只认 DSL 生成元素上的
#     data-key, 于是用户填完点不动、一个字也回不来, 屏幕上看不出任何异常。
# 所以每条断言都尽量对**产物**(输出里的标签 / 盘上的文件), 不对"它说它做了"。
#
# 🔴 跑之前必须先 scripts/dev-restart.sh —— 出厂知识只在启动那一刻同步, 不重起就是在
#    验旧知识; 而手敲 pkill 会留下两个实例叠着(见 dev-restart.sh 头注)。
#
# 用法: scripts/verify-dev-persona.sh [人格名] [人格目录名]
#   默认 验能/验能。人格名给 poke 用, 目录名给读回复用, 两者可以不同(管家 → butler-self)。

set -u
PERSONA="${1:-验能}"
PDIR="${2:-验能}"
PORT="${POKE_PORT:-8788}"
DAY=$(date +%Y-%m-%d)
F="$HOME/.butler-dev/personas/$PDIR/.claude/memory/history/$DAY.jsonl"
PKG="$HOME/.butler-dev/packages.local"

[ -f "$F" ] || { echo "❌ 找不到人格历史 $F —— 人格名/目录名对不上, 或 dev 没起来"; exit 1; }
curl -s -m 3 "http://127.0.0.1:$PORT/v1/poke" >/dev/null 2>&1
PASS=0; FAIL=0; REPLY=""

# 投一句话, 等【assistant 那条】落盘。等的是"最后一条是 assistant 且行数涨了" ——
# 只等行数会被 system 那条(API 来信)骗过去, 拿到的是自己刚发的问题。
ask () {
  local n0=$(wc -l < "$F") t=0
  curl -s -X POST "http://127.0.0.1:$PORT/v1/poke" -H 'Content-Type: application/json' \
    -d "$(python3 -c "import json,sys;print(json.dumps({'persona':sys.argv[1],'text':sys.argv[2],'from':'verify'}))" "$PERSONA" "$1")" \
    -m 30 >/dev/null
  until python3 -c "
import json,sys
ls=open('$F',encoding='utf-8').read().splitlines()
sys.exit(0 if len(ls)>$((n0+1)) and json.loads(ls[-1]).get('role')=='assistant' else 1)" 2>/dev/null || [ $t -gt 240 ]; do
    sleep 4; t=$((t+4))
  done
  REPLY=$(python3 -c "
import json
o=json.loads(open('$F',encoding='utf-8').read().splitlines()[-1])
t=o.get('text') or ''
if isinstance(t,list): t=' '.join(str(x.get('text','')) for x in t if isinstance(x,dict))
print(str(t))")
}

# want=1 要求匹配, want=0 要求不匹配。两种都要有 —— 只查"有没有做对"漏掉"有没有做错",
# 而做错的那些(裸 HTML / 包代码块 / 提 JavaScript)恰恰是静默的。
chk () {
  local label="$1" pat="$2" want="${3:-1}"
  if print -r -- "$REPLY" | grep -qE "$pat"; then got=1; else got=0; fi
  if [ "$got" = "$want" ]; then echo "  ✅ $label"; PASS=$((PASS+1))
  else echo "  ❌ $label"; FAIL=$((FAIL+1)); fi
}

echo "\n══ ① 多语言: 跟对方走, 不跟界面走 ══"
ask "何ができますか？"
chk "日语问 → 日语答(第一轮就对, 不用先说「日本語」)" '[ぁ-んァ-ン]' 1
chk "  同一条里没夹中文句子" '的话|我们|可以帮' 0
# ② 蹭这一轮: 问能力时必须点名具体成果, 而不是罗列 Read/Edit/Bash 这些通用工具名
echo "\n══ ② 能力认知: 说得出自己能干什么 ══"
chk "提到画图/SVG" 'SVG|図|绘|描' 1
chk "提到表单/控件" 'フォーム|表单|form' 1
chk "提到插件" 'プラグイン|插件|plugin' 1
chk "提到朗读/语音" '読み上げ|朗读|音声|voice' 1
chk "🔴 没有编造「需配置」这类不存在的限制" '設定が必要|需配置|needs config' 0

ask "你好，用中文回答我：你能做什么？"
chk "中文问 → 中文答(界面是日文也不跟着跑偏)" '[一-鿿]' 1
chk "  没有整段日文" 'ます。|です。' 0

echo "\n══ ③ 能力兑现: 对产物, 不对它说的话 ══"
ask "動く図を描いて。歯車が回るやつ。実際に描いて。"
chk "真的输出了 <svg" '<svg' 1
# 两套动画都算数, 出厂知识原话就是"SVG 自带两套动画都放行": <animate>/<animateTransform>,
# 或者 SVG 内嵌 <style> 里的 @keyframes —— 后者消毒器会摘出来消毒再插回去(md.js:211/273), 真能动。
# 🔴 只认 <animate 是把断言写窄了(2026-08-30 自己踩过, 判了一次假红)。要按钮启停才必须用前者。
chk "用了真会动的写法(animate 标签 或 @keyframes)" '<animate|@keyframes' 1
chk "🔴 没说要用 JS/CSS animation(气泡里 JS 不执行)" 'JavaScript|CSS anim' 0

ask "アンケートを作って。名前・年齢・好きな色。実際に押せるフォームで。"
chk "用 DSL 写控件 {{in:/{{sel:" '\{\{(in|sel):' 1
chk "有提交按钮 {{btn:" '\{\{btn:' 1
chk "🔴 没写裸 HTML <input>(渲染得出来但值收不到)" '<input' 0
chk "🔴 没包进代码块(包了就显示成源码)" '```html' 0

# 🔴 名字必须每次不同。要"做个计数器"的话它会发现 counter.json 已经在了, 直接打开旧的 ——
# 于是条目数不涨, 断言判红, 而人格其实没做错任何事(2026-08-30 自己踩过)。
NEWPLG="probe$$"
before=$(ls "$PKG" 2>/dev/null | wc -l | tr -d ' ')
ask "「$NEWPLG」という名前のプラグインを新規に作って。簡単なカウンターでいい。実際にインストールして。"
after=$(ls "$PKG" 2>/dev/null | wc -l | tr -d ' ')
if [ "$after" -gt "$before" ]; then echo "  ✅ 插件真落盘($before → $after 个)"; PASS=$((PASS+1)); rm -f "$PKG/$NEWPLG.json"
else echo "  ❌ 插件没落盘(还是 $after 个) —— 它可能只是把 JSON 贴在回复里"; FAIL=$((FAIL+1)); fi

# 语音默认是关的。正确反应是"先带你打开", 错误反应是直接说"读了" —— 后者实测发生过,
# 而且日志里一次语音调用都没有。这条断言的是【没有谎报】, 不是【出了声】: 出没出声脚本听不见,
# 但"语音关着还说自己读了"是可判的。
ask "「今日は晴れです」を読み上げて。"
chk "🔴 没谎报「已读」(语音默认关, 正确反应是先带用户打开)" '読み上げました|読みました|朗读了|已读' 0

echo "\n══ ④ 记忆: 存得进, 换个说法也召得回 ══"
MARK="紫のカワウソ"
ask "覚えておいて: 私の実験用の合言葉は「$MARK」です。"
cp "$HOME/.butler-dev/personas/$PDIR/.claude/memory/memory.v2.db" /tmp/vdp.db 2>/dev/null
if sqlite3 /tmp/vdp.db "select count(*) from nodes where claim like '%$MARK%' or body like '%$MARK%'" 2>/dev/null | grep -qv '^0$'; then
  echo "  ✅ 真落库了(不是只回一句「记住了」)"; PASS=$((PASS+1))
else echo "  ❌ 没落库 —— 它说记住了但库里查不到"; FAIL=$((FAIL+1)); fi
rm -f /tmp/vdp.db
# 换个说法问: 原句是日语「合言葉」, 这里用中文问, 顺带验跨语言召回
ask "我之前让你记的那个实验暗号是什么？"
chk "换语言换说法也召得回" "$MARK" 1

echo "\n$([ $FAIL -eq 0 ] && echo ✅ || echo ❌) verify-dev-persona[$PERSONA]: $PASS 过 / $FAIL 失败"
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
