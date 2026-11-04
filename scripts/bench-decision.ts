/** 单次决策耗时：深推参数一改，这个数最容易失控 */
import { applyAction } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction, aiTrace } from '../src/core/ai.ts';
import type { GameState } from '../src/core/types.ts';

let s: GameState = createMatch({ ...DEFAULT_CONFIG, size: 16, startEra: 3, aiOpponent: true, aiAlly: true, aiLevel: 'advanced' }, 900);
for (let turn = 0; turn < 20 && !s.winner; turn += 1) {
  for (let i = 0; i < AI_MAX_STEPS; i += 1) {
    const a = aiNextAction(s, { ...DEFAULT_BUDGET });
    if (!a) break;
    const r = applyAction(s, a);
    if (!r.ok) break;
    s = r.state;
  }
  const e = applyAction(s, { type: 'END_TURN' });
  if (!e.ok) break;
  s = e.state;
}
aiTrace.reset();
aiTrace.on = true;
const N = 20;
const t0 = Date.now();
for (let i = 0; i < N; i += 1) aiNextAction(s, { ...DEFAULT_BUDGET });
const dt = (Date.now() - t0) / N;
console.log(`单次决策平均 ${dt.toFixed(0)} ms（${N} 次）· 其中进计划 ${aiTrace.planRuns} 次`);
