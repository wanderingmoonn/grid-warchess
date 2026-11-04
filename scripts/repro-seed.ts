/**
 * 复盘同一颗种子：把上报对局（`warchess_reports` #88，seed 914654067）用**当前 AI**
 * 双方各打一遍，看"人类那一侧的数字"换成 AI 会长成什么样。
 *
 * 只打印、不判定——用来回答"AI 为什么不这么做"。
 *
 * 为什么需要它：上报数据只留了逐回合摘要（兵数、金币、城池、战力）和终局阵容，
 * 没有逐步动作。想知道"同一个局面下 AI 会怎么选"，只能拿同一颗种子重开一局。
 * 注意它不是"重放人类那局"：人类的落子不在数据里，所以两次对局从第二步就分岔。
 * 能对上的只有**结构**：谁在攒钱、谁在摊兵海、谁先升城。
 *
 * 用法：
 *   node --experimental-strip-types scripts/repro-seed.ts [seed] [size] [startEra]
 */
import { applyAction, unitsOf } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction, aiDebugPlan } from '../src/core/ai.ts';
import { utype } from '../src/core/rules.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const SEED = Number(process.argv[2] ?? 914654067);
const SIZE = Number(process.argv[3] ?? 16);
const START_ERA = Number(process.argv[4] ?? 2);
const EXPS = ['fantasy-core', 'fantasy-knights', 'fantasy-beasts', 'fantasy-arcane', 'fantasy-heroes', 'bloodbath', 'turn-order-comp', 'last-stand'];

let s: GameState = createMatch(
  { ...DEFAULT_CONFIG, size: SIZE, startEra: START_ERA, aiLevel: 'advanced', aiAlly: true, aiOpponent: true, expansionIds: EXPS },
  SEED,
);

const acts: Record<string, Record<string, number>> = { A: {}, B: {} };
const made: Record<string, Record<string, number>> = { A: {}, B: {} };
const lost: Record<string, { count: number; value: number }> = { A: { count: 0, value: 0 }, B: { count: 0, value: 0 } };
const plans: Record<string, string[]> = { A: [], B: [] };
let va = 0;
let vb = 0;

const valOf = (p: PlayerId): number =>
  unitsOf(s, p)
    .filter((u) => utype(s, u.type).category === 'combat')
    .reduce((n, u) => n + (utype(s, u.type).cost ?? 0), 0);

while (!s.winner && s.turn <= 90) {
  const me = s.current;
  const budget = { ...DEFAULT_BUDGET };
  if (me === 'A') {
    va = valOf('A');
    vb = valOf('B');
    const plan = aiDebugPlan(s, me);
    plans.A.push(`t${s.turn} ${plan.stance}/${plan.savingFor ?? '-'} 金${Math.round(s.players[me].gold)}`);
    if (s.turn % 5 === 0) {
      console.log(
        `t${String(s.turn).padStart(2)} A: 兵${unitsOf(s, 'A').length} 值${va} 金${Math.round(s.players.A.gold)}` +
          ` | B: 兵${unitsOf(s, 'B').length} 值${vb} 金${Math.round(s.players.B.gold)}` +
          ` 城A${s.cities.filter((c) => c.owner === 'A').length}/B${s.cities.filter((c) => c.owner === 'B').length}` +
          ` | 姿态 ${plan.stance} 攒:${plan.savingFor ?? '-'}`,
      );
    }
  }
  for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
    const a = aiNextAction(s, budget);
    if (!a) break;
    acts[me]![a.type] = (acts[me]![a.type] ?? 0) + 1;
    if (a.type === 'RECRUIT') {
      budget.recruited += 1;
      const t = a.unitType;
      made[me]![t] = (made[me]![t] ?? 0) + 1;
    }
    if (a.type === 'UPGRADE') budget.upgraded += 1;
    const before = new Set(unitsOf(s, me === 'A' ? 'B' : 'A').map((u) => u.id));
    const r = applyAction(s, a);
    if (!r.ok) break;
    s = r.state;
    const foe = me === 'A' ? 'B' : 'A';
    for (const id of before) {
      if (!s.units.some((u) => u.id === id)) {
        lost[foe].count += 1;
        lost[foe].value += 0;
      }
    }
  }
  if (s.winner) break;
  const r = applyAction(s, { type: 'END_TURN' });
  if (!r.ok) break;
  s = r.state;
}

const avgCost = (p: PlayerId): number => {
  const entries = Object.entries(made[p]!);
  let n = 0;
  let sum = 0;
  for (const [id, k] of entries) {
    const d = s.unitTypes[id];
    if (!d || d.category !== 'combat') continue;
    n += k;
    sum += (d.cost ?? 0) * k;
  }
  return n ? sum / n : 0;
};
const econ = (p: PlayerId): number =>
  Object.entries(made[p]!).filter(([id]) => s.unitTypes[id]?.category === 'economy').reduce((n, [, k]) => n + k, 0);

console.log('winner', s.winner, 'turns', s.turn);
for (const p of ['A', 'B'] as PlayerId[]) {
  console.log(
    `${p} 行动 ${JSON.stringify(acts[p])}\n  造兵 ${JSON.stringify(made[p])}\n` +
      `  战斗兵平均单价 ${avgCost(p).toFixed(0)} 金 / 经济单位 ${econ(p)} 个 / 阵亡 ${lost[p].count}`,
  );
}
console.log('A 姿态样本', plans.A.filter((_, i) => i % 6 === 0).slice(0, 16).join(' | '));
