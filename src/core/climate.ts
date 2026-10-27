/**
 * 「季节与气候」：一张地形 × 海陆距离 × 季节的天气表。
 *
 * 这个扩展改的是**战场条件**而不是数值：同一块地，春天是湿冷的、
 * 夏天是酷暑的、冬天可能是严冬——单位还是那些单位，但"这片地怎么打"变了。
 *
 * 三条设计上的取舍，写在这儿免得以后自己被自己坑：
 *
 *   1. **气候不碰城市**。城市是"人住的地方"，自带供暖排水；让它也吃气候，
 *      就等于把一个全局乘数压到产能上，玩家除了骂人没事可做。
 *   2. **季节从回合数派生，不存进存档**。`floor((回合-1)/10) % 4` 一算就有，
 *      存档不用多一个字段，读旧档也不会因为缺字段而算错季节。
 *   3. **气候按格算，不按全局算**。所以它必须挂在"这一格"上：
 *      移动力看出发格、护甲看挨打的那个兵站哪儿、产出看经济单位脚下。
 *      做成全局修正会简单得多，但那样"沿海的平原"和"内陆的平原"就没区别了，
 *      整张海陆距离表也就白算。
 *
 * 这个文件只依赖 types.ts：规则层要用它，它不能反过来依赖规则层，
 * 否则 rules → expansions → climate → rules 绕成一圈。
 */

import type { GameState, Terrain, Unit } from './types.ts';

/* ------------------------------------------------------------------ */
/* 1. 季节                                                             */
/* ------------------------------------------------------------------ */

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

/** 每 10 回合换一个季节 */
export const SEASON_TURNS = 10;

const SEASON_ORDER: Season[] = ['spring', 'summer', 'autumn', 'winter'];

export const SEASON_NAME: Record<Season, string> = {
  spring: '春',
  summer: '夏',
  autumn: '秋',
  winter: '冬',
};

/**
 * 现在是什么季节。
 *
 * 从回合数派生而不是存进 state：存档不用多一个字段，旧档读进来也不会算错。
 * 第 1~10 回合是春，11~20 是夏，以此类推，40 回合一年。
 */
export function seasonOf(turn: number): Season {
  const n = Math.max(1, Math.floor(turn));
  return SEASON_ORDER[Math.floor((n - 1) / SEASON_TURNS) % SEASON_ORDER.length]!;
}

/* ------------------------------------------------------------------ */
/* 2. 海陆距离                                                         */
/* ------------------------------------------------------------------ */

/**
 * 陆地三档 / 水域三档。
 *
 * 判定用**方形邻域**（切比雪夫距离）：说"周围 2 格内"时，人想的是
 * 以这一格为中心的一个方块，而不是曼哈顿距离画出来的菱形。
 */
export type Coast = 'coastal' | 'nearshore' | 'inland' | 'shore' | 'shallow' | 'deep';

export const COAST_NAME: Record<Coast, string> = {
  coastal: '沿海',
  nearshore: '近岸',
  inland: '内陆',
  shore: '沿岸',
  shallow: '浅海',
  deep: '深海',
};

function terrainAt(s: GameState, x: number, y: number): Terrain | null {
  if (x < 0 || y < 0 || x >= s.w || y >= s.h) return null;
  const t = s.tiles[y * s.w + x];
  return t ? t.terrain : null;
}

/** 桥面按水域算：桥底下就是河，它不该把"这片是水"这件事抹掉 */
function isWaterTerrain(t: Terrain | null): boolean {
  return t === 'water' || t === 'bridge';
}

function isLandTerrain(t: Terrain | null): boolean {
  return t !== null && !isWaterTerrain(t);
}

/** 方圆 r 格内有没有满足条件的格子（不含中心格自己） */
function anyWithin(
  s: GameState,
  x: number,
  y: number,
  r: number,
  test: (t: Terrain | null) => boolean,
): boolean {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (test(terrainAt(s, x + dx, y + dy))) return true;
    }
  }
  return false;
}

