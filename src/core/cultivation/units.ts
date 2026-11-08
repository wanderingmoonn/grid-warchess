// 单位

import type { UnitTypeDef } from '../types.ts';
// 技能的 SkillDef 和数值常量都在 skills/ 下：一个技能一个文件。
// 这里只负责把它们挂到兵种身上，不重复定义。
import { BLOOD_RITE_SKILL, SPIRIT_REBIRTH_SKILL, SWORD_SWEEP_SKILL, TOWER_CHARGE_SKILL, TELEPORT_SKILL } from './skills/index.ts';
import { SPIRIT_STONE } from './resources.ts';
import { UNIT_IDS } from './identity.ts';
import { ARTIFACT_SPIRIT_ID, WARM_NOURISH_ID } from './artifacts.ts';
import { SWORD_QI_ID } from './abilities/artifact-auras.ts';
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

/**
 * 体修（时代 2）：用身体硬抗的一支。
 *
 * 定位是"站得住"，所以血/甲比同代修士高一截，换来的是**偏科**的境界加成：
 * 攻击 ×1.1，真元、移动、射程各 ×0.5（系数在 stats.ts，别在这里写第二份）。
 * 结果是它前期能顶、后期也能打人，但永远比同伴慢半步、近一格。
 *
 * `body-ward`（金刚不坏）是它的招牌：挨打时按剩余血量减免 30%~50%，
 * 真元与持续伤害不受影响——所以炼气士和剑修天然克它。
 *
 * 30 点基础血不是拍的：同代剑修 20、长枪兵 40，体修夹在中间；
 * 它没有额外的生命成长系数，靠的是减免，所以基础值要给够。
 */
export const BODY_CULTIVATOR: UnitTypeDef = {
  id: UNIT_IDS.BODY_CULTIVATOR,
  name: '体修',
  short: '体',
  era: 2,
  category: 'combat',
  cost: 240,
  move: 2,
  atk: 8,
  armor: 2,
  maxHp: 30,
  range: 1,
  vision: 3,
  abilities: ['qi-true-damage', 'body-ward'],
};

/**
 * 魔修（时代 3）：靠血祭炼化生灵的一支。
 *
 * 它**不走常规修炼路**：打坐只有 1 点（见 progression.ts 的 getExpGrowth），
 * 击杀历练也被关掉（hooks.ts 的 onUnitKilled），全部修为来自「血祭」——
 * 那条路的经验绕过了每回合击杀上限，所以不能再叠一份击杀经验。
 *
 * 代价是实打实的：打坐几乎不涨，血祭每次减 1 年寿元，而且折算率随境界下降
 * （= 越练越亏）。所以它是一支"快到中期很猛、后期必须靠战功续命"的兵。
 *
 * 时代 3 的定位：它是四条流派里唯一有主动 AOE 的一支，攻击基础值最低（6），
 * 换来的是"每一拳都打一圈"——强度主要体现在清场，不是单挑。
 */
export const BLOOD_CULTIVATOR: UnitTypeDef = {
  id: UNIT_IDS.BLOOD_CULTIVATOR,
  name: '魔修',
  short: '魔',
  era: 3,
  category: 'combat',
  cost: 300,
  move: 2,
  atk: 6,
  armor: 1,
  maxHp: 22,
  range: 1,
  vision: 3,
  abilities: ['qi-true-damage'],
  skills: [BLOOD_RITE_SKILL],
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
  builds: [UNIT_IDS.SPIRIT_FIELD, UNIT_IDS.SPIRIT_TOWER, UNIT_IDS.FORGE_1],
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
  builds: [
    UNIT_IDS.SPIRIT_FIELD,
    UNIT_IDS.SPIRIT_TOWER,
    UNIT_IDS.SPIRIT_MINE,
    UNIT_IDS.FORGE_1,
    UNIT_IDS.FORGE_2,
  ],
  buildPower: 18,
};

