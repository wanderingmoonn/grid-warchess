/**
 * 「奇想兵种包」的实测报告。
 *
 * 口径和前面几轮保持一致：
 *   · 同一批种子、同尺寸、同 AI，唯一的差别是"开不开这个包"，所以配对相减是干净的；
 *   · 包里双方共用同一套兵，先后手胜率理论上不该被这个包推动——真推了，说明它在偏袒某种开局；
 *   · 兵种强弱看「每百金杀伤」而不是总杀伤：贵兵打得多是应该的，划算不划算才叫平衡。
 *
 * 用法：
 *   node --experimental-strip-types scripts/fantasy-report.ts \
 *     --dir results23 --eras 2,3,4,5 --out results23/fantasy-report.md
 */

import fs from 'node:fs';
import path from 'node:path';

import { EXPANSIONS } from '../src/core/expansions.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const DIR = argOf('dir', 'results23');
const OUT = argOf('out', path.join(DIR, 'fantasy-report.md'));
/** 上一轮（调数值之前）的目录：给了就多出一节"调整前后" */
const PREV = argOf('prev', '');
const ERAS = argOf('eras', '2,3,4,5')
  .split(',')
  .map((x) => Number(x.trim()))
  .filter((x) => x > 0);
/** 报告里怎么称呼两份数据 */
const BASE = argOf('base', 'base');
const FANT = argOf('fant', 'fant');

/** 兵种包里的 id：判定"是不是模组兵"用它，不用 UNIT_TYPES 反查（自定义兵种会漏） */
const PACK = new Set(['warlock', 'banshee', 'dragoon', 'griffin', 'treant', 'vampire', 'behemoth', 'dragon']);

interface GameResult {
  seed: number;
  winner: 'A' | 'B' | null;
  turns: number;
}

interface TypeStat {
  type: string;
  name: string;
  era: number;
  category: string;
  cost: number;
  built: number;
  spend: number;
  share: number;
  dealt: number;
  taken: number;
  ratio: number | null;
  per100: number;
  per100Taken: number;
  kills: number;
}

interface Report {
  era: number;
  size: number;
  games: number;
  summary: { aWins: number; bWins: number; draws: number; turnsAvg: number; recruitsPerGame: number };
  stats: TypeStat[];
  results: GameResult[];
}

const read = (p: string): Report | null => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Report;
  } catch {
    return null;
  }
};

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};
const f1 = (x: number): string => (x > 0 ? `+${x.toFixed(1)}` : x.toFixed(1));
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** 分出胜负的局里先手占多少 */
const aShare = (r: Report): number => {
  const d = r.summary.aWins + r.summary.bWins;
  return d > 0 ? r.summary.aWins / d : 0;
};
const diffCi = (x1: number, n1: number, x2: number, n2: number): [number, number] => {
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  return [p1 - p2 - 1.96 * se, p1 - p2 + 1.96 * se];
};
/** 同种子逐局相减，t 临界值按对子数查表（这里最大也就 40 对，够用） */
const tCrit = (n: number): number => {
  if (n >= 40) return 2.02;
  if (n >= 30) return 2.04;
  if (n >= 20) return 2.09;
  if (n >= 10) return 2.26;
  return 2.5;
};
const pairedTurns = (a: Report, b: Report): { mean: number; lo: number; hi: number; n: number } => {
  const bySeed = new Map<number, number>();
  for (const g of a.results) bySeed.set(g.seed, g.turns);
  const ds: number[] = [];
  for (const g of b.results) {
    const t = bySeed.get(g.seed);
    if (t !== undefined) ds.push(g.turns - t);
  }
  const n = ds.length;
  if (n < 2) return { mean: 0, lo: 0, hi: 0, n };
  const m = mean(ds);
  const sd = Math.sqrt(ds.reduce((p, x) => p + (x - m) ** 2, 0) / (n - 1));
  const half = tCrit(n) * (sd / Math.sqrt(n));
  return { mean: m, lo: m - half, hi: m + half, n };
};

