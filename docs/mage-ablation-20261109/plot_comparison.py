from pathlib import Path
import json
import os
import sys

ROOT = Path(__file__).resolve().parent
local_runtime = ROOT / 'plot-runtime'
if not local_runtime.exists():
    local_runtime = ROOT.parent / 'unit-mismatch-review-20261108/plot-runtime'
sys.path.insert(0, str(local_runtime))
os.environ['MPLCONFIGDIR'] = str(ROOT / 'plot-cache')
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.font_manager import FontProperties

data = json.loads((ROOT / 'comparison.json').read_text(encoding='utf-8'))
assets = ROOT / 'assets'
assets.mkdir(exist_ok=True)
font = FontProperties(fname='C:/Windows/Fonts/msyh.ttc') if Path('C:/Windows/Fonts/msyh.ttc').exists() else FontProperties()
plt.rcParams.update({'font.size': 11, 'axes.spines.top': False, 'axes.spines.right': False, 'axes.axisbelow': True, 'svg.fonttype': 'path'})

def fonts(ax):
    for text in [ax.title, ax.xaxis.label, ax.yaxis.label, *ax.get_xticklabels(), *ax.get_yticklabels()]:
        text.set_fontproperties(font)
    if ax.get_legend():
        for text in ax.get_legend().get_texts():
            text.set_fontproperties(font)

fig, ax = plt.subplots(figsize=(10.7, 4.6), layout='constrained')
rows = data['totals']
left = [0] * len(rows)
for key, label, color in [('win', '胜', '#317b69'), ('loss', '负', '#c26860'), ('capped', '到上限未决', '#a7a9b1')]:
    values = [r['outcomes'][key] for r in rows]
    ax.barh(range(len(rows)), values, left=left, color=color, height=.65, label=label)
    for i, v in enumerate(values):
        if v:
            ax.text(left[i] + v / 2, i, str(v), color='white', weight='bold', ha='center', va='center', fontsize=12)
    left = [a + b for a, b in zip(left, values)]
ax.set_yticks(range(len(rows)), [r['name'] for r in rows])
ax.invert_yaxis()
ax.set_xlim(0, 4)
ax.set_xticks(range(5))
ax.set_xlabel('局数（两张固定地图，各交换A/B座位）')
ax.set_title('三项单独调整均未增加法师组胜局')
ax.legend(frameon=False, ncols=3, loc='lower right', bbox_to_anchor=(1, 1.02))
ax.grid(axis='x', alpha=.15)
fonts(ax)
fig.savefig(assets / 'outcomes.png', dpi=180)
fig.savefig(assets / 'outcomes.svg')
plt.close(fig)

fig, ax = plt.subplots(figsize=(12, 5.1), layout='constrained')
ids = ['original', 'upgrade', 'batch', 'position', 'combined_reference']
colors = ['#7e8997', '#c58b3b', '#3c8970', '#397aa2', '#b5abbc']
case_rows = data['paired']
for i, (ident, color) in enumerate(zip(ids, colors)):
    values = [r[ident]['quotaDamage'] for r in case_rows]
    name = next(r['name'] for r in rows if r['id'] == ident)
    bars = ax.bar([x + (i - 2) * .16 for x in range(4)], values, width=.15, color=color, label=name)
    ax.bar_label(bars, padding=3, fontsize=9)
ax.set_xticks(range(4), [f"{r['seed']} / {r['seat']}" for r in case_rows])
ax.set_ylabel('首批4名法师的即时单位HP伤害（含反击）')
ax.set_xlabel('各组每局此批法师均花费600金；阵容、购买时间和对局时长不同')
ax.set_ylim(0, max(r[k]['quotaDamage'] for r in case_rows for k in ids) * 1.18)
ax.set_title('相同法师预算下，分批组的负转胜并未伴随法师输出增加')
ax.legend(frameon=False, ncols=3, loc='upper right')
ax.grid(axis='y', alpha=.15)
fonts(ax)
fig.savefig(assets / 'first-four-output.png', dpi=180)
fig.savefig(assets / 'first-four-output.svg')
plt.close(fig)
print(json.dumps({'plots': 2, 'groups': len(rows), 'pairedCases': len(case_rows), 'matplotlib': matplotlib.__version__}))
