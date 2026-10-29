/**
 * 第六时代的两个包：一个开时代，一个装兵。
 *
 * ---------------------------------------------------------------
 * 为什么是两个包，而不是一个
 * ---------------------------------------------------------------
 * 前五个时代是**写死在基础规则里**的：ERAS 有那一行，原版有那一代的兵，
 * 时代兵种包只负责"给这一代多塞几个兵"（见 era-packs.ts）。第六时代不一样——
 * 它连"能不能升上去"都是新的。所以照前五包的分法拆成两个：
 *
 *   「现代」     `era-contemporary`   只做一件事：把时代上限抬到 6（unlockEra）
 *   「现代战争」 `pack-contemporary`  只做一件事：16 个第六代兵种（和 era-packs 同构）
 *
 * 拆开的好处是两者都能被单独讨论：想量"第六时代的经济曲线"，只勾「现代」
 * 就得到一座能升到 6 级、但一件六代装备都没有的空时代（原版第 6 代本来就是空的）；
 * 想要兵，再勾「现代战争」。合在一起写的话，"开了兵却没时代"和
 * "开了时代却没兵"这两种局面都没法复现，调平衡时只能猜。
 *
 * 「现代战争」写了 `requires: ['era-contemporary']`：兵种包单独勾选不生效
 * （开局面板会自动把前置一起勾上）。理由和奇幻系列的前置一样——
 * 一个"勾了却造不出来"的兵种包，在玩家眼里就是坏了。
 *
 * ---------------------------------------------------------------
 * 兵种包的排布：和前五个时代包一个模子
 * ---------------------------------------------------------------
 * 同一个前缀（`cnt_`）、同样的字段顺序、同样"战斗 / 工事 / 经济 / 工程 / 海军"
 * 的分段，单位数量（16）也落在那五包的区间里（12~15，第六代多一格军营）。
 *
 * ---------------------------------------------------------------
 * 兵种尽量按现实来
 * ---------------------------------------------------------------
 * 每个兵都对应一类真实装备，名字用兵种/编制名，不用虚构代号：
 *
 *   机械化步兵   步兵战车搭载的步兵班，车载武器让它不必贴脸（射程 3）
 *   主战坦克     MBT，125mm 滑膛炮打尾翼稳定脱壳穿甲弹（破甲）＋攻坚（破城）
 *   反坦克导弹   便携/车载 ATGM，先手伏击 ＋ 破甲，专治重装甲
 *   特种部队     小队渗透，靠潜行摸后排
 *   自行榴弹炮   155mm 自行火炮，射程 5、溅射 2，能自己挪窝
 *   远程火箭炮   300mm 多管火箭，打的是"一片"（溅射 3），不是"一个"
 *   防空导弹营   车载区域防空，对飞行目标 ×1.6（能力「对空」）
 *   武装直升机   反坦克导弹 + 机炮，飞越水面与林丘（layer air + flight）
 *   察打无人机   高空长航时，视野 6 是它的主武器
 *   导弹驱逐舰   区域防空 + 反舰，水上唯一能跟陆基火力对射的东西
 *   复合装甲墙   城墙线第六环：纯粹的路障，一步都走不了
 *   加固地堡     连发机关炮 + 厚墙，防线的硬芯
 *   前进指挥所   指挥光环 + 可驻军，视野 6
 *   物流集团     现代经济单位（平原最赚，城里做分拨）
 *   工程兵团     会修工事、会架桥的工兵，同时是 camp6 的唯一来源
 *   联合作战中心 第六代军营（军营链条的第六档）
 *
 * ---------------------------------------------------------------
 * 数值口径：和上一代对齐，不"整体更强"
 * ---------------------------------------------------------------
 * 沿用 era-packs.ts 那套粗指标（有效耐久 EHP = maxHp + 2 × armor）：
 * 原版第五时代战斗单位的每金耐久是 0.16~0.32，这个包全部落在 **0.12~0.24**。
 * 也就是说第六代不是"每金更划算"，而是**分工更细、代价更明确**：
 * 反坦克导弹的每金耐久只有 0.12（挨一下就散），换的是"两发带走一辆坦克"；
 * 火箭炮 0.12 换溅射 3；主战坦克 0.24 是全包最贵的正面。
 *
 * 工事不在这条带里：墙和地堡从来都是"每金耐久极高、但一点用都没有"的东西
 * （时代 5 的混凝土墙是 1.21，这里是 1.17），比的是"这条路值不值这些钱"。
 *
 * **射程没有加到 6。** 时代 5 的火箭炮与自行火炮都因为射程 5 以上被打回过
 * （见 era-packs.ts 里那几段"病根不是攻击而是射程"），所以第六代陆炮仍然是
 * 5：这一代的进步写在溅射、连发、对空和空中层上，不写在"更远"上。
 *
 * 一条硬约束：`era: 6` 的单位**不会**被开局白送（setup.ts 只白送 era 1 的战斗单位），
 * 也不会在第五时代的城市里出现（rules 的招募门槛按城市时代判）。
 */

