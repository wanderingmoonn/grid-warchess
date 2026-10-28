/**
 * 全部可调数值集中在这里。
 *
 * 基础兵种严格按真实历史线走：古典 → 中世 → 火药 → 工业 → 现代。
 * 奇想类兵种在 expansions.ts 的「奇想兵种包」里，不勾选就不会出现。
 *
 * 单位分四类：
 *   combat   战斗单位，打仗的
 *   economy  经济单位，站在合适地形上产金（农民在平原、伐木工在森林）
 *   builder  建造单位，自己不产金，但能盖建筑
 *   building 建筑，不能移动；军事建筑自动开火，经济建筑产金
 *
 * 注意：建筑不是凭空造出来的，是**由建造单位走过去盖**出来的。
 * 所以磨坊主不产金，"磨坊"才产金 —— 这更接近历史，也更有决策感。
 */

import type { Terrain, UnitCategory, UnitTypeDef } from './types.ts';

export const CONFIG = {
  boardW: 16,
  boardH: 16,

  /** 每方起始金币 */
  startGold: 120,
  /** 每回合基础收入（与城市无关） */
  baseIncome: 20,
  /**
   * AI 单方产兵上限，**规则层不限制玩家**。
   *
   * 以前这是硬规则，招募时超了直接拒绝。但"编制"这种东西，人其实不需要被管：
   * 钱就那么多、棋盘就那么大、每回合行动就那么几次，堆兵的自然代价比一条
   * 全局上限更有说服力——上限只是在替玩家做取舍决定。
   * 留着它是因为 AI 没有这种自觉：给它自由，它会把钱全换成兵，
   * 前线堆成一坨、后方一座城都不修。所以这条现在是 AI 的自我约束。
   */
  maxUnits: 24,
  /**
   * 指挥官模式：生产序列有几格。
   *
   * 5 是按"能看见但不必算太远"定的——排满 5 格大约对应一次战术周期，
   * 再长就变成开局一次性规划、后面不用管了，这个模式的乐趣恰恰是每回合微调。
   */
  commanderSlots: 5,  /** 建造单位能盖建筑的最大距离（以建造者为中心） */
  buildRange: 2,
  /** 经济单位或经济建筑相邻水域时的额外收入（灌溉、运输之利） */
  riverTradeBonus: 3,

  /**
   * 城市回血：城里有驻军、且城墙外没有敌人时，每回合恢复的耐久。
   *
   * 只加一个基础值 + 每个额外驻军一点点，而不是按比例回满：
   * 城要"守得住"，但不能变成打不动的铁王八。
   */
  cityRegen: 3,
  /** 每个超出第一名的驻军再额外回多少（有上限，见 cityRegenCap） */
  cityRegenPerExtra: 1,
  /** 回血上限：再多人守也不超过这个数 */
  cityRegenCap: 6,

  /** 默认开启战争迷雾 */
  fogDefault: true,
  /** 城市额外提供的视野半径（从城市每一格往外算） */
  cityVision: 1,
  /** 视野外的格子压暗程度，0 不压暗，1 全黑 */
  fogDim: 0.55,

  /**
   * 遣散/拆除时回收的造价比例。
   *
   * 定 0.4 而不是全额：能全额退的话，"造了再拆"就变成零成本的侦察
   * （造个箭塔看一眼对面动向，不需要就退掉）。四成让这个动作有代价，
   * 但又比"扔在场上占着编制、挡着自己的路"划算。
   */
  disbandRefund: 0.4,

  /** 被攻击时的反击伤害系数 */
  counterAttackRatio: 0.5,
  /**
   * 驻军加成：站在自家「可驻军」建筑上的部队额外护甲。
   *
   * 3 点差不多是"多穿一层甲"（同代兵种护甲 2~5），够让一座塔真的能守，
   * 又不足以让一队兵缩进去变成打不动的乌龟。
   */
  garrisonArmor: 3,
  /**
   * 溅射伤害系数：主目标吃满伤害，周围被波及的敌人吃这个比例。
   *
   * 不用满额，是因为炮的定位是"打散阵型"而不是"一发清场"——
   * 满额的话一门炮顶三支部队，前线就只剩炮了。
   */
  splashRatio: 0.5,

  /** 地形防御加成，算进守方护甲 */
  terrainDef: {
    plain: 0,
    forest: 2,
    hill: 3,
    city: 3,
    water: 0,
    // 站不上去的地形，防御加成没有意义
    mountain: 0,
    bridge: 0,
    // 台地：坡陡墙高，但顶上没什么遮挡
    plateau: 3,
    // 谷地：被两边的坡夹着，等于半个掩体
    valley: 2,
    // 沼泽：没掩护，还得站在泥里
    marsh: 0,
    // 沙丘：沙脊上目标明显
    dune: 1,
    // 熔岩浅流：站在流动的岩浆上，没有任何掩护可言
    lava: 0,
    volcano: 0,
  } as Record<Terrain, number>,

  /** 进入一格的移动力消耗，99 表示不可通行。爬坡附加属于「地形高差」扩展，不在这里。 */
  terrainCost: {
    plain: 1,
    forest: 2,
    hill: 2,
    city: 1,
    water: 99,
    mountain: 99,
    // 桥面就是普通路面
    bridge: 1,
    plateau: 2,
    valley: 1,
    marsh: 2,
    dune: 2,
    // 熔岩浅流：能过，但一步顶三步——绕路往往更快
    lava: 3,
    volcano: 99,
  } as Record<Terrain, number>,

  /**
   * 爬坡附加消耗、高度差射程阈值、地形高度表——
   * 都属于「地形高差」扩展，定义在 core/height-terrain.ts 里，
   * 本体不认识"高度"这件事（关掉扩展就完全不存在这套规则）。
   */

  /** 地形中文名，给 UI 用 */
  terrainName: {
    plain: '平原',
    forest: '森林',
    hill: '丘陵',
    city: '城市',
    water: '水域',
    mountain: '高山',
    bridge: '桥',
    plateau: '台地',
    valley: '谷地',
    marsh: '沼泽',
    dune: '沙丘',
    lava: '熔岩浅流',
    volcano: '火山',
  } as Record<Terrain, string>,
};

