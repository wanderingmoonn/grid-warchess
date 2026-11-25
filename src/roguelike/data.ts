/**
 * 肉鸽 2.0 的全部内容数据。
 *
 * 设计原则：**内容可以少，但必须成"池"**——事件、奖励、商店货、敌人编成
 * 都是按池随机抽的，这样才能验证"同一套流程跑出不同局"。
 * 正式版把这些表换成文档里的几十条内容即可，代码不用动。
 *
 * 加东西只需要改这一页：
 *   · 加藏品 → `RELICS` 里加一行，效果字段见 `types.ts` 的 `Effect`；
 *     真正生效的地方在 `battle.ts` 的加成段和 `run.ts` 的层推进。
 *   · 加事件 → `EVENTS` 里加一条，选项效果同样是 `Effect`。
 *   · 加休整选项 → `REST_OPTIONS` 加一行，`run.ts` 的 `restOptions` 认 id。
 */
import type { LayerId, EventDef, ArmyEntry } from './types.ts';
import { expansionUnitsFor } from '../core/setup.ts';

/** 兵种中文名 */
export const UNIT_NAME: Record<string, string> = {
  militia: '民兵',
  archer: '弓手',
  scout: '斥候',
  ge: '戈兵',
  spearman: '长枪兵',
  longbow: '长弓手',
  knight: '骑士',
  crossbow: '弩兵',
  musketeer: '火枪兵',
  mortar: '臼炮',
  halberdier: '戟兵',
  hussar: '骠骑兵',
  rifleman: '步枪兵',
  mg: '机枪队',
  armoredcar: '装甲车',
  hmg: '重机枪组',
  squad: '步兵班',
  tank: '坦克',
  artillery: '榴弹炮',
  ct_infantry: '摩托化步兵',
  ct_tank: '中型坦克',
  ct_howitzer: '自行榴弹炮',
  ct_recon: '装甲侦察车',
};

/** 扩展兵的显示名（奇想的飞龙、修真的法器……），在 WORLDS 定义之后填 */
const EXPANDED_NAMES: Record<string, string> = {};

export function unitName(id: string): string {
  return UNIT_NAME[id] ?? EXPANDED_NAMES[id] ?? id;
}

/**
 * 时代规划（与设计文档一致）：
 *   L1 = 第 1–2 代　L2 = 第 3–4 代　L3 = 第 5–6 代
 * 城跟着低代走（1 / 3 / 5），层末敌人用高代（2 / 4 / 6）。
 */
export interface LayerTheme {
  id: LayerId;
  name: string;
  subtitle: string;
  /** 本层低代（开局）/ 高代（层末） */
  eraLow: number;
  eraHigh: number;
  /** 上一代的兵池：开局两关混进来一些，玩家的老兵还有得打（L1 没有） */
  prevPool: string[];
  prevEra: number;
  /** 本层的低代兵池（开场主力） */
  pool: string[];
  /** 时代钟靠后 / 层末的高代兵池 */
  poolHigh: string[];
  /** 这一层要开哪些扩展（第 6 代要「信息化」解锁，它没有规则钩子） */
  expansions: string[];
  /** 地图边长：遭遇 / 精英 / 攻坚 / boss */
  size: readonly [number, number, number, number];
  /** 层末 boss 的候选 */
  bosses: ReadonlyArray<{ title: string; sub: string }>;
}

export const LAYERS: Record<LayerId, LayerTheme> = {
  1: {
    id: 1,
    name: '第一层 · 旧垒',
    subtitle: '墙还站在那儿，人已经换过三茬',
    eraLow: 1,
    eraHigh: 2,
    // 第一层没有"上一代"，开局就是第一代
    prevPool: [],
    prevEra: 0,
    pool: ['militia', 'archer', 'scout', 'ge'],
    poolHigh: ['spearman', 'longbow', 'crossbow', 'knight'],
    expansions: [],
    size: [8, 10, 10, 12],
    bosses: [
      { title: '守墙人的土垣', sub: '他守的不是城，是"这里归谁"这件事' },
      { title: '持秤者的货栈', sub: '账本比城墙厚，也比特么城墙硬' },
      { title: '守钟人的石龛', sub: '钟还没响，他先站到了门口' },
    ],
  },
  2: {
    id: 2,
    name: '第二层 · 商道',
    subtitle: '同一条路，昨天运粮，今天运兵',
    eraLow: 3,
    eraHigh: 4,
    // 开局两关混一半第二代的兵：玩家刚带着第一层的老兵上来，第一关不该全是火枪
    prevPool: ['spearman', 'longbow', 'crossbow', 'knight'],
    prevEra: 2,
    pool: ['musketeer', 'halberdier', 'hussar', 'mortar'],
    poolHigh: ['rifleman', 'mg', 'armoredcar'],
    expansions: [],
    size: [10, 12, 12, 14],
    bosses: [
      { title: '守墙人的棱堡', sub: '墙学会了拐弯，人就学会了绕路' },
      { title: '持秤者的商埠', sub: '你打下的每一寸地，他都算过价' },
      { title: '守钟人的修道院', sub: '院里不敲钟了，改抄账' },
    ],
  },
  3: {
    id: 3,
    name: '第三层 · 钟楼',
    subtitle: '三家的旗都挂在同一座楼上，谁也不敢先摘',
    eraLow: 5,
    eraHigh: 6,
    // 同上：开局还留着第四代的兵，钟过 3 之后才全是第五代
    prevPool: ['rifleman', 'mg', 'armoredcar'],
    prevEra: 4,
    pool: ['hmg', 'squad', 'tank', 'artillery'],
    poolHigh: ['ct_infantry', 'ct_tank', 'ct_howitzer', 'ct_recon'],
    expansions: ['pack-contemporary'],
    size: [12, 14, 14, 16],
    bosses: [{ title: '钟楼', sub: '三家共守的地方——谁都不能让你砸这口钟' }],
  },
};

