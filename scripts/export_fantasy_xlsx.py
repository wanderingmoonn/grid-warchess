# -*- coding: utf-8 -*-
"""
把「奇想兵种包」的配置与实测数据导出成一份 Excel。

数据来源：
  results23/units.json          兵种配置快照（原版 + 奇想包）
  results23/fant-era{2,3,4,5}.json   开了包的实测（每时代一份）
  results23/base-era{2,3,4,5}.json   只开血战的实测（对照）

输出的表不是"把 json 摊平"，而是按看表的人要回答的三个问题分开：
  1. 这些兵是什么？（配置一张表）
  2. 它们在实战里划算吗？（每百金杀伤 vs 同代原版中位）
  3. 加了它们，对局有没有变形？（先后手胜率、回合数、未决率）
"""

import json
import os
import statistics

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, 'results26')
OUT = os.path.join(DIR, '奇想兵种包-兵种数据.xlsx')
ERAS = [2, 3, 4, 5]

HEAD_FILL = PatternFill('solid', fgColor='1F3A5F')
HEAD_FONT = Font(color='FFFFFF', bold=True, size=10)
TITLE_FONT = Font(bold=True, size=13, color='1F3A5F')
NOTE_FONT = Font(size=9, color='555555')
BAND_FILL = PatternFill('solid', fgColor='F2F5F9')
WEAK_FILL = PatternFill('solid', fgColor='FBE3E3')
STRONG_FILL = PatternFill('solid', fgColor='E3F2E3')
THIN = Side(style='thin', color='D5DCE5')
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
CENTER = Alignment(horizontal='center', vertical='center')
LEFT = Alignment(horizontal='left', vertical='center', wrap_text=True)


def load(name):
    p = os.path.join(DIR, name)
    if not os.path.exists(p):
        return None
    with open(p, encoding='utf-8') as f:
        return json.load(f)


units_doc = load('units.json')
UNITS = units_doc['units']
ABILITY_NAME = units_doc['abilities']
PACK = units_doc['packIds']

fant = {e: load('fant-era%d.json' % e) for e in ERAS}
base = {e: load('base-era%d.json' % e) for e in ERAS}

MECH_NOTE = {
    'warlock': '法术溅射：主目标周围的敌人也吃一半伤害',
    'banshee': '威吓：相邻敌军攻击 −2（最多叠两层）',
    'dragoon': '冲锋：本回合移动过则攻击 +5',
    'griffin': '飞行：可越过水面（停不到水上），森林丘陵按 1 步算',
    'treant': '再生 + 破城：每回合自回 10%，攻城 ×1.5',
    'vampire': '吸血：造成伤害的 40% 转化为自身生命',
    'behemoth': '再生：每回合自回 10% 生命上限',
    'dragon': '飞行 + 溅射：跨越水面，攻击波及周围敌人',
}


