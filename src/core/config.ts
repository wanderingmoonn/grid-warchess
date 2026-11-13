/**
 * 全部可调数值集中在这里。
 *
 * 基础兵种严格按真实历史线走：青铜时代 → 铁器时代 → 火器时代 → 蒸汽时代 → 机械化时代。
 * 第六时代「信息化」不在这里——它整套兵种都在「现代战争」扩展包里，
 * 基础规则只把时代那一行数值先摆好（见 BASE_MAX_ERA 的说明）。
 * 奇想类兵种在 expansions.ts 的「奇想兵种包」里，不勾选就不会出现。
 *
 * 单位分四类：
 *   combat   战斗单位，打仗的
 *   economy  经济单位，站在合适地形上产金（农民在平原、伐木工在森林）
 *   builder  建造单位，自己不产金，但能盖建筑
 *   building 建筑，不能移动；军事建筑自动开火，经济建筑产金
 *
 * 注意：建筑不是凭空造出来的，是**由建造单位走过去盖**出来的。
 * 所以民夫不产金，"磨坊"才产金 —— 这更接近历史，也更有决策感。
 */

import type { Terrain, UnitCategory, UnitTypeDef } from './types.ts';

/**
 * 算作「水」的四种地形。
 *
 * 桥面也算——桥底下就是河。军营要临水、地图生成要判港址、AI 要选登陆点，
 * 用的都是这一份：各写一遍必然走偏（浅流漏判过一次，桥面漏判过一次，
 * 两次的表现都是"画面高亮能建，点下去才说不临水"）。
 */
export const WATER_TERRAINS: Terrain[] = ['water', 'deep', 'shallow', 'bridge'];

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
   * 隔着格子打桥时的伤害系数。
   *
   * 1 格（贴着桥头）是满伤，2 格以上按这个比例算。定 0.5 是为了让"隔河拆桥"
   * 从"做不到"变成"很费劲"：远程兵种有了参与的办法，但想把一座桥拆干净，
   * 还是得把部队压到桥边。这条和 canStrike 是一对——那边放开了射程判定，
   * 这边负责让放开之后的代价落在伤害上。
   */
  bridgeRangedDamageRatio: 0.5,
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
    // 浅流：站在漫到小腿的水里，没处躲——比平地还差
    shallow: -1,
    // 深水：外海，没遮没挡（船在这里挨打就是挨打）
    deep: 0,
    // 沼泽：没掩护，还得站在泥里
    marsh: 0,
    // 沙丘：沙脊上目标明显
    dune: 1,
    // 月壤：开阔、没有掩护
    regolith: 0,
    // 环形山：坑缘的碎石能挡一下
    crater: 2,
    // 虚空：站不上去，防御加成没有意义
    void: 0,
    // 甲板：平的，没遮挡
    deck: 0,
    // 破损舱段：破口两面透风，站在那里就是露着
    wreck: 0,
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
    // 浅流：陆军能涉水过去，但水底打滑、看不清脚，走一格顶两格。
    // 水军也能过（水够深，船浮得起来）——它的水面判定在 navigable()，
    // 这里写的只是陆军的价；水军照旧按 1 点一步算。
    shallow: 2,
    // 深水：陆军一律过不去（99），水军按 navigable() 走 1 点一步
    deep: 99,
    marsh: 2,
    dune: 2,
    // 月壤：松但平，正常走
    regolith: 1,
    // 环形山：爬坑缘费劲
    crater: 2,
    // 虚空：过不去（99 是"不可通行"的通用写法）
    void: 99,
    // 甲板：正常走
    deck: 1,
    // 破损舱段：能过，但碎钢架和裸露的管路绊脚，走一格顶两格
    wreck: 2,
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
    shallow: '浅流',
    deep: '深水',
    regolith: '月壤',
    crater: '环形山',
    void: '虚空',
    deck: '甲板',
    wreck: '破损舱段',
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

/**
 * 指挥官模式里"这一回合**故意什么都不要**"的哨兵值。
 *
 * 序列里的空串（`''`）已经被另一个意思占住了：**队列没排到这一格**。
 * 两者必须分开，否则"我想空过这一回合"根本表达不出来——AI 看到队首是空串
 * 会当成"没排计划"自己拍一条，反而把钱花掉。这个哨兵就是那道分界线：
 *
 *   `''`      → 队列到此为止，后面的格子是空的（AI 若托管则自行安排）
 *   `@idle`   → 这一回合确定不产兵、不升级（攒钱、等时代、等对面送上门）
 *
 * 同样以 `@` 开头，不和任何兵种 id 撞车。
 */
