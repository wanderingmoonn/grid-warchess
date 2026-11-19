/**
 * ⚠️ **暂停（2026-11-19）**：这条线暂时不用，别再往 UI / runner 里接。
 *
 * 原因（用户原话："不太平衡也不够兼容"）：
 *   · 一代可用兵种严重不均——信息化/空军/海军 0 个、奇想 3 个、冷兵器 20 个，
 *     于是"选哪条线"实际等于"能不能在第一关抽到牌"，不是设计选择；
 *   · 分支 = 扩展包的映射是硬编的，加新包就得回来改这张表。
 * 后面要么让分支自带起始时代，要么改成"包 = 卡池、分支 = 权重"两层。
 * 代码留着可跑（978 项测试覆盖），**但不要接到界面上**。
 *
 * —— 以下是原设计意图 ——
 *
 * 肉鸽分支 = **主题线**（2026-11-19 重做）。
 *
 * 第一版按战术角色分（步战/远程/机动…），结果每条分支里只剩三五个兵，
 * 抽卡几乎没有随机性——那不是"路线"，是更窄的池子。正确理解是：
 *
 *   一个分支 = 一个主题 × 一组扩展包 × 几十个兵种。
 *   选「奇想」是 71 个战斗兵里抽，选「冷兵器」是 86 个里抽。
 *
 * 分支管两件事：**这一 run 的卡池从哪来**，以及**开局开哪些包**（不再一口气全开）。
 */

import { EXPANSIONS } from '../expansions.ts';
import { UNIT_TYPES } from '../config.ts';
import type { UnitTypeDef } from '../types.ts';

export interface BranchMeta {
  id: string;
  name: string;
  blurb: string;
  /** 属于这条线的扩展包 id（'base' = 原版表里、不属于任何包的兵） */
  packs: string[];
  /** 开局可选 */
  startable: boolean;
}

export const BRANCHES: readonly BranchMeta[] = [
  {
    id: 'cold',
    name: '冷兵器',
    blurb: '原版与各时代的常规军备，兵种最全的一条线',
    packs: ['base', 'era-arms'],
    startable: true,
  },
  {
    id: 'fantasy',
    name: '奇想',
    blurb: '法术、巨兽、异族，池子最杂',
    packs: ['fantasy'],
    startable: true,
  },
  {
    id: 'cultivation',
    name: '修真',
    blurb: '修士与邪物：兵少，个体强',
    packs: ['cultivation', 'dark-turmoil'],
    startable: true,
  },
  {
    id: 'modern',
    name: '信息化',
    blurb: '火器到装甲时代，靠射程与破甲',
    packs: ['pack-contemporary', 'armor-era7', 'armor-era8'],
    startable: true,
  },
  {
    id: 'air',
    name: '空军',
    blurb: '越过地形、被对空克制',
    packs: ['air'],
    startable: true,
  },
  {
    id: 'naval',
    name: '海军',
    blurb: '水师线，只有水图能打',
    packs: ['naval'],
    startable: false,
  },
];

/** 兵种 id → 包 id（原版兵种记为 'base'） */
let unitPackCache: Map<string, string> | null = null;

export function unitPack(id: string): string {
  if (!unitPackCache) {
    const map = new Map<string, string>();
    for (const e of EXPANSIONS) {
      for (const u of e.units ?? []) map.set(u.id, (e as { id: string }).id);
    }
    unitPackCache = map;
  }
  return unitPackCache.get(id) ?? 'base';
}

/** 兵种属于哪条分支（找不到包 → 冷兵器线兜底，绝不返回 null 之外的东西） */
export function branchOf(id: string, def: UnitTypeDef | undefined = UNIT_TYPES[id]): BranchMeta | null {
  if (def && def.category !== 'combat') return null;
  const pack = unitPack(id);
  return BRANCHES.find((b) => b.packs.includes(pack)) ?? BRANCHES[0]!;
}

export function branchById(id: string): BranchMeta {
  return BRANCHES.find((b) => b.id === id) ?? BRANCHES[0]!;
}

/**
 * 这条分支的卡池（已按城市时代过滤）。
 *
 * @param eraOf   兵种 → 时代；默认一律 1（测试里可传真表）
 * @param cityEra 高于它的抽不到
 * @param ids     候选全集（默认整个兵种表，测试里可传小集合）
 */
export function poolOfBranch(
  branchId: string,
  opts: { eraOf?: (id: string) => number; cityEra?: number; ids?: readonly string[] } = {},
): string[] {
  const branch = branchById(branchId);
  const ids = opts.ids ?? Object.keys(UNIT_TYPES);
  const eraOf = opts.eraOf ?? (() => 1);
  const cityEra = opts.cityEra ?? Number.POSITIVE_INFINITY;
  return ids.filter((id) => {
    const def = UNIT_TYPES[id];
    if (def && def.category !== 'combat') return false;
    if (!branch.packs.includes(unitPack(id))) return false;
    return eraOf(id) <= cityEra;
  });
}

/** 主分支的卡权重 ×3；别的分支仍可能出现，作为"外援" */
export const BRANCH_MAIN_MUL = 3;

export function branchMul(id: string, main: string | undefined): number {
  if (!main) return 1;
  const b = branchOf(id);
  if (!b) return 0;
  return b.id === main ? BRANCH_MAIN_MUL : 1;
}

/** 每条分支有多少战斗兵（开局界面要显示，玩家据此选路线） */
export function branchSize(branchId: string, eraOf?: (id: string) => number): number {
  return poolOfBranch(branchId, { eraOf, cityEra: 8 }).length;
}
