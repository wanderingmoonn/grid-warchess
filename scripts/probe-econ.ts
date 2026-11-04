/**
 * 采购 / 升级 / 接战的行为指标（AI 自对弈，同一批种子）。
 *
 * 为什么要有它：胜负在 60 局上的噪声是 ±13 点，而"战斗兵均价 100→130""每局升级 2→5 次"
 * 这类指标一局就能看出来。改 AI 的经济行为时，先用它判断机制有没有真的生效，
 * 再去看胜率——否则分不清"没效果"和"没触发"。
 *
 * 用法：
 *   node --experimental-strip-types scripts/probe-econ.ts [games] [era] [size]
 */

import { applyAction, unitsOf, utype } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction } from '../src/core/ai.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const GAMES = Number(process.argv[2] ?? 8);
const ERA = Number(process.argv[3] ?? 3);
const SIZE = Number(process.argv[4] ?? 20);
const SEED = 900;

interface Side {
  recruits: number;
  combatCost: number;
  combatCount: number;
  upgrades: number;
  goldSamples: number;
  turns: number;
  attacks: number;
  moves: number;
  deaths: number;
  valueLost: number;
}

const blank = (): Side => ({
  recruits: 0,
  combatCost: 0,
  combatCount: 0,
  upgrades: 0,
  goldSamples: 0,
  turns: 0,
  attacks: 0,
  moves: 0,
  deaths: 0,
  valueLost: 0,
});

function playOne(seed: number): Record<PlayerId, Side> {
  let s: GameState = createMatch(
    { ...DEFAULT_CONFIG, startEra: ERA, size: SIZE, aiLevel: 'advanced', aiAlly: true, aiOpponent: true },
    seed,
  );
  const out: Record<PlayerId, Side> = { A: blank(), B: blank(), C: blank(), D: blank() };
  while (!s.winner && s.turn <= 200) {
    const me = s.current;
    out[me].turns += 1;
    out[me].goldSamples += s.players[me].gold;
    const foe = me === 'A' ? 'B' : 'A';
    const budget = { ...DEFAULT_BUDGET };
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
      const a = aiNextAction(s, budget);
      if (!a) break;
      if (a.type === 'RECRUIT') {
        budget.recruited += 1;
        out[me].recruits += 1;
        const d = utype(s, a.unitType);
        if (d.category === 'combat') {
          out[me].combatCount += 1;
          out[me].combatCost += d.cost ?? 0;
        }
      }
      if (a.type === 'UPGRADE') {
        budget.upgraded += 1;
        out[me].upgrades += 1;
      }
      if (a.type === 'ATTACK' || a.type === 'SIEGE') out[me].attacks += 1;
      if (a.type === 'MOVE') out[me].moves += 1;
      // 阵亡：动作前后差集（含反击致死、损耗致死）
      const before = new Map(unitsOf(s, foe).map((u) => [u.id, utype(s, u.type).cost ?? 0]));
      const r = applyAction(s, a);
      if (!r.ok) break;
      s = r.state;
      for (const [id, cost] of before) {
        if (!s.units.some((u) => u.id === id)) {
          out[foe].deaths += 1;
          out[foe].valueLost += cost;
        }
      }
    }
    if (s.winner) break;
    const r = applyAction(s, { type: 'END_TURN' });
    if (!r.ok) break;
    s = r.state;
  }
  return out;
}

const sum: Record<PlayerId, Side> = { A: blank(), B: blank(), C: blank(), D: blank() };
for (let i = 0; i < GAMES; i++) {
  const g = playOne(SEED + i);
  for (const p of ['A', 'B'] as PlayerId[]) {
    const a = sum[p];
    const b = g[p];
    a.recruits += b.recruits;
    a.combatCost += b.combatCost;
    a.combatCount += b.combatCount;
    a.upgrades += b.upgrades;
    a.goldSamples += b.goldSamples;
    a.turns += b.turns;
    a.attacks += b.attacks;
    a.moves += b.moves;
    a.deaths += b.deaths;
    a.valueLost += b.valueLost;
  }
}

const n = GAMES;
const sideLine = (p: PlayerId): string => {
  const a = sum[p];
  const price = a.combatCount ? a.combatCost / a.combatCount : 0;
  return (
    `${p}: 均价 ${price.toFixed(0)} 金 · 升级 ${(a.upgrades / n).toFixed(1)} 次/局 · ` +
    `持金 ${(a.goldSamples / Math.max(1, a.turns)).toFixed(0)} · ` +
    `攻/走 ${a.attacks}/${a.moves} · 阵亡 ${(a.deaths / n).toFixed(1)} 个/局`
  );
};
console.log(`默认配置·自对弈 ${GAMES} 局（era${ERA} ${SIZE}×${SIZE}）`);
console.log('  ' + sideLine('A'));
console.log('  ' + sideLine('B'));
