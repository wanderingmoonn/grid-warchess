// 单位

import type { UnitTypeDef } from '../types.ts';
// 技能的 SkillDef 和数值常量都在 skills/ 下：一个技能一个文件。
// 这里只负责把它们挂到兵种身上，不重复定义。
import { BLOOD_RITE_SKILL, SPIRIT_REBIRTH_SKILL, SPRING_SURGE_SKILL, SWORD_SWEEP_SKILL, TOWER_CHARGE_SKILL, TELEPORT_SKILL } from './skills/index.ts';
import { SPIRIT_STONE } from './resources.ts';
import { UNIT_IDS } from './identity.ts';
import { ARTIFACT_SPIRIT_ID, WARM_NOURISH_ID } from './artifacts.ts';
import { FIRE_QI_ID, STONE_WARD_ID, SWORD_QI_ID } from './abilities/artifact-auras.ts';
import { CHILL_HIT_ID, SUNDER_HIT_ID } from './abilities/artifact-effects.ts';
import { GOLD } from '../resources.ts';
import { nextUpgradeCost } from '../config.ts';

/**
 * 修士的金币造价：**升到下一时代花费的一半**。
 *
 * 用现成的经济刻度定价，而不是每支修士各拍一个数：升铁器 220、升火器 360、
 * 升蒸汽 540，于是 1/2/3 代修士落在 110/180/270——玩家自己就能算出
 * "两个修士 ≈ 一次升代的预算"。以前那套 150/270/240/300 是逐个拍的，
 * 结果是修士全线贵过本体同代兵种（2 代剑修 270 vs 骑士 95），
 * 打起来就是"等你养出一个像样的修士，对面的长枪已经推到家门口了"。
 *
 * 1 代借的是"升到 2 代"那一笔（220），不是 `ERAS[0].upgradeCost`（0）——
 * 否则炼气士会变成白送。
 *
 * 这条只覆盖**有境界成长的五支修士**：法器、阵法、建筑各有各的定位，
 * 不跟时代升级挂钩（法器是"给修士配的装备"，贵在功能不在人头）。
 */
function cultivatorCost(era: number): number {
  return (nextUpgradeCost(era) ?? 0) / 2;
}

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
  cost: cultivatorCost(1),
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
  cost: cultivatorCost(2),
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
  cost: cultivatorCost(2),
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
  cost: cultivatorCost(3),
  move: 2,
  atk: 6,
  armor: 1,
  maxHp: 22,
  range: 1,
  vision: 3,
  abilities: ['qi-true-damage'],
  skills: [BLOOD_RITE_SKILL],
};

/**
 * 魂修（时代 3）：唯一一支"死了不掉战斗力"的修士。
 *
 * 它的强度**不在活着的时候**——数值只和同代持平，也没有主动技能。
 * 真正的价值在化灵：普通修士肉身一碎，技能散掉、境界血掉七成、攻击只剩一成；
 * 魂修一样都不掉。
 *
 * 三处判据共用 `identity.ts` 的 `SOUL_MASTER_IDS`（`isWeakenedSpirit` /
 * `spirit-ascension` 的两处特例），所以这里不需要写任何"魂修专属"字段——
 * 加一个 id 就够。
 *
 * 因此正确的用法是"把它当耗材使"：它死得起，别的修士死不起。
 * 时代 3 才给，是因为"死得起"在低境界没意义：那时血量本来就薄，
 * 而化灵本身要 4 期。太晚出场会来不及升级。
 */
export const SOUL_CULTIVATOR: UnitTypeDef = {
  id: UNIT_IDS.SOUL_CULTIVATOR,
  name: '魂修',
  short: '魄',
  era: 3,
  category: 'combat',
  cost: cultivatorCost(3),
  move: 2,
  atk: 8,
  armor: 1,
  maxHp: 24,
  range: 1,
  vision: 3,
  abilities: ['qi-true-damage'],
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
    UNIT_IDS.SECT,
    UNIT_IDS.SCRIPTURE_PAVILION,
    UNIT_IDS.SILENT_PAVILION,
    UNIT_IDS.ALCHEMY_FURNACE,
  ],
  buildPower: 18,
};

