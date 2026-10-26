# -*- coding: utf-8 -*-
"""把几轮奇想跑批的兵种统计合并成一张"利用率 + 效率"总表。

    python scripts/fantasy-agg.py results-fantasy/e3-fantasy.json results-fantasy/e4-fantasy.json results-fantasy/e5-fantasy.json

输出 markdown 到 stdout。口径：
    built  几轮加起来的建造数（120 局）
    per100 按"总输出 / 总花费"重算，跨轮合并，避免小样本单轮噪声
"""

import json
import sys

FANTASY = set()


def main():
    runs = [json.load(open(p, encoding='utf-8')) for p in sys.argv[1:]]
    names = json.load(open('_build/fantasy-units.json', encoding='utf-8'))
    meta = {}
    for p in names['packs']:
        for u in p['units']:
            meta[u['id']] = (u['name'], p['name'], u['era'], u['cost'], u.get('summonedOnly', False), u.get('hero', False))

    agg = {}
    for r in runs:
        for s in r['stats']:
            if s['type'] not in meta:
                continue
            a = agg.setdefault(s['type'], {'built': 0, 'spend': 0, 'dealt': 0, 'taken': 0, 'kills': 0, 'runs': 0, 'gold': 0})
            a['built'] += s['built']
            a['spend'] += s['spend']
            a['dealt'] += s['dealt']
            a['taken'] += s['taken']
            a['kills'] += s['kills']
            a['gold'] += s['goldShare']
            if s['built'] > 0:
                a['runs'] += 1

    games = sum(r['games'] for r in runs)
    total_spend = sum(sum(s['spend'] for s in r['stats']) for r in runs)

    print(f'# 奇想兵种利用率（{games} 局合并）')
    print()
    print('| 兵种 | 包 | 时代 | 造价 | 建造 | 占比局 | 金币占比 | 输出/100金 | 承伤/100金 | 击杀 |')
    print('|---|---|---|---|---|---|---|---|---|---|')
    rows = sorted(agg.items(), key=lambda kv: -kv[1]['built'])
    for t, a in rows:
        name, pack, era, cost, summoned, hero = meta[t]
        per100 = a['dealt'] / a['spend'] * 100 if a['spend'] else 0
        per100t = a['taken'] / a['spend'] * 100 if a['spend'] else 0
        print(
            f'| {name}{"（英雄）" if hero else ""}{"（召唤物）" if summoned else ""} | {pack} | {era} | {cost} | '
            f'{a["built"]} | {a["runs"]}/{len(runs)} | {a["gold"] / len(runs) * 100:.1f}% | '
            f'{per100:.1f} | {per100t:.1f} | {a["kills"]} |'
        )

    zero = [meta[t][0] for t in meta if agg.get(t, {}).get('built', 0) == 0]
    print()
    print(f'合计：{len(meta)} 个兵种里，**{len(zero)} 个一次都没被造过**。')
    if zero:
        print()
        print('一次没造过：' + '、'.join(zero))


if __name__ == '__main__':
    main()