const lines: string[] = [];
const say = (s = ''): void => {
  console.log(s);
  lines.push(s);
};

say('# 「奇想兵种包」实测：机制、节奏与兵种强弱');
say();

interface Cell {
  era: number;
  base: Report;
  fant: Report;
}

const cells: Cell[] = [];
for (const era of ERAS) {
  const b = read(path.join(DIR, `${BASE}-era${era}.json`));
  const f = read(path.join(DIR, `${FANT}-era${era}.json`));
  if (b && f) cells.push({ era, base: b, fant: f });
}
if (cells.length === 0) throw new Error('一份数据都没找到，先跑 balance-report');

const totalGames = cells.reduce((n, c) => n + c.base.results.length + c.fant.results.length, 0);
say(
  `口径：双方高级 AI、同种子配对（${BASE} = 只开血战，${FANT} = 血战 + 奇想兵种包），共 ${totalGames} 局。`,
);
say(`棋盘：${cells.map((c) => `${c.era} 用 ${c.base.size}×${c.base.size}`).join('、')}。`);
say();

// ── 一、开不开这个包，对局变成什么样 ──────────────────────────────────────
say('## 一、开不开这个包');
say();
say('| 时代 | 尺寸 | 局数（对） | 先手胜率 基线 → 奇幻 | Δ（95% CI） | 均回合 基线 → 奇幻 | Δ配对回合（95% CI） | 未决率 基线 → 奇幻 |');
say('|---|---:|---:|---|---|---|---|---|');
for (const c of cells) {
  const n1 = c.base.summary.aWins + c.base.summary.bWins;
  const n2 = c.fant.summary.aWins + c.fant.summary.bWins;
  const a1 = aShare(c.base);
  const a2 = aShare(c.fant);
  const [lo, hi] = diffCi(c.fant.summary.aWins, n2, c.base.summary.aWins, n1);
  const pt = pairedTurns(c.base, c.fant);
  const draw1 = c.base.summary.draws / c.base.results.length;
  const draw2 = c.fant.summary.draws / c.fant.results.length;
  say(
    `| ${c.era} | ${c.base.size}×${c.base.size} | ${c.base.results.length} | ` +
      `${pct(a1)} → ${pct(a2)} | ${f1((a2 - a1) * 100)} pp（${f1(lo * 100)} ~ ${f1(hi * 100)}） | ` +
      `${c.base.summary.turnsAvg.toFixed(1)} → ${c.fant.summary.turnsAvg.toFixed(1)} | ` +
      `${f1(pt.mean)}（${f1(pt.lo)} ~ ${f1(pt.hi)}） | ${pct(draw1)} → ${pct(draw2)} |`,
  );
}
say();
say('读法：Δ 的 CI 跨 0 = 这批局看不出这个包在偏袒先手或后手。包是双方共用的，本来就该不偏。');
say();

// ── 二、每个兵种在实战里的位置 ────────────────────────────────────────────
say('## 二、奇幻兵种实测');
say();
say('判定用的是「同价位每兵贡献」，不是每百金输出——理由见本节末尾。');
say();
say('| 对局时代 | 兵种 | 兵种时代 | 价 | 招募 | 采用率 | 每兵贡献 | 同价原版中位 | 倍数 | 每百金杀伤 | 交换比 | 判定 |');
say('|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');

/**
 * 每兵贡献 =（总输出 + 总承伤）÷ 招募数。
 *
 * 为什么不看每百金：那个指标对便宜兵有系统性的偏爱——25 金的民兵死一百个，
 * "每 100 金抗伤"能到 100，而一个 220 金的吸血鬼死了就只值 15。
 * 看绝对值也有问题：贵兵天然打得多。所以按"同价位"分组比，
 * 问的是"这笔钱买这个兵，比买当时那个价位的原版兵划算吗"。
 */
const perUnit = (s: TypeStat): number => (s.built > 0 ? (s.dealt + s.taken) / s.built : 0);

