# -*- coding: utf-8 -*-
"""生成《地形高差扩展数据表》。

数据全部照抄 src/core/height-terrain.ts 与 src/core/config.ts 的实值（2026-10-30 版）。
步耗矩阵与"与平原高度差"是公式派生，改高度/步耗/常量会自动跟着变。
"""

try:
    import openpyxl
except ImportError:
    import subprocess, sys

    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "openpyxl>=3.1.0"])
    import openpyxl

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.formatting.rule import CellIsRule


def xl_color(css_hex: str) -> str:
    value = css_hex.removeprefix("#").upper()
    if len(value) != 6:
        raise ValueError(f"Expected #RRGGBB, got: {css_hex}")
    return "FF" + value


XL_PRIMARY = xl_color("#4472C4")
XL_PRIMARY_DARK = xl_color("#2F5597")
XL_LIGHT = xl_color("#D9E2F3")
XL_LINE = xl_color("#BFBFBF")
XL_NOTE = xl_color("#FAFAFA")
XL_WARN_BG = xl_color("#FFC7CE")
XL_WARN_FG = xl_color("#9C0006")
XL_HOT_BG = xl_color("#FFEB9C")
XL_HOT_FG = xl_color("#9C6500")

WHITE = xl_color("#FFFFFF")
TEXT = xl_color("#1A1A1A")
MUTED = xl_color("#6B6B6B")

THIN = Side(style="thin", color=XL_LINE)
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
CENTER = Alignment(horizontal="center", vertical="center")
LEFT_WRAP = Alignment(horizontal="left", vertical="top", wrap_text=True)

TITLE = "地形高差扩展 · 数据表"

# ── 数据（照 config.ts / height-terrain.ts）────────────────────────────────
# id, 名称, 高度(层), 基础步耗, 防御加成, 射程修正, 视野修正, 陆军可过, 水军可过, 来源, 脾气
TERRAINS = [
    ("plain", "平原", 2, 1, 0, 0, 0, True, False, "本体", "基准面。开阔地，没有加成也没有遮挡。"),
    ("forest", "森林", 2, 2, 2, -1, -1, True, False, "本体", "树冠挡视线：射程 −1、视野 −1；防御 +2，躲在树里划算。"),
    ("hill", "丘陵", 3, 2, 3, 1, 1, True, False, "本体", "制高点：射程 +1、视野 +1、防御 +3。从平原走上去要多花 1 点（爬坡）。"),
    ("city", "城市", 2, 1, 3, 0, 0, True, False, "本体", "站在城里护甲 +3。敌方城市进不去（废墟除外），攻城要走结算。"),
    ("water", "水域", 0, 99, 0, 0, 0, False, True, "本体", "陆军不可通行；水军基础水面，1 点/格。"),
    ("mountain", "高山", 5, 99, 0, 0, 0, False, False, "本体", "天险，谁都上不去。射程/视野修正为 0 只是因为站不上去。"),
    ("bridge", "桥", 2, 1, 0, 0, 0, True, True, "本体", "桥面双向通行：陆军和船都过得去，但桥自己占着那格，停不下来（只能穿）。"),
    ("plateau", "台地", 4, 2, 3, 1, 1, True, False, "地形高差", "视野 +1、射程 +1，防御 +3；从谷地爬上来要 4 点（2 + 2 层爬坡封顶）。"),
    ("valley", "谷地", 1, 1, 2, -1, -1, True, False, "地形高差", "被两坡夹着：视野 −1、射程 −1，但防御 +2。这是躲的地方，不是打的地方。"),
    ("marsh", "沼泽", 1, 2, 0, 0, -1, True, False, "地形高差", "芦苇比人高（视野 −1），没有掩体；**走出去**那一步额外 +1（进来便宜、出去难）。"),
    ("dune", "沙丘", 3, 2, 1, 1, 1, True, False, "地形高差", "沙脊看得远（视野 +1、射程 +1），但沙脊上目标明显，防御只有 +1。"),
    ("shallow", "浅流", 1, 2, -1, 0, 0, True, True, "地形高差", "唯一两边都能走的水：陆军涉水（2 点/格），水军能贴滩滑过；站水里没处躲，防御 −1。占地 2×2 的大舰会搁浅，进不来。"),
    ("deep", "深水", 0, 99, 0, 0, 0, False, True, "海战 / 现代海军", "离岸 2 格以上的外海，只有船进得去，1 点/格；没有遮挡也没有制高点。"),
    ("lava", "熔岩", 1, 3, 0, 0, 0, True, False, "地形高差", "能过但绕脚（3 点/格）；**回合末**还停在岩浆上会受 5 点真伤，逼你算清抄近路值不值。"),
    ("volcano", "火山", 6, 99, 0, 0, 0, False, False, "地形高差", "整张图最高的东西（6 层），纯粹是墙。"),
]