/**
 * 管事（时代 4）：仆役 → 执事 → 管事，这一列是修真包里的"建造工人"线。
 *
 * 它比执事多会两样东西：二、三档炼器炉，以及灵泉。不新开「炼器师」是因为这条线的语义
 * 本来就是"谁在替宗门干活"——摆阵有阵师，炼器归管事，各管一摊；
 * 灵泉也一样：开泉取水是宗门的家务事，归管事。宗门大殿执事就会盖，它只是继承。
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
    UNIT_IDS.SPIRIT_SPRING,
    UNIT_IDS.SECT,
    UNIT_IDS.SCRIPTURE_PAVILION,
    UNIT_IDS.SILENT_PAVILION,
    UNIT_IDS.ALCHEMY_FURNACE,
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

// ── 静心阁（2026-11-08）────────────────────────────
//
// 藏经阁的对称件：一个往里装，一个往外倒。
//   · 藏经阁：站在旁边可以**学**一门法术，还给阵营 +2 研发额度；
//   · 静心阁：站在旁边可以**忘**掉一门法术，腾出自己的法术位。
//
// 造型、造价、耐久、选址条件都和藏经阁一样（1×1、贴着自家宗门），
// 差别只在按钮上——玩家不用再学一套新的建筑语言。
//
// 它不给任何额度、不产资源：法术位由境界决定，忘掉一门只是把那个位置空出来。
// 想多背，只能修炼；想换一门，来这里。

export const SILENT_PAVILION: UnitTypeDef = {
  id: UNIT_IDS.SILENT_PAVILION,
  name: '静心阁',
  short: '静',
  era: 3,
  category: 'building',
  cost: 120,
  costRes: { 'spirit-stone': 10 },
  buildCost: 20,
  move: 0,
  atk: 0,
  armor: 3,
  maxHp: 60,
  range: 1,
  vision: 3,
  adjacent: { unit: [UNIT_IDS.SECT] },
};

// ── 炼丹炉（2026-11-08）────────────────────────────
//
// 丹药只能在炉子旁边炼，但**动作的发起者是修士，不是炉子**：
// 选中修士 → 面板「炼丹」组 → 花金币和灵石，丹直接进他自己的袋子。
//
// 这是和炼器系统"错开"的地方：炼器炉是产兵建筑（产物是单位，走 produceAt），
// 炼丹炉不产单位，所以它退化成一个**站位条件**——和藏经阁之于法术完全同构。
// 好处是核心一个字不用改：不用新动作、不用库存、不用生产队列。
//
// 选址不限（不像藏经阁要贴宗门）：丹药是补给，前线后方都该能起炉子。
// "打完仗要回炉子旁边补药"这件事本身就是它的物流成本。

export const ALCHEMY_FURNACE: UnitTypeDef = {
  id: UNIT_IDS.ALCHEMY_FURNACE,
  name: '炼丹炉',
  short: '丹',
  era: 3,
  category: 'building',
  // 比藏经阁便宜一点：它不给任何被动加成，价值全在"能炼什么"上
  cost: 110,
  costRes: { 'spirit-stone': 8 },
  // 执事 18 点 → 一回合立起来。小设施不该占两回合
  buildCost: 18,
  move: 0,
  atk: 0,
  armor: 2,
  maxHp: 50,
  range: 1,
  vision: 2,
};

// ── 藏经阁（2026-11-08）────────────────────────────
//
// 学法术的地方。必须**贴着自家宗门**：`adjacent` 是既有的选址条件（脚下 + 四邻），
// 宗门的四格都算，所以贴着它任意一面墙都能起一座。
//
// 两件事都跟"贴着宗门"有关：
//   · 建的时候：旁边必须已经有一座宗门（否则点不下去）；
//   · 建成之后：宗门一旦被拆，这座楼**自动失效**——它给的 +2 法术位立刻消失，
//     站在旁边也读不了书（见 spells.ts 的 libraryIsActive）。
//
// 没有数量上限：宗门周围的空位本身就是上限。堆十座藏经阁的代价是十格地和
// 十次施工，而它们全都贴着同一座宗门——那是玩家的选择，不是需要额外拦的事。

export const SCRIPTURE_PAVILION: UnitTypeDef = {
  id: UNIT_IDS.SCRIPTURE_PAVILION,
  name: '藏经阁',
  short: '经',
  era: 3,
  category: 'building',
  cost: 120,
  costRes: { 'spirit-stone': 10 },
  // 执事每回合 18 点 → 两回合立起来。藏书楼不该比宗门还难盖
  buildCost: 20,
  move: 0,
  atk: 0,
  armor: 3,
  maxHp: 60,
  range: 1,
  vision: 3,
  adjacent: { unit: [UNIT_IDS.SECT] },
};

// ── 宗门大殿（2026-11-08）──────────────────────────
//
// 一座 2×2 的大建筑，自己不打人、不产资源，两个功能全挂在**贴着它站的修士**上：
//   · 招募弟子：相邻有哪位 ≥2 期的修士，就能用灵石招哪位（规则在 hooks.ts 的
//     produceBlocked + 定价钩子，纯查询在 sect.ts）；
//   · 传承：贴着宗门打坐的低阶修士效率按"师徒境界差"放大（见 sect.ts 的 sectLegacyMul）。
//
// 所以它该修在修士堆里——师父走了就停产，弟子走了就吃不到传承。
// 这是它唯一的"操作"，也是它为什么值 2×2 四格。

export const SECT: UnitTypeDef = {
  id: UNIT_IDS.SECT,
  name: '宗门大殿',
  short: '宗',
  era: 3,
  category: 'building',
  // 四格：占满一圈徒弟的位置，也挡得住路——大建筑该有的代价
  footprint: 2,
  cost: 200,
  costRes: { 'spirit-stone': 20 },
  // 执事每回合 18 点 → 三回合；管事 24 点 → 两回合。宗门是"立起来要时间"的东西
  buildCost: 48,
  move: 0,
  atk: 0,
  armor: 5,
  maxHp: 120,
  range: 1,
  vision: 4,
  /*
   * 名单写死四条流派，能不能招由 `produceBlocked` 按"相邻师父"判。
   *
   * 为什么不把名单做成动态的：产兵面板的候选列表读的就是这份白名单，
   * 名单里有的会**灰着列出来并写明缺什么**（"附近没有 2 期以上的剑修师傅"）。
   * 动态名单会让玩家永远不知道自己错过了什么，也没有"把师父搬过来"的目标。
   */
  produce: {
    units: [UNIT_IDS.QI_CULTIVATOR, UNIT_IDS.SWORD_CULTIVATOR, UNIT_IDS.BODY_CULTIVATOR, UNIT_IDS.BLOOD_CULTIVATOR],
  },
};

