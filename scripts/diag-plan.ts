/**
 * 看 AI 每一回合的"计划"：攒不攒钱、攒什么、还有多少可动用的现金。
 *
 * 为什么要这个：采购被冻住的机制是隐形的——`savingFor` 一非空，
 * 只有"超出目标费用的那部分"能花，而经济单位有「回本 ≤8 回合不冻结」的豁免，
 * 战斗单位没有。于是同一笔钱能变成农民，却永远变不成兵。
 * 线上被打崩的那十几局，AI 造了 43 个单位、战斗单位 0 个，就是这个形状。
 *
 *   node --experimental-strip-types scripts/diag-plan.ts --side B --games 1
 *   node --experimental-strip-types scripts/diag-plan.ts --exp bloodbath,turn-order-comp --size 20
 */

import { AI_MAX_STEPS, aiDebugPlan, aiNextAction, aiRecruitTrace } from '../src/core/ai.ts';
import { applyAction, citiesOf, incomeOf, unitsOf } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const SIZE = Number(argOf('size', '20'));
const CAP = Number(argOf('cap', '80'));
const WATCH: PlayerId = argOf('side', 'B') === 'A' ? 'A' : 'B';
const EXP = argOf('exp', 'bloodbath,turn-order-comp').split(',').filter(Boolean);
const SEED = Number(argOf('seed', '7000'));
/** 每回合给对手补多少金：人为制造"对面比我会花钱"的压力，用来看 AI 被压时的计划 */
const FEED = Number(argOf('feed', '0'));
/** 把"这一回合比较过的全部攒钱候选"摊开：只看到结果，看不出为什么不是那一个 */
const SHOW_GOALS = args.includes('--goals');

aiRecruitTrace.on = true;

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
  SEED,
);

const combatOf = (st: GameState, p: PlayerId): number =>
  unitsOf(st, p).filter((u) => st.unitTypes[u.type]?.category === 'combat').length;

console.log('回合  金  收入  兵  敌兵  攒钱目标  目标价  可用现金  姿态  紧急');

// 汇总口径：整局里 AI 有多少钱是"躺着的"
const stat = { goldSum: 0, turns: 0, recruit: 0, combatSum: 0, frozen: 0 };

let round = 0;
let ended = false;
while (!ended && round < CAP) {
  round += 1;
  for (let half = 0; half < 2 && !ended; half += 1) {
    const me: PlayerId = s.current;
    if (FEED > 0 && me !== WATCH) s.players[me].gold += FEED;
    const plan = aiDebugPlan(s, me);
    if (me === WATCH) {
      stat.goldSum += s.players[me].gold;
      stat.turns += 1;
      stat.combatSum += combatOf(s, me);
      if (plan.savingFor && plan.allowance === 0) stat.frozen += 1;
      console.log(
        `${String(s.turn).padStart(4)}  ${String(s.players[me].gold).padStart(4)}  ` +
          `${String(incomeOf(s, me)).padStart(4)}  ${String(combatOf(s, me)).padStart(2)}  ` +
          `${String(combatOf(s, other(me))).padStart(4)}  ` +
          `${(plan.savingFor ?? '-').padStart(8)}  ${String(plan.targetCost).padStart(6)}  ` +
          `${String(plan.allowance === Infinity ? '∞' : plan.allowance).padStart(8)}  ` +
          `${plan.stance.padStart(6)}  ${plan.urgent ? 'Y' : '.'}`,
      );
      if (SHOW_GOALS) {
        for (const g of plan.goalOptions) {
          console.log(
            `${' '.repeat(30)}· ${g.kind.padEnd(7)} ${String(g.cost).padStart(5)} 金` +
              ` 评分 ${g.score.toFixed(2)}  ${g.note}`,
          );
        }
      }
    }

    const budget = { maxRecruit: 2, maxUpgrade: 1, recruited: 0, upgraded: 0 };
    const got: string[] = [];
    for (let step = 0; step < AI_MAX_STEPS; step += 1) {
      const action = aiNextAction(s, budget);
      if (!action) break;
      if (action.type === 'RECRUIT') {
        budget.recruited += 1;
        if (me === WATCH) {
          got.push(action.unitType);
          stat.recruit += 1;
        }
      }
      if (action.type === 'UPGRADE') {
        budget.upgraded += 1;
        if (me === WATCH) got.push('【升级】');
      }
      const r = applyAction(s, action);
      if (!r.ok) break;
      s = r.state;
      if (s.winner) {
        ended = true;
        break;
      }
    }
    // 产兵名额没用完：把"为什么挑不出兵"写出来
    if (me === WATCH && budget.recruited < budget.maxRecruit && aiRecruitTrace.last) {
      console.log(`${' '.repeat(58)}不造兵：${aiRecruitTrace.last}`);
    }
    if (me === WATCH && got.length) console.log(`${' '.repeat(58)}买：${got.join(' ')}`);
    if (ended) break;
    const end = applyAction(s, { type: 'END_TURN' });
    if (!end.ok) {
      console.log(`  ! END_TURN 失败：${end.reason}`);
      ended = true;
      break;
    }
    s = end.state;
  }
}

const fin = citiesOf(s, WATCH).length;
console.log(`\n终局：回合 ${s.turn} / ${s.winner ?? '未决'} 胜 / ${WATCH} 城 ${fin} 兵 ${combatOf(s, WATCH)}`);
console.log(
  `口径：平均余额 ${(stat.goldSum / Math.max(1, stat.turns)).toFixed(0)}` +
    ` / 平均兵力 ${(stat.combatSum / Math.max(1, stat.turns)).toFixed(1)}` +
    ` / 采购 ${stat.recruit} 次` +
    ` / 全程冻结 ${stat.frozen}/${stat.turns} 回合（${((stat.frozen / Math.max(1, stat.turns)) * 100).toFixed(0)}%）`,
);

function other(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}