# 按高度排序：数据表与矩阵用同一个顺序，横竖对照起来才不费眼
TERRAINS.sort(key=lambda t: (t[2], t[3], t[1]))

CLIMB_COST = 1      # 每往上一层多花的移动力
CLIMB_CAP = 2       # 爬坡最多算几层
RANGE_BAND = 2      # 射程高差阈值
LAVA_BURN = 5       # 熔岩回合末真伤
MARSH_BOG = 1       # 沼泽陷足

CONSTANTS = [
    ("爬坡：每往上一层多花的移动力", 1, "只在高差为正时加价，下坡不加价也不减价。"),
    ("爬坡：最多算几层", 2, "封顶 2 层，否则台地会变成 4 点/格的天堑（现在已经是了）。"),
    ("射程：触发高差修正的层数阈值", 2, "差 2 层以上才 +1 / −1；差 1 层不动，否则地形会压过兵种本身的差异。"),
    ("熔岩：回合末真伤", 5, "停在熔岩上的每支部队，每回合末受 5 点真伤（战报按方汇总一条）。"),
    ("沼泽：陷足的额外步耗", 1, "从沼泽**走出去**的那一步 +1。"),
]

STYLES = [
    ("highland", "高原", "层层递进的高地：山心、台地、丘陵、平原一圈圈铺开，俯射优势明显"),
    ("canyon", "峡谷", "一条深沟横在中间，两岸越往外越高；沟底走得快但仰攻吃亏"),
    ("volcanic", "火山群", "锥体从山口往外依次是高山、台地、丘陵，山脚一圈溢流的熔岩；熔岩能过，但会烧人"),
    ("marsh", "沼泽", "低平积水，塘洼与烂地交错；走出去比走进来贵"),
    ("isles", "群岛", "整片海隔开两军，只有几串浅滩能徒涉，其余得靠船或桥"),
    ("river", "大川", "一条大河南北（或东西）贯到底，只有几处浅滩能过，其余要架桥"),
]

SOFTEN = [
    ("1", "只在勾了「地形高差」的对局里执行", "本体那五种地貌照旧；这个收尾只补山脚，不搬山、不换生成器。"),
    ("2", "从所有高山/火山出发做一次 4 邻 BFS", "记下「离山心几格」，最多算 2 圈。"),
    ("3", "第 1 圈抬成台地", "只抬平原/林地/丘陵，且原高度 < 4。"),
    ("4", "第 2 圈抬成丘陵", "同样只抬那三类「软地面」，且原高度 < 3。"),
    ("5", "这些地形一律不抬", "水、浅流、谷地、沼泽、熔岩、沙丘、城市——海边是悬崖、沟底是沟底，本来就该是断的。"),
    ("6", "隔水不传播", "BFS 不穿过水/浅流：隔着一条河的对岸不该被算成这座山的山脚。"),
    ("7", "城郊那一圈不动", "出生点要能站人，城门口也不该变成台地（keep 集合里的一律跳过）。"),
    ("8", "收尾后的形状", "平原(2) → 丘陵(3) → 台地(4) → 高山(5)，每步只差一层；山体从「一格柱子」变成「三圈 5~9 格」。"),
]