// ── 灵泉（2026-11-08）──────────────────────────────
//
// 加它的直接原因是寒水镜：那件法器的产地写的是"水面或浅滩"，而**地图不一定生成水**。
// 没有水、又没有备用产地，整条水系法器就是一张废纸。灵泉既是那张备用产地，
// 也是一座自己的支援建筑——一举两得。
//
// 它不产资源、不能攻击（atk 0，和阵法同一个口径：写个 5 反而让玩家以为它能打），
// 全部价值在「泉涌」上。技能数值与计费在 skills/spirit-spring.ts，
// 这里只负责"它长什么样、多少钱、谁能盖"。

export const SPIRIT_SPRING: UnitTypeDef = {
  id: UNIT_IDS.SPIRIT_SPRING,
  name: '灵泉',
  short: '泉',
  era: 4,
  category: 'building',
  cost: 150,
  costRes: { 'spirit-stone': 18 },
  // 管事每回合 24 点，要两回合才立起来——它是"后方设施"，不该一夜之间冒出来
  buildCost: 30,
  move: 0,
  atk: 0,
  armor: 5,
  maxHp: 70,
  range: 1,
  vision: 3,
  skills: [SPRING_SURGE_SKILL],
};

// ── 炼器（2026-11-08）──────────────────────────────
//
// 炼器炉用的是"军营那套产兵逻辑"，一行新规则都没有：
//   · 能造什么 = `produce.units` 白名单；
//   · 能不能造 = 炉子**自己的**时代（era）≥ 法器的 era；
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
  // 多认一样：水边（或灵泉旁）的寒水镜
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

