"""卡池体检的三个池子级指标 + 席位校正的单卡显著表。

口径（与 docs/DRAFT-STATS-2026-11-07.md 一致，但这里第一次写成脚本）：
  · 单卡胜率：只算「只有一方拿到它」的局（镜像局不计），分母 n
  · 席位校正：期望 = Σ_side (该侧拿到它的局数 × 该侧整体胜率)，不假设 50%
  · SDM：单卡胜率（扣席位后）的标准差
  · EM ：单卡胜率的归一化熵（越接近 1 越"人人有份"）
  · 覆盖率：真被选过的卡 ÷ 进过池的卡
用法：python .tmp/draft/metrics.py e3-turnban e1 e3
"""
import json, glob, math, sys, collections

def load(d):
    rows = []
    for f in sorted(glob.glob(f'.tmp/draft/{d}/*.jsonl')):
        for line in open(f, encoding='utf-8'):
            if line.strip():
                rows.append(json.loads(line))
    return rows

def analyse(d):
    rows = load(d)
    n = len(rows)
    a = sum(1 for r in rows if r['winner'] == 'A')
    b = sum(1 for r in rows if r['winner'] == 'B')
    decided = a + b
    base = {'A': a / decided if decided else .5, 'B': b / decided if decided else .5}
    turns = sum(r['turns'] for r in rows) / max(1, n)

    pool = collections.Counter(); banned = collections.Counter(); picked = collections.Counter()
    solo = collections.Counter(); solow = collections.Counter(); soloseat = collections.Counter()
    for r in rows:
        for x in set(r['pool']): pool[x] += 1
        for x in r['bansA'] + r['bansB']:
            if x: banned[x] += 1
        pa, pb = set(r['picksA']), set(r['picksB'])
        for x in pa | pb: picked[x] += 1
        if not r['winner']: continue
        for side, mine, theirs in (('A', pa, pb), ('B', pb, pa)):
            for x in mine - theirs:
                solo[x] += 1
                soloseat[(x, side)] += 1
                if r['winner'] == side: solow[x] += 1

    cards = []
    for c, nn in solo.items():
        w = solow[c]
        exp = soloseat[(c, 'A')] * base['A'] + soloseat[(c, 'B')] * base['B']
        p = w / nn
        var = exp * (1 - exp / nn)          # 二项方差 n·p·(1−p)，exp 是期望胜场数
        z = (w - exp) / math.sqrt(max(var, 1e-9))
        cards.append((c, nn, w, p, exp, z))

    # 池子级：只用 n>=10 的卡算 SDM/EM（小样本卡的胜率方差本身就大）
    ok = [c for c in cards if c[1] >= 10]
    wr = [c[3] for c in ok]
    mean = sum(wr) / len(wr) if wr else 0
    sdm = math.sqrt(sum((x - mean) ** 2 for x in wr) / len(wr)) if wr else 0
    # 纯抽样噪声会在 SDM 里垫一个底：n 越小底越高，所以跨样本量比 SDM 是无效的。
    # 只有超出噪声底的「超额 SDM」才能跨批次比。
    noise_var = sum(c[3] * (1 - c[3]) / c[1] for c in ok) / len(ok) if ok else 0
    excess = math.sqrt(max(sdm * sdm - noise_var, 0))
    s = sum(wr) or 1
    em = -sum((x / s) * math.log(x / s) for x in wr if x > 0) if wr else 0
    em_norm = em / math.log(len(wr)) if len(wr) > 1 else 0
    covered = len([c for c in pool if picked[c] > 0])
    return dict(dir=d, n=n, a=a, b=b, undecided=n - decided, base=base, turns=turns,
                cards=cards, ok=ok, mean=mean, sdm=sdm, noise=math.sqrt(noise_var),
                excess=excess, em=em, em_norm=em_norm,
                pool=len(pool), picked=len(picked), covered=covered,
                banned=banned, pickedc=picked, poolc=pool, solo=solo,
                pair={c: (nn, w, exp) for c, nn, w, p, exp, z in cards})