import { DAMAGE_STAGE } from './ability-hooks.ts';
import type { AbilityDef } from './abilities.ts';
import type { Expansion } from './expansions.ts';
import type { UnitTypeDef } from './types.ts';

/* ================================================================== */
/* 能力：对空                                                          */
/* ================================================================== */

/**
 * 「对空」——只在对飞行单位开火时加成。
 *
 * 为什么这条能力一定要有：`layer: 'air'` 的单位会绕开一切地形（河、山、林），
 * 而地面近战**够不着它**（`strikeDistance` 给"地面打空中"多算一格，
 * 射程 1 的单位因此打不到头顶的直升机）。这是空中单位的卖点，
 * 但如果没有专门的解法，它就变成"谁有飞行谁赢"。
 *
 * 现实的解法就是防空导弹：所以这里让它**只**对飞行目标 ×1.6，对地面照旧。
 * 加成放在 postRange 段（射程折扣已经算完、减护甲还没开始），
 * 这样它和「长短皆可」那种"距离折扣"不会互相吃掉。
 *
 * 注意它乘的是**攻击力**，不是最终伤害：46 × 1.6 ＝ 74，再减目标的护甲。
 * 所以一架装甲 6 的直升机吃 68，而装甲 17 的坦克吃 29（没有加成）。
 * 这是刻意的——对空是"打得更准"，不是"无视装甲"。
 */
const ANTI_AIR = 1.6;

const MODERN_ABILITIES: AbilityDef[] = [
  {
    id: 'anti-air',
    name: '对空',
    summary: '打飞行单位（直升机、无人机、飞行兵种）时攻击 ×1.6（护甲照常扣）；打地面目标没有加成。',
    group: 'attack',
    hooks: {
      damage: [
        {
          stage: DAMAGE_STAGE.postRange,
          apply: (c) => {
            if (c.side !== 'attacker' || !c.foe) return;
            const def = c.api.utype(c.state, c.foe.type);
            const flying =
              def.layer === 'air' ||
              c.api.hasAbility(c.state, c.foe, 'fly-over') ||
              c.api.hasAbility(c.state, c.foe, 'fly');
            if (flying) c.damage = Math.round(c.damage * ANTI_AIR);
          },
        },
      ],
    },
  },
];

/* ================================================================== */
/* 时代 6 · 现代（原版 0 个 → 模组 16 个）                             */
/* ================================================================== */

