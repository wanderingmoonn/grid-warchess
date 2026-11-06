// 天赋、技能与法术

import type { GameState, Unit, SkillDef } from '../types.ts';
import { isCultivatorUnit } from './identity.ts';
import { getRank } from './progression.ts';

/** 御空需要的最低境界（规则书里那个"几级解锁"就是它） */
export const SKY_STEP_RANK = 2;

export const SKY_STEP_SKILL: SkillDef = {
  id: 'sky-step',
  name: '御空',
  summary: `在低空与地面之间切换。消耗 1 点移动力，每回合一次（需 ${SKY_STEP_RANK} 级）。`,
  effect: 'sky-step',
  cooldown: 0,
  multiCast: true,
};

export const SWORD_SWEEP_SKILL:SkillDef = {
  id: 'sword-sweep',
  name: '剑气纵横',
  summary: '向指定方向挥出剑气，穿透路径上的敌人，释放与命中均可增加修为。',
  effect: 'sword-sweep',
  cooldown: 0,
  multiCast: true,
  targeting: 'direction', // 声明它需要选方向
  notReadyReason: '攻击次数不足',
};

export const SPIRIT_REBIRTH_SKILL: SkillDef = {
  id: 'spirit-rebirth',
  name: '重生',
  summary: '重塑肉身：失去一半修为并强制降一境，恢复 10% 最大生命。',
  effect: 'spirit-rebirth',
  cooldown: 0,
  multiCast: false,
};

/** 重生要跌几个境界 */
export const SPIRIT_REBIRTH_RANK_DROP = 1;
/** 重生后修为按原门槛的多少分之一算（1/2） */
export const SPIRIT_REBIRTH_EXP_DIV = 2;
/** 重生后恢复多少比例的最大生命 */
export const SPIRIT_REBIRTH_HP_RATIO = 0.1;

/** 剑气纵横的基础射程（格） */
export const SWEEP_BASE_REACH = 3;
/** 境界每提高这么多级，剑气射程再 +1 格（向上取整） */
export const SWEEP_REACH_STEP = 3;
/** 剑气纵横：挥出一剑本身给多少修为（落空也给） */
export const SWEEP_EXP_CAST = 1;
/** 剑气纵横：每命中一个目标（人或城）额外给多少修为 */
export const SWEEP_EXP_PER_HIT = 5;

/** 某个境界的剑气射程（只吃境界，规则书和实际结算共用） */
export function sweepReachForRank(rank: number): number {
  // 向上取整：1 级就已经 +1 格，9 级是 6 格
  return SWEEP_BASE_REACH + Math.ceil(rank / SWEEP_REACH_STEP);
}

/** 计算剑气纵横的直线长度（距离） */
export function getSwordSweepReach(s: GameState, u: Unit): number {
  // 如果它是修士，就按境界加成算
  if (isCultivatorUnit(s, u)) {
    return sweepReachForRank(getRank(u));
  }
  // 如果是别的兵种（未来扩展）借用了这个技能，默认给个基础值
  return SWEEP_BASE_REACH;
}