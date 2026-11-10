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

/** 季节顺序（春→夏→秋→冬）。`field.ts` 按它算"这一季的中点"，所以导出。 */
export const SEASON_ORDER: Season[] = ['spring', 'summer', 'autumn', 'winter'];

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
  /** 大风：晴天但风大——空军逆风每格多花 1 点 */
  | 'gale'
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
  gale: '大风',
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
  /**
   * 空军**逆风**时每格多花的移动点。
   *
   * 只认逆风：顺风不加也不减。给 −1 会造出"每格 0 消耗"这种结算，
   * 玩家算不清一格到底花多少，而且在整数移动力上会放大成"白嫖几格"。
   */
  airUpwindCostAdd?: number;
  /** 护甲惩罚（正数表示扣多少） */
  armorPenalty?: number;
  /** 护甲惩罚只对"不在城里驻扎的军队"生效（严冬） */
  armorPenaltyOnlyField?: boolean;
  /**
   * 经济产出加成，**百分数、相加**（0.15 = +15%）。
   *
   * 为什么是加法不是乘法：天气是**多档同时生效**的（温度一档、湿度一档、
   * 降水一档），乘法叠两次就失控——原来的「湿热」×2.5 再撞上「温暖」×1.25
   * 就是 3.1 倍。加法封顶在 ±60%/90%，怎么叠都在玩家算得清的范围内。
   */
  incomeBonus?: number;
  /** 攻击范围增减（阴雨 -1、暴雨 -2） */
  rangeAdd?: number;
  /** 攻击范围上限（浓雾 2） */
  rangeMax?: number;
  /** 视野上限（浓雾 2） */
  visionMax?: number;
  /**
   * `visionMax` / `rangeMax` 只对**视野不超过这个数**的部队生效（浓雾 5）。
   *
   * 浓雾原来是"所有单位一律压到 2"，连视野 8 的侦察单位也一起按住——
   * 高时代花大价钱买的"看得远"在雾天被一笔抹平，很别扭。
   * 现在改成只收拾"本来就看不太远"的部队：雾对它们才是致命的，
   * 而对高视野单位只是少看见一点（它们照样能看见，只是不再有优势）。
   */
  fogVisionLine?: number;
  /**
   * 这一格命中的**组合效果**。由多个驱动一起凑出来的那几种，
   * 单独起个名字讲：温度湿度风都是玩家能读到的数，但"多少度加多少湿度
   * 会起雾"没人算得出来，得直接告诉他"这是浓雾"。
   *
   * 一次只会有一个：起雾要求不下雨，雷暴/风暴要求下大雨，封冻要求结冰，
   * 天然互斥。
   */
  combo?: 'fog' | 'thunder' | 'storm' | 'freeze' | 'ice';
  /** 回合结束的固定伤害 */
  endDamage?: { hits: number; amount: number; splash?: number; radius?: number };
  /**
   * 每回合的**固定**维护费（金）。
   *
   * 不按造价比例收：比例制下高级单位交得更多，而它的产出也更多——
   * 结果"高时代更抗天气"这件事反而体现不出来。固定金额才是
   * "廉价单位心疼、高级单位无感"。
   */
  upkeepGold?: number;
  /** 交不起维护费时的真实伤害（按血量上限比例） */
  upkeepHpRatio?: number;
  /** 海军移动力归零（封冻） */
  navyMoveZero?: boolean;
  /** 海军移动力倍率（浮冰 0.75） */
  navyMoveMul?: number;
  /** 陆军可以在冰面（水格）上走（封冻） */
  landOnIce?: boolean;
}

/*
 * 效果表已经搬走了：现在是 `effect.ts` 里的 `weatherEffect(drivers)`——
 * 由温度、湿度、风、降水、抬升**各自算一档再叠加**，不再"一个标签一组加成"。
 * 这个文件只留标签本身（类型、名字）和它们共同的效果结构。
 */

/** 这个单位是不是水军（水军吃"封冻 / 浮冰"，陆军吃"冰面"） */
export function isNaval(def: { domain?: string }): boolean {
  return def.domain === 'water';
}
