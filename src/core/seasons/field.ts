/**
 * 温湿度场：「季节与气候」真正在算的东西。
 *
 * ── 为什么不再查那张 120 格表 ──────────────────────────────
 *
 * 那张表是**纸上的东西**：地形 × 海陆距离 × 季节，每格填一个天气。
 * 它好写、好查，但它是为了"让人口算"而设计的——所以它只能有三档海陆、
 * 只能有四个季节、只能一格一个固定答案，天气永远不会自己变。
 *
 * 电脑不用迁就口算。这里换成两个连续的场：
 *
 *   · `temp`（0.1°C 的整数）——季节基准 + 海陆年温差 + 地形海拔，
 *     再按各自的热容**慢慢趋近**目标。相位延迟是这么来的：
 *     夏天到了，海水还是凉的。
 *   · `wet`（0~100 的绝对湿度）——蒸发注入、**随风平流**、向四邻扩散、
 *     超过饱和线就下雨。"海陆距离"不再是查表的一个维度，而是**输运的自然结果**：
 *     靠水的地方潮，往里走越来越干。
 *   · `wind`（`windX` / `windY`，百分之一格每步）——由**温度梯度**推出来：
 *     p ≈ −T，冷处压高、暖处压低，风顺着梯度吹；再叠一层季节主导风。
 *     有了它，湿度才会"挪"而不是只"漫"——雨带跟着风走，云在动。
 *
 * 最后一步把 `(temp, wet, 降水强弱, 风)` 判回那 17 个标签。
 * **这一步是刻意的**：`ClimateEffect` 表、五条规则钩子、侧栏文案、
 * 天气视图全都不用动——换的是数据来源，不是天气系统。
 *
 * ── 确定性 ────────────────────────────────────────────────
 *
 * 全程只用加减乘除和 `Math.round`，**没有 sin / exp / pow**。
 * 超越函数在不同引擎之间有 ULP 级差异，一旦天气卡在阈值边界，
 * 回放两端就会算出不同的天气（"这回合能不能走"会分歧）。
 * 季节基准本来就是 4 个常数，所谓"正弦波"只是给这 4 个数定来源，不必真的算。
 *
 * ── 存哪儿 ────────────────────────────────────────────────
 *
 * `Tile.custom.temp` / `Tile.custom.wet`，和灵气同一个沙盒
 * （见 types.ts 的 `Tile.custom`）。缺省值按地形现算，所以老存档、
 * 新地图都不需要初始化。
 *
 * ── 可调 ──────────────────────────────────────────────────
 *
 * 全部参数集中在 `TUNING` 里，`scripts/tune-climate.ts` 会就地改它扫参。
 * 所以这里的每个数都是**可覆盖的初值**，不是写死的物理常数。
 *
 * ⚠️ 红线：本文件只能 import `climate.ts`（它不反向依赖这里）。
 * `climate.ts` 放类型、季节、海陆距离、效果表；`climateAt` 搬到了这里。
 */
import type { GameState, Terrain } from '../types.ts';
import { coastClassOf, seasonOf, type Climate, type Coast, type Season } from './climate.ts';

/* ------------------------------------------------------------------ */
/* 1. 参数                                                             */
/* ------------------------------------------------------------------ */

export interface TerrainClimate {
  /** 海拔/地表造成的固定温差（0.1°C）：山地 −11°C，沙丘 +4°C */
  temp: number;
  /**
   * 相对湿润倾向（百分数）。缺省湿度 = `饱和值 × 这个数 / 100`。
   *
   * 超过 100 就是"过饱和"——水面和沼泽天生就在下雨，不用等演化。
   */
  wet: number;
  /** 每步向空气里送多少水 */
  evap: number;
  /** 向目标温度靠拢的比例（千分数）。**小 = 热容大 = 相位延迟** */
  heat: number;
  /**
   * 成雾倾向（加到"起雾线"上，正数更容易起雾）。
   *
   * 这一项是**唯一直读地形**的地方，因为地形抬升/山谷积雾是真实存在的
   * 局地现象：同温同湿的平原和山地，山地先起雾。把它折进温度或湿度
   * 都会牵动整张图（山地会变潮、或者变冷），反而是特判更干净。
   */
  fogBias?: number;
}