/**
 * 世界（第二层的四种样子）。
 *
 * 设计里 L1 末要选"这条历史怎么走"：原版（正史）/ 时代军备（加速史）走技术史，
 * 奇想（神话史）/ 修真（修行史）走神话史；**第二层就是这一支史的样子**。
 * 四种世界的区别不是换个名字，是**兵池、扩展开关、层末 boss、第三层的溢出**全都换。
 *
 * 实现方式：一局在 `RunState.world` 里记一个 id，`themeFor(world, layer)` 按它取主题。
 * 第一层和第三层共用一套（L3 是科技层，只把本世界的高代兵混进去）。
 */
export type WorldId = 'base' | 'arms' | 'fantasy' | 'cultivation';

export interface WorldDef {
  id: WorldId;
  /** 选项名 */
  name: string;
  /** 这一支史最后通向 L4 的哪一边 */
  history: 'technology' | 'myth';
  /** 选择界面上的说明 */
  blurb: string;
  /** 第二层的主题（层名 / 兵池 / 扩展开关 / 层末 boss） */
  theme: LayerTheme;
  /** 修真：修士按时代钟拿到的"境界档位"（其它世界没有） */
  rankOf?: (clock: number) => number;
  /**
   * 敌方预算的折算系数（缺省 1）。
   *
   * 奇想和修真的兵"每块钱买到的战力"比原版高：奇想带魔法/飞行/治疗，
   * 修真带境界。同样的预算，他们会明显更难打——所以按世界给预算打个折。
   */
  power?: number;
  /** 第三层的"本世界溢出"：并进 L3 的低代池 */
  l3Pool: string[];
  /** 第三层层名若不是默认的科技层，在这里覆盖 */
  l3Subtitle?: string;
}

/** 第二层的地图尺寸与"上一代"兵池：四个世界通用 */
const L2_SIZE = [10, 12, 12, 14] as const;
const L2_PREV = ['spearman', 'longbow', 'crossbow', 'knight'];

function l2(
  name: string,
  subtitle: string,
  pool: string[],
  poolHigh: string[],
  expansions: string[],
  bosses: ReadonlyArray<{ title: string; sub: string }>,
): LayerTheme {
  return {
    id: 2,
    name,
    subtitle,
    eraLow: 3,
    eraHigh: 4,
    prevPool: [...L2_PREV],
    prevEra: 2,
    pool,
    poolHigh,
    expansions,
    size: L2_SIZE,
    bosses,
  };
}

/** 修真里会"长境界"的单位（法器不会——它们不是人） */
export const CULTIVATORS = new Set([
  'qi-cultivator',
  'sword-cultivator',
  'body-cultivator',
  'blood-cultivator',
  'soul-cultivator',
]);

