# -*- coding: utf-8 -*-
"""奇想兵种包的平衡分析：把两次 balance-report 的 JSON 摊成一张人看的表。

    python scripts/fantasy-balance.py results-fantasy/e3-base.json results-fantasy/e3-fantasy.json > results-fantasy/e3.md

口径（和 balance-report 一致，别自己另发明一套）：
    per100      每 100 金造成的伤害 —— 输出效率
    per100Taken 每 100 金承受的伤害 —— 抗打效率（吃伤害也是一种工作）
    ratio       输出 / 承伤
    share       这个兵占全军造价的比重
"""

import json
import sys

FANTASY_PREFIX = ('fantasy-',)


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def pct(x):
    return f'{x * 100:.1f}%'


def num(x, nd=1):
    return f'{x:.{nd}f}'


def summary_block(tag, d):
    s = d['summary']
    return (
        f'| {tag} | {d["games"]} | {pct(s["aRate"])} | {pct(s["bRate"])} | {pct(s["drawRate"])} | '
        f'{num(s["turnsAvg"], 0)} | {num(s["recruitsPerGame"], 1)} | {num(s["spendPerGame"], 0)} |'
    )


def main():
    base = load(sys.argv[1])
    fan = load(sys.argv[2])
    out = []
    w = out.append

    w('# 奇想兵种包 · 平衡测量')
    w('')
    w(f'- 基线：`{sys.argv[1]}`（{", ".join(base["expansions"]) or "无扩展"}）')
    w(f'- 奇想：`{sys.argv[2]}`（{len(fan["expansions"])} 个包）')
    w(f'- 同种子配对：era {fan["era"]} · {fan["size"]}×{fan["size"]} · 各 {fan["games"]} 局')
    w('')
    w('## 总体')
    w('')
    w('| 组 | 局数 | A 胜 | B 胜 | 未决 | 平均回合 | 场均招兵 | 场均花费 |')
    w('|---|---|---|---|---|---|---|---|')
    w(summary_block('基线', base))
    w(summary_block('奇想', fan))
    w('')

    fb = {s['type']: s for s in base['stats']}
    ff = {s['type']: s for s in fan['stats']}

    # 原版兵种被挤占了多少
    shared = [t for t in ff if t in fb]
    moved = sorted(
        (t for t in shared if fb[t]['share'] > 0.5),
        key=lambda t: ff[t]['share'] - fb[t]['share'],
    )
    if moved:
        w('## 原版兵种的份额变化（只列基线里份额 >0.5% 的）')
        w('')
        w('| 兵种 | 基线份额 | 奇想份额 | 变化 |')
        w('|---|---|---|---|')
        for t in moved[:12] + moved[-12:]:
            d = ff[t]['share'] - fb[t]['share']
            w(f'| {fb[t]["name"]} | {pct(fb[t]["share"])} | {pct(ff[t]["share"])} | {d * 100:+.1f}pp |')
        w('')

    # 奇想兵种效能
    rows = [s for s in fan['stats'] if s['type'] in ff and s['built'] > 0]
    fantasy_rows = [s for s in rows if s['type'] not in fb]
    if fantasy_rows:
        w('## 奇想兵种效能（按每 100 金输出排序）')
        w('')
        w('| 兵种 | 时代 | 造价 | 建造 | 金币占比 | 输出 | 输出/100金 | 承伤 | 承伤/100金 | 交换比 | 击杀 |')
        w('|---|---|---|---|---|---|---|---|---|---|---|')
        for s in sorted(fantasy_rows, key=lambda x: -x['per100']):
            ratio = '∞' if s['ratio'] is None else num(s['ratio'], 2)
            w(
                f'| {s["name"]} | {s["era"]} | {s["cost"]} | {s["built"]} | {pct(s["goldShare"])} | '
                f'{num(s["dealt"], 0)} | {num(s["per100"])} | {num(s["taken"], 0)} | '
                f'{num(s["per100Taken"])} | {ratio} | {s["kills"]} |'
            )
        w('')

    # 原版参照：同时代同一批里，原版兵的 per100 中位数，用来判断奇想兵有没有出格
    def median(xs):
        xs = sorted(xs)
        if not xs:
            return 0.0
        n = len(xs)
        return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2

    base_by_era = {}
    for s in base['stats']:
        if s['built'] >= 20:
            base_by_era.setdefault(s['era'], []).append(s)

    w('## 出格清单')
    w('')
    ref = {era: (median([x['per100'] for x in xs]), median([x['per100Taken'] for x in xs]))
           for era, xs in base_by_era.items()}
    w('| 时代 | 原版输出中位 | 原版承伤中位 |')
    w('|---|---|---|')
    for era in sorted(ref):
        w(f'| {era} | {num(ref[era][0])} | {num(ref[era][1])} |')
    w('')

    hot, cold = [], []
    for s in fantasy_rows:
        m = ref.get(s['era'])
        if not m or s['built'] < 30:
            continue
        d_out = s['per100'] - m[0]
        d_tank = s['per100Taken'] - m[1]
        if d_out > m[0] * 0.5 or (d_tank > m[1] * 0.8 and s['per100'] > m[0]):
            hot.append((s, d_out, d_tank))
        if d_out < -m[0] * 0.35 and d_tank < m[1] * 0.4:
            cold.append((s, d_out, d_tank))

    w('### 偏强（输出或抗打明显高于同代原版中位）')
    w('')
    if hot:
        w('| 兵种 | 时代 | 输出/100金 | 比中位 | 承伤/100金 | 比中位 | 造价 |')
        w('|---|---|---|---|---|---|---|')
        for s, do, dt in sorted(hot, key=lambda x: -x[1]):
            w(f'| {s["name"]} | {s["era"]} | {num(s["per100"])} | {do:+.1f} | {num(s["per100Taken"])} | {dt:+.1f} | {s["cost"]} |')
    else:
        w('（无）')
    w('')
    w('### 偏弱（两头都低于同代中位）')
    w('')
    if cold:
        w('| 兵种 | 时代 | 输出/100金 | 比中位 | 承伤/100金 | 比中位 | 造价 |')
        w('|---|---|---|---|---|---|---|')
        for s, do, dt in sorted(cold, key=lambda x: x[1]):
            w(f'| {s["name"]} | {s["era"]} | {num(s["per100"])} | {do:+.1f} | {num(s["per100Taken"])} | {dt:+.1f} | {s["cost"]} |')
    else:
        w('（无）')
    w('')

    print('\n'.join(out))


if __name__ == '__main__':
    main()
