"""把地图文本文件转成可直接执行的 base64 SQL（给 MCP 的 exec_sql 用）。

为什么要有这个：往 `warchess_maps` 里塞数据，正常走游戏内上传按钮即可。
但有时要**从命令行补传**（批量、或者手上只有文件），这时候两条路都不好走：

  · 用 `parameters` 传数组：偶尔会被上游解析成 "empty sql"，重试也一样；
  · 把行数据**手抄**进 SQL：我抄错过一个字符，把一行写成 33 字符。
    那张图在库里是"行长不一致"，客户端 `validateFixedMap` 会整张拒掉，
    而肉眼看上去完全正常——是 md5 比对才发现的。

所以这里只做一件事：从 `.tmp/maps/<名字>.txt`（`name:` 首行 + 地形行）
生成一句 base64 的 insert/update，**不给人抄的机会**。

用法：
  python scripts/map-sql.py .tmp/maps/宿命.txt            # 生成 insert
  python scripts/map-sql.py .tmp/maps/宿命.txt --update 4 # 生成 update（修某一行）

输出最后一行是 base64，直接粘给 exec_sql 的 `sqlBase64`。
生成前会自检：每行等宽、每方至少一座城、没有非法字符。
"""

import base64
import json
import sys

TERRAIN_CHARS = set('.fh~^=PvwdsDAB')


def load(path):
    lines = [x for x in open(path, encoding='utf-8').read().splitlines() if x.strip()]
    name = '未命名'
    if lines and lines[0].startswith('name:'):
        name = lines[0][5:].strip()
        lines = lines[1:]
    rows, ca, cb = [], [], []
    for y, line in enumerate(lines):
        r = ''
        for x, ch in enumerate(line):
            if ch not in TERRAIN_CHARS:
                raise SystemExit(f'第 {y + 2} 行第 {x + 1} 列有不认识的字符 {ch!r}')
            if ch == 'A':
                ca.append({'x': x, 'y': y}); r += '.'
            elif ch == 'B':
                cb.append({'x': x, 'y': y}); r += '.'
            else:
                r += ch
        rows.append(r)
    widths = {len(r) for r in rows}
    if len(widths) != 1:
        bad = [(i, len(r)) for i, r in enumerate(rows) if len(r) != len(rows[0])]
        raise SystemExit(f'行长不一致（应为 {len(rows[0])}）：{bad}')
    if not ca or not cb:
        raise SystemExit('至少每方要有一座城（用 A / B 标）')
    return {'name': name, 'w': widths.pop(), 'h': len(rows),
            'rows': rows, 'cities_a': ca, 'cities_b': cb}


def q(obj):
    return json.dumps(obj, ensure_ascii=False).replace("'", "''")


def main():
    args = [a for a in sys.argv[1:]]
    if not args:
        raise SystemExit(__doc__)
    path = args[0]
    m = load(path)
    if '--update' in args:
        rid = args[args.index('--update') + 1]
        sql = (f"update public.warchess_maps set rows = '{q(m['rows'])}'::jsonb, "
               f"cities_a = '{q(m['cities_a'])}'::jsonb, cities_b = '{q(m['cities_b'])}'::jsonb "
               f"where id = {int(rid)} returning id, name, jsonb_array_length(rows) as nrows")
        print(f'# update id={rid}  {m["name"]}  {m["w"]}×{m["h"]}  '
              f'A{len(m["cities_a"])}/B{len(m["cities_b"])}')
    else:
        sql = ("insert into public.warchess_maps "
               "(name, author, w, h, rows, cities_a, cities_b, listed) values "
               f"('{m['name'].replace(chr(39), chr(39) * 2)}', null, {m['w']}, {m['h']}, "
               f"'{q(m['rows'])}'::jsonb, '{q(m['cities_a'])}'::jsonb, "
               f"'{q(m['cities_b'])}'::jsonb, false) returning id, name, w, h")
        print(f'# insert  {m["name"]}  {m["w"]}×{m["h"]}  '
              f'A{len(m["cities_a"])}/B{len(m["cities_b"])}  （listed=false，待审核）')
    print(base64.b64encode(sql.encode('utf-8')).decode())


if __name__ == '__main__':
    main()