/**
 * 指挥官模式里"这一格用来升级时代"的哨兵值。
 *
 * 生产序列本来只放兵种 id，但升级同样是"排期"性质的决定——
 * 什么时候把城升上去，直接决定接下来能造什么兵。所以让它占一格，而不是另开一套控件。
 *
 * 用 `@` 开头是为了不和任何兵种 id 撞车（兵种 id 全是纯小写字母）。
 */
export const ORDER_UPGRADE = '@upgrade';

/** 城市参数（与时代无关的部分） */
export const CITY = {  /** 边长：占 size × size 个格子 */
  size: 2,
  /** 被攻陷后易主时保留的血量比例 */
  captureHpRatio: 0.3,
};

/**
 * 不可通行的地形：水、高山、火山。
 * 不能进入、不能建造、不能驻军；高山和火山是纯粹的"天险"，水还额外提供临水收益。
 * 熔岩浅流不在其中——它是"能过，但一步顶三步"，用来给机动判死刑而不是直接堵死。
 */
export function passable(t: Terrain): boolean {
  return t !== 'water' && t !== 'mountain' && t !== 'volcano';
}

export interface EraDef {
  level: number;
  name: string;
  hint: string;
  /** 从上一个时代升到这个时代要花的金币；1 级为 0 */
  upgradeCost: number;
  cityMaxHp: number;
  cityArmor: number;
  cityIncome: number;
}

/** 时代：从冷兵器推到二战。城市各自的属性，攻陷会连时代一起接收。 */
export const ERAS: EraDef[] = [
  {
    level: 1,
    name: '古典',
    hint: '短兵相接',
    upgradeCost: 0,
    cityMaxHp: 30,
    cityArmor: 4,
    cityIncome: 30,
  },
  {
    level: 2,
    name: '中世',
    hint: '甲胄与长弓',
    upgradeCost: 220,
    cityMaxHp: 42,
    cityArmor: 6,
    cityIncome: 35,
  },
  {
    level: 3,
    name: '火药',
    hint: '排队枪毙',
    upgradeCost: 360,
    cityMaxHp: 54,
    cityArmor: 8,
    cityIncome: 41,
  },
  {
    level: 4,
    name: '工业',
    hint: '钢铁与堑壕',
    upgradeCost: 540,
    cityMaxHp: 66,
    cityArmor: 10,
    cityIncome: 48,
  },
  {
    level: 5,
    name: '现代',
    hint: '内燃机与总动员',
    upgradeCost: 780,
    cityMaxHp: 80,
    cityArmor: 12,
    cityIncome: 56,
  },
];

export const MAX_ERA = ERAS.length;

export function eraDef(level: number): EraDef {
  return ERAS[Math.max(0, Math.min(ERAS.length - 1, level - 1))] as EraDef;
}

/** 升到下一级的费用；已是顶级返回 null */
export function nextUpgradeCost(currentEra: number): number | null {
  const next = ERAS[currentEra];
  if (!next) return null;
  return next.upgradeCost;
}

export const CATEGORY_NAME: Record<UnitCategory, string> = {
  combat: '战斗单位',
  economy: '经济单位',
  builder: '建造单位',
  building: '建筑',
};

/**
 * 伤害模型：伤害 = 攻击 - （护甲 + 地形加成），最低 0。
 *
 * 允许 0 是有意的：差四个时代的兵打现代装甲就是打不动。
 * 所以跨时代成长主要放在攻击和血量上，护甲涨得克制。
 *
 * ---------------- 平衡轮次：机动与侦察整体削减 ----------------
 *
 * 这一轮把所有单位的移动力和视野各削了一档，目的是把"推进"从
 * "两三个回合就能从家门口顶到对面城下"变成"得先铺路、先探路"。
 *
 * 移动：move ≥ 3 的减 1，move ≤ 2 的**不动**。
 *   move 2 是地板：森林和丘陵的进入消耗是 2，再削一档就变成
 *   "永远进不了林子"，地形系统会直接失效。所以这里不是无脑 −1。
 * 视野：全部 −1，下限 2。侦察单位（斥候/骠骑兵/装甲车）仍然是视野最好的，
 *   但"一眼看穿对面半场"的日子结束了；建筑视野一并削（它们本来就是晴雨表）。
 *
 * 削完的直接影响：地图的有效宽度变大了，河流/山脊的战略权重上升，
 * 桥梁（唯一的跨河手段）从"锦上添花"变成"必须提前规划"。
 */
export const UNIT_TYPES: Record<string, UnitTypeDef> = {
  // ================= 时代 1 · 古典 =================
  militia: {
    id: 'militia',
    name: '民兵',
    short: '兵',
    era: 1,
    category: 'combat',
    cost: 25,
    move: 2,
    atk: 13,
    armor: 2,
    maxHp: 28,
    range: 1,
    vision: 2,
  },
  archer: {
    id: 'archer',
    name: '弓手',
    short: '弓',
    era: 1,
    category: 'combat',
    cost: 35,
    move: 2,
    atk: 11,
    armor: 1,
    maxHp: 22,
    range: 3,
    vision: 3,
  },
  scout: {
    id: 'scout',
    name: '斥候',
    short: '斥',
    era: 1,
    category: 'combat',
    cost: 50,
    move: 4,
    atk: 14,
    armor: 2,
    maxHp: 26,
    range: 1,
    vision: 4,
    abilities: ['stealth'],
  },
  farmer: {
    id: 'farmer',
    name: '农民',
    short: '农',
    era: 1,
    category: 'economy',
    cost: 55,
    move: 2,
    atk: 3,
    armor: 1,
    maxHp: 16,
    range: 1,
    vision: 2,
    incomeByTerrain: { plain: 7, forest: 3, hill: 4, city: 0 },
  },
  herder: {
    id: 'herder',
    name: '牧民',
    short: '牧',
    era: 1,
    category: 'economy',
    cost: 45,
    move: 3,
    atk: 3,
    armor: 1,
    maxHp: 18,
    range: 1,
    vision: 3,
    incomeByTerrain: { hill: 8, plain: 4, forest: 2, city: 0 },
  },
  laborer: {
    id: 'laborer',
    name: '劳工',
    short: '工',
    era: 1,
    category: 'builder',
    cost: 50,
    move: 2,
    atk: 5,
    armor: 2,
    maxHp: 20,
    range: 1,
    vision: 2,
    builds: ['tower', 'mill', 'bridge', 'camp'],
    buildPower: 8,
  },
  tower: {
    id: 'tower',
    name: '箭塔',
    buildCost: 16,
    short: '塔',
    era: 1,
    category: 'building',
    cost: 55,
    move: 0,
    atk: 10,
    armor: 5,
    maxHp: 30,
    range: 3,
    vision: 3,
    autoAttack: true,
  },
  mill: {
    id: 'mill',
    name: '磨坊',
    buildCost: 12,
    short: '磨',
    era: 1,
    category: 'building',
    cost: 65,
    move: 0,
    atk: 2,
    armor: 3,
    maxHp: 24,
    range: 1,
    vision: 2,
    incomeByTerrain: { plain: 8, hill: 5, forest: 4, city: 0 },
  },

  // ================= 时代 2 · 中世 =================
  spearman: {
    id: 'spearman',
    name: '长枪兵',
    short: '枪',
    era: 2,
    category: 'combat',
    cost: 65,
    move: 2,
    atk: 15,
    armor: 3,
    maxHp: 40,
    range: 1,
    vision: 2,
    abilities: ['shield-wall'],
  },
  longbow: {
    id: 'longbow',
    name: '长弓手',
    short: '长',
    era: 2,
    category: 'combat',
    cost: 90,
    move: 2,
    atk: 14,
    armor: 1,
    maxHp: 24,
    range: 4,
    vision: 3,
  },
  knight: {
    id: 'knight',
    name: '骑士',
    short: '骑',
    era: 2,
    category: 'combat',
    cost: 110,
    move: 3,
    atk: 17,
    armor: 4,
    maxHp: 40,
    range: 1,
    vision: 3,
  },
  lumberjack: {
    id: 'lumberjack',
    name: '伐木工',
    short: '伐',
    era: 2,
    category: 'economy',
    cost: 70,
    move: 2,
    atk: 4,
    armor: 2,
    maxHp: 20,
    range: 1,
    vision: 2,
    incomeByTerrain: { forest: 12, hill: 5, plain: 3, city: 0 },
  },
  miller: {
    id: 'miller',
    name: '磨坊主',
    short: '坊',
    era: 2,
    category: 'builder',
    cost: 85,
    move: 2,
    atk: 4,
    armor: 2,
    maxHp: 22,
    range: 1,
    vision: 2,
    builds: ['keep', 'watermill', 'bridge', 'camp', 'camp2'],
    buildPower: 12,
  },
  keep: {
    id: 'keep',
    name: '石堡',
    buildCost: 24,
    short: '堡',
    era: 2,
    category: 'building',
    cost: 100,
    move: 0,
    atk: 13,
    armor: 7,
    maxHp: 42,
    range: 2,
    vision: 3,
    autoAttack: true,
  },
  watermill: {
    id: 'watermill',
    name: '水车',
    buildCost: 18,
    short: '水',
    era: 2,
    category: 'building',
    cost: 110,
    move: 0,
    atk: 2,
    armor: 3,
    maxHp: 28,
    range: 1,
    vision: 2,
    incomeByTerrain: { plain: 13, forest: 8, hill: 6, city: 4 },
  },

  // ================= 时代 3 · 火药 =================
  musketeer: {
    id: 'musketeer',
    name: '火枪兵',
    short: '铳',
    era: 3,
    category: 'combat',
    cost: 130,
    move: 2,
    atk: 23,
    armor: 3,
    maxHp: 36,
    range: 4,
    vision: 3,
    abilities: ['armor-pierce'],
  },
  mortar: {
    id: 'mortar',
    name: '臼炮',
    short: '臼',
    era: 3,
    category: 'combat',
    cost: 140,
    move: 2,
    atk: 19,
    armor: 2,
    maxHp: 28,
    range: 4,
    abilities: ['siege-master'],
    vision: 3,
    // 打的是"一片"：主目标周围的人一起挨
    splash: 1,
  },
  halberdier: {
    id: 'halberdier',
    name: '戟兵',
    short: '戟',
    era: 3,
    category: 'combat',
    cost: 100,
    move: 2,
    atk: 21,
    armor: 5,
    maxHp: 46,
    range: 2,
    vision: 2,
  },
  hussar: {
    id: 'hussar',
    name: '骠骑兵',
    short: '骠',
    era: 3,
    category: 'combat',
    cost: 150,
    move: 4,
    atk: 26,
    armor: 4,
    maxHp: 38,
    range: 1,
    vision: 4,
  },
  planter: {
    id: 'planter',
    name: '种植园主',
    short: '园',
    era: 3,
    category: 'economy',
    cost: 120,
    move: 2,
    atk: 4,
    armor: 2,
    maxHp: 24,
    range: 1,
    vision: 2,
    incomeByTerrain: { plain: 20, forest: 12, hill: 8, city: 6 },
  },
  engineer: {
    id: 'engineer',
    name: '工程师',
    short: '师',
    era: 3,
    category: 'builder',
    cost: 130,
    move: 2,
    atk: 5,
    armor: 3,
    maxHp: 24,
    range: 1,
    vision: 2,
    builds: ['battery', 'factory', 'bridge', 'bridge2', 'camp', 'camp2', 'camp3'],
    buildPower: 18,
  },
  battery: {
    id: 'battery',
    name: '炮台',
    buildCost: 36,
    short: '炮',
    era: 3,
    category: 'building',
    cost: 150,
    move: 0,
    atk: 22,
    armor: 8,
    maxHp: 50,
    range: 4,
    splash: 1,
    vision: 4,
    autoAttack: true,
  },
  factory: {
    id: 'factory',
    name: '工厂',
    buildCost: 36,
    short: '厂',
    era: 3,
    category: 'building',
    cost: 180,
    move: 0,
    atk: 4,
    armor: 5,
    maxHp: 40,
    range: 1,
    vision: 2,
    incomeByTerrain: { city: 20, plain: 10, hill: 6, forest: 6 },
  },

  // ================= 时代 4 · 工业 =================
  rifleman: {
    id: 'rifleman',
    name: '步枪兵',
    short: '枪',
    era: 4,
    category: 'combat',
    cost: 200,
    move: 2,
    atk: 36,
    armor: 3,
    maxHp: 38,
    range: 4,
    vision: 3,
    abilities: ['armor-pierce'],
  },
  mg: {
    id: 'mg',
    name: '机枪队',
    short: '机',
    era: 4,
    category: 'combat',
    cost: 175,
    move: 1,
    // 一次攻击打三下，每下单独减护甲：
    // 打轻甲是一串数字（3×12），打重甲全被挡回去（3×2）。
    // 所以单发攻击力从 28 降到 12 —— 总伤害只在"软目标"上才是净赚。
    atk: 20,
    armor: 3,
    maxHp: 32,
    range: 4,
    vision: 2,
    burst: 3,
  },
  hmg: {
    id: 'hmg',
    name: '重机枪组',
    short: '重',
    era: 5,
    category: 'combat',
    cost: 215,
    move: 1,
    atk: 17,
    armor: 3,
    maxHp: 32,
    range: 4,
    vision: 2,
    // 四段：比机枪队多一段，但每段更弱 —— 对重甲的惩罚更狠
    burst: 4,
  },
  armoredcar: {
    id: 'armoredcar',
    name: '装甲车',
    short: '甲',
    era: 4,
    category: 'combat',
    cost: 250,
    move: 4,
    atk: 22,
    armor: 5,
    maxHp: 54,
    range: 3,
    // 车顶机枪：两连发
    burst: 2,
    vision: 3,
  },
  foreman: {
    id: 'foreman',
    name: '厂长',
    short: '长',
    era: 4,
    category: 'builder',
    cost: 190,
    move: 2,
    atk: 4,
    armor: 3,
    maxHp: 26,
    range: 1,
    vision: 2,
    builds: ['fortress', 'arsenal', 'bridge', 'bridge2', 'camp', 'camp2', 'camp3', 'camp4'],
    buildPower: 24,
  },
  fortress: {
    id: 'fortress',
    name: '要塞',
    buildCost: 48,
    short: '塞',
    era: 4,
    category: 'building',
    cost: 230,
    move: 0,
    atk: 29,
    armor: 11,
    maxHp: 66,
    range: 4,
    vision: 4,
    autoAttack: true,
  },
  arsenal: {
    id: 'arsenal',
    name: '兵工厂',
    buildCost: 44,
    short: '兵',
    era: 4,
    category: 'building',
    cost: 260,
    move: 0,
    atk: 5,
    armor: 7,
    maxHp: 50,
    range: 1,
    vision: 2,
    incomeByTerrain: { city: 30, plain: 14, hill: 9, forest: 9 },
  },

  // ================= 时代 5 · 现代 =================
  squad: {
    id: 'squad',
    name: '步兵班',
    short: '班',
    era: 5,
    category: 'combat',
    cost: 300,
    move: 2,
    atk: 47,
    armor: 4,
    maxHp: 48,
    range: 4,
    vision: 4,
  },
  tank: {
    id: 'tank',
    name: '坦克',
    short: '坦',
    era: 5,
    category: 'combat',
    cost: 400,
    move: 3,
    atk: 56,
    armor: 10,
    maxHp: 88,
    range: 3,
    vision: 3,
    abilities: ['shield-wall', 'siege-master'],
  },
  artillery: {
    id: 'artillery',
    name: '火炮',
    short: '炮',
    era: 5,
    category: 'combat',
    cost: 320,
    move: 2,
    atk: 47,
    armor: 5,
    maxHp: 54,
    range: 5,
    splash: 2,
    vision: 2,
    abilities: ['siege-master'],
  },
  agribusiness: {
    id: 'agribusiness',
    name: '农业公司',
    short: '司',
    era: 5,
    category: 'economy',
    cost: 260,
    move: 2,
    atk: 4,
    armor: 4,
    maxHp: 30,
    range: 1,
    vision: 3,
    incomeByTerrain: { plain: 36, city: 24, forest: 14, hill: 12 },
  },
  crew: {
    id: 'crew',
    name: '建筑队',
    short: '建',
    era: 5,
    category: 'builder',
    cost: 280,
    move: 2,
    atk: 4,
    armor: 4,
    maxHp: 30,
    range: 1,
    vision: 2,
    builds: ['bunker', 'industrialpark', 'bridge', 'bridge2', 'bridge3', 'camp', 'camp2', 'camp3', 'camp4', 'camp5'],
    buildPower: 32,
  },
  bunker: {
    id: 'bunker',
    name: '碉堡',
    buildCost: 64,
    short: '碉',
    era: 5,
    category: 'building',
    cost: 350,
    move: 0,
    atk: 36,
    armor: 13,
    maxHp: 86,
    range: 4,
    vision: 3,
    autoAttack: true,
  },
  industrialpark: {
    id: 'industrialpark',
    name: '工业园',
    buildCost: 60,
    short: '园',
    era: 5,
    category: 'building',
    cost: 390,
    move: 0,
    atk: 5,
    armor: 9,
    maxHp: 60,
    range: 1,
    vision: 2,
    incomeByTerrain: { plain: 34, city: 22, forest: 14, hill: 14 },
  },

  // ================= 水上部队与桥梁 =================
  // 水军只能在临水的城市造，只能在湖河里跑。它的价值不是攻城，
  // 而是"沿河线的机动与火力"：一条河能养活一支舰队，也能被对面用桥堵死。
  boat: {
    id: 'boat',
    name: '舢板',
    short: '舟',
    era: 1,
    category: 'combat',
    cost: 45,
    move: 3,
    atk: 11,
    armor: 1,
    maxHp: 34,
    range: 1,
    vision: 3,
    domain: 'water',
  },
  ferry: {
    id: 'ferry',
    name: '渡船',
    short: '渡',
    era: 1,
    category: 'combat',
    cost: 60,
    move: 3,
    // 不打架：它的全部价值是把人送过对岸
    atk: 0,
    armor: 1,
    maxHp: 26,
    range: 0,
    vision: 3,
    domain: 'water',
    transport: true,
    capacity: 2,
  },
  bridge: {
    id: 'bridge',
    name: '木桥',
    buildCost: 8,
    short: '桥',
    era: 1,
    category: 'building',
    cost: 45,
    move: 0,
    atk: 0,
    armor: 0,
    maxHp: 40,
    range: 0,
    vision: 2,
    bridges: true,
    buildOn: ['water'],
  },
  bridge2: {
    id: 'bridge2',
    name: '石桥',
    buildCost: 12,
    short: '石',
    era: 3,
    category: 'building',
    cost: 85,
    move: 0,
    atk: 0,
    armor: 3,
    maxHp: 60,
    range: 0,
    vision: 2,
    bridges: true,
    buildOn: ['water'],
  },
  bridge3: {
    id: 'bridge3',
    name: '钢桥',
    buildCost: 18,
    short: '钢',
    era: 5,
    category: 'building',
    cost: 140,
    move: 0,
    atk: 0,
    armor: 6,
    maxHp: 120,
    range: 0,
    vision: 2,
    bridges: true,
    buildOn: ['water'],
  },
  camp: {
    id: 'camp',
    name: '军营',
    buildCost: 8,
    short: '营',
    era: 1,
    category: 'building',
    cost: 90,
    move: 0,
    atk: 6,
    armor: 4,
    maxHp: 34,
    range: 1,
    vision: 3,
    // 营里有哨兵，贴着营门的敌人每回合都会被敲一下
    autoAttack: true,
    barracks: true,
    // 野战营地：只能在平地或丘陵上扎，森林里不行
    buildOn: ['plain', 'hill'],
    // 临水扎营：粮秣、饮水、船运都得靠河。这条同时是水军的存在理由——
    // 军营必然出现在水边，水军就有东西可以打，也就必须有人护航。
    requiresWater: true,
  },
  camp2: {
    id: 'camp2',
    name: '寨垒',
    buildCost: 12,
    short: '寨',
    era: 2,
    category: 'building',
    cost: 130,
    move: 0,
    atk: 8,
    armor: 5,
    maxHp: 42,
    range: 1,
    vision: 3,
    autoAttack: true,
    barracks: true,
    buildOn: ['plain', 'hill'],
    requiresWater: true,
  },
  camp3: {
    id: 'camp3',
    name: '堡寨',
    buildCost: 18,
    short: '堡',
    era: 3,
    category: 'building',
    cost: 180,
    move: 0,
    atk: 11,
    armor: 6,
    maxHp: 52,
    range: 1,
    vision: 4,
    autoAttack: true,
    barracks: true,
    buildOn: ['plain', 'hill'],
    requiresWater: true,
  },
  camp4: {
    id: 'camp4',
    name: '兵站',
    buildCost: 24,
    short: '站',
    era: 4,
    category: 'building',
    cost: 240,
    move: 0,
    atk: 14,
    armor: 7,
    maxHp: 64,
    range: 1,
    vision: 4,
    autoAttack: true,
    barracks: true,
    buildOn: ['plain', 'hill'],
    requiresWater: true,
  },
  camp5: {
    id: 'camp5',
    name: '前进基地',
    buildCost: 32,
    short: '基',
    era: 5,
    category: 'building',
    cost: 300,
    move: 0,
    atk: 17,
    armor: 8,
    maxHp: 78,
    range: 1,
    vision: 5,
    autoAttack: true,
    barracks: true,
    buildOn: ['plain', 'hill'],
    requiresWater: true,
  },
  gunboat: {
    id: 'gunboat',
    name: '炮艇',
    short: '艇',
    era: 3,
    category: 'combat',
    cost: 130,
    move: 4,
    atk: 25,
    armor: 4,
    maxHp: 46,
    range: 3,
    vision: 4,
    domain: 'water',
    abilities: ['armor-pierce'],
  },
  ironclad: {
    id: 'ironclad',
    name: '铁甲舰',
    short: '舰',
    era: 5,
    category: 'combat',
    cost: 300,
    move: 4,
    atk: 47,
    armor: 11,
    maxHp: 90,
    range: 5,
    vision: 5,
    domain: 'water',
    abilities: ['armor-pierce', 'siege-master'],
  },
};

/** 按时代取兵种 */
export function unitsByEra(level: number, pool = UNIT_TYPES): UnitTypeDef[] {
  return Object.values(pool).filter((u) => u.era === level);
}

/** 最便宜的兵种价格，用于判定"是否还有翻盘能力" */
export const CHEAPEST_COST = Math.min(...Object.values(UNIT_TYPES).map((u) => u.cost));

// ── 建造点数：难度与工兵能力 ────────────────────────────────────────────
//
// 两个派生函数放在这里而不是 rules.ts，是因为它们只读兵种表：
// 面板、规则书、AI、规则层都要问"这座塔多难修"，而 rules.ts 反过来
// 依赖 config —— 让 info/panel 去 import rules 只会绕出一圈循环依赖。

/**
 * 这座建筑要多少建造点数。
 *
 * 没写 `buildCost` 时按造价派生：贵的东西自然更难修，这样所有既有建筑
 * （包括五个时代兵备包里的那些）不用改数据就自动有了难度梯度。
 * 想要"便宜但费工"（桥）或"贵但快"（要塞）就显式写一个数覆盖它。
 */
export function buildCostOf(def: UnitTypeDef): number {
  if (typeof def.buildCost === 'number') return Math.max(1, Math.round(def.buildCost));
  return Math.max(6, Math.round((def.cost ?? 0) / 6));
}

/** 这个建造单位每回合能投多少点（缺省 8：能让大多数派生难度的建筑两回合成型） */
export function buildPowerOf(def: UnitTypeDef): number {
  if (typeof def.buildPower === 'number') return Math.max(1, Math.round(def.buildPower));
  return 8;
}
