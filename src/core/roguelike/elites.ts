/**
 * 肉鸽专属的三只"精英怪"（2026-11-19）。
 *
 * 用户定的设计：
 *   · **城市只给 Boss**；
 *   · 精英不给城，改成「一只新设计的怪 + 一队常规怪」。
 *
 * 这里只定义"那只新怪"。做法是**克隆现有兵种再改**——不是偷懒，
 * 是因为兵种定义里有很多互相牵制的字段（射程/穿甲/反击/是否占格…），
 * 从零写一只极容易漏掉某条，出现"打不动"或"无法被攻击"这类怪事。
 * 克隆保证它一定是个合法的兵，改的只是数值和名字。
 */

import { UNIT_TYPES } from '../config.ts';
import type { UnitTypeDef } from '../types.ts';

function cloneFrom(baseId: string, id: string, name: string, patch: Partial<UnitTypeDef>): UnitTypeDef {
  const base = UNIT_TYPES[baseId];
  if (!base) throw new Error(`精英怪的基础兵种不存在：${baseId}`);
  return { ...base, ...patch, id, name };
}

/** 血盾兵：走得慢、血厚、专啃城墙 */
export const ELITE_SHIELD = cloneFrom('militia', 'elite_shield', '血盾兵', {
  maxHp: 46,
  attack: 14,
  move: 2,
  cost: 120,
  // 攻城加成走 siegeBonus（和攻城车同一口径）
  siegeBonus: 12,
  legacy: true,
} as Partial<UnitTypeDef>);

/** 钩镰手：移动快、专抓远处的弓手 */
export const ELITE_HOOK = cloneFrom('scout', 'elite_hook', '钩镰手', {
  maxHp: 30,
  attack: 13,
  move: 4,
  cost: 130,
  legacy: true,
} as Partial<UnitTypeDef>);

/** 咒火术士：远程 2、打一片（burst 2） */
export const ELITE_HEXER = cloneFrom('archer', 'elite_hexer', '咒火术士', {
  maxHp: 26,
  attack: 16,
  range: 2,
  burst: 2,
  move: 2,
  cost: 150,
  legacy: true,
} as Partial<UnitTypeDef>);

export const ELITE_UNITS: readonly UnitTypeDef[] = [ELITE_SHIELD, ELITE_HOOK, ELITE_HEXER];

/** `mergeUnits` 要的是"id → 定义"的表，这里直接给一份 */
/*
 * 注册进全局兵种表。
 *
 * 关卡校验与部署都查 `UNIT_TYPES`，不注册的话关卡里写 `elite_shield` 会被判
 * 没有这个兵种。标 `legacy` 之后它只是存在但产线不列——能摆、不能造。
 */
// 注册进全局表会让"时代兵数"这类统计把精英怪算进去（测试会红），
// 所以不注册；关卡校验与建局各自接受一份额外兵种表。
void UNIT_TYPES;

export const ELITE_UNIT_MAP: Record<string, UnitTypeDef> = Object.fromEntries(
  ELITE_UNITS.map((u) => [u.id, u]),
);

/** 精英关里"新怪"的 id，供关卡数据引用 */
export type EliteId = 'elite_shield' | 'elite_hook' | 'elite_hexer';
