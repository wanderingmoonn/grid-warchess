# -*- coding: utf-8 -*-
"""把 _build/fantasy-units.json 打成一份可以发给别人看的兵种表。

先跑 `npm run fantasy` 生成 JSON，再跑本脚本：

    python scripts/export-fantasy-xlsx.py

输出：奇想兵种表.xlsx（项目根目录）
"""

import json
import os
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, '_build', 'fantasy-units.json')
OUT = os.path.join(ROOT, '奇想兵种表.xlsx')

INK = '1F2937'        # 表头底色
ACCENT = '7C3AED'     # 奇想紫
BAND = 'F5F3FF'       # 隔行底色
GRID = 'D8D4E4'
WARN = 'FFF1F2'

HEAD_FONT = Font(name='微软雅黑', size=10, bold=True, color='FFFFFF')
BODY_FONT = Font(name='微软雅黑', size=10, color='1F2937')
NAME_FONT = Font(name='微软雅黑', size=10, bold=True, color='1F2937')
TITLE_FONT = Font(name='微软雅黑', size=16, bold=True, color='1F2937')
SUB_FONT = Font(name='微软雅黑', size=9, color='6B7280')

THIN = Side(style='thin', color=GRID)
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

CATEGORY = {'combat': '战斗', 'economy': '经济', 'builder': '工程', 'building': '建筑'}
ERA_NAME = {}
SPLASH = 0.5

# 分表顺序：和兵种面板一致，召唤物（不进兵营）压最后
GROUP_ORDER = ['骑士团', '荒兽', '秘法', '英雄', '召唤']


def style_header(ws, row, ncols, fill=INK):
    for c in range(1, ncols + 1):
        cell = ws.cell(row=row, column=c)
        cell.fill = PatternFill('solid', fgColor=fill)
        cell.font = HEAD_FONT
        cell.border = BOX
        cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    ws.row_dimensions[row].height = 30


def style_body(ws, first_row, last_row, ncols, band=True, center_from=3):
    for r in range(first_row, last_row + 1):
        for c in range(1, ncols + 1):
            cell = ws.cell(row=r, column=c)
            cell.font = NAME_FONT if c == 2 else BODY_FONT
            cell.border = BOX
            wrap = c <= 2 or c in LONG_COLS
            cell.alignment = Alignment(
                horizontal='center' if c >= center_from and not wrap else 'left',
                vertical='center',
                wrap_text=wrap,
            )
            if band and (r - first_row) % 2 == 1:
                cell.fill = PatternFill('solid', fgColor=BAND)


def add_table(ws, first_row, last_row, ncols, name):
    ref = f'A{first_row}:{get_column_letter(ncols)}{last_row}'
    tab = Table(displayName=name, ref=ref)
    tab.tableStyleInfo = TableStyleInfo(
        name='TableStyleLight1', showRowStripes=False, showColumnStripes=False
    )
    ws.add_table(tab)


def set_widths(ws, widths):
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w


def element_of(u, elements):
    if u.get('cycle'):
        return '轮换（' + ' → '.join(elements[e] for e in u['cycle']) + '）'
    if u.get('element'):
        return elements[u['element']]
    return '—'


def weak_of(u, elements):
    parts = [f"{elements[k]}×{v}" for k, v in (u.get('weak') or {}).items() if v > 1]
    return '、'.join(parts) if parts else '—'


def resist_of(u, elements):
    parts = [f"{elements[k]} −{v}" for k, v in (u.get('resist') or {}).items() if v > 0]
    return '、'.join(parts) if parts else '—'


