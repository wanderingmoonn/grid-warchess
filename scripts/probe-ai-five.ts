/**
 * 五个结构性缺口的**行为探针**：量"机制有没有真的跑起来"，而不是只量胜负。
 *
 * 为什么需要两份：胜负只是一个数。改完 AI 出现"胜率没动"，可能是这条机制没用，
 * 也可能是它压根没触发（条件写错了、永远被更靠前的分支挡住）。这两件事的修法
 * 完全不同，而胜负分不出来。所以这里逐个记：
 *
 *   换血      DISBAND 动作次数（每局），以及发生在第几回合左右
 *   攒钱记忆  意向被"复活"的次数（这一条以前会让攒到一半的钱散回产线）
 *   两翼      分到佯攻那一翼的"单位·回合"数
 *   一层推演  推演把纯评分第一换掉的次数
 *   换家      处于 trade 姿态的动作次数
 *   两回合威胁 走位落点里"下回合打不到、两回合内够得着"的占比（两侧对比）
 *
 * 用法：
 *   node --experimental-strip-types scripts/probe-ai-five.ts --games 12
 *   node --experimental-strip-types scripts/probe-ai-five.ts --games 12 --ai old --old ./baselines/ai-6c3c992.ts
 */

import { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction as newAi, aiDebugPlan, aiTrace } from '../src/core/ai.ts';
import { tacticalMap } from '../src/core/ai-tactics.ts';
import { applyAction, utype } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import type { GameState } from '../src/core/types.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};
const GAMES = Number(argOf('games', '12'));
const SEED = Number(argOf('seed', '900'));
const ERA = Number(argOf('era', '3'));
const CAP = Number(argOf('cap', '200'));
const WHICH = argOf('ai', 'new');
const OLD_FILE = argOf('old', './baselines/ai-6c3c992.ts');

const oldAi =
  WHICH === 'old'
    ? ((await import(OLD_FILE)).aiNextAction as unknown as typeof newAi)
    : newAi;
const pick = WHICH === 'old' ? oldAi : newAi;
/** 旧版也有 buildPlan 的只读出口，用它量"攒钱目标被丢掉"的次数 */
const planOf = (
  WHICH === 'old'
    ? ((await import(OLD_FILE)).aiDebugPlan as unknown as (s: GameState, me: string) => { savingFor: string | null; targetCost: number })
    : (aiDebugPlan as unknown as (s: GameState, me: string) => { savingFor: string | null; targetCost: number })
);

interface GameStat {
  turns: number;
  winner: string | null;
  disband: number;
  /** 走位落点：两回合内够得着、但下回合还打不到 */
  soonMoves: number;
  moves: number;
  /** DISBAND 发生的回合 */
  disbandTurns: number[];
  /** 攒钱目标"上一回合在攒、这一回合不攒了"的次数 */
  goalDrops: number;
  lastGoal: string | null;
  lastCost: number;
  /** 新 AI 的五项计数器（每局一份） */
  trace: { swap: number; revive: number; flankUnits: number; tradeCalls: number; lookaheadFlip: number };
}

