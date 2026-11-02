/**
 * 压力基准：给对手每回合补一点金，模拟"会花钱的玩家"，看 AI 在这种局面下能撑多久。
 *
 * 为什么不用 AI 打 AI 的胜率当唯一指标：镜像局两边都用同一套错，错的地方会互相抵消，
 * 胜率 50% 看起来毫无问题。线上真正打崩 AI 的不是"另一个 AI"，而是**一直在买兵的人**。
 * 所以这里人为给对手加一份预算（默认 +30 金/回合），把"AI 的钱花不出去"放大成胜负差。
 *
 *   node --experimental-strip-types scripts/bench-pressure.ts --games 4 --feed 30
 *   node --experimental-strip-types scripts/bench-pressure.ts --size 16 --cap 60 --feed 30
 */

import { AI_MAX_STEPS, aiNextAction } from '../src/core/ai.ts';
import { applyAction, citiesOf, unitsOf } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const SIZE = Number(argOf('size', '16'));
const GAMES = Number(argOf('games', '4'));
const CAP = Number(argOf('cap', '60'));
const FEED = Number(argOf('feed', '30'));
const SEED0 = Number(argOf('seed0', '7000'));
const EXP = argOf('exp', 'bloodbath,turn-order-comp').split(',').filter(Boolean);
const WATCH: PlayerId = 'B';

const combatOf = (s: GameState, p: PlayerId): number =>
  unitsOf(s, p).filter((u) => s.unitTypes[u.type]?.category === 'combat').length;

let wins = 0;
let losses = 0;
let draws = 0;
let armySum = 0;
let goldSum = 0;
let turns = 0;
let lostCitySum = 0;

for (let g = 0; g < GAMES; g += 1) {
  const seed = SEED0 + g * 137;
  let s: GameState = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: SIZE,
      startEra: 1,
      aiOpponent: true,
      aiAlly: true,
      expansionIds: EXP,
      aiLevel: 'advanced',
    } as never,
    seed,
  );

  let ended = false;
  let round = 0;
  while (!ended && round < CAP) {
    round += 1;
    for (let half = 0; half < 2 && !ended; half += 1) {
      const me: PlayerId = s.current;
      if (me !== WATCH) s.players[me].gold += FEED;
      if (me === WATCH) {
        turns += 1;
        armySum += combatOf(s, me);
        goldSum += s.players[me].gold;
      }

      const budget = { maxRecruit: 2, maxUpgrade: 1, recruited: 0, upgraded: 0 };
      for (let step = 0; step < AI_MAX_STEPS; step += 1) {
        const action = aiNextAction(s, budget);
        if (!action) break;
        if (action.type === 'RECRUIT') budget.recruited += 1;
        if (action.type === 'UPGRADE') budget.upgraded += 1;
        const r = applyAction(s, action);
        if (!r.ok) break;
        s = r.state;
        if (s.winner) {
          ended = true;
          break;
        }
      }
      if (ended) break;
      const end = applyAction(s, { type: 'END_TURN' });
      if (!end.ok) ended = true;
      else s = end.state;
    }
    // 城市全丢就算被推平（报告里 AI 输了多半是这个形状）
    if (!ended && citiesOf(s, WATCH).length === 0 && s.turn > 5) ended = true;
  }

  const cityLeft = citiesOf(s, WATCH).length;
  lostCitySum += 4 - cityLeft;
  if (s.winner === WATCH) wins += 1;
  else if (s.winner) losses += 1;
  else draws += 1;

  console.log(
    `局 ${g + 1}  seed ${seed}  回合 ${String(s.turn).padStart(3)}  ` +
      `${s.winner ?? '未决'}  残城 ${cityLeft}  兵 ${combatOf(s, WATCH)}`,
  );
}

console.log(
  `\n汇总：${wins} 胜 / ${losses} 负 / ${draws} 未决  ·  平均兵力 ${(armySum / Math.max(1, turns)).toFixed(1)}` +
    `  ·  平均余额 ${(goldSum / Math.max(1, turns)).toFixed(0)}  ·  平均丢城 ${(lostCitySum / GAMES).toFixed(1)}`,
);