/**
 * 法器用哪条"会飞"的能力：`fly-over`（**名字叫「飞行」**，2026-11-08 改名后）。
 *
 * 注意 id 和名字对不上：`fly` 现在叫「掠空」（只掠水、仍在地面层），
 * `fly-over` 才叫「飞行」（真正在空中层）。这条只在 abilities.ts 里解释一次，
 * 这里写死 id 是为了让"法器悬浮在头顶"这件事有据可查。
 *
 * 选了空中层，连带三件事（都是规则自然推出来的，不是额外加的）：
 *   · 图标缩小、画在上层；
 *   · 地形一概不挡——水面、深水、高山都能停；
 *   · 地面单位打它时距离 +1，所以射程 1 的近战够不着，除非敌人站到同一格压着打。
 *
 * 之前用的是「掠空」（只掠水、不下水层不悬空），代价是"飞剑贴地爬"这件事
 * 和「御剑」的画面差得太远；换成真飞行之后，它才真的像一件被人遥控的器物。
 */
const FLY_ABILITY = 'fly-over';

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
  abilities: [ARTIFACT_SPIRIT_ID, WARM_NOURISH_ID, SWORD_QI_ID, FLY_ABILITY],
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
  cost: 180,
  costRes: { 'spirit-stone': 10 },
  /*
   * 一块"砸下去的印"：攻低、甲厚、血多、慢、射程短，但**能溅**。
   *
   * 和青木剑正好相反——那一件是"跑得快、打得远、皮薄"，
   * 这一件是"站得住、打得近、一下能扫到旁边的人"。
   * 它是四件法器里唯一不靠机动吃饭的，所以飞行只是"能过河"，不改它的定位。
   */
  move: 2,
  atk: 12,
  armor: 9,
  maxHp: 52,
  range: 1,
  vision: 2,
  splash: 1,
  abilities: [ARTIFACT_SPIRIT_ID, WARM_NOURISH_ID, STONE_WARD_ID, FLY_ABILITY],
  /*
   * 丘陵，或者两块灵矿。
   *
   * 2 代还造不出灵矿（它是 3 代建筑），所以"或"这半边在前期永远不成立——
   * 这是有意的兜底：**地图没生成丘陵时**，玩家升到 3 代、开一座灵矿
   * 仍然能把这个产品线救回来，不至于整件法器作废。
   */
  produceNear: [{ terrain: ['mountain', 'hill'] }, { unit: [UNIT_IDS.SPIRIT_MINE], count: 2 }],
};

export const ARTIFACT_WATER: UnitTypeDef = {
  id: UNIT_IDS.ARTIFACT_WATER,
  name: '寒水镜',
  short: '水',
  era: 3,
  category: 'combat',
  campOnly: true,
  artifact: true,
  cost: 190,
  costRes: { 'spirit-stone': 12 },
  /*
   * 远程控制。攻击力刻意不如同代火枪兵（23），换来的是射程、视野和**面**：
   * 溅射 2 格，而且被打到的都会被冻慢。它不是杀伤单位，是"让你的阵型走不动"。
   */
  move: 2,
  atk: 16,
  armor: 3,
  maxHp: 30,
  range: 4,
  vision: 5,
  splash: 2,
  abilities: [ARTIFACT_SPIRIT_ID, WARM_NOURISH_ID, CHILL_HIT_ID, FLY_ABILITY],
  /*
   * 两种产地，满足其一就行：
   *   · 水面或浅滩——"寒水"，最直白的一条；
   *   · 或者挨着一座灵泉。
   *
   * 第二条是**为了没有水的地图**：地图生成不保证有河湖，而这一件是整条
   * 水系唯一的产物，没有备用产地就等于"这张图这条线不存在"。
   * 灵泉本身是四代建筑（见 SPIRIT_SPRING），所以这条后路要等管事出来才通——
   * 三代之前仍然得找水。这是有意的时代门槛，不是遗漏。
   */
  produceNear: [{ terrain: ['water', 'shallow'] }, { unit: [UNIT_IDS.SPIRIT_SPRING] }],
};