export const WORLDS: Record<WorldId, WorldDef> = {
  base: {
    id: 'base',
    name: '正史',
    history: 'technology',
    blurb: '没有魔法，也没有被提前造出来的枪。一切按本来的时间表走。',
    theme: LAYERS[2],
    l3Pool: [],
  },
  arms: {
    id: 'arms',
    name: '时代军备',
    history: 'technology',
    blurb: '有人把三代以后的枪提前造了出来。线列、胸甲、加农炮，然后直接跳进堑壕与坦克。',
    theme: l2(
      '第二层 · 军械库',
      '铁比人多，炮比话多',
      ['gp_lineinfantry', 'gp_sharpshooter', 'gp_cuirassier', 'gp_dragoon', 'gp_grenadier', 'gp_siegecannon', 'gp_rocket', 'gp_culverin', 'combat-engineer'],
      ['ind_trenchraider', 'ind_trenchmortar', 'ind_flamethrower', 'ind_gas', 'ind_howitzer', 'ind_railwaygun', 'ind_landship', 'ind_armoredtrain', 'mine-sweeper'],
      ['era-arms'],
      [
        { title: '守墙人的兵工厂', sub: '墙靠人守，人靠厂养' },
        { title: '持秤者的军械库', sub: '他连炮弹都按斤称' },
        { title: '守钟人的试炮场', sub: '他们拿钟当靶子试射程' },
      ],
    ),
    l3Pool: ['mod_paratrooper', 'mod_commando', 'mod_atgun', 'mod_katyusha', 'mod_heavytank', 'mod_spg', 'mod_flak', 'mod_heavy_mortar'],
  },
  fantasy: {
    id: 'fantasy',
    name: '奇想',
    history: 'myth',
    blurb: '龙、法师、精灵从故事里走了出来，站到了战场上。脆，但什么都干得出来。',
    theme: l2(
      '第二层 · 异境',
      '树上挂着龙，井里游着精灵',
      /*
       * 飞行单位**照常入池**（2026-11-25 按反馈改）。
       *
       * 上一版把它们剔掉了，理由是"空中层地面打不到"——但那条理由不成立：
       * 规则层对空中目标只加一格距离（`strikeDistance`），有射程的兵照样能打；
       * 而且剔除是**剔不干净**的，玩家照样会在别处撞见会飞的东西——说一套做一套
       * 比平衡问题更糟。现在改用编成侧的两条约束（见 `run.ts` 的
       * `sanitizeAir`）：一场最多一个飞行单位、且我方没有任何射程 ≥2 的兵时不给，
       * 既保住"奇想就该有会飞的东西"，也不会出现打不完的仗。
       *
       * 便宜的蝙蝠/小恶魔不进池：它们会拉低池内最低价，让整套"按人头摊钱"
       * 的编成算法把敌人换成一堆杂兵。
       */
      [
        'berserker', 'ghost', 'assassin', 'mage', 'elf-archer', 'treant', 'necromancer', 'paladin',
        'royal-cavalry', 'cataphract',
        'harpy', 'gargoyle', 'air-elemental', 'griffin-rider',
      ],
      [
        'royal-guard', 'werewolf', 'elementalist', 'two-head-giant', 'clockwork-golem', 'holy-knight-lord',
        'royal-king', 'alchemist',
        'vampire', 'dragoon-rider', 'demon', 'bone-dragon',
      ],
      ['fantasy'],
      [
        { title: '邪龙王的巢', sub: '它不是守城，它只是睡在城里' },
        { title: '精灵女王的庭院', sub: '每一棵树都记得你砍过谁' },
        { title: '至尊法师的高塔', sub: '塔里没有楼梯，只有上一层的门' },
      ],
    ),
    l3Pool: ['archmage', 'elf-queen'],
    power: 1.8,
  },
  cultivation: {
    id: 'cultivation',
    name: '修真',
    history: 'myth',
    blurb: '有人不靠机器，靠自己往上修。人少，贵，但境界压人。',
    theme: l2(
      '第二层 · 山门',
      '山门还在，灵气不多了',
      ['qi-cultivator', 'sword-cultivator', 'body-cultivator', 'cultivation-artifact-wood', 'cultivation-artifact-stone'],
      ['blood-cultivator', 'soul-cultivator', 'cultivation-artifact-water', 'cultivation-artifact-fire'],
      ['cultivation'],
      [
        { title: '掌门与护山大阵', sub: '山门不破，是因为阵还没破' },
        { title: '魔修的洞府', sub: '洞里没有灯，只有人在发光' },
        { title: '魂修的祭坛', sub: '坛上摆的不是供品，是名字' },
      ],
    ),
    // 境界：门口就是筑基，越往钟后越深（demo 用固定加成代替完整的修炼循环）
    rankOf: (clock) => Math.min(5, 2 + Math.floor(clock / 3)),
    power: 2.2,
    l3Pool: [],
    l3Subtitle: '末法之世——灵气被钢铁抽干了，这一层没有修士，只有机器',
  },
};

// 四种世界的兵都有自己的名字；`unitName` 查不到基础表时会落到这张表
for (const w of Object.values(WORLDS)) {
  for (const [id, def] of Object.entries(expansionUnitsFor(w.theme.expansions))) {
    EXPANDED_NAMES[id] = def.name;
  }
}

/**
 * 防御工事（精英战 / 攻坚 / 层末 / 守城战都会用）。
 *
 * 按**时代**给一套，而不是按层写死：第一层的箭塔和第三层的碉堡不是同一种东西，
 * 但"每一层都有一座塔"这件事是一样的。塔负责火力，墙负责挡路——
 * 墙的 atk 很低甚至为 0，它的价值是让你必须先拆它才能摸到城。
 */
export interface DefenseSet {
  tower: string;
  wall?: string;
  /**
   * 数值缩放（缺省 1）。
   *
   * 奇想和修真的建筑本身偏弱（哥布林战营 4 攻、散灵台 12 攻），
   * 放在第三层会被玩家当纸糊。按世界放大一点，既保住风味，又不至于没用。
   */
  scale?: { atk: number; hp: number };
}

/**
 * 按时代的默认防御工事（第一/三层用；第二层看世界）。
 *
 * **墙必须是墙**：这里曾经写的是 `camp` / `camp2` / …（军营、寨垒、堡寨），
 * 它们在本体里是 `produce: true` 的产兵建筑——玩家在肉鸽里没有产兵面板，
 * 拿到一座军营等于拿到一块 34 血的石头，"防御工事"这件事就落空了。
 * 现在换成时代军备包里真正的墙体（栅栏 / 城墙 / 混凝土胸墙 / 掩体墙），
 * 它们 `atk: 0, move: 0`，价值全在血和护甲上。
 *
 * 这四件**不靠开整个 era-arms 包**来注册（那会把 89 个近现代兵一起塞进
 * 招募池），而是随关卡以 `LevelDef.units` 的形式带进去——见 `battle.ts`。
 */
export const DEFENSE_BY_ERA: Record<number, DefenseSet> = {
  1: { tower: 'tower', wall: 'anc_palisade' },
  2: { tower: 'keep', wall: 'med_wall' },
  3: { tower: 'battery', wall: 'ind_concrete' },
  4: { tower: 'fortress', wall: 'ind_concrete' },
  5: { tower: 'bunker', wall: 'mod_concretewall' },
  6: { tower: 'bunker', wall: 'mod_concretewall' },
};

