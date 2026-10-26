/**
 * 两组对局的同种子对比：这份是给「哀兵必胜」用的，但逻辑是通用的。
 *
 * 关心三件事：
 *   1. 整体胜率与局长有没有动（规则不该把对局节奏改坏）；
 *   2. **首城攻方胜率**——哀兵必胜直接作用在这上面，它掉了才说明规则有效；
 *   3. 逐种子配对，避免"整体持平"掩盖掉两个方向的互相抵消。
 *
 * 用法：
 *   node --experimental-strip-types scripts/laststand-compare.ts \
 *     --a results29/base.json --b results29/laststand.json --an 不开 --bn 开
 */

import fs from 'node:fs';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const A_PATH = argOf('a', 'results29/base.json');
const B_PATH = argOf('b', 'results29/laststand.json');
const A_NAME = argOf('an', '不开');
const B_NAME = argOf('bn', '开');
const OUT = argOf('out', '');

interface GameResult {
  seed: number;
  winner: string | null;
  turns: number;
  firstCap: { turn: number; by: string; city: string; retakeTurn: number | null } | null;
  citiesA: number;
  citiesB: number;
}

interface Report {
  era: number;
  size: number;
  results: GameResult[];
}

const load = (p: string): Report => JSON.parse(fs.readFileSync(p, 'utf8')) as Report;
const A = load(A_PATH);
const B = load(B_PATH);

const mean = (xs: number[]): number => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 0);
const pct = (x: number, n: number): string => (n > 0 ? `${((x / n) * 100).toFixed(1)}%` : '—');

/** 首城攻方最终有没有赢 */
const capWinner = (g: GameResult): boolean | null => {
  if (!g.firstCap) return null;
  if (!g.winner) return null;
  return g.winner === g.firstCap.by;
};

const lines: string[] = [];
const say = (s = ''): void => {
  console.log(s);
  lines.push(s);
};

const statOf = (rs: GameResult[]): {
  n: number;
  aWin: number;
  capWin: number;
  capN: number;
  turns: number;
  gap: number;
  capped: number;
} => {
  const capped = rs.filter((g) => capWinner(g) !== null);
  return {
    n: rs.length,
    aWin: rs.filter((g) => g.winner === 'A').length,
    capWin: capped.filter((g) => capWinner(g) === true).length,
    capN: capped.length,
    turns: mean(rs.map((g) => g.turns)),
    gap: mean(rs.map((g) => Math.abs(g.citiesA - g.citiesB))),
    capped: rs.filter((g) => g.firstCap).length,
  };
};

const sa = statOf(A.results);
const sb = statOf(B.results);

say(`# ${A_NAME} vs ${B_NAME}：同种子对比`);
say();
say(`口径：时代 ${A.era}、${A.size}×${A.size}、各 ${A.results.length} 局，种子对得上，逐局配对。`);
say();
say(`| 指标 | ${A_NAME} | ${B_NAME} | 差值 |`);
say('|---|---:|---:|---:|');
say(
  `| A 方胜率 | ${pct(sa.aWin, sa.n)} | ${pct(sb.aWin, sb.n)} | ` +
    `${((sb.aWin / sb.n - sa.aWin / sa.n) * 100).toFixed(1)}pp |`,
);
say(
  `| **首城攻方胜率** | **${pct(sa.capWin, sa.capN)}** | **${pct(sb.capWin, sb.capN)}** | ` +
    `**${((sb.capWin / sb.capN - sa.capWin / sa.capN) * 100).toFixed(1)}pp** |`,
);
say(`| 有首城的局 | ${sa.capN} | ${sb.capN} | — |`);
say(`| 平均局长（回合） | ${sa.turns.toFixed(1)} | ${sb.turns.toFixed(1)} | ${(sb.turns - sa.turns).toFixed(1)} |`);
say(`| 终局城数差（绝对值） | ${sa.gap.toFixed(2)} | ${sb.gap.toFixed(2)} | ${(sb.gap - sa.gap).toFixed(2)} |`);
say();

// 逐种子配对：只统计两边都有首城的种子
const mapA = new Map(A.results.map((g) => [g.seed, g]));
let paired = 0;
let waTrue = 0; // A 组里首城攻方赢的局数
let wbTrue = 0; // B 组里首城攻方赢的局数
let flipped = 0; // 首城攻方从"赢"变成"输"
let backFlip = 0; // 从"输"变成"赢"
let same = 0;
for (const gb of B.results) {
  const ga = mapA.get(gb.seed);
  if (!ga) continue;
  const wa = capWinner(ga);
  const wb = capWinner(gb);
  if (wa === null || wb === null) continue;
  paired += 1;
  if (wa) waTrue += 1;
  if (wb) wbTrue += 1;
  if (wa === wb) same += 1;
  else if (wa) flipped += 1;
  else backFlip += 1;
}
say(`逐种子配对（两边都打出首城且分出胜负的 ${paired} 局）：`);
say();
say(`- 结局没变：${same} 局；首城攻方**从赢变输 ${flipped} 局**、从输变赢 ${backFlip} 局（净 ${flipped - backFlip}）`);
say(
  `- **丢了首城的一方，翻盘率 ${pct(paired - waTrue, paired)} → ${pct(paired - wbTrue, paired)}**` +
    `（${((wbTrue - waTrue) / paired * 100).toFixed(1)}pp，${paired} 局配对）`,
);
say();

if (OUT) {
  fs.mkdirSync(OUT.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  fs.writeFileSync(OUT, lines.join('\n'));
  process.stderr.write(`写出 ${OUT}\n`);
}
