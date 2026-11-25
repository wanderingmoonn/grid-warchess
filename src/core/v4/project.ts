/**
 * **发展期投影**（P3 闸 C 的 C2 步，2026-11-25）。
 *
 * ── 它回答什么 ────────────────────────────────────────────────
 *
 * "如果我把钱先投经济投到第 k 手，然后剩下的手全造兵，到第 T 手我有多少战力？"
 * k 从 0 扫到 T，取 T 时刻**战力最大**的那个 k。k = 0 就是"一直造兵"，k = T 就是"一直发展"。
 *
 * 为什么必须有 T（用户 2026-11-25 的判断）：兵是一次性消费，经济是复利资产。
 * 没有终点时任何正收益投资都严格优于消费，最优解必然是"无限投经济、不出兵"。
 * T 是"再晚出发对面就升完本了"，由地图和地形给出（见 `constrain.ts` 的 `planHorizon`）。
 *
 * ── 输入必须是真的（v3 的教训）─────────────────────────────────
 *
 * v3 的 `power-solver` 模型是对的，但它有四处输入造假，所以数不真：
 *   ① `econRoom = 城数 × 2`（玩家没有这个上限）；
 *   ② 买了当回合就产钱（没走路）；
 *   ③ 边际产出恒定（好地早被人占了，实际是递减的）；
 *   ④ 只买单一兵种。
 * 这里四条都按真数据：岗位来自 `world.econSpots()`（认领表：一格一条、带走路回合和真实造价），
 * 岗位被消耗后不会再出现（递减），兵种来自每座城的 `affordableCombat`。
 *
 * ── 这一版**不建模升级** ────────────────────────────────────────
 *
 * 升级会同时改三件事（城收入、城耐久、能造的兵），它是闸 C 的"第三个出口"。
 * 先把"经济 vs 兵"这条最简单的账算对，再往里加升级——否则出错分不清是投影错还是升级错。
 *
 * ── 它只打印，不接动作 ────────────────────────────────────────
 *
 * C2 的验收是"人工手算能对上"。C3 才让约束层读 k。
 */
import { incomeOf, utype } from '../rules.ts';
import type { GameState } from '../types.ts';
import type { World } from './world.ts';

/** 一个单位的"身价"。和决定层同一个口径（`constrain.ts` 的 `unitWorth` 就是它） */
export function unitWorthOfType(s: GameState, typeId: string): number {
  const d = utype(s, typeId);
  return (d.atk ?? 0) + (d.maxHp ?? 0) + (d.range ?? 1) * 4;
}

/** 一个已存在单位的身价：按剩余血量打折 */
export function unitWorth(s: GameState, u: { type: string; hp: number }): number {
  const d = utype(s, u.type);
  return ((d.atk ?? 0) + (d.maxHp ?? 0) + (d.range ?? 1) * 4) * (u.hp / Math.max(1, d.maxHp ?? 1));
}

/** 投影里的一个候选战斗兵（"这座城市这个价，买来值这么多"） */
export interface CombatPick {
  type: string;
  gold: number;
  worth: number;
}

/** 投影结果的一行 */
export interface ProjectPoint {
  /** 经济投到第几手（0 = 一直造兵，T = 一直发展） */
  k: number;
  econN: number;
  armyN: number;
  /** 第 T 手结束时手上的金 */
  gold: number;
  /** 第 T 手时的每回合金收入 */
  income: number;
  /** 第 T 手时的战力合计（经济兵不算战力，它们是资产） */
  worth: number;
}

export interface ProjectInput {
  T: number;
  gold: number;
  income: number;
  /** 认领表（`world.econSpots()`）：一格一条，带走路回合和真实造价 */
  spots: Array<{ type: string; yield: number; turns: number; gold: number }>;
  /** 每座城能造的战斗兵，按"每金战力"排好（投影里按顺序买，买不起就换下一个） */
  combat: CombatPick[];
  /**
   * **每回合最多能造几个兵**（引擎硬事实：产兵格占满会拒 `RECRUIT`）。
   *
   * 不建模它就会系统性高估"钱全变兵"——12×12 上 8 手能造出 27 个兵，
   * 而 2×2 的城一手只放得下 4 个。稳态下上回合造的兵会走开，
   * 所以稳态产能 ≈ 空产兵格数。见 `docs/V4-CODE-MAP` 9.22。
   */
  soldierSlots: number;
}