const CONTEMPORARY: UnitTypeDef[] = [
  // ---- 陆军：步兵与装甲 ----
  {
    // 机械化步兵：坐在步兵战车里行军、下车作战的步兵班。
    // 比二战步兵班（340 金 / 41 攻 / 48 血）更贵更硬，但真正拉开的差距是射程 3 ——
    // 车载重机枪与班组自动武器让它不必贴脸。
    id: 'cnt_mechinf',
    name: '机械化步兵',
    short: '机',
    era: 6,
    category: 'combat',
    cost: 380,
    move: 3,
    atk: 54,
    armor: 7,
    maxHp: 62,
    range: 3,
    vision: 4,
  },
  {
    // 主战坦克：正面几乎无解，代价是贵和慢（640 金是全包最贵的地面单位）。
    // 破甲（尾翼稳定脱壳穿甲弹）让它对同级重甲仍然有效，
    // 破城让它能啃动第六代城墙——这两条合起来就是"陆战的核心"。
    id: 'cnt_mbt',
    name: '主战坦克',
    short: '坦',
    era: 6,
    category: 'combat',
    cost: 640,
    move: 3,
    atk: 78,
    armor: 17,
    maxHp: 120,
    range: 3,
    vision: 3,
    abilities: ['armor-pierce', 'siege-master'],
    bio: false,
  },
  {
    // 反坦克导弹分队：三个人扛一具发射器，埋伏在半路等装甲。
    // 先手（first-strike）＋ 破甲，是"坦克杀手"这件事唯一诚实的写法：
    // 它一被摸到就散（护甲 3、血 42），所以卖的是"谁先看见谁先动手"。
    id: 'cnt_atgm',
    name: '反坦克导弹',
    short: '反',
    era: 6,
    category: 'combat',
    cost: 400,
    move: 2,
    atk: 66,
    armor: 3,
    maxHp: 42,
    range: 4,
    vision: 3,
    abilities: ['armor-pierce', 'first-strike'],
  },
  {
    // 特种部队：小队渗透，靠潜行（森林/丘陵）摸到后排。
    // 血薄、射程短，但它能在对面看不见的地方出现——这是它 460 金的理由。
    id: 'cnt_specops',
    name: '特种部队',
    short: '特',
    era: 6,
    category: 'combat',
    cost: 460,
    move: 4,
    atk: 56,
    armor: 5,
    maxHp: 52,
    range: 3,
    vision: 5,
    abilities: ['stealth'],
  },

  // ---- 陆军：炮兵与防空 ----
  {
    // 自行榴弹炮：155mm，射程 5、溅射 2。能自己挪窝，所以比固定炮阵贵。
    // 视野只有 2：它打的是"友军报来的坐标"，这一点靠射程补，不靠眼睛。
    id: 'cnt_sph',
    name: '自行榴弹炮',
    short: '榴',
    era: 6,
    category: 'combat',
    cost: 500,
    move: 2,
    atk: 60,
    armor: 6,
    maxHp: 64,
    range: 5,
    vision: 2,
    splash: 2,
    abilities: ['siege-master'],
    bio: false,
  },
  {
    // 远程火箭炮：300mm 多管，一发覆盖三格（splash 3）。
    // 攻击力压到 40：它清的是"挤在一起的一堆轻甲"，打单体远不如自行榴弹炮。
    id: 'cnt_mlrs',
    name: '远程火箭炮',
    short: '箭',
    era: 6,
    category: 'combat',
    cost: 520,
    move: 2,
    atk: 40,
    armor: 4,
    maxHp: 56,
    range: 5,
    vision: 2,
    splash: 3,
    abilities: ['siege-master'],
    bio: false,
  },
  {
    // 防空导弹营：车载区域防空。对地面仍有 46 攻（自卫），
    // 但对空是 46 × 1.6 ＝ 74 —— 一架 520 金的直升机挨两发就没了。
    id: 'cnt_sam',
    name: '防空导弹营',
    short: '防',
    era: 6,
    category: 'combat',
    cost: 440,
    move: 2,
    atk: 46,
    armor: 4,
    maxHp: 58,
    range: 5,
    vision: 5,
    abilities: ['anti-air'],
    bio: false,
  },

  // ---- 空中 ----
  {
    // 武装直升机：反坦克导弹 + 机炮。layer air = 与地面互不占格，
    // flight = 能掠过水面（河防对它不成立）。
    // 它的天敌是防空导弹（对空 ×1.6）——这条克制关系是整个包的骨架。
    id: 'cnt_heli',
    name: '武装直升机',
    short: '直',
    era: 6,
    category: 'combat',
    cost: 520,
    move: 5,
    atk: 58,
    armor: 6,
    maxHp: 66,
    range: 4,
    vision: 5,
    abilities: ['armor-pierce'],
    flight: true,
    layer: 'air',
    bio: false,
  },
  {
    // 察打无人机：高空长航时。视野 6 是它的主武器，
    // 攻击 34 只够点掉落单的炮兵和工程队——让它能打，但打不疼。
    id: 'cnt_uav',
    name: '察打无人机',
    short: '无',
    era: 6,
    category: 'combat',
    cost: 300,
    move: 4,
    atk: 34,
    armor: 2,
    maxHp: 32,
    range: 5,
    vision: 6,
    flight: true,
    layer: 'air',
    bio: false,
  },

  // ---- 海军 ----
  {
    // 导弹驱逐舰：区域防空 + 反舰，水上唯一能和岸防火力对射的东西。
    // 射程 5、视野 6 是水面上的顶配，代价是 620 金、而且只有临水的城能造。
    id: 'cnt_destroyer',
    name: '导弹驱逐舰',
    short: '驱',
    era: 6,
    category: 'combat',
    cost: 620,
    move: 5,
    atk: 70,
    armor: 13,
    maxHp: 120,
    range: 5,
    vision: 6,
    domain: 'water',
    abilities: ['armor-pierce'],
    bio: false,
  },

  // ---- 工事 ----
  {
    // 复合装甲墙：城墙线第六环（夯土 → 石墙 → 棱堡 → 混凝土胸墙 → 混凝土掩体墙 → 这里）。
    // 240 金换 240 血 + 20 护甲，比同价战斗单位耐得多，但一步都走不了：
    // 到这个时代它已经彻底是"路障"，只剩"让一条路变得很贵"这一个作用。
    id: 'cnt_armorwall',
    name: '复合装甲墙',
    short: '壁',
    era: 6,
    category: 'building',
    cost: 240,
    move: 0,
    atk: 0,
    armor: 20,
    maxHp: 240,
    range: 1,
    vision: 1,
    obstacle: true,
  },
  {
    // 加固地堡：连发机关炮（burst 4）＋ 厚墙，是这个时代防线的硬芯。
    // burst 4 的代价写在伤害公式里：每一下单独减护甲，打重甲等于白打。
    id: 'cnt_bunker',
    name: '加固地堡',
    short: '堡',
    era: 6,
    category: 'building',
    cost: 360,
    buildCost: 60,
    move: 0,
    atk: 36,
    armor: 16,
    maxHp: 100,
    range: 4,
    vision: 3,
    burst: 4,
    autoAttack: true,
  },
  {
    // 前进指挥所：不还手，但给相邻友军 +2 攻（指挥光环）、
    // 站上去的部队多 3 点护甲（可驻军），视野 6。
    // 它的价值不在自己打，而在"把一片阵地变硬"。
    id: 'cnt_hq',
    name: '前进指挥所',
    short: '所',
    era: 6,
    category: 'building',
    cost: 400,
    buildCost: 50,
    move: 0,
    atk: 0,
    armor: 11,
    maxHp: 96,
    range: 1,
    vision: 6,
    garrison: true,
    abilities: ['aura-command'],
  },

  // ---- 经济与工程 ----
  {
    // 物流集团：现代经济单位。仓库、车队、枢纽都在平原上，所以平原最赚；
    // 城里只做分拨（26），林丘是末端配送（16 / 14）。
    id: 'cnt_logistics',
    name: '物流集团',
    short: '物',
    era: 6,
    category: 'economy',
    cost: 330,
    move: 3,
    atk: 4,
    armor: 4,
    maxHp: 34,
    range: 1,
    vision: 3,
    incomeByTerrain: { plain: 40, city: 26, forest: 16, hill: 14 },
  },
  {
    // 工程兵团：会修工事、会架桥的工兵，也是 camp6 的唯一来源。
    // buildPower 40 —— 比二战战斗工兵的 32 高一头，一座第六代工事基本一回合起。
    // 它不盖前五个时代的建筑：那些交给各代的工兵，这一代只碰现代工事。
    id: 'cnt_engineer',
    name: '工程兵团',
    short: '工',
    era: 6,
    category: 'builder',
    cost: 320,
    move: 2,
    atk: 6,
    armor: 5,
    maxHp: 34,
    range: 1,
    vision: 2,
    buildPower: 40,
    builds: ['cnt_armorwall', 'cnt_bunker', 'cnt_hq', 'camp6', 'bridge3'],
  },

  // ---- 军营 ----
  {
    // 联合作战中心：兵营链条的第六档（军营→寨垒→堡寨→兵站→前进基地→这里）。
    // 和前面五档一样取"落成时最近城市的时代"，所以想要第六代兵，
    // 就得把城升到第六时代之后再造它。
    id: 'camp6',
    name: '联合作战中心',
    short: '联',
    era: 6,
    category: 'building',
    cost: 380,
    buildCost: 40,
    move: 0,
    atk: 22,
    armor: 10,
    maxHp: 92,
    range: 1,
    vision: 6,
    autoAttack: true,
    barracks: true,
    buildOn: ['plain', 'hill'],
    requiresWater: true,
  },
];

