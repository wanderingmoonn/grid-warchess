// 单位

import type { UnitTypeDef } from '../types.ts';
import { SPIRIT_REBIRTH_SKILL, SWORD_SWEEP_SKILL } from './skills.ts';

//灵体
export const SPIRIT_CULTIVATOR: UnitTypeDef = {
  id: 'cultivator-spirit',
  name: '灵体',
  short: '灵',
  era: 1,
  category: 'combat',
  cost: 0,
  move: 3,
  atk: 0,
  armor: 0,
  maxHp: 1,
  range: 1,
  vision: 3,
  layer: 'air',
  flight: true, 
  summonedOnly: true,
  abilities: ['qi-true-damage'],
  skills: [SPIRIT_REBIRTH_SKILL],
};
// 炼气士
export const CULTIVATOR: UnitTypeDef = {
  id: 'qi-cultivator',
  name: '炼气士',
  short: '炼',
  era: 1,
  category: 'combat',
  cost: 150,
  move: 2,
  atk: 10,
  armor: 0,
  maxHp: 20,
  range: 1,
  vision: 3,
  abilities: ['qi-true-damage'], 
};
// 剑修
export const SWORD_CULTIVATOR: UnitTypeDef = {
  id: 'sword-cultivator',
  name: '剑修',
  short: '剑',
  era: 2,
  category: 'combat',
  cost: 270, 
  move: 3,
  atk: 8,
  armor: 1,
  maxHp: 20,
  range: 1,
  vision: 3,
  abilities: ['qi-true-damage'], 
  skills: [SWORD_SWEEP_SKILL],
};