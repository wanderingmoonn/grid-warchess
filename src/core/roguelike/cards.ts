/**
 * 兵种卡：三张同名合成一级（2026-11-19 定）。
 *
 * 为什么是"三张"而不是像杀戮尖塔那样"两张同名升级"：这套游戏里一张卡的
 * 效果是**整个兵种变强**（不是多一张手牌），所以三张才够一次质变。
 */

import { branchMul } from './branches.ts';

/** 抽到几张算一级 */
export const CARDS_PER_LEVEL = 3;

/** 已抽张数 → 卡等级（0 张 = 0 级；1~2 张仍是 0 级，3 张 = 1 级） */
export function cardLevel(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.floor(count / CARDS_PER_LEVEL);
}

/** 还差几张升级（0 = 已经是整数级，不用再抽） */
export function cardsToNext(count: number): number {
  const n = Number.isFinite(count) && count > 0 ? count : 0;
  return CARDS_PER_LEVEL - (n % CARDS_PER_LEVEL);
}

/**
 * 抽卡用的确定性随机（mulberry32）。
 *
 * 必须是"同一 seed 同一结果"：重开本关要能重放同一组三选一，
 * 不然玩家会拿"刷奖励"当最优解。
 */
export function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 从一整张卡池里抽 n 个互不相同的候选。
 *
 * 已拥有 2 张的卡**优先出现**（差一张就升级的那种），这是肉鸽的"临门一脚"
 * 体验：玩家总能看到"再来一张就成"的选项。
 */
export interface DrawOptions {
  /** 城市时代：高于它的兵种**抽不到**（玩家的兵种池由城市时代决定） */
  cityEra?: number;
  /** 兵种 → 时代。默认按原版兵种表查 */
  eraOf?: (id: string) => number;
  /** 主分支：属于它的卡权重 ×3（见 branches.ts），其余分支 ×1 */
  branch?: import('./branches.ts').Branch;
}

/**
 * **升城市之后，高阶兵种卡出率上升**（2026-11-19 定）。
 *
 * 权重规则（写死在这里，方便一眼看懂难度曲线）：
 *   · 时代 e 的基础权重 = 1 + 0.6 × (e − 1)  → 二代 1.6，三代 2.2……
 *   · **正好等于当前城市时代**的兵种再 ×1.5 —— 玩家刚升上来，就该先见到这一代的兵；
 *   · 差一张就升级的卡再 ×2 —— 肉鸽的"临门一脚"体验。
 *
 * 不按"抽不到就重抽"实现：那样在城市时代很高时，低阶卡会被反复过滤，
 * 候选数量不稳定，玩家会觉得三选一有时只有两项。
 */
export function cardWeight(era: number, cityEra: number, nearUpgrade: boolean): number {
  const base = 1 + 0.6 * Math.max(0, era - 1);
  const frontier = era === cityEra ? 1.5 : 1;
  return base * frontier * (nearUpgrade ? 2 : 1);
}

export function drawCards(
  pool: readonly string[],
  owned: Record<string, number>,
  seed: number,
  n = 3,
  opts: DrawOptions = {},
): string[] {
  const rnd = rngFrom(seed);
  const cityEra = opts.cityEra ?? Number.POSITIVE_INFINITY;
  const eraOf = opts.eraOf ?? (() => 1);

  // 高于城市时代的兵种这一局根本用不上，直接不进池
  const eligible = pool.filter((id) => eraOf(id) <= cityEra);
  const isNear = (id: string): boolean => (owned[id] ?? 0) % CARDS_PER_LEVEL === CARDS_PER_LEVEL - 1;

  const out: string[] = [];
  const left = [...eligible];
  const mulOf = (id: string): number => (opts.branch ? branchMul(id, opts.branch) : 1);
  while (out.length < n && left.length > 0) {
    const weights = left.map((id) => cardWeight(eraOf(id), cityEra, isNear(id)) * mulOf(id));
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = rnd() * total;
    let pick = left.length - 1;
    for (let i = 0; i < left.length; i += 1) {
      roll -= weights[i]!;
      if (roll <= 0) {
        pick = i;
        break;
      }
    }
    out.push(left[pick]!);
    left.splice(pick, 1);
  }
  return out;
}
