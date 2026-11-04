/** 三回合计划的行为探针：跑了几次、翻盘几次、一局多花多少时间 */
import { applyAction } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction, aiTrace } from '../src/core/ai.ts';
import type { GameState } from '../src/core/types.ts';

const GAMES = Number(process.argv[2] ?? 6);
let runs = 0, flips = 0, steps = 0, ms = 0;
for (let g = 0; g < GAMES; g += 1) {
  aiTrace.reset();
  aiTrace.on = true;
  let s: GameState = createMatch({ ...DEFAULT_CONFIG, size: 16, startEra: 3, aiOpponent: true, aiAlly: true, aiLevel: 'advanced' }, 900 + g);
  const t0 = Date.now();
  let n = 0;
  while (!s.winner && s.turn <= 120) {
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i += 1) {
      const a = aiNextAction(s, { ...DEFAULT_BUDGET });
      if (!a) break;
      n += 1;
      const r = applyAction(s, a);
      if (!r.ok) break;
      s = r.state;
    }
    if (s.winner) break;
    const e = applyAction(s, { type: 'END_TURN' });
    if (!e.ok) break;
    s = e.state;
  }
  const dt = Date.now() - t0;
  runs += aiTrace.planRuns; flips += aiTrace.planFlip; steps += n; ms += dt;
  console.log(
    `第 ${g + 1} 局：${n} 次决策 · 计划跑 ${aiTrace.planRuns} 次 · 翻盘 ${aiTrace.planFlip} 次`
      + ` · ${(dt / 1000).toFixed(1)}s${s.winner ? '' : '（未决）'}`,
  );
}
console.log('');
console.log(`合计 ${GAMES} 局：决策 ${steps} 次 · 计划 ${runs} 次（${(runs / steps * 100).toFixed(1)}%）`
  + ` · 翻盘 ${flips} 次（占计划 ${(flips / Math.max(1, runs) * 100).toFixed(0)}%）· 总 ${(ms / 1000).toFixed(0)}s`);
