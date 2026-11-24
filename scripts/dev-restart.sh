#!/bin/zsh
# butler dev 重启 —— 唯一入口。别再手敲 kill + sleep + electron。
#
# 为什么要有这个脚本(四次踩坑的合集):
#   · 退出链要跑一轮模型做沉淀, SIGTERM 后实测 16~48 秒才真退, 而端口早就让了出来。
#     等端口 = 在旧实例还活着时起了第二个, 两个实例共用同一个 dataDir。
#   · 旧实例攥着 CDP 9222 时, 新实例 bind 失败但进程照常启动、不报错 ——
#     于是 CDP 静默连回旧实例, 你验的是刚被自己删掉的那份代码, 而且全绿。
#   · 装机版(/Applications/全能管家.app)和 dev 都是 electron, 只凭进程名杀会杀掉自己。
#
# 判据一律是「进程真的没了」, 不是 sleep N。

set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
CDP_PORT="${CDP_PORT:-9222}"
WAIT_MAX=120

# 非登录 shell(harness / cron)的 PATH 里没有 /usr/local/bin, 而 electron 的 bin 是带 node
# shebang 的脚本 —— 缺 node 时它只报一句 `env: node: No such file or directory` 就没了,
# 而前面几步照样全绿, 看着像起成功了。2026-08-27 实测踩到。
command -v node > /dev/null || export PATH="/usr/local/bin:/opt/homebrew/bin:${PATH}"
command -v node > /dev/null || { echo "✗ PATH 里找不到 node, electron 起不来。先解决 node。"; exit 1 }

# dev 的唯一识别特征是可执行文件路径在仓库的 node_modules 里 —— 装机版在 /Applications 下。
dev_pids() { pgrep -f "^${REPO}/node_modules/.bin/electron|^node ${REPO}/node_modules/.bin/electron|${REPO}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \." 2>/dev/null }

echo "① 查现有 dev 实例"
pids=(${(f)"$(dev_pids)"})
if [[ ${#pids} -eq 0 || -z "${pids[1]}" ]]; then
  echo "   没有在跑的 dev"
else
  ps -o pid=,lstart=,command= -p ${pids} | cut -c1-140
  echo "② 停 (SIGTERM, 让退出链跑完沉淀)"
  kill ${pids} 2>/dev/null

  echo "③ 等它真的没了 (最多 ${WAIT_MAX}s, 不用 sleep 猜)"
  waited=0
  while true; do
    alive=(${(f)"$(dev_pids)"})
    [[ ${#alive} -eq 0 || -z "${alive[1]}" ]] && break
    (( waited >= WAIT_MAX )) && { echo "   ✗ ${WAIT_MAX}s 还没退, 剩 ${alive}。自己看一眼再决定, 不自动 -9"; exit 1 }
    sleep 2; (( waited += 2 ))
    (( waited % 10 == 0 )) && echo "   ...${waited}s"
  done
  echo "   ✓ 进程已清空 (${waited}s)"
fi

echo "④ 确认端口没人占"
for p in ${CDP_PORT} 8788; do
  holder=$(lsof -ti tcp:${p} 2>/dev/null)
  [[ -n "${holder}" ]] && { echo "   ✗ ${p} 仍被 ${holder} 占着 —— 起了也是白起, 先查清楚"; exit 1 }
done
echo "   ✓ ${CDP_PORT} / 8788 都空着"

echo "⑤ 起新实例"
cd "${REPO}" || exit 1
# 开在内置屏, 别糊在作者的工作屏上 —— 验一次界面就起一次 dev, 而默认的"主显示器"正是他干活那块。
# 坐标在建窗口时就给出去(personal/dev-window-place.js), 所以连闪一下都没有; 事后拿 AppleScript
# 挪治不了本, 挪只能发生在窗口已经存在之后。要默认位置就 `BUTLER_DEV_SCREEN= ./scripts/dev-restart.sh`。
export BUTLER_DEV_SCREEN="${BUTLER_DEV_SCREEN-builtin}"
nohup ./node_modules/.bin/electron . --remote-debugging-port=${CDP_PORT} > /tmp/butler-dev.log 2>&1 &
echo "   pid=$! · 日志 /tmp/butler-dev.log · 屏幕=${BUTLER_DEV_SCREEN:-系统默认}"

echo "⑥ 验证 (只认: 单实例 + CDP 真的通)"
waited=0
while (( waited < 40 )); do
  sleep 2; (( waited += 2 ))
  curl -s -m 2 "http://127.0.0.1:${CDP_PORT}/json/version" > /dev/null 2>&1 && break
done
now=(${(f)"$(dev_pids)"})
main=$(pgrep -f "${REPO}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \." 2>/dev/null | wc -l | tr -d ' ')
if curl -s -m 2 "http://127.0.0.1:${CDP_PORT}/json/version" > /dev/null 2>&1; then
  echo "   ✓ CDP ${CDP_PORT} 通 · 主进程 ${main} 个 (要求 1)"
  # 必须写成 if 不能写 `[[ ]] && echo` —— 后者在"只有一个主进程"(即一切正常)时求值为假,
  # 作为分支最后一条语句会把整个脚本的退出码带成 1, 变成一条假红。
  if [[ "${main}" != "1" ]]; then
    echo "   ⚠️ 主进程不止一个, 说明没停干净, 别拿它验代码"
  fi
else
  echo "   ✗ CDP ${CDP_PORT} 不通 —— 大概率 bind 失败(旧实例残留)。别用它验代码。"
  exit 1
fi