export const ARTIFACT_FIRE: UnitTypeDef = {
  id: UNIT_IDS.ARTIFACT_FIRE,
  name: '赤炎珠',
  short: '炎',
  era: 4,
  category: 'combat',
  campOnly: true,
  artifact: true,
  cost: 260,
  costRes: { 'spirit-stone': 16 },
  /*
   * 远程 AOE：四件里伤害最高的一件，代价是射程比寒水镜短一格。
   * 溅射 2 格 + 「熔甲」＝ 一炮把一片阵型的护甲打对折，
   * 后面跟上来的近战就有了破口。它是"开团的那一下"，不是持续输出。
   */
  move: 2,
  atk: 30,
  armor: 3,
  maxHp: 34,
  range: 3,
  vision: 4,
  splash: 2,
  abilities: [ARTIFACT_SPIRIT_ID, WARM_NOURISH_ID, SUNDER_HIT_ID, FIRE_QI_ID, FLY_ABILITY],
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

/*
 * ── 召唤物（族 8）────────────────────────────────────────────────
 *
 * 这三个**只能由法术造出来**：建造表里没有它们，城市产线也不供应。
 * 所以 `cost` 写 0——它们不该在任何"造得起/造不起"的判断里出现。
 */

/**
 * 替劫灵身：替主人挨刀的傀儡。
 *
 * `move: 0` 且 `atk: 0` 是刻意的：它不是一个能打的单位，只是"一层会死的护甲"。
 * 给它行动力会让玩家拿它去探路，那就变成两个单位了。
 */
export const LING_SHEN: UnitTypeDef = {
  id: UNIT_IDS.LING_SHEN,
  name: '替劫灵身',
  short: '劫',
  era: 1,
  category: 'combat',
  cost: 0,
  move: 0,
  atk: 0,
  armor: 3,
  maxHp: 50,
  range: 1,
  vision: 2,
};

/**
 * 化身分神造出来的分身：和本体同兵种、同境界，能行动。
 *
 * 单独一个兵种而不是直接复制修士，是为了让"分身"在面板上有个说得清的名字
 * （否则战报里会出现两个同名修士，玩家分不清哪个是真身）。
 */
export const CLONE: UnitTypeDef = {
  id: UNIT_IDS.CLONE,
  name: '化身',
  short: '化',
  era: 1,
  category: 'combat',
  cost: 0,
  move: 3,
  atk: 10,
  armor: 3,
  maxHp: 30,
  range: 1,
  vision: 3,
};

/** 众妙之门：光环建筑。每回合给半径内的友方修士添一份修为。 */
export const MIAO_MEN: UnitTypeDef = {
  id: UNIT_IDS.MIAO_MEN,
  name: '众妙之门',
  short: '门',
  era: 1,
  category: 'building',
  cost: 0,
  move: 0,
  atk: 0,
  armor: 4,
  maxHp: 60,
  range: 1,
  vision: 4,
};

/**
 * 魂灯：死亡锚点。主人倒下时，灯会把他的魂魄接住一次。
 *
 * 它本身没有任何战斗力，所以敌方要不要花一刀去拆灯，是一笔很真实的选择。
 */
export const HUN_DENG: UnitTypeDef = {
  id: UNIT_IDS.HUN_DENG,
  name: '魂灯',
  short: '灯',
  era: 1,
  category: 'building',
  cost: 0,
  move: 0,
  atk: 0,
  armor: 2,
  maxHp: 40,
  range: 1,
  vision: 4,
};