export interface ClimateTuning {
  /** 四季基准气温（0.1°C）。秋比春高半度 = 秋老虎 */
  seasonTemp: Record<Season, number>;
  /** 年温差围绕它展开 */
  tempMean: number;
  /**
   * 海陆**年温差系数**（百分数）。这是"海陆距离"的物理真身：
   * 水比热大，沿海年温差小（冬暖夏凉）；内陆是大陆性气候。
   */
  coastAmp: Record<Coast, number>;
  /** 地形的气象属性 */
  terrain: Record<Terrain, TerrainClimate>;
  /** 海陆的**湿度加成**：靠海更潮 */
  coastWet: Record<Coast, number>;
  /** 季节的湿度偏移：春天化雪、秋高气爽 */
  seasonWet: Record<Season, number>;
  /** 湿度的损耗比例（每步）。`蒸发 / 损耗` 就是孤立地皮的平衡湿度 */
  wetDecay: number;
  /**
   * 湿度扩散系数。用**凸组合**写法（`new = old + D×(邻居均值−old)`），
   * 对任意 D ≤ 1 都稳定，不用担心"4 个邻居一乘超过 0.25"。
   * 太大就会把"靠海潮、内陆干"这层梯度抹平。
   */
  wetDiffuse: number;
  /** 饱和线：`sat = satBase + temp × satPerTemp / 1000` */
  satBase: number;
  satPerTemp: number;
  /**
   * 过饱和多少算**大雨**（小于它算小雨 / 阴天）。
   *
   * 这个数和"蒸发"是一对：一块地的过饱和量会稳定在 `蒸发 / rainDrain`，
   * 所以水面（蒸发强）能冲到十几点、平地只有几点——**大雨是水边的特权**。
   */
  /**
   * 起风暴的最低水温（0.1°C），按**离岸格数**分三档。
   *
   * 风暴要开阔水面才刮得起来，但判定不能用 `coastClassOf` 的"深海"档——
   * 它要求方圆 7 格没有陆地，而 16~32 格的小地图上**一格都满足不了**，
   * 整片海都会被判成"沿岸"，于是"只在外海起风暴"就等于"永远不起风暴"。
   * 离岸距离是连续的，大小图都能分出层次。
   */
  stormTemp: { coast: number; near: number; open: number };
  heavyMargin: number;
  /** 过饱和的水汽每步凝结掉多少比例（云、露、雨都算） */
  rainDrain: number;
  /** 每步至少凝掉这么多，否则会卡在饱和线上永远不落下来 */
  rainMinDrain: number;
  /**
   * 判类阈值（0.1°C）。**七个档按温度排开**：
   *
   *   严冬 < −10°C < 寒冷 < 5°C < 凉爽 < 13°C < 温和 < 20°C < 温暖 < 27°C < 炎热 < 32°C < 酷暑
   *
   * 这组数是照"体感"定的，不是照物理定的：20°C 上下才是"温和"，
   * 24°C 该觉得暖和，6°C 该觉得凉——早先 24°C 报"炎热"、6°C 报"温和"，
   * 玩家一眼就看出不对。
   */
  hardWinterAt: number;
  coldAt: number;
  coolAt: number;
  warmAt: number;
  hotAt: number;
  blazingAt: number;
  /** 相对湿度超过它、又没下雨 → 起雾 */
  fogLine: number;
  /** 相对湿度超过它 → 湿冷 / 湿热 */
  dampWet: number;
  /**
   * 主导风向（百分之一格/步）。四季各一个，风往哪儿吹。
   *
   * 这一项是"天气系统整体往哪边漂"的骨架：冬天北风往南吹，夏天南风往北吹，
   * 春天西风往东吹。玩家记住的是"冬天的云往南跑"，不是某个浮点数。
   */
  prevailing: Record<Season, { x: number; y: number }>;
  /**
   * 阵风周期（百分数），每 2 回合换一档。
   *
   * 没有它，主导风是个常数——要么全年天天大风，要么一年到头都没有。
   * 这张表让"这几天风大"成串出现（16 回合一个来回），不用引入压力场演化。
   */
  gust: number[];
  /**
   * 温度梯度换算成风速的系数（千分数）。
   *
   * 物理上气压 ≈ −温度（冷空气重、压得高），风从高压吹向低压，
   * 也就是**顺着温度梯度吹**：海边/山脚这些温差大的地方自带一股风。
   */
  windGrad: number;
  /** 风速上限（百分之一格/步）。同时也是"再大风也不会把云吹过半个地图"的闸 */
  windMax: number;
  /** 判「大风」的风速线（百分之一格/步） */
  galeAt: number;
  /** 湿度平流的折扣（百分数）：100 = 完全按风速漂 */
  wetDrift: number;
}