wb = Workbook()

# ══════════════════════════════════════════════════════════════════
# Sheet 1 地形总表
# ══════════════════════════════════════════════════════════════════
ws = wb.active
ws.title = "地形总表"
ws.sheet_properties.tabColor = XL_PRIMARY

HEAD = [
    "序号", "地形 ID", "名称", "来源", "高度（层）", "基础步耗", "防御加成",
    "射程修正", "视野修正", "陆军可过", "水军可过", "与平原高差", "从平原进入步耗", "脾气 / 特殊规则",
]
WIDTHS = [6, 12, 9, 16, 11, 10, 10, 10, 10, 10, 10, 13, 17, 58]

ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(HEAD))
c = ws.cell(row=1, column=1, value=TITLE + "　｜　地图扩展「地形高差」的全部地形数值")
c.font = Font(size=14, bold=True, color=WHITE)
c.fill = PatternFill("solid", fgColor=XL_PRIMARY_DARK)
c.alignment = Alignment(horizontal="left", vertical="center")
ws.row_dimensions[1].height = 30

HEAD_ROW = 2
FIRST = HEAD_ROW + 1
LAST = FIRST + len(TERRAINS) - 1

for i, name in enumerate(HEAD, start=1):
    cell = ws.cell(row=HEAD_ROW, column=i, value=name)
    cell.font = Font(bold=True, color=WHITE)
    cell.fill = PatternFill("solid", fgColor=XL_PRIMARY)
    cell.alignment = CENTER
    cell.border = BORDER
    ws.column_dimensions[get_column_letter(i)].width = WIDTHS[i - 1]
ws.row_dimensions[HEAD_ROW].height = 22

plain_row = FIRST + next(i for i, t in enumerate(TERRAINS) if t[0] == "plain")
PLAIN_H = next(t[2] for t in TERRAINS if t[0] == "plain")

for idx, t in enumerate(TERRAINS):
    r = FIRST + idx
    tid, name, h, cost, dfn, rmod, vmod, land, water, src, note = t
    ws.cell(row=r, column=1, value=idx + 1).alignment = CENTER
    ws.cell(row=r, column=2, value=tid).font = Font(name="Consolas", size=10)
    ws.cell(row=r, column=3, value=name).font = Font(bold=True)
    ws.cell(row=r, column=4, value=src)
    ws.cell(row=r, column=5, value=h)
    ws.cell(row=r, column=6, value=cost)
    ws.cell(row=r, column=7, value=dfn)
    ws.cell(row=r, column=8, value=rmod)
    ws.cell(row=r, column=9, value=vmod)
    ws.cell(row=r, column=10, value="是" if land else "否")
    ws.cell(row=r, column=11, value="是" if water else "否")
    # 与平原高差（算好的值，不写公式：见「说明」里"为什么不写成公式"）
    ws.cell(row=r, column=12, value=h - PLAIN_H)
    # 从平原进入的步耗：基础步耗 + 爬坡（封顶）；不可通行就写「不可通行」
    if cost >= 99:
        ws.cell(row=r, column=13, value="不可通行")
    else:
        ws.cell(row=r, column=13, value=cost + max(0, min(CLIMB_CAP, h - PLAIN_H)) * CLIMB_COST)
    ws.cell(row=r, column=14, value=note)

    for col in range(1, len(HEAD) + 1):
        cell = ws.cell(row=r, column=col)
        cell.border = BORDER
        if col in (2, 4, 14):
            cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=(col == 14))
        else:
            cell.alignment = CENTER
        if idx % 2 == 1:
            cell.fill = PatternFill("solid", fgColor=XL_NOTE)
    ws.row_dimensions[r].height = 30

