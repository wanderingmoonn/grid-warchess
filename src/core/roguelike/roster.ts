/**
 * 兵额与撤离结算。
 *
 * 兵额 = 城市容量（格子数）：2×2 = 4，3×3 = 9（加固两次升一级）。
 * 撤离时只有**站进城内**的单位能带走；带不走的按身价折半（阵亡抚恤），
 * 这是给玩家的止损出口——不给的话，"练三关一失误全没"会让人不想再开一局。
 */

import type { RosterUnit } from './run-state.ts';

/** 城市容量 = 边长² */
export function cityCapacity(citySize: number): number {
  const n = Math.floor(citySize);
  if (!Number.isFinite(n) || n < 1) return 0;
  return n * n;
}

/** 加固几次升一级（2 次：4 → 9） */
export const WALL_STEPS = 2;

export function citySizeFor(wallProgress: number, baseSize = 2): number {
  const steps = Math.floor(Math.max(0, wallProgress) / WALL_STEPS);
  return baseSize + steps;
}

export interface SettleRoster {
  /** 带进下一关的（不超过兵额） */
  taken: RosterUnit[];
  /** 留在城外的（已损失） */
  left: RosterUnit[];
  /** 抚恤金（身价的一半，向下取整） */
  refund: number;
}

/**
 * 撤离结算。
 *
 * - 城内的人先按**身价从高到低**抢位置：兵额满了的时候，玩家最想要的是保住贵的兵，
 *   引擎替他把顺序排好，不用在倒计时里一个个选；
 * - 城内人数超过兵额时，多出来的**回到 left**（没位置就是没位置）；
 * - 城外的人全部进 left，按身价折半。
 *
 * @param valueOf 身价（金币）。默认按 60 估，调用方传真实造价更准。
 */
export function settleRoster(
  inside: readonly RosterUnit[],
  outside: readonly RosterUnit[],
  capacity: number,
  valueOf: (u: RosterUnit) => number = () => 60,
): SettleRoster {
  const cap = Math.max(0, Math.floor(capacity));
  const ranked = [...inside].sort((a, b) => valueOf(b) - valueOf(a) || a.type.localeCompare(b.type));

  const taken = ranked.slice(0, cap);
  const overflow = ranked.slice(cap);
  const lost = [...overflow, ...outside];
  const refund = lost.reduce((sum, u) => sum + Math.floor(Math.max(0, valueOf(u)) / 2), 0);
  return { taken, left: lost, refund };
}

/** 城内格子的判定：城市占 size×size，从左上角算起 */
export function isInsideCity(x: number, y: number, city: { x: number; y: number }, size: number): boolean {
  return x >= city.x && x < city.x + size && y >= city.y && y < city.y + size;
}