/**
 * 关卡自带的工事兵种（`LevelDef.units`）。
 *
 * 只取肉鸽用得到的那几个墙体：它们不在本体的 `UNIT_TYPES` 里，也不是本项目
 * 常开的扩展，所以必须由关卡自己登记，否则 `deploy` 会当成"不存在的兵"跳过，
 * 场上的墙就凭空消失。
 */
const ERA_ARMS_UNITS = expansionUnitsFor(['era-arms']);
export const DEFENSE_UNIT_DEFS: Record<string, import('../core/types.ts').UnitTypeDef> = Object.fromEntries(
  ['tower', 'keep', 'battery', 'fortress', 'bunker', 'anc_palisade', 'med_wall', 'ind_concrete', 'mod_concretewall']
    .map((id) => [id, ERA_ARMS_UNITS[id]])
    .filter(([, def]) => Boolean(def)) as Array<[string, import('../core/types.ts').UnitTypeDef]>,
);

/** 第二层四个世界各自的工事（只换外壳，数值按 scale 对齐） */
export const WORLD_DEFENSE: Partial<Record<WorldId, DefenseSet>> = {
  arms: { tower: 'gp_bastion', wall: 'gp_earthwork' },
  fantasy: { tower: 'goblin-warcamp', wall: 'earth-wall', scale: { atk: 3.2, hp: 1.7 } },
  cultivation: { tower: 'cultivation-spirit-tower', wall: 'cultivation-kill-formation', scale: { atk: 1.7, hp: 1.8 } },
};

/** 方略：开局身份 + 一条被动。被动在 battle.ts 里翻译成具体加成 */
export interface Strategy {
  id: string;
  name: string;
  sub: string;
  army: ArmyEntry[];
  passive: string;
}

export const STRATEGIES: Strategy[] = [
  {
    id: 'frontier',
    name: '边军',
    sub: '长年守边的一营，人不多，阵不散',
    army: [
      { type: 'ge', count: 3 },
      { type: 'spearman', count: 1 },
      { type: 'archer', count: 2 },
    ],
    passive: '我军全体护甲 +1',
  },
  {
    id: 'skirmish',
    name: '射手',
    sub: '不与人贴身，只与人比谁的箭先到',
    army: [
      { type: 'archer', count: 3 },
      { type: 'militia', count: 3 },
      { type: 'scout', count: 1 },
    ],
    passive: '我军远程单位（射程 ≥3）攻击 +2',
  },
  {
    id: 'horse',
    name: '骑军',
    sub: '来得快，走得也快，只剩你追不上',
    army: [
      { type: 'scout', count: 2 },
      { type: 'knight', count: 1 },
      { type: 'militia', count: 3 },
    ],
    passive: '我军全体移动 +1',
  },
];

export function strategyById(id: string): Strategy {
  return STRATEGIES.find((s) => s.id === id) ?? (STRATEGIES[0] as Strategy);
}

/**
 * 藏品。
 *
 * 效果字段（都在 `types.ts` 的 `Effect` 里）：
 *   atk / move / armor / hp   我军全体加成（战斗开始时套到兵种变体上）
 *   enemyCut                  本场敌人少几个兵
 *   cityDamage                本场敌城初始耐久 −N%
 *   goldPerLayer              每层开始 +N 金
 *   unitPerLayer              每层开始 +N 个本层基础兵
 *   shopOff                   商店价格折扣（0~1）
 *   revive                    战斗后返还 N 个阵亡单位
 */
export interface Relic {
  id: string;
  name: string;
  desc: string;
  /**
   * 摊子上的标价（基准价，结算时再乘层价水位）。
   *
   * 上一版所有藏品一个价（200）：急行靴和行军图卖同一个数，等于把"哪个更值"
   * 这件事藏起来。现在按强度分档——不是让贵的更强，而是让**价格说真话**。
   */
  price?: number;
  effect: {
    atk?: number;
    move?: number;
    armor?: number;
    hp?: number;
    enemyCut?: number;
    cityDamage?: number;
    goldPerLayer?: number;
    unitPerLayer?: number;
    shopOff?: number;
    revive?: number;
  };
}

/**
 * 藏品列表。
 *
 * **数值藏品按层成长**（2026-11-25）：攻击/护甲/生命是减法公式里的绝对值，
 * 第一层 +1 攻很值钱，到第三层（中位攻 55）就只剩 2%；而"移动 +1"的收益
 * 是节奏，不随时代缩水。结果就是越往后"移速藏品"越一家独大。
 * 现在这三件按层取 `RELIC_GROWTH`（+1/2/3 攻、+1/2/2 甲、+6/9/12 血），
 * 相对价值在第一层和第三层差不多；`desc` 里写的是第一层的数，实际值见 `relicDesc`。
 */