ws.freeze_panes = f"C{FIRST}"
ws.auto_filter.ref = f"A{HEAD_ROW}:N{LAST}"

# 负数（浅流防御 −1、森林/谷地射程 −1）标红，一眼看出"这里是吃亏的地形"
red = Font(color=XL_WARN_FG, bold=True)
for col in ("H", "I"):
    ws.conditional_formatting.add(
        f"{col}{FIRST}:{col}{LAST}",
        CellIsRule(operator="lessThan", formula=["0"], font=red),
    )

# ══════════════════════════════════════════════════════════════════
# Sheet 2 步耗矩阵
# ══════════════════════════════════════════════════════════════════
mx = wb.create_sheet("步耗矩阵")
mx.sheet_properties.tabColor = XL_PRIMARY

n = len(TERRAINS)
mx.merge_cells(start_row=1, start_column=1, end_row=1, end_column=n + 1)
c = mx.cell(row=1, column=1, value="陆军单格步耗矩阵（行 = 从哪来，列 = 进入哪格）")
c.font = Font(size=13, bold=True, color=WHITE)
c.fill = PatternFill("solid", fgColor=XL_PRIMARY_DARK)
c.alignment = Alignment(horizontal="left", vertical="center")
mx.row_dimensions[1].height = 26

mx.cell(row=2, column=1, value="从 ↓ ／ 进入 →")
for j, t in enumerate(TERRAINS):
    mx.cell(row=2, column=2 + j, value=t[1])
for i, t in enumerate(TERRAINS):
    mx.cell(row=3 + i, column=1, value=t[1])

for cell in [mx.cell(row=2, column=c_) for c_ in range(1, n + 2)]:
    cell.font = Font(bold=True, color=WHITE)
    cell.fill = PatternFill("solid", fgColor=XL_PRIMARY)
    cell.alignment = CENTER
    cell.border = BORDER
for i in range(n):
    cell = mx.cell(row=3 + i, column=1)
    cell.font = Font(bold=True)
    cell.fill = PatternFill("solid", fgColor=XL_LIGHT)
    cell.alignment = CENTER
    cell.border = BORDER

mx.row_dimensions[2].height = 24
mx.column_dimensions["A"].width = 15
for j in range(n):
    mx.column_dimensions[get_column_letter(2 + j)].width = 9

# 每个格子：目标步耗 + 爬坡（封顶）+ 沼泽陷足（看来处）
def step_cost(frm, to):
    """一行代码就是规则本身：进入价 + 爬坡（封顶）+ 从沼泽拔脚的额外一步。"""
    if to[3] >= 99:
        return "—"
    dh = to[2] - frm[2]
    return to[3] + (max(0, min(CLIMB_CAP, dh)) * CLIMB_COST if dh > 0 else 0) + (
        MARSH_BOG if frm[0] == "marsh" else 0
    )


for i, frm in enumerate(TERRAINS):
    r = 3 + i
    for j, to in enumerate(TERRAINS):
        cell = mx.cell(row=r, column=2 + j, value=step_cost(frm, to))
        cell.alignment = CENTER
        cell.border = BORDER

mx.freeze_panes = "B3"

# "—" 灰掉；4 点以上的格子标黄（爬坡 + 熔岩/浅流这类高消耗）
mx.conditional_formatting.add(
    f"B3:{get_column_letter(n + 1)}{2 + n}",
    CellIsRule(
        operator="greaterThanOrEqual",
        formula=["4"],
        fill=PatternFill("solid", fgColor=XL_HOT_BG),
        font=Font(color=XL_HOT_FG, bold=True),
    ),
)

