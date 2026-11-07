// 单位

import type { UnitTypeDef } from '../types.ts';
// 技能的 SkillDef 和数值常量都在 skills/ 下：一个技能一个文件。
// 这里只负责把它们挂到兵种身上，不重复定义。
import { SPIRIT_REBIRTH_SKILL, SWORD_SWEEP_SKILL, TOWER_CHARGE_SKILL, TELEPORT_SKILL } from './skills/index.ts';
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
  skills: [TOWER_CHARGE_SKILL]
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

// ── 阵法（2026-11-06）──────────────────────────────
//
// 阵法是**建筑**：不能动、会被打、会挡路。它们不靠攻击力吃饭，而是给周围的
// 单位改数值，所以 atk 一律写 0——写个 5 反而会让玩家以为它能打。
//
// 建造它们的不是仆役，是专门的阵师；阵师自己也吃灵石造价，因为摆阵是修真的事，
// 不该用金币从本体经济里买。
//
// 时代门槛靠 builds 白名单递增表达：三代的阵师只会杀伐阵，四代才会封印阵。

export const FORMATION_MASTER: UnitTypeDef = {
  id: UNIT_IDS.FORMATION_MASTER,
  name: '阵师',
  short: '阵',
  era: 3,
  category: 'builder',
  cost: 120,
  costRes: { 'spirit-stone': 6 },
  move: 2,
  atk: 6,
  armor: 2,
  maxHp: 24,
  range: 1,
  vision: 2,
  builds: [UNIT_IDS.KILL_FORMATION],
  buildPower: 10,
};

export const FORMATION_MASTER_2: UnitTypeDef = {
  id: UNIT_IDS.FORMATION_MASTER_2,
  name: '大阵师',
  short: '阵',
  era: 4,
  category: 'builder',
  cost: 170,
  costRes: { 'spirit-stone': 9 },
  move: 2,
  atk: 8,
  armor: 3,
  maxHp: 30,
  range: 1,
  vision: 3,
  // 大阵师：杀伐 / 封印 / 守御。守御阵是他这一代才有的东西（阵要有人守才立得住）
  builds: [UNIT_IDS.KILL_FORMATION, UNIT_IDS.SEAL_FORMATION, UNIT_IDS.GUARD_FORMATION],
  buildPower: 14,
};

export const FORMATION_MASTER_3: UnitTypeDef = {
  id: UNIT_IDS.FORMATION_MASTER_3,
  name: '天阵师',
  short: '阵',
  era: 5,
  category: 'builder',
  cost: 220,
  costRes: { 'spirit-stone': 12 },
  move: 2,
  atk: 10,
  armor: 4,
  maxHp: 36,
  range: 1,
  vision: 3,
  builds: [
    UNIT_IDS.KILL_FORMATION,
    UNIT_IDS.SEAL_FORMATION,
    UNIT_IDS.GUARD_FORMATION,
    UNIT_IDS.TELEPORT_FORMATION,
  ],
  buildPower: 18,
};

export const KILL_FORMATION: UnitTypeDef = {
  id: UNIT_IDS.KILL_FORMATION,
  name: '杀伐阵',
  short: '杀',
  era: 3,
  category: 'building',
  cost: 80,
  costRes: { 'spirit-stone': 8 },
  buildCost: 14,
  move: 0,
  atk: 0,
  armor: 4,
  maxHp: 30,
  range: 1,
  vision: 2,
  abilities: ['formation-kill'],
};

export const SEAL_FORMATION: UnitTypeDef = {
  id: UNIT_IDS.SEAL_FORMATION,
  name: '封印阵',
  short: '封',
  era: 4,
  category: 'building',
  cost: 100,
  costRes: { 'spirit-stone': 12 },
  buildCost: 16,
  move: 0,
  atk: 0,
  armor: 5,
  maxHp: 34,
  range: 1,
  vision: 2,
  abilities: ['formation-seal'],
};

export const TELEPORT_FORMATION: UnitTypeDef = {
  id: UNIT_IDS.TELEPORT_FORMATION,
  name: '传送阵',
  short: '传',
  era: 5,
  category: 'building',
  cost: 140,
  costRes: { 'spirit-stone': 18 },
  buildCost: 20,
  move: 0,
  atk: 0,
  armor: 4,
  maxHp: 32,
  range: 1,
  vision: 3,
  // 只有主动技能，没有被动光环：它的价值全在"能把兵搬到哪"
  skills: [TELEPORT_SKILL],
};

/**
 * 守御阵：唯一的"替友军挨打"建筑。
 *
 * 80 血不是随手写的：三代戟兵 21 攻打 6 甲只有 15 点，能挡 5 下；
 * 如果照着别的阵给 30 血，两下就没了，那不叫守御。
 * 它自己没有攻击手段，续航全靠旁边那个修士的血（见 formation-guardian.ts）。
 */
export const GUARD_FORMATION: UnitTypeDef = {
  id: UNIT_IDS.GUARD_FORMATION,
  name: '守御阵',
  short: '守',
  era: 4,
  category: 'building',
  cost: 110,
  costRes: { 'spirit-stone': 14 },
  // 大阵师每回合投 14 点，所以要两回合立起来；天阵师 18 点一回合成型
  buildCost: 18,
  move: 0,
  atk: 0,
  armor: 6,
  maxHp: 80,
  range: 1,
  vision: 2,
  abilities: ['formation-guardian'],
};