/* ================================================================== */
/* 注册                                                                */
/* ================================================================== */

/**
 * 「现代」——把科技线抬到第六时代的那一格。
 *
 * 它不带任何兵种：基础规则的第六代兵种表本来就是空的（见 config.ts 的
 * `BASE_MAX_ERA`），这一包只是把"能不能升上去"这道闸打开。
 * 归册归到小型扩展合订本：它确实只是一个开关，一行说明就够了。
 */
export const CONTEMPORARY_ERA: Expansion = {
  id: 'era-contemporary',
  name: '现代',
  scale: 'small',
  summary:
    '科技线往后接一格：城市可以升到第六时代「现代」（升级费 1080，城市耐久 96、护甲 14、收入 62）。' +
    '这个包本身不带兵种——第六代装备在「现代战争」里；不勾它，城市升到二战就封顶。',
  /**
   * 这一条就是"第六时代"的开关。
   * 不写它，ERAS 里那一行只是数值（见 config.ts 的 BASE_MAX_ERA）。
   */
  unlockEra: 6,
  hooks: {},
};

/** 「现代战争」——第六代的兵种包，和 era-packs.ts 里那五个一个模子 */
export const MODERN_WARFARE: Expansion = {
  id: 'pack-contemporary',
  name: '现代战争',
  scale: 'large',
  summary:
    '第六代兵种：机械化步兵、主战坦克、反坦克导弹、特种部队、自行榴弹炮、远程火箭炮、防空导弹、武装直升机、察打无人机与导弹驱逐舰，外加复合装甲墙、加固地堡、前进指挥所、物流集团、工程兵团与联合作战中心。',
  /**
   * 兵种包不自己开时代：时代是「现代」那一包的事。
   * 单独勾这一包会整包不进场（前置没满足），开局面板会先把「现代」补上。
   */
  requires: ['era-contemporary'],
  hooks: {},
  abilities: MODERN_ABILITIES,
  units: CONTEMPORARY,
};