export const ORDER_IDLE = '@idle';

/** 城市参数（与时代无关的部分） */
export const CITY = {  /** 边长：占 size × size 个格子 */
  size: 2,
  /** 被攻陷后易主时保留的血量比例 */
  captureHpRatio: 0.3,
};

/**
 * 不可通行的地形：水、高山、火山。
 * 不能进入、不能建造、不能驻军；高山和火山是纯粹的"天险"，水还额外提供临水收益。
 * 熔岩不在其中——它是"能过，但一步顶三步"，用来给机动判死刑而不是直接堵死。
 */
export function passable(t: Terrain): boolean {
  return t !== 'water' && t !== 'deep' && t !== 'mountain';
}

/**
 * 船能不能待在这一格。
 *
 * 四种水面：水域（water）、深水（deep）、桥面（bridge）、浅滩（shallow）。
 * 浅滩是**双方共用**的口子——陆军涉水、水军也能贴着它滑过去，
 * 它存在的意义之一就是给水军一条抄近路：不用绕整片海，直接从浅滩挤过去。
 * （所以"船搁底进不了浅流"是错的，别再把浅流当成只有陆军能走的地形。）
 *
 * 浅滩只有在开了「地形高差」的对局里才会出现在地图上，
 * 所以这条判断对本体对局没有任何影响。
 */
export function navigable(t: Terrain): boolean {
  return t === 'water' || t === 'deep' || t === 'bridge' || t === 'shallow';
}

export interface EraDef {
  level: number;
  /** 正式名（"青铜时代"）：规则书、结算、提示里用它 */
  name: string;
  /**
   * 按钮上的短标（"青铜"）。
   *
   * 单独一个字段而不是从 name 里切掉"时代"两个字：切字符串看起来省事，
   * 但"青铜时代"和"铁器时代"这类名字一眼能看出规律，"信息化时代"以后要是改成
   * 别的叫法，切出来的短标就会莫名其妙。写死在这里，改的时候改一处。
   */
  short: string;
  hint: string;
  /** 从上一个时代升到这个时代要花的金币；1 级为 0 */
  upgradeCost: number;
  cityMaxHp: number;
  cityArmor: number;
  cityIncome: number;
}

/** 时代：从冷兵器推到机械化。城市各自的属性，攻陷会连时代一起接收。 */
export const ERAS: EraDef[] = [
  {
    level: 1,
    name: '青铜时代',
    short: '青铜',
    hint: '短兵相接',
    upgradeCost: 0,
    cityMaxHp: 30,
    cityArmor: 4,
    cityIncome: 30,
  },
  {
    level: 2,
    name: '铁器时代',
    short: '铁器',
    hint: '甲胄与长弓',
    upgradeCost: 220,
    cityMaxHp: 42,
    cityArmor: 6,
    cityIncome: 35,
  },
  {
    level: 3,
    name: '火器时代',
    short: '火器',
    hint: '排队枪毙',
    upgradeCost: 360,
    cityMaxHp: 54,
    cityArmor: 8,
    cityIncome: 41,
  },
  {
    level: 4,
    name: '蒸汽时代',
    short: '蒸汽',
    hint: '钢铁与堑壕',
    upgradeCost: 540,
    cityMaxHp: 66,
    cityArmor: 10,
    cityIncome: 48,
  },
  {
    level: 5,
    name: '机械化时代',
    short: '机械化',
    hint: '内燃机与总动员',
    upgradeCost: 780,
    cityMaxHp: 80,
    cityArmor: 12,
    cityIncome: 56,
  },
  {
    level: 6,
    name: '信息化时代',
    short: '信息化',
    hint: '信息化与精确打击',
    upgradeCost: 1080,
    cityMaxHp: 96,
    cityArmor: 14,
    cityIncome: 62,
  },
  {
    level: 7,
    name: '装甲时代',
    short: '装甲',
    hint: '平台、模块与供电',
    upgradeCost: 1440,
    cityMaxHp: 112,
    cityArmor: 16,
    cityIncome: 68,
  },
  {
    level: 8,
    name: '聚变时代',
    short: '聚变',
    hint: '超载、光环与重型平台',
    upgradeCost: 1980,
    cityMaxHp: 132,
    cityArmor: 19,
    cityIncome: 78,
  },
];

