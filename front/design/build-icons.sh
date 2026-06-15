#!/usr/bin/env bash
# 从青绿「A文」源图生成工具栏图标（2 态 × 4 尺寸）写入 public/icon/。
# 母题：青绿底 + 白「A / 文 + aha 火花」满铺方图标（秒懂翻译 / aha translate）。
# 两态（见 lib/icon.ts）：off=主图 / on=右下角绿✓（已开启翻译）。无「翻译中 / 出错」态。
# 源图：design/icon-src/aha-source.png（青绿 #02ACB1，满铺正方、无 alpha）。
# 工作分辨率 512，再降采样到 128/48/32/16，保证小尺寸抗锯齿。
# 改图标/角标几何后重跑：  bash design/build-icons.sh
set -euo pipefail

cd "$(dirname "$0")/.."
SRC="design/icon-src/aha-source.png"
OUT="public/icon"
W=512                      # 工作分辨率
SIZES=(16 32 48 128)
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1) 主图：满铺正方源图直接降到 512（已是正方、无需 trim/fit）
magick "$SRC" -resize ${W}x${W} -background none -gravity center -extent ${W}x${W} \
  PNG32:"$TMP/master.png"

# 2) on 角标几何（512 画布）：~37% 方块，贴右下角，圆角 ~22%；绿底白勾 ✓
BS=188                     # 角标边长
M=4                        # 贴边留白
X0=$((W - M - BS)); Y0=$((W - M - BS)); X1=$((W - M)); Y1=$((W - M))
R=42                       # 圆角
CX=$(( (X0 + X1) / 2 )); CY=$(( (Y0 + Y1) / 2 ))
CHK="stroke-width 26 fill none path 'M $((CX-46)),$((CY+2)) L $((CX-14)),$((CY+36)) L $((CX+52)),$((CY-40))'"

magick -size ${W}x${W} xc:none \
  -fill "#1FB24A" -draw "roundrectangle $X0,$Y0 $X1,$Y1 $R,$R" \
  -fill white -stroke white \
  -draw "stroke-linecap round stroke-linejoin round $CHK" \
  PNG32:"$TMP/overlay.png"
magick "$TMP/master.png" "$TMP/overlay.png" -compose over -composite PNG32:"$TMP/on.png"

# 3) 降采样到各尺寸：off=master 命名为 16/32/48/128；on 带前缀
emit() {  # $1=src512  $2=prefix(空=主图)
  local pfx="$2"
  for s in "${SIZES[@]}"; do
    magick "$1" -resize ${s}x${s} -background none -gravity center -extent ${s}x${s} \
      PNG32:"$OUT/${pfx}${s}.png"
  done
}
emit "$TMP/master.png" ""
emit "$TMP/on.png"     "on-"

# 4) 同步源态大图（design/icon-src），方便日后微调对照
cp "$TMP/master.png" design/icon-src/master.png
cp "$TMP/on.png"     design/icon-src/on.png

echo "icons written to $OUT:"
ls -1 "$OUT"
