/**
 * 先后手配平方案对比：同种子、同尺寸、同一批 60 局，逐臂跟"什么都不做"比。
 *
 * 现在比的是四臂：
 *   ① 基线（不补）
 *   ② 后手开局 +5% 起始金
 *   ③ 后手开局 +20% 起始金（敏感性，用来看"给钱"这个杠杆的斜率）
 *   ④ 先手第一回合不结算收入（结构性的做法：不削人、只削那笔白拿的钱）
 *
 * 为什么要同种子：图不一样的话，先手胜率的方差比这几条规则的效应大一个量级，
 * 60 局根本看不出来。同种子配对之后，每局的差异才能归到规则上。
 *
 * 用法：
 *   node --experimental-strip-types scripts/bonus-compare.ts --dir results19 --eras 1,2
 */

import fs from 'node:fs';
import path from 'node:path';

import { startGoldFor } from '../src/core/setup.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const DIR = argOf('dir', 'results19');
const ERAS = argOf('eras', '1,2')
  .split(',')
  .map((x) => Number(x.trim()))
  .filter((x) => x > 0);
const OUT = argOf('out', path.join(DIR, 'bonus-compare.md'));

/**
 * 一个实验臂。`ratio` 是"后手额外拿起始金的几成"（负数/null 表示不是加钱那一类），
 * 只用来在表里写出"这一臂到底动了多少钱"。
 */
interface Arm {
  prefix: string;
  label: string;
  ratio?: number;
  note?: string;
}

/**
 * 臂可以从命令行给：`--arms "prefix:标签:比例,prefix:标签:比例"`。
 * 不给就用 results19 那四臂（12×12 的那批）。
 * 换个尺寸/时代重跑时，直接把前缀和比例写在命令行里，不用改代码。
 */
const DEFAULT_ARMS: Arm[] = [
  { prefix: 'bonus0-era', label: '不补（基线）' },
  { prefix: 'bonus5-era', label: '后手 +5% 起始金', ratio: 0.05 },
  { prefix: 'bonus20-era', label: '后手 +20% 起始金', ratio: 0.2 },
  { prefix: 'noincome-era', label: '先手首回合不结算收入', note: '先手少 1 笔收入' },
];

const ARMS: Arm[] = (() => {
  const spec = argOf('arms', '');
  if (!spec) return DEFAULT_ARMS;
  return spec.split(',').map((part) => {
    const [prefix, label, ratio] = part.split(':');
    if (!prefix || !label) throw new Error(`--arms 格式错了：${part}`);
    const r = ratio === undefined ? undefined : Number(ratio);
    return { prefix, label, ratio: Number.isFinite(r) ? r : undefined };
  });
})();

const moneyOf = (arm: Arm, era: number): string => {
  if (arm.note) return arm.note;
  if (arm.ratio === undefined) return '—';
  if (arm.ratio === 0) return '—';
  return `+${Math.round(startGoldFor(era) * arm.ratio)} 金`;
};

interface GameResult {
  seed: number;
  winner: 'A' | 'B' | 'draw' | null;
  turns: number;
}

interface Report {
  era: number;
  size: number;
  summary: {
    aWins: number;
    bWins: number;
    draws: number;
    unresolved?: number;
    aRate: number;
    drawRate: number;
    turnsAvg: number;
    recruitsPerGame: number;
  };
  results: GameResult[];
}

const read = (p: string): Report | null =>
  fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as Report) : null;

const diffCi95 = (x1: number, n1: number, x2: number, n2: number): [number, number] => {
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  return [p1 - p2 - 1.96 * se, p1 - p2 + 1.96 * se];
};
/** 配对 t 临界值（双侧 95%）。只列了跑批常用的几档，落到哪档就用哪档，够用了。 */
const tCrit = (df: number): number => {
  const T: Record<number, number> = {
    9: 2.262,
    19: 2.093,
    29: 2.045,
    39: 2.023,
    49: 2.01,
    59: 2.001,
    79: 1.99,
    99: 1.984,
    119: 1.98,
  };
  let best = 1.98;
  for (const k of Object.keys(T).map(Number).sort((a, b) => a - b)) {
    if (df >= k) best = T[k] as number;
  }
  return best;
};

/**
 * 同种子逐局相减的回合差。均值看着差不多时，配对的方差比独立样本小一个量级，
 * 才看得出"这一臂到底让局变短了还是变长了"。
 */
const pairedTurns = (
  arm: Report,
  base: Report,
): { mean: number; lo: number; hi: number; shorter: number; longer: number; same: number } => {
  const bySeed = new Map(base.results.map((g) => [g.seed, g]));
  const ds: number[] = [];
  for (const g of arm.results) {
    const b = bySeed.get(g.seed);
    if (b) ds.push(g.turns - b.turns);
  }
  const n = ds.length;
  if (n < 2) return { mean: 0, lo: 0, hi: 0, shorter: 0, longer: 0, same: 0 };
  const mean = ds.reduce((p, c) => p + c, 0) / n;
  const sd = Math.sqrt(ds.reduce((p, c) => p + (c - mean) ** 2, 0) / (n - 1));
  const half = tCrit(n - 1) * (sd / Math.sqrt(n));
  return {
    mean,
    lo: mean - half,
    hi: mean + half,
    shorter: ds.filter((x) => x < 0).length,
    longer: ds.filter((x) => x > 0).length,
    same: ds.filter((x) => x === 0).length,
  };
};