legend_row = 4 + n
mx.cell(row=legend_row, column=1, value="读法").font = Font(bold=True)
mx.cell(
    row=legend_row,
    column=2,
    value=(
        "「—」= 陆军不可通行（水域/深水/高山/火山）。数字 = 从左边那种地形走进上面那种地形的总步耗，"
        "已含爬坡（每层 +1，最多算 2 层）与沼泽陷足（从沼泽走出去 +1）。"
        "水军不走这张表：能过就是 1 点/格（浅流对 2×2 大舰例外，会搁浅）。"
    ),
).alignment = LEFT_WRAP
mx.merge_cells(start_row=legend_row, start_column=2, end_row=legend_row, end_column=n + 1)
mx.row_dimensions[legend_row].height = 46

# ══════════════════════════════════════════════════════════════════
# Sheet 3 高差规则
# ══════════════════════════════════════════════════════════════════
rt = wb.create_sheet("高差规则")
rt.sheet_properties.tabColor = XL_PRIMARY

rt.merge_cells("A1:C1")
c = rt["A1"]
c.value = "高差规则：常量与判定"
c.font = Font(size=13, bold=True, color=WHITE)
c.fill = PatternFill("solid", fgColor=XL_PRIMARY_DARK)
c.alignment = Alignment(horizontal="left", vertical="center")
rt.row_dimensions[1].height = 26

for i, name in enumerate(["常量", "取值", "说明"], start=1):
    cell = rt.cell(row=2, column=i, value=name)
    cell.font = Font(bold=True, color=WHITE)
    cell.fill = PatternFill("solid", fgColor=XL_PRIMARY)
    cell.alignment = CENTER
    cell.border = BORDER

# 锚点固定：B3 爬坡每层、B4 封顶层数、B5 高差阈值、B6 熔岩伤害、B7 沼泽陷足
for i, (label, val, note) in enumerate(CONSTANTS):
    r = 3 + i
    rt.cell(row=r, column=1, value=label).alignment = Alignment(horizontal="left", vertical="center")
    vcell = rt.cell(row=r, column=2, value=val)
    vcell.alignment = CENTER
    vcell.font = Font(bold=True)
    vcell.fill = PatternFill("solid", fgColor=XL_LIGHT)
    rt.cell(row=r, column=3, value=note).alignment = LEFT_WRAP
    for col in range(1, 4):
        rt.cell(row=r, column=col).border = BORDER
    rt.row_dimensions[r].height = 26

rt.column_dimensions["A"].width = 30
rt.column_dimensions["B"].width = 8
rt.column_dimensions["C"].width = 62

RULES = [
    ("射程（俯射/仰攻）", "只对基础射程 ≥ 2 的远程兵种生效。加成分叠加、减成分只看最差那一个：台地打谷地 = +2，谷地打台地 = −1（不是 −2，否则弓兵在谷地里直接废掉）。最终射程不低于 1。"),
    ("视野", "站什么地看多远：森林 −1、沼泽 −1、谷地 −1、丘陵 +1、台地 +1、沙丘 +1。只改「这个兵自己看多远」，不改整方的视野半径。"),
    ("步耗", "进入一格 = 基础步耗 + 爬坡（往上每层 +1，封顶 2 层）+ 陷足（从沼泽走出去 +1）。下坡不加价、也不减价。"),
    ("熔岩灼烧", "回合末结算，不是进入即伤：让 AI 的寻路不至于算不明白，也让「路过熔岩边缘」不至于莫名其妙地疼。"),
    ("关掉扩展", "没有新地形、没有高度、没有熔岩烫人；步耗与射程与本体逐格相同（所有规则都挂在扩展的钩子上）。"),
    ("与天气的分工", "地形改的是「这块地本身的脾气」，天气改的是「这个回合全场」。两者都作用在射程/视野上时按顺序叠加。"),
]

