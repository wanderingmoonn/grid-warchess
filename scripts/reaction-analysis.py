#!/usr/bin/env python3
"""反应射击评测：把合并后的跑批 JSON 打成报告用的表格。

只读 `results/reaction/*.json`，不碰引擎。输出是 Markdown 片段，贴进报告即可。

用法：
    python3 scripts/reaction-analysis.py results/reaction
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path


def load(path: Path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def se(p: float, n: int) -> float:
    return math.sqrt(max(p * (1 - p), 0) / n) if n else 0.0


def pct(x: float) -> str:
    return f"{x * 100:.0f}%"


def turns_stats(doc) -> tuple[float, float, float, float]:
    """平均、标准差、p50、p90（只算分出胜负/打到上限都算，和报表口径一致）"""
    turns = sorted(g["turns"] for g in doc["results"])
    n = len(turns)
    if n == 0:
        return 0, 0, 0, 0
    mean = sum(turns) / n
    var = sum((t - mean) ** 2 for t in turns) / max(1, n - 1)
    p50 = turns[n // 2]
    p90 = turns[min(n - 1, int(n * 0.9))]
    return mean, math.sqrt(var), p50, p90


def row_of(doc, type_id: str):
    return next((s for s in doc["stats"] if s["type"] == type_id), None)


def econ_totals(doc):
    """经济单位（category=economy）的阵亡数与身价"""
    lost = 0
    value = 0
    n = 0
    for s in doc["stats"]:
        if s["category"] == "economy":
            lost += s.get("lost", 0)
            value += s.get("lostValue", 0)
            n += 1
    games = max(1, doc["games"])
    return lost / games, value / games, n


def flips_per_game(doc) -> float:
    games = max(1, doc["games"])
    return sum(g.get("flipCount", 0) for g in doc["results"]) / games


def table_pacing(base, after) -> str:
    lines = ["| 指标 | 改前 | 改后 |", "|---|---|---|"]
    for label, key in (("局数", "games"),):
        pass
    bm, bsd, bp50, bp90 = turns_stats(base)
    am, asd, ap50, ap90 = turns_stats(after)
    nb, na = len(base["results"]), len(after["results"])
    lines.append(f"| 局数 | {nb} | {na} |")
    lines.append(f"| 平均回合 | {bm:.1f} ± {bsd / math.sqrt(nb):.1f} | {am:.1f} ± {asd / math.sqrt(na):.1f} |")
    lines.append(f"| 中位回合 (p50) | {bp50} | {ap50} |")
    lines.append(f"| 长局 p90 | {bp90} | {ap90} |")
    lines.append(
        f"| 和局率 | {pct(base['summary']['drawRate'])} | {pct(after['summary']['drawRate'])} |"
    )
    lines.append(
        f"| 先手胜率 | {pct(base['summary']['aRate'])} ± {pct(se(base['summary']['aRate'], nb))} "
        f"| {pct(after['summary']['aRate'])} ± {pct(se(after['summary']['aRate'], na))} |"
    )
    lines.append(
        f"| 每局招兵 | {base['summary']['recruitsPerGame']:.1f} | {after['summary']['recruitsPerGame']:.1f} |"
    )
    return "\n".join(lines)


def table_econ(base, after) -> str:
    bl, bv, _ = econ_totals(base)
    al, av, _ = econ_totals(after)
    bf, af = flips_per_game(base), flips_per_game(after)
    lines = [
        "| 指标 | 改前 | 改后 |",
        "|---|---|---|",
        f"| 经济单位每局阵亡 | {bl:.2f} 个 | {al:.2f} 个 |",
        f"| 经济单位每局阵亡身价 | {bv:.0f} 金 | {av:.0f} 金 |",
        f"| 城市易主次数/局 | {bf:.2f} | {af:.2f} |",
    ]
    return "\n".join(lines)


def table_buildings(base, after, type_ids) -> str:
    lines = [
        "| 兵种 | 指标 | 改前 | 改后 |",
        "|---|---|---|---|",
    ]
    for t in type_ids:
        b, a = row_of(base, t), row_of(after, t)
        if not b or not a:
            continue
        name = b["name"]
        honest = a.get("honesty")
        _ = honest
        r_b = "∞" if b["ratio"] is None else f"{b['ratio']:.2f}"
        r_a = "∞" if a["ratio"] is None else f"{a['ratio']:.2f}"
        lines.append(f"| {name} | 建造数（{base['games']}局） | {b['built']} | {a['built']} |")
        lines.append(f"| | 采用率 | {pct(b.get('adoptRate', 0))} | {pct(a.get('adoptRate', 0))} |")
        ft_b = f"{b['firstTurnAvg']:.0f}" if b.get("firstTurnAvg") else "—"
        ft_a = f"{a['firstTurnAvg']:.0f}" if a.get("firstTurnAvg") else "—"
        lines.append(f"| | 首建回合 | {ft_b} | {ft_a} |")
        lines.append(f"| | 每百金杀伤 | {b['per100']:.1f} | {a['per100']:.1f} |")
        lines.append(f"| | 每百金承伤 | {b['per100Taken']:.1f} | {a['per100Taken']:.1f} |")
        lines.append(f"| | 交换比 | {r_b} | {r_a} |")
        lines.append(f"| | 每局阵亡 | {b.get('lostPerGame', 0):.2f} | {a.get('lostPerGame', 0):.2f} |")
    return "\n".join(lines)


def table_units(base, after, type_ids) -> str:
    lines = ["| 兵种 | 每百金杀伤 改前 → 改后 | 交换比 改前 → 改后 |", "|---|---|---|"]
    for t in type_ids:
        b, a = row_of(base, t), row_of(after, t)
        if not b or not a:
            continue
        r_b = "∞" if b["ratio"] is None else f"{b['ratio']:.2f}"
        r_a = "∞" if a["ratio"] is None else f"{a['ratio']:.2f}"
        lines.append(f"| {b['name']} | {b['per100']:.1f} → {a['per100']:.1f} | {r_b} → {r_a} |")
    return "\n".join(lines)


def main() -> None:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "results/reaction")
    for era in (1, 2):
        bp, ap = root / f"base-era{era}.json", root / f"after-era{era}.json"
        if not bp.exists() or not ap.exists():
            continue
        base, after = load(bp), load(ap)
        print(f"\n## 时代 {era}\n")
        print("### 对局节奏\n")
        print(table_pacing(base, after))
        print("\n### 经济区损失\n")
        print(table_econ(base, after))
        print("\n### 防御建筑\n")
        print(table_buildings(base, after, ["tower", "keep", "battery", "camp"]))
        print("\n### 其它兵种（顺带看有没有被误伤）\n")
        print(table_units(base, after, ["militia", "archer", "spearman", "longbow"]))


if __name__ == "__main__":
    main()