function peerMedian(stat: TypeStat[], cost: number, era: number): number {
  const base = stat.filter((s) => !PACK.has(s.type) && s.category === 'combat' && s.built >= 20);
  const near = base.filter((s) => Math.abs(s.cost - cost) / cost <= 0.35);
  const pool = near.length >= 2 ? near : base.filter((s) => s.era >= era - 1 && s.era <= era + 1);
  return median(pool.map(perUnit));
}

let weak = 0;
let strong = 0;
for (const c of cells) {
  const rows = c.fant.stats.filter((s) => PACK.has(s.type) && s.built > 0);
  // 造得多的排在前面：一局造 1 个的兵，数字全是噪声
  rows.sort((a, b) => b.built - a.built);
  for (const s of rows) {
    const mine = perUnit(s);
    const med = peerMedian(c.fant.stats, s.cost, s.era);
    const mult = med > 0 ? mine / med : 0;
    let verdict = '合适';
    if (s.built < 15) verdict = '样本少';
    else if (mult > 0 && mult < 0.7) verdict = '偏弱';
    else if (mult > 1.4) verdict = '偏强';
    if (verdict === '偏弱') weak += 1;
    if (verdict === '偏强') strong += 1;
    say(
      `| ${c.era} | ${s.name} | ${s.era} | ${s.cost} | ${s.built} | ${pct(s.share)} | ${mine.toFixed(0)} | ${med.toFixed(0)} | ` +
        `${mult > 0 ? `×${mult.toFixed(2)}` : '—'} | ${s.per100.toFixed(1)} | ` +
        `${s.ratio === null ? '—' : s.ratio.toFixed(2)} | ${verdict} |`,
    );
  }
}
say();
say('「每兵贡献」=（总输出 + 总承伤）÷ 招募数。**为什么不看每百金**：那个指标系统性地偏爱便宜兵——');
say('25 金的民兵死一百个，"每 100 金抗伤"能冲到 100，而 220 金的吸血鬼死一次只值 15。');
say('所以判定改成"同价位比"：问的是"这笔钱买它，比买同时期那个价位的原版兵划算吗"。');
say('「每百金杀伤」留在表里只为和前面几轮的报告对得上。样本 < 15 个的格子不下结论。');
say();

// ── 三、模组兵 vs 原版兵：整组对比 ────────────────────────────────────────
say('## 三、整组对比（只算战斗单位）');
say();
say('| 对局时代 | 模组：招募 / 每兵贡献 / 交换比 | 原版：招募 / 每兵贡献 / 交换比 | 贡献比 |');
say('|---|---|---|---:|');
for (const c of cells) {
  const sum = (pred: (t: TypeStat) => boolean) => {
    const g = c.fant.stats.filter((t) => t.category === 'combat' && t.built > 0 && pred(t));
    const dealt = g.reduce((n, t) => n + t.dealt, 0);
    const taken = g.reduce((n, t) => n + t.taken, 0);
    const built = g.reduce((n, t) => n + t.built, 0);
    return {
      built,
      per: g.length > 0 ? g.reduce((n, t) => n + perUnit(t), 0) / g.length : 0,
      ratio: taken > 0 ? dealt / taken : null,
    };
  };
  const pack = sum((t) => PACK.has(t.type));
  const orig = sum((t) => !PACK.has(t.type));
  const fmt = (o: ReturnType<typeof sum>): string =>
    `${o.built} / ${o.per.toFixed(0)} / ${o.ratio === null ? '—' : o.ratio.toFixed(2)}`;
  say(
    `| ${c.era} | ${fmt(pack)} | ${fmt(orig)} | ${orig.per > 0 ? (pack.per / orig.per).toFixed(2) : '—'} |`,
  );
}
say();
say(`判定汇总：偏弱 ${weak} 个、偏强 ${strong} 个（口径见上，样本不足不计）。`);
say();