block = 10
rt.cell(row=block, column=1, value="判定顺序与边界").font = Font(bold=True, size=12)
for i, (name, text) in enumerate(RULES):
    r = block + 1 + i
    rt.cell(row=r, column=1, value=name).alignment = Alignment(horizontal="left", vertical="top")
    rt.cell(row=r, column=1).font = Font(bold=True)
    rt.merge_cells(start_row=r, start_column=2, end_row=r, end_column=3)
    cell = rt.cell(row=r, column=2, value=text)
    cell.alignment = LEFT_WRAP
    for col in range(1, 4):
        rt.cell(row=r, column=col).border = BORDER
    rt.row_dimensions[r].height = 46

# ══════════════════════════════════════════════════════════════════
# Sheet 4 地貌风格
# ══════════════════════════════════════════════════════════════════
st = wb.create_sheet("地貌风格")
st.sheet_properties.tabColor = XL_PRIMARY

st.merge_cells("A1:D1")
c = st["A1"]
c.value = "本扩展带来的 6 种等高线地貌（开局面板「地貌」一栏跟着扩展开关增减）"
c.font = Font(size=13, bold=True, color=WHITE)
c.fill = PatternFill("solid", fgColor=XL_PRIMARY_DARK)
c.alignment = Alignment(horizontal="left", vertical="center")
st.row_dimensions[1].height = 26

for i, name in enumerate(["序号", "风格 ID", "名称", "说明"], start=1):
    cell = st.cell(row=2, column=i, value=name)
    cell.font = Font(bold=True, color=WHITE)
    cell.fill = PatternFill("solid", fgColor=XL_PRIMARY)
    cell.alignment = CENTER
    cell.border = BORDER

for i, (sid, sname, note) in enumerate(STYLES):
    r = 3 + i
    st.cell(row=r, column=1, value=i + 1).alignment = CENTER
    st.cell(row=r, column=2, value=sid).font = Font(name="Consolas", size=10)
    st.cell(row=r, column=3, value=sname).font = Font(bold=True)
    st.cell(row=r, column=3).alignment = CENTER
    st.cell(row=r, column=4, value=note).alignment = LEFT_WRAP
    for col in range(1, 5):
        st.cell(row=r, column=col).border = BORDER
    st.row_dimensions[r].height = 34

st.column_dimensions["A"].width = 6
st.column_dimensions["B"].width = 12
st.column_dimensions["C"].width = 10
st.column_dimensions["D"].width = 76

# ══════════════════════════════════════════════════════════════════
# Sheet 5 生成与收尾
# ══════════════════════════════════════════════════════════════════
gp = wb.create_sheet("生成与收尾")
gp.sheet_properties.tabColor = XL_PRIMARY

gp.merge_cells("A1:C1")
c = gp["A1"]
c.value = "山脚补坡（softenPeaks）：把本体的「一格柱子山」抹成坡"
c.font = Font(size=13, bold=True, color=WHITE)
c.fill = PatternFill("solid", fgColor=XL_PRIMARY_DARK)
c.alignment = Alignment(horizontal="left", vertical="center")
gp.row_dimensions[1].height = 26

for i, name in enumerate(["步骤", "规则", "说明"], start=1):
    cell = gp.cell(row=2, column=i, value=name)
    cell.font = Font(bold=True, color=WHITE)
    cell.fill = PatternFill("solid", fgColor=XL_PRIMARY)
    cell.alignment = CENTER
    cell.border = BORDER

for i, (step, rule, note) in enumerate(SOFTEN):
    r = 3 + i
    gp.cell(row=r, column=1, value=step).alignment = CENTER
    gp.cell(row=r, column=2, value=rule).alignment = LEFT_WRAP
    gp.cell(row=r, column=2).font = Font(bold=True)
    gp.cell(row=r, column=3, value=note).alignment = LEFT_WRAP
    for col in range(1, 4):
        gp.cell(row=r, column=col).border = BORDER
    gp.row_dimensions[r].height = 40

gp.column_dimensions["A"].width = 6
gp.column_dimensions["B"].width = 30
gp.column_dimensions["C"].width = 74

