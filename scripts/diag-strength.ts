/**
 * 战力估值的校准（S4）：它算出来的比值，和实际胜负对不对得上。
 *
 * 只做一件事：跑到第 T 回合时记下双方的战力比，再看最后谁赢——
 * "比值高的那方赢"的比例，就是这套估值的命中率。
 *
 * 为什么要这个数：估值本身不改变 AI 行为（只算不用），所以不能用胜率验它。
 * 唯一能验的是"它说的和实际发生的像不像"。
 *
 * 用法：
 *   node --experimental-strip-types scripts/diag-strength.ts --games 10 --era 2 --size 24
 *   ... --turn 40     在第 40 回合取样（默认 40）
 *   ... --new ../src/core/ai-v3.ts   用 v3 跑（默认 v1）
 */
import { applyAction } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey, aiNextAction as v1 } from '../src/core/ai.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';
import { armyStrength, powerPerTurn, projectedStrength, strengthRatio } from '../src/core/ai-strength.ts';

const args = process.argv.slice(2);
const argOf = (n: string, d: string): string => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : d;
};
const GAMES = Number(argOf('games', '10'));
const ERA = Number(argOf('era', '2'));
const SIZE = Number(argOf('size', '24'));
const SAMPLE_TURN = Number(argOf('turn', '40'));
const CAP = Number(argOf('cap', '260'));
const SEED0 = Number(argOf('seed', '20'));
const NEW_FILE = argOf('new', '');
/** 投影往前看几回合 */
const PROJ_TURNS = Number(argOf('proj', '40'));

const ai = NEW_FILE
  ? ((await import(NEW_FILE)) as { aiNextAction: typeof v1 }).aiNextAction
  : v1;

type Row = {
  seed: number;
  ratioA: number;
  ratioB: number;
  powerA: number;
  powerB: number;
  winner: PlayerId | null;
  turns: number;
};

let hit = 0;
let hitProj = 0;
let decided = 0;
const rows: Row[] = [];

for (let g = 0; g < GAMES; g += 1) {
  const seed = SEED0 + g;
  let s: GameState = createMatch(
    { ...DEFAULT_CONFIG, startEra: ERA, aiLevel: 'tactic', size: SIZE },
    seed,
  );
  let sample: {
    ratioA: number; ratioB: number; powerA: number; powerB: number;
    projA: number; projB: number; perTurnA: number; perTurnB: number;
  } | null = null;

  while (!s.winner && s.turn <= CAP) {
    if (sample === null && s.turn >= SAMPLE_TURN) {
      sample = {
        ratioA: strengthRatio(s, 'A'),
        ratioB: strengthRatio(s, 'B'),
        powerA: armyStrength(s, 'A'),
        powerB: armyStrength(s, 'B'),
        projA: projectedStrength(s, 'A', PROJ_TURNS),
        projB: projectedStrength(s, 'B', PROJ_TURNS),
        perTurnA: powerPerTurn(s, 'A'),
        perTurnB: powerPerTurn(s, 'B'),
      };
    }
    const budget = { ...DEFAULT_BUDGET };
    const rejected = new Set<string>();
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i += 1) {
      const a = ai(s, budget, rejected);
      if (!a) break;
      const r = applyAction(s, a);
      if (!r.ok) {
        rejected.add(aiActionKey(a));
        continue;
      }
      rejected.clear();
      s = r.state;
      if (a.type === 'RECRUIT') budget.recruited += 1;
      if (a.type === 'UPGRADE') budget.upgraded += 1;
    }
    if (s.winner) break;
    const r = applyAction(s, { type: 'END_TURN' });
    if (!r.ok) break;
    s = r.state;
  }

  const snap = sample ?? {
    ratioA: strengthRatio(s, 'A'),
    ratioB: strengthRatio(s, 'B'),
    powerA: armyStrength(s, 'A'),
    powerB: armyStrength(s, 'B'),
    projA: projectedStrength(s, 'A', PROJ_TURNS),
    projB: projectedStrength(s, 'B', PROJ_TURNS),
    perTurnA: powerPerTurn(s, 'A'),
    perTurnB: powerPerTurn(s, 'B'),
  };
  const predicted: PlayerId = snap.ratioA >= snap.ratioB ? 'A' : 'B';
  const predictedProj: PlayerId = snap.projA >= snap.projB ? 'A' : 'B';
  const winner = s.winner ?? null;
  if (winner) {
    decided += 1;
    if (winner === predicted) hit += 1;
    if (winner === predictedProj) hitProj += 1;
  }
  rows.push({ seed, ...snap, winner, turns: s.turn });
  console.log(
    `seed=${seed} t${SAMPLE_TURN}: 战力 A=${snap.powerA.toFixed(0)} B=${snap.powerB.toFixed(0)}` +
      ` → 比 A=${snap.ratioA.toFixed(2)}/B=${snap.ratioB.toFixed(2)} 预测 ${predicted}` +
      ` | 投影 A=${snap.projA.toFixed(0)} B=${snap.projB.toFixed(0)}（每回合 ${snap.perTurnA.toFixed(0)}/${snap.perTurnB.toFixed(0)}）预测 ${predictedProj}` +
      ` | 实际 ${winner ?? '平'} @${s.turn} 回合 现状${winner ? (winner === predicted ? '✓' : '✗') : '—'} 投影${winner ? (winner === predictedProj ? '✓' : '✗') : '—'}`,
  );
}

console.log('');
const avg = (list: number[]): number => (list.length === 0 ? 0 : list.reduce((a, b) => a + b, 0) / list.length);
console.log(
  `${GAMES} 局：分胜负 ${decided}，现状命中 ${hit}（${decided ? ((hit / decided) * 100).toFixed(0) : 0}%）` +
    `，投影命中 ${hitProj}（${decided ? ((hitProj / decided) * 100).toFixed(0) : 0}%）` +
    ` | 均回合 ${avg(rows.map((r) => r.turns)).toFixed(0)}`,
);
console.log(
  `第 ${SAMPLE_TURN} 回合的平均战力：A=${avg(rows.map((r) => r.powerA)).toFixed(0)} B=${avg(rows.map((r) => r.powerB)).toFixed(0)}`,
);
