/**
 * 「季节与气候」的**骨架**：季节、海陆距离、14 个标签、以及每个标签改什么。
 *
 * ── 这个文件里没有"天气表"了 ──────────────────────────────
 *
 * 原来这里有一张 地形 × 海陆 × 季节 的 120 格表，每格填一个天气。
 * 它被删掉了，换成 `field.ts` 里的温湿度场——那张表当初是为了让人**口算**
 * 才设计成离散的，而条目的编辑决定（"山地沿海的春天是浓雾"）现在变成了
 * 温度、湿度、降水的**后果**。
 *
 * 表本身没浪费：它搬到了 `scripts/tune-climate.ts`，成了回归比对的期望值。
 *
 * ── 三条设计上的取舍（从原表时代保留下来）──────────────────
 *
 *   1. **气候不碰城市**。城市是"人住的地方"，自带供暖排水；让它也吃气候，
 *      就等于把一个全局乘数压到产能上，玩家除了骂人没事可做。
 *   2. **季节从回合数派生，不存进存档**。`floor((回合-1)/10) % 4` 一算就有。
 *   3. **气候按格算，不按全局算**。移动力看出发格、护甲看挨打的那个兵站哪儿、
 *      产出看经济单位脚下。做成全局修正会简单得多，但那样"沿海的平原"和
 *      "内陆的平原"就没区别了。
 *
 * 依赖方向是**单向**的：本文件只依赖 types.ts；`field.ts` 依赖本文件。
 * 气温场要读季节和海陆距离，反过来不行——否则
 * rules → expansions → field → climate → field 会绕成一圈。
 */

import type { GameState, Terrain } from '../types.ts';

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
  /** 温和偏冷：行军舒服（移动 +1） */
  | 'cool'
  /** 温和偏热：作物长得好（产出 +25%） */
  | 'warm'
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
  cool: '凉爽',
  warm: '温暖',
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

/** `climateAt` 在 field.ts（它要读温湿度场）。这里只留"表"本身：
 *  类型、季节、海陆距离、效果表——它们不依赖场，所以不会和 field 成环。 */

/* ------------------------------------------------------------------ */
/* 4. 气候效果表                                                       */
/* ------------------------------------------------------------------ */

export interface ClimateEffect {
  /**
   * 移动力**加法**修正（凉爽 +1）。
   *
   * 为什么不复用 `moveMul`：移动力是整数，`move × 0.85` 对 move 2 的兵
   * 会 `floor` 成 1——**"只减 15%"实际减了 50%**。所以低移动单位的任何
   * 乘法减速都是一刀砍半，对增益同理（×1.25 对 move 2 完全不生效）。
   * 加减法才是玩家能预期的那种修正。
   */
  moveAdd?: number;
  /** 移动力倍率（只留给严冬 / 酷暑这种"真的走不动"的极端天气） */
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

/**
 * 每个天气改什么。
 *
 * ── 一条原则：**降温降的是经济，不是腿** ──────────────────
 *
 * 早先"冷 / 热 / 阴雨"三档各带 `moveMul: 0.75`，玩家反馈说"到处都在减移动力，
 * 战斗节奏太折磨"。数学上这比看上去更狠：移动力是整数，`2 × 0.75 = 1.5`
 * 向下取整是 1——**标着 −25%，实际是 −50%**，而且越慢的兵越吃亏
 * （骑兵 5 → 3 只掉 40%，步兵 2 → 1 掉了 50%）。
 *
 * 所以现在：**只有真正的极端天气减速**（严冬、酷暑、暴雨），
 * 日常的冷暖只动产出与护甲。爽快的行军节奏比"精确模拟寒冷"重要得多。
 *
 * 反过来的增益也一样：`× 1.25` 对 move 2 的单位毫无效果（2.5 取整还是 2），
 * 所以「凉爽」给的是 `moveAdd: +1` 这种**看得见**的加法。
 */
const EFFECTS: Record<Climate, ClimateEffect> = {
  mild: {},
  // 凉爽：天不热不冷，行军最舒服。这是本扩展唯一一个**加速**的天气
  cool: { moveAdd: 1 },
  // 温暖：作物长得好，部队不额外受累
  warm: { incomeMul: 1.25 },
  // 寒冷：只让经济难受，不拖慢部队
  cold: { incomeMul: 0.7 },
  hot: { incomeMul: 1.25, armorPenalty: 1 },
  hardWinter: { moveMul: 0.5, armorPenalty: 3, armorPenaltyOnlyField: true },
  blazing: { moveMul: 0.5, armorPenalty: 2 },
  dampCold: { incomeMul: 2, upkeepRate: 0.05, upkeepHpRatio: 0.1 },
  dampHeat: { incomeMul: 2.5, upkeepRate: 0.1, upkeepHpRatio: 0.05 },
  overcast: { incomeMul: 1.25, rangeAdd: -1 },
  // 暴雨是"路烂了"而不是"人累了"：多花一点移动点，但不砍总移动力
  downpour: { moveCostAdd: 1, rangeAdd: -2 },
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