/**
 * 全部可调参数。改这里 = 改天气的手感，别处不用动。
 *
 * 数值不是"物理正确"，是"跑出来像那张表"。调参脚本
 * （`scripts/tune-climate.ts`）会拿原来那张 120 格表当期望值扫参。
 */
export const TUNING: ClimateTuning = {
  seasonTemp: { spring: 150, summer: 300, autumn: 155, winter: -60 },
  tempMean: 136,
  coastAmp: { coastal: 60, nearshore: 85, inland: 115, shore: 105, shallow: 95, deep: 85 },
  terrain: {
    plain: { temp: 0, wet: 62, evap: 2.6, heat: 480 },
    forest: { temp: -25, wet: 78, evap: 3.4, heat: 420 },
    hill: { temp: -30, wet: 72, evap: 3.0, heat: 450 },
    mountain: { temp: -130, wet: 66, evap: 2.2, heat: 460, fogBias: 0.08 },
    plateau: { temp: -60, wet: 60, evap: 2.0, heat: 440 },
    valley: { temp: -10, wet: 70, evap: 2.8, heat: 470 },
    marsh: { temp: -20, wet: 96, evap: 4.6, heat: 430 },
    dune: { temp: 40, wet: 32, evap: 0.6, heat: 550 },
    city: { temp: 0, wet: 55, evap: 2.0, heat: 480 },
    bridge: { temp: 0, wet: 105, evap: 8.5, heat: 200 },
    water: { temp: 0, wet: 105, evap: 8.5, heat: 100 },
    shallow: { temp: 0, wet: 100, evap: 7.5, heat: 200 },
    deep: { temp: 0, wet: 108, evap: 8.0, heat: 50 },
  },
  coastWet: { coastal: 16, nearshore: 7, inland: 0, shore: 0, shallow: 0, deep: 0 },
  seasonWet: { spring: 6, summer: 0, autumn: -3, winter: -18 },
  wetDecay: 0.09,
  wetDiffuse: 0.08,
  satBase: 48,
  satPerTemp: 90,
  stormTemp: { coast: 265, near: 195, open: 120 },
  heavyMargin: 5,
  rainDrain: 0.4,
  rainMinDrain: 2,
  hardWinterAt: -100,
  coldAt: 50,
  coolAt: 130,
  warmAt: 200,
  hotAt: 270,
  blazingAt: 320,
  fogLine: 0.76,
  dampWet: 0.86,
  // 风往哪儿吹（1/100 格每步）：春天西风、夏天南风、秋天西偏北、冬天北风
  prevailing: {
    spring: { x: 16, y: 0 },
    summer: { x: 2, y: -12 },
    autumn: { x: 12, y: 5 },
    winter: { x: 5, y: 20 },
  },
  gust: [90, 110, 140, 100, 80, 120, 160, 100],
  windGrad: 450,
  windMax: 55,
  galeAt: 26,
  wetDrift: 100,
};

/* -- 只读常量：不参与扫参 -------------------------------------------- */

/** 温度的单位：存整数，1 表示 0.1°C */
export const TEMP_SCALE = 10;
/** 温度的上下界（−40.0°C ~ 50.0°C） */
export const TEMP_MIN = -400;
export const TEMP_MAX = 500;
/** 湿度的域 */
export const WET_MAX = 100;

/* ------------------------------------------------------------------ */
/* 2. 两个场的读写                                                     */
/* ------------------------------------------------------------------ */

function isWaterTerrain(t: Terrain | undefined): boolean {
  return t === 'water' || t === 'deep' || t === 'shallow' || t === 'bridge';
}

/**
 * 这一格离最近的陆地有几格（切比雪夫距离，只看边圈）。水格用它判"够不够外海"。
 *
 * 为什么不用 `coastClassOf` 的 deep 档：那个要求方圆 7 格没有陆地，
 * 而小地图上整片海都能在 7 格内摸到岸——于是每一格都是"沿岸"，
 * 分级形同虚设。距离是连续的，16 格和 64 格的图上都能分出"贴岸 / 近海 / 外海"。
 */