/**
 * 造兵那一段怎么挑：**每金战力最高、买得起就买**。
 *
 * 这不是采购判据（那有两道闸 + 2c 的双口径），只是投影里的占位——投影关心的是
 * "这堆钱能换成多少战力"，不是"该造哪个兵种"。C3 接动作时才用真判据。
 */
function buyArmy(
  gold: number,
  picks: CombatPick[],
  limit: number,
): { gold: number; worth: number; n: number } {
  let g = gold;
  let worth = 0;
  let n = 0;
  while (n < limit) {
    const p = picks.find((x) => g >= x.gold);
    if (!p) break;
    g -= p.gold;
    worth += p.worth;
    n++;
  }
  return { gold: g, worth, n };
}

/**
 * 扫 k = 0..T，返回每个 k 在 T 时刻的读数。
 *
 * 时序（和引擎对齐的三条）：
 *   ① 收入在**回合结束时**结算 → 这一手能花的是"上一手末的余额"；
 *   ② 造出来的兵**这一手不能动**（出生即用完行动），下一手才走；
 *   ③ 经济兵到岗之前产出为 0，到岗那一手末才开始产钱（`at = 造它那一手 + 1 + 走路回合`）。
 */
export function projectEconUntil(input: ProjectInput): ProjectPoint[] {
  const T = Math.max(0, Math.floor(input.T));
  const out: ProjectPoint[] = [];
  const order = [...input.combat].sort((a, b) => b.worth / b.gold - a.worth / a.gold || a.gold - b.gold);

  for (let k = 0; k <= T; k++) {
    let gold = input.gold;
    let income = input.income;
    let worth = 0;
    let econN = 0;
    let armyN = 0;
    /* 岗位按"走过去近"优先消耗：远的先造会白等 */
    const queue = [...input.spots].sort((a, b) => a.turns - b.turns);
    const producing: Array<{ at: number; yield: number }> = [];

    for (let turn = 1; turn <= T; turn++) {
      /* ① 上一手末的结算到账 */
      gold += income;

      if (turn <= k) {
        /* 经济段：买得起就买，一回合能买几个买几个 */
        while (queue.length > 0) {
          /* 岗按"走过去近"排，但队首未必买得起——找第一个买得起的，别被贵的卡住 */
          const i = queue.findIndex((sp) => gold >= sp.gold);
          if (i < 0) break;
          const sp = queue.splice(i, 1)[0]!;
          gold -= sp.gold;
          econN++;
          producing.push({ at: turn + 1 + sp.turns, yield: sp.yield });
        }
      } else {
        /* 兵段 */
        const b = buyArmy(gold, order, Math.max(1, input.soldierSlots));
        gold = b.gold;
        worth += b.worth;
        armyN += b.n;
      }

      /* ③ 到岗的经济兵从这一手末开始产钱 */
      for (const p of producing) if (p.at <= turn) income += p.yield;
      /* 已经计入的不该再加一次：用 at 的单调性打掉 */
      for (let i = producing.length - 1; i >= 0; i--) if (producing[i]!.at <= turn) producing.splice(i, 1);
    }

    out.push({ k, econN, armyN, gold, income, worth });
  }
  return out;
}

/** 取最好的一行：战力最大；同战力取收入大；再同取 k 小（更早出兵） */
export function bestProjection(points: ProjectPoint[]): ProjectPoint | undefined {
  let best: ProjectPoint | undefined;
  for (const p of points) {
    if (!best) {
      best = p;
      continue;
    }
    if (p.worth > best.worth) best = p;
    else if (p.worth === best.worth && p.income > best.income) best = p;
  }
  return best;
}

/** 给打印用：这一方现在的战力（已在场的兵） */
export function armyWorthNow(s: GameState, world: World): number {
  return world.myCombat.reduce((n, u) => n + unitWorth(s, u), 0);
}

/** 给打印用：现在每回合能收多少 */
export function incomeNow(s: GameState, world: World): number {
  return incomeOf(s, world.me);
}