def report(r):
    print(f"\n=== {r['dir']}  n={r['n']}  A={r['a']} B={r['b']} 未决={r['undecided']} "
          f"平均{r['turns']:.1f}回 ===")
    print(f"  席位基准：A {r['base']['A']*100:.1f}% / B {r['base']['B']*100:.1f}%")
    print(f"  池子：进池 {r['pool']} 种，真被选 {r['picked']} 种，覆盖率 "
          f"{r['covered']}/{r['pool']} = {r['covered']/max(1,r['pool'])*100:.0f}%")
    print(f"  单卡胜率(n>=10 共 {len(r['ok'])} 张)：均值 {r['mean']*100:.1f}%  "
          f"SDM {r['sdm']*100:.1f}pp（噪声底 {r['noise']*100:.1f}pp，"
          f"超额 {r['excess']*100:.1f}pp）")
    print(f"  EM {r['em']:.3f}（归一化 {r['em_norm']*100:.0f}%）"
          f"  ← 胜率都挤在 50% 附近时这个数恒接近 100%，本身没有信息量")
    sig = sorted([c for c in r['cards'] if abs(c[5]) >= 1.96], key=lambda t: -abs(t[5]))
    print(f"  席位校正后显著：{len(sig)} 张")
    for c, nn, w, p, exp, z in sig[:14]:
        print(f"    {c:22s} {p*100:5.1f}%  n={nn:3d}  期望{exp/r['solo'][c]*100:5.1f}%  z={z:+.2f}")

# 批次名 = 除了开关和开关的取值之外的参数（`--emit-ts 路径` 别当批次读）
_raw = sys.argv[1:]
_skip = set()
for _i, _a in enumerate(_raw):
    if _a.startswith('--'):
        _skip.add(_i)
        if _a == '--emit-ts' and _i + 1 < len(_raw):
            _skip.add(_i + 1)
BATCHES = [_a for _i, _a in enumerate(_raw) if _i not in _skip] or ['e1', 'e3', 'e3-turnban']
res = [analyse(d) for d in BATCHES]
for r in res:
    report(r)

print("\n=== 三批数据横向比 ===")
print(f"{'批次':14s} {'n':>4s} {'覆盖率':>7s} {'SDM':>8s} {'噪声底':>7s} {'超额':>7s} {'胜率均值':>8s} {'回合':>6s}")
for r in res:
    print(f"{r['dir']:14s} {r['n']:4d} {r['covered']/max(1,r['pool'])*100:6.0f}% "
          f"{r['sdm']*100:7.1f}pp {r['noise']*100:6.1f}pp {r['excess']*100:6.1f}pp "
          f"{r['mean']*100:7.1f}% {r['turns']:6.1f}")

# ──────────────────────────────────────────────────────────────────────────
# 生成 AI 的「卡牌先验表」
# ──────────────────────────────────────────────────────────────────────────
# 干什么用：手写 AI 的选卡估值 `draftValueOf` 是纯静态的（攻/血/甲/射程 ×
# 时代折价 × 每金战力），它看不见"空中层 + 时代 1 没有对空"这种事——女巫
# 87% 的胜率完全不在那四个维度里。这张表就是把实测残差喂回估值。
#
# 口径（三条都必须写在表里，否则数字会被误读）：
#   1. 残差 = (实胜 − 席位加权期望) / 局数，**不是裸胜率**。裸胜率是席位的倒影。
#   2. 收缩：shrunk = 残差 × n/(n+K)，K=40。n=20 的卡只拿到三分之一的残差，
#      n=86 的女巫拿 68%。这是贝叶斯收缩（ManaCore 那套 GIH WR 的同类做法）。
#   3. 映射：factor = 1 + (CAP/SPAN) × clamp(shrunk, ±SPAN)，SPAN=15pp、CAP=15%。
#      即 shrunk 到 15pp 才顶到 ±15%，中间线性。
#      所以这张表最多只能把一张卡的选卡分推 ±15%，压不过静态估值的量级，
#      也压不过"现在造不出来"那类硬约束。
#
# **这是弱标签，不是真值**：胜率来自 AI 自对弈，AI 不会用的卡会显得弱、于是更
# 不会被选、于是永远学不会（自证循环）。数值改动一次这张表就过期。真人 43 局
# 才是分布外的信号。
K = 40.0
SPAN = 0.15
CAP = 0.15
MIN_N = 10

def build_prior():
    agg = {}
    for r in res:
        for c, (nn, w, exp) in r['pair'].items():
            a = agg.setdefault(c, [0.0, 0.0, 0.0])
            a[0] += nn; a[1] += w; a[2] += exp
    table = {}
    for c, (nn, w, exp) in agg.items():
        if nn < MIN_N:
            continue
        resid = (w - exp) / nn
        shrunk = resid * nn / (nn + K)
        # 满量程折算：shrunk 达到 ±SPAN 时才顶到 ±CAP，中间线性。
        # （写成 shrunk/SPAN 再 clamp ±CAP 是错的量纲：2.3pp 就顶满了，表退化成三档。）
        factor = 1.0 + (CAP / SPAN) * max(-SPAN, min(SPAN, shrunk))
        table[c] = dict(n=int(nn), resid=resid, shrunk=shrunk, factor=factor)
    return table