const f1 = (x: number): string => (x > 0 ? `+${x.toFixed(1)}` : x.toFixed(1));
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/**
 * 先手胜率统一按"分出胜负的局"算：`aWins / (aWins + bWins)`。
 *
 * 之前用的是 payload 里的 `aRate`（= aWins / 总局数，未决算进分母），
 * 却又拿"分出胜负的局"去算置信区间，两头分母不一样。
 * 未决少的时候（12×12 那批基本是 0）看不出来，一旦未决到 10~15%，
 * 点估计和 CI 就对不上账了——所以这里自己算，别信 payload 的比率。
 */
const aShare = (s: Report['summary']): number => {
  const decided = s.aWins + s.bWins;
  return decided > 0 ? s.aWins / decided : 0;
};

const lines: string[] = [];
const say = (s = ''): void => {
  console.log(s);
  lines.push(s);
};

const probe = read(path.join(DIR, `${ARMS[0]!.prefix}${ERAS[0]}.json`));
const size = probe?.size ?? 12;

say(`# 先后手配平方案对比`);
say();
say(
  `统一口径：同种子配对（900 起 60 局）、**${size}×${size}**、双方高级 AI、默认只开血战。` +
    `起始金币：${[1, 2, 3, 4, 5].map((e) => `时代${e} ${startGoldFor(e)}`).join('、')}。`,
);
say();
say(`先手胜率只算分出胜负的局；Δ胜率 = 这一臂 − 基线，负值表示更平衡。`);
say();

for (const era of ERAS) {
  const base = read(path.join(DIR, `${ARMS[0]!.prefix}${era}.json`));
  if (!base) continue;
  const bySeed = new Map(base.results.map((g) => [g.seed, g]));
  const baseDecided = Math.max(1, base.summary.aWins + base.summary.bWins);

  say(`## 时代 ${era}（${base.size}×${base.size}，每组 ${base.results.length} 局）`);
  say();
  say('| 方案 | 动的钱 | 先手胜/后手胜/平局或未决 | 先手胜率 | Δ胜率（95% CI） | 均回合 | 均招兵 | 胜负被改写 |');
  say('| --- | --- | --- | --- | --- | --- | --- | --- |');

  for (const arm of ARMS) {
    const r = read(path.join(DIR, `${arm.prefix}${era}.json`));
    if (!r) continue;
    const decided = Math.max(1, r.summary.aWins + r.summary.bWins);
    const [lo, hi] = diffCi95(r.summary.aWins, decided, base.summary.aWins, baseDecided);
    let flipped = 0;
    for (const g of r.results) {
      const b = bySeed.get(g.seed);
      if (b && b.winner !== g.winner) flipped += 1;
    }
    const isBase = arm.prefix === ARMS[0]!.prefix;
    const share = aShare(r.summary);
    const baseShare = aShare(base.summary);
    say(
      `| ${arm.label} | ${moneyOf(arm, era)} | ${r.summary.aWins} / ${r.summary.bWins} / ${r.summary.draws + (r.summary.unresolved ?? 0)} | ` +
        `${pct(share)} | ${isBase ? '—' : `${f1((share - baseShare) * 100)} pp（${f1(lo * 100)} ~ ${f1(hi * 100)}）`} | ` +
        `${r.summary.turnsAvg.toFixed(1)} | ${r.summary.recruitsPerGame.toFixed(0)} | ${isBase ? '—' : flipped} |`,
    );
  }
  say();

  const arms = ARMS.slice(1)
    .map((arm) => ({ arm, r: read(path.join(DIR, `${arm.prefix}${era}.json`)) }))
    .filter((x): x is { arm: Arm; r: Report } => x.r !== null);
  if (arms.length > 0) {
    say('配对回合差（同种子逐局相减，负值 = 这一臂把局打短了）：');
    say();
    say('| 方案 | Δ回合均值（95% CI） | 缩短/拉长/持平 |');
    say('| --- | --- | --- |');
    for (const { arm, r } of arms) {
      const t = pairedTurns(r, base);
      say(
        `| ${arm.label} | ${f1(t.mean)}（${f1(t.lo)} ~ ${f1(t.hi)}） | ${t.shorter} / ${t.longer} / ${t.same} |`,
      );
    }
    say();
  }
}

say('---');
say();
say('读法：Δ胜率 CI 跨 0，就是"这批局看不出差别"；Δ回合同理。');
say(
  '但"胜负被改写"要单独看：几十局里一大半赢家被换掉，并不说明规则效应大，' +
    '恰恰说明这类对称图的对局在刀尖上——一家多几十块钱就能把局面推翻。' +
    '所以 60 局的点估计只能当方向看，要定参数得再换一批种子复现。',
);
say();

fs.writeFileSync(OUT, `${lines.join('\n')}\n`, 'utf8');
console.log(`已写出 ${OUT}`);
