#!/bin/zsh
# 官网(公开仓里的网页部分)同步到各台镜像服务器的 /srv/site, 由那台机器上的 web 服务直接发。
# 镜像清单放在本机 ~/.config/butler/site-mirrors(一行一个 ssh 别名), 不进仓库。
# 用法: scripts/deploy-site-mirrors.sh [公开仓本地目录, 默认 /tmp/aibutler-public]
# 只带网页目录, 不带源码; 公开仓先 pull 到最新再跑。
set -eu
SRC="${1:-/tmp/aibutler-public}"
LIST="$HOME/.config/butler/site-mirrors"
[[ -s "$LIST" ]] || { echo "缺镜像清单 $LIST"; exit 1; }
git -C "$SRC" pull -q origin main
for host in ${(f)"$(grep -v '^#' "$LIST")"}; do
  ssh "$host" "mkdir -p /srv/site"
  for d in site assets monologue dataai docs docs-versions; do
    [[ -d "$SRC/$d" ]] && rsync -az --delete "$SRC/$d/" "$host:/srv/site/$d/"
  done
  echo "$host: site synced from $(git -C "$SRC" log --oneline -1)"
done
