// 单位

import type { UnitTypeDef } from '../types.ts';
import { SPIRIT_REBIRTH_SKILL, SWORD_SWEEP_SKILL } from './skills.ts';
import { SPIRIT_STONE } from './resources.ts';
import { UNIT_IDS } from './identity.ts';
import { GOLD } from '../resources.ts';

//灵体
export const SPIRIT_CULTIVATOR: UnitTypeDef = {
  id: UNIT_IDS.SPIRIT,
  name: '灵体',
  short: '魂',
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
  id: UNIT_IDS.QI_CULTIVATOR,
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
  id: UNIT_IDS.SWORD_CULTIVATOR,
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
  id: UNIT_IDS.SERVANT,
  name: '仆役',
  short: '仆',
  era: 2,
  category: 'builder',
  cost: 75,
  move: 2,
  atk: 4,
  armor: 2,
  maxHp: 20,
  range: 1,
  vision: 2,
  builds: [UNIT_IDS.SPIRIT_FIELD, UNIT_IDS.SPIRIT_TOWER],
  buildPower: 10,
};
export const DEACON: UnitTypeDef = {
  id: UNIT_IDS.DEACON,
  name: '执事',
  short: '执',
  era: 3,
  category: 'builder',
  cost: 110,
  move: 2,
  atk: 6,
  armor: 3,
  maxHp: 25,
  range: 1,
  vision: 2,
  builds: [UNIT_IDS.SPIRIT_FIELD, UNIT_IDS.SPIRIT_TOWER, UNIT_IDS.SPIRIT_MINE],
  buildPower: 18,
};

/** 灵矿每相邻一座高山，额外产出多少灵石（钩子在 hooks.ts，规则书要引用） */
export const MINE_MOUNTAIN_STONE_BONUS = 2;
/** 散灵台「释放灵气」一次给几次攻击次数 */
export const TOWER_BURST_CHARGES = 3;
/** 散灵台「释放灵气」每次耗多少灵石 */
export const TOWER_CHARGE_COST = 5;

export const SPIRIT_TOWER: UnitTypeDef = {
  id: UNIT_IDS.SPIRIT_TOWER,
  name: '散灵台',
  short: '灵',
  era: 2,
  category: 'building',
  cost: 60,
  costRes: { 'spirit-stone': 10 },
  buildCost: 15,
  move: 0,
  atk: 12,
  armor: 2,
  maxHp: 28,
  range: 4,
  vision: 5,
  autoAttack: true,
  burst: 0,
  skills: [
    {
      id: 'tower-charge',
      name: '释放灵气',
      summary: `充能：本回合获得 ${TOWER_BURST_CHARGES} 次攻击次数，消耗 ${TOWER_CHARGE_COST} 灵石`,
      effect: 'spirit-tower-shot',
      cooldown: 0,
      multiCast: false, // 一回合只能开一次
    }
  ]
};

export const SPIRIT_FIELD: UnitTypeDef = {
  id: UNIT_IDS.SPIRIT_FIELD,
  name: '灵田',
  short: '田',
  era: 2,
  category: 'building',
  cost: 90,
  buildCost: 20,
  move: 0,
  atk: 2,
  armor: 2,
  maxHp: 30,
  range: 1,
  vision: 2,
  yield: { [GOLD]: 6, [SPIRIT_STONE]: 1 },
  yieldByTerrain: {
    plain:  { [GOLD]: 11, [SPIRIT_STONE]: 1 }, // 平原偏金币
    forest: { [GOLD]: 6,  [SPIRIT_STONE]: 4 }, // 森林偏灵石
  },
  abilities: ['spirit-aura'],
};
export const SPIRIT_MINE: UnitTypeDef = {
  id: UNIT_IDS.SPIRIT_MINE,
  name: '灵矿',
  short: '矿',
  era: 3,
  category: 'building',
  cost: 120,
  costRes: { 'spirit-stone': 20 },
  buildCost: 30,
  move: 0,
  atk: 3,
  armor: 4,
  maxHp: 45,
  range: 1,
  vision: 2,
  yield: { [GOLD]: 5, [SPIRIT_STONE]: 1 },
  yieldByTerrain: {
    hill: { [GOLD]: 5, [SPIRIT_STONE]: 5 },
  },
};