export function distToLandOf(s: GameState, x: number, y: number): number {
  for (let r = 1; r <= 7; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        // 只看这一圈的边：内圈上一轮已经查过了
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const t = tileAt(s, x + dx, y + dy);
        if (!t) continue;
        if (!isWaterTerrain(t.terrain)) return r;
      }
    }
  }
  return 8;
}

function clampTemp(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(TEMP_MIN, Math.min(TEMP_MAX, Math.round(v)));
}

function clampWet(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(WET_MAX, Math.round(v)));
}

function tileAt(s: GameState, x: number, y: number) {
  if (x < 0 || y < 0 || x >= s.w || y >= s.h) return null;
  return s.tiles[y * s.w + x] ?? null;
}

/** 地形归到哪一类。未知地形按平原算，别让新地形把天气搞崩 */
function profileOf(t: Terrain | undefined): TerrainClimate {
  return TUNING.terrain[t ?? 'plain'] ?? TUNING.terrain.plain;
}

/** 饱和线本身（判类和脚本共用） */
export function satOf(temp: number): number {
  return Math.max(10, TUNING.satBase + Math.round((temp * TUNING.satPerTemp) / 1000));
}

/**
 * 这一格**这一季的目标温度**（0.1°C）。
 *
 * 物理上就是"给足时间的话，这块地会被晒到多少度"：
 * 季节基准 → 按海陆振幅拉开年温差 → 加地形海拔修正。
 */
export function tempTargetOf(s: GameState, x: number, y: number): number {
  const tile = tileAt(s, x, y);
  if (!tile) return TUNING.tempMean;
  const coast = coastClassOf(s, x, y);
  const amp = (TUNING.coastAmp[coast] ?? 100) / 100;
  const base = TUNING.seasonTemp[seasonOf(s.turn)] ?? TUNING.tempMean;
  return clampTemp(
    TUNING.tempMean + (base - TUNING.tempMean) * amp + profileOf(tile.terrain).temp,
  );
}

/**
 * 这一格现在的温度。
 *
 * 没有落库字段时返回**目标温度**——地图一生成就是稳定态，玩家不用等。
 * 和灵气的缺省值同一个思路。
 */
export function tempAt(s: GameState, x: number, y: number): number {
  const tile = tileAt(s, x, y);
  if (!tile) return TUNING.tempMean;
  const stored = tile.custom?.temp;
  if (typeof stored === 'number' && Number.isFinite(stored)) return clampTemp(stored);
  return tempTargetOf(s, x, y);
}

/**
 * 缺省湿度：`饱和值 × 相对湿润倾向`。
 *
 * 用**相对**而不是绝对值，是为了让"冬天的空气本来就装不住那么多水"自动成立——
 * 用绝对值的话，秋天攒下的湿气一入冬就全部变成雪，天天下雪。
 */
function wetBaselineOf(s: GameState, x: number, y: number): number {
  const tile = tileAt(s, x, y);
  if (!tile) return 0;
  const prof = profileOf(tile.terrain);
  const coast = coastClassOf(s, x, y);
  const season = seasonOf(s.turn);
  // 季节湿度偏移只对陆地生效：水的比热大，一年到头都潮，不会"秋高气爽"
  const seasonal = isWaterTerrain(tile.terrain) ? 0 : (TUNING.seasonWet[season] ?? 0);
  const ratio = (prof.wet + (TUNING.coastWet[coast] ?? 0) + seasonal) / 100;
  return clampWet(satOf(tempAt(s, x, y)) * ratio);
}

/** 这一格现在的湿度。没有落库字段时按地形 + 温度现算 */
export function wetAt(s: GameState, x: number, y: number): number {
  const tile = tileAt(s, x, y);
  if (!tile) return 0;
  const stored = tile.custom?.wet;
  if (typeof stored === 'number' && Number.isFinite(stored)) return clampWet(stored);
  return wetBaselineOf(s, x, y);
}

/** 这一格的饱和湿度 */
export function satAt(s: GameState, x: number, y: number): number {
  return satOf(tempAt(s, x, y));
}

export type Precip = 'none' | 'light' | 'heavy';

/** 这一格现在下不下雨、下多大 */
export function precipAt(s: GameState, x: number, y: number): Precip {
  return precipOf(wetAt(s, x, y), satAt(s, x, y));
}