def mechanic_of(u):
    """特性列装不下的东西：飞行、障碍、建造、孵化、合体、召唤、弹药、自损、分裂、英雄解锁、召唤物"""
    parts = []
    # 飞行要放第一位：14 个兵会飞，而"它能不能越过地形和阵型"是最影响战局的一条。
    # 空中层还有一条隐性代价（地面护甲不生效），必须一起说，否则读表的人会以为白赚。
    # 两条是独立的规则（见 rules.ts）：
    #   flight  → crossesWater，能过水
    #   layer:'air' → 空中层，能和地面单位同格；地面打它要多算 1 格（rules.ts:775），
    #                 且不吃地形护甲（rules.ts:1449）
    if u.get('flight'):
        parts.append('可选掠过水面')
    if u.get('layer') == 'air':
        parts.append('飞行：空中层，与地面单位互不占格（地面打它多算 1 格），不吃地形护甲')
    if u.get('obstacle'):
        parts.append('障碍：不可通行，只能拆')
    if u.get('buildsText'):
        parts.append(f"可建造：{u['buildsText']}")
    if u.get('hatchText'):
        parts.append(f"倒计时结束孵化为 {u['hatchText']}")
    if u.get('mergeText'):
        parts.append(f"与同类合体为 {u['mergeText']}")
    if u.get('summon'):
        s = u['summon']
        parts.append(f"每 {s.get('every', 1)} 回合召唤 1 个{u.get('summonText', '')}（同时最多 {s.get('max', 1)}）")
    if u.get('ammo'):
        parts.append(f"弹药 {u['ammo']} 发，打完只能贴脸")
    if u.get('decays'):
        parts.append(f"每回合自损 {u['decays']} 血")
    if u.get('splitText'):
        parts.append(f"死后分裂为 {u['splitText']}")
    if u.get('hero'):
        parts.append(f"英雄：同方场上一名，首次解锁 {u.get('unlockCost', 0)} 金")
    if u.get('summonedOnly'):
        parts.append('只能被召唤，不占编制')
    if u.get('splash'):
        parts.append(f"溅射 {u['splash']} 格（溅射到的目标吃 {int(SPLASH * 100)}%）")
    if u.get('splashLine'):
        parts.append('直线穿透（一线上的目标都吃伤害）')
    return '；'.join(parts) if parts else '—'


def ability_detail_of(u):
    """能力说明：和"特性"列同序，一条一行。

    只列名字等于把机制留在了别处，读表的人得来回翻「能力对照」。
    这里把 summary 直接摊开——要查"这个词是谁都有"再去那张表反查。
    """
    names = u.get('abilityNames') or []
    sums = u.get('abilitySummary') or []
    lines = [f"· {n}：{s}" if s else f"· {n}" for n, s in zip(names, sums)]
    return '\n'.join(lines) if lines else '—'


COLUMNS = [
    ('包', 16, lambda u, p: u.get('group') or p['name']),
    ('名称', 12, lambda u, p: u['name']),
    ('图标', 6, lambda u, p: u.get('short', '')),
    ('时代', 7, lambda u, p: ERA_NAME.get(u['era'], u['era'])),
    ('类别', 7, lambda u, p: CATEGORY.get(u['category'], u['category'])),
    ('造价', 7, lambda u, p: u['cost']),
    ('攻击', 7, lambda u, p: u['atk']),
    ('连击', 7, lambda u, p: u.get('burst', 1) if u.get('burst', 1) > 1 else '—'),
    ('魔法攻击', 9, lambda u, p: u.get('magicAtk') or '—'),
    ('护甲', 7, lambda u, p: u['armor']),
    ('魔法抗性', 9, lambda u, p: u.get('magicRes', 0)),
    ('生命', 7, lambda u, p: u['maxHp']),
    ('移动', 7, lambda u, p: u['move'] if u['move'] else '—'),
    ('射程', 7, lambda u, p: u['range']),
    ('视野', 7, lambda u, p: u['vision']),
    ('攻击属性', 12, None),
    ('弱点（倍乘）', 12, None),
    ('抗性（平减）', 12, None),
    ('特性', 26, lambda u, p: ' · '.join(u['abilityNames']) or '—'),
    ('能力说明', 40, None),
    ('英雄技能', 34, lambda u, p: u.get('skillText') or '—'),
    ('其他机制', 30, None),
]

# 需要换行 + 左对齐的长文本列（特性 / 能力说明 / 技能 / 其他机制）
LONG_COLS = {19, 20, 21, 22}


