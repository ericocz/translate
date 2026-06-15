#!/usr/bin/env bash
# 从橙色双气泡源图生成工具栏全套图标（4 态 × 4 尺寸）写入 public/icon/。
# 母题：橙色双气泡「A / 文」翻译标，透明底，专为工具栏。状态角标烤进位图（见 lib/icon.ts）。
#   off=主图  on=右下角绿✓  translating=右下角琥珀…  error=右下角红✕
# 源图：design/icon-src/orange-source.png（橙 #FF4808，透明底，干净无光晕）。
# 几何：FIT（不变形，居中铺满方画布；宽满边、上下留极小内生空隙）。角标 ~37% 居右下角贴边。
# 工作分辨率 512，再降采样到 128/48/32/16，保证小尺寸抗锯齿。
# 改图标/角标几何后重跑：  bash design/build-icons.sh
set -euo pipefail

cd "$(dirname "$0")/.."
SRC="design/icon-src/orange-source.png"
OUT="public/icon"
W=512                      # 工作分辨率
SIZES=(16 32 48 128)
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1) 主图：去透明边 → 居中铺满方画布（FIT，不变形）→ 512
magick "$SRC" -trim +repage \
  -background none -gravity center -extent "%[fx:max(w,h)]x%[fx:max(w,h)]" \
  -resize ${W}x${W} -background none -gravity center -extent ${W}x${W} \
  PNG32:"$TMP/master.png"

# 2) 角标几何（512 画布）：~37% 方块，贴右下角，圆角 ~22%
BS=188                     # 角标边长
M=4                        # 贴边留白
X0=$((W - M - BS)); Y0=$((W - M - BS)); X1=$((W - M)); Y1=$((W - M))
R=42                       # 圆角
CX=$(( (X0 + X1) / 2 )); CY=$(( (Y0 + Y1) / 2 ))

# 角标白符号绘制（在透明 512 画布上画底色方块 + 白符号），再叠到主图。
make_badge() {  # $1=color  $2=symbol-mvg  $3=outfile
  magick -size ${W}x${W} xc:none \
    -fill "$1" -draw "roundrectangle $X0,$Y0 $X1,$Y1 $R,$R" \
    -fill white -stroke white \
    -draw "stroke-linecap round stroke-linejoin round $2" \
    PNG32:"$TMP/overlay.png"
  magick "$TMP/master.png" "$TMP/overlay.png" -compose over -composite PNG32:"$3"
}

# 符号坐标（围绕角标中心 CX,CY）
# ✓ 勾：三点折线，圆头粗线
CHK="stroke-width 26 fill none path 'M $((CX-46)),$((CY+2)) L $((CX-14)),$((CY+36)) L $((CX+52)),$((CY-40))'"
# … 三点：三个白圆
DOT="stroke none path 'M $((CX-42)),$CY m -15,0 a 15,15 0 1,0 30,0 a 15,15 0 1,0 -30,0 M $CX,$CY m -15,0 a 15,15 0 1,0 30,0 a 15,15 0 1,0 -30,0 M $((CX+42)),$CY m -15,0 a 15,15 0 1,0 30,0 a 15,15 0 1,0 -30,0'"
# ✕ 叉：两条对角粗线
CRS="stroke-width 24 path 'M $((CX-38)),$((CY-38)) L $((CX+38)),$((CY+38)) M $((CX-38)),$((CY+38)) L $((CX+38)),$((CY-38))'"

make_badge "#1FB24A" "$CHK" "$TMP/on.png"
make_badge "#F5A623" "$DOT" "$TMP/translating.png"
make_badge "#E23A2E" "$CRS" "$TMP/error.png"

# 3) 降采样到各尺寸：off=master 命名为 16/32/48/128；其余带前缀
emit() {  # $1=src512  $2=prefix(空=主图)
  local pfx="$2"
  for s in "${SIZES[@]}"; do
    magick "$1" -resize ${s}x${s} -background none -gravity center -extent ${s}x${s} \
      PNG32:"$OUT/${pfx}${s}.png"
  done
}
emit "$TMP/master.png"      ""
emit "$TMP/on.png"          "on-"
emit "$TMP/translating.png" "translating-"
emit "$TMP/error.png"       "error-"

# 4) 同步源态大图（design/icon-src），方便日后微调对照
cp "$TMP/master.png"      design/icon-src/master.png
cp "$TMP/on.png"          design/icon-src/on.png
cp "$TMP/translating.png" design/icon-src/translating.png
cp "$TMP/error.png"       design/icon-src/error.png

echo "icons written to $OUT:"
ls -1 "$OUT"