function precipOf(wet: number, sat: number): Precip {
  if (wet <= sat) return 'none';
  return wet >= sat + TUNING.heavyMargin ? 'heavy' : 'light';
}

/* ------------------------------------------------------------------ */
/* 2.5 风场                                                            */
/* ------------------------------------------------------------------ */

/** 风：单位和 `Tile.custom.windX/windY` 同一个刻度（百分之一格/步） */
export interface Wind {
  x: number;
  y: number;
}

/**
 * 这一刻的**主导风**：季节定方向，阵风表定强弱。
 *
 * 没有落库的风时也用它兜底（老存档、地图刚生成），所以"第一回合就有风"。
 */
export function prevailingOf(s: GameState): Wind {
  const base = TUNING.prevailing[seasonOf(s.turn)] ?? { x: 0, y: 0 };
  const turn = Math.max(1, Math.floor(s.turn));
  const g = (TUNING.gust[Math.floor((turn - 1) / 2) % TUNING.gust.length] ?? 100) / 100;
  return { x: Math.round(base.x * g), y: Math.round(base.y * g) };
}

/**
 * 这一格的风。
 *
 * 没落库（老存档 / 刚生成的地图）时返回主导风：风场是"算出来的"，不是"攒出来的"，
 * 缺省值给一个有方向的常规风，比给 0 更接近它该有的样子。
 */
export function windAt(s: GameState, x: number, y: number): Wind {
  const tile = tileAt(s, x, y);
  if (!tile) return { x: 0, y: 0 };
  const wx = tile.custom?.windX;
  const wy = tile.custom?.windY;
  if (typeof wx === 'number' && typeof wy === 'number' && Number.isFinite(wx) && Number.isFinite(wy)) {
    return { x: wx, y: wy };
  }
  return prevailingOf(s);
}

/** 风速（百分之一格/步）。判「大风」、面板读数都用它 */
export function windSpeedAt(s: GameState, x: number, y: number): number {
  const w = windAt(s, x, y);
  return Math.round(Math.sqrt(w.x * w.x + w.y * w.y));
}

/**
 * 风速 → 风力等级（0~12）。
 *
 * 用的是蒲福风的档数，不是我们的内部刻度：玩家看得懂"7 级风"，
 * 看不懂"风速 36"。一档 = 5 个内部刻度，正好让「大风」落在 7 级上。
 */
export function windLevelOf(speed: number): number {
  return Math.max(0, Math.min(12, Math.round(speed / 5)));
}

/** 这一格此刻刮不刮「大风」（判类用） */
export function isGaleAt(s: GameState, x: number, y: number): boolean {
  return windSpeedAt(s, x, y) >= TUNING.galeAt;
}

/**
 * 风场走一步：**从温度场推出来**，不是自己演化。
 *
 * 三步：
 *   1. 压力代理 `p ≈ −T`：冷空气重 → 高压，暖处低压。
 *   2. 温度先做一次 3×3 盒平滑。不做的话，山地与平原交界那一格的温差
 *      会变成一条一格宽的锯齿状"风口"，风场看着像噪点。
 *   3. 风 = 主导风 + k × ∇T（从高压吹向低压，也就是顺着温度梯度）。
 *
 * 全部整数与四则运算：不用 sin/cos，回放两端算出来的风一模一样。
 */
export function stepWind(s: GameState): void {
  const n = s.w * s.h;
  const p = new Array<number>(n);

  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      let sum = 0;
      let cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!tileAt(s, x + dx, y + dy)) continue;
          sum += tempAt(s, x + dx, y + dy);
          cnt++;
        }
      }
      p[y * s.w + x] = cnt === 0 ? 0 : Math.round(sum / cnt);
    }
  }

  const prev = prevailingOf(s);
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = y * s.w + x;
      const tile = s.tiles[i];
      if (!tile) continue;
      // 边界没有"外面那格"，梯度按 0 算：风在图的边上不会凭空拐弯
      const gx = x > 0 && x < s.w - 1 ? p[i + 1]! - p[i - 1]! : 0;
      const gy = y > 0 && y < s.h - 1 ? p[i + s.w]! - p[i - s.w]! : 0;
      const wx = prev.x + Math.round((gx * TUNING.windGrad) / 1000);
      const wy = prev.y + Math.round((gy * TUNING.windGrad) / 1000);
      tile.custom ??= {};
      tile.custom.windX = Math.max(-TUNING.windMax, Math.min(TUNING.windMax, wx));
      tile.custom.windY = Math.max(-TUNING.windMax, Math.min(TUNING.windMax, wy));
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3. 判类                                                             */
/* ------------------------------------------------------------------ */