export const RELICS: Relic[] = [
  { id: 'forge', name: '铁匠铺', desc: '我军全体攻击 +1（第三层 +3）', price: 190, effect: { atk: 1 } },
  {
    id: 'boots',
    name: '急行靴',
    desc: '我军全体移动 +1（基础移速 4 以上不受影响）',
    price: 300,
    effect: { move: 1 },
  },
  { id: 'armorplate', name: '铁甲', desc: '我军全体护甲 +1（第三层 +2）', price: 220, effect: { armor: 1 } },
  { id: 'rampart', name: '壁垒图', desc: '我军全体最大生命 +6（第三层 +12）', price: 170, effect: { hp: 6 } },
  { id: 'scoutnet', name: '斥候网', desc: '每场战斗敌人少 1 个兵', price: 240, effect: { enemyCut: 1 } },
  { id: 'powder', name: '火药桶', desc: '攻坚与层末：敌城初始耐久 −30%', price: 160, effect: { cityDamage: 0.3 } },
  { id: 'purse', name: '军饷袋', desc: '每层开始 +90 金（按层换算）', price: 150, effect: { goldPerLayer: 90 } },
  { id: 'ration', name: '军粮袋', desc: '每层开始 +1 个本层基础兵', price: 180, effect: { unitPerLayer: 1 } },
  { id: 'marchmap', name: '行军图', desc: '商店价格 −25%', price: 140, effect: { shopOff: 0.25 } },
  {
    id: 'medic',
    name: '随军医官',
    desc: '每层最多救回 2 个阵亡单位（用最便宜的兵补员）',
    price: 300,
    effect: { revive: 1 },
  },
];

export function relicById(id: string): Relic | undefined {
  return RELICS.find((r) => r.id === id);
}

/**
 * 事件池。
 *
 * 和临战决议的分工（2026-11-24 明确）：
 *   · **事件 = 这一趟值不值**：金币、兵、藏品、整编、赌博。影响的是整局。
 *   · **决议 = 这一仗怎么打**：只在层末出现，只影响那一场，全部是战术修正。
 * 所以事件里**不再出现**"下一战攻击 +2"这种临时加成——那是决议的活。
 *
 * 选项的骨架也刻意做得不一样：有的两选、有的四选；有的给东西、有的要你拿兵去换、
 * 有的纯赌。这样玩家读到的不是"三个数值选一个"，是"这伙人想从你这儿拿什么"。
 */
