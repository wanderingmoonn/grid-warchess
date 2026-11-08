from pathlib import Path
import json
import os
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "plot-runtime"))
os.environ["MPLCONFIGDIR"] = str(ROOT / "plot-cache")
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.font_manager import FontProperties

summary = json.loads((ROOT / "review-summary.json").read_text(encoding="utf-8"))
assets = ROOT / "assets"
assets.mkdir(exist_ok=True)
font_path = Path("C:/Windows/Fonts/msyh.ttc")
font = FontProperties(fname=str(font_path)) if font_path.exists() else FontProperties()
plt.rcParams.update({"font.size": 11, "axes.spines.top": False, "axes.spines.right": False, "axes.axisbelow": True, "svg.fonttype": "path"})

def label_fonts(ax):
    for text in [ax.title, ax.xaxis.label, ax.yaxis.label, *ax.get_xticklabels(), *ax.get_yticklabels()]:
        text.set_fontproperties(font)
    legend = ax.get_legend()
    if legend:
        for text in legend.get_texts():
            text.set_fontproperties(font)

pairs = summary["openingPairs"]
fig, ax = plt.subplots(figsize=(9, 4.5), layout="constrained")
x = list(range(len(pairs)))
left = ax.bar([i - .19 for i in x], [p["geAfterTwo"] for p in pairs], width=.36, label="两个戈兵后", color="#3576a8")
right = ax.bar([i + .19 for i in x], [p["mageAfterTwo"] for p in pairs], width=.36, label="两个法师后", color="#d18a36")
ax.axhline(540, color="#343434", linewidth=1.2, linestyle="--", label="四代升级：540金")
ax.bar_label(left, padding=3, fontsize=10)
ax.bar_label(right, padding=3, fontsize=10)
ax.set_xticks(x, [f'{p["seed"]} / {p["seat"]}' for p in pairs])
ax.set_ylim(0, 760)
ax.set_ylabel("剩余金币")
ax.set_title("首回合两次招募后的现金决定了能否立即升级")
ax.legend(loc="upper right", frameon=False, ncols=3, fontsize=10)
ax.grid(axis="y", alpha=.16)
label_fonts(ax)
fig.savefig(assets / "opening-budget.png", dpi=180)
fig.savefig(assets / "opening-budget.svg")
plt.close(fig)

holy = next(t for t in summary["totals"] if t["target"] == "holy-knight-lord")
by_type = holy["localBuffSavingsByRecipientType"]
values = [by_type.get("holy-knight-lord", 0), by_type.get("bridge", 0), sum(v for k, v in by_type.items() if k not in ("holy-knight-lord", "bridge"))]
assert sum(values) == holy["bannerHpSaved"]
fig, ax = plt.subplots(figsize=(9, 3.8), layout="constrained")
bars = ax.barh(["神圣骑士长自身", "桥梁", "其他战斗单位"], values, color="#3576a8", height=.55)
ax.bar_label(bars, padding=5)
ax.invert_yaxis()
ax.set_xlim(0, max(values) * 1.18)
ax.set_xlabel("固定实战动作下，移除圣旗后增加的即时HP损失")
ax.set_title("圣旗的局部保护差额主要落在自身和桥梁")
ax.grid(axis="x", alpha=.16)
label_fonts(ax)
fig.savefig(assets / "banner-protection.png", dpi=180)
fig.savefig(assets / "banner-protection.svg")
plt.close(fig)
print(json.dumps({"plots": 2, "openingPairs": len(pairs), "holyLocalProtection": sum(values), "matplotlib": matplotlib.__version__}))
