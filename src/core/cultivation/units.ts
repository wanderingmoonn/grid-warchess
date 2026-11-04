// 单位

import type { UnitTypeDef } from '../types.ts';
import { SPIRIT_REBIRTH_SKILL, SWORD_SWEEP_SKILL } from './skills.ts';
import { SPIRIT_STONE } from './resources.ts';
import { GOLD } from '../resources.ts';

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
export const SERVANT: UnitTypeDef = {
  id: 'cultivation-servant',
  name: '仆役',
  short: '仆',
  era: 2,
  category: 'builder',
  cost: 50,
  move: 2,
  atk: 0,
  armor: 0,
  maxHp: 20,
  range: 0,
  vision: 2,
  builds: ['cultivation-spirit-field', 'cultivation-spirit-mine'],
  buildPower: 10,
};
export const SPIRIT_FIELD: UnitTypeDef = {
  id: 'cultivation-spirit-field',
  name: '灵田',
  short: '田',
  era: 2,
  category: 'building',
  cost: 80, // 纯金币消耗
  move: 0,
  atk: 0,
  armor: 1,
  maxHp: 40,
  range: 0,
  vision: 1,
  yield: { [GOLD]: 2, [SPIRIT_STONE]: 1 },
  yieldByTerrain: {
    plain: { [GOLD]: 5, [SPIRIT_STONE]: 1 },
    forest: { [GOLD]: 2, [SPIRIT_STONE]: 3 },
  },
};
export const SPIRIT_MINE: UnitTypeDef = {
  id: 'cultivation-spirit-mine',
  name: '灵矿',
  short: '矿',
  era: 3,
  category: 'building',
  cost: 60,
  costRes: { [SPIRIT_STONE]: 30 },
  move: 0,
  atk: 0,
  armor: 2,
  maxHp: 60,
  range: 0,
  vision: 1,
  yield: { [GOLD]: 3, [SPIRIT_STONE]: 2 },
  yieldByTerrain: {
    hill: { [GOLD]: 3, [SPIRIT_STONE]: 4 }, // 丘陵加灵石
  },
};