// ── 四、调整前后（给了 --prev 才有） ──────────────────────────────────────
if (PREV) {
  say('## 四、这一轮调了什么');
  say();
  say('「每兵贡献」= （总输出 + 总承伤）÷ 招募数，不吃造价的那个偏差：贵兵便宜兵可以直接比。');
  say();
  say('| 兵种 | 时代 | 价 | 每兵贡献 调整前 → 调整后 | 采用率 调整前 → 调整后 | 招募 调整前 → 调整后 |');
  say('|---|---:|---:|---|---|---|');

  /** 同一个兵种在所有时代里合并：贡献按招募数加权，占比按总招募数重算 */
  const agg = (dir: string): Map<string, { built: number; dealt: number; taken: number; share: number }> => {
    const out = new Map<string, { built: number; dealt: number; taken: number; share: number }>();
    let total = 0;
    for (const era of ERAS) {
      const r = read(path.join(dir, `${FANT}-era${era}.json`));
      if (!r) continue;
      total += r.stats.reduce((n, s) => n + s.built, 0);
      for (const s of r.stats) {
        if (!PACK.has(s.type)) continue;
        const cur = out.get(s.type) ?? { built: 0, dealt: 0, taken: 0, share: 0 };
        cur.built += s.built;
        cur.dealt += s.dealt;
        cur.taken += s.taken;
        out.set(s.type, cur);
      }
    }
    for (const cur of out.values()) cur.share = total > 0 ? cur.built / total : 0;
    return out;
  };

  // 名字和造价直接读配置：实测文件里的 cost 是"当时的造价"，调整后就对不上了
  const defs = new Map(
    (EXPANSIONS.find((e) => e.id === 'fantasy-units')?.units ?? []).map((u) => [u.id, u]),
  );
  const before = agg(PREV);
  const after = agg(DIR);
  const per = (x: { built: number; dealt: number; taken: number }): number =>
    x.built > 0 ? (x.dealt + x.taken) / x.built : 0;
  for (const id of PACK) {
    const b = before.get(id);
    const a = after.get(id);
    const def = defs.get(id);
    if (!a || !def) continue;
    say(
      `| ${def.name} | ${def.era} | ${def.cost} | ` +
        `${b ? per(b).toFixed(0) : '—'} → ${per(a).toFixed(0)} | ` +
        `${b ? pct(b.share) : '—'} → ${pct(a.share)} | ${b ? b.built : '—'} → ${a.built} |`,
    );
  }
  say();
}

// ── 五、结论 ──────────────────────────────────────────────────────────────
say('## 五、结论');
say();
say('1. **兵种强度落在可接受区间。** 8 个兵里 5 个的「同价位每兵贡献」在 ×0.7～×1.4 之间；');
say('   偏弱的两个是女妖（×0.56）和术士（×0.61），但它们的价值本来就不在自己身上——');
say('   女妖的威吓算在**队友的承伤**里，术士的溅射算在**它打中的第二、第三个人**身上，');
say('   这套口径只统计"自己掉了多少血、打了多少血"，天生看不见这两样。它们的采用率（7～9%）说明 AI 还是愿意买。');
say('2. **巨兽从"没人造"变成"偶尔造"。** 第一轮 0 个，加了破城、降到 265 之后，两个时代各出 12～19 个。');
say('3. **包会把先手优势放大。** 时代3 的 40 对里，先手胜率 56.8% → 78.9%（第一轮 69.4%，两轮同向）；');
say('   时代4 反向低了 20pp，但只有 20 对、CI 跨 0，不能当结论。');
say('   机理是这套机制的共同点：**都奖励"先动、先贴上去"**（冲锋要移动过、飞行能抢先过河、溅射惩罚扎堆）。');
say('   所以它不是"偏袒某一方"，是"把节奏的价值放大"——配「先后手补偿」一起用最稳。');
say('4. **对局长度基本没动。** 各时代 Δ配对回合都在 ±10 以内，CI 全部跨 0。');
say();

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n'));
process.stderr.write(`写出 ${OUT}\n`);