def make_sheet(wb, title, units, elements, tab_color=ACCENT):
    ws = wb.create_sheet(title)
    ws.sheet_properties.tabColor = tab_color
    head = [c[0] for c in COLUMNS]
    ws.append(head)
    style_header(ws, 1, len(head))

    for i, (u, p) in enumerate(units):
        row = [
            u.get('group') or p['name'], u['name'], u.get('short', ''), ERA_NAME.get(u['era'], u['era']),
            CATEGORY.get(u['category'], u['category']), u['cost'], u['atk'],
            u.get('burst', 1) if u.get('burst', 1) > 1 else '—',
            u.get('magicAtk') or '—', u['armor'], u.get('magicRes', 0), u['maxHp'],
            u['move'] if u['move'] else '—', u['range'], u['vision'],
            element_of(u, elements), weak_of(u, elements), resist_of(u, elements),
            ' · '.join(u['abilityNames']) or '—', ability_detail_of(u),
            u.get('skillText') or '—', mechanic_of(u),
        ]
        ws.append(row)

    last = ws.max_row
    style_body(ws, 2, last, len(head))
    ws.freeze_panes = 'C2'
    ws.auto_filter.ref = f'A1:{get_column_letter(len(head))}{last}'
    set_widths(ws, [c[1] for c in COLUMNS])
    for r in range(2, last + 1):
        # 行高按最长的那两列算：写死 34 的话，至尊法师那种"英雄 + 溅射"两行挤一起会被裁掉
        lines = 1
        for c, width in ((19, 26), (20, 40), (21, 34), (22, 30)):
            text = str(ws.cell(row=r, column=c).value or '')
            for seg in text.split('\n'):
                lines = max(lines, -(-len(seg) // int(width * 0.95)))
        ws.row_dimensions[r].height = max(30, lines * 15 + 8)
        # 魔法那两列浅浅地标一下：它们是新机制的门面
        for c in (9, 11):
            if ws.cell(row=r, column=c).value not in ('—', 0):
                ws.cell(row=r, column=c).fill = PatternFill('solid', fgColor='F3E8FF')
    return ws


def overview(wb, data):
    elements = data['elements']
    ws = wb.active
    ws.title = '总览'
    ws.sheet_properties.tabColor = INK
    ws['A1'] = '奇想兵种包 · 兵种表'
    ws['A1'].font = TITLE_FONT
    ws['A2'] = f"导出时间 {data['generatedAt']} · 数据直接取自 src/core/fantasy-packs.ts，改数值请重跑导出脚本"
    ws['A2'].font = SUB_FONT

    row = 4
    ws.cell(row=row, column=1, value='包结构').font = Font(
        name='微软雅黑', size=11, bold=True, color=ACCENT)
    row += 1
    head = ['扩展包', '兵种数', '依赖', '内容']
    for i, h in enumerate(head, start=1):
        ws.cell(row=row, column=i, value=h)
    style_header(ws, row, len(head))
    head_row = row
    row += 1
    for p in data['packs']:
        ws.cell(row=row, column=1, value=p['name'])
        ws.cell(row=row, column=2, value=len(p['units']))
        ws.cell(row=row, column=3, value='、'.join(p['requires']) or '—')
        ws.cell(row=row, column=4, value=p['summary'])
        row += 1
    style_body(ws, head_row + 1, row - 1, len(head), center_from=4)

    # 子包一览：面板里按这五组分，分表也按它分。合并成一个扩展之后，
    # 光看"包结构"那一行（奇想 72）会以为只有一张表，找不到该翻哪一页。
    row += 1
    ws.cell(row=row, column=1, value='子包（后面几张分表就是按它分的）').font = Font(
        name='微软雅黑', size=11, bold=True, color=ACCENT)
    row += 1
    sub_head = ['子包', '兵种数', '说明']
    for i, h in enumerate(sub_head, start=1):
        ws.cell(row=row, column=i, value=h)
    style_header(ws, row, len(sub_head))
    sub_head_row = row
    row += 1
    counts, descs = {}, {}
    for p in data['packs']:
        for u in p['units']:
            g = u.get('group') or '—'
            counts[g] = counts.get(g, 0) + 1
    descs = {
        '骑士团': '人类：剑士、精英/皇家骑兵、法师、牧师、刺客、圣骑士、国王……',
        '荒兽': '野兽与怪物：狼骑士、蜘蛛骑士、树人、牛头人、鹰身女妖、狮鹫骑士……',
        '秘法': '亡灵与元素：诅咒师、死灵法师、四元素、吸血鬼、恶魔、机关傀儡……',
        '英雄': '全场唯一的 11 个英雄，外加魔龙、魔龙卵、大史莱姆',
        '召唤': '只能被召唤，不进兵营：骷髅、幻象、小史莱姆、小恶魔、土墙',
    }
    for g in GROUP_ORDER + [k for k in counts if k not in GROUP_ORDER]:
        if g not in counts:
            continue
        ws.cell(row=row, column=1, value=g)
        ws.cell(row=row, column=2, value=counts[g])
        ws.cell(row=row, column=3, value=descs.get(g, ''))
        ws.merge_cells(start_row=row, start_column=3, end_row=row, end_column=4)
        row += 1
    style_body(ws, sub_head_row + 1, row - 1, len(sub_head), center_from=3)

    row += 1
    ws.cell(row=row, column=1, value='规则速查（表里那几列怎么读）').font = Font(
        name='微软雅黑', size=11, bold=True, color=ACCENT)
    row += 1
    notes = [
        ('列说明',
         '"特性"只列能力名，"能力说明"把每条能力的原文摊开（一条一行）；'
         '"其他机制"放的是数据字段里的硬机制——飞行、障碍、可建造、孵化、合体、召唤、弹药、'
         '自损、分裂、英雄解锁、溅射。这三列合起来才是一张完整的机制表，别只看"特性"。'),
        ('魔法攻击 / 魔法抗性',
         '魔攻是独立结算的第二段伤害：不吃护甲、不吃地形、不吃破甲，只被目标的魔抗平减。'
         '所以法师打重甲划算，打在魔抗单位身上像挠痒。数值都压在 20 以内——它是"另一条路"，不是"更大的数字"。'),
        ('属性伤害',
         '火 / 水 / 土 / 风 / 光 / 暗 / 自然 / 奥术。目标可以写"怕X"（倍乘）和"抗X"（平减），作用在整段伤害上：'
         '怕火不是"怕魔法火"，被火把砸一下也疼。'),
        ('飞行',
         '飞行单位能掠过水面、也能**停在水面上**（栖息，不是过河），森林丘陵按 1 步；'
         '它和地面单位互不占格——地面那格站着人，天上那格照样能停，'
         '天上的人也只打得到天上的人。'),
        ('状态',
         '中毒按生命上限 6% 结算；**燃烧改成叠层**：每层 4 点固定伤害，最多 3 层，结算完掉一层，'
         '怕火的每层翻倍——反复挨火会越烧越旺，走出去两回合就熄了。'
         '减速 −1 移动（最低 1）、诅咒 −2 护甲（最多两层）。'),
        ('英雄',
         '同一方场上只能有一个，第一次招募要额外付解锁费（表里"其他机制"列有写）。'
         '每个英雄每回合有一个**主动技能**（见"英雄技能"列），由玩家点，不占行动。'
         '不死鸟阵亡后不留尸体，而是留下一枚蛋，由玩家在自己回合选一格孵化（一半生命）。' + 
         '矮人王的投斧虽然也是技能，但它那一斧**不占用本回合的攻击次数**，扔完还能贴身再劈一刀。'),
        ('召唤物',
         '骷髅、小史莱姆、小恶魔、幻影只能被召唤，不占 24 编制，招募列表里根本不出现。'),
    ]
    for k, v in notes:
        ws.cell(row=row, column=1, value=k).font = Font(name='微软雅黑', size=10, bold=True)
        ws.cell(row=row, column=2, value=v).font = BODY_FONT
        ws.merge_cells(start_row=row, start_column=2, end_row=row, end_column=4)
        ws.cell(row=row, column=2).alignment = Alignment(wrap_text=True, vertical='top')
        ws.row_dimensions[row].height = 46
        row += 1

    row += 1
    ws.cell(row=row, column=1, value='属性对照').font = Font(name='微软雅黑', size=11, bold=True, color=ACCENT)
    row += 1
    ws.cell(row=row, column=1, value='属性')
    ws.cell(row=row, column=2, value='说明')
    style_header(ws, row, 2)
    row += 1
    el_note = {
        'fire': '火焰：点燃的载体，也是巨魔 / 僵尸 / 树人 / 史莱姆的克星',
        'water': '水流：给火元素加倍伤害，附带减速',
        'earth': '大地：最硬的属性，土墙与土元素',
        'wind': '疾风：击退与位移',
        'light': '光：克制亡灵与吸血鬼，天使的默认属性',
        'dark': '暗：死灵法师、诅咒师的默认属性',
        'nature': '自然：德鲁伊、树人的默认属性',
        'arcane': '奥术：法师、至尊法师的默认属性',
    }
    first = row
    for k, v in elements.items():
        ws.cell(row=row, column=1, value=v)
        ws.cell(row=row, column=2, value=el_note.get(k, ''))
        row += 1
    style_body(ws, first, row - 1, 2, center_from=3)
    set_widths(ws, [22, 26, 16, 66])
    return ws


def ability_sheet(wb, data):
    """能力对照：只列奇想包里真正用到的那些能力"""
    used = {}
    for p in data['packs']:
        for u in p['units']:
            for i, a in enumerate(u.get('abilities') or []):
                used.setdefault(a, []).append(u['name'])
    ws = wb.create_sheet('能力对照')
    ws.sheet_properties.tabColor = '0EA5E9'
    head = ['能力', '分组', '效果', '谁有']
    ws.append(head)
    style_header(ws, 1, len(head))
    group_name = {'attack': '进攻', 'defense': '防御', 'move': '机动', 'support': '支援'}
    for a in data['abilities']:
        if a['id'] not in used:
            continue
        ws.append([a['name'], group_name.get(a['group'], a['group']), a['summary'], '、'.join(used[a['id']])])
    last = ws.max_row
    style_body(ws, 2, last, len(head))
    ws.freeze_panes = 'A2'
    ws.auto_filter.ref = f'A1:D{last}'
    set_widths(ws, [14, 8, 62, 44])
    for r in range(2, last + 1):
        ws.row_dimensions[r].height = 32
    return ws


def main():
    with open(SRC, encoding='utf-8') as f:
        data = json.load(f)
    global SPLASH
    for e in data['eras']:
        ERA_NAME[e['level']] = e['name']
    SPLASH = data['config'].get('splashRatio', 0.5)

    wb = Workbook()
    overview(wb, data)

    elements = data['elements']
    all_units = []
    for p in data['packs']:
        for u in p['units']:
            all_units.append((u, p))

    # 一个子包一张表。
    #
    # 2026-11-04 五个奇想包并成一个扩展之后，这里原来按 `data['packs']` 分页，
    # 于是 72 个兵全挤进一张「奇想」表——以前骑士团/荒兽/秘法/英雄四张分表
    # 才是好用的地方（找"荒兽这一档有什么"不用在 72 行里翻）。
    # 合并只是把"要不要勾"合成一个开关，子包在兵种面板里还分着，所以照样分页。
    by_group = {}
    for u, p in all_units:
        by_group.setdefault(u.get('group') or p['name'], []).append((u, p))
    for g in GROUP_ORDER + [k for k in by_group if k not in GROUP_ORDER]:
        if g not in by_group:
            continue
        # 召唤物和土墙排到最后：它们不是"能招募的兵"，混在造价序列里会让人以为 20 金能买一只小史莱姆
        pairs = sorted(by_group[g], key=lambda x: (bool(x[0].get('summonedOnly')), x[0]['cost'], x[0]['name']))
        make_sheet(wb, g, pairs, elements)

    # 全表：按子包顺序 + 造价排（和兵种面板的排列一致）
    gorder = {g: i for i, g in enumerate(GROUP_ORDER)}
    make_sheet(
        wb,
        '全表',
        sorted(
            all_units,
            key=lambda x: (
                gorder.get(x[0].get('group') or '', 99),
                bool(x[0].get('summonedOnly')),
                x[0]['cost'],
            ),
        ),
        elements,
        tab_color=INK,
    )
    ability_sheet(wb, data)

    # 目标文件可能正被 Excel / 预览窗口占着，直接写会 PermissionError。
    # 先写临时文件，再原子替换；替换也失败时留一份带时间戳的副本，别让人以为没生成。
    tmp = OUT + '.tmp'
    wb.save(tmp)
    try:
        os.replace(tmp, OUT)
        print(f'已生成 {OUT}：{len(all_units)} 个兵种，{len(wb.sheetnames)} 张表')
    except PermissionError:
        alt = OUT.replace('.xlsx', '-新.xlsx')
        os.replace(tmp, alt)
        print(f'{OUT} 正被占用，已改写到 {alt}')


if __name__ == '__main__':
    main()