def median(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else 0.0


def per_unit(s):
    """每兵贡献 =（总输出 + 总承伤）÷ 招募数。不吃造价，贵兵便宜兵可以直接比。"""
    return (s['dealt'] + s['taken']) / s['built'] if s['built'] else 0.0


def peer_median(stat, cost, era):
    """同价位原版战斗单位的中位贡献（±35% 内，凑够两个才用；否则退到同时代的）"""
    base = [s for s in stat if s['type'] not in PACK and s['category'] == 'combat' and s['built'] >= 20]
    near = [s for s in base if abs(s['cost'] - cost) / cost <= 0.35]
    pool = near if len(near) >= 2 else [s for s in base if era - 1 <= s['era'] <= era + 1]
    return median([per_unit(s) for s in pool])


wb = Workbook()

# ── 表 1：兵种配置 ────────────────────────────────────────────────────────
ws = wb.active
ws.title = '兵种表'
ws['A1'] = '奇想兵种包 · 兵种数据'
ws['A1'].font = TITLE_FONT
ws['A2'] = '数值来自 src/core/expansions.ts；最后一列是按设计意图写的一句话机制说明，不是自动生成的。'
ws['A2'].font = NOTE_FONT

head = ['兵种', 'id', '时代', '造价', '移动', '攻击', '护甲', '生命', '射程', '视野', '溅射', '能力', '机制']
for i, h in enumerate(head, start=1):
    c = ws.cell(row=4, column=i, value=h)
    c.fill, c.font, c.alignment, c.border = HEAD_FILL, HEAD_FONT, CENTER, BORDER

row = 5
pack_units = [UNITS[i] for i in PACK]
pack_units.sort(key=lambda u: (u['era'], u['cost']))
for idx, u in enumerate(pack_units):
    ab = '、'.join(ABILITY_NAME.get(a, a) for a in (u.get('abilities') or [])) or '—'
    vals = [
        u['name'], u['id'], u['era'], u['cost'], u['move'], u['atk'], u['armor'],
        u['maxHp'], u['range'], u['vision'], u.get('splash', '—'), ab, MECH_NOTE.get(u['id'], ''),
    ]
    for i, v in enumerate(vals, start=1):
        c = ws.cell(row=row, column=i, value=v)
        c.border = BORDER
        c.alignment = LEFT if i in (1, 12, 13) else CENTER
        if idx % 2 == 1:
            c.fill = BAND_FILL
    row += 1

widths = [10, 11, 6, 7, 6, 6, 6, 6, 6, 6, 6, 22, 46]
for i, w in enumerate(widths, start=1):
    ws.column_dimensions[get_column_letter(i)].width = w
ws.freeze_panes = 'A5'

# ── 表 2：各时代实测 ──────────────────────────────────────────────────────
ws2 = wb.create_sheet('实测')
ws2['A1'] = '每个兵种在实战里划不划算（只算开了包的那半批）'
ws2['A1'].font = TITLE_FONT
ws2['A2'] = '判定看「每兵贡献」和「同价原版中位」的倍数；「每百金杀伤」只留着和旧报告对得上。招募 < 15 的格子已灰掉。'
ws2['A2'].font = NOTE_FONT

head2 = ['对局时代', '兵种', '兵种时代', '价', '招募', '采用率', '每兵贡献', '同价原版中位', '倍数', '每百金杀伤', '交换比', '击杀', '判定']
for i, h in enumerate(head2, start=1):
    c = ws2.cell(row=4, column=i, value=h)
    c.fill, c.font, c.alignment, c.border = HEAD_FILL, HEAD_FONT, CENTER, BORDER

row = 5
for era in ERAS:
    doc = fant.get(era)
    if not doc:
        continue
    rows = [s for s in doc['stats'] if s['type'] in PACK and s['built'] > 0]
    rows.sort(key=lambda s: -s['built'])
    for s in rows:
        mine = per_unit(s)
        med = peer_median(doc['stats'], s['cost'], s['era'])
        mult = mine / med if med else None
        if s['built'] < 15:
            verdict = '样本少'
        elif mult is None:
            verdict = '—'
        elif mult < 0.7:
            verdict = '偏弱'
        elif mult > 1.4:
            verdict = '偏强'
        else:
            verdict = '合适'
        vals = [
            era, s['name'], s['era'], s['cost'], s['built'], s['share'], round(mine), round(med),
            round(mult, 2) if mult else '—', s['per100'],
            s['ratio'] if s['ratio'] is not None else '—', s['kills'], verdict,
        ]
        for i, v in enumerate(vals, start=1):
            c = ws2.cell(row=row, column=i, value=v)
            c.border = BORDER
            c.alignment = CENTER if i != 2 else LEFT
            if i == 6:
                c.number_format = '0.0%'
            if s['built'] < 15:
                c.font = Font(color='999999')
        if verdict == '偏弱':
            ws2.cell(row=row, column=13).fill = WEAK_FILL
        elif verdict == '偏强':
            ws2.cell(row=row, column=13).fill = STRONG_FILL
        row += 1

for i, w in enumerate([9, 10, 9, 7, 8, 8, 9, 12, 7, 11, 8, 7, 8], start=1):
    ws2.column_dimensions[get_column_letter(i)].width = w
ws2.freeze_panes = 'A5'

# ── 表 3：同代对照 ────────────────────────────────────────────────────────
ws3 = wb.create_sheet('同代对照')
ws3['A1'] = '包里八个兵 vs 原版同代主力'
ws3['A1'].font = TITLE_FONT
ws3['A2'] = '原版那一列是同一批对局里、同时代原版战斗单位的加权结果，所以"强弱"是当场比出来的，不是拿旧数据套的。'
ws3['A2'].font = NOTE_FONT

head3 = ['对局时代', '分组', '兵种数', '招募', '每兵贡献', '交换比']
for i, h in enumerate(head3, start=1):
    c = ws3.cell(row=4, column=i, value=h)
    c.fill, c.font, c.alignment, c.border = HEAD_FILL, HEAD_FONT, CENTER, BORDER

row = 5
for era in ERAS:
    doc = fant.get(era)
    if not doc:
        continue
    for label, pred in (('奇想包', True), ('原版', False)):
        g = [
            s for s in doc['stats']
            if s['category'] == 'combat' and s['built'] > 0 and ((s['type'] in PACK) == pred)
        ]
        dealt = sum(s['dealt'] for s in g)
        taken = sum(s['taken'] for s in g)
        built = sum(s['built'] for s in g)
        vals = [
            era, label, len(g), built,
            round(dealt / built + taken / built) if built else 0,
            round(dealt / taken, 2) if taken else '—',
        ]
        for i, v in enumerate(vals, start=1):
            c = ws3.cell(row=row, column=i, value=v)
            c.border = BORDER
            c.alignment = CENTER if i != 2 else LEFT
            if label == '奇想包':
                c.fill = BAND_FILL
        row += 1

for i, w in enumerate([9, 10, 8, 8, 10, 8], start=1):
    ws3.column_dimensions[get_column_letter(i)].width = w

# ── 表 4：对局影响 ────────────────────────────────────────────────────────
ws4 = wb.create_sheet('对局影响')
ws4['A1'] = '加了这套兵，对局有没有变形'
ws4['A1'].font = TITLE_FONT
ws4['A2'] = '包是双方共用的，所以先手胜率不该被它推动；真正该看的是回合数和未决率有没有被拉长。'
ws4['A2'].font = NOTE_FONT

head4 = ['时代', '尺寸', '局数（每臂）', '先手胜率 基线', '先手胜率 奇幻', 'Δ（pp）', '均回合 基线', '均回合 奇幻', '未决率 基线', '未决率 奇幻']
for i, h in enumerate(head4, start=1):
    c = ws4.cell(row=4, column=i, value=h)
    c.fill, c.font, c.alignment, c.border = HEAD_FILL, HEAD_FONT, CENTER, BORDER


def a_share(doc):
    d = doc['summary']['aWins'] + doc['summary']['bWins']
    return doc['summary']['aWins'] / d if d else 0.0


row = 5
for era in ERAS:
    b, f = base.get(era), fant.get(era)
    if not b or not f:
        continue
    vals = [
        era, '%d×%d' % (b['size'], b['size']), len(b['results']),
        round(a_share(b), 4), round(a_share(f), 4), round((a_share(f) - a_share(b)) * 100, 1),
        round(b['summary']['turnsAvg'], 1), round(f['summary']['turnsAvg'], 1),
        round(b['summary']['draws'] / len(b['results']), 4),
        round(f['summary']['draws'] / len(f['results']), 4),
    ]
    for i, v in enumerate(vals, start=1):
        c = ws4.cell(row=row, column=i, value=v)
        c.border = BORDER
        c.alignment = CENTER
        if i in (4, 5, 9, 10):
            c.number_format = '0.0%'
    row += 1

for i, w in enumerate([6, 8, 13, 13, 13, 9, 11, 11, 11, 11], start=1):
    ws4.column_dimensions[get_column_letter(i)].width = w

# ── 表 5：口径 ────────────────────────────────────────────────────────────
ws5 = wb.create_sheet('口径')
ws5['A1'] = '这份表怎么读'
ws5['A1'].font = TITLE_FONT
notes = [
    ('数据来源', 'AI 对 AI 跑批（双方高级 AI），同种子配对：一臂只开「血战」，另一臂再勾「奇想兵种包」，其余完全相同。'),
    ('局数', '时代 2 共 20 局、时代 3 共 80 局、时代 4 共 40 局、时代 5 共 40 局，合计 180 局（每臂 90 局）。'),
    ('每兵贡献', '（总输出 + 总承伤）÷ 招募数。这是判定用的口径：不吃造价，贵兵便宜兵可以直接比。'),
    ('为什么不看每百金', '那个指标系统性地偏爱便宜兵——25 金的民兵死一百个，"每 100 金抗伤"能冲到 100，而 220 金的吸血鬼死一次只值 15。'),
    ('同价原版中位', '同一批对局里、造价 ±35% 内的原版战斗单位的贡献中位数。凑不够两个就退到"同时代 ±1"那一档。'),
    ('判定', '倍数 < 0.7 = 偏弱，> 1.4 = 偏强，中间算合适；招募 < 15 的格子灰掉，不下结论。'),
    ('交换比', '总输出 ÷ 总承伤。>1 说明打回来的比挨的多；承伤为 0 的样本不进这个比值。'),
    ('关于先后手', '时代3 的 40 对里先手胜率 56.8% → 78.9%（第一轮 69.4%，两轮同向）：这套机制几乎都在奖励"先动、先贴上去"，所以会放大节奏优势。建议配「先后手补偿」一起用。'),
    ('样本提醒', '时代 2 只有 10 对、时代 4/5 各 20 对，只能当方向看；时代 3 有 40 对，是这批里最可信的一档。'),
]
r = 3
for k, v in notes:
    ws5.cell(row=r, column=1, value=k).font = Font(bold=True, size=10)
    c = ws5.cell(row=r, column=2, value=v)
    c.alignment = LEFT
    c.font = Font(size=10)
    r += 1
ws5.column_dimensions['A'].width = 22
ws5.column_dimensions['B'].width = 95

wb.save(OUT)
print('写出', OUT)