def unit_digest(ids):
    """数值指纹：和运行端共用 scripts/unit-digest.ts，避免"两套实现各自漂移"。"""
    import subprocess
    r = subprocess.run(
        ['node', '--experimental-strip-types', 'scripts/unit-digest.ts', '--stdin'],
        input='\n'.join(ids), capture_output=True, text=True, encoding='utf-8',
    )
    if r.returncode != 0:
        raise SystemExit('算数值指纹失败：\n' + (r.stderr or '')[-800:])
    return r.stdout.strip().splitlines()[-1]


def emit_ts(path):
    table = build_prior()
    digest = unit_digest(list(table.keys()))
    rows = sorted(table.items(), key=lambda kv: -kv[1]['factor'])
    stamp = __import__('datetime').date.today().isoformat()
    out = []
    out.append("/**")
    out.append(" * 卡牌先验表（**生成文件，不要手改**）。")
    out.append(" *")
    out.append(f" * 生成：{stamp}　`python scripts/draft-metrics.py {' '.join(r['dir'] for r in res)} --emit-ts`")
    out.append(f" * 数据：{', '.join(str(r['dir']) + '(n=' + str(r['n']) + ')' for r in res)}")
    out.append(" *")
    out.append(" * resid  = (实胜 − 席位加权期望) / 局数，pp。**不是裸胜率**。")
    out.append(f" * shrunk = resid × n/(n+{K:.0f})，把 n=20 的卡缩到三分之一。")
    out.append(f" * factor = 1 + ({CAP:.2f}/{SPAN:.2f}) × clamp(shrunk, ±{SPAN:.2f})，")
    out.append(f" *          即 shrunk 到 {SPAN*100:.0f}pp 才顶到满额，最多把选卡分推 ±{CAP*100:.0f}%。")
    out.append(" *")
    out.append(" * 已知偏差（改表前先读）：胜率来自 AI 自对弈，AI 不会用的卡会被判弱、")
    out.append(" * 于是更不会被选，永远学不会。")
    out.append(" *")
    out.append(" * unitsDigest 是这批卡的数值指纹（见 core/unit-digest.ts）。**改了任何一个")
    out.append(" * 参与指纹的数字，这张表就自动失效**——运行端会对不上、先验关掉，")
    out.append(" * npm run test:rules 也会红。重生成：npm run draft:prior")
    out.append(" */")
    out.append("")
    out.append("export interface CardPriorRow {")
    out.append("  /** 参与统计的局数（只有一方拿到它的局） */")
    out.append("  n: number;")
    out.append("  /** 未收缩的残差（pp，正 = 拿到它比同席位期望多赢） */")
    out.append("  resid: number;")
    out.append("  /** 收缩后的残差（pp） */")
    out.append("  shrunk: number;")
    out.append("  /** 选卡分乘数：1 + clamp(shrunk/span, ±cap) */")
    out.append("  factor: number;")
    out.append("}")
    out.append("")
    out.append("export const CARD_PRIOR_META = {")
    out.append(f"  builtAt: '{stamp}',")
    out.append(f"  batches: [{', '.join(chr(39) + str(r['dir']) + chr(39) for r in res)}],")
    out.append(f"  games: {sum(r['n'] for r in res)},")
    out.append(f"  unitsDigest: '{digest}',")
    out.append(f"  k: {K}, span: {SPAN}, cap: {CAP}, minN: {MIN_N},")
    out.append("} as const;")
    out.append("")
    out.append("export const CARD_PRIOR: Record<string, CardPriorRow> = {")
    for c, v in rows:
        out.append(f"  '{c}': {{ n: {v['n']}, resid: {v['resid']:.4f}, "
                   f"shrunk: {v['shrunk']:.4f}, factor: {v['factor']:.4f} }},")
    out.append("};")
    out.append("")
    open(path, 'w', encoding='utf-8').write('\n'.join(out))
    return table

if '--emit-ts' in sys.argv:
    i = sys.argv.index('--emit-ts')
    dst = sys.argv[i + 1] if len(sys.argv) > i + 1 else 'scripts/lib/card-prior.table.ts'
    tbl = emit_ts(dst)
    fs = sorted(tbl.items(), key=lambda kv: -kv[1]['factor'])
    print(f"\n=== 先验表 → {dst}（{len(tbl)} 张，K={K:.0f}，cap=±{CAP*100:.0f}%）===")
    print(f"{'卡':22s} {'n':>4s} {'残差':>8s} {'收缩后':>8s} {'乘数':>7s}")
    for c, v in fs[:8]:
        print(f"{c:22s} {v['n']:4d} {v['resid']*100:+7.1f}pp {v['shrunk']*100:+7.1f}pp {v['factor']:6.3f}")
    print("  …")
    for c, v in fs[-6:]:
        print(f"{c:22s} {v['n']:4d} {v['resid']*100:+7.1f}pp {v['shrunk']*100:+7.1f}pp {v['factor']:6.3f}")
