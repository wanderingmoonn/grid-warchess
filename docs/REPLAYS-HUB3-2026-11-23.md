# 三件套回放（2026-11-23）

四份，都带 `--hub --city-site --garrison`（三件套全开），导出脚本和跑批用同一套开关。

> 回放不进版本库（`results/*` 被忽略）。复现：
>
> ```bash
> node --experimental-strip-types scripts/export-bench-replay.ts \
>   --queue Q1 --seed 31 --new-side B --hub --city-site --garrison \
>   --out results/replays/hub3/hub3-q1-31-B.json
> ```

**怎么看**：首页「复盘」→ 选文件。逐回合城视角：`npm run replay:city -- <文件> --every 15`。

---

## 1. `hub3-q1-31-B.json` — **三局负之一翻盘**（负 79 → 胜 66）

```
T 16  c3 e↑3 hp81 产3(planter,engineer,planter) · c4 e2 hp63 产4(farmer,militia,herder,lumberjack)
T 31  c3 e↑4 hp99 产10(planter×3,musketeer,halberdier,rifleman,mortar…) · c4 e2 hp63 产3
T 46  c3 e4  hp90 产9(rifleman×5,halberdier,foreman) · c4 e2 hp63 产0
T 61  c3 e4  hp94 产9(mg,rifleman×4,…) · c4 e↑3 hp81 产6(herder×2,musketeer,mortar)
终局 B（66）
```

**看这里**：从头到尾**只有 c3 一座在升级**（e3→e4），产兵也跟着压在它身上；
c4 一直停在 e2、只在 T61 才被升到 e3。基线同一局是升级在两座城之间交替、79 回合输。
注意 T16 时金 675（钱多但没乱花），T46 起兵量才起来（3 → 13 → 21）。

## 2. `hub3-q1-30-A.json` — 另一局负翻盘，而且最快（负 78 → 胜 43）

```
T 11  A: 兵11 | c1 e2 产12(crossbow×4,archer×2,spearman…longbow,miller) · c2 e2 产5
T 21  A: 兵20 | c1 e2 产9(spearman×2,longbow×2,militia,archer,crossbow) · c2 e2 产2
T 41  A: 兵28 | c1 e2 产2 · c3 e3 hp44 产5     ← 对面 c3 已经被打穿
终局 A（43）
```

**看这里**：这局我军**一次都没升级**（全程 e2），赢的是**纯速推**：
前十回合 c1 就出了 12 个便宜兵，T21 已有 20 兵，T41 兵 28 个、对面只剩 9 个。
所以它说明的不是"枢纽升级"起了作用，而是**三件套顺带改变了出兵节奏**——
同样的钱堆出更多人、更早压过去。这也是要留意的信号：小图上"更快更多"本身就能赢一局。

## 3. `hub3-q3-31-A.json` — 三局负里的第三局，没赢但拖长了（负 84 → 负 250）

```
T 51  c1 e↑3 hp81 产23(herder,farmer,…musketeer) · c2 e↑4 hp99 产15(…rifleman×5)
T101  c2 e↑5 hp120 产9(rifleman×6,engineer,squad)      ← c1 这时已经丢了
T151  c2 e5  hp120 产13(squad,tank,artillery…)
T201  c1 e3  hp25  · c2 e5 hp120 产14(tank,squad×4,artillery…)
终局 B（250）
```

**看这里**：前线 c1 当上了枢纽并升到 e3，但**兵始终只有 5~14 个**，
金常年在 200~400 —— 兵不是造不出来，是钱没变成兵（攒钱那条老毛病）。
T101 c1 丢掉，枢纽迁到 c2 并升到 e5，T201 又把 c1 抢回来（e3、25 血）。
这局输在"守不住 + 兵力上不去"，不是"选错城"。

## 4. `hub3-q4-30-A.json` — 大图僵持（胜 101 → 平 261）

```
T131  我方 11 兵 · 对方 16 兵（c3 e4 / c4 e5）
T261  我方 46 兵 · 对方 19 兵，两边各 2 座城、都满血；对方金 9656
```

**看这里**：我方产能其实很猛（c2 一个窗口造 64 个兵），兵也堆到 46 个，
但**两座敌城都是满血**——打不进去。对比"只开升级"那份回放
（`p13-q4-30-A-hub.json`）：那局对方只剩 1 座城、4 个兵，是"快赢了但慢"。
所以三件套在大图上不是变慢，是**打不动**，问题在收尾（P0-2 / P2-3），不在产兵。