export const EVENTS: EventDef[] = [
  {
    id: 'levy',
    title: '征兵令',
    body: '里正把名册摊在你面前。名字比粮多，粮比人少。他说：抽几个吧，反正明年还得抽。',
    choices: [
      { label: '按册抽丁', hint: '本层基础兵 ×2，−30 金', effect: { add: { type: 'layer-low', count: 2 }, gold: -30 } },
      { label: '只征粮', hint: '+70 金', effect: { gold: 70 } },
      { label: '从册子里挑老兵', hint: '把 1 个最差的兵换成 1 个高级兵', effect: { promote: 1 } },
    ],
  },
  {
    id: 'ruins',
    title: '烧过的庄子',
    body: '半个村子没了，另外半个还没决定要不要没。有人在灰里翻东西，有人在门口坐着。',
    choices: [
      { label: '搜能用的', hint: '+90 金', effect: { gold: 90 } },
      { label: '收拢散兵', hint: '本层中档兵 ×1', effect: { add: { type: 'layer-mid', count: 1 } } },
      {
        label: '在灰里挖',
        hint: '五成：得 1 件藏品；否则 +30 金',
        effect: {
          risk: {
            chance: 0.5,
            win: { relic: 'random' },
            lose: { gold: 30 },
            winText: '挖出一只没烧透的箱子',
            loseText: '只有灰和骨头，顺手捡了点铜',
          },
        },
      },
    ],
  },
  {
    id: 'caravan',
    title: '过路的商队',
    body: '车上有布、有盐、还有几箱说不清来路的东西。掌柜的看见你的旗，笑得很客气。',
    choices: [
      { label: '买他的货', hint: '−120 金，得 1 件藏品', effect: { gold: -120, relic: 'random' } },
      { label: '照价收税', hint: '+140 金', effect: { gold: 140 } },
      { label: '让他过去', hint: '+20 金', effect: { gold: 20 } },
      {
        label: '连车带人扣下',
        hint: '+220 金，损 1 个基础兵',
        effect: { gold: 220, remove: { type: 'layer-low', count: 1 } },
      },
    ],
  },
  {
    id: 'oldfield',
    title: '旧战场',
    body: '两年前这里打过一场，现在草长得很好。兵器还插在土里，像谁忘了收。',
    choices: [
      { label: '捡兵器', hint: '得 1 个中档兵', effect: { add: { type: 'layer-mid', count: 1 } } },
      /*
       * 免费藏品是**故意的**（2026-11-26 定）：事件节点的收益必须高于一场战斗，
       * 否则玩家最优解是"只走战斗、绕开事件"。藏品 ≈ 5~6 个兵，白拿才值得绕路。
       */
      { label: '找那面旗', hint: '得 1 件藏品', effect: { relic: 'random' } },
      { label: '什么都不动', hint: '+40 金', effect: { gold: 40 } },
    ],
  },
  {
    id: 'bell',
    title: '钟楼的影子',
    body: '太阳落下去的时候，远处那座楼的影子刚好盖到你脚边。老兵说：别在那儿站着。',
    choices: [
      {
        label: '敲一下',
        hint: '五成：得 1 件藏品；否则损 1 个基础兵',
        effect: {
          risk: {
            chance: 0.5,
            win: { relic: 'random' },
            lose: { remove: { type: 'layer-low', count: 1 } },
            winText: '钟声里掉出一样东西',
            loseText: '有人当场扔了兵器就走',
          },
        },
      },
      { label: '移开眼', hint: '+60 金', effect: { gold: 60 } },
      {
        label: '在影子里站到天黑',
        hint: '五成：得 1 个高级兵；否则什么都没有',
        effect: {
          risk: {
            chance: 0.5,
            win: { add: { type: 'layer-high', count: 1 } },
            winText: '有个人从影子里走出来，跟上了队伍',
            loseText: '什么也没有发生，只是天黑了',
          },
        },
      },
    ],
  },
  {
    id: 'three',
    title: '三家的账房',
    body: '账房先生把三本账并排放着，说：哪家都行，只要押得准。他连笔都替你备好了。',
    choices: [
      { label: '借兵', hint: '−80 金，得 1 个高级兵', effect: { gold: -80, add: { type: 'layer-high', count: 1 } } },
      { label: '卖情报', hint: '+110 金', effect: { gold: 110 } },
      { label: '抄一份账本', hint: '得 1 件藏品', effect: { relic: 'random' } },
    ],
  },
  {
    id: 'stragglers',
    title: '溃兵',
    body: '二十来个人蹲在沟里，旗扔了，甲还在。领头的不敢看你，只说：给口饭，跟你走。',
    choices: [
      { label: '收编', hint: '−20 金，得 2 个基础兵', effect: { gold: -20, add: { type: 'layer-low', count: 2 } } },
      { label: '拿走他们的甲', hint: '+90 金', effect: { gold: 90 } },
      { label: '给他们一口饭', hint: '−40 金，得 1 件藏品', effect: { gold: -40, relic: 'random' } },
    ],
  },
  {
    id: 'ferry',
    title: '渡口',
    body: '摆渡的老头一天只跑两趟。他说：兵过河，船就沉。要过，得加钱。',
    choices: [
      { label: '给钱', hint: '−50 金，得 1 个中档兵', effect: { gold: -50, add: { type: 'layer-mid', count: 1 } } },
      {
        label: '抢船',
        hint: '+20 金，得 1 个中档兵，损 1 个基础兵',
        effect: { gold: 20, add: { type: 'layer-mid', count: 1 }, remove: { type: 'layer-low', count: 1 } },
      },
      { label: '替他们摆渡', hint: '+60 金', effect: { gold: 60 } },
    ],
  },
  {
    id: 'shrine',
    title: '路边的祭坛',
    body: '石头垒的，不知道供的是谁。供品还在，说明这附近已经没人敢来拿了。',
    choices: [
      {
        label: '上供',
        hint: '−60 金，六成：得 1 件藏品；否则什么都没有',
        effect: {
          gold: -60,
          risk: {
            chance: 0.6,
            win: { relic: 'random' },
            winText: '石头底下压着东西',
            loseText: '供品没了，石头还是石头',
          },
        },
      },
      { label: '拿走供品', hint: '+100 金', effect: { gold: 100 } },
      {
        label: '撬开石座',
        hint: '得 1 件藏品，损 1 个基础兵',
        effect: { relic: 'random', remove: { type: 'layer-low', count: 1 } },
      },
    ],
  },
  {
    id: 'smith',
    title: '铁匠',
    body: '炉子还热着，人已经跑了。砧上放着一块没打完的铁，锤子还在旁边。',
    choices: [
      { label: '打一件兵器', hint: '−100 金，得 1 件藏品', effect: { gold: -100, relic: 'random' } },
      { label: '修甲', hint: '−60 金，得 1 个中档兵', effect: { gold: -60, add: { type: 'layer-mid', count: 1 } } },
      { label: '把废铁卖了', hint: '+80 金', effect: { gold: 80 } },
    ],
  },
  {
    id: 'captives',
    title: '俘虏',
    body: '沟里蹲着七个，绳子不够，只能用他们的腰带。看见你过来，有人先跪了。',
    choices: [
      { label: '收编', hint: '−30 金，得 1 个中档兵', effect: { gold: -30, add: { type: 'layer-mid', count: 1 } } },
      { label: '换赎金', hint: '+120 金', effect: { gold: 120 } },
      { label: '问完话放走', hint: '+40 金', effect: { gold: 40 } },
    ],
  },
  {
    id: 'plague',
    title: '瘟疫',
    body: '先是炊事班，然后是马夫。军医说别数了，数了也没用。',
    choices: [
      { label: '请医', hint: '−90 金，无人损失', effect: { gold: -90 } },
      { label: '隔离', hint: '损 1 个基础兵', effect: { remove: { type: 'layer-low', count: 1 } } },
      {
        label: '硬扛',
        hint: '五成：没事；否则损 2 个基础兵',
        effect: {
          risk: {
            chance: 0.5,
            win: {},
            lose: { remove: { type: 'layer-low', count: 2 } },
            winText: '扛过去了',
            loseText: '一夜抬出去两个',
          },
        },
      },
    ],
  },
  {
    id: 'gamble',
    title: '赌局',
    body: '几个兵蹲在墙根下掷骰子。见你来了，把碗往前推了推，谁也没收。',
    choices: [
      {
        label: '押大',
        hint: '−100 金，五成：+320 金',
        effect: {
          gold: -100,
          risk: { chance: 0.5, win: { gold: 320 }, winText: '开了大', loseText: '开了小' },
        },
      },
      {
        label: '押小',
        hint: '−50 金，五成：+140 金',
        effect: {
          gold: -50,
          risk: { chance: 0.5, win: { gold: 140 }, winText: '开了小', loseText: '开了大' },
        },
      },
      { label: '看场子', hint: '+40 金', effect: { gold: 40 } },
    ],
  },
  {
    id: 'refugees',
    title: '逃难的人',
    body: '路上全是人，往北走。有人把最后一袋粮换成了你的旗，说：跟着旗走，总比跟着路走强。',
    choices: [
      { label: '给粮', hint: '−60 金，得 2 个基础兵', effect: { gold: -60, add: { type: 'layer-low', count: 2 } } },
      { label: '征兵', hint: '−20 金，得 1 个基础兵', effect: { gold: -20, add: { type: 'layer-low', count: 1 } } },
      { label: '抢', hint: '+100 金', effect: { gold: 100 } },
    ],
  },
  {
    id: 'grave',
    title: '老兵的坟',
    body: '一块木牌，字被雨打花了。看得出是"某某营，十七人"。土是新翻的，翻的人没留下名字。',
    choices: [
      {
        label: '立块碑',
        hint: '−40 金，把 1 个最差的兵换成 1 个高级兵',
        effect: { gold: -40, promote: 1 },
      },
      {
        label: '挖开',
        hint: '得 1 件藏品，损 1 个基础兵',
        effect: { relic: 'random', remove: { type: 'layer-low', count: 1 } },
      },
    ],
  },
  {
    id: 'armsdealer',
    title: '军械贩子',
    body: '他掀开油布，底下一排枪，擦得比你的兵干净。他说：这些东西来路不正，所以便宜。',
    choices: [
      { label: '买一批', hint: '−150 金，得 1 件藏品', effect: { gold: -150, relic: 'random' } },
      { label: '卖旧兵器', hint: '+90 金，损 1 个基础兵', effect: { gold: 90, remove: { type: 'layer-low', count: 1 } } },
      {
        label: '以旧换新',
        hint: '损 1 个基础兵，得 1 个高级兵',
        effect: { add: { type: 'layer-high', count: 1 }, remove: { type: 'layer-low', count: 1 } },
      },
    ],
  },
  {
    id: 'kid',
    title: '拾荒的孩子',
    body: '他在死人身上翻东西，翻得很熟练。看见你，先把手里的东西举起来，像是在等你开价。',
    choices: [
      {
        label: '给他钱',
        hint: '−30 金，五成：得 1 件藏品；否则什么都没有',
        effect: {
          gold: -30,
          risk: {
            chance: 0.5,
            win: { relic: 'random' },
            winText: '他从怀里掏出一件东西',
            loseText: '他拿了钱就跑',
          },
        },
      },
      { label: '带走', hint: '得 1 个基础兵', effect: { add: { type: 'layer-low', count: 1 } } },
      { label: '不管', hint: '+10 金', effect: { gold: 10 } },
    ],
  },
  {
    id: 'well',
    title: '古井',
    body: '井沿上刻着字，磨得只剩半个"守"。往下看，水面上有个你，比你干净。',
    choices: [
      {
        label: '投钱',
        hint: '−50 金，五成：得 1 件藏品；否则 +20 金',
        effect: {
          gold: -50,
          risk: {
            chance: 0.5,
            win: { relic: 'random' },
            lose: { gold: 20 },
            winText: '井底有东西',
            loseText: '捞上来一只铜桶',
          },
        },
      },
      { label: '打水', hint: '+30 金', effect: { gold: 30 } },
    ],
  },
];