/**
 * 这一格的海陆距离。
 *
 * 不缓存：一次判定最多扫 7×7 格，纯数组下标，代价可以接受；
 * 而缓存会踩到一个真问题——**造桥会把水格改成桥面**，
 * 海陆距离当场就变了。按 state 对象缓存会读到旧值，
 * 按地形签名缓存又要维护失效逻辑。宁可慢一点，也不要一层看不见的错。
 *
 * 陆地：方圆 2 格内有水 → 沿海；方圆 7 格内没水 → 内陆；其余 → 近岸。
 * 水域：方圆 2 格内有陆 → 沿岸；方圆 7 格内没陆 → 深海；其余 → 浅海。
 */
export function coastClassOf(s: GameState, x: number, y: number): Coast {
  const t = terrainAt(s, x, y);
  if (t === null) return 'inland';

  if (isWaterTerrain(t)) {
    if (anyWithin(s, x, y, 2, isLandTerrain)) return 'shore';
    if (!anyWithin(s, x, y, 7, isLandTerrain)) return 'deep';
    return 'shallow';
  }
  if (anyWithin(s, x, y, 2, isWaterTerrain)) return 'coastal';
  if (!anyWithin(s, x, y, 7, isWaterTerrain)) return 'inland';
  return 'nearshore';
}

/* ------------------------------------------------------------------ */
/* 3. 气候                                                             */
/* ------------------------------------------------------------------ */

export type Climate =
  | 'mild'
  | 'cold'
  | 'hardWinter'
  | 'hot'
  | 'blazing'
  | 'dampCold'
  | 'dampHeat'
  | 'overcast'
  | 'downpour'
  | 'fog'
  | 'thunder'
  | 'frozen'
  | 'driftIce'
  | 'storm';

export const CLIMATE_NAME: Record<Climate, string> = {
  mild: '温和',
  cold: '寒冷',
  hardWinter: '严冬',
  hot: '炎热',
  blazing: '酷暑',
  dampCold: '湿冷',
  dampHeat: '湿热',
  overcast: '阴雨',
  downpour: '暴雨',
  fog: '浓雾',
  thunder: '雷暴',
  frozen: '封冻',
  driftIce: '浮冰',
  storm: '风暴',
};

/** 地形归到哪一类（城市、桥这类"其他"一律温和，不参与冲突判定） */
function terrainClass(t: Terrain | null): 'plain' | 'hill' | 'mountain' | 'forest' | 'water' | 'other' {
  switch (t) {
    case 'plain':
      return 'plain';
    case 'hill':
      return 'hill';
    case 'mountain':
      return 'mountain';
    case 'forest':
      return 'forest';
    case 'water':
      return 'water';
    default:
      return 'other';
  }
}

/**
 * 气候矩阵：地形 × 海陆距离 × 季节。
 *
 * 直接照着设计表抄下来，没有再"抽象"一层——这张表的每一个格子都是
 * 一次编辑决定（比如"山地沿海的春天是浓雾"），抽象成公式只会把它藏起来。
 */
const TABLE: Record<'plain' | 'hill' | 'mountain' | 'forest' | 'water', Record<Coast, Record<Season, Climate>>> = {
  plain: {
    coastal: { spring: 'dampCold', summer: 'mild', autumn: 'overcast', winter: 'mild' },
    nearshore: { spring: 'mild', summer: 'hot', autumn: 'mild', winter: 'cold' },
    inland: { spring: 'mild', summer: 'blazing', autumn: 'mild', winter: 'cold' },
    shore: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
    shallow: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
    deep: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
  },
  hill: {
    coastal: { spring: 'overcast', summer: 'downpour', autumn: 'mild', winter: 'dampCold' },
    nearshore: { spring: 'mild', summer: 'overcast', autumn: 'overcast', winter: 'cold' },
    inland: { spring: 'mild', summer: 'hot', autumn: 'fog', winter: 'cold' },
    shore: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
    shallow: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
    deep: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
  },
  mountain: {
    coastal: { spring: 'fog', summer: 'downpour', autumn: 'dampCold', winter: 'cold' },
    nearshore: { spring: 'overcast', summer: 'thunder', autumn: 'cold', winter: 'hardWinter' },
    inland: { spring: 'cold', summer: 'mild', autumn: 'cold', winter: 'hardWinter' },
    shore: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
    shallow: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
    deep: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
  },
  forest: {
    coastal: { spring: 'fog', summer: 'dampHeat', autumn: 'overcast', winter: 'dampCold' },
    nearshore: { spring: 'overcast', summer: 'dampHeat', autumn: 'fog', winter: 'cold' },
    inland: { spring: 'mild', summer: 'hot', autumn: 'fog', winter: 'cold' },
    shore: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
    shallow: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
    deep: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
  },
  water: {
    coastal: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
    nearshore: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
    inland: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
    shore: { spring: 'fog', summer: 'mild', autumn: 'overcast', winter: 'frozen' },
    shallow: { spring: 'driftIce', summer: 'storm', autumn: 'storm', winter: 'driftIce' },
    deep: { spring: 'storm', summer: 'thunder', autumn: 'storm', winter: 'mild' },
  },
};

