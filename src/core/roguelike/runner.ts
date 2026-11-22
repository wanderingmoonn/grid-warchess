/**
 * 一轮战斗的"外壳"：撤离阶段 + 结算（2026-11-19）。
 *
 * 为什么放 core 而不是 UI：它是纯状态机——只读 GameState，产出一个新快照。
 * 这样能在 node 里直接跑真对局来测，不用开浏览器。
 *
 * **不改 rules.ts**：敌人清空、倒计时、入城判定都在这里看，规则层一个字没动。
 */

import type { GameState, PlayerId } from '../types.ts';
import { cityTiles } from '../rules.ts';
import type { RosterUnit, RunState } from './run-state.ts';
import { cityCapacity, settleRoster } from './roster.ts';
import { settleGold } from './rewards.ts';

export type Phase = 'battle' | 'evac' | 'done';

export interface RunnerSnapshot {
  phase: Phase;
  /** 撤离还剩几手（只在 evac 阶段有意义） */
  evacLeft: number;
  /** 敌人清空时是第几手（用来算"省了几手"） */
  clearedTurn: number | null;
}

export interface RunnerCtx {
  run: RunState;
  stageIndex: number;
  /** 普通关 2 / Boss 1 / 任务 3 */
  evacTurns: number;
  /** 期望手数：算"省下几手"的基准 */
  expectedTurns: number;
  /** 玩家席位（撤离只看"我的兵有没有进城"） */
  playerSeat: PlayerId;
  /** 遗物「军械」：带回来的兵按上限回满 */
  healIntake?: boolean;
}

export interface StageResult {
  gold: number;
  /** 带走的人（已经受兵额限制） */
  taken: RosterUnit[];
  /** 没带走的人（城外 / 兵额溢出） */
  left: RosterUnit[];
  refund: number;
  /** 实际用了几手 */
  turnsUsed: number;
  /** 没清场就结束（败退） */
  halfDone: boolean;
}

/**
 * 撤离阶段必须**把胜负按下不表**（2026-11-19）。
 *
 * `applyAction` 开头就有一句 `if (s.winner) return { ok:false, reason:'对局已结束' }`，
 * 而"敌人清空"会立刻判赢——不处理的话倒计时一开始就动不了，玩家只能干看着。
 *
 * 做法：撤离期间把 `winner` 抹掉（记在 runner 的快照里），结算时再按快照恢复。
 * **不改 rules**：这里动的是这一局的状态副本，规则层的判定一个字没变。
 */
export function keepPlaying(state: GameState): GameState {
  if (state.winner) state.winner = null;
  return state;
}

export function initRunner(): RunnerSnapshot {
  return { phase: 'battle', evacLeft: 0, clearedTurn: null };
}

function foesOf(state: GameState, seat: PlayerId): number {
  return state.units.filter((u) => u.owner !== seat && u.hp > 0).length;
}

/**
 * 每走一步之后调一次。
 *
 * 两条转移：
 *   · 敌人清空（且没分胜负）→ 进入撤离，倒计时 = `ctx.evacTurns`
 *   · 撤离中每次**换手**（`turn` 变化）→ 倒计时 -1，到 0 就结束
 *
 * 用 `turn` 变化而不是"每次 END_TURN"：AI 回合也会 END_TURN，
 * 按行动数扣会让倒计时凭空变短。
 */
export function observe(
  _prev: GameState,
  next: GameState,
  snap: RunnerSnapshot,
  ctx: RunnerCtx,
): RunnerSnapshot {
  if (snap.phase === 'done') return snap;

  if (snap.phase === 'battle') {
    // 清空敌人 → 撤离（哪怕引擎已经判我赢，也要先让我把兵带回城）
    if (foesOf(next, ctx.playerSeat) === 0) {
      return { phase: 'evac', evacLeft: Math.max(1, ctx.evacTurns), clearedTurn: next.turn };
    }
    // 输了就没得撤
    if (next.winner && next.winner !== ctx.playerSeat) return { ...snap, phase: 'done' };
    return snap;
  }

  /*
   * 撤离倒计时**不在这里扣**（2026-11-19 第三次修）。
   *
   * 试过两种信号都不成立：
   *   · 按 `turn` 变化 → 敌人被清空后它的回合空转，一个来回烧掉两手；
   *   · 按 `current` 回到玩家 → 敌人没兵时引擎直接把回合跳回玩家，
   *     `current` 从头到尾都是 A，信号根本不出现（实测 evacLeft 卡在 2）。
   * 现在改成**玩家每按一次"结束回合"扣一手**（见 `onPlayerEndTurn`），
   * 这才是"写 2 就真能走两个回合"的字面意思。
   */
  return snap;
}

