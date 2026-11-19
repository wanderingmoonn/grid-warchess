/**
 * 兵种分支：肉鸽的"升级路线"（2026-11-19 定）。
 *
 * 问题：现在开多少扩展都往一个大池子里丢，三选一抽到的是"整个游戏所有兵"，
 * 于是玩家没有路线，只有运气。
 *
 * 做法：按**兵种属性**分类（射程 / 移动 / 领域 / 层级 / 能力），不用手工名单——
 * 手工名单必然和新增扩展脱节。分支决定：
 *   · 开局选一条主分支 → 这一 run 的卡池偏向它；
 *   · 扩展包要不要全开，也由分支决定（选秘法就只相关包，池子才可控）。
 */

import { UNIT_TYPES } from '../config.ts';
import type { UnitTypeDef } from '../types.ts';

export type Branch = 'infantry' | 'ranged' | 'mobile' | 'heavy' | 'air' | 'naval';

export interface BranchMeta {
  id: Branch;
  name: string;
  blurb: string;
  /** 开局可选（水师要水图，切片里先不给） */
  startable: boolean;
}

export const BRANCHES: readonly BranchMeta[] = [
  { id: 'infantry', name: '步战', blurb: '便宜、能站住，靠数量和人换', startable: true },
  { id: 'ranged', name: '远程', blurb: '先手、怕近身，需要有人挡在前面', startable: true },
  { id: 'mobile', name: '机动', blurb: '跑得快，抢位置和拆后排', startable: true },
  { id: 'heavy', name: '重装', blurb: '破甲与攻城，慢但硬', startable: true },
  { id: 'air', name: '空中', blurb: '越过地形，被对空克制', startable: true },
  { id: 'naval', name: '水师', blurb: '只在水上有效，切片里不开放', startable: false },
];

/** 显式覆盖：属性判不准的个例写在这里（新增扩展时优先改这里，不要改判据） */
export const BRANCH_OVERRIDE: Record<string, Branch> = {
  // 例：投石车射程 2 但本质是攻城器械
  catapult: 'heavy',
};

const HEAVY_ABILITIES = new Set(['siege-master', 'shield-wall', 'armor-pierce']);

/** 一个兵种属于哪条分支。经济/建筑类不算战斗分支，返回 null */
export function branchOf(id: string, def: UnitTypeDef | undefined = UNIT_TYPES[id]): Branch | null {
  const forced = BRANCH_OVERRIDE[id];
  if (forced) return forced;
  if (!def) return null;
  // 只有战斗兵种参与分支；经济/建筑不该出现在卡池里
  if (def.category !== 'combat') return null;

  const abilities = def.abilities ?? [];
  if (def.domain === 'water') return 'naval';
  if (def.layer === 'air' || def.flight === true || abilities.includes('fly-over')) return 'air';
  if (abilities.some((a) => HEAVY_ABILITIES.has(a))) return 'heavy';
  if (def.range >= 2) return 'ranged';
  if (def.move >= 3) return 'mobile';
  return 'infantry';
}

/** 把一批兵种按分支分组（忽略非战斗兵种） */
export function groupByBranch(ids: readonly string[]): Record<Branch, string[]> {
  const out: Record<Branch, string[]> = {
    infantry: [],
    ranged: [],
    mobile: [],
    heavy: [],
    air: [],
    naval: [],
  };
  for (const id of ids) {
    const b = branchOf(id);
    if (b) out[b].push(id);
  }
  return out;
}

/** 主分支 ×3，其余 ×1；这条倍数就是"路线感"的来源，可单测 */
export const BRANCH_MAIN_MUL = 3;

export function branchMul(id: string, main: Branch | undefined): number {
  if (!main) return 1;
  const b = branchOf(id);
  if (!b) return 0;
  return b === main ? BRANCH_MAIN_MUL : 1;
}
