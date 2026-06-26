#!/usr/bin/env bash
# 从青绿「A文」源图生成工具栏图标（2 态 × 4 尺寸）写入 public/icon/。
# 母题：青绿底 + 白「A / 文 + aha 火花」满铺方图标（秒懂翻译 / aha translate）。
# 两态（见 lib/icon.ts）：off=灰度图标（未开启，"熄灭"）/ on=彩色图标（已开启翻译，"点亮"）。无「翻译中 / 出错」态。
# 为什么用灰⇄彩而非角标：青绿底上绿勾对比太弱、红/桃红角标像报错、深墨青角标又不够明显；
# 整体"灰→点亮"区分度最高、最干净（无角标噪点），也最贴合本插件的"隐形"哲学。
# 源图：design/icon-src/aha-source.png（青绿 #02ACB1，满铺正方、无 alpha）。
# 工作分辨率 512，再降采样到 128/48/32/16，保证小尺寸抗锯齿。
# 改图标/态后重跑：  bash design/build-icons.sh
set -euo pipefail

cd "$(dirname "$0")/.."
SRC="design/icon-src/aha-source.png"
OUT="public/icon"
W=512                      # 工作分辨率
SIZES=(16 32 48 128)
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1) 彩色主图（=on 态）：满铺正方源图直接降到 512（已是正方、无需 trim/fit）
magick "$SRC" -resize ${W}x${W} -background none -gravity center -extent ${W}x${W} \
  PNG32:"$TMP/on.png"

# 2) 灰度态（=off 态）：去饱和 + 略提亮，呈现"熄灭/未激活"质感
magick "$TMP/on.png" -colorspace Gray -modulate 105 PNG32:"$TMP/off.png"

# 3) 降采样到各尺寸：off=灰度命名为 16/32/48/128（默认/未开启）；on=彩色带前缀
emit() {  # $1=src512  $2=prefix(空=off 默认)
  local pfx="$2"
  for s in "${SIZES[@]}"; do
    magick "$1" -resize ${s}x${s} -background none -gravity center -extent ${s}x${s} \
      PNG32:"$OUT/${pfx}${s}.png"
  done
}
emit "$TMP/off.png" ""
emit "$TMP/on.png"  "on-"

# 4) 同步源态大图（design/icon-src），方便日后微调对照
cp "$TMP/off.png" design/icon-src/master.png
cp "$TMP/on.png"  design/icon-src/on.png

echo "icons written to $OUT:"
ls -1 "$OUT"
