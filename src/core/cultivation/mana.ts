/**
 * 灵力：修士施放「法术」要花的资源。
 *
 * ── 设计（2026-11-08 敲定）────────────────────────────────
 *
 * 灵力是**每个修士自己的一池子**，不是国库的灵石：法术的节奏应该跟着这个人的
 * 境界走，而不是跟着整方的经济走。它和灵石的关系只有"都叫灵"这一层。
 *
 * · 上限 = `(4 + 境界) × 10`：0 期 40 点、9 期 130 点。
 * · 每回合开始回 30 点（不随境界涨）。
 * · 一个法术耗 40~60 点，所以低境界大约"攒两回合放一发"，高境界能连放两发。
 *
 * ── 为什么全部乘 10 ──────────────────────────────────────
 *
 * 这是设计者的要求：数值都取整十，以后要加"每回合回 35"或者"耗 45"这种
 * 细调余地时不用引入小数。`custom.mana` 里存的就是这个整数，不是百分比。
 *
 * ── 为什么存"上限"而不每次都算 ────────────────────────────
 *
 * `custom.manaMax` 是落库的字段（老存档没有它，按当前境界补算）。
 * 境界升级、衰老降级都会改上限，**在回合开始时统一刷新一次**：
 * 其他时机刷新会遇到"这一帧的上限是多少"的时序问题，而回合开始只有一处。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（见 skills/sky-step.ts 顶部）。
 */
import type { Unit } from '../types.ts';
import { getRank } from './progression.ts';

/** 上限的基数（0 期就是 4 点，再乘 10 = 40） */
export const MANA_LIMIT_BASE = 4;
/** 每升一层多加多少点（乘 10 之前） */
export const MANA_LIMIT_PER_RANK = 1;
/** 所有灵力数值的放大倍数：设计上留的"小数位" */
export const MANA_SCALE = 10;
/** 每回合开始回多少灵力 */
export const MANA_REGEN = 30;

/** 某个境界的灵力上限（已乘 10） */
export function manaLimitForRank(rank: number): number {
  return (MANA_LIMIT_BASE + Math.max(0, rank) * MANA_LIMIT_PER_RANK) * MANA_SCALE;
}

/**
 * 这个修士的灵力上限。
 *
 * 优先读落库的 `custom.manaMax`（它是"上次回合开始时"的值），没有就按境界现算。
 * 老存档里没有这两个字段，于是第一次读出来是"满灵力"——这比"开局 0 灵力、
 * 要等两个回合才能放第一发"友好得多，也不会让法术在存档里凭空欠账。
 */
export function maxManaOf(u: Unit): number {
  const stored = u.custom?.manaMax;
  if (typeof stored === 'number' && Number.isFinite(stored)) return stored;
  return manaLimitForRank(getRank(u));
}

/** 当前灵力（老存档没这个字段 = 满） */
export function manaOf(u: Unit): number {
  const cur = u.custom?.mana;
  if (typeof cur === 'number' && Number.isFinite(cur)) return Math.max(0, Math.min(maxManaOf(u), cur));
  return maxManaOf(u);
}

/** 直接写一个值（会自动夹在 0..上限 之间） */
export function setMana(u: Unit, n: number): void {
  const max = maxManaOf(u);
  const v = Math.max(0, Math.min(max, Math.round(n)));
  u.custom = { ...(u.custom ?? {}), mana: v, manaMax: max };
}

/** 够不够放这一发 */
export function canSpendMana(u: Unit, cost: number): boolean {
  return manaOf(u) >= cost;
}

/** 扣灵力。不够就什么都不做并返回 false —— 调用方必须先判，别靠它兜底 */
export function spendMana(u: Unit, cost: number): boolean {
  const cur = manaOf(u);
  if (cur < cost) return false;
  setMana(u, cur - cost);
  return true;
}

/**
 * 回合开始：刷新上限 + 回灵力。
 *
 * 上限要用**当前境界**重算并写回：境界是这回合之前升上去的，如果只在
 * "读的时候现算"，面板上的数字会和 `custom.manaMax` 打架；而如果每处都现算，
 * 那这个字段就没有存在的意义了。刷新放在这里只有一处，谁都不用操心时序。
 */
export function regenMana(u: Unit): { before: number; after: number; max: number } {
  const max = manaLimitForRank(getRank(u));
  const before = manaOf(u);
  const after = Math.min(max, before + MANA_REGEN);
  u.custom = { ...(u.custom ?? {}), mana: after, manaMax: max };
  return { before, after, max };
}
