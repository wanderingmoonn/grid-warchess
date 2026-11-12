/**
 * 「地图环境」：进入某张图就生效的**全图**影响。
 *
 * ── 为什么不用地形 / 不用扩展钩子 ──────────────────────
 *
 * 1. **不是地形**。地形是按格的（森林、环形山），而"外空缺氧"是整张图的事，
 *    和站在哪一格无关。硬塞进地形表，就得给每张图的每一格都改一遍，
 *    而且玩家看到的是"这块地不好"而不是"这里不能待"。
 *
 * 2. **不交给扩展自己算**。`modifyArmor` / `modifyMove` 钩子确实能做同样的事，
 *    但那样有三个地方要各自记得调（面板、结算、寻路），漏一个就会出现
 *    "面板写 2 甲、实际按 12 甲挨打"。放在核心 + 三处接入点，
 *    口径只有一份。
 *
 * 3. **豁免要能动态算**。空间站的维生仓是"造好就生效、被打掉就失效"，
 *    如果把结果写回 `board.hazard`，任何一条销毁路径漏了都会留下永久免疫。
 *    所以这里只提供"读的时候问一句"的钩子，**不缓存**。
 */

import type { BoardId, GameState, HazardSpec, Unit } from './types.ts';
import { boardIdOf, EARTH } from './board.ts';

/** 这张图本身有没有环境（不考虑谁豁免） */
export function hazardOn(s: GameState, board: BoardId): HazardSpec | null {
  // 地球不参与：它连 `boards` 都不在里面（见 board.ts 开头）
  if (board === EARTH) return null;
  return s.boards?.[board]?.hazard ?? null;
}

/**
 * 某个单位是不是**豁免**当前环境（维生仓、宇航服这类）。
 *
 * 返回 true = 不受影响。注册方自己判断"管不管这张图"：
 * 维生仓只看自己那座站，所以别的图它会返回 false。
 */
export type HazardExempt = (s: GameState, unit: Unit, h: HazardSpec) => boolean;

/**
 * 豁免来源可以有好几个（航天员的宇航服、空间站的维生仓……），
 * 所以这里是**列表**不是单个函数：用单槽的话后注册的会悄悄覆盖先注册的，
 * 表现是"只开太空战争时航天员突然不免疫了"——那种 bug 没人查得出来。
 */
const exempts: HazardExempt[] = [];

export function registerHazardExempt(fn: HazardExempt): void {
  exempts.push(fn);
}

/** 这个单位现在实际承受的环境（null = 没有，或者它豁免了） */
export function hazardFor(s: GameState, unit: Unit): HazardSpec | null {
  const h = hazardOn(s, boardIdOf(unit));
  if (!h) return null;
  for (const fn of exempts) if (fn(s, unit, h)) return null;
  return h;
}

/**
 * 环境对护甲的影响：整除数，**无保底**。
 *
 * 无保底是有意的：护甲 12 的基地在月面上只剩 2，护甲 4 的舱段直接归零。
 * 这正是"穿宇航服很脆"的表达——要保底的话，环境就只是个小减益了。
 */
export function hazardArmorOf(armor: number, h: HazardSpec | null): number {
  if (!h?.armorDiv || h.armorDiv <= 1) return armor;
  return Math.floor(armor / h.armorDiv);
}

/** 环境对移动力的影响：乘完再抬到保底 */
export function hazardMoveOf(move: number, h: HazardSpec | null): number {
  if (!h?.moveMul || h.moveMul >= 1 || move <= 0) return move;
  return Math.max(h.moveMin ?? 1, Math.floor(move * h.moveMul));
}

/** 面板上那一行（没有环境就返回空数组） */
export function hazardLines(h: HazardSpec | null): string[] {
  if (!h) return [];
  const bits: string[] = [];
  if (h.armorDiv && h.armorDiv > 1) bits.push(`护甲 ÷${h.armorDiv}（无保底）`);
  if (h.moveMul && h.moveMul < 1) {
    bits.push(`移动 ×${h.moveMul}${h.moveMin ? `（保底 ${h.moveMin}）` : ''}`);
  }
  return [`${h.name}：${bits.join(' · ')}`];
}