/**
 * `(温度, 湿度, 降水) → 那 14 个标签`。
 *
 * 分水陆两条线：水温的曲线和气温完全不同（水几乎不结冰、也不酷暑），
 * 硬套一套阈值会得到"外海酷暑"这种结论。
 *
 * 判序从"最极端"往"最普通"走，第一个命中的就是答案。
 */
export function classifyClimate(
  temp: number,
  wet: number,
  precip: Precip,
  water: boolean,
  terrain?: Terrain,
  /** 离岸格数：水面用它决定"刮不刮得起风暴"；陆地不传 */
  distToLand?: number,
  /**
   * 这一格此刻在不在刮大风（由 `isGaleAt` 判）。
   *
   * 传布尔而不是风速：阈值是**气象参数**、就住在本文件的 TUNING 里；
   * `climate.ts` 只负责"大风这件事怎么落到某个天气标签上"。
   */
  gale = false,
): Climate {
  const sat = satOf(temp);
  const r = sat > 0 ? wet / sat : 0;
  // 地形自己也会让雾更早出现（山地抬升、山谷积水）
  const fogLine = TUNING.fogLine + (profileOf(terrain).fogBias ?? 0);

  if (water) {
    // 水面：先看冻不冻，再看风暴，最后才是雾和温和。
    //
    // 「风暴」要暖水才刮得起来：2°C 的外海下大雨只是阴天，不是台风。
    // 少了这道温度闸，冬天整片海都在刮风暴（实测踩到过）。
    if (temp <= 0) return 'frozen';
    if (temp <= 45) return 'driftIce';
    if (precip === 'heavy') {
      if (temp >= TUNING.hotAt) return 'thunder';
      // 越往外海越容易起风暴：贴岸（1 格）要很暖才刮，外海（4 格以上）暖一点就刮。
      // 沿岸是玩家发育的地方，不该常年被风暴堵着（实机反馈）。
      const d = distToLand ?? 1;
      const floor =
        d <= 1 ? TUNING.stormTemp.coast : d <= 3 ? TUNING.stormTemp.near : TUNING.stormTemp.open;
      return temp >= floor ? 'storm' : 'overcast';
    }
    if (precip === 'light') return 'overcast';
    if (r > fogLine) return 'fog';
    return 'mild';
  }

  // ── 降水：先定"下不下"，再定"下什么" ──
  if (precip !== 'none') {
    // 0°C 以下下的是雪。雪天在规则上就是严冬
    if (temp < TUNING.coldAt) return 'hardWinter';
    if (precip === 'heavy') return temp >= TUNING.hotAt ? 'thunder' : 'downpour';
    return 'overcast';
  }

  // ── 不下雨 ──
  //
  // 按温度从冷到热一路排下去：严冬 → 寒冷 → 凉爽 → 温和 → 温暖 → 炎热 → 酷暑。
  // 每一档的"湿"各有归宿：冷 / 凉爽段落到湿冷，温暖 / 炎热段落到湿热，
  // 温和与凉爽段落到浓雾（雾是春秋的东西——夜里地面辐射冷却，
  // 不是"冬天很冷"或"夏天很闷"的另一种说法）。
  if (temp < TUNING.hardWinterAt) return 'hardWinter';
  if (temp < TUNING.coldAt) return r > TUNING.dampWet ? 'dampCold' : 'cold';
  if (temp < TUNING.coolAt) {
    if (r > fogLine) return 'fog';
    return r > TUNING.dampWet ? 'dampCold' : 'cool';
  }
  if (temp < TUNING.warmAt) {
    if (r > fogLine) return 'fog';
    // 大风只**替换「温和」**，不去抢凉爽和温暖。
    //
    // 那两档是玩家手里少有的增益（+1 移动 / +25% 产出），被一个纯空军减益顶掉
    // 会很难受；而「温和」本来就是"这一格没额外影响"，换成大风不亏任何东西。
    // 副作用是这个天气只在 13~20°C 的晴天出现——也就是春天和秋天，正好对。
    if (gale) return 'gale';
    return 'mild';
  }
  if (temp < TUNING.hotAt) return r > TUNING.dampWet ? 'dampHeat' : 'warm';
  if (temp < TUNING.blazingAt) return r > TUNING.dampWet ? 'dampHeat' : 'hot';
  return 'blazing';
}

