// 天赋、技能与法术

import type { SkillDef } from '../types.ts';

export const SKY_STEP_SKILL: SkillDef = {
  id: 'sky-step',
  name: '御空',
  summary: '在低空与地面之间切换。消耗 1 点移动力，每回合一次。',
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