/**
 * 玩家结束了自己的一回合：撤离倒计时 -1，到 0 就结束。
 *
 * 只认玩家自己的动作，不猜状态变化——敌人有没有兵、引擎跳不跳回合都不影响。
 */
export function onPlayerEndTurn(snap: RunnerSnapshot, _ctx: RunnerCtx): RunnerSnapshot {
  if (snap.phase !== 'evac') return snap;
  const left = snap.evacLeft - 1;
  return left <= 0 ? { ...snap, phase: 'done', evacLeft: 0 } : { ...snap, evacLeft: left };
}

/** 城内格子判定：城市占 size×size，直接用规则层的 cityTiles（口径只有一处） */
function insideCitySet(state: GameState, seat: PlayerId): Set<string> {
  const city = state.cities.find((c) => c.owner === seat && !c.ruined);
  if (!city) return new Set();
  return new Set(cityTiles(city).map((t) => `${t.x},${t.y}`));
}

/** 玩家单位的"身价"：按招募价估，查不到就按 60 */
function valueOfUnit(state: GameState, type: string): number {
  const def = state.unitTypes[type];
  if (!def) return 60;
  return Math.max(30, def.cost ?? 60);
}

/**
 * 结束这一关并结算。
 *
 * 顺序很重要：**先按城内/城外分，再受兵额限制**——城外的人不管兵额多少都带不走，
 * 城内的人超过兵额才需要按身价排。
 */
export function settleStage(state: GameState, snap: RunnerSnapshot, ctx: RunnerCtx): StageResult {
  const inside = insideCitySet(state, ctx.playerSeat);
  const mine = state.units.filter((u) => u.owner === ctx.playerSeat);
  const toRoster = (u: (typeof mine)[number]): RosterUnit => ({
    type: u.type,
    hp: Math.max(1, u.hp),
    cardLv: 0,
  });

  const inCity: RosterUnit[] = [];
  const outside: RosterUnit[] = [];
  for (const u of mine) {
    if (inside.has(`${u.x},${u.y}`)) inCity.push(toRoster(u));
    else outside.push(toRoster(u));
  }

  /*
   * 兵额 = 城格数，**没有任何加成**（2026-11-21）。
   * 以前这里还有一项 `ctx.capacityBonus`（驮马遗物 +2），等于绕过"空间就是名额"
   * 凭空多塞两个人——和"城里挤满了就得当场选"这条设计正面冲突，已删除。
   */
  const capacity = cityCapacity(state.config.citySize ?? 2);
  const valueOf = (u: RosterUnit): number => valueOfUnit(state, u.type);
  const split = settleRoster(inCity, outside, capacity, valueOf);
  /*
   * 遗物「军械」：带回来的人按兵种上限回满（2026-11-19）。
   * 放在 settleRoster 之后，只影响"真的被带走的人"——没带走的不该白回血。
   */
  if (ctx.healIntake) {
    split.taken = split.taken.map((u) => ({
      ...u,
      hp: state.unitTypes[u.type]?.maxHp ?? u.hp,
    }));
  }

  const halfDone = snap.clearedTurn === null;
  const turnsUsed = snap.clearedTurn ?? state.turn;
  const gold = settleGold({
    stageIndex: ctx.stageIndex,
    taken: split.taken.length,
    turnsSaved: ctx.expectedTurns - turnsUsed,
    campDestroyed: false,
    halfDone,
  });

  return { gold, taken: split.taken, left: split.left, refund: split.refund, turnsUsed, halfDone };
}