function playOne(seed: number): GameStat {
  let s: GameState = createMatch(
    { ...DEFAULT_CONFIG, startEra: ERA, aiLevel: 'tactic', aiAlly: true, aiOpponent: true },
    seed,
  );
  const out: GameStat = {
    turns: 0,
    winner: null,
    disband: 0,
    soonMoves: 0,
    moves: 0,
    disbandTurns: [],
    goalDrops: 0,
    lastGoal: null,
    lastCost: 0,
    trace: { swap: 0, revive: 0, flankUnits: 0, tradeCalls: 0, lookaheadFlip: 0 },
  };
  aiTrace.on = true;
  aiTrace.reset();

  while (!s.winner && s.turn <= CAP) {
    const me = s.current;
    // 每回合建一次战术图：它按"位置"取值，所以一个回合里所有落点都拿它核
    const map = tacticalMap(s, me);
    // 攒钱目标"丢了"：上一回合在攒、这一回合不攒了
    const plan = planOf(s, me);
    // 只数"还买不起、目标还在"却把计划丢了——那才是 bug；
    // 目标买到了、或者急事来了而放弃，都是正常的，不算
    if (out.lastGoal !== null && plan.savingFor === null && out.lastCost > s.players[me].gold) {
      out.goalDrops += 1;
    }
    out.lastGoal = plan.savingFor;
    out.lastCost = plan.targetCost;
    const budget = { ...DEFAULT_BUDGET };
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
      const a = pick(s, budget);
      if (!a) break;
      if (a.type === 'MOVE') {
        const u = s.units.find((x) => x.id === a.unitId);
        if (u && utype(s, u.type).category === 'combat') {
          const moved = { ...u, x: a.x, y: a.y };
          out.moves += 1;
          if (map.exposure(moved).damage === 0 && map.soon(moved).damage > 0) out.soonMoves += 1;
        }
      }
      if (a.type === 'DISBAND') {
        out.disband += 1;
        out.disbandTurns.push(s.turn);
      }
      const r = applyAction(s, a);
      if (!r.ok) break;
      s = r.state;
      if (a.type === 'RECRUIT') budget.recruited += 1;
      if (a.type === 'UPGRADE') budget.upgraded += 1;
    }
    if (s.winner) break;
    const r = applyAction(s, { type: 'END_TURN' });
    if (!r.ok) break;
    s = r.state;
  }
  out.turns = s.turn;
  out.winner = s.winner;
  out.trace = {
    swap: aiTrace.swap,
    revive: aiTrace.revive,
    flankUnits: aiTrace.flankUnits,
    tradeCalls: aiTrace.tradeCalls,
    lookaheadFlip: aiTrace.lookaheadFlip,
  };
  aiTrace.on = false;
  return out;
}

let turns = 0;
let decided = 0;
let soonMoves = 0;
let moves = 0;
let disband = 0;
let goalDrops = 0;
const disbandTurns: number[] = [];
const sum = { swap: 0, revive: 0, flankUnits: 0, tradeCalls: 0, lookaheadFlip: 0 };
const swapWhy = new Map<string, number>();

for (let i = 0; i < GAMES; i++) {
  const g = playOne(SEED + i);
  turns += g.turns;
  if (g.winner) decided += 1;
  soonMoves += g.soonMoves;
  moves += g.moves;
  disband += g.disband;
  goalDrops += g.goalDrops;
  disbandTurns.push(...g.disbandTurns);
  sum.swap += g.trace.swap;
  sum.revive += g.trace.revive;
  sum.flankUnits += g.trace.flankUnits;
  sum.tradeCalls += g.trace.tradeCalls;
  sum.lookaheadFlip += g.trace.lookaheadFlip;
  for (const [k, v] of aiTrace.swapWhy) swapWhy.set(k, (swapWhy.get(k) ?? 0) + v);
}

const pct = (a: number, b: number): string => (b === 0 ? '—' : `${((a / b) * 100).toFixed(1)}%`);
console.log(
  `${WHICH === 'old' ? '旧版' : '新版'} AI 自对弈 · ${GAMES} 局 · era${ERA} · 上限 ${CAP} 回合\n` +
    `  均 ${(turns / GAMES).toFixed(0)} 回合，分胜负 ${decided}/${GAMES}\n` +
    `  换血 DISBAND：${disband} 次（${(disband / GAMES).toFixed(2)} 次/局）` +
    (disbandTurns.length
      ? `，首次在第 ${Math.min(...disbandTurns)} 回合，中位第 ${disbandTurns.sort((a, b) => a - b)[Math.floor(disbandTurns.length / 2)]} 回合`
      : '') +
    `\n  攒钱目标中途丢掉：${goalDrops} 次（${(goalDrops / GAMES).toFixed(2)} 次/局）` +
    `\n  走位落进"两回合威胁圈"：${soonMoves}/${moves} = ${pct(soonMoves, moves)}`,
);

if (WHICH !== 'old') {
  console.log(
    `  换血（计数器）：${sum.swap} 次（${(sum.swap / GAMES).toFixed(2)} 次/局）\n` +
      `  攒钱意向复活：${sum.revive} 次（${(sum.revive / GAMES).toFixed(2)} 次/局）\n` +
      `  佯攻分兵：${sum.flankUnits} 单位·次（${(sum.flankUnits / GAMES).toFixed(1)} 每局）\n` +
      `  换家姿态：${sum.tradeCalls} 次（${(sum.tradeCalls / GAMES).toFixed(1)} 每局）\n` +
      `  换血被挡的原因：${[...swapWhy.entries()].sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}×${v}`).join(' / ') || '—'}\n` +
      `  一层推演改判：${sum.lookaheadFlip} 次（${(sum.lookaheadFlip / GAMES).toFixed(1)} 每局）`,
  );
}
