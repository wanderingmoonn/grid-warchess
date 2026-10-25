/**
 * 扩展规则扫描：每个扩展单独叠在「血战」上，看它对回合数与先后手的影响。
 *
 * 为什么是"血战 + 一个"：血战现在是默认开启的，玩家实际玩到的就是"默认 + 你多勾的"。
 * 所以对这 8 个扩展，基线必须是"只开血战"那一组（results17/dlc-on-era*.json），
 * 而不是"全关"。同一批种子（900 起 120 个）→ 同一张图，配对比较才有意义。
 *
 * 用法：
 *   node --experimental-strip-types scripts/exp-compare.ts \
 *     --base results17/dlc-on-era --dir results18 --eras 1,2 --out results18/exp-compare.md
 */

import fs from 'node:fs';
import path from 'node:path';

import { EXPANSIONS } from '../src/core/expansions.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const BASE = argOf('base', 'results17/dlc-on-era');
const DIR = argOf('dir', 'results18');
const ERAS = argOf('eras', '1,2')
  .split(',')
  .map((x) => Number(x.trim()))
  .filter((x) => x > 0);
const OUT = argOf('out', path.join(DIR, 'exp-compare.md'));
/** 不参与扫描的扩展（血战是基线，奇想兵种包按需求排除） */
const SKIP = new Set(argOf('skip', 'bloodbath,fantasy-units').split(','));

interface GameResult {
  seed: number;
  winner: 'A' | 'B' | null;
  turns: number;
}

interface Report {
  era: number;
  size: number;
  cap: number;
  summary: {
    aWins: number;
    bWins: number;
    draws: number;
    aRate: number;
    drawRate: number;
    turnsAvg: number;
    recruitsPerGame: number;
  };
  results: GameResult[];
}

const read = (p: string): Report => JSON.parse(fs.readFileSync(p, 'utf8')) as Report;
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sd = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((n, x) => n + (x - m) ** 2, 0) / (xs.length - 1));
};
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const ci95 = (xs: number[]): [number, number] => {
  const m = mean(xs);
  const se = sd(xs) / Math.sqrt(Math.max(1, xs.length));
  return [m - 1.96 * se, m + 1.96 * se];
};
const diffCi95 = (x1: number, n1: number, x2: number, n2: number): [number, number] => {
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  return [p1 - p2 - 1.96 * se, p1 - p2 + 1.96 * se];
};
const f1 = (x: number): string => (x > 0 ? `+${x.toFixed(1)}` : x.toFixed(1));
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

interface Row {
  id: string;
  name: string;
  n: number;
  dTurns: number;
  dTurnsCi: [number, number];
  shorter: number;
  longer: number;
  same: number;
  baseTurns: number;
  turns: number;
  baseDraw: number;
  draw: number;
  baseRate: number;
  rate: number;
  rateCi: [number, number];
  flipped: number;
  recruits: number;
  baseRecruits: number;
}

const lines: string[] = [];
const say = (s = ''): void => {
  console.log(s);
  lines.push(s);
};

const scanned = EXPANSIONS.filter((e) => !SKIP.has(e.id)).map((e) => e.name);
say(`# 扩展规则对回合数与先后手的影响（血战已默认开启）`);
say();
say(
  `方法：每组 = 「血战」+ 一个扩展，跟基线用同一批种子（${argOf('seed', '900')} 起），` +
    `所以同一局用的都是同一张图，差值就是这个扩展单独的贡献；回合上限两侧相同。` +
    `基线的口径是"只开血战"，也就是玩家不做任何额外勾选时的那一局。`,
);
say();
say(`扫描范围：${scanned.join('、')}（共 ${scanned.length} 个）。`);
say(`排除：「血战」本身是基线，不跟自己比；「奇想兵种包」按需求不在这次范围内。`);
say();

const rowsByEra = new Map<number, Row[]>();

