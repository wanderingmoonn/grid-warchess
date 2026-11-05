/**
 * 一次性诊断：老师给的 BUILD 为什么不在 legalActions 里。
 *
 * 打印前 8 个不匹配：工兵、要盖的东西、落点，以及**真的把它下出去的返回理由**
 * （拿一份状态副本试一下，不污染原局）。
 */
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction } from '../../src/core/ai.ts';
import { applyAction } from '../../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../../src/core/setup.ts';
import type { GameState } from '../../src/core/types.ts';
import { legalActions } from './legal.ts';

const seed = Number(process.argv[2] ?? 12000);
let s: GameState = createMatch(
  { ...DEFAULT_CONFIG, size: 10, startEra: 1, playerCount: 2, draftMode: false, aiOpponent: false, aiAlly: false, expansionIds: ['bloodbath'], aiLevel: 'advanced' },
  seed,
);
s.fog = false;

let turnSeat: string | null = null;
let budget = { ...DEFAULT_BUDGET };
let rejected = new Set<string>();
let inTurn = 0;
let shown = 0;
let builds = 0;

while (!s.winner && s.turn <= 150) {
  const seat = s.current;
  if (seat !== turnSeat) {
    turnSeat = seat;
    inTurn = 0;
    budget = { ...DEFAULT_BUDGET };
    rejected = new Set();
  }
  if (inTurn >= AI_MAX_STEPS) {
    const end = applyAction(s, { type: 'END_TURN' });
    if (!end.ok) break;
    s = end.state;
    inTurn += 1;
    continue;
  }
  const picked = aiNextAction(s, budget, rejected);
  if (!picked) {
    const end = applyAction(s, { type: 'END_TURN' });
    if (!end.ok) break;
    s = end.state;
    inTurn += 1;
    continue;
  }
  if (picked.type === 'RECRUIT') budget.recruited += 1;
  if (picked.type === 'UPGRADE') budget.upgraded += 1;

  if (picked.type === 'BUILD') {
    builds += 1;
    const acts = legalActions(s, seat);
    const hit = acts.some(
      (a) => a.type === 'BUILD' && a.unitId === picked.unitId && a.unitType === picked.unitType && a.x === picked.x && a.y === picked.y,
    );
    if (!hit && shown < 8) {
      shown += 1;
      const copy: GameState = JSON.parse(JSON.stringify(s));
      const probe = applyAction(copy, picked);
      const near = acts.filter((a) => a.type === 'BUILD').slice(0, 4);
      console.log(
        `\n[${shown}] 第 ${s.turn} 回合 ${picked.unitType} @ (${picked.x},${picked.y}) 工兵=${picked.unitId}`,
        `\n    真的下出去会：${probe.ok ? 'OK' : probe.reason}`,
        `\n    同一时刻枚举里的 BUILD 有 ${acts.filter((a) => a.type === 'BUILD').length} 个，比如：`,
        near.map((a) => JSON.stringify(a)).join(' '),
      );
    }
  }

  const r = applyAction(s, picked);
  if (!r.ok) {
    rejected.add(JSON.stringify(picked));
    const end = applyAction(s, { type: 'END_TURN' });
    if (!end.ok) break;
    s = end.state;
    inTurn += 1;
    continue;
  }
  s = r.state;
  inTurn += 1;
}
console.log(`\n结束：${s.winner} 回合 ${s.turn}，这一局老师提了 ${builds} 次 BUILD`);