export function eventById(id: string): EventDef {
  return EVENTS.find((e) => e.id === id) ?? (EVENTS[0] as EventDef);
}

/**
 * 休整房的选项池（每次随机抽 3 个）。
 *
 * 只做**人、钱、编制**三件事——战斗加成全部让给临战决议，否则两个池子又会撞。
 */
export interface RestOption {
  id: string;
  label: string;
  hint: string;
}

export const REST_OPTIONS: RestOption[] = [
  { id: 'reinforce', label: '补员', hint: '得 1 个本层基础兵' },
  { id: 'wage', label: '募饷', hint: '+90 金' },
  { id: 'recruit', label: '征召', hint: '−80 金，得 1 个本层高级兵' },
  { id: 'reform', label: '整编', hint: '把 1 个最低级的兵换成 1 个本层高级兵' },
  { id: 'muster', label: '犒军', hint: '−60 金，得 2 个本层基础兵' },
];

/**
 * 临战决议：层末 boss 前抽 3 个给玩家选 1 个。
 *
 * 全部是**这一场**的战术修正，不带金币/兵/藏品的收益（那是事件的活）。
 * 每一个都带一点代价：要么花钱，要么拿别的属性换——没有"纯赚"的选项，
 * 所以选起来是"这一仗我打算怎么打"，不是"哪个数大"。
 */
export interface DecisionOption {
  id: string;
  label: string;
  hint: string;
  /** 立刻扣的钱（不够就不能选） */
  cost?: number;
  /** 本场加成（可以是负数：拿一样换另一样） */
  atk?: number;
  hp?: number;
  armor?: number;
  move?: number;
  enemyCut?: number;
  cityDamage?: number;
  /** 敌人工事（塔/墙）开场耐久 −N% */
  defenseDamage?: number;
  /** 敌军开场掉 N% 血 */
  enemyHp?: number;
  /** 本场临时兵（本层基础兵） */
  tempUnits?: number;
}

