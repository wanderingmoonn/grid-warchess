# -*- coding: utf-8 -*-
"""生成《行动点扩展数据表》。

数值照抄 src/core/action-points.ts（2026-10-30 版），名单与单价由脚本按同一份规则算出来，
不手抄——改一个常量，整份表跟着重算。
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
XL_OK_BG = xl_color("#C6EFCE")
XL_OK_FG = xl_color("#006100")

WHITE = xl_color("#FFFFFF")
THIN = Side(style="thin", color=XL_LINE)
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
CENTER = Alignment(horizontal="center", vertical="center")
LEFT_WRAP = Alignment(horizontal="left", vertical="top", wrap_text=True)

TITLE = "行动点扩展 · 数据表"

# ── 配置（照 action-points.ts）────────────────────────────────────────────
AP_MAX = 100
AP_COST = {"move": 20, "attack": 40, "hold": 20, "skill": 60}
AP_NAME = {"move": "移动", "attack": "攻击", "hold": "驻扎", "skill": "技能"}
AP_MIN = 5
HOLD_ARMOR = 2

# 类别修正：骑兵/车 机动 −5，近战 出手 −10；驻扎跟随机动那一档
CLASS_MOD = {
    "mounted": {"move": -5},
    "vehicle": {"move": -5},
    "melee": {"attack": -10},
}
CLASS_LABEL = {
    "none": "标准（无修正）",
    "mounted": "骑兵",
    "vehicle": "车类",
    "melee": "近战",
    "mounted+melee": "骑兵 + 近战",
    "vehicle+melee": "车类 + 近战",
}


def cost_of(classes: str, action: str) -> int:
    """某个类别组合做某个动作要多少 E。顺序：先减修正，再保底 5。"""
    mod_key = "move" if action == "hold" else action
    e = AP_COST[action]
    if classes != "none":
        for cls in classes.split("+"):
            e += CLASS_MOD[cls].get(mod_key, 0)
    return max(AP_MIN, e)


def attacks_allowed(classes: str, moved: bool, skilled: bool) -> int:
    """这一回合池子买得起几次出手（还要再和兵种自己的 burst 取小）。"""
    budget = AP_MAX
    if moved:
        budget -= cost_of(classes, "move")
    if skilled:
        budget -= cost_of(classes, "skill")
    return max(0, budget // cost_of(classes, "attack"))


GROUPS = ["none", "mounted", "vehicle", "melee", "mounted+melee", "vehicle+melee"]

MOUNTED = [
    ("scout", "斥候", "古典", "本体", 2),
    ("knight", "骑士", "中世", "本体", 1),
    ("hussar", "骠骑兵", "火药", "本体", 1),
    ("med_horsearcher", "骑射手", "中世", "中世兵备", 2),
    ("gp_cuirassier", "胸甲骑兵", "火药", "火药列国", 1),
    ("gp_dragoon", "龙骑兵", "火药", "火药列国", 2),
    ("royal-cavalry", "皇家骑兵", "中世", "奇想·骑士团", 1),
    ("cataphract", "超级重骑", "火药", "奇想·骑士团", 1),
    ("paladin", "圣骑士", "火药", "奇想·骑士团", 1),
    ("wolf-rider", "狼骑士", "中世", "奇想·荒兽", 1),
    ("spider-rider", "蜘蛛骑士", "中世", "奇想·荒兽", 1),
    ("centaur", "半人马", "中世", "奇想·荒兽", 2),
    ("griffin-rider", "狮鹫骑士", "火药", "奇想·荒兽", 1),
    ("dragoon-rider", "龙骑兵（奇想）", "火药", "奇想·荒兽", 2),
    ("cursed-knight", "诅咒骑士", "火药", "奇想·秘法", 1),
]

VEHICLE = [
    ("mortar", "臼炮", "火药", "本体", 3),
    ("artillery", "火炮", "二战", "本体", 4),
    ("armoredcar", "装甲车", "工业", "本体", 2),
    ("tank", "坦克", "二战", "本体", 2),
    ("anc_chariot", "战车", "古典", "古典会战", 1),
    ("anc_ballista", "弩炮", "古典", "古典会战", 3),
    ("med_trebuchet", "投石机", "中世", "中世兵备", 3),
    ("gp_siegecannon", "攻城加农炮", "火药", "火药列国", 3),
    ("gp_culverin", "长管炮", "火药", "火药列国", 3),
    ("ind_trenchmortar", "战壕迫击炮", "工业", "工业绞肉机", 2),
    ("ind_howitzer", "榴弹炮", "工业", "工业绞肉机", 3),
    ("ind_railwaygun", "列车炮", "工业", "工业绞肉机", 4),
    ("ind_landship", "马克 I 坦克", "工业", "工业绞肉机", 2),
    ("ind_armoredtrain", "装甲列车", "工业", "工业绞肉机", 3),
    ("mod_atgun", "反坦克炮", "二战", "二战合成兵", 2),
    ("mod_katyusha", "火箭炮", "二战", "二战合成兵", 3),
    ("mod_heavytank", "重型坦克", "二战", "二战合成兵", 2),
    ("mod_spg", "自行火炮", "二战", "二战合成兵", 3),
    ("mod_flak", "高射炮", "二战", "二战合成兵", 3),
    ("mod_heavy_mortar", "重型迫击炮", "二战", "二战合成兵", 3),
    ("mod_supply", "补给车队", "二战", "二战合成兵", 0),
    ("ct_tank", "坦克（现代）", "现代", "现代", 2),
    ("ct_howitzer", "榴弹炮（现代）", "现代", "现代", 3),
    ("ct_recon", "装甲侦察车", "现代", "现代", 2),
    ("cnt_mbt", "主战坦克", "现代", "现代战争", 2),
    ("cnt_sph", "自行榴弹炮", "现代", "现代战争", 3),
    ("cnt_mlrs", "远程火箭炮", "现代", "现代战争", 3),
]

MELEE_RULE = [
    ("判定式", "category = combat　且　range ≤ 1　且　domain ≠ water"),
    ("为什么这么定", "两百多个兵种手写一遍不现实；而且「射程 1 就是贴上去打」本来就是它的定义——不需要再单独标一次。"),
    ("命中规模", "当前共 66 个兵种符合（战斗单位合计 186 个）。"),
    ("示例", "民兵、长枪兵、剑士、斥候、骑士、狼骑士、骷髅兵、忍者……"),
    ("会叠加", "骑士既是骑兵（机动 −5）也是近战（出手 −10），两类叠加——这正是规则想要的效果。"),
    ("不会命中", "水军（domain = water）、建筑、射程 ≥ 2 的远程兵、射程 0 的非战斗单位。"),
]

LEDGER = [
    ("E 是什么", "一个单位一个回合的行动点池（简称 E），上限 100。移动 / 攻击 / 驻扎 / 上下船 / 释放技能都从它里面扣。"),
    ("为什么上限是 100", "移动 20 + 出手 40 + 技能 60 = 120，大于 100：这三件事同一回合做不全。这就是这套规则真正的牙齿。"),
    ("E 是算出来的，不是扣出来的", "引擎没有「行动发生的那一刻」这种钩子（modify* 是纯函数，预览和 AI 试算都会反复调用，写进去就等于预览也扣钱）。所以 E 从引擎已经记下的事实投影出来。"),
    ("四类事实怎么读", "移动/上下船：站位和开账时不一样；攻击：attacksLeft 比允许次数少了几次；技能：skillTurn 等于本回合；驻扎：以上都没有。"),
    ("拦得住：移动", "modifyMove 返回 0 是引擎写明的口径（这一回合动不了，封冻的海军同款），E 不够就走不了。"),
    ("拦得住：额外攻击", "modifyAttacks = min(引擎本来给几次, 池子买得起几次)，burst 高的单位照样被 E 压回来。"),
    ("拦不住：首击与技能", "doAttack 第一次攻击时把次数兜底成 max(1, …)、doHeroSkill 只看冷却与充能，两处都没有扩展的否决位。所以照常发生，但账要记：超支部分变成透支。"),
    ("透支只滚一个回合", "回合末把超支记成 over，下回合开账时变成 debt 先扣掉；不滚雪球——否则一次超支会让这支部队永远慢半拍，而玩家没有任何办法洗掉它。"),
    ("驻扎买到什么", "驻扎（这一回合什么都没干）记 20E（走机动那一档，所以骑兵/车打折），换 +2 护甲，只在防守时算，从自己回合一直挂到下次开账。"),
    ("建筑不参与", "城墙不会走、也不会驻扎，不记 E 也不挂 +2 护甲。"),
    ("未开账", "刚招出来、刚下船的单位还没开账，按满池显示；轮到自己那一刻才把站位钉下来。"),
    ("上下船为什么同价", "引擎里上下船表现为「单位换个位置重新进场」（LOAD 摘走、UNLOAD 在岸边放回），从外面看和走一步是同一件事；分成两个键只会造出一对永远相等的数字。"),
    ("为什么有保底 5", "apActionCost 最后一步是 max(5, …)：给以后可能出现「移动 −20」这类怪扩展留个活口，不让 E 变成负数。"),
    ("联机与撤销", "账本只把「开账那一刻站在哪」存在 Unit.custom 里，所以跟着存档、快照、撤销重算一起走，两端算出来一致。"),
]

NOTES = [
    ("这是什么", "《时代与回旋镖》扩展「行动点」（action-points）的完整数据表：E 池子的常量、按兵种类别算出的单价、一回合的行动预算、骑兵/车类名单、近战判定、以及账本与拦截的规则。"),
    ("数据来源", "src/core/action-points.ts 全文（常量、类别修正、名单、账本算法），兵种名与所属扩展取自 src/core/config.ts 与 src/core/expansions.ts。数值照抄代码。"),
    ("怎么开", "开局面板 → 扩展 → 勾「行动点」。勾上之后引擎的移动/攻击/护甲/回合开始结束几个钩子才挂上；关掉就完全回到原来的「一回合一动一打」。"),
    ("哪些是算出来的", "「单价汇总」「一回合能做什么」两张表都是按同一份规则算的：单价 = 基准价 + 类别修正（保底 5）；可出手次数 = ⌊(100 − 机动 − 技能) ÷ 出手价⌋，再和兵种自己的 burst 取小。改常量后重新出表即可。"),
    ("为什么写死数字", "这是一份「当前就是这些数」的数据表，不是给你改参数试算的模型：公式单元格在被 Excel 重算之前，用预览器或脚本打开是空白，反而更糟。"),
    ("这份表不包含", "技能的分档定价（引擎只记 skillTurn，不记技能 id，所以眼下只能统一价 60）、AI 对 E 的估值、以及界面面板的排版。"),
    ("生成时间", "2026-10-30，对应仓库提交 7270f00 之后的代码。"),
]

wb = Workbook()

# ══════════════════════════════════════════════════════════════════
# Sheet 1 消耗与单价
# ══════════════════════════════════════════════════════════════════
ws = wb.active
ws.title = "消耗与单价"
ws.sheet_properties.tabColor = XL_PRIMARY


def sheet_title(ws, text, span):
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=span)
    c = ws.cell(row=1, column=1, value=text)
    c.font = Font(size=13, bold=True, color=WHITE)
    c.fill = PatternFill("solid", fgColor=XL_PRIMARY_DARK)
    c.alignment = Alignment(horizontal="left", vertical="center")
    ws.row_dimensions[1].height = 26


sheet_title(ws, TITLE + "　｜　E 池子上限、四类行动基准价、以及按类别算出的最终单价", 6)

# ── 常量块（第 3 行起）
row = 3
ws.cell(row=row, column=1, value="一、常量").font = Font(bold=True, size=12)
row += 1
for i, name in enumerate(["项", "取值", "说明"], start=1):
    cell = ws.cell(row=row, column=i, value=name)
    cell.font = Font(bold=True, color=WHITE)
    cell.fill = PatternFill("solid", fgColor=XL_PRIMARY)
    cell.alignment = CENTER
    cell.border = BORDER
CONST_ROWS = [
    ("每回合行动点上限 E", AP_MAX, "一个单位一个回合的池子，不累积、不留到下一回合。"),
    ("移动 / 上下船", AP_COST["move"], "上下船并入这一档：引擎里它就是「换个位置重新进场」。"),
    ("攻击（每次）", AP_COST["attack"], "多段攻击（burst）的单位每段各算一次。"),
    ("驻扎", AP_COST["hold"], "这一回合就地不动、也不出手；换 +2 护甲。"),
    ("技能（每次）", AP_COST["skill"], "引擎只记「哪回合放的」不记技能 id，所以眼下统一价。"),
    ("单价保底", AP_MIN, "任何修正算完之后不低于 5E。"),
    ("驻扎换来的护甲", HOLD_ARMOR, "只在防守时结算，从自己回合一直挂到下次开账。"),
]
for label, val, note in CONST_ROWS:
    row += 1
    ws.cell(row=row, column=1, value=label).alignment = Alignment(horizontal="left", vertical="center")
    vc = ws.cell(row=row, column=2, value=val)
    vc.alignment = CENTER
    vc.font = Font(bold=True)
    vc.fill = PatternFill("solid", fgColor=XL_LIGHT)
    ws.cell(row=row, column=3, value=note).alignment = LEFT_WRAP
    for col in range(1, 4):
        ws.cell(row=row, column=col).border = BORDER
    ws.row_dimensions[row].height = 24

# ── 类别修正块
row += 2
ws.cell(row=row, column=1, value="二、类别修正（唯一出现数值的地方）").font = Font(bold=True, size=12)
row += 1
head2 = row
for i, name in enumerate(["类别", "作用在", "修正", "怎么判定", "备注"], start=1):
    cell = ws.cell(row=row, column=i, value=name)
    cell.font = Font(bold=True, color=WHITE)
    cell.fill = PatternFill("solid", fgColor=XL_PRIMARY)
    cell.alignment = CENTER
    cell.border = BORDER
CLASS_ROWS = [
    ("骑兵", "机动", -5, "写在 MOUNTED_IDS 名单里（15 个兵种）", "兵种表里没有「骑」这个字段，move/range/armor 也推不出来，所以只能列表。"),
    ("车类", "机动", -5, "写在 VEHICLE_IDS 名单里（27 个兵种）", "攻城器械、装甲车辆、火炮都算。"),
    ("近战", "出手", -10, "射程 ≤ 1 的战斗单位（陆战）", "不写名单，按定义推：贴上去打就是近战。"),
]
for cls, on, mod, how, note in CLASS_ROWS:
    row += 1
    ws.cell(row=row, column=1, value=cls).font = Font(bold=True)
    ws.cell(row=row, column=1).alignment = CENTER
    ws.cell(row=row, column=2, value=on).alignment = CENTER
    mc = ws.cell(row=row, column=3, value=mod)
    mc.alignment = CENTER
    mc.font = Font(bold=True)
    ws.cell(row=row, column=4, value=how).alignment = LEFT_WRAP
    ws.cell(row=row, column=5, value=note).alignment = LEFT_WRAP
    for col in range(1, 6):
        ws.cell(row=row, column=col).border = BORDER
    ws.row_dimensions[row].height = 34

# ── 单价汇总
row += 2
ws.cell(row=row, column=1, value="三、算出来的单价（E）").font = Font(bold=True, size=12)
row += 1
head3 = row
for i, name in enumerate(["类别组合", AP_NAME["move"], AP_NAME["attack"], AP_NAME["hold"], AP_NAME["skill"], "说明"], start=1):
    cell = ws.cell(row=row, column=i, value=name)
    cell.font = Font(bold=True, color=WHITE)
    cell.fill = PatternFill("solid", fgColor=XL_PRIMARY)
    cell.alignment = CENTER
    cell.border = BORDER
first_price = row + 1
for g in GROUPS:
    row += 1
    ws.cell(row=row, column=1, value=CLASS_LABEL[g]).font = Font(bold=True)
    for j, act in enumerate(["move", "attack", "hold", "skill"]):
        cell = ws.cell(row=row, column=2 + j, value=cost_of(g, act))
        cell.alignment = CENTER
        cell.border = BORDER
    if g == "none":
        note = "基准价。"
    elif g == "mounted" or g == "vehicle":
        note = "机动与驻扎都便宜 5（驻扎走机动那一档）。"
    elif g == "melee":
        note = "出手便宜 10，机动不变。"
    else:
        note = "两类叠加：机动 −5、出手 −10。"
    ws.cell(row=row, column=6, value=note).alignment = LEFT_WRAP
    for col in range(1, 7):
        ws.cell(row=row, column=col).border = BORDER
    ws.row_dimensions[row].height = 24

row += 2
ws.cell(
    row=row,
    column=1,
    value="注：驻扎的价格跟着机动走。两者互斥、占同一份预算——如果驻扎比移动便宜，「先待着再走一步」会看到 E 先掉 20 再涨回来 5，账越算越多。",
).alignment = LEFT_WRAP
ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=6)
ws.row_dimensions[row].height = 32

ws.column_dimensions["A"].width = 24
ws.column_dimensions["B"].width = 10
ws.column_dimensions["C"].width = 10
ws.column_dimensions["D"].width = 34
ws.column_dimensions["E"].width = 46
ws.column_dimensions["F"].width = 40

# ══════════════════════════════════════════════════════════════════
# Sheet 2 一回合能做什么
# ══════════════════════════════════════════════════════════════════
bd = wb.create_sheet("一回合能做什么")
bd.sheet_properties.tabColor = XL_PRIMARY
sheet_title(bd, "E = 100 能买到什么：按类别算的可出手次数与结余", 8)

row = 3
bd.cell(row=row, column=1, value="一、这一回合最多能出手几次").font = Font(bold=True, size=12)
row += 1
head = ["类别组合", "机动价", "出手价", "技能价", "不动时\n可出手", "移动后\n余量", "移动后\n可出手", "技能后\n余量", "技能后\n可出手", "移动+技能\n余量", "移动+技能\n可出手"]
for i, name in enumerate(head, start=1):
    cell = bd.cell(row=row, column=i, value=name)
    cell.font = Font(bold=True, color=WHITE)
    cell.fill = PatternFill("solid", fgColor=XL_PRIMARY)
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    cell.border = BORDER
bd.row_dimensions[row].height = 40

for g in GROUPS:
    row += 1
    m, a = cost_of(g, "move"), cost_of(g, "attack")
    bd.cell(row=row, column=1, value=CLASS_LABEL[g]).font = Font(bold=True)
    bd.cell(row=row, column=2, value=m).alignment = CENTER
    bd.cell(row=row, column=3, value=a).alignment = CENTER
    bd.cell(row=row, column=4, value=cost_of(g, "skill")).alignment = CENTER
    # 逐列写：次数列写次数，余量列写余量
    def budget(moved, skilled):
        b = AP_MAX - (m if moved else 0) - (cost_of(g, "skill") if skilled else 0)
        return max(0, b)

    bd.cell(row=row, column=5, value=attacks_allowed(g, False, False)).alignment = CENTER
    bd.cell(row=row, column=6, value=budget(True, False)).alignment = CENTER
    bd.cell(row=row, column=7, value=attacks_allowed(g, True, False)).alignment = CENTER
    bd.cell(row=row, column=8, value=budget(False, True)).alignment = CENTER
    bd.cell(row=row, column=9, value=attacks_allowed(g, False, True)).alignment = CENTER
    bd.cell(row=row, column=10, value=budget(True, True)).alignment = CENTER
    bd.cell(row=row, column=11, value=attacks_allowed(g, True, True)).alignment = CENTER
    for col in range(1, 12):
        bd.cell(row=row, column=col).border = BORDER

row += 2
bd.cell(
    row=row,
    column=1,
    value="读法：余量 = 100 − 机动（如果动了）− 技能（如果放了）；可出手 = ⌊余量 ÷ 出手价⌋。"
    "实际次数还要再和兵种自己的 burst（每回合攻击次数）取小——机枪队一回合 3 次，池子买得起，它就真能打 3 次；"
    "`burst` 是 1 的单位，池子再满也只能打 1 次。",
).alignment = LEFT_WRAP
bd.merge_cells(start_row=row, start_column=1, end_row=row, end_column=11)
bd.row_dimensions[row].height = 44

# ── 常见组合
row += 2
bd.cell(row=row, column=1, value="二、常见组合（标准价 20 / 40 / 20 / 60）").font = Font(bold=True, size=12)
row += 1
for i, name in enumerate(["组合", "明细", "合计消耗", "结余 / 透支", "结果"], start=1):
    cell = bd.cell(row=row, column=i, value=name)
    cell.font = Font(bold=True, color=WHITE)
    cell.fill = PatternFill("solid", fgColor=XL_PRIMARY)
    cell.alignment = CENTER
    cell.border = BORDER

COMBOS = [
    ("只驻扎", "驻扎 20", 20, "可行，还留 80（但这一回合就什么都不能干了——驻扎与移动互斥）"),
    ("只移动", "移动 20", 20, "可行，还留 80"),
    ("移动 + 1 次攻击", "移动 20 + 攻击 40", 60, "可行，还留 40（不够再打一下，要么留着）"),
    ("移动 + 2 次攻击", "移动 20 + 攻击 40×2", 100, "刚好用完——这是「走上去打两下」的上限"),
    ("移动 + 3 次攻击", "移动 20 + 攻击 40×3", 140, "做不到：引擎只给 ⌊80÷40⌋ = 2 次，第 3 下根本发不出来"),
    ("技能 + 1 次攻击", "技能 60 + 攻击 40", 100, "刚好用完"),
    ("技能 + 移动", "技能 60 + 移动 20", 80, "可行，但余量 20 < 出手价 40：这一回合打不了了"),
    ("技能 + 移动 + 攻击", "技能 60 + 移动 20 + 攻击 40", 120, "做不全——差 20。这正是上限定在 100 的原因"),
    ("不动 + 2 次攻击", "攻击 40×2", 80, "可行，还留 20"),
    ("近战：移动 + 3 次攻击", "移动 20 + 攻击 30×3", 110, "近战便宜 10，但 3 次仍要 110 > 100：最多 2 次 + 余 20"),
]

for combo, detail, total, result in COMBOS:
    row += 1
    bd.cell(row=row, column=1, value=combo).font = Font(bold=True)
    bd.cell(row=row, column=2, value=detail)
    tc = bd.cell(row=row, column=3, value=total)
    tc.alignment = CENTER
    sc = bd.cell(row=row, column=4, value=AP_MAX - total)
    sc.alignment = CENTER
    bd.cell(row=row, column=5, value=result).alignment = LEFT_WRAP
    for col in range(1, 6):
        bd.cell(row=row, column=col).border = BORDER
    bd.row_dimensions[row].height = 30
    if total > AP_MAX:
        for col in range(1, 6):
            bd.cell(row=row, column=col).fill = PatternFill("solid", fgColor=XL_WARN_BG)
    elif total == AP_MAX:
        for col in range(1, 6):
            bd.cell(row=row, column=col).fill = PatternFill("solid", fgColor=XL_HOT_BG)

bd.column_dimensions["A"].width = 22
bd.column_dimensions["B"].width = 24
bd.column_dimensions["C"].width = 11
bd.column_dimensions["D"].width = 9
bd.column_dimensions["E"].width = 66
for col in range(6, 12):
    bd.column_dimensions[get_column_letter(col)].width = 10

# ══════════════════════════════════════════════════════════════════
# 名单（骑兵 / 车类）
# ══════════════════════════════════════════════════════════════════
def unit_sheet(name, rows, note):
    sh = wb.create_sheet(name)
    sh.sheet_properties.tabColor = XL_PRIMARY
    sheet_title(sh, f"{name}：机动 −5E（{len(rows)} 个兵种，写在 MOUNTED_IDS / VEHICLE_IDS 名单里）", 7)

    for i, h in enumerate(["序号", "兵种 ID", "名称", "时代", "所属扩展", "射程", "机动价（E）"], start=1):
        cell = sh.cell(row=2, column=i, value=h)
        cell.font = Font(bold=True, color=WHITE)
        cell.fill = PatternFill("solid", fgColor=XL_PRIMARY)
        cell.alignment = CENTER
        cell.border = BORDER
    sh.row_dimensions[2].height = 22

    for idx, (uid, uname, era, pack, rng) in enumerate(rows):
        r = 3 + idx
        sh.cell(row=r, column=1, value=idx + 1).alignment = CENTER
        sh.cell(row=r, column=2, value=uid).font = Font(name="Consolas", size=10)
        sh.cell(row=r, column=3, value=uname).font = Font(bold=True)
        sh.cell(row=r, column=4, value=era).alignment = CENTER
        sh.cell(row=r, column=5, value=pack)
        sh.cell(row=r, column=6, value=rng if rng else "—").alignment = CENTER
        # 机动价：骑兵/车 −5，近战不动机动；这里只算机动那一档
        sh.cell(row=r, column=7, value=cost_of("mounted", "move")).alignment = CENTER
        for col in range(1, 8):
            sh.cell(row=r, column=col).border = BORDER
            if idx % 2 == 1:
                sh.cell(row=r, column=col).fill = PatternFill("solid", fgColor=XL_NOTE)

    last = 2 + len(rows)
    nr = last + 2
    sh.cell(row=nr, column=1, value=note).alignment = LEFT_WRAP
    sh.merge_cells(start_row=nr, start_column=1, end_row=nr, end_column=7)
    sh.row_dimensions[nr].height = 40
    sh.freeze_panes = "C3"
    sh.auto_filter.ref = f"A2:G{last}"

    sh.column_dimensions["A"].width = 6
    sh.column_dimensions["B"].width = 18
    sh.column_dimensions["C"].width = 16
    sh.column_dimensions["D"].width = 8
    sh.column_dimensions["E"].width = 16
    sh.column_dimensions["F"].width = 8
    sh.column_dimensions["G"].width = 12


unit_sheet(
    "骑兵名单",
    MOUNTED,
    "漏写的后果是安全的：那个兵按标准价付 E（多花 5 点），不会凭空变强。"
    "test-rules 里有一条用例专门核对这张名单里的 id 都真实存在，改兵种 id 或写错字会当场变红。",
)
unit_sheet(
    "车类名单",
    VEHICLE,
    "攻城器械、装甲车辆、火炮、补给车队都算车类：机动 −5E。同样有 id 存在性用例盯着。",
)

# ══════════════════════════════════════════════════════════════════
# 近战规则
# ══════════════════════════════════════════════════════════════════
ml = wb.create_sheet("近战规则")
ml.sheet_properties.tabColor = XL_PRIMARY
sheet_title(ml, "近战：不写名单，按定义推（出手 −10E）", 3)

for i, h in enumerate(["项", "内容", "备注"], start=1):
    cell = ml.cell(row=2, column=i, value=h)
    cell.font = Font(bold=True, color=WHITE)
    cell.fill = PatternFill("solid", fgColor=XL_PRIMARY)
    cell.alignment = CENTER
    cell.border = BORDER

for i, (k, v) in enumerate(MELEE_RULE):
    r = 3 + i
    ml.cell(row=r, column=1, value=k).font = Font(bold=True)
    ml.cell(row=r, column=1).alignment = Alignment(horizontal="left", vertical="top")
    ml.cell(row=r, column=1).fill = PatternFill("solid", fgColor=XL_LIGHT)
    ml.cell(row=r, column=2, value=v).alignment = LEFT_WRAP
    ml.merge_cells(start_row=r, start_column=2, end_row=r, end_column=3)
    for col in range(1, 4):
        ml.cell(row=r, column=col).border = BORDER
    ml.row_dimensions[r].height = 40

ml.column_dimensions["A"].width = 16
ml.column_dimensions["B"].width = 60
ml.column_dimensions["C"].width = 40

# ══════════════════════════════════════════════════════════════════
# 账本与拦截
# ══════════════════════════════════════════════════════════════════
lg = wb.create_sheet("账本与拦截")
lg.sheet_properties.tabColor = XL_PRIMARY
sheet_title(lg, "账本：E 从哪来、拦得住什么、拦不住的部分怎么记", 2)

for i, h in enumerate(["条目", "说明"], start=1):
    cell = lg.cell(row=2, column=i, value=h)
    cell.font = Font(bold=True, color=WHITE)
    cell.fill = PatternFill("solid", fgColor=XL_PRIMARY)
    cell.alignment = CENTER
    cell.border = BORDER

for i, (k, v) in enumerate(LEDGER):
    r = 3 + i
    lg.cell(row=r, column=1, value=k).font = Font(bold=True)
    lg.cell(row=r, column=1).alignment = Alignment(horizontal="left", vertical="top", wrap_text=True)
    lg.cell(row=r, column=1).fill = PatternFill("solid", fgColor=XL_LIGHT)
    lg.cell(row=r, column=2, value=v).alignment = LEFT_WRAP
    for col in range(1, 3):
        lg.cell(row=r, column=col).border = BORDER
    lg.row_dimensions[r].height = 46

lg.column_dimensions["A"].width = 24
lg.column_dimensions["B"].width = 96

# ══════════════════════════════════════════════════════════════════
# 说明
# ══════════════════════════════════════════════════════════════════
hp = wb.create_sheet("说明")
hp.sheet_properties.tabColor = XL_PRIMARY
sheet_title(hp, "这份表是什么", 2)

for i, (k, v) in enumerate(NOTES):
    r = 3 + i
    hp.cell(row=r, column=1, value=k).font = Font(bold=True)
    hp.cell(row=r, column=1).alignment = Alignment(horizontal="left", vertical="top")
    hp.cell(row=r, column=1).fill = PatternFill("solid", fgColor=XL_LIGHT)
    hp.cell(row=r, column=2, value=v).alignment = LEFT_WRAP
    for col in range(1, 3):
        hp.cell(row=r, column=col).border = BORDER
    hp.row_dimensions[r].height = 52

hp.column_dimensions["A"].width = 20
hp.column_dimensions["B"].width = 96

wb.properties.title = TITLE
wb.save("G:/wbspace/2026-10-23-21-22-52/warchess/行动点扩展数据表.xlsx")
print("saved")
