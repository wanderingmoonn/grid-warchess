import { AI_MAX_STEPS, aiNextAction } from './src/core/ai.ts';
import { applyAction } from './src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from './src/core/setup.ts';
import type { GameState } from './src/core/types.ts';

let caps = 0, wins = 0, sealedRuins = 0;
for (let k = 1; k <= 4; k++) {
  const s0: GameState = createMatch({ ...DEFAULT_CONFIG, size: 20, aiOpponent: true, aiAlly: true }, k * 313 + 7);
  const owner0 = new Map(s0.cities.map((c) => [c.id, c.owner]));
  let s = s0;
  const budget = { maxRecruit: 2, maxUpgrade: 1, recruited: 0, upgraded: 0 };
  for (let t = 0; t < 100 && !s.winner; t++) {
    budget.recruited = 0; budget.upgraded = 0;
    for (let i = 0; i < AI_MAX_STEPS; i++) {
      const a = aiNextAction(s, budget);
      if (!a) break;
      const r = applyAction(s, a);
      if (!r.ok) break;
      s = r.state;
      if (a.type === 'RECRUIT') budget.recruited++;
      if (a.type === 'UPGRADE') budget.upgraded++;
    }
    const end = applyAction(s, { type: 'END_TURN' });
    if (!end.ok) break;
    s = end.state;
  }
  const changed = s.cities.filter((c) => owner0.get(c.id) !== c.owner).length;
  caps += changed;
  sealedRuins += s.cities.filter((c) => c.ruined).length;
  if (s.winner) wins++;
  console.log(`seed${k}: 易主 ${changed}，仍废墟 ${s.cities.filter((c) => c.ruined).length}，胜负 ${s.winner ?? '未决'}，回合 ${s.turn}`);
}
console.log(`20x20 100回合：易主 ${caps}，剩废墟 ${sealedRuins}，胜负 ${wins}/4`);