/**
 * 这一格现在是什么气候。
 *
 * 不算扩展有没有开——开不开由调用方决定（扩展没开时这些钩子根本不会被调用）。
 */
export function climateAt(s: GameState, x: number, y: number): Climate {
  const cls = terrainClass(terrainAt(s, x, y));
  if (cls === 'other') return 'mild';
  const coast = coastClassOf(s, x, y);
  return TABLE[cls][coast][seasonOf(s.turn)] ?? 'mild';
}

/** 某个单位脚下是什么气候 */
export function climateOfUnit(s: GameState, u: Unit): Climate {
  return climateAt(s, u.x, u.y);
}

/* ------------------------------------------------------------------ */
/* 4. 气候效果表                                                       */
/* ------------------------------------------------------------------ */

export interface ClimateEffect {
  /** 移动力倍率（0.75 / 0.5） */
  moveMul?: number;
  /** 每走一格额外消耗的点数（暴雨 +2） */
  moveCostAdd?: number;
  /** 护甲惩罚（正数表示扣多少） */
  armorPenalty?: number;
  /** 护甲惩罚只对"不在城里驻扎的军队"生效（严冬） */
  armorPenaltyOnlyField?: boolean;
  /** 经济产出倍率 */
  incomeMul?: number;
  /** 攻击范围增减（阴雨 -1、暴雨 -2） */
  rangeAdd?: number;
  /** 攻击范围上限（浓雾 4） */
  rangeMax?: number;
  /** 视野上限（浓雾 2） */
  visionMax?: number;
  /** 回合结束的固定伤害 */
  endDamage?: { hits: number; amount: number; splash?: number; radius?: number };
  /** 维护费比例（按自身造价收金币） */
  upkeepRate?: number;
  /** 交不起维护费时的真实伤害（按血量上限比例） */
  upkeepHpRatio?: number;
  /** 海军移动力归零（封冻） */
  navyMoveZero?: boolean;
  /** 海军移动力倍率（浮冰 0.75） */
  navyMoveMul?: number;
  /** 陆军可以在冰面（水格）上走（封冻） */
  landOnIce?: boolean;
}

const EFFECTS: Record<Climate, ClimateEffect> = {
  mild: {},
  cold: { moveMul: 0.75, incomeMul: 0.5 },
  hardWinter: { moveMul: 0.5, armorPenalty: 3, armorPenaltyOnlyField: true },
  hot: { moveMul: 0.75, incomeMul: 1.25 },
  blazing: { moveMul: 0.5, armorPenalty: 2 },
  dampCold: { incomeMul: 2, upkeepRate: 0.05, upkeepHpRatio: 0.1 },
  dampHeat: { incomeMul: 2.5, upkeepRate: 0.1, upkeepHpRatio: 0.05 },
  overcast: { moveMul: 0.75, incomeMul: 1.25, rangeAdd: -1 },
  downpour: { moveCostAdd: 2, rangeAdd: -2 },
  fog: { visionMax: 2, rangeMax: 4 },
  thunder: { endDamage: { hits: 1, amount: 50, splash: 0.5, radius: 1 }, incomeMul: 3 },
  frozen: { navyMoveZero: true, landOnIce: true },
  driftIce: { navyMoveMul: 0.75 },
  storm: { endDamage: { hits: 5, amount: 10 } },
};

export function climateEffect(c: Climate): ClimateEffect {
  return EFFECTS[c] ?? {};
}

/** 这个单位是不是水军（水军吃"封冻 / 浮冰"，陆军吃"冰面"） */
export function isNaval(def: { domain?: string }): boolean {
  return def.domain === 'water';
}
