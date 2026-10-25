#!/usr/bin/env bash
# 单个扩展对"回合数 / 先后手"的影响：批量跑 古典 + 中世，各 120 局。
#
# 每组都带着「血战」（它现在是默认开启的），只多勾一个扩展，
# 这样得到的差就是"这个扩展本身的贡献"，而不是"血战 + 它"的合并效应。
# 血战单独一组的结果在 results17/dlc-on-era{1,2}.json，直接当基线。
#
# 用法：bash scripts/exp-sweep.sh [输出目录]
set -u
cd "$(dirname "$0")/.." || exit 1
OUT="${1:-results18}"
mkdir -p "$OUT"

EXPS="war-economy veterans trench blitz conscription night-raid scorched-earth fortress"
export OUT

run_one() {
  local id="$1"
  local e
  for e in 1 2; do
    npm run balance -- --era "$e" --games 120 --seed 900 \
      --expansions "bloodbath,$id" --out "$OUT/exp-$id-era$e.json" \
      > "$OUT/log-$id-era$e.txt" 2>&1
    echo "done $id era$e"
  done
}
export -f run_one

printf '%s\n' $EXPS | xargs -P 8 -I{} bash -c 'run_one "$@"' _ {}
echo "全部完成 -> $OUT"
