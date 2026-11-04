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