export const DECISIONS: DecisionOption[] = [
  { id: 'night', label: '夜袭', hint: '本场我军攻击 +3、护甲 −1', atk: 3, armor: -1 },
  { id: 'press', label: '强攻', hint: '本场我军最大生命 +10、移动 −1', hp: 10, move: -1 },
  { id: 'bribe', label: '买通', hint: '−120 金，本场敌人少 2 个兵', cost: 120, enemyCut: 2 },
  { id: 'levy', label: '就地征召', hint: '本场多 2 个基础兵（活下来就带走）', tempUnits: 2 },
  { id: 'sappers', label: '工兵破墙', hint: '本场敌城与工事耐久 −45%', cityDamage: 0.45, defenseDamage: 0.45 },
  { id: 'fire', label: '火攻', hint: '本场敌军开场即带伤（−25% 生命）', enemyHp: 0.25 },
  { id: 'flank', label: '迂回', hint: '本场我军移动 +1、攻击 −1', move: 1, atk: -1 },
  { id: 'dig', label: '掘壕', hint: '本场我军护甲 +2、移动 −1', armor: 2, move: -1 },
];

/** 房间标题里用的地名，纯装饰 */
export const PLACE_NAMES: Record<LayerId, string[]> = {
  1: ['北坡', '干河沟', '旧驿', '断桥', '石堆', '西口'],
  2: ['盐道', '车马店', '税卡', '渡口', '货场', '关隘'],
  3: ['钟楼前街', '铁厂', '轨道站', '电报房', '市政厅', '钟塔下'],
};

/**
 * 敌方编成：**先定人数，再把预算摊到每个人头上**。
 *
 * 以前是"按预算从贵到便宜地买"，结果预算卡在两件贵货之间时，场上只有一两个
 * 巨兽，玩家六个兵围着打——那不是会战，是打木桩。人数和钱是两件事，
 * 分开算才不会出现"钱够但人不够"。
 *
 * `count` 是这一场想要的人数；每个位置最多花 `剩余 / 剩余位置 × 1.35`，
 * 所以前面的位置能买贵一点的，最后几个位置用便宜的填满。
 */
export function pickEnemyTypes(
  pool: string[],
  budget: number,
  cost: (id: string) => number,
  count: number,
  /**
   * 这一支编成里**最多只能有一个英雄**（本体规则：同一方场上英雄唯一）。
   *
   * 不传 = 不限制（老的调用点行为不变）。传了之后，第二个英雄位置会被
   * 同价位的普通兵顶掉——不这样做，L2 奇想的 boss 会带着两个英雄出场，
   * 而玩家那边一个都凑不齐。
   */
  isHero?: (id: string) => boolean,
): string[] {
  const sorted = [...pool].filter((id) => cost(id) > 0).sort((a, b) => cost(b) - cost(a));
  if (sorted.length === 0) return [];
  const cheapest = sorted[sorted.length - 1] as string;
  const cheapestCost = Math.max(1, cost(cheapest));

  const out: string[] = [];
  const heroTaken = (): boolean => (isHero ? out.some((id) => isHero(id)) : false);
  let left = budget;
  const slots = Math.max(1, Math.min(14, count));
  for (let i = 0; i < slots; i += 1) {
    /*
     * 每一个位置先**扣掉后面所有人的最低开销**，剩下的才是这个位置能花的钱。
     *
     * 上一版第一个位置直接拿一半预算，钱少的局里这一半刚好买一个贵兵，
     * 剩下的位置连最便宜的都不够——"算 4 个人、场上只来 3 个"。
     * 先留底再花，人数才一定凑得齐；第一个位置仍然多分一点，编成里才有尖子。
     */
    const rest = slots - i - 1;
    const reserve = rest * cheapestCost;
    const spendable = Math.max(cheapestCost, left - reserve);
    const cap = spendable;
    const affordable = sorted.filter((id) => cost(id) <= cap);
    /*
     * 英雄名额：已经有一个了，就只剩下普通兵可选。
     * 全都够不着时退回"买得起的最便宜那个"，人数优先。
     */
    const banned = heroTaken();
    const cands = (banned ? affordable.filter((id) => !isHero?.(id)) : affordable);
    const usable = cands.length > 0 ? cands : affordable.filter((id) => !isHero?.(id));
    const pickPool = usable.length > 0 ? usable : affordable;
    let pick = pickPool[0] ?? cheapest;
    /*
     * 别连着买四个一样的。
     *
     * 价格差在 15% 以内的两个兵战力接近，换着买不影响强度，但看起来是
     * "一支什么样的队伍"，而不是"四个同一个模子"。价格差得远就不换——
     * 宁可重复，也不要为了好看把编成拉垮。
     */
    if (out.length > 0 && pick === out[out.length - 1]) {
      const alt = pickPool.find((id) => id !== pick && cost(id) >= cost(pick) * 0.85);
      if (alt) pick = alt;
    }
    if (cost(pick) > left) break;
    out.push(pick);
    left -= cost(pick);
  }
  if (out.length === 0) out.push(cheapest);
  return out;
}