/**
 * 这一格现在是什么气候。
 *
 * 不算扩展有没有开——开不开由调用方决定（没开时根本不会调进来）。
 * 城市恒为温和：城市是"人住的地方"，自带供暖排水，让它也吃气候
 * 等于把一个全局乘数压到产能上，玩家除了骂人没事可做。
 */
export function climateAt(s: GameState, x: number, y: number): Climate {
  const tile = tileAt(s, x, y);
  if (!tile) return 'mild';
  if (tile.terrain === 'city') return 'mild';
  const temp = tempAt(s, x, y);
  const wet = wetAt(s, x, y);
  const water = isWaterTerrain(tile.terrain);
  return classifyClimate(
    temp,
    wet,
    precipOf(wet, satOf(temp)),
    water,
    tile.terrain,
    water ? distToLandOf(s, x, y) : undefined,
    // 「大风」只在没下雨的温和档里成立（见 classifyClimate）：刮风的日子
    // 本来就不该同时在下雨——那是暴雨/雷暴的分工。
    isGaleAt(s, x, y),
  );
}

/** 某个单位脚下是什么气候 */
export function climateOfUnit(s: GameState, u: { x: number; y: number }): Climate {
  return climateAt(s, u.x, u.y);
}

/* ------------------------------------------------------------------ */
/* 4. 演化                                                             */
/* ------------------------------------------------------------------ */

/**
 * 温度走一步：向这一季的目标温度靠拢。
 *
 * `temp += (target − temp) × heat` **一个式子同时给出相位延迟和振幅衰减**：
 * 热容大的地方（水）走得慢，所以夏天最热时水还没热透、秋天转凉时水还暖着。
 * 不需要另写一条"延迟"规则。
 */
function stepTemperature(s: GameState): void {
  const n = s.w * s.h;
  const next = new Array<number>(n);
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = y * s.w + x;
      const heat = profileOf(s.tiles[i]?.terrain).heat / 1000;
      const cur = tempAt(s, x, y);
      const target = tempTargetOf(s, x, y);
      next[i] = clampTemp(cur + Math.round((target - cur) * heat));
    }
  }
  for (let i = 0; i < n; i++) {
    const tile = s.tiles[i];
    if (!tile) continue;
    tile.custom ??= {};
    tile.custom.temp = next[i]!;
  }
}

/**
 * 湿度走一步：蒸发 → 平流 → 扩散 → 降水 → 截断。
 *
 * 平流是这一版新加的：**云会跟着风走**。用半拉格朗日写法——按风反推
 * "这团水汽上一步在哪"，再在四个角上双线性插值。任意风速都稳定
 * （显式对流要卡 CFL，风速一大就炸），代价是会有一点点数值抹平，
 * 正好顶替了一部分原本靠扩散做的平滑。
 *
 * 剩下的扩散仍然保留一小份：纯平流会让湿度场沿风向拉成丝，看着脏。
 */