# ══════════════════════════════════════════════════════════════════
# Sheet 6 说明
# ══════════════════════════════════════════════════════════════════
hp = wb.create_sheet("说明")
hp.sheet_properties.tabColor = XL_PRIMARY

hp.merge_cells("A1:B1")
c = hp["A1"]
c.value = "这份表是什么"
c.font = Font(size=13, bold=True, color=WHITE)
c.fill = PatternFill("solid", fgColor=XL_PRIMARY_DARK)
c.alignment = Alignment(horizontal="left", vertical="center")
hp.row_dimensions[1].height = 26

NOTES = [
    ("这是什么", "《时代与回旋镖》地图扩展「地形高差」（height-terrain）的完整数据表：15 种地形的数值、陆军步耗矩阵、高差规则的常量与判定顺序、6 种地貌风格、山脚补坡的生成规则。"),
    ("数据来源", "src/core/config.ts（地形名 / 防御 / 步耗）与 src/core/height-terrain.ts（高度 / 射程修正 / 视野修正 / 常量 / 地貌 / 收尾）。深水来自 src/core/naval-packs.ts。数值照抄代码，不是估算。"),
    ("排序口径", "地形总表与步耗矩阵都按「高度 → 基础步耗 → 名称」排，横竖对照时同一种地形落在同一条线上。"),
    ("数值怎么来的", "「与平原高差」「从平原进入步耗」和整张步耗矩阵都是按下面这条式子算出来的，不是手填：进入一格 = 目标地形的基础步耗 + 爬坡（高度差为正时每层 +1、最多算 2 层）+ 陷足（从沼泽走出去 +1）；基础步耗 99 的写「不可通行」。常量见「高差规则」表。"),
    ("为什么不写成公式", "这里是一份「当前就是这些数」的数据表，不是给你改参数试算的模型：公式单元格在没被 Excel 重算过之前，用预览器/脚本打开是空白，反而更糟。要试算就去改代码里的 TERRAIN_HEIGHT / CLIMB_COST，再重新出一份表。"),
    ("进游戏怎么看", "开局面板 → 扩展 → 勾「地形高差」。勾上之后三件事同时生效：地图里才会出现那 7 种新地形、「地貌」一栏多出高原/峡谷/火山群/沼泽/群岛/大川六颗 chip、步耗与射程的那套钩子才挂上。"),
    ("关掉会怎样", "没有新地形、没有高度、没有熔岩烫人，步耗与射程与本体逐格相同——所有规则都挂在这一个扩展的钩子上，本体一行都不认识「高度」。"),
    ("射程那条为什么这么算", "同一支弓箭手，站台地上和站谷地里射程本来就该不一样，那是地形的属性；写进兵种表就变成每个兵种都要为每类地形各写一份。所以高差修正放在射程钩子里，只对基础射程 ≥ 2 的兵种生效。"),
    ("这份表不包含", "地形对 AI 寻路的权重、天气/季节的修正、以及「海战」扩展的封锁与港口规则——那些不在「地形高差」里。"),
    ("生成时间", "2026-10-30，对应仓库提交 7270f00 之后的代码。"),
]

for i, (k, v) in enumerate(NOTES):
    r = 2 + i
    hp.cell(row=r, column=1, value=k).font = Font(bold=True)
    hp.cell(row=r, column=1).alignment = Alignment(horizontal="left", vertical="top")
    hp.cell(row=r, column=1).fill = PatternFill("solid", fgColor=XL_LIGHT)
    hp.cell(row=r, column=2, value=v).alignment = LEFT_WRAP
    for col in range(1, 3):
        hp.cell(row=r, column=col).border = BORDER
    hp.row_dimensions[r].height = 52

hp.column_dimensions["A"].width = 20
hp.column_dimensions["B"].width = 92

wb.properties.title = TITLE
wb.save("G:/wbspace/2026-10-23-21-22-52/warchess/地形高差扩展数据表.xlsx")
print("saved")