/**
 * 管事（时代 4）：仆役 → 执事 → 管事，这一列是修真包里的"建造工人"线。
 *
 * 它只比执事多会一样东西：三档炼器炉。不新开「炼器师」是因为这条线的语义
 * 本来就是"谁在替宗门干活"——摆阵有阵师，炼器归管事，各管一摊。
 */
export const STEWARD: UnitTypeDef = {
  id: UNIT_IDS.STEWARD,
  name: '管事',
  short: '管',
  era: 4,
  category: 'builder',
  cost: 150,
  costRes: { 'spirit-stone': 8 },
  move: 2,
  atk: 8,
  armor: 3,
  maxHp: 28,
  range: 1,
  vision: 2,
  builds: [
    UNIT_IDS.SPIRIT_FIELD,
    UNIT_IDS.SPIRIT_TOWER,
    UNIT_IDS.SPIRIT_MINE,
    UNIT_IDS.FORGE_1,
    UNIT_IDS.FORGE_2,
    UNIT_IDS.FORGE_3,
  ],
  buildPower: 24,
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

// ── 炼器（2026-11-08）──────────────────────────────
//
// 炼器炉用的是"军营那套产兵逻辑"，一行新规则都没有：
//   · 能造什么 = `produce.units` 白名单；
//   · 能不能造 = 炉子**自己的**档位（era）≥ 法器的 era；
//   · 在哪能造 = 法器身上的 `produceNear`——同一座炉子换块地就换一条产品线。
//
// 法器全部 `campOnly`：城市产线不供。想造就得把炉子挪到对的地形边上，
// 这是这个系统唯一的"操作"。
//
// 三档炉子走的是和阵师、军营一样的白名单递增：高代炉子不是数值更高，
// 而是**名单更长**——它不改变旧法器的强度，只是多认一种材料。

export const FORGE_1: UnitTypeDef = {
  id: UNIT_IDS.FORGE_1,
  name: '炼器炉',
  short: '炉',
  era: 2,
  category: 'building',
  cost: 140,
  costRes: { 'spirit-stone': 8 },
  buildCost: 18,
  move: 0,
  atk: 0,
  armor: 4,
  maxHp: 90,
  range: 0,
  vision: 3,
  // 炉子自己可以建在林子里：站在森林格上，脚下那格就算"挨着森林"
  buildOn: ['plain', 'hill', 'forest'],
  produce: {
    units: [UNIT_IDS.ARTIFACT_WOOD, UNIT_IDS.ARTIFACT_STONE],
  },
};

export const FORGE_2: UnitTypeDef = {
  id: UNIT_IDS.FORGE_2,
  name: '地火炉',
  short: '炉',
  era: 3,
  category: 'building',
  cost: 200,
  costRes: { 'spirit-stone': 12 },
  buildCost: 26,
  move: 0,
  atk: 0,
  armor: 5,
  maxHp: 120,
  range: 0,
  vision: 3,
  buildOn: ['plain', 'hill', 'forest'],
  // 多认一样：水边的寒水镜
  produce: {
    units: [UNIT_IDS.ARTIFACT_WOOD, UNIT_IDS.ARTIFACT_STONE, UNIT_IDS.ARTIFACT_WATER],
  },
};

export const FORGE_3: UnitTypeDef = {
  id: UNIT_IDS.FORGE_3,
  name: '天工炉',
  short: '炉',
  era: 4,
  category: 'building',
  cost: 280,
  costRes: { 'spirit-stone': 16 },
  buildCost: 34,
  move: 0,
  atk: 0,
  armor: 6,
  maxHp: 150,
  range: 0,
  vision: 4,
  buildOn: ['plain', 'hill', 'forest'],
  produce: {
    units: [
      UNIT_IDS.ARTIFACT_WOOD,
      UNIT_IDS.ARTIFACT_STONE,
      UNIT_IDS.ARTIFACT_WATER,
      UNIT_IDS.ARTIFACT_FIRE,
    ],
  },
};

/*
 * 四件法器。它们都是普通战斗单位（category: 'combat'），只是不能从城市产线出来：
 * 没有境界、不吃修炼经验，就是一件"会动的东西"。
 *
 * 数值按"同代兵略强、但有地形门槛"来定：门槛本身就是成本，所以每一件都比
 * 同代的普通兵高一档；真正的限制是"你得先有炉子，还得把炉子摆在材料边上"。
 */
export const ARTIFACT_WOOD: UnitTypeDef = {
  id: UNIT_IDS.ARTIFACT_WOOD,
  name: '青木剑',
  short: '木',
  era: 2,
  category: 'combat',
  campOnly: true,
  artifact: true,
  cost: 150,
  costRes: { 'spirit-stone': 10 },
  /*
   * 一件"飞剑"：跑得快、打得远，但血薄甲薄。
   *
   * 数值比同代兵略高一档（骑士 17/4/40 攻甲血、移 3 射 1），贵出来的部分是
   * 射程 3 和「剑气环」——前者让它能站在近战射程外开火（对方够不着就不能反击），
   * 后者让它成为一小团兵的火力核心。真正限制它的是造价和产地，不是数值。
   */
  move: 4,
  atk: 18,
  armor: 3,
  maxHp: 36,
  range: 3,
  vision: 3,
  abilities: [ARTIFACT_SPIRIT_ID, WARM_NOURISH_ID, SWORD_QI_ID],
  /*
   * 两种产地，满足其一就行：
   *   · 挨着森林——"林中取材"，最直白的一条；
   *   · 或者挨着两块灵田——灵木得靠灵气养，宗门有田也能凑出来。
   *
   * 第二条是"数量条件"（count: 2），不是"挨着两块田其中一块"。
   * 它让"没森林但田多"的开局也造得出青木剑，不至于整条木系被地形锁死。
   */
  produceNear: [{ terrain: ['forest'] }, { unit: [UNIT_IDS.SPIRIT_FIELD], count: 2 }],
};

export const ARTIFACT_STONE: UnitTypeDef = {
  id: UNIT_IDS.ARTIFACT_STONE,
  name: '玄石印',
  short: '石',
  era: 2,
  category: 'combat',
  campOnly: true,
  artifact: true,
  cost: 110,
  costRes: { 'spirit-stone': 6 },
  move: 1,
  atk: 7,
  armor: 6,
  maxHp: 36,
  range: 1,
  vision: 2,
  abilities: [ARTIFACT_SPIRIT_ID, WARM_NOURISH_ID],
  produceNear: { terrain: ['mountain', 'hill'] },
};

export const ARTIFACT_WATER: UnitTypeDef = {
  id: UNIT_IDS.ARTIFACT_WATER,
  name: '寒水镜',
  short: '水',
  era: 3,
  category: 'combat',
  campOnly: true,
  artifact: true,
  cost: 150,
  costRes: { 'spirit-stone': 8 },
  move: 2,
  atk: 9,
  armor: 2,
  maxHp: 22,
  range: 3,
  vision: 4,
  abilities: [ARTIFACT_SPIRIT_ID, WARM_NOURISH_ID],
  produceNear: { terrain: ['water', 'shallow'] },
};

export const ARTIFACT_FIRE: UnitTypeDef = {
  id: UNIT_IDS.ARTIFACT_FIRE,
  name: '赤炎珠',
  short: '炎',
  era: 4,
  category: 'combat',
  campOnly: true,
  artifact: true,
  cost: 200,
  costRes: { 'spirit-stone': 12 },
  move: 2,
  atk: 13,
  armor: 2,
  maxHp: 26,
  range: 2,
  vision: 3,
  // 炸开一小片：珠子碎了就是一团火
  splash: 1,
  abilities: [ARTIFACT_SPIRIT_ID, WARM_NOURISH_ID],
  // 条件不只看地形，也可以看"旁边有没有某样东西"——地火要从灵矿里引
  produceNear: { unit: [UNIT_IDS.SPIRIT_MINE] },
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
