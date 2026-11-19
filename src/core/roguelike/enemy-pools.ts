/**
 * 敌人池：前几场从**弱怪池**抽，后几场从**强怪池**抽（2026-11-19 定）。
 *
 * 为什么要分池而不是"按威胁等级加权抽一个"：加权抽会出现"第 1 关就撞上骑士"，
 * 玩家没处躲；分池把难度曲线**写在池子边界上**，一眼能看懂，也好调。
 */

import { UNIT_TYPES } from '../config.ts';

export type PoolId = 'weak' | 'strong';

/**
 * 池子边界：前 `weakRatio` 比例的战斗关用弱池。
 * 3 场 → 2 弱 1 强；5 场 → 3 弱 2 强；9 场 → 5 弱 4 强。
 */
export const WEAK_RATIO = 0.6;

export function poolForStage(stageIndex: number, totalStages: number): PoolId {
  const total = Math.max(1, totalStages);
  const weakCount = Math.max(1, Math.round(total * WEAK_RATIO));
  return stageIndex < weakCount ? 'weak' : 'strong';
}

/**
 * 两个池子的成员。
 *
 * 现在只有原版兵；以后每加一条扩展，把它的战斗兵按强度补进对应池即可。
 * **强池里的兵不一定强在数值，也可以强在"难处理"**（射程、盾墙、破甲）。
 */
export const ENEMY_POOLS: Record<PoolId, readonly string[]> = {
  weak: ['militia', 'archer', 'scout', 'spearman'],
  strong: ['knight', 'longbow', 'crossbow', 'halberdier', 'musketeer', 'mortar'],
};

/** 这一关可用的敌人池（过滤掉本局不存在的兵种，避免抽到空定义） */
export function poolUnits(id: PoolId): string[] {
  return ENEMY_POOLS[id].filter((u) => !!UNIT_TYPES[u]);
}

/** 确定性随机（和抽卡同一个实现思路：同 seed 同结果，重开本关能重放） */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PickOptions {
  count: number;
  seed: number;
  /** 地图标签（林地/关隘…）：命中偏好的兵种权重 ×2，见设计稿 §7.1 */
  arenaTags?: readonly string[];
  /** 兵种 → 偏好标签。没写就按普通权重 */
  tagsOf?: (id: string) => readonly string[];
}

/**
 * 从一个池子里抽 `count` 个敌人（可以是同一种兵多次——小队里两个民兵很正常，
 * 所以这里是"有放回"的，只是用权重让重复不至于整队同型）。
 */
export function pickEnemies(pool: readonly string[], opts: PickOptions): string[] {
  const rnd = rng(opts.seed);
  const tags = new Set(opts.arenaTags ?? []);
  const weightOf = (id: string): number => {
    const t = opts.tagsOf?.(id) ?? [];
    return tags.size === 0 ? 1 : t.some((x) => tags.has(x)) ? 2 : 1;
  };

  const out: string[] = [];
  const counts = new Map<string, number>();
  for (let i = 0; i < Math.max(0, opts.count); i += 1) {
    const weights = pool.map((id) => weightOf(id) * (1 / (1 + (counts.get(id) ?? 0))));
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) break;
    let roll = rnd() * total;
    let pick = pool[pool.length - 1]!;
    for (let k = 0; k < pool.length; k += 1) {
      roll -= weights[k]!;
      if (roll <= 0) {
        pick = pool[k]!;
        break;
      }
    }
    out.push(pick);
    counts.set(pick, (counts.get(pick) ?? 0) + 1);
  }
  return out;
}
