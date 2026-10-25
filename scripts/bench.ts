/**
 * 平衡基准跑分。
 *
 * 跑标准对局组合（古典 12×12 / 中世 16×16 / 火药 20×20 / 工业 20×20 / 现代 20×20），
 * 每个组合若干种子，双 AI 对打，统计：
 *   · 结束回合数（没打完就记上限）
 *   · 场上最高时代（城市时代的最大值）
 *   · 攻城次数、招兵数
 *
 * 这些数字是调数值的唯一依据：只看"感觉"调平衡，最后一定调成自己爱玩的那一版。
 *
 * 运行：npm run bench   （BENCH_SEEDS=10 可以多跑几轮）
 */

import { AI_MAX_STEPS, aiNextAction } from '../src/core/ai.ts';
import { UNIT_TYPES } from '../src/core/config.ts';
import { applyAction, citiesOf, unitsOf } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const SEEDS = Number(process.env.BENCH_SEEDS ?? 6);
const CAP = Number(process.env.BENCH_CAP ?? 180);
/** BENCH_ERA 支持单个数字或逗号分隔的多个时代，例如 BENCH_ERA=1,2,3 */
const ONLY = process.env.BENCH_ERA ? process.env.BENCH_ERA.split(',').map(Number) : null;
/** BENCH_SIZE 给定时，强制所有组合用同一个棋盘尺寸，方便只对比起始时代这一个变量 */
const SIZE = Number(process.env.BENCH_SIZE ?? 0);

interface Combo {
  era: number;
  size: number;
  name: string;
}

const COMBOS: Combo[] = [
  { era: 1, size: 12, name: '古典' },
  { era: 2, size: 16, name: '中世' },
  { era: 3, size: 20, name: '火药' },
  { era: 4, size: 20, name: '工业' },
  { era: 5, size: 20, name: '现代' },
]
  .filter((c) => ONLY === null || ONLY.includes(c.era))
  .map((c) => {
    const size = SIZE > 0 ? SIZE : c.size;
    return { era: c.era, size, name: `${c.name} ${size}×${size}` };
  });

interface Result {
  turns: number;
  decided: boolean;
  winner: PlayerId | null;
  maxEra: number;
  sieges: number;
  attacks: number;
  recruits: number;
}

function playOne(combo: Combo, seed: number): Result {
  let s: GameState = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: combo.size,
      startEra: combo.era,
      aiOpponent: true,
      aiAlly: true,
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    seed,
  );

  const budget = { maxRecruit: 2, maxUpgrade: 1, recruited: 0, upgraded: 0 };
  let turns = 0;
  let sieges = 0;
  let attacks = 0;
  let recruits = 0;

  for (let t = 0; t < CAP; t++) {
    budget.recruited = 0;
    budget.upgraded = 0;
    turns += 1;

    for (let step = 0; step < AI_MAX_STEPS * 2; step++) {
      const a = aiNextAction(s, budget);
      if (!a) break;
      if (a.type === 'SIEGE') sieges += 1;
      if (a.type === 'ATTACK') attacks += 1;
      if (a.type === 'RECRUIT') {
        recruits += 1;
        budget.recruited += 1;
      }
      if (a.type === 'UPGRADE') budget.upgraded += 1;
      const r = applyAction(s, a);
      if (!r.ok) break;
      s = r.state;
    }

    if (s.winner) break;
    const end = applyAction(s, { type: 'END_TURN' });
    if (!end.ok) break;
    s = end.state;
    if (s.winner) break;
  }

  const maxEra = Math.max(...s.cities.map((c) => c.era), 0);
  return {
    turns,
    decided: !!s.winner,
    winner: s.winner,
    maxEra,
    sieges,
    attacks,
    recruits,
  };
}

const avg = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

console.log(`每个组合 ${SEEDS} 个种子，回合上限 ${CAP}\n`);
console.log('组合            完成  平均回合  中位  最高时代  攻城/局  交战/局  招兵/局  胜方');

const rows: Array<{ name: string; r: Result[] }> = [];
for (const combo of COMBOS) {
  const results: Result[] = [];
  for (let i = 0; i < SEEDS; i++) {
    results.push(playOne(combo, 20260000 + i * 7919 + combo.size * 31 + combo.era));
  }
  rows.push({ name: combo.name, r: results });

  const decided = results.filter((x) => x.decided);
  const turns = results.map((x) => x.turns);
  const sorted = [...turns].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const wins = decided.reduce<Record<string, number>>((acc, x) => {
    const k = x.winner ?? '未分';
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  console.log(
    `${combo.name.padEnd(14)} ${String(decided.length).padStart(2)}/${SEEDS}` +
      `  ${avg(turns).toFixed(0).padStart(7)}  ${String(median).padStart(4)}` +
      `  ${avg(results.map((x) => x.maxEra)).toFixed(1).padStart(6)}` +
      `  ${avg(results.map((x) => x.sieges)).toFixed(1).padStart(6)}` +
      `  ${avg(results.map((x) => x.attacks)).toFixed(0).padStart(6)}` +
      `  ${avg(results.map((x) => x.recruits)).toFixed(0).padStart(6)}` +
      `  ${Object.entries(wins)
        .map(([k, v]) => `${k}:${v}`)
        .join(' ')}`,
  );
}

// 每个组合的详情，方便对照是哪个种子卡住了（种子多了就不逐条打，只报分布）
if (SEEDS <= 20) {
  console.log('\n明细（回合 / 最高时代 / 攻城 / 交战）');
  for (const { name, r } of rows) {
    const text = r
      .map((x) => `${x.turns}/${x.maxEra}/${x.sieges}/${x.attacks}${x.decided ? '' : '*'}`)
      .join('  ');
    console.log(`  ${name.padEnd(14)} ${text}   (* = 上限内未分胜负)`);
  }
} else {
  console.log('\n分布（最高时代出现次数 / 未分胜负局数）');
  for (const { name, r } of rows) {
    const byEra = new Map<number, number>();
    let unresolved = 0;
    for (const x of r) {
      byEra.set(x.maxEra, (byEra.get(x.maxEra) ?? 0) + 1);
      if (!x.decided) unresolved += 1;
    }
    const eraText = [...byEra.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([e, n]) => `E${e}:${n}`)
      .join('  ');
    console.log(`  ${name.padEnd(14)} ${eraText}   未分胜负:${unresolved}`);
  }
}

void citiesOf;
void unitsOf;