/**
 * 不开"加时代"扩展时的时代上限。
 *
 * 第 6 时代「信息化」在表里，但**基础规则升不上去**：它没有原版兵种，
 * 升上去只会花一千多金换来一座更厚的空城。真正把它打开的是
 * 「现代战争」扩展（`Expansion.unlockEra`）——那边带了一整套第六代兵种。
 *
 * 所以 ERAS.length 是"表有多长"，这个常量是"不勾任何包时能走到第几级"。
 * 两者混用会立刻出事：开局面板的时代按钮会多出一格、AI 会攒钱去升一个
 * 空时代，而玩家看到的只是"我花了一千金，什么也没多出来"。
 */
export const BASE_MAX_ERA = 5;

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
  // ─────────────────────────────────────────────────────────────
  // 城防伪装：把 City 包一层最小的 Unit 形状，喂进 computeDamage。
  // 判据只在这里出现一次，其余逻辑全靠 isCity 短路。
  // ─────────────────────────────────────────────────────────────
  '__city__': {
    id: '__city__',
    name: '城市',
    short: '城',          // 兵种缩写，随便填
    era: 'none' as any,   // 所属时代，如果你的 era 有严格枚举，这里直接 as any 绕过
    armor: 0,             // 真实护甲会在计算时动态替换
    weak: undefined,
    resist: undefined,
    bridges: false,
    abilities: [],
    category: 'building',
    cost: 0,
    move: 0,
    atk: 0,
    maxHp: 1,
    range: 0,
    vision: 0,
    autoAttack: true,
  } as UnitTypeDef, 
  // ================= 时代 1 · 青铜 =================
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
    // 55 → 45（2026-11-01）：和牧民同价，让"平地流 / 丘陵流"变成真选择。
    // 180 局数据：牧民采用率 97.5%，农民只有 5.0%——它不是弱，是贵 10 金还少 1 点上限。
    cost: 45,
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
    name: '奴隶',
    short: '奴',
    era: 1,
    category: 'builder',
    cost: 50,
    move: 2,
    atk: 5,
    armor: 2,
    maxHp: 20,
    range: 1,
    vision: 2,
    builds: ['tower', 'mill', 'bridge', 'camp', 'anc_palisade', 'anc_rammed_wall', 'anc_watchtower'],
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

  /*
   * 戈兵（商周）。
   *
   * 补它就是因为它把"青铜时代"从地图上只有欧洲变回它本来的样子：戈是
   * 中国青铜时代的主战兵器，钩、啄、拉，专治甲片之间的缝——所以给的是破甲，
   * 而不是再加一个"攻更高的民兵"。民兵 25 金 13 攻，它 30 金 12 攻、多一格甲
   * 和破甲：同一档里买它不是为了打得狠，是为了打得穿。
   */
  ge: {
    id: 'ge',
    name: '戈兵',
    short: '戈',
    era: 1,
    category: 'combat',
    cost: 30,
    move: 2,
    atk: 12,
    armor: 1,
    maxHp: 30,
    range: 1,
    vision: 2,
    abilities: ['armor-pierce'],
  },
  // ================= 时代 2 · 铁器 =================
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
    // 2026-11-03 数值复核：110 → 95。
    // 100 局零建造。它和戟兵同价时，攻击低 4、护甲低 1、射程少 1，
    // 只有移速多 1——没有理由被选中。降到 95 让它成为"便宜一点的机动前排"，
    // 和 110 的戟兵分工（一个守线、一个绕侧）。
    cost: 95,
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
    /*
     * 2026-11-11：给伐木工「穿林」。
     *
     * 它每天在林子里干活，却是全场走得最慢的单位之一（移动力 2），
     * 进森林还要付整步——"在自家林地挪一格等于走两格"，这个手感是错的。
     * 穿上林之后森林不再减速，它就真的成了"林子里的搬运工"。
     */
    abilities: ['forest-walk'],
    incomeByTerrain: { forest: 12, hill: 5, plain: 3, city: 0 },
  },
  miller: {
    id: 'miller',
    name: '民夫',
    short: '夫',
    era: 2,
    category: 'builder',
    cost: 85,
    move: 2,
    atk: 4,
    armor: 2,
    maxHp: 22,
    range: 1,
    vision: 2,
    builds: ['tower', 'mill', 'bridge', 'camp', 'anc_palisade', 'anc_rammed_wall', 'anc_watchtower', 'keep', 'watermill', 'camp2', 'med_wall', 'med_donjon'],
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
    // 2 → 3（2026-11-01）：射程 2 意味着它必须贴着前线才打得到人，
    // 而铁器的攻城火力（投石/火炮）恰恰在三格外就能点掉它——一座"守不住自己"的堡。
    // 加一格之后它终于能在自己被打之前先还手，其余数值一个没动。
    range: 3,
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

  /*
   * 弩兵（战国—汉）。
   *
   * 和长弓的分工：长弓（90 金 / 射 4）靠射程压制，弩（82 金 / 射 3）靠**破甲**。
   * 弩的拉力大、装填慢，所以移动和血量都比长弓差一点——它不是"更好的弓"，
   * 是"拉得开重甲的那把"。铁器时代的主力远程从这一格开始分成两条路。
   *
   * 2026-11-07 攻击 16 → 19：射 3 + 破甲的组合在二代打重甲时，16 攻减完甲
   * 只剩个位数，落在"要两轮才能换掉一个二级步兵"的尴尬区间。+3 之后
   * 战力 45.0 → 49.8（×1.11），82 金没动，性价比从 3.98 抬到 4.42，
   * 才真正配得上"二代唯一的破甲远程"这个定位。
   */
  crossbow: {
    id: 'crossbow',
    name: '弩兵',
    short: '弩',
    era: 2,
    category: 'combat',
    cost: 82,
    move: 2,
    atk: 19,
    armor: 1,
    maxHp: 24,
    range: 3,
    vision: 3,
    abilities: ['armor-pierce'],
  },
  /*
   * 楼船（汉）。
   *
   * 原版的海面在舢板（1 代 34 血）和炮艇（3 代）之间是空的，两代之间没有一条
   * 能扛能打的船——水图打到铁器时代只能继续开舢板。楼船补的就是这一格：
   * 慢（移 3）、厚（85 血）、射 2 格，是"水上的活动堡垒"，不是快船。
   * 快船仍然是海军扩展里那几条（桨帆船 / 德罗蒙，移 4~5）。
   */
  tower_ship: {
    id: 'tower_ship',
    name: '楼船',
    short: '楼',
    era: 2,
    category: 'combat',
    cost: 130,
    move: 3,
    atk: 15,
    armor: 3,
    maxHp: 85,
    range: 2,
    vision: 3,
    domain: 'water',
  },
  // ================= 时代 3 · 火器 =================
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
    /*
     * 2026-11-03 数值复核：**暂不调价**（仍是 100）。
     *
     * 数据上它是偏强的（采用率 75%、每百金输出 22.8、等金对决 14:0 碾狂战士），
     * 抬到 110 是最直接的对策。但实测这一改会连带改掉 AI 的另一条行为：
     * 在"两格宽河道"的造桥用例里，它从"30 轮内架通"变成"80 轮也架不通"——
     * 链路是 价格 → 采购排序 → 工程队的站位 → 架桥点选址，属于典型的蝴蝶效应。
     * 一处价格改动能把另一条不相关的能力打掉，说明这条链路还没有被理解，
     * 不该顺手带进这一批。留作单独一批（连同"盾墙/阵型"一起）再验。
     */
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
    name: '劳工',
    short: '劳',
    era: 3,
    category: 'builder',
    cost: 130,
    move: 2,
    atk: 5,
    armor: 3,
    maxHp: 24,
    range: 1,
    vision: 2,
    builds: ['tower', 'mill', 'bridge', 'camp', 'anc_palisade', 'anc_rammed_wall', 'anc_watchtower', 'keep', 'watermill', 'camp2', 'med_wall', 'med_donjon', 'battery', 'factory', 'bridge2', 'camp3', 'gp_bastion', 'gp_chevaux', 'gp_earthwork'],
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
    // 城市 20 → 30（2026-11-01）：火器档唯一"城里赚钱"的建筑。
    // 180 局里它几乎没被造过——20/回合撑不起 180 金造价 + 36 点工期。
    incomeByTerrain: { city: 30, plain: 10, hill: 6, forest: 6 },
  },

  // ================= 时代 4 · 蒸汽 =================
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
    // 2026-11-03 数值复核：移 1 → 2。
    // 移 1 在 AI 的账本里有硬惩罚（`score -= 10 + rough×130`），而且"移 1 + 射 4"
    // 意味着它必须出生在平原上、否则一辈子到不了射程内——100 局零建造。
    // 移 2 仍是最慢的一档（重步兵同档），但至少能跟着战线挪。
    move: 2,
    // 多动 3 次：一回合打三发完整的，总输出是单发的三倍。
    // 下面这个 atk 只是"一发"的数，动 burst 等于把整条输出线乘上去——两个要一起调。
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
    // 同上：移 1 → 2（理由见机枪队）。四段输出已经够强，卡死的只是走位。
    move: 2,
    atk: 17,
    armor: 3,
    maxHp: 32,
    range: 4,
    vision: 2,
    // 四动：比机枪队多一动，所以单发伤害压到更低——总输出靠次数堆
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
    name: '工程师',
    short: '师',
    era: 4,
    category: 'builder',
    cost: 190,
    move: 2,
    atk: 4,
    armor: 3,
    maxHp: 26,
    range: 1,
    vision: 2,
    builds: ['tower', 'mill', 'bridge', 'camp', 'anc_palisade', 'anc_rammed_wall', 'anc_watchtower', 'keep', 'watermill', 'camp2', 'med_wall', 'med_donjon', 'battery', 'factory', 'bridge2', 'camp3', 'gp_bastion', 'gp_chevaux', 'gp_earthwork', 'fortress', 'arsenal', 'camp4', 'ind_wire', 'ind_concrete', 'ind_pillbox', 'ind_steelworks'],
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
    // 城市 30 → 40（2026-11-01）：和工厂同一条理由，4 代这一档更依赖它回本
    incomeByTerrain: { city: 40, plain: 14, hill: 9, forest: 9 },
  },

  // ============ 时代 5 · 机械化（第六时代在原版表里是空的） ============
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
    // 2026-11-03 数值复核：320 → 380，射程**保持 5**。
    //
    // 数据上它的交换比 9.13、每百金承伤 5.1，是"没人够得着"的典型。
    // 第一反应是砍射程，但射程有一条设计不变式撑着：
    // 「时代越靠后、站桩远程射程越长」——火炮 5 格是这条线的天花板（有测试钉着），
    // 砍成 4 就等于让 5 代火力追平 2 代长弓。所以改成"用钱换那一格"：
    // 价格 +60，每百金输出从 46.2 掉到 38.7，仍然高效，但不再是"顺手就买"。
    cost: 380,
    move: 2,
    atk: 47,
    armor: 5,
    maxHp: 54,
    range: 5,
    splash: 2,
    // 视野 2 → 3：射程 5 却只能看 2 格，等于自己 60% 的射程要别人点灯。
    // 不改射程，就把"看得见"补回来一格；最后一格仍然需要前排。
    vision: 3,
    abilities: ['siege-master'],
  },
  agribusiness: {
    id: 'agribusiness',
    name: '农业公司',
    short: '司',
    // 5 代 → 4 代（2026-11-01）：连唯一能造它的档都 0 次出场。
    // 260 金、36/回合，等到 5 代解锁时对局已进入决战，回本窗口根本不存在。
    era: 4,
    category: 'economy',
    cost: 260,
    move: 2,
    atk: 4,
    armor: 4,
    maxHp: 30,
    range: 1,
    vision: 3,
    incomeByTerrain: { plain: 48, city: 32, forest: 19, hill: 16 },
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
    builds: ['tower', 'mill', 'bridge', 'camp', 'anc_palisade', 'anc_rammed_wall', 'anc_watchtower', 'keep', 'watermill', 'camp2', 'med_wall', 'med_donjon', 'battery', 'factory', 'bridge2', 'camp3', 'gp_bastion', 'gp_chevaux', 'gp_earthwork', 'fortress', 'arsenal', 'camp4', 'ind_wire', 'ind_concrete', 'ind_pillbox', 'ind_steelworks', 'bunker', 'industrialpark', 'bridge3', 'camp5', 'mod_concretewall', 'mod_dragonsteeth', 'mod_mgbunker'],
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
    // 视野必须 ≥ 射程：2026-11-09 起"看不见就不能开火"，自动开火也吃这条。
    // 留着原来的 3 等于把这座塔的射程悄悄砍成 3，而造价和攻击都是按 4 定的。
    vision: 4,
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
    // 只有货舱、没有甲板：渡船运的是人和马，不是飞机。
    carry: { hold: { max: 2 } },
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
    vision: 0,
    bridges: true,
    buildOn: ['water', 'marsh'],
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
    vision: 0,
    bridges: true,
    buildOn: ['water', 'marsh'],
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
    vision: 0,
    bridges: true,
    buildOn: ['water', 'marsh'],
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
    // 产兵能力：这座营能造什么、多快、多贵，全在这一行。
    // 空对象 = 不设白名单、当回合成型、原价——也就是 0.3.7 之前的行为。
    produce: {},
    // 野战营地：只能在平地或丘陵上扎，森林里不行
    buildOn: ['plain', 'hill'],
    // 临水扎营：粮秣、饮水、船运都得靠河。这条同时是水军的存在理由——
    // 军营必然出现在水边，水军就有东西可以打，也就必须有人护航。
    adjacent: { terrain: WATER_TERRAINS },
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
    produce: {},
    buildOn: ['plain', 'hill'],
    adjacent: { terrain: WATER_TERRAINS },
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
    produce: {},
    buildOn: ['plain', 'hill'],
    adjacent: { terrain: WATER_TERRAINS },
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
    produce: {},
    buildOn: ['plain', 'hill'],
    adjacent: { terrain: WATER_TERRAINS },
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
    // 整条营线里唯一做了"产能差异"的一档：它把兵工厂和补给站搬到了前线，
    // 在它这儿产兵便宜一成（0.3.7 之前五档营完全一样，差异只在攻/甲/血上）。
    // 想给某一档加白名单或冷却，也只需要改这一行——规则层不用动。
    produce: { costScale: 0.9 },
    buildOn: ['plain', 'hill'],
    adjacent: { terrain: WATER_TERRAINS },
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
    // 3 → 4：炮艇是本体里唯一"便宜、能打、还带破甲"的水面单位，
    // 射程比同代的岸防火力短一格时，它只能贴着岸挨打（浅水重炮舰 E4 是 3）。
    range: 4,
    vision: 4,
    domain: 'water',
    abilities: ['armor-pierce'],
  },
  ironclad: {
    id: 'ironclad',
    name: '铁甲舰',
    short: '舰',
    // E5 → E4：铁甲舰是 1859（Gloire）到 1890 年代（定远、镇远）的舰种，
    // 属于"蒸汽"这一档。以前它被放在第五时代，等于让 1860 年代的船和
    // 机械化的战列舰同场；而真正接它班的前无畏/无畏要到 E5 才出现。
    //
    // 挪下来的代价必须一起付：原数值（47/11/90、射 5）是按 E5 的天花板给的，
    // 直接搬到 E4 会压死整条蒸汽水军（护卫舰 30/8、浅水重炮舰 50/10）。
    // 现在它是"海上正面"：比浅水重炮舰快一格、多一格视野，但少 10 点攻、
    // 也没有「岸轰」——攻城那件事仍然归浅水重炮舰（monitor）。
    // 破城（siege-master）一并交出去，同一个时代不需要两条攻城船。
    //
    // V = 40 + 0.45×82 + 5×10 + 3×4 + 2.5×4 + 1.5×4 = 154.9 → 0.52，
    // 落在 E4 那条 0.50~0.54 的带子里。
    era: 4,
    category: 'combat',
    cost: 300,
    move: 4,
    atk: 40,
    armor: 10,
    maxHp: 82,
    range: 4,
    vision: 4,
    domain: 'water',
    abilities: ['armor-pierce'],
  },
};