function stepHumidity(s: GameState): void {
  const n = s.w * s.h;
  const a = new Array<number>(n);
  const b = new Array<number>(n);

  // 1) 蒸发与损耗：`wet ← wet × (1 − 损耗) + 蒸发`
  //
  // 损耗这一步是**全图干湿的总闸门**：平衡湿度就是 `蒸发 / 损耗`。
  // 漏掉它的话湿度只增不减（降水只在超过饱和时扣一点），跑一年全图饱和、
  // 处处是雾——这条是实测踩出来的。
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = y * s.w + x;
      const prof = profileOf(s.tiles[i]?.terrain);
      const temp = tempAt(s, x, y);
      // 温度因子：−10°C 时 0.225，15°C 时 0.875，30°C 时 1.25
      const factor = Math.max(0.1, Math.min(2.0, 0.5 + (temp + 100) / 400));
      const decayed = wetAt(s, x, y) * (1 - TUNING.wetDecay);
      a[i] = clampWet(decayed + prof.evap * factor);
    }
  }

  // 2) 平流：半拉格朗日采样。
  //
  // 位移 = 风(百分之一格/步) × `wetDrift`。风 30 → 一步挪 0.3 格，
  // 32 格的图上一场雨跨图要 100 多步——正好是"云在慢慢走"的节奏。
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = y * s.w + x;
      const w = windAt(s, x, y);
      const fx = x - (w.x * TUNING.wetDrift) / 10000;
      const fy = y - (w.y * TUNING.wetDrift) / 10000;
      // 采样点钳在图内：边界按"贴边那格的湿度"算，不让水汽漏出地图
      const cx = Math.max(0, Math.min(s.w - 1, fx));
      const cy = Math.max(0, Math.min(s.h - 1, fy));
      const x0 = Math.floor(cx);
      const y0 = Math.floor(cy);
      const x1 = Math.min(s.w - 1, x0 + 1);
      const y1 = Math.min(s.h - 1, y0 + 1);
      const tx = cx - x0;
      const ty = cy - y0;
      const top = a[y0 * s.w + x0]! * (1 - tx) + a[y0 * s.w + x1]! * tx;
      const bot = a[y1 * s.w + x0]! * (1 - tx) + a[y1 * s.w + x1]! * tx;
      b[i] = clampWet(top * (1 - ty) + bot * ty);
    }
  }

  // 3) 扩散：向四邻的**均值**靠拢（凸组合，任意 D 都稳定）
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = y * s.w + x;
      let sum = 0;
      let cnt = 0;
      if (x > 0) { sum += b[i - 1]!; cnt++; }
      if (x < s.w - 1) { sum += b[i + 1]!; cnt++; }
      if (y > 0) { sum += b[i - s.w]!; cnt++; }
      if (y < s.h - 1) { sum += b[i + s.w]!; cnt++; }
      // 没有邻居（1×1 的图）：原地不动，绝不除以 0
      a[i] = cnt === 0 ? b[i]! : b[i]! + TUNING.wetDiffuse * (sum / cnt - b[i]!);
    }
  }

  // 4) 降水：过饱和的部分凝结掉——按**比例**而不是固定值。
  //
  // 固定扣量做过一版，问题是要么"永远差一点点到不了大雨"、要么"一次倒空
  // 之后连旱十回合"。按比例凝结让过饱和量稳定在 `蒸发 / rainDrain`：
  // 水面（蒸發 8.5）能到 +21、平地（2.6）只有 +6，大雨自然只落在大片水上。
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = y * s.w + x;
      const sat = satOf(tempAt(s, x, y));
      let v = a[i]!;
      const over = v - sat;
      if (over > 0) {
        v -= Math.max(TUNING.rainMinDrain, Math.round(over * TUNING.rainDrain));
      }
      b[i] = clampWet(v);
    }
  }

  // 5) 写回
  for (let i = 0; i < n; i++) {
    const tile = s.tiles[i];
    if (!tile) continue;
    tile.custom ??= {};
    tile.custom.wet = b[i]!;
  }
}

/**
 * 整张场走一步。每方回合开始调一次（和灵气同一个节奏：时间在流动）。
 *
 * 一年 40 回合 = 80 步：陆地热容 260‰ 在 20 步里走完 99%，
 * 水面 40‰ 只走完 56%——**这就是相位延迟**。玩家看到的是"夏天到了，
 * 但海还是凉的，雾要到秋天才散"。
 */
export function stepClimateField(s: GameState): void {
  stepTemperature(s);
  // 风是从温度场推出来的，所以必须排在温度之后、湿度之前：
  // 先有这一季的温差，才有这一季的风；湿度再按这股风走。
  stepWind(s);
  stepHumidity(s);
}

/* ------------------------------------------------------------------ */
/* 5. 给面板用的文案                                                   */
/* ------------------------------------------------------------------ */

/** 温度显示：整数 0.1°C → `23.4°C` */
export function formatTemp(temp: number): string {
  const sign = temp < 0 ? '−' : '';
  const abs = Math.abs(temp);
  return `${sign}${Math.floor(abs / 10)}.${abs % 10}°C`;
}

/** 降水显示 */
export function precipLabel(p: Precip): string {
  return p === 'heavy' ? '大雨' : p === 'light' ? '小雨' : '无';
}
