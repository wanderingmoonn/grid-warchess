// 境界加成属性修正，返回的是增量

import type { Unit } from '../types.ts';
import { getRank, getAgingYears } from './progression.ts';
import { isSpirit, isSoulMasterSpirit } from './identity.ts';

// ── 境界基础加成：公式的单一真相 ──────────────────────────
//
// 这一组回答的是"修到第 r 层，本身给了多少"，所以：
//   · **不乘**流派系数（灵体 ×0.1、剑修 ×0.8 是各自的设计，不是境界的功劳）；
//   · **不扣**衰老（超龄的惩罚在「油尽灯枯」里单独列，扣两遍玩家就对不上账）。
//
// 面板那句「境界加成」印的就是 `realm*Base`；战斗结算走下面那些 `*Modifier`，
// 它们在同一个 `*Raw` 上再乘系数、再扣衰老。改公式只改 `*Raw` 一处。

/** 攻击的原始值（未取整、未乘流派系数、未扣衰老） */
function atkRaw(rank: number): number {
  // 由于攻击次数和溅射太强，这里的基础数值略为削弱
  return (5 * rank + 2 ** (rank - 0.5)) / ((rank + 1) ** 0.2);
}
/** 护甲的原始值（未取整、未乘灵体倍率、未扣衰老） */
function armorRaw(rank: number): number {
  return -1 + rank * rank + 1.5 ** rank;
}
/** 射程的原始值（未取整、未乘灵体倍率） */
function rangeRaw(rank: number): number {
  return rank / 2;
}

/** 境界带来的攻击加成（面板用） */
export function realmAtkBase(rank: number): number {
  return Math.ceil(atkRaw(rank));
}
/** 境界带来的护甲加成（面板用） */
export function realmArmorBase(rank: number): number {
  return Math.ceil(armorRaw(rank));
}
/** 境界带来的射程加成（面板用） */
export function realmRangeBase(rank: number): number {
  return Math.floor(rangeRaw(rank));
}
/** 境界带来的神识加成（面板用）。一级一格，本来就是整数，不用取整 */
export function realmVisionBase(rank: number): number {
  return rank;
}

// 下面四个同理：规则书要按境界列表格，所以都提供"只吃境界"的版本，
// 单位版（带流派系数/衰老）只是它的薄包装。

/** 境界带来的真元（真实伤害） */
export function trueDamageForRank(rank: number): number {
  return Math.floor(rank * rank / 4 + rank * (1.2 ** rank));
}
/** 境界带来的额外攻击次数（总次数 = 1 + 它） */
export function extraAttacksForRank(rank: number): number {
  return Math.max(0, Math.floor((rank - 1) / 2));
}
/** 境界带来的溅射半径 */
export function splashForRank(rank: number): number {
  return Math.floor(rank / 4);
}
/** 境界带来的移动力 */
export function moveForRank(rank: number): number {
  return Math.floor(rank / 3);
}

// ── 灵体系数 ──────────────────────────────────────────
// 和剑修那组倍率一样抽成常量：三条 *Modifier 共用一份，改倍率只改这里。
// 注意：灵体目前**不渲染**修士面板（getCultivationPanelLines 的闸门只放
// 修士 id），所以下面这些倍率暂时没有对应的文案行，别为它写死数字。
export const SPIRIT_ATK_MUL = 0.1;
export const SPIRIT_ARMOR_MUL = 10;
export const SPIRIT_RANGE_MUL = 0.5;
export const SPIRIT_MOVE_MUL = 1.2;

/** 灵体的境界射程加成（打对折后向上取整） */
export function spiritRangeForRank(rank: number): number {
  return Math.ceil((rank / 2) * SPIRIT_RANGE_MUL);
}

/** 要不要按"被削弱过的灵体"折算（未来的魂修不吃这一套） */
function isWeakenedSpirit(u: Unit): boolean {
  return isSpirit(u) && !isSoulMasterSpirit(u);
}

/** 攻击力修正：境界，衰老 −2/岁 */
export function atkModifier(u: Unit): number {
  const rank = getRank(u);
  const scaled = atkRaw(rank) * (isWeakenedSpirit(u) ? SPIRIT_ATK_MUL : 1);
  return Math.ceil(scaled) - getAgingYears(u) * 2;
}

/** 真伤修正 */
export function trueDamageOf(u: Unit): number {
  return trueDamageForRank(getRank(u));
}

/** 攻击次数修正 */
// x=0~2 -> 1次，x=3~4 -> 2次，x=5~6 -> 3次，x=7~8 -> 4次，x=9 -> 5次。
export function attTimesModifier(u: Unit): number {
  return extraAttacksForRank(getRank(u));
}

/** 生命修正 */

/** 护甲修正：境界，衰老 −1/岁 */
export function armorModifier(u: Unit): number {
  const rank = getRank(u);
  const scaled = armorRaw(rank) * (isWeakenedSpirit(u) ? SPIRIT_ARMOR_MUL : 1);
  return Math.ceil(scaled) - getAgingYears(u);
}

/** 移动修正 */
export function moveModifier(u: Unit): number {
  if (isWeakenedSpirit(u)) return Math.ceil((getRank(u) / 3) * SPIRIT_MOVE_MUL);
  return moveForRank(getRank(u));
}

/** 溅射范围修正 */
export function SplashModifier(u: Unit): number {
  return splashForRank(getRank(u));
}

/** 射程修正 */
export function RangeModifier(u: Unit): number {
  const rank = getRank(u);
  return isWeakenedSpirit(u) ? spiritRangeForRank(rank) : realmRangeBase(rank);
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