/** 按时代取兵种 */
export function unitsByEra(level: number, pool = UNIT_TYPES): UnitTypeDef[] {
  return Object.values(pool).filter((u) => u.era === level);
}

/**
 * 只给结算用的"伪单位"。
 *
 * 城市要在 `computeDamage` 里有一个 `UnitTypeDef` 形状的壳（护甲、弱点、抗性
 * 都得参与伤害公式），但它不是一局里存在、能造、能选、能摆上场的东西。
 * 于是任何"把兵种表摊给玩家看"或"从兵种表里抽候选"的地方都必须跳过它：
 * 漏一处就是一张叫「城市」的空卡片混进选卡池、一个 0 金的建筑混进建造清单。
 *
 * 判据只写在这里。以前 draft / setup / 选卡面板各写一遍 `!== '__city__'`，
 * 谁少写一次，池子就少一个真兵种、多一个空位。
 */
export const PSEUDO_UNIT_IDS: ReadonlySet<string> = new Set(['__city__']);

/** 这个 id 是不是伪单位（见 PSEUDO_UNIT_IDS） */
export function isPseudoUnit(id: string): boolean {
  return PSEUDO_UNIT_IDS.has(id);
}

/** 最便宜的兵种价格，用于判定"是否还有翻盘能力"。伪单位不算：它标价 0 */
export const CHEAPEST_COST = Math.min(
  ...Object.values(UNIT_TYPES)
    .filter((u) => !isPseudoUnit(u.id))
    .map((u) => u.cost),
);

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