for (const era of ERAS) {
  const base = read(`${BASE}${era}.json`);
  const bySeed = new Map(base.results.map((g) => [g.seed, g]));
  const rows: Row[] = [];

  for (const exp of EXPANSIONS) {
    if (SKIP.has(exp.id)) continue;
    const file = path.join(DIR, `exp-${exp.id}-era${era}.json`);
    if (!fs.existsSync(file)) continue;
    const r = read(file);

    const deltas: number[] = [];
    let shorter = 0;
    let longer = 0;
    let same = 0;
    let flipped = 0;
    for (const g of r.results) {
      const b = bySeed.get(g.seed);
      if (!b) continue;
      const d = g.turns - b.turns;
      deltas.push(d);
      if (d < 0) shorter += 1;
      else if (d > 0) longer += 1;
      else same += 1;
      if (g.winner !== b.winner) flipped += 1;
    }
    const decidedBase = Math.max(1, base.summary.aWins + base.summary.bWins);
    const decided = Math.max(1, r.summary.aWins + r.summary.bWins);
    rows.push({
      id: exp.id,
      name: exp.name,
      n: deltas.length,
      dTurns: mean(deltas),
      dTurnsCi: ci95(deltas),
      shorter,
      longer,
      same,
      baseTurns: base.summary.turnsAvg,
      turns: r.summary.turnsAvg,
      baseDraw: base.summary.drawRate,
      draw: r.summary.drawRate,
      baseRate: base.summary.aRate,
      rate: r.summary.aRate,
      rateCi: diffCi95(r.summary.aWins, decided, base.summary.aWins, decidedBase),
      flipped,
      recruits: r.summary.recruitsPerGame,
      baseRecruits: base.summary.recruitsPerGame,
    });
  }

  rows.sort((a, b) => a.dTurns - b.dTurns);
  rowsByEra.set(era, rows);

  const size = base.size;
  const n = base.results.length;
  say(`## 时代 ${era}（${size}×${size}，基线 ${n} 局，每组同种子配对 ${rows[0]?.n ?? 0} 局）`);
  say();
  say(
    `基线 = 只开「血战」：平均 ${base.summary.turnsAvg.toFixed(1)} 回合（中位 ${median(base.results.map((g) => g.turns)).toFixed(0)}）、` +
      `未决 ${pct(base.summary.drawRate)}、先手胜率 ${pct(base.summary.aRate)}。`,
  );
  say();
  say('| 叠加扩展 | 平均回合 | Δ回合（配对，95% CI） | 缩短/拉长/相同 | 未决率 | 先手胜率 | Δ胜率（95% CI） | 均招兵 |');
  say('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    say(
      `| ${r.name} | ${r.turns.toFixed(1)} | **${f1(r.dTurns)}**（${f1(r.dTurnsCi[0])} ~ ${f1(r.dTurnsCi[1])}） | ` +
        `${r.shorter}/${r.longer}/${r.same} | ${pct(r.baseDraw)} → ${pct(r.draw)} | ` +
        `${pct(r.baseRate)} → ${pct(r.rate)} | ${f1((r.rate - r.baseRate) * 100)} pp（${f1(r.rateCi[0] * 100)} ~ ${f1(r.rateCi[1] * 100)}） | ` +
        `${r.baseRecruits.toFixed(0)} → ${r.recruits.toFixed(0)} |`,
    );
  }
  say();
}

// 两个时代合并的排名：同一扩展在古典 + 中世的配对回合差取平均，
// 用来回答"这个扩展到底拖不拖时间"，而不是被某个时代的特例带偏。
if (ERAS.length > 1) {
  const ids = rowsByEra.get(ERAS[0]!)?.map((r) => r.id) ?? [];
  const pooled = ids
    .map((id) => {
      const parts = ERAS.map((e) => rowsByEra.get(e)?.find((r) => r.id === id)).filter(Boolean) as Row[];
      const d = mean(parts.map((p) => p.dTurns));
      const lo = mean(parts.map((p) => p.dTurnsCi[0]));
      const hi = mean(parts.map((p) => p.dTurnsCi[1]));
      return { id, name: parts[0]!.name, d, lo, hi, draws: parts.map((p) => p.draw), baseDraws: parts.map((p) => p.baseDraw) };
    })
    .sort((a, b) => a.d - b.d);

  say('## 两时代合并：谁在拖时间');
  say();
  say('| 扩展 | 古典 Δ回合 | 中世 Δ回合 | 平均 Δ | 未决率变化 |');
  say('| --- | --- | --- | --- | --- |');
  for (const p of pooled) {
    const per = ERAS.map((e) => rowsByEra.get(e)?.find((r) => r.id === p.id));
    say(
      `| ${p.name} | ${per[0] ? f1(per[0].dTurns) : '—'} | ${per[1] ? f1(per[1].dTurns) : '—'} | ` +
        `**${f1(p.d)}**（${f1(p.lo)} ~ ${f1(p.hi)}） | ` +
        `${ERAS.map((_, i) => `${pct(p.baseDraws[i]!)} → ${pct(p.draws[i]!)}`).join('；')} |`,
    );
  }
  say();
}

fs.writeFileSync(OUT, `${lines.join('\n')}\n`, 'utf8');
console.log(`已写出 ${OUT}`);
