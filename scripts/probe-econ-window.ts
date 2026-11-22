/**
 * 经济投资窗口探针（第五节第 1~2 步的验证）：`econUntil` 在小图/大图上到底是多少。
 *
 * 只读：不改任何决策，只把"求解器会建议投经济到第几回合"打出来，
 * 和实际局面（行军回合、收入、产能）并排看。
 *
 * 用法：
 *   npm run probe:econ-window                 # Q1（12×12）与 Q3（24×24）各一局
 *   npm run probe:econ-window -- --case Q1
 *   npm run probe:econ-window -- --every 5 --limit 60
 */
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction } from '../src/core/rules.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey } from '../src/core/ai.ts';
import { aiNextAction, decisiveViewGap } from '../src/core/ai-v3.ts';
import { powerInputOf } from '../src/core/ai-strength.ts';
import { solvePower } from '../src/core/power-solver.ts';
import { playerView } from '../src/core/fog.ts';
import type { GameState } from '../src/core/types.ts';

const argOf = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const EVERY = Math.max(1, Number(argOf('every', '4')));
const LIMIT = Number(argOf('limit', '40'));
const ONLY = argOf('case', '').toUpperCase();
/** `--econ-cap`：经济上限用"地块容量"（否则 econRoom 还被"每城 2 个"卡着） */
const ECON_CAP = process.argv.includes('--econ-cap');
/** `--horizon-mode fixed|march`：窗口取固定值还是"主力到敌城的回合数" */
const MODE = argOf('horizon-mode', 'march');
const FIXED = Number(argOf('horizon', '10'));

interface Case {
  id: string;
  size: number;
  era: number;
  cap: number;
  seed: number;
}
const CASES: Case[] = [
  { id: 'Q1', size: 12, era: 2, cap: 200, seed: 30 },
  { id: 'Q3', size: 24, era: 2, cap: 260, seed: 30 },
];

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function run(c: Case): void {
  let s: GameState = createMatch(
    {
      ...DEFAULT_CONFIG,
      startEra: c.era,
      aiLevel: 'tactic',
      size: c.size,
      mapSymmetry: 'fair',
      ...(ECON_CAP ? { aiEconCap: true } : {}),
    },
    c.seed,
  );
  console.log(`\n${c.id} ${c.size}×${c.size}/era${c.era} seed=${c.seed}（窗口=${MODE === 'march' ? '行军回合' : FIXED}）`);
  console.log('| 回合 | 行军 | 窗口 | econUntil | 建议经济数 | 建议兵数 | 收入 | 产能 |');
  console.log('|---|---|---|---|---|---|---|---|');
  let lastTurn = -1;
  while (!s.winner && s.turn <= c.cap) {
    if (s.turn % EVERY === 0 && s.turn !== lastTurn) {
      lastTurn = s.turn;
      const me = s.current;
      const view = playerView(s, me).state;
      const gap = decisiveViewGap(s, me);
      const march = gap?.fogged.marchTurns ?? 0;
      const horizon = MODE === 'march' ? clamp(march, 2, 20) : FIXED;
      const input = powerInputOf(view, me);
      const plan = solvePower(input, horizon);
      console.log(
        `| T${String(s.turn).padStart(3)} | ${march} | ${horizon} | **${plan.econUntil}** | ` +
          `${plan.econ} | ${plan.units} | ${Math.round(input.income)} | ${input.slots} |`,
      );
    }
    if (s.turn > LIMIT) break;
    const budget = { ...DEFAULT_BUDGET };
    const rejected = new Set<string>();
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
      const a = aiNextAction(s, budget, rejected);
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
}

for (const c of CASES.filter((x) => !ONLY || x.id === ONLY)) run(c);
