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
 *   · `wet`（0~100 的绝对湿度）——蒸发注入、向四邻扩散、超过饱和线就下雨。
 *     "海陆距离"不再是查表的一个维度，而是**扩散的自然结果**：
 *     靠水的地方潮，往里走越来越干。
 *
 * 最后一步把 `(temp, wet, 降水强弱)` 判回原来那 14 个标签。
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
  heavyMargin: number;
  /** 过饱和的水汽每步凝结掉多少比例（云、露、雨都算） */
  rainDrain: number;
  /** 每步至少凝掉这么多，否则会卡在饱和线上永远不落下来 */
  rainMinDrain: number;
  /** 判类阈值（0.1°C） */
  hardWinterAt: number;
  coldAt: number;
  hotAt: number;
  blazingAt: number;
  /** 相对湿度超过它、又没下雨 → 起雾 */
  fogLine: number;
  /** 相对湿度超过它 → 湿冷 / 湿热 */
  dampWet: number;
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
  heavyMargin: 5,
  rainDrain: 0.4,
  rainMinDrain: 2,
  hardWinterAt: -130,
  coldAt: 40,
  hotAt: 240,
  blazingAt: 305,
  fogLine: 0.76,
  dampWet: 0.86,
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
      return temp >= 120 ? 'storm' : 'overcast';
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
  // 分三段走：**冷、热、温和**。雾只在温和段出现——它是春秋的东西
  // （夜里地面辐射冷却），不是"冬天很冷"或"夏天很闷"的另一种说法。
  // 冷段的"湿"就是湿冷，热段的"湿"就是湿热，各自有各自的标签。
  if (temp < TUNING.hardWinterAt) return 'hardWinter';
  if (temp < TUNING.coldAt) return r > TUNING.dampWet ? 'dampCold' : 'cold';
  if (temp >= TUNING.blazingAt) return 'blazing';
  if (temp >= TUNING.hotAt) return r > TUNING.dampWet ? 'dampHeat' : 'hot';
  if (r > fogLine) return 'fog';
  if (r > TUNING.dampWet) return 'dampCold';
  return 'mild';
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
  return classifyClimate(temp, wet, precipOf(wet, satOf(temp)), isWaterTerrain(tile.terrain), tile.terrain);
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
 * 湿度走一步：蒸发 → 扩散 → 降水 → 截断。
 *
 * 两次缓冲：扩散必须用**上一步的整张表**算新值。原地更新会让扩散带方向偏置，
 * 图像上表现为"湿气往左上角漂"——灵气那边也是同一个坑。
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

  // 2) 扩散：向四邻的**均值**靠拢（凸组合，任意 D 都稳定）
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = y * s.w + x;
      let sum = 0;
      let cnt = 0;
      if (x > 0) { sum += a[i - 1]!; cnt++; }
      if (x < s.w - 1) { sum += a[i + 1]!; cnt++; }
      if (y > 0) { sum += a[i - s.w]!; cnt++; }
      if (y < s.h - 1) { sum += a[i + s.w]!; cnt++; }
      // 没有邻居（1×1 的图）：原地不动，绝不除以 0
      b[i] = cnt === 0 ? a[i]! : a[i]! + TUNING.wetDiffuse * (sum / cnt - a[i]!);
    }
  }

  // 3) 降水：过饱和的部分凝结掉——按**比例**而不是固定值。
  //
  // 固定扣量做过一版，问题是要么"永远差一点点到不了大雨"、要么"一次倒空
  // 之后连旱十回合"。按比例凝结让过饱和量稳定在 `蒸发 / rainDrain`：
  // 水面（蒸發 8.5）能到 +21、平地（2.6）只有 +6，大雨自然只落在大片水上。
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = y * s.w + x;
      const sat = satOf(tempAt(s, x, y));
      let v = b[i]!;
      const over = v - sat;
      if (over > 0) {
        v -= Math.max(TUNING.rainMinDrain, Math.round(over * TUNING.rainDrain));
      }
      b[i] = clampWet(v);
    }
  }

  // 4) 写回
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
