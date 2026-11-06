// 境界加成属性修正，返回的是增量

import type { Unit } from '../types.ts';
import { getRank, getAgingYears } from './progression.ts';
import { isSpirit, isSoulMasterSpirit } from './identity.ts';

/** 攻击力修正：境界，衰老 −2/岁 */
// 由于攻击次数和溅射太强，这里的基础数值略为削弱
export function atkModifier(u: Unit): number {
  const rank = getRank(u);
  const realmsModifier = (5 * rank + 2 ** (rank - 0.5)) / ((rank + 1) ** 0.2);
  const aging = getAgingYears(u) * 2;
  let scaled = realmsModifier;
  if (isSpirit(u) && !isSoulMasterSpirit(u)) scaled *= 0.1;
  return Math.ceil(scaled) - aging;
}

/** 真伤修正 */
export function trueDamageOf(u: Unit): number {
  const rank = getRank(u);
  const realmsModifier = (rank*rank)/4+rank*(1.2**rank);
  return Math.floor(realmsModifier);
}

/** 攻击次数修正 */
// x=0~2 -> 1次，x=3~4 -> 2次，x=5~6 -> 3次，x=7~8 -> 4次，x=9 -> 5次。
export function attTimesModifier(u: Unit): number {
  const rank = getRank(u);
  const realmsModifier = (rank - 1) / 2;
  return Math.max(0, Math.floor(realmsModifier));
}

/** 生命修正 */
export function HpModifier(u: Unit): number {
  const rank = getRank(u);
  const realmsModifier = (rank - 1) / 2;
  return Math.max(0, Math.floor(realmsModifier));
}

/** 护甲修正：境界，衰老 −1/岁 */
export function armorModifier(u: Unit): number {
  const rank = getRank(u);
  const realm = -1 + rank * rank + 1.5 ** rank;
  const aging = getAgingYears(u);
  let scaled = realm;
  if (isSpirit(u) && !isSoulMasterSpirit(u)) scaled *= 10;
  return Math.ceil(scaled) - aging;
}

/** 移动修正 */
export function moveModifier(u: Unit): number {
  const realm = getRank(u) / 3;
  if (isSpirit(u) && !isSoulMasterSpirit(u)) return Math.ceil(realm * 1.2);
  return Math.floor(realm);
}

/** 溅射范围修正 */
export function SplashModifier(u: Unit): number {
  const rank = getRank(u);
  const realmsModifier = rank/4;
  return Math.floor(realmsModifier);
}

/** 射程修正 */
export function RangeModifier(u: Unit): number {
  const realm = getRank(u) / 2;
  if (isSpirit(u) && !isSoulMasterSpirit(u)) return Math.ceil(realm * 0.5);
  return Math.floor(realm);
}

/** 视野修正 */
export function VisionModifier(u: Unit): number {
  const rank = getRank(u);
  const aging = getAgingYears(u);
  const realmsModifier = rank;
  return Math.floor(realmsModifier-aging);
}

// ── 剑修伤害倍率 ──────────────────────────────────
// 普攻 ×0.8，剑气纵横期间 ×1.2；非剑修 ×1.0。
// 抽在这里是为了让 hooks.ts（伤害/攻城/面板修正）和 panel.ts（文案）
// 共用同一份规则，改倍率只改这里。
export const SWORD_BASE_MUL = 0.8;
export const SWORD_SWEEP_MUL = 1.2;
export function swordMul(u: Unit): number {
  if (u.type !== 'sword-cultivator') return 1.0;
  return u.custom?.swordSweepActive === true ? SWORD_SWEEP_MUL : SWORD_BASE_MUL;
}

// ── 战斗历练（击杀经验）──────────────────────────
// 规则单一真相：击杀经验只在这里算，hooks.ts 只负责读写额度。
// 设计要点：
//   · 目标不看造价/等级，只看基础攻击力是否达到当前境界的"值得一战"门槛；
//     这样天然绕开召唤物无价、多资源换算、英雄无等级的问题。
//   · 单次收益受击杀者境界系数调制，高阶清杂兵收益自然下降。
//   · 单回合有硬上限，防止 AOE 清屏刷经验。
//   · rank 7+ 系数为 0：纯战斗摸不到 7 级（剑修 rank 6 仍可磨，见下）。

/** 单次击杀的名义历练基数（未乘境界系数） */
export const KILL_EXP_BASE = 3;

/** 单个修士单回合最多获得的击杀经验 */
export const KILL_EXP_PER_TURN_CAP = 10;

/** 下标 = 击杀者境界，值 = 名义历练系数。rank 7+ 为 0。 */
export const KILL_EXP_RANK_FACTOR = [1.8, 1.8, 1.5, 1.2, 0.8, 0.5, 0.15, 0, 0, 0];

/**
 * 下标 = 击杀者境界，值 = 目标 atk 必须严格大于它才给历练。
 * rank 0-1 只要 atk > 0 就给；越高境界门槛越高，高境界清杂兵自动无收益。
 * rank 8-9 的 99 是"基本过滤一切"，和 factor 的 0 是双重保险。
 */
export const KILL_EXP_MIN_ATK_BY_RANK = [0, 0, 1, 2, 3, 5, 8, 12, 99, 99];

/**
 * 剑修实战历练倍率。配合 getExpGrowth 对剑修减半的人设。
 * rank 6 时 3 * 0.15 * 2 = 0.9 → round = 1，剑修理论上能靠血战磨到 7 级；
 * 非剑修 rank 6 是 0.45 → round = 0，磨不上去。
 */
export const SWORD_KILL_EXP_MUL = 2;

/** 从按 rank 索引的表里取值，越界钳到两端，防止未来加 rank 时 undefined。 */
function rankIndex(table: readonly number[], rank: number): number {
  const i = Math.min(Math.max(rank, 0), table.length - 1);
  return table[i] ?? 0;
}

/**
 * 该目标是否"值得一战"：基础攻击力必须超过当前境界的门槛。
 * 用基础 atk（不做 effectiveStats 修正），纯查询、无副作用。
 */
export function isWorthFighting(killerRank: number, victimAtk: number): boolean {
  return victimAtk > rankIndex(KILL_EXP_MIN_ATK_BY_RANK, killerRank);
}

/**
 * 单次击杀的"名义历练"，不含单回合封顶。
 * 不通过门槛（低攻靶子）返回 0。
 * `victimAtk` 由调用方从 state.unitTypes[victim.type].atk 取。
 */
export function killExpPerKill(killer: Unit, victimAtk: number): number {
  const rank = getRank(killer);
  if (!isWorthFighting(rank, victimAtk)) return 0;
  const base = KILL_EXP_BASE * rankIndex(KILL_EXP_RANK_FACTOR, rank);
  const mul = killer.type === 'sword-cultivator' ? SWORD_KILL_EXP_MUL : 1;
  return Math.round(base * mul);
}

/**
 * 实际入账的击杀经验：名义值再受本回合剩余额度限制。
 * `usedThisTurn` 由调用方从 custom.killExpThisTurn 读出。
 */
export function calcKillExp(killer: Unit, usedThisTurn: number, victimAtk: number): number {
  const nominal = killExpPerKill(killer, victimAtk);
  const left = Math.max(0, KILL_EXP_PER_TURN_CAP - usedThisTurn);
  return Math.min(nominal, left);
}