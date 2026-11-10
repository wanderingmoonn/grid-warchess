/**
 * 地图生成器。
 *
 * 上一版是"只生成左上 1/4 再点对称铺满"，好处是绝对公平，
 * 坏处是每张图都长得一样：中间一条横河、一个渡口，两军只能在一个口子上堆兵互怼。
 *
 * 这一版换成"分区生成"：
 *   1. 先把城市摆好（决定了两边的"主场"），再按"离谁更近"把棋盘切成 A 区 / B 区；
 *   2. 大地貌（河 / 山脊）按风格画——横河、纵河、山岭，也可以什么都不画；
 *   3. 森林、丘陵、高山按**团块**长出来，不再是逐格撒点；
 *   4. 默认两侧**各长各的**，但配额相同（同数量的森林/丘陵/高山，位置不同）；
 *      想要完全镜像就把对称模式切回 mirror；
 *   5. 最后强制连通：不通就沿最省事的方向"开凿"——河上架渡口，山上开隘口。
 *
 * 全程只用从 seed 派生的线性同余随机，同 seed 永远同一张图。
 */

import { passable } from './config.ts';
import { expansionById } from './expansions.ts';
import type { MapStyle, Terrain } from './types.ts';

// 地貌风格的联合类型只有一个来源（types.ts），这里只是转出去，
// 免得"能选的地貌"和"能生成的地貌"变成两张会各自走偏的表。
export type { MapStyle };
export type MapSymmetry = 'fair' | 'mirror';

/**
 * 扩展自带的地貌生成器。
 *
 * 地貌"长什么样"是风格问题，不该全部堆在 mapgen 里：本体的五种地貌是
 * 河、岭、开阔那套配方，而"层层递进的等高线山地"是另一套完全不同的算法
 * （连续高度场 + 阈值分层）。让扩展把自己的生成器一起交上来，
 * mapgen 只负责搭骨架（摆城、镜像、连通、出生点），谁也别改谁。
 */
export type MapStyleBuild = (c: MapBuildCtx) => void;

/**
 * 交给扩展生成器的工具包。
 *
 * 只给"往格子上写地形"这一件事需要的东西：尺寸、分区、城市、禁写格。
 * 城市摆放、镜像、连通性开凿、出生点仍由 mapgen 自己做完——
 * 那些是"一局合法对局"的底线，不能让每个扩展各写一份。
 */
export interface MapBuildCtx {
  w: number;
  h: number;
  citySize: number;
  /** 这一格离哪一方更近（决定"两侧配额相同"该怎么算） */
  zoneOf: (x: number, y: number) => 'A' | 'B';
  /** 双方城市锚点（左上角） */
  cities: { A: Array<{ x: number; y: number }>; B: Array<{ x: number; y: number }> };
  /** 不能动的格子：城市本体 */
  blocked: Set<number>;
  /** 确定性随机：同一个 seed 永远同一张图 */
  rng: () => number;
  put: (x: number, y: number, t: Terrain) => void;
  at: (x: number, y: number) => Terrain | undefined;
  /** 点对称的另一格（用来把一侧的地势复制给另一侧） */
  mirror: (x: number, y: number) => { x: number; y: number };
  /** 从一格开始长一片团块地形 */
  grow: (x: number, y: number, t: Terrain, area: number) => void;
  /** 在某一半区里挑一块空地（已排除城市和已有地形） */
  pick: (zone: 'A' | 'B') => { x: number; y: number } | null;
}

export interface MapStyleOption {
  id: MapStyle;
  name: string;
  note: string;
  /** 有它就不走本体的团块配方，改由扩展自己长地形 */
  build?: MapStyleBuild;
}

export const MAP_STYLES: MapStyleOption[] = [
  { id: 'random', name: '随机', note: '按种子抽一种地貌' },
  { id: 'river-h', name: '横河', note: '东西向河流，多处渡口' },
  { id: 'river-v', name: '纵河', note: '南北向河流，贯通全图' },
  { id: 'ridge', name: '山岭', note: '连片高山与丘陵，只有隘口能过' },
  { id: 'open', name: '开阔', note: '没有天险，纯靠正面硬碰' },
];

/** 本体那四种地貌（不含 `random`） */
const BASE_STYLE_IDS: Array<Exclude<MapStyle, 'random'>> = MAP_STYLES.map((o) => o.id).filter(
  (id): id is Exclude<MapStyle, 'random'> => id !== 'random',
);

/**
 * "随机"到底随机到什么：从地貌池里按权重抽一种。
 *
 * **双人和三人四人共用这一份**——这本该是一开始就做成的事。
 * 以前双人有一整套袋子逻辑（下面那段注释里的权重），而三/四人图在
 * `generateMultiLayout` 里写的是 `style !== 'random' ? style : 'open'`，
 * 等于"随机"在多人图里恒等于开阔：开三次三人局，三张图一模一样的地貌配方。
 *
 * 权重（原样保留双人的口径）：
 *   · 河道与山岭各两次——这两种最耐打，多抽一点；
 *   · 扩展地貌进两次，但它们只有在**没有本体重叠**时才享这个待遇
 *     （见下面 `extCount`），否则"随机"会变成"每局都在打火山"。
 *
 * 之所以给扩展地貌加倍：它们才是"勾了这个扩展"的理由。只进一次的话，
 * 本体四种占 6/14，四成对局拿到的图跟没开扩展时一模一样
 * （同种子同地貌时甚至逐格相同），等于白勾。
 */
export function pickRandomStyle(
  styles: ReadonlyArray<Exclude<MapStyle, 'random'>>,
  rng: () => number,
): Exclude<MapStyle, 'random'> {
  const baseIds = new Set<string>(BASE_STYLE_IDS);
  const extCount = styles.filter((id) => !baseIds.has(id)).length;
  const bag: Array<Exclude<MapStyle, 'random'>> = [];
  for (const id of styles) {
    const isExt = !baseIds.has(id);
    bag.push(id);
    if (isExt) bag.push(id);
    else if (extCount === 0 && (id === 'river-h' || id === 'ridge')) bag.push(id);
  }
  return bag[Math.floor(rng() * bag.length)] ?? 'river-h';
}

/**
 * 把"玩家想要的地貌"落成一个真能画出来的地貌。
 *
 * 两条规则，双人和多人共用：
 *   1. 明确点了某一种、但它不在**这一局可用的池子**里（扩展被关掉了、
 *      或者多人图用不了那种双向生成器）→ 退回 `random`，不画一张残图；
 *   2. `random` → 按 `pickRandomStyle` 的袋子抽。
 */
export function resolveMapStyle(
  wanted: MapStyle | undefined,
  styles: ReadonlyArray<Exclude<MapStyle, 'random'>>,
  rng: () => number,
): Exclude<MapStyle, 'random'> {
  let style = wanted ?? 'random';
  if (style !== 'random' && !styles.includes(style)) style = 'random';
  if (style === 'random') return pickRandomStyle(styles, rng);
  return style;
}

/**
 * 这一局能选的地貌：本体五种 + 已启用扩展自带的地貌。
 *
 * 地貌是跟着扩展走的，不是引擎常量：勾了「地形高差」才有高原/峡谷/火山群/沼泽，
 * 没勾就看不见（也不该在随机袋里被抽到）。
 */
export function mapStylesFor(expansionIds: readonly string[] = []): MapStyleOption[] {
  const out: MapStyleOption[] = [...MAP_STYLES];
  for (const id of expansionIds) {
    for (const st of expansionById(id)?.mapStyles ?? []) {
      if (out.some((o) => o.id === st.id)) continue;
      out.push({ id: st.id as MapStyle, name: st.name, note: st.note, build: st.build });
    }
  }
  return out;
}

export const MAP_SYMMETRIES: Array<{ id: MapSymmetry; name: string; note: string }> = [
  { id: 'fair', name: '地势各异', note: '两侧地形数量相同、分布不同' },
  { id: 'mirror', name: '完全镜像', note: '绝对对称，最公平也最可预测' },
];

export interface SpawnDef {
  type: string;
  x: number;
  y: number;
}

export interface MapOptions {
  style?: MapStyle;
  symmetry?: MapSymmetry;
  /**
   * 城市的边长（默认 2）。
   *
   * 留成参数而不是常量，是因为「城郭」这类扩展会把主城扩成 3×3：
   * 城市占多大直接影响城的间距、城郊清场范围、出生点半径，
   * 这些都在生成地图时就得知道——事后再改，城会互相压住。
   */
  citySize?: number;
  /**
   * 本局启用的扩展开关。
   *
   * 地图生成器不读规则，但得知道"能不能画台地/熔岩/火山"——这些地形
   * 是扩展带来的，没开就不该出现（否则关掉扩展的局里会留下不认识的格子）。
   * 同理，扩展自带的地貌也不能进随机袋。
   */
  expansions?: readonly string[];
}

export interface MapLayout {
  w: number;
  h: number;
  rows: string[];
  citiesA: Array<{ x: number; y: number }>;
  citiesB: Array<{ x: number; y: number }>;
  /**
   * 第三、第四家的城位。只有三人/四人局才有内容。
   *
   * 为什么不把 A/B 也并成 `cities: Record<PlayerId, Pos[]>`：两人局的地图生成
   * 是被反复调过的（河、渡口、公平性），那条路径一个字都不该动。多出来的两家
   * 走另一条生成器（generateMultiLayout），字段也就各留各的。
   */
  citiesC?: Array<{ x: number; y: number }>;
  citiesD?: Array<{ x: number; y: number }>;
  spawnsA: SpawnDef[];
  spawnsB: SpawnDef[];
  spawnsC?: SpawnDef[];
  spawnsD?: SpawnDef[];
  /** 本局实际用的地貌（random 会被落成具体的一种） */
  style: Exclude<MapStyle, 'random'>;
  symmetry: MapSymmetry;
  /** 城市布局：同边对峙 / 对角交错 */
  layout: CityLayout;
  /**
   * 无渡口河：整条河没有一处可以徒涉的浅滩，过河只能造桥。
   * 只在"河把两军隔开"的对峙布局里出现。
   */
  fordless: boolean;
}

const CHAR: Record<Terrain, string> = {
  plain: '.',
  forest: 'f',
  hill: 'h',
  water: '~',
  mountain: '^',
  bridge: '=', // 生成器不画桥，这里只是为了类型完整
  city: '.',
  // 新地形各用一个不冲突的字符：行字符串按字符还原成地块，所以不能复用
  plateau: 'P',
  valley: 'v',
  marsh: 'w',
  dune: 'd',
  // 月球地形：生成器不画，只有月球图用；留字符是为了调试转储
  regolith: 'r',
  crater: 'c',
  shallow: 's', // 浅滩：陆军能踩过去的"水"
  // 生成器自己**不画**深水：它是「海战」扩展在 afterTerrain 里把
  // 离岸 2 格以上的 water 改写的。这里留字符只是为了类型完整 + 调试转储够用。
  deep: 'D',
};

/**
 * 字符 → 地形。**只有这一份**。
 *
 * 以前开局那边自己抄了一张表，只认得 `.f h~^` 五个字符——地图生成加了
 * 新地形之后，生成器画得好好的台地在开局的还原那一步全变成了平原。
 * 两张表就是两个真相，所以反向表从 CHAR 派生，谁也别再手抄。
 */
const CHAR_TO_TERRAIN: Record<string, Terrain> = (() => {
  const out: Record<string, Terrain> = {};
  for (const [t, ch] of Object.entries(CHAR)) {
    // 'city' 和 'plain' 共用 '.'：格子是不是城由 cityId 决定，字符只管地貌
    if (t === 'city') continue;
    out[ch] = t as Terrain;
  }
  return out;
})();

/** 行字符串里的一个字符还原成地形（认不出来的按平原算） */
export function terrainFromChar(ch: string): Terrain {
  return CHAR_TO_TERRAIN[ch] ?? 'plain';
}

/**
 * 地形 → 行字符串里的字符。导出地图时用。
 *
 * 和 `terrainFromChar` **同一张表**。以前 `fixed-maps.ts` 自己抄了一份
 * "只收六种本体地形"的白名单，于是上帝模式画好的沼泽/台地一导出就被拒——
 * 两份表就是两个真相，这次把导出这边也接回这张表上。
 */
export function terrainCharOf(t: Terrain): string {
  return CHAR[t] ?? '.';
}

/**
 * 地图文本里允许出现的字符（去重后的一份）。
 *
 * 就是"每种地形各一个字符"：`.` 同时是平原，`'city'` 不单独占字符
 * （格子是不是城由 cityId / citiesA-B 决定，字符只管地貌）。
 *
 * 扩展地形（P 台地 / v 谷地 / w 沼泽 / d 沙丘 / s 浅流 / D 深水）**照样收**：
 * 它们是规则层的正式地形，渲染、移动、视野都无条件支持——扩展只决定
 * "地图生成器会不会画它"，不决定"这张图能不能有它"。
 */
export const MAP_TERRAIN_CHARS: string = [...new Set(Object.values(CHAR))].join('');

type Pos = { x: number; y: number };

/** 线性同余，只要确定性，不要质量 */
function makeRng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  const step = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  // 前几个值对相近种子是相关的（同一乘子下几乎落在同一个桶里），
  // 会表现为"连抽十个种子都是同一种地貌"。先空转几步把它搅开。
  for (let i = 0; i < 5; i++) step();
  return step;
}

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** 一张正在施工的地图 */
interface Ctx {
  w: number;
  h: number;
  g: Terrain[];
  /** 城市边长（2 或扩展要求的 3）。所有"城市占几格"的推算都读它。 */
  citySize: number;
}

const at = (c: Ctx, x: number, y: number): Terrain | undefined =>
  x < 0 || y < 0 || x >= c.w || y >= c.h ? undefined : c.g[y * c.w + x];

const put = (c: Ctx, x: number, y: number, t: Terrain): void => {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  c.g[y * c.w + x] = t;
};

const mirrorOf = (c: Ctx, p: Pos): Pos => ({ x: c.w - 1 - p.x, y: c.h - 1 - p.y });

/**
 * "这格是水"的统一判据。
 *
 * 浅滩也算水：船能停在上面、水面连通性也靠它维持（渡口就是浅滩）。
 * 只有 `water` / `deep` 才算水的话，"河道通不通"会被自己的统计口径骗过去。
 */
const WET: ReadonlySet<Terrain> = new Set<Terrain>(['water', 'deep', 'shallow']);
const isWet = (t: Terrain | undefined): boolean => (t ? WET.has(t) : false);

/**
 * 目标水域占比（2026-11-08 由 13.8% 提到 20%）。
 *
 * 为什么是"占比"而不是"几片湖"：地图尺寸从 12 到 64 都有人玩，按块数给会让
 * 12×12 上一片湖占八分之一、64×64 上四片湖等于没有。按占比给，任何尺寸都一致。
 *
 * 单张允许 12%~32%：这是**目标值**，不是硬约束——河图的河已经占掉一截，
 * 按缺口补的湖只要别把地图泡掉就行。真正的硬下限由收尾的 `topUpWater` 兜。
 */
const WATER_TARGET = 0.2;

/** 全图水面格数（含浅滩） */
function countWet(c: Ctx): number {
  let n = 0;
  for (let i = 0; i < c.g.length; i++) if (isWet(c.g[i])) n += 1;
  return n;
}

/** 点对称镜像（单格），导出给外部换算用 */
export function mirrorCell(x: number, y: number, w: number, h: number): Pos {
  return { x: w - 1 - x, y: h - 1 - y };
}

/** 点对称镜像（size × size 方块，用左上角坐标算） */
export function mirrorBlock(x: number, y: number, size: number, w: number, h: number): Pos {
  return { x: w - size - x, y: h - size - y };
}

/** 到 2×2 城市方块的距离（切比雪夫式，贴边算 0） */
function blockDist(p: Pos, city: Pos, size = 2): number {
  const cx = Math.max(city.x, Math.min(p.x, city.x + size - 1));
  const cy = Math.max(city.y, Math.min(p.y, city.y + size - 1));
  return Math.abs(p.x - cx) + Math.abs(p.y - cy);
}

/* ------------------------------------------------------------------ */
/* 1. 城市位置：谁的地盘在哪半张图                                     */
/* ------------------------------------------------------------------ */

/**
 * 两座城摆在同一条"前线"的两端，另一侧镜像。
 *
 * 横河/山岭 → A 在南、B 在北；纵河 → A 在西、B 在东。
 * 这样正面至少有两个接触点，而不是所有人都往一个口子挤。
 */
/**
 * 城市布局。
 *
 * 四角里取两角给 A，另外两角给 B。只有两类是公平的（两城间距相等）：
 *   split    —— A 占同一条边，B 占对面那条边（"隔着河对峙"）
 *   diagonal —— 双方各占一对对角（"河两岸都有敌我"）
 *
 * 以前是"河横着就南北分、河竖着就东西分"，于是纵河不过是把横河转了 90 度。
 * 现在布局和河的走向互不相干，四种组合都会出现。
 */
export type CityLayout = 'split' | 'diagonal';

/**
 * 两座城之间至少要隔开这么远（以左上角曼哈顿距离计），否则会出现"两城贴脸"的怪图。
 *
 * 规则是**棋盘最短边的 1/4**：12→3、16→4、20→5、32→8。
 * 3 是硬下限——城是 2×2 的方块，再近就开始肩并肩了。
 *
 * 这条不变式以前是"尽力而为"的：`make()` 撒够 40 次还撒不下就退到前线上，
 * 退的时候**不检查间距**；镜像模式更糟，B 是 A 的点镜像，完全没校验过
 * ——实测 150 张镜像图里有 36 张违规，最差的两座城直接重叠（距离 0）。
 * 现在改成"撒不下就换一次重来，实在不行退回矩形"，宁可图规整，也不能贴着。
 */
const MIN_CITY_SEP_FLOOR = 3;
const MIN_CITY_SEP_RATIO = 0.25;

function minCitySep(w: number, h: number, citySize = 2): number {
  return Math.max(MIN_CITY_SEP_FLOOR + (citySize - 2) * 2, Math.floor(Math.min(w, h) * MIN_CITY_SEP_RATIO));
}

function citySep(a: Pos, b: Pos): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** 四座城里最近的一对有多远 */
function closestPair(cities: Pos[]): number {
  let best = Infinity;
  for (let i = 0; i < cities.length; i++) {
    for (let j = i + 1; j < cities.length; j++) {
      best = Math.min(best, citySep(cities[i]!, cities[j]!));
    }
  }
  return best === Infinity ? 0 : best;
}

function nearestBetween(a: Pos[], b: Pos[]): number {
  let best = Infinity;
  for (const p of a) for (const q of b) best = Math.min(best, citySep(p, q));
  return best === Infinity ? 0 : best;
}

/**
 * 城市布局：随机撒点，不再是四角矩形。
 *
 * 以前是"先定一个矩形，再把四个角分给两边"——于是每张图都是同一个形状的
 * 对称对局：两城永远在同一行/同一列，中间地带永远一样宽，连该往哪打都一样。
 *
 * 现在改成：
 *   1. 先按老办法抽一次"两军之间的走廊宽度"，拿它作为**目标间距**；
 *   2. 每座城在自己那一侧的半区里**自由选位置**（可以往前压，也可以往回缩，
 *      横向更是整条宽度随便挑），只要求互不贴脸；
 *   3. 撒出来的"最近敌我距离"要落在目标 ±1 内，否则重撒——撒不出来就退回矩形。
 *
 * 第 3 步是"平均间距不变"的保证：形状随便变，距离的分布不动。
 *
 * **纵深必须两侧同构**（2026-10-29 修的真 bug）：
 * 以前两边的纵深窗口不是镜像的——近侧永远是 `[底线, 前线]`（只有 1~2 格，
 * 城只能贴着自己的边），远侧是 `[前线, 对面底线]`（把整张图的余量都吃下来）。
 * 于是上半区的城离自己的上边平均 1.5 格、下半区的城离自己的下边平均 3.3 格，
 * 32×32 上差到 3.3 格：同一张图上一边被逼在墙角、另一边坐拥纵深。
 * 现在两侧共用同一个"能退几格"的 `pad`（由目标间距反推），也共用**同一组纵深**
 * （第一个钉死 `pad`、第二个有机会退一格）：两座城能错开一行，但上/下半区的
 * 纵深多重集逐格相同，均值也就必然相同——不是"统计上差不多"。
 *
 * 注意这里对称的只是**纵深**（到各自底线的那一段）。横向（沿河方向）两半区各抽各的，
 * 不做镜像：真要做镜像就是 `symmetry: 'mirror'` 那条路（B 是 A 的 180° 点对称，
 * 见 mirrorBlock），公平图要留着自己"两边城墙不在同一段"的样子。
 *
 * 必须保留的不变量（全部是硬的，写测试盯着）：
 *   · 任意两座城的曼哈顿距离 ≥ minCitySep；
 *   · 上/下半区到各自底线的平均距离相等（见 test-rules「城市到各自底线」）；
 *   · 对峙布局下，A 的两个城和 B 的两个城必须分处河的两侧
 *     （无渡口河靠这条才能真的把两军隔开，见 freeBand / midOf）；
 *   · 镜像模式下，B 必须是 A 的严格点镜像（地形对称全靠它）。
 */
function planCities(
  c: Ctx,
  layout: CityLayout,
  axis: 'h' | 'v',
  rng: () => number,
  mirror: boolean,
): { A: Pos[]; B: Pos[] } {
  const span = c.citySize;
  const minSep = minCitySep(c.w, c.h, c.citySize);
  // 纵深方向 = 河要横穿的那个方向；横向 = 沿着河的方向
  const along = axis === 'h' ? c.h : c.w;
  const cross = axis === 'h' ? c.w : c.h;
  const floorGap = axis === 'h' ? 4 : 5;

  const at2 = (a: number, cr: number): Pos => (axis === 'h' ? { x: cr, y: a } : { x: a, y: cr });
  const mirrorOf = (p: Pos): Pos => mirrorBlock(p.x, p.y, span, c.w, c.h);

  // ---- 目标间距：老公式在这一次 rng 下本该给出的两军距离 ----
  const maxGap = Math.max(floorGap, along - 2 * span - 2);
  const gap = floorGap + Math.floor(rng() * (maxGap - floorGap + 1));
  const front0 = 1 + Math.floor(rng() * Math.min(2, Math.max(1, along - span - gap - span - 1)));
  const front1 = Math.min(along - span - 1, front0 + span + gap);
  const target = front1 - front0; // 老布局下最近的敌我距离就是这个

  const alongLo = 1;
  const alongHi = along - span - 1;
  const crossLo = 1;
  const crossHi = cross - span - 1;

  /**
   * 每一侧能从**自己的底线**往里退几格，也就是"两军各压到多前"。
   *
   * 由目标间距反推，两侧平分余量：
   *   `(alongHi - pad) - (alongLo + pad) = target`  ⇒  `pad = (alongHi - alongLo - target)/2`
   *
   * 以前只有近侧拿到 `alongLo..front0`（1~2 格）、远侧拿到 `front1..alongHi`
   * （把整张图的余量一个人吃了）：于是上半区的城被逼在墙角、下半区的城坐拥纵深，
   * 32×32 上"到各自底线"的平均距离差到 3.3 格。现在两侧都只有 pad 格。
   *
   * 小图上 target 可能吃满纵深，pad 退化成 0：两侧各只剩一行，城退回
   * "同一行、横向拉开"的老样子，这是约束下的唯一解。
   */
  const pad = Math.max(0, Math.floor((alongHi - alongLo - target) / 2));

  /**
   * 两侧**共用**的纵深多重集：两座城最多错开一行。
   *
   * 第一个永远是 `pad`（压到最前），第二个有对半的机会退一格。
   * 为什么必须"共用"：所谓"上下等距"就是两侧到各自底线的距离分布一样，
   * 而分布一样的最省事写法就是**同一组数**——远侧不是另抽一次，而是把这一组调个顺序用。
   * 所以哪怕错开了，两边的均值、甚至多重集都逐格相同。
   *
   * 为什么只退一格：`pad` 是"两军刚好隔 target"的位置，再往回退就是让两军比 target
   * 更远，退两格就开始不像同一张图上的对局了。
   * 为什么第一个钉死 `pad`：这样无论错开与否，**最近的那一对城**始终在 `pad` 上，
   * 目标间距不会因为错落而被动变宽。
   */
  const depth: [number, number] = [pad, pad > 0 && rng() < 0.5 ? pad - 1 : pad];

  /** 这个位置离已占的每一座城都够远吗 */
  const farEnough = (p: Pos, taken: Pos[]): boolean =>
    taken.every((q) => citySep(p, q) >= minSep);

  /**
   * 在某一侧、指定纵深上挑一个横向位置。
   *
   * `side` 0 = 靠近 `alongLo` 的那一侧（横河时是上），1 = 另一侧。
   * 纵深由调用方给（两侧共用同一组），这里只负责横向随机——
   * 横向本来就不需要对称，两边的城墙落在哪一段本来就不该一样。
   */
  const placeAt = (side: 0 | 1, d: number, taken: Pos[]): Pos | null => {
    const a = side === 0 ? alongLo + d : alongHi - d;
    const cands: Pos[] = [];
    for (let cr = crossLo; cr <= crossHi; cr++) {
      const p = at2(a, cr);
      if (farEnough(p, taken)) cands.push(p);
    }
    if (cands.length === 0) return null;
    return cands[Math.floor(rng() * cands.length)]!;
  };

  const attempt = (): { A: Pos[]; B: Pos[] } | null => {
    if (mirror) {
      // 镜像模式：只规划 A，B 由点镜像得到。
      // 约束要连"镜像之后的四座城"一起满足——以前这里完全没查，
      // 于是 B 常常被镜像到 A 旁边甚至同一个格子上。
      const a: Pos[] = [];
      const taken: Pos[] = []; // A 的城 + 它们的镜像，全都算占位
      for (let k = 0; k < 2; k++) {
        const p = placeAt(0, depth[k]!, taken);
        if (!p) return null;
        a.push(p);
        taken.push(p, mirrorOf(p));
      }
      const b = a.map(mirrorOf);
      // 后放的城不会回头检查"先放的城 vs 自己的镜像"，这里补一次总校验
      return closestPair([...a, ...b]) >= minSep ? { A: a, B: b } : null;
    }

    const taken: Pos[] = [];
    const side0: Pos[] = [];
    const side1: Pos[] = [];
    for (let k = 0; k < 2; k++) {
      const p0 = placeAt(0, depth[k]!, taken);
      if (!p0) return null;
      taken.push(p0);
      side0.push(p0);

      // 另一半区：**同一组纵深的另一个顺序**。顺序对调是给对角布局留的：
      // 对角时 A 拿 side0[0] + side1[0]、B 拿 side0[1] + side1[1]，
      // 顺序照抄的话 A 会吃下两个"深"的、B 两个"浅"的——那是新的不公平。
      const p1 = placeAt(1, depth[1 - k]!, taken);
      if (!p1) return null;
      taken.push(p1);
      side1.push(p1);
    }
    // 对峙：A 整条边、B 整条边；对角：两岸各有敌我各一
    if (layout === 'diagonal') {
      return { A: [side0[0]!, side1[0]!], B: [side0[1]!, side1[1]!] };
    }
    const aFirst = axis === 'h'; // 横河时 A 在南岸（front1），纵河时 A 在西岸（front0）
    return aFirst ? { A: side1, B: side0 } : { A: side0, B: side1 };
  };

  /**
   * 兜底：规整的两角 + 一点纵深抖动。
   *
   * 只用在前面的随机撒点全都构不出合法布局的时候（很罕见）。
   * 四个角本身是最"分开"的位置，任何 minSep ≤ 边长/2 都能满足。
   */
  const rectangular = (): { A: Pos[]; B: Pos[] } => {
    const a = [at2(alongLo, crossLo), at2(alongLo, crossHi)];
    if (mirror) return { A: a, B: a.map(mirrorOf) };
    const b = [at2(alongHi, crossLo), at2(alongHi, crossHi)];
    return axis === 'h' ? { A: b, B: a } : { A: a, B: b };
  };

  // 撒到"最近敌我距离"尽量贴住目标为止。
  //
  // 打分是**偏心的**：先要"刚好等于目标"，其次是"稍微远一点"，
  // 最后才是"近了"。因为四座城里取最近的一对天然偏低——两边都往前压、
  // 又恰好同列的时候，距离会比目标少两格。不这么偏心的话，
  // 平均间距会被整体拉低约 0.3 格（实测 6.77 而不是 7.0）。
  const score = (p: { A: Pos[]; B: Pos[] }): number => {
    const d = nearestBetween(p.A, p.B);
    return d >= target ? d - target : 100 + (target - d);
  };

  let best: { A: Pos[]; B: Pos[] } | null = null;
  let bestScore = Infinity;
  // 24 次：约束收紧之后前几次失败是常事（尤其 12×12 的镜像图），
  // 但每次失败都是"这次 rng 没撒出来"，换一轮就行。
  for (let i = 0; i < 24 && bestScore > 0; i++) {
    const cand = attempt();
    if (!cand) continue;
    const s = score(cand);
    if (s < bestScore) {
      best = cand;
      bestScore = s;
    }
  }
  const out = best ?? rectangular();

  // 最后一道闸：不管走哪条路，出去的四座城必须都够远。
  // 万一 rectangular() 之后还有违规（比如 8×8 这种极小图），
  // 也只能认了——但至少开发时会在这里被测试抓住。
  return out;
}

/** 这块地离谁的城市更近 */
function makeZoneOf(citiesA: Pos[], citiesB: Pos[], citySize = 2) {
  return (x: number, y: number): 'A' | 'B' => {
    const p = { x, y };
    let da = Infinity;
    let db = Infinity;
    for (const c1 of citiesA) da = Math.min(da, blockDist(p, c1, citySize));
    for (const c1 of citiesB) db = Math.min(db, blockDist(p, c1, citySize));
    return da <= db ? 'A' : 'B';
  };
}

/* ------------------------------------------------------------------ */
/* 2. 大地貌：河与山脊                                                 */
/* ------------------------------------------------------------------ */

/**
 * 画一条贯穿全图的河，中间留 2~3 处渡口。
 *
 * 上一版只有一个居中的渡口，两军只能在一个口子上互相消耗。
 * 渡口分散到 1/4、1/2、3/4 附近，正面自然就散开了。
 */
/**
 * 画一条贯穿全图的河。
 *
 * 两种形态：
 *   · 有渡口（默认）：2~3 处 2 格宽的渡口，中段还会鼓成"汪洋"。
 *     打法是"抢渡口"，正面自然散开。
 *   · 无渡口（fordless）：整条河一处不断，宽度压到 2~3 格。
 *     想过河只有一条路——造桥。这是"天堑"，不是"防线"。
 *
 * 无渡口时必须窄：宽到 6~7 格的话，架桥要铺六七个桥面，成本高到没人会做，
 * 那这张图就退化成"两边互相看着"的废图。
 *
 * @param bandLo/bandHi 允许河身摆动的区间（垂直于河的坐标）。
 *        用来把河限制在两军之间的空档里，避免它压到城市上——
 *        城市格会被压平成平原，等于在河上开了个免费渡口。
 */
function paintRiver(
  c: Ctx,
  axis: 'h' | 'v',
  rng: () => number,
  mid: number,
  opts: { fordless?: boolean; bandLo?: number; bandHi?: number } = {},
): Set<number> {
  const fordless = !!opts.fordless;
  const len = axis === 'h' ? c.w : c.h;
  const span = axis === 'h' ? c.h : c.w;
  const painted = new Set<number>();

  const mark = (x: number, y: number, t: Terrain) => {
    if (at(c, x, y) === undefined) return;
    put(c, x, y, t);
    // 浅滩也是这条河的一部分：船能过、陆军能涉，不该被当成"没有水"
    if (t === 'water' || t === 'shallow') painted.add(y * c.w + x);
  };

  // 河要有体量：有渡口的图 2~3 格宽起步、还能鼓成汪洋；
  // 无渡口的图固定在 2 格 —— 过河要铺两座桥（90 金、两个回合），
  // 这个价码刚好"疼但付得起"。再宽就成了"这局打不起来"。
  const width = fordless ? 2 : 2 + Math.floor(rng() * 2);

  // 河身允许摆动的范围：无渡口时锁在空档里，有渡口时就是整张图
  const lo = opts.bandLo ?? 2;
  const hi = opts.bandHi ?? span - 2 - width;
  const clampBase = (v: number) => Math.max(lo, Math.min(hi - width + 1, v));

  let base = clampBase(Math.round(mid - width / 2 + (rng() - 0.5) * 2));

  const basins = fordless ? 0 : 1 + (rng() < 0.45 ? 1 : 0);
  const lakes = Array.from({ length: basins }, () => ({
    center: Math.round(len * (0.2 + rng() * 0.6)),
    radius: 2 + Math.floor(rng() * 3),
  }));
  const widthAt = (t: number) => {
    let w = width;
    for (const lake of lakes) {
      const d = Math.abs(t - lake.center);
      if (d <= lake.radius) w = Math.max(w, width + lake.radius + 2 - d);
    }
    // 上限：汪洋可以大，但不能把整张图泡了，否则两边连照面的地方都没有。
    // 这条是从 0.42 收到 0.26 的（2026-11-08）：按跨度给 42% 时，12×12 的河
    // 最宽处能到 5 格——光河本身就占掉两成地图，再叠港湾就冲过 40%。
    // 按"跨度的四分之一"给，12→3、20→5、32→8，汪洋还在，但留得下陆地。
    return Math.min(w, Math.max(3, Math.round(span * 0.26)));
  };

  // 渡口：2 处（大图 3 处），各 2 格宽，尽量避开汪洋。无渡口图没有渡口
  const fords = fordless ? 0 : len >= 18 ? 3 : 2;
  const gaps: Array<[number, number]> = [];
  for (let i = 0; i < fords; i++) {
    let center = Math.round((len * (i + 1)) / (fords + 1) + (rng() - 0.5) * len * 0.08);
    for (const lake of lakes) {
      if (Math.abs(center - lake.center) < lake.radius + 2) center += lake.radius + 3;
    }
    center = Math.max(1, Math.min(len - 3, center));
    gaps.push([center - 1, 2]);
  }
  const inGap = (t: number) => gaps.some(([st, wd]) => t >= st && t < st + wd);

  let dir = rng() < 0.5 ? -1 : 1;
  for (let t = 0; t < len; t++) {
    // 河要"顺"：隔一段才拐一次，看起来才是一条河而不是一堆水坑
    if (rng() < 0.1) dir = -dir;
    if (rng() < 0.14) base += dir;
    base = clampBase(base);

    if (inGap(t)) {
      /*
       * 渡口：**一律画浅滩**（2026-11-08 改成无条件，不再看扩展）。
       *
       * 以前这里是 `c.shallowOk ? 'shallow' : 干脆不画`。没开「地形高差」时
       * "不画"等于在河上开一段平原——一条横贯全图的河被 2~3 处渡口切成 2~4 段，
       * 每一段都成了独立的小水塘，水军下水之后只能在里面转圈。
       *
       * 为什么不能"留一条窄水道"兼顾两边：陆军过河是**垂直**穿河宽方向，
       * 河宽里剩任何一格水，那一列就过不去；而船要求每一列至少一格水且正交相连。
       * 同一格不可能既挡陆军又放船——除非它同时"能走又能开船"，那就是浅滩
       * （`config.navigable()` 含 shallow，陆军移动力 2）。
       * 所以渡口只能是浅滩：河从头到尾都是水面，船能开到底，陆军照样徒涉。
       */
      const w = widthAt(t);
      for (let k = 0; k < w; k++) {
        const [x, y] = axis === 'h' ? [t, base + k] : [base + k, t];
        mark(x, y, 'shallow');
      }
      continue;
    }

    const w = widthAt(t);
    for (let k = 0; k < w; k++) {
      const [x, y] = axis === 'h' ? [t, base + k] : [base + k, t];
      mark(x, y, 'water');
    }
    // 河身至少 2 格宽，倾斜时两列的水仍然是正交相邻的，不会漏出缝隙。
    // （以前这里还要"拐弯补角"，那是给 1 格宽的沟补洞；现在不需要了，
    // 而那一笔会把无渡口的河偷偷加宽到 4 格，桥就铺不起来了。）
  }

  return painted;
}

/**
 * 河身允许摆动的区间：沿"垂直于河"的轴，避开所有城市的 2×2 占地外扩一格。
 *
 * 为什么较真：城市格会被压平成平原。如果河从城市身上过，
 * 那一圈城市格就成了河上的免费渡口——"必须造桥"立刻变成一句空话。
 */
function freeBand(
  c: Ctx,
  plan: { A: Pos[]; B: Pos[] },
  axis: 'h' | 'v',
  mid: number,
): { lo: number; hi: number } | null {
  const perpendicular = axis === 'h' ? c.h : c.w;
  const blocked = new Array<boolean>(perpendicular).fill(false);
  for (const p of [...plan.A, ...plan.B]) {
    const at0 = axis === 'h' ? p.y : p.x;
    for (let d = -1; d <= 2; d++) {
      const v = at0 + d;
      if (v >= 0 && v < perpendicular) blocked[v] = true;
    }
  }

  // 把空档都列出来，然后挑**包住中线**的那一段。
  // 不能只看"最长的一段"：曾经因此把河画到地图最底下，
  // 两家根本没被隔开，"必须架桥"就成了空话。
  const runs: Array<{ lo: number; hi: number }> = [];
  let run = -1;
  for (let v = 0; v <= perpendicular; v++) {
    const free = v < perpendicular && !blocked[v];
    if (free && run < 0) run = v;
    if (!free && run >= 0) {
      runs.push({ lo: run, hi: v - 1 });
      run = -1;
    }
  }
  if (runs.length === 0) return null;

  const contains = runs.filter((r) => mid >= r.lo && mid <= r.hi);
  const pick =
    contains[0] ??
    runs.reduce((a, b) => (Math.abs((a.lo + a.hi) / 2 - mid) <= Math.abs((b.lo + b.hi) / 2 - mid) ? a : b));

  // 至少要有 3 格河宽 + 上下各一格余量
  if (pick.hi - pick.lo + 1 < 5) return null;
  return pick;
}

/**
 * 画一道山脊：连片高山，中间留 2 个隘口，两侧铺一层丘陵。
 * 高山不可通行，所以隘口就是唯一的战略通道——但至少有两个。
 */
function paintRidge(c: Ctx, rng: () => number, mid: number, axis: 'h' | 'v'): void {
  const horizontal = axis === 'h';
  const len = horizontal ? c.w : c.h;
  const span = horizontal ? c.h : c.w;
  let base = Math.max(4, Math.min(span - 5, Math.round(mid + (rng() - 0.5) * 2)));
  let dir = rng() < 0.5 ? -1 : 1;

  const passes = 2;
  const gaps: Array<[number, number]> = [];
  for (let i = 0; i < passes; i++) {
    const center = Math.round((len * (i + 1)) / (passes + 1) + (rng() - 0.5) * len * 0.12);
    gaps.push([center - 1, 3]);
  }
  const inGap = (t: number) => gaps.some(([s, wd]) => t >= s && t < s + wd);

  for (let t = 0; t < len; t++) {
    if (rng() < 0.12) dir = -dir;
    if (rng() < 0.18) base += dir;
    base = Math.max(3, Math.min(span - 4, base));

    for (let d = -1; d <= 1; d++) {
      const [x, y] = horizontal ? [t, base + d] : [base + d, t];
      if (Math.abs(d) === 1) {
        // 山脚：丘陵
        const cur = at(c, x, y);
        if (cur === 'plain') put(c, x, y, 'hill');
        continue;
      }
      if (inGap(t)) {
        const cur = at(c, x, y);
        if (cur === 'plain') put(c, x, y, 'hill');
      } else {
        put(c, x, y, 'mountain');
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3. 团块地形                                                         */
/* ------------------------------------------------------------------ */

/** 在指定区域内挑一块能长的地 */
function pickSeed(
  c: Ctx,
  rng: () => number,
  zoneOf: (x: number, y: number) => 'A' | 'B',
  zone: 'A' | 'B',
  blocked: Set<number>,
): Pos | null {
  for (let attempt = 0; attempt < 40; attempt++) {
    const x = Math.floor(rng() * c.w);
    const y = Math.floor(rng() * c.h);
    const i = y * c.w + x;
    if (blocked.has(i)) continue;
    if (zoneOf(x, y) !== zone) continue;
    if (at(c, x, y) !== 'plain') continue;
    return { x, y };
  }
  return null;
}

/** 按配额在两侧铺同数量的团块地形 */
function scatterTerrain(
  c: Ctx,
  rng: () => number,
  zoneOf: (x: number, y: number) => 'A' | 'B',
  terrain: Terrain,
  counts: Record<'A' | 'B', number>,
  blocked: Set<number>,
): void {
  // 团块大小跟着图长：12×12 一片林子 4~7 格就够看，
  // 32×32 上还按 2~6 格撒，只剩一地碎斑——"成片的森林"就是这么丢的。
  const maxBlob = Math.max(5, Math.min(20, Math.round(4 + Math.min(c.w, c.h) / 4)));
  for (const zone of ['A', 'B'] as const) {
    let left = counts[zone];
    let guard = 0;
    while (left > 0 && guard < 300) {
      guard += 1;
      const size = Math.min(left, 3 + Math.floor(rng() * Math.max(1, maxBlob - 3)));
      const seed = pickSeed(c, rng, zoneOf, zone, blocked);
      if (!seed) break;
      // 团块用"前沿扩张"长，长出来是连成一片的，而不是面条
      const placed = growRegion(c, rng, seed, terrain, size, blocked);
      if (placed === 0) break;
      left -= placed;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3.5 额外地貌：大地图上的河、湖、海、山与成片森林                    */
/* ------------------------------------------------------------------ */

/**
 * 紧凑地长一团地形。
 *
 * 老版本是随机游走长的：一步一格，一半概率跳回起点，撞到别的地形就 `break`——
 * 结果是一片片"细面条"，或者半路断掉。所以"成片的森林"基本没出现过。
 *
 * 这里改成前沿扩张：把和已占格相邻的空白格记进 frontier，每次随机挑一个吃掉，
 * 新格再把它的邻居加进来。长出来的团是连成一片的，尺寸也可控，
 * 视觉上才像"林子"和"湖"，而不是撒了一把碎块。
 */
function growRegion(
  c: Ctx,
  rng: () => number,
  start: Pos,
  terrain: Terrain,
  size: number,
  blocked: Set<number>,
): number {
  if (at(c, start.x, start.y) !== 'plain') return 0;
  const frontier: Pos[] = [];
  const seen = new Set<number>();
  const push = (p: Pos): void => {
    if (at(c, p.x, p.y) !== 'plain') return;
    const i = p.y * c.w + p.x;
    if (seen.has(i) || blocked.has(i)) return;
    seen.add(i);
    frontier.push(p);
  };

  put(c, start.x, start.y, terrain);
  blocked.add(start.y * c.w + start.x);
  let placed = 1;
  for (const [dx, dy] of DIRS) push({ x: start.x + dx, y: start.y + dy });

  while (placed < size && frontier.length > 0) {
    const k = Math.floor(rng() * frontier.length);
    const p = frontier.splice(k, 1)[0]!;
    if (at(c, p.x, p.y) !== 'plain') continue;
    put(c, p.x, p.y, terrain);
    blocked.add(p.y * c.w + p.x);
    placed += 1;
    for (const [dx, dy] of DIRS) push({ x: p.x + dx, y: p.y + dy });
  }
  return placed;
}

/**
 * 长一片**圆盘状**的水（湖、汪洋处）。
 *
 * ---------------------------------------------------------------
 * 为什么不用 `growRegion`
 * ---------------------------------------------------------------
 * `growRegion` 是随机前沿扩张：每步从 frontier 里随机挑一格吃掉。它保证"连成一片"，
 * 但长出来的边缘是毛刺状的——同样 20 格，它是一片"树莓"，周长 22~26；
 * 圆盘平滑后周长只有 16~18，视觉上才像湖，也才给船留出够走的宽度。
 *
 * 做法：由面积反推半径 `r = sqrt(area/π)`；
 *   · `0.72r` 以内必填；
 *   · `0.72r ~ 1.15r` 之间按线性衰减的概率填（边缘不规则，不是正圆）；
 *   · 按"离圆心由近到远"取前 `area` 格，保证不超支；
 *   · 最后做一遍 3×3 平滑：削掉只有 1 个水邻居的凸起、填掉被水围住的单格空地。
 *
 * `allow` 用来把湖挡在城市近郊之外（城门口要能出兵）。
 */
function blobRegion(
  c: Ctx,
  rng: () => number,
  center: Pos,
  terrain: Terrain,
  area: number,
  blocked: Set<number>,
  allow?: (x: number, y: number) => boolean,
  /**
   * 这一格能不能被水淹掉。
   *
   * 默认只吃"干净的空地"。收尾补水会放宽到"丘陵、林地也行，山不行"——
   * 12×12 的山岭图上空地早就被散布的丘陵和林子占完了，只吃空地的话
   * 补水一格都长不出来，实测有整张图只剩 6.9% 水的。
   * 山必须排除：那是地形骨架，泡掉就等于把山岭抹平了。
   */
  ground: (t: Terrain) => boolean = (t) => t === 'plain',
): number {
  const centerT = at(c, center.x, center.y);
  if (centerT === undefined || !ground(centerT)) return 0;
  const r = Math.max(1.2, Math.sqrt(Math.max(1, area) / Math.PI));
  const inner = r * 0.72;
  const outer = r * 1.15;
  const cells: Pos[] = [];
  const x0 = Math.floor(center.x - outer);
  const x1 = Math.ceil(center.x + outer);
  const y0 = Math.floor(center.y - outer);
  const y1 = Math.ceil(center.y + outer);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = at(c, x, y);
      if (t === undefined || !ground(t)) continue;
      if (blocked.has(y * c.w + x)) continue;
      if (allow && !allow(x, y)) continue;
      const d = Math.hypot(x - center.x, y - center.y);
      if (d > outer) continue;
      if (d > inner) {
        const keep = 1 - (d - inner) / Math.max(0.001, outer - inner);
        if (rng() > Math.max(0.18, keep * 0.85)) continue;
      }
      cells.push({ x, y });
    }
  }
  const dist = (p: Pos): number => Math.hypot(p.x - center.x, p.y - center.y);
  cells.sort((a, b) => dist(a) - dist(b));
  const chosen = cells.slice(0, Math.max(1, Math.round(area)));
  const wetN = (x: number, y: number): number => {
    let n = 0;
    for (const [dx, dy] of DIRS) if (isWet(at(c, x + dx, y + dy))) n += 1;
    return n;
  };

  for (const p of chosen) {
    put(c, p.x, p.y, terrain);
    blocked.add(p.y * c.w + p.x);
  }
  /*
   * 只留"从种子能走到的"那部分。
   *
   * 按距离截断之后，最外圈可能有个别格子跟主体断开了（它和主体之间那一格
   * 没被选中）——那就是一块 1~2 格的碎水。这里从种子做一次四连通泛洪，
   * 走不到的、又是这次新画的格子，一律退回平地。
   * 泛洪会把**原有**的水面也当通路（种子常常就贴着一片旧水），
   * 所以"新湖并进老湖"不会被误判成碎片。原有的水一格都不动。
   */
  if (chosen.length > 1) {
    const reach = new Set<number>();
    const stack: number[] = [center.y * c.w + center.x];
    reach.add(center.y * c.w + center.x);
    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = i % c.w;
      const y = Math.floor(i / c.w);
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!isWet(at(c, nx, ny))) continue;
        const ni = ny * c.w + nx;
        if (reach.has(ni)) continue;
        reach.add(ni);
        stack.push(ni);
      }
    }
    for (const p of chosen) {
      const i = p.y * c.w + p.x;
      if (reach.has(i)) continue;
      put(c, p.x, p.y, 'plain');
      blocked.delete(i);
    }
  }
  /*
   * 只填洞，**不削凸起**。
   *
   * 曾经有一版在这里"削掉只有 1 个水邻居的毛刺"。那是错的：`wetN` 是在边削边算的，
   * 一个加号形的小湖会从四个臂开始退化，削到最后一个都不剩——12×12 上实测
   * 补水阶段长出来的湖全被自己削没了，整张图只剩 4.9% 水。
   * 而且"毛刺"只要还连在主水体上，就不会变成一块独立碎水，留着无妨。
   */
  for (const p of cells) {
    if (at(c, p.x, p.y) !== 'plain') continue;
    if (blocked.has(p.y * c.w + p.x)) continue;
    if (allow && !allow(p.x, p.y)) continue;
    if (wetN(p.x, p.y) >= 3) put(c, p.x, p.y, terrain);
  }
  let placed = 0;
  for (const p of chosen) if (isWet(at(c, p.x, p.y))) placed += 1;
  return placed;
}

/**
 * 一条会拐弯的线：从 start 出发，朝 target 走，偶尔横向抖一下。
 *
 * 用来画支流。它比主河简单——主河要保证横贯全图、还要留渡口，
 * 支流只要"从边上流进来、接到中间"就够，剩下的交给连通性开凿那一步。
 * width=2 时两侧各补一格，看起来像条小溪而不是一刀切。
 */
function paintWander(
  c: Ctx,
  rng: () => number,
  start: Pos,
  target: Pos,
  terrain: Terrain,
  steps: number,
  width: number,
  blocked: Set<number>,
): void {
  let cur = { ...start };
  for (let i = 0; i < steps; i++) {
    const dx = Math.sign(target.x - cur.x);
    const dy = Math.sign(target.y - cur.y);
    // 主方向 + 抖动：全是直的会像尺子画的
    const r = rng();
    let nx = cur.x;
    let ny = cur.y;
    if (Math.abs(target.x - cur.x) >= Math.abs(target.y - cur.y)) {
      nx += dx;
      if (r < 0.3) ny += rng() < 0.5 ? 1 : -1;
    } else {
      ny += dy;
      if (r < 0.3) nx += rng() < 0.5 ? 1 : -1;
    }
    if (nx === cur.x && ny === cur.y) break;
    cur = { x: nx, y: ny };
    if (at(c, cur.x, cur.y) === undefined) break;
    put(c, cur.x, cur.y, terrain);
    blocked.add(cur.y * c.w + cur.x);
    if (width >= 2) {
      const side = Math.abs(target.x - cur.x) >= Math.abs(target.y - cur.y)
        ? { x: cur.x, y: cur.y + (rng() < 0.5 ? 1 : -1) }
        : { x: cur.x + (rng() < 0.5 ? 1 : -1), y: cur.y };
      if (at(c, side.x, side.y) === 'plain') {
        put(c, side.x, side.y, terrain);
        blocked.add(side.y * c.w + side.x);
      }
    }
  }
}

/**
 * 大地图"加料"：额外水体与山系。
 *
 * 为什么按边长分级：12×12 上一片湖就占了八分之一，走位全被它决定；
 * 32×32 上什么都不加，中间就是一大块空地——两个回合走到对面，看着很荒。
 * 所以这些地貌只在够大的图上出现：
 *   湖   ≥14（1 对）；≥26（2 对）；≥44（3 对）
 *   短山脊 ≥18（1 对）
 *   支流 ≥20（1 对）
 *   成片森林 ≥24（1 对，18~30 格的林子）
 *
 * 公平性：每一件都成对生成——一件落在 A 区，另一件落在它的点镜像位置。
 * 这样不管是对称图还是公平图，两边拿到的地形数量一致，
 * 不会出现"我这半边是湖、你那边是平原"的开局。
 */
function enrichTerrain(
  c: Ctx,
  rng: () => number,
  zoneOf: (x: number, y: number) => 'A' | 'B',
  blocked: Set<number>,
): void {
  const size = Math.min(c.w, c.h);
  if (size < 14) return;

  const mirrorPos = (p: Pos): Pos => mirrorOf(c, p);

  /** 在 A 区里挑一块空地的种子（`nearWater` 为真时优先挑贴着水的） */
  const seedInA = (nearWater = false): Pos | null => {
    if (nearWater) {
      /*
       * 贴着水长：湖是河的"湾"，不是独立的水坑。
       *
       * 这一条比"把湖画大"更能救海军——两块 20 格的水如果各自独立，
       * 船只能在两个池子里分别转圈；只有连成一片，通航范围才是整片水域。
       * 所以先找"和水正交相邻的空地"，找不到才退回全图随机。
       */
      const shore: Pos[] = [];
      for (let y = 1; y < c.h - 1; y++) {
        for (let x = 1; x < c.w - 1; x++) {
          if (zoneOf(x, y) !== 'A') continue;
          if (blocked.has(y * c.w + x)) continue;
          if (at(c, x, y) !== 'plain') continue;
          let touch = false;
          for (const [dx, dy] of DIRS) {
            if (isWet(at(c, x + dx, y + dy))) {
              touch = true;
              break;
            }
          }
          if (touch) shore.push({ x, y });
        }
      }
      if (shore.length > 0) return shore[Math.floor(rng() * shore.length)]!;
    }
    for (let t = 0; t < 300; t++) {
      const x = 1 + Math.floor(rng() * (c.w - 2));
      const y = 1 + Math.floor(rng() * (c.h - 2));
      if (zoneOf(x, y) !== 'A') continue;
      if (blocked.has(y * c.w + x)) continue;
      if (at(c, x, y) !== 'plain') continue;
      return { x, y };
    }
    return null;
  };

  // ---- 湖：按"水占比缺口"给面积，形状是圆盘 ----
  //
  // 旧版是固定 `tiles/700` 对、每块 `tiles*0.02`（20×20 上就是 1 对 8 格），
  // 结果水永远只有两三个小水坑；而河图里河已经占了 10%，再叠同样多的湖就过头。
  // 现在反过来算：目标占比 - 已有的水 = 缺口，缺口除以"每对约 10% 地图"得对数，
  // 每块 = 缺口 / (对数 × 2)（因为每对要长两处，镜像各一处）。
  // 这样同一套参数在任何尺寸、任何地貌上都指向同一个占比。
  const tiles = c.w * c.h;
  const gap = Math.max(0, Math.round(tiles * WATER_TARGET) - countWet(c));
  // 缺口太小就一片都不长。以前这里是 `Math.max(1, ...)`，于是"河已经把份额吃满"的
  // 图上还会硬塞一对湖，实测能推到 45%——一条河 + 一个汪洋湾，地图整个泡汤。
  const lakePairs =
    gap < Math.max(8, Math.round(tiles * 0.02))
      ? 0
      : Math.max(1, Math.min(4, Math.round(gap / Math.max(1, Math.round(tiles * 0.1)))));
  const lakeArea = Math.max(8, Math.round(gap / Math.max(1, lakePairs * 2)));
  for (let k = 0; k < lakePairs; k++) {
    // 每一对都优先贴水：湖要长成河的"湾"、湖与湖要串起来，
    // 海军才有一条能走的水道。长不出来（没水可贴）才退回全图随机。
    const seed = seedInA(true);
    if (!seed) break;
    const area = Math.max(6, Math.round(lakeArea * (0.8 + rng() * 0.4)));
    blobRegion(c, rng, seed, 'water', area, blocked);
    blobRegion(c, rng, mirrorPos(seed), 'water', area, blocked);
  }

  // ---- 支流：从地图边流进城与城之间的空档 ----
  //
  // 20×20 以前不给：一条支流就能把战场切成两半（实测攻城次数 7 → 1）。
  // 现在连通性兜底已经拆掉、水本来就该是障碍，所以门槛降到 22——
  // 大一点的图上多一条能通航的水道，比多一块死湖有用。
  if (size >= 22) {
    const mid = { x: Math.floor(c.w / 2), y: Math.floor(c.h / 2) };
    const edge = Math.floor(rng() * 4);
    const t = 3 + Math.floor(rng() * (size - 6));
    const start: Pos =
      edge === 0
        ? { x: t, y: 0 }
        : edge === 1
          ? { x: t, y: c.h - 1 }
          : edge === 2
            ? { x: 0, y: t }
            : { x: c.w - 1, y: t };
    const steps = Math.round(size * (0.45 + rng() * 0.3));
    paintWander(c, rng, start, mid, 'water', steps, rng() < 0.5 ? 2 : 1, blocked);
    paintWander(c, rng, mirrorPos(start), mirrorPos(mid), 'water', steps, rng() < 0.5 ? 2 : 1, blocked);
    // 64 这种巨图上一条支流感觉不到，再补一条从另一侧流进来的
    if (size >= 40) {
      const a = Math.floor(rng() * 4);
      const t2 = 3 + Math.floor(rng() * (size - 6));
      const s2: Pos =
        a === 0 ? { x: t2, y: 0 } : a === 1 ? { x: t2, y: c.h - 1 } : a === 2 ? { x: 0, y: t2 } : { x: c.w - 1, y: t2 };
      paintWander(c, rng, s2, mid, 'water', steps, 1, blocked);
      paintWander(c, rng, mirrorPos(s2), mirrorPos(mid), 'water', steps, 1, blocked);
    }
  }

  // ---- 次级山脊：一条短的山脉，主山脊之外的那种 ----
  if (size >= 18) {
    const ridgePairs = size >= 40 ? 2 : 1;
    for (let r = 0; r < ridgePairs; r++) {
    const horizontal = rng() < 0.5;
    const len = Math.round((horizontal ? c.w : c.h) * (0.35 + rng() * 0.25));
    const start: Pos = horizontal
      ? { x: 2 + Math.floor(rng() * (c.w - len - 4)), y: 2 + Math.floor(rng() * (c.h - 5)) }
      : { x: 2 + Math.floor(rng() * (c.w - 5)), y: 2 + Math.floor(rng() * (c.h - len - 4)) };
    const drawRidge = (from: Pos): void => {
      let cur = { ...from };
      for (let i = 0; i < len; i++) {
        const t = at(c, cur.x, cur.y);
        if (t === undefined) break;
        if (t === 'plain') put(c, cur.x, cur.y, 'mountain');
        // 山脚补丘陵，山体才不会像一排孤零零的方块
        for (const [dx, dy] of DIRS) {
          if (at(c, cur.x + dx, cur.y + dy) === 'plain' && rng() < 0.55) {
            put(c, cur.x + dx, cur.y + dy, 'hill');
          }
        }
        if (rng() < 0.25) {
          if (horizontal) cur = { x: cur.x, y: cur.y + (rng() < 0.5 ? 1 : -1) };
          else cur = { x: cur.x + (rng() < 0.5 ? 1 : -1), y: cur.y };
        }
        cur = horizontal ? { x: cur.x + 1, y: cur.y } : { x: cur.x, y: cur.y + 1 };
      }
    };
    drawRidge(start);
    drawRidge(mirrorPos(start));
    }
  }

  // ---- 成片的森林：一条明显的林子，比撒碎块更像"地形" ----
  if (size >= 24) {
    const forestPairs = size >= 40 ? 2 : 1;
    for (let f = 0; f < forestPairs; f++) {
      const seed = seedInA();
      if (!seed) break;
      const area = Math.max(16, Math.min(48, Math.round(tiles * 0.007)));
      const a = Math.round(area * (0.8 + rng() * 0.5));
      growRegion(c, rng, seed, 'forest', a, blocked);
      growRegion(c, rng, mirrorPos(seed), 'forest', a, blocked);
    }
  }
}

/**
 * 收尾校平：水不够就往"贴着已有水域"的空地上再长一块，够了就一格不加。
 *
 * 为什么要有这一步：前面的湖是**按缺口估算**长的（`enrichTerrain`），
 * 但中途会被城市压平、被别的林地抢地、被城郊的浅滩填补改数，
 * 实测会偏 2~4 个百分点。与其把每处参数都调到刚好，不如量一次真实占比再补。
 *
 * 三条约束：
 *   · **只补不削**。削水最容易制造碎块——从大块边缘啃一口，剩下的就散了；
 *   · **贴水优先**。新长的一定要挨着已有水面，这样补的是"把湖加宽"，
 *     而不是"在空地上多撒一个池塘"，连通性只会变好不会变差；
 *   · **不进城市近郊**（`apron`）。城门口要能出兵，这一条不能被补水破坏。
 */
function topUpWater(
  c: Ctx,
  rng: () => number,
  zoneOf: (x: number, y: number) => 'A' | 'B',
  cities: { A: Pos[]; B: Pos[] },
  contour: boolean,
): void {
  const tiles = c.w * c.h;
  const target = Math.round(tiles * WATER_TARGET);
  const apron = (x: number, y: number): boolean => {
    // 只护城block外一圈（切比雪夫 1）。以前护到 2 圈，12×12 上四座城加起来
    // 能盖掉八成棋盘，补水直接找不到落点——实测有整张图只剩 2.8% 水的。
    for (const p of [...cities.A, ...cities.B]) {
      if (x >= p.x - 1 && x <= p.x + c.citySize && y >= p.y - 1 && y <= p.y + c.citySize) {
        return true;
      }
    }
    return false;
  };
  /*
   * 能淹的地：丘陵、林地都行，山不行。
   *
   * `blocked` 在这条路上**不能用**：它记的是"已经有地形了"，而山岭图上那几乎就是
   * 整张棋盘（散布的丘陵 + 林地）。照它挑，补水一格都落不下来。
   * 城由 `apron` 兜——那才是唯一不能碰的东西。
   */
  /*
   * 等高线地貌（「地形高差」那几种）另有一套口径：只淹"低处"。
   *
   * 那套生成器是"连续高度场 + 阈值分层"，水本来只出现在最低那一带
   * （`water` / `shallow`，再往上是 `valley`）。往上糊一个圆盘湖不难看，
   * 糊到台地/山顶上就难看了——所以只允许河谷、平原、沼泽、林地和丘陵。
   * 台地（plateau）与峡谷外沿一律不碰。
   */
  const LOWLAND = new Set<Terrain>(['plain', 'valley', 'marsh', 'forest', 'hill']);
  const ground = (t: Terrain): boolean =>
    contour ? LOWLAND.has(t) : t !== 'mountain' && !isWet(t);
  const pick = (onShore: boolean): Pos | null => {
    const cands: Pos[] = [];
    for (let y = 1; y < c.h - 1; y++) {
      for (let x = 1; x < c.w - 1; x++) {
        if (zoneOf(x, y) !== 'A') continue;
        if (apron(x, y)) continue;
        const t = at(c, x, y);
        if (t === undefined || !ground(t)) continue;
        if (onShore) {
          let touch = false;
          for (const [dx, dy] of DIRS) {
            if (isWet(at(c, x + dx, y + dy))) {
              touch = true;
              break;
            }
          }
          if (!touch) continue;
        }
        cands.push({ x, y });
      }
    }
    return cands.length > 0 ? cands[Math.floor(rng() * cands.length)]! : null;
  };

  let guard = 0;
  while (guard++ < 8) {
    const have = countWet(c);
    if (have >= target) return;
    // 一处要长多少：两格一处（本体 + 镜像），所以缺口对半分
    const want = Math.min(Math.round(tiles * 0.05), Math.ceil((target - have) / 2));
    if (want < 5) return;
    const seed = pick(true) ?? pick(false);
    if (!seed) return;
    const allow = (x: number, y: number): boolean => !apron(x, y);
    // 传一副空账本：这一路不认 `blocked`（见 ground 的注释）
    const scratch = new Set<number>();
    const a1 = blobRegion(c, rng, seed, 'water', want, scratch, allow, ground);
    const a2 = blobRegion(c, rng, mirrorOf(c, seed), 'water', want, scratch, allow, ground);
    if (a1 + a2 === 0) return;
  }
}

/**
 * 填空白：把仍然是大片空地的区域补上林子和小丘。
 *
 * 这是用户直接提的问题——"大地图整体显得较空"。原因不是地形总量不够，
 * 而是它们**扎堆**：几团林子长在同一个角落，图上就剩下一片几百格的空场。
 * 光调高比例只是让团块更密，空白区还是空白区。
 *
 * 做法：(1) 找出所有连成片的"纯平原"区域；
 *       (2) 对超过阈值的区域，往里长小团块（森林为主、丘陵为辅），
 *           直到这块区域的空地比例降到目标值以下。
 * 这样补的是"缺口"，不是"平均撒一遍"，地形该密的地方仍然密。
 */
function fillEmptyRegions(
  c: Ctx,
  rng: () => number,
  blocked: Set<number>,
  opts: { minRegion: number; keepPlain: number; blob: [number, number] },
): void {
  const n = c.w * c.h;
  const seen = new Uint8Array(n);
  const regions: number[][] = [];

  for (let i = 0; i < n; i++) {
    if (seen[i] || c.g[i] !== 'plain' || blocked.has(i)) continue;
    const region: number[] = [];
    const st = [i];
    seen[i] = 1;
    while (st.length > 0) {
      const k = st.pop()!;
      region.push(k);
      const x = k % c.w;
      const y = (k - x) / c.w;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= c.w || ny >= c.h) continue;
        const j = ny * c.w + nx;
        if (seen[j] || c.g[j] !== 'plain' || blocked.has(j)) continue;
        seen[j] = 1;
        st.push(j);
      }
    }
    regions.push(region);
  }

  for (const region of regions) {
    if (region.length < opts.minRegion) continue;
    // 这块区域里还剩多少空地（生长过程中会变，所以每轮重数）
    let plain = region.filter((k) => c.g[k] === 'plain').length;
    const target = Math.floor(region.length * opts.keepPlain);
    let guard = 0;
    while (plain > target && guard < 60) {
      guard += 1;
      const k = region[Math.floor(rng() * region.length)]!;
      if (c.g[k] !== 'plain') continue;
      const x = k % c.w;
      const y = (k - x) / c.w;
      const terrain: Terrain = rng() < 0.72 ? 'forest' : 'hill';
      const size = opts.blob[0] + Math.floor(rng() * (opts.blob[1] - opts.blob[0] + 1));
      const placed = growRegion(c, rng, { x, y }, terrain, size, blocked);
      plain -= placed;
      if (placed === 0) break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4. 连通性：不通就开凿                                               */
/* ------------------------------------------------------------------ */

/**
 * 从起点到终点找一条"最省事"的路：能走的地方优先，森林丘陵次之，
 * 水和山只有实在绕不过去才穿。
 *
 * 找不到连通路径的地图是废图（打不起来），所以这件事必须硬保证，
 * 而不是"生成完看一眼，不行就重来"——重来几次也未必行，还会失去确定性。
 */
function cheapestPath(
  c: Ctx,
  from: Pos,
  to: Pos,
  isCity: (x: number, y: number) => boolean,
  /** 绝对不可穿越的格子（无渡口地图里的主河） */
  forbid?: Set<number>,
): Pos[] | null {
  const n = c.w * c.h;
  const dist: number[] = new Array(n).fill(Infinity);
  const prev: number[] = new Array(n).fill(-1);
  const start = from.y * c.w + from.x;
  const goal = to.y * c.w + to.x;
  dist[start] = 0;

  const queue: Array<{ i: number; d: number }> = [{ i: start, d: 0 }];
  while (queue.length > 0) {
    let pick = 0;
    for (let k = 1; k < queue.length; k++) {
      if ((queue[k]?.d ?? 0) < (queue[pick]?.d ?? 0)) pick = k;
    }
    const cur = queue.splice(pick, 1)[0];
    if (!cur) break;
    if (cur.d > (dist[cur.i] ?? Infinity)) continue;
    if (cur.i === goal) break;

    const x = cur.i % c.w;
    const y = Math.floor(cur.i / c.w);
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      const t = at(c, nx, ny);
      if (t === undefined) continue;
      const ni = ny * c.w + nx;
      if (forbid?.has(ni)) continue;
      // 城市格本身可通行；别的城占着也是障碍
      const step = isCity(nx, ny) ? 1 : t === 'plain' || t === 'city' ? 1 : t === 'forest' || t === 'hill' ? 3 : 40;
      const nd = cur.d + step;
      if (nd < (dist[ni] ?? Infinity)) {
        dist[ni] = nd;
        prev[ni] = cur.i;
        queue.push({ i: ni, d: nd });
      }
    }
  }

  if (!Number.isFinite(dist[goal] ?? Infinity)) return null;
  const path: Pos[] = [];
  let cur = goal;
  while (cur !== -1) {
    path.push({ x: cur % c.w, y: Math.floor(cur / c.w) });
    cur = prev[cur] ?? -1;
  }
  return path.reverse();
}

/**
 * 给挡路的山开隘口（水**一律不动**）。
 *
 * ---------------------------------------------------------------
 * 为什么不再凿水（2026-11-08）
 * ---------------------------------------------------------------
 * 这里以前会把路径上的水改成浅滩或平原，目的是"保证陆军能走到对面"。
 * 代价是：一条好好的河被填出若干个假陆桥，河断成几截，水军下水就是一口死塘。
 * 用户的原话是"你现在最缺的就是河流的连通性"——所以这条兜底整个拆掉。
 *
 * 现在的水是**真障碍**：要么造桥（`bridgeChainOk` 支持接龙，任意宽度都能架）、
 * 要么飞过去、要么下水。这和四人局早就在用的口径一致（见多人图那边的 `cut`），
 * 这次只是把它推广到双人和三人局。
 *
 * 山不一样：桥架不过山、飞行不是每族都有，所以山必须留隘口。
 */
function carve(c: Ctx, path: Pos[], blocked: Set<number>, mirror = false): void {
  const cut = (x: number, y: number) => {
    if (at(c, x, y) === 'mountain') put(c, x, y, 'hill');
  };

  for (const p of path) {
    cut(p.x, p.y);
    if (mirror) {
      const m = mirrorOf(c, p);
      cut(m.x, m.y);
    }
  }
  void blocked;
}

/* ------------------------------------------------------------------ */
/* 5. 城市周边与出生点                                                 */
/* ------------------------------------------------------------------ */

/**
 * 城市周围清出一圈空地：能出兵、能出城、能第一个回合就展开。
 *
 * 只平山、不填水：水边是要留给港口的（水军只能从临水城市下水），
 * 顺便也当护城河。山必须平，否则城可能被山圈死。
 */
function clearAroundCity(c: Ctx, city: Pos): void {
  for (let dy = -1; dy <= c.citySize; dy++) {
    for (let dx = -1; dx <= c.citySize; dx++) {
      const x = city.x + dx;
      const y = city.y + dy;
      const t = at(c, x, y);
      if (t === undefined) continue;
      // 城郊必须是能出兵、能展开的空地：山平掉
      if (t === 'mountain') put(c, x, y, 'plain');
    }
  }
}

/**
 * 在城边开一片**港湾**：湖泊或河湾。
 *
 * 目的很实际——水军只能在临水城市下水，如果地图上所有城都不挨水，
 * 那这一整类兵种就等于不存在。
 *
 * 2026-11-08 改成"港湾"而不是"水坑"：
 *   · 以前是 2~4 格的一串格子，全图 4 座城就是 4 堆独立碎水（实测碎水 3.5 块/张图）；
 *   · 现在先看城门四个方向哪边**已经有水**，优先朝那边铺，让它并进大河/大湖；
 *     没有现成的水才自己开一片 5~8 格的湾。
 * 水军要的是"能从城里下水、并且开得出去"，一堆互不相连的小水洼没这个用。
 */
function lakeNearCity(c: Ctx, city: Pos, rng: () => number, cities: Set<number>): void {
  if (rng() > 0.85) return;

  /** 这一侧城墙外第 k 格（k 从 1 开始），用于探测"哪边已经有水" */
  const cellOut = ([dx, dy]: readonly [number, number], k: number): Pos => ({
    x: dx > 0 ? city.x + c.citySize - 1 + k : dx < 0 ? city.x - k : city.x,
    y: dy > 0 ? city.y + c.citySize - 1 + k : dy < 0 ? city.y - k : city.y,
  });

  // 先看哪一侧 3 格以内已经有水：优先朝那边铺，让港湾并进大河/大湖
  const wetDir = DIRS.find((d) => {
    for (let k = 1; k <= 3; k++) {
      const p = cellOut(d, k);
      if (isWet(at(c, p.x, p.y))) return true;
    }
    return false;
  });
  const dir =
    wetDir && rng() < 0.8 ? wetDir : DIRS[Math.floor(rng() * DIRS.length)] ?? [0, 1];
  const [dx, dy] = dir;

  /*
   * 港湾也吃"水预算"。
   *
   * 每座城一片 5~8 格的水，四座城就是 20~30 格：20×20 上是 5~8%，12×12 上接近两成。
   * 不按预算发的话，河图（河本身已经占掉一成多）会被港湾推过 40%——
   * 实测 12×12 的河图有 47% 的。预算见底时只允许"朝已有水面接一格"，
   * 不再凭空开新水洼（那种小水洼对水军没有意义，只会变成碎水）。
   */
  const tiles = c.w * c.h;
  const left = Math.round(tiles * WATER_TARGET) - countWet(c);
  if (left < 3) return;
  const size = Math.min(wetDir && rng() < 0.8 ? 8 : 6, Math.max(3, left));
  // 从城墙上往外一格开始铺
  const startX =
    dx > 0 ? city.x + c.citySize : dx < 0 ? city.x - 1 : city.x + (rng() < 0.5 ? 0 : 1);
  const startY =
    dy > 0 ? city.y + c.citySize : dy < 0 ? city.y - 1 : city.y + (rng() < 0.5 ? 0 : 1);

  let cur = { x: startX, y: startY };
  const inCityOf = (p: Pos): boolean =>
    p.x >= city.x &&
    p.x <= city.x + c.citySize - 1 &&
    p.y >= city.y &&
    p.y <= city.y + c.citySize - 1;
  /** 横摆用的垂直方向 */
  const [px, py] = dx === 0 ? [1, 0] : [0, 1];
  for (let i = 0; i < size; i++) {
    if (at(c, cur.x, cur.y) === undefined) break;
    /*
     * 撞到**另一座城**就停。
     *
     * 港湾是直线往一个方向铺的，两座城挨得近时（12×12 上常见）它会一路刷到
     * 对面那座城身上——把人家整块城格刷成水，那座城当场变成"水上孤岛"，
     * 出生点、出兵、港口全乱。以前一次只刷 2~4 格，勉强够不到；改成港湾之后
     * 一次 6~8 格，这个洞就露出来了。
     */
    if (cities.has(cur.y * c.w + cur.x)) break;
    // 加宽格只在"主干那一格真的画了"的时候才画，否则会在城墙拐角处
    // 留下一个和谁都不相邻的孤格（1 格碎水就是这么来的）
    if (!inCityOf(cur)) {
      put(c, cur.x, cur.y, 'water');
      /*
       * 加宽一格，让港湾是一片水而不是一条线。
       *
       * 这里以前是"偶尔斜着挪一格"（`cur.x + dx + side` / `cur.y + dy + side`）——
       * 斜移出来的格子**只共角不共边**，四连通下每一格都是一块独立的水，
       * 一张图 4 座城就凭空多出 4 块 1 格碎水。这也是"水域过于零散"的一部分来源。
       * 现在只走正交一步，加宽用另一个正交方向补，铺出来是连成一片的湾。
       */
      const spread = rng() < 0.5 ? 1 : -1;
      const wide: Pos = { x: cur.x + px * spread, y: cur.y + py * spread };
      if (at(c, wide.x, wide.y) !== undefined && !inCityOf(wide) && !cities.has(wide.y * c.w + wide.x)) {
        put(c, wide.x, wide.y, 'water');
      }
    }
    cur = { x: cur.x + dx, y: cur.y + dy };
  }
}

/** 绕着城市找 count 个能站人的位置，越靠近城池越好 */
function spawnsAround(
  c: Ctx,
  city: Pos,
  count: number,
  used: Set<number>,
  pool: string[],
  offset: number,
): SpawnDef[] {
  const out: SpawnDef[] = [];
  for (let r = 2; r <= 6 && out.length < count; r++) {
    for (let dy = -r; dy <= r && out.length < count; dy++) {
      for (let dx = -r; dx <= r && out.length < count; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = city.x + Math.floor(c.citySize / 2) + dx;
        const y = city.y + Math.floor(c.citySize / 2) + dy;
        const t = at(c, x, y);
        if (t === undefined || !passable(t) || t === 'city') continue;
        const i = y * c.w + x;
        if (used.has(i)) continue;
        // 别把人扔进一格孤岛：至少得有一边能走出去
        const canStepOut = DIRS.some(([ox, oy]) => {
          const nb = at(c, x + ox, y + oy);
          return nb !== undefined && passable(nb);
        });
        if (!canStepOut) continue;
        used.add(i);
        out.push({ type: pool[(offset + out.length) % pool.length] as string, x, y });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 固定地图（手绘 / 玩家上传）                                          */
/* ------------------------------------------------------------------ */

/**
 * 用手绘的字符地形直接拼出一份 MapLayout。
 *
 * 和 `generateLayout` 的关系：生成器负责"从种子变出地形"，这条负责
 * "地形已经有人画好了，别乱动"。两条最后都要交出一份同样的 MapLayout，
 * 所以建局之后的所有流程（摆城、判临水、估出生点、算通行）完全共用一套。
 *
 * 刻意只做三件事：
 *   1. 把字符还原成地形；城市格（citiesA/B 覆盖的方块）强制写成 `city`，
 *      免得作者画漏一格，出现"城边上缺一角"的怪图；
 *   2. 用 `spawnsAround` 按同样的规则撒开局部队——手绘图不该自己定"谁站哪"，
 *      那部分规则一旦两处各写一份，改一处就会漂；
 *   3. 其余字段填默认值（style/symmetry/layout 只用于显示，`fordless` 永远 false：
 *      手绘图的河道由作者负责，不该被"无渡口"这条随机规则二次加工）。
 */
export function layoutFromRows(
  rows: string[],
  citiesA: Pos[],
  citiesB: Pos[],
  unitPool: string[] = [],
  citySize = 2,
): MapLayout {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const c: Ctx = { w, h, g: new Array<Terrain>(w * h).fill('plain'), citySize };
  for (let y = 0; y < h; y += 1) {
    const row = rows[y] ?? '';
    for (let x = 0; x < w; x += 1) {
      const t = terrainFromChar(row[x] ?? '.');
      put(c, x, y, t);
    }
  }
  const blocked = new Set<number>();
  for (const city of [...citiesA, ...citiesB]) {
    for (let dy = 0; dy < citySize; dy += 1) {
      for (let dx = 0; dx < citySize; dx += 1) {
        put(c, city.x + dx, city.y + dy, 'city');
        blocked.add((city.y + dy) * w + (city.x + dx));
      }
    }
  }

  const pool = unitPool.length > 0 ? unitPool : ['infantry'];
  const used = new Set<number>(blocked);
  const spawnsA: SpawnDef[] = [];
  const spawnsB: SpawnDef[] = [];
  citiesA.forEach((city, i) => spawnsA.push(...spawnsAround(c, city, i === 0 ? 3 : 2, used, pool, i * 3)));
  citiesB.forEach((city, i) => spawnsB.push(...spawnsAround(c, city, i === 0 ? 3 : 2, used, pool, i * 3)));

  return {
    w,
    h,
    rows: Array.from({ length: h }, (_, y) =>
      Array.from({ length: w }, (_, x) => CHAR[at(c, x, y) ?? 'plain']).join(''),
    ),
    citiesA,
    citiesB,
    spawnsA,
    spawnsB,
    // 固定地图没有"风格"可言：`style` 只用于界面显示，给它一个中性值
    style: 'open',
    symmetry: 'fair',
    layout: 'diagonal',
    fordless: false,
  };
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 微图（边长 ≤ 5）专门走这一条路。
 *
 * 4×4 一共 16 格，四个 2×2 的城正好把整张图铺满——标准那套"随机撒点 + 河 + 山脊"
 * 在这里会退化成四座城叠在同一格上（实测 5/5 张图都叠）。5×5 同理摆不开间距。
 *
 * 所以微图不再假装是"缩小的标准图"，而是明确的一张**街角斗殴**图：
 * 一边一座城，分占对角，不画河也不画山脊，剩下的格子全是出生点。
 * 这比让主流程去兼容 16 格的地图要诚实得多。
 */
function tinyLayout(
  size: number,
  unitPool: string[],
  symmetry: MapSymmetry,
  citySize: number,
): MapLayout {
  const w = size;
  const h = size;
  const c: Ctx = { w, h, g: new Array<Terrain>(w * h).fill('plain'), citySize };
  const citiesA = [{ x: 0, y: h - citySize }];
  const citiesB = [{ x: w - citySize, y: 0 }];
  for (const p of [...citiesA, ...citiesB]) {
    for (let dy = 0; dy < citySize; dy++) {
      for (let dx = 0; dx < citySize; dx++) put(c, p.x + dx, p.y + dy, 'city');
    }
  }

  const pool = unitPool.length > 0 ? unitPool : ['infantry'];
  const used = new Set<number>();
  /** 微图里空地就那么几块，直接按"离城中心近"排一遍，不用环形搜索 */
  const spots = (city: Pos, count: number, offset: number): SpawnDef[] => {
    const cx = city.x + Math.floor(citySize / 2);
    const cy = city.y + Math.floor(citySize / 2);
    const cand: Array<{ x: number; y: number; d: number }> = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = at(c, x, y);
        if (t === undefined || !passable(t) || t === 'city') continue;
        if (used.has(y * w + x)) continue;
        cand.push({ x, y, d: Math.abs(x - cx) + Math.abs(y - cy) });
      }
    }
    cand.sort((a, b) => a.d - b.d);
    const out: SpawnDef[] = [];
    for (const p of cand.slice(0, count)) {
      used.add(p.y * w + p.x);
      out.push({ type: pool[(offset + out.length) % pool.length] as string, x: p.x, y: p.y });
    }
    return out;
  };

  const spawnsA = spots(citiesA[0]!, 3, 0);
  const spawnsB = spots(citiesB[0]!, 3, 3);
  const rows = Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => CHAR[at(c, x, y) ?? 'plain']).join(''),
  );

  return {
    w,
    h,
    rows,
    citiesA,
    citiesB,
    spawnsA,
    spawnsB,
    style: 'open',
    symmetry,
    layout: 'diagonal',
    fordless: false,
  };
}

export function generateLayout(
  size: number,
  seed: number,
  unitPool: string[] = ['infantry', 'archer', 'cavalry', 'guard'],
  opts: MapOptions = {},
): MapLayout {
  const w = size;
  const h = size;

  // 城市边长：扩展可以把主城扩成 3×3，但棋盘太小就退回 2——
  // 一边长四分之一的硬上限，否则 12×12 上两座 3×3 的城会把出生点挤没。
  const wanted = Math.round(opts.citySize ?? 2);
  const citySize = Math.max(2, Math.min(wanted, Math.max(2, Math.floor(size / 4))));

  // 微图是另一套规则（见 tinyLayout 的注释），不走后面的随机生成
  if (size <= 5) return tinyLayout(size, unitPool, opts.symmetry ?? 'fair', citySize);

  // 这一局有没有"浅滩"这种东西：只要某个启用的扩展登记了浅流地形，就有。
  // 不点名具体扩展——谁引入了浅流，谁就顺带享有"凿水凿成浅滩"这套待遇。
  const c: Ctx = { w, h, g: new Array<Terrain>(w * h).fill('plain'), citySize };

  const rngStyle = makeRng(seed * 2654435761 + size * 7919 + 11);
  const rngCity = makeRng(seed * 40503 + size * 7919 + 29);
  const rngTerrain = makeRng(seed * 22695477 + size * 3751 + 7);

  const symmetry: MapSymmetry = opts.symmetry ?? 'fair';
  // 这一局能画哪些地貌：本体五种 + 已启用扩展自带的地貌。
  // 存档里可能留着"上次勾了扩展时选的高原"，扩展关掉后要退回随机，
  // 否则会画出一张全是台地、但规则里没有台地高度的图。
  const styles = mapStylesFor(opts.expansions ?? [])
    .map((o) => o.id)
    .filter((id): id is Exclude<MapStyle, 'random'> => id !== 'random');
  const style = resolveMapStyle(opts.style, styles, rngStyle);

  // 布局与河的走向解耦：同样是横河，也可能两边各占一对对角
  const layout: CityLayout = rngCity() < 0.5 ? 'split' : 'diagonal';
  const axis: 'h' | 'v' = style === 'river-v' ? 'v' : 'h';
  const plan = planCities(c, layout, axis, rngCity, symmetry === 'mirror');
  // 镜像模式下 B 的城市必须是 A 的严格镜像，否则城郊清场、出生点都会错位，
  // "完全对称"就名不副实了。
  if (symmetry === 'mirror') {
    plan.B = plan.A.map((p) => mirrorBlock(p.x, p.y, citySize, w, h));
  }
  const zoneOf = makeZoneOf(plan.A, plan.B, citySize);

  // ---- 大地貌：位置取两军前线的中点，保证横在双方之间 ----
  const midOf = (axis: 'h' | 'v') => {
    if (axis === 'h') {
      const yA = plan.A.map((p) => p.y + 1);
      const yB = plan.B.map((p) => p.y + 1);
      return (Math.min(...yA) + Math.max(...yB)) / 2;
    }
    const xA = plan.A.map((p) => p.x + 1);
    const xB = plan.B.map((p) => p.x + 1);
    return (Math.min(...xA) + Math.max(...xB)) / 2;
  };
  // 无渡口：河一处不断，过河只能造桥。
  // 只在"河真的把两军隔开"（对峙布局）时抽，否则它只是一条穿过
  // 双方领土的水沟——逼不出桥，还会把地图切成两半互不相干的小战场。
  let fordless = false;
  let riverCells = new Set<number>();
  if (style === 'river-h' || style === 'river-v') {
    const mayFordless = layout === 'split';
    const band = mayFordless ? freeBand(c, plan, axis, midOf(axis)) : null;
    fordless = !!band && rngTerrain() < 0.45;
    if (fordless && band) {
      riverCells = paintRiver(c, axis, rngTerrain, midOf(axis), {
        fordless: true,
        bandLo: band.lo + 1,
        bandHi: band.hi - 1,
      });
      // 万一河身被空档挤没了，就当这张图没有河
      if (riverCells.size === 0) fordless = false;
    } else {
      riverCells = paintRiver(c, axis, rngTerrain, midOf(axis));
    }
  } else if (style === 'ridge') {
    // 山脊必须横在两军之间：南北对峙就横着修，东西对峙就竖着修
    paintRidge(c, rngTerrain, midOf('h'), 'h');
  }

  // ---- 城市占位：先把城市那 8 格标记成不可生长 ----
  const blocked = new Set<number>(); // 不能长地形的格子（城市 + 已长好的地块）
  const cityCells = new Set<number>(); // 只记城市：镜像和寻路要用
  const markCity = (p: Pos) => {
    for (let dy = 0; dy < citySize; dy++) {
      for (let dx = 0; dx < citySize; dx++) {
        const x = p.x + dx;
        const y = p.y + dy;
        if (at(c, x, y) === undefined) continue;
        put(c, x, y, 'plain');
        blocked.add(y * w + x);
        cityCells.add(y * w + x);
      }
    }
  };
  for (const p of [...plan.A, ...plan.B]) markCity(p);

  // ---- 团块地形：两侧配额相同、分布不同 ----
  const countPlain = (zone: 'A' | 'B') => {
    let n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (zoneOf(x, y) !== zone) continue;
        if (at(c, x, y) === 'plain') n += 1;
      }
    }
    return n;
  };
  const areaA = countPlain('A');
  const areaB = countPlain('B');
  const base = Math.min(areaA, areaB);

  // ---- 地形本体：两条路 ----
  //
  //   · 扩展地貌：由扩展自己的生成器长地形。那一套是"连续高度场 + 阈值分层"，
  //     长出来是同心环状的等高线地形（山心→台地→丘陵→平原→谷地）。
  //   · 本体地貌：走原来的团块配方，一行不改——老地图的手感不该被动到。
  //
  // 分岔放在这里而不是更早，是因为两条路共用同一套骨架：城已摆好、
  // blocked 已标好、镜像与连通性开凿都在下面统一做。
  const styleDef = mapStylesFor(opts.expansions ?? []).find((st) => st.id === style);
  const build = styleDef?.build;
  if (build) {
    build({
      w,
      h,
      citySize,
      zoneOf,
      cities: plan,
      blocked,
      rng: rngTerrain,
      put: (x, y, t) => put(c, x, y, t),
      at: (x, y) => at(c, x, y),
      mirror: (x, y) => mirrorOf(c, { x, y }),
      grow: (x, y, t, area) => growRegion(c, rngTerrain, { x, y }, t, area, blocked),
      pick: (zone) => pickSeed(c, rngTerrain, zoneOf, zone, blocked),
    });
    // 扩展自己长完地形就到此为止：本体的"加料 / 填空白"会把等高线打碎
    // （它们是给撒点式地图补纹理的，会把山脊掏出一堆碎林子和小湖）。
  } else {
    // 本体五种地貌的配方。扩展地貌走上面那条路，不会进到这里。
    const ratio: Array<{ t: Terrain; r: number }> = [
      { t: 'forest', r: style === 'open' ? 0.06 : 0.11 },
      { t: 'hill', r: style === 'ridge' ? 0.13 : style === 'open' ? 0.05 : 0.08 },
      { t: 'mountain', r: style === 'open' ? 0 : 0.03 },
    ];
    for (const { t, r } of ratio) {
      const n = Math.round(base * r);
      if (n <= 0) continue;
      scatterTerrain(c, rngTerrain, zoneOf, t, { A: n, B: n }, blocked);
    }

    // ---- 大地图加料：额外的湖、支流、短山脊、成片森林 ----
    // 放在镜像和连通性开凿之前：镜像会把这些统一成对称的，
    // 开凿则保证加了这么多水体之后地图还是通得过去的。
    enrichTerrain(c, rngTerrain, zoneOf, blocked);

    // ---- 填空白：把还剩的大块空地补上林子/小丘 ----
    // 只对够大的图做：12×12 上一团林子就占了十分之一，本来就不空。
    if (Math.min(c.w, c.h) >= 16) {
      fillEmptyRegions(c, rngTerrain, blocked, {
        minRegion: Math.round((c.w * c.h) * 0.06), // 小于 6% 地图的空地不用管
        keepPlain: 0.9,                            // 大块空地至少留 90% 是空地
        blob: [3, Math.max(5, Math.min(10, Math.round(Math.min(c.w, c.h) / 4)))],
      });
    }
  }

  // ---- 完全镜像：把每一对镜像格统一成同一块地形 ----
  //
  // 做法是"取 A 区那一侧的版本，两边都写成它"。逐格复制 A 区到 B 区不行：
  // 分区按"离谁近"算，边界不是严格的反对角线，会漏掉一些格子。
  const symmetrize = () => {
    if (symmetry !== 'mirror') return;
    const snap = [...c.g];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const m = mirrorOf(c, { x, y });
        if (m.x < 0 || m.y < 0 || m.x >= w || m.y >= h) continue;
        const mi = m.y * w + m.x;
        if (mi <= i) continue; // 每一对只处理一次
        if (cityCells.has(i) || cityCells.has(mi)) continue; // 城格留给后面统一

        const fromA = zoneOf(x, y) === 'A' ? snap[i] : snap[mi];
        const value = fromA ?? 'plain';
        c.g[i] = value;
        c.g[mi] = value;
      }
    }
    // 镜像可能把地形拍到城格上，这里重新压平一次
    for (const p of [...plan.A, ...plan.B]) markCity(p);
  };
  symmetrize();

  // ---- 连通性：只给山开隘口，水一格都不动（见 carve 的注释） ----
  const isCity = (x: number, y: number) => cityCells.has(y * w + x);
  const anchorA = plan.A[0];
  /**
   * 从 A 主城往每座城找一条最省事的路，把**山**开出隘口。
   *
   * 水在 `carve` 里已经不处理了，这里传 `forbid` 只为了解决一件事：
   * 无渡口图上如果允许路径穿过主河，凿出来的隘口会落在河对岸——
   * 陆军过不去，那个口子等于白开。所以无渡口时仍然让路径绕开河身。
   */
  const openPasses = (): void => {
    if (!anchorA) return;
    for (const target of [...plan.A.slice(1), ...plan.B]) {
      // 从城边上出发（城格本身是 plain，可以直接当起点）
      const path = cheapestPath(
        c,
        { x: anchorA.x, y: anchorA.y + 1 },
        { x: target.x, y: target.y + 1 },
        isCity,
        fordless ? riverCells : undefined,
      );
      if (path) carve(c, path, blocked, symmetry === 'mirror');
    }
  };
  openPasses();

  // ---- 城市周边清空 + 城边开一片水（给港口留位置） ----
  for (const p of plan.A) lakeNearCity(c, p, rngTerrain, cityCells);
  for (const p of plan.B) lakeNearCity(c, p, rngTerrain, cityCells);
  for (const p of [...plan.A, ...plan.B]) clearAroundCity(c, p);

  /*
   * 城郊：**保证城外还有 ≥3 格能站人的陆地，但不再把水面填掉**。
   *
   * 旧规则是"城墙外一圈最多留 2 格水，其余填平"。水里一多，这条会把城边的湖
   * 削成一条两格宽的护城河——水军想在城门口下水就没地方了，等于把
   * "临水城市"这件事从地图上抹掉。
   *
   * 现在只在陆地真的不够站人时才动手，而且填的是**浅滩**不是平原：
   * 陆军能踩、船能停，水面一格不少（`navigable()` 含 shallow）。
   * 三格是 `spawnsAround` 的最低要求——开局一个兵都摆不下才是真的坏图。
   */
  const STANDABLE_MIN = 3;
  for (const p of [...plan.A, ...plan.B]) {
    const ring: Array<{ x: number; y: number; d: number }> = [];
    let standable = 0;
    for (let dy = -1; dy <= citySize; dy++) {
      for (let dx = -1; dx <= citySize; dx++) {
        const x = p.x + dx;
        const y = p.y + dy;
        const inCity = x >= p.x && x < p.x + citySize && y >= p.y && y < p.y + citySize;
        if (inCity) continue;
        const t = at(c, x, y);
        if (t === undefined) continue;
        if (isWet(t) || t === 'mountain') {
          ring.push({ x, y, d: Math.abs(dx - 0.5) + Math.abs(dy - 0.5) });
        } else {
          standable += 1;
        }
      }
    }
    if (standable >= STANDABLE_MIN) continue;
    ring.sort((a, b) => a.d - b.d);
    for (const t of ring) {
      if (standable >= STANDABLE_MIN) break;
      // 天堑图（无渡口）的硬口径：河身那几格保持深水，城门口不留可徒涉的口子，
      // 否则"过河只能造桥"就成了一句空话。城圈的其它水照常填成浅滩。
      if (fordless && riverCells.has(t.y * c.w + t.x)) continue;
      put(c, t.x, t.y, 'shallow');
      standable += 1;
    }
  }
  symmetrize(); // 城郊处理也要对称，否则镜像模式会和"严格对称"对不上

  // ---- 收尾校平：水不够就贴着已有水域再长，够了一格不加 ----
  //
  // 前面的湖是"按缺口估算"长的，中途会被城市、山、别的林地吃掉一些，
  // 而且城边水、浅滩填补都会改数。这里量一次真实占比，只补不削：
  // **削水最容易制造碎块**（从大块边缘啃一口，剩下的就散了）。
  //
  // 等高线地貌只淹低处（见 topUpWater 里的 LOWLAND），本体地貌不淹山。
  //  等高线地貌（`build`）也要补水：它们的阈值分层只决定"水在最低那一带"，
  //  并不保证有多少——实测同一套参数能出 2.5%，也能出 43%。不补的话，
  //  玩家勾了「地形高差」就会抽到 7% 水的图（线上反馈就是这么来的）。
  topUpWater(c, rngTerrain, zoneOf, plan, !!build);

  // 湖可能把城围住，重新找一次隘口（只平山，不动水）
  openPasses();

  // ---- 扩展的地形收尾：整张棋盘交给它们整理一遍 ----
  //
  // 放在所有开凿/清场之后、出生点之前：这一步只看"最后的地形长什么样"，
  // 前面谁凿了谁填了都不必关心。多个扩展按启用顺序依次过一遍。
  // 关掉扩展这条循环就是空的——本体地图一格都不会变。
  //
  // 交给它们一张"不许动"的名单：城市本身加城郊那一圈。城门口要能站人、
  // 要能出兵，补山脚补到那儿就成了"城被台地围死"。
  const keepAroundCity = new Set<number>();
  for (const p of [...plan.A, ...plan.B]) {
    for (let dy = -1; dy <= citySize; dy++) {
      for (let dx = -1; dx <= citySize; dx++) {
        const x = p.x + dx;
        const y = p.y + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        keepAroundCity.add(y * w + x);
      }
    }
  }
  for (const id of opts.expansions ?? []) {
    expansionById(id)?.afterTerrain?.(c.g, c.w, c.h, keepAroundCity);
  }
  // 收尾会改地形，而镜像是在这之前做完的。现在这道收尾是"对称进、对称出"
  // （只看地形、不看 rng），所以这一步其实是空转；留着是因为它很便宜，
  // 而下一个写 afterTerrain 的人未必守这条——一处不对称，整张镜像图就废了。
  symmetrize();

  // ---- 出生点 ----
  const pool = unitPool.length > 0 ? unitPool : ['infantry'];
  const used = new Set<number>(blocked);
  const spawnsA: SpawnDef[] = [];
  const spawnsB: SpawnDef[] = [];
  plan.A.forEach((city, i) => {
    spawnsA.push(...spawnsAround(c, city, i === 0 ? 3 : 2, used, pool, i * 3));
  });
  plan.B.forEach((city, i) => {
    spawnsB.push(...spawnsAround(c, city, i === 0 ? 3 : 2, used, pool, i * 3));
  });

  const rows = Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => CHAR[at(c, x, y) ?? 'plain']).join(''),
  );

  return {
    w,
    h,
    rows,
    citiesA: plan.A,
    citiesB: plan.B,
    spawnsA,
    spawnsB,
    style,
    symmetry,
    layout,
    fordless,
  };
}

/* ------------------------------------------------------------------ */
/* 三人 / 四人图                                                        */
/* ------------------------------------------------------------------ */

/**
 * 三家或四家的地图。
 *
 * 为什么另起一条而不是给 `generateLayout` 加个参数：两人局那张图是被反复
 * 调过的（河怎么走、渡口留几个、公平性怎么算），把它参数化成 N 方，等于
 * 每加一种人数就重调一次。这条只管"多方地图的最低要求"：
 *
 *   · **四家**：左上四分之一画好，旋转 90° 铺三遍——三家地形与四家严格同形，
 *     中心天然对称，这是能做到的**完全公平**；
 *   · **三家**：方格棋盘没有 120° 旋转对称（转 120° 落在半格上），所以只能
 *     做到"数量公平"——按离谁最近把棋盘分成三块，每块的森林 / 丘陵 / 水**数量
 *     完全相同**，位置各自随机。中心的水面是圆心圆，三家等距。
 *
 * 共同点：开局位置在三个 / 四个方向上等距，城郊一圈永远清空（城门口要能站人），
 * 出生部队走和两人局同一个 `spawnsAround`。
 */
/**
 * 双城市开局至少要多大一块棋盘。
 *
 * 两种排法各解一次：
 *   · **三家**走外圈八点，相邻两点间距是 `(size - 2 - citySize) / 2`，
 *     要求它不小于"城本体 + 城郊各一格 + 两格过道"（`citySize + 4`）→ `3*citySize + 10`；
 *   · **四家**走田字四区，每区要独立装下一对基地：边距 1 + 城 + 空档 + 城 + 边距 1，
 *     空档取 `citySize + 2`（城郊不相接）→ 单区 `3*citySize + 4`，整图两倍 → `6*citySize + 8`。
 *
 * 2×2 的城：三家 16×16，四家 20×20。
 * 四家比三家大一圈是**故意的**——田字把棋盘切成四块之后，每块都要单独放得下一对
 * 基地；按 16×16 算，单区只有 8×8，两座 2×2 的城加上城郊一圈就占掉大半，
 * "随机生成"退化成"只能摆在对角"。20×20 单区 10×10，落点才真有腾挪余地。
 *
 * 导出给开局面板和 setup 用：**约束不满足就不让开局**，而不是悄悄摆出两座贴脸的城。
 */
export function twoCityMinSize(citySize = 2, players: 3 | 4 = 3): number {
  const cs = Math.max(2, Math.round(citySize));
  return players === 4 ? 6 * cs + 8 : 3 * cs + 10;
}

/**
 * 同一家的两座城至少要隔几格（切比雪夫，锚点到锚点）。
 *
 * 三家（外圈环）和四家（田字四区）用的是两条不同的式子：环上要留过道给人走，
 * 田字里两座城是背靠背的自家兄弟，只要求"城郊不贴脸"。
 */
export const TWO_CITY_GAP = (citySize: number, players: 3 | 4 = 3): number =>
  players === 4 ? Math.max(2, Math.round(citySize)) + 2 : Math.max(2, Math.round(citySize)) + 4;

/** 两座城之间至少要隔几格（切比雪夫，锚点到锚点） */
export const CITY_MIN_GAP = (citySize: number): number => Math.max(2, Math.round(citySize)) + 4;

export function generateMultiLayout(
  size: number,
  seed: number,
  unitPool: string[] = ['infantry', 'archer'],
  opts: {
    players: 3 | 4;
    citySize?: number;
    style?: MapStyle;
    /**
     * 本局启用的扩展：决定**地貌池**里有没有高原/峡谷/沼泽/群岛/大川。
     *
     * 不传就等于一张干净的图：只有本体四种。这和双人那边同一个口径
     * （`generateLayout` 也读 `expansions`）——扩展关了，那几种地貌就不该出现。
     */
    expansions?: readonly string[];
    /** 每家两座城（见 types.ts 的 twoCities）。只影响城位，地貌照旧 */
    twoCities?: boolean;
  },
): MapLayout {
  const w = size;
  const h = size;
  const n = opts.players;
  const citySize = Math.max(2, Math.min(Math.round(opts.citySize ?? 2), Math.max(2, Math.floor(size / 5))));
  /*
   * 地貌：和双人**同一个袋子、同一条选择规则**（`resolveMapStyle`）。
   *
   * 以前这一行是 `opts.style !== 'random' ? opts.style : 'open'`：
   * "随机"在三人四人图里恒等于开阔，而且 `style` 之后**再没被读过**
   * （只原样写进返回值的 label 里）——也就是说多人图根本没有地貌这回事，
   * 顶栏写着"横河"，画出来的还是那套随机团块。
   *
   * 池子 = 本体四种 + 本局扩展带来的地貌，和双人**完全同一份**
   * （`mapStylesFor(opts.expansions)`）。扩展那几套生成器是给"两家 + 点对称"写的，
   * 多家图的套法见下面 `extBuild` 那段——借一份虚拟的 A/B 分区让它跑起来。
   */
  const styles = mapStylesFor(opts.expansions ?? [])
    .map((o) => o.id)
    .filter((id): id is Exclude<MapStyle, 'random'> => id !== 'random');
  const style = resolveMapStyle(opts.style, styles, makeRng(seed * 2654435761 + size * 7919 + 11));
  const rng = makeRng(seed ^ (n * 7919));
  const c: Ctx = { w, h, g: new Array(w * h).fill('plain'), citySize };
  /**
   * 城与棋盘边的间距：只留一格。
   *
   * 一开始写的是 `1 + citySize`（城往后缩三格）。16×16 上四家时，一格象限只有 8×8，
   * 而城郊还要清出一圈——留给地形的地方被吃得干干净净，生成出来的四家图是一片光板。
   * 城贴着角放，反而更像"四角开局"，中间也真的有了地形。
   */
  const margin = 1;

  /** 把角度换算成城位（锚点＝左上角） */
  const fromAngle = (deg: number, radius: number): Pos => {
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    const t = (deg * Math.PI) / 180;
    const ax = Math.round(cx + Math.cos(t) * radius - (citySize - 1) / 2);
    const ay = Math.round(cy + Math.sin(t) * radius - (citySize - 1) / 2);
    return {
      x: Math.max(margin, Math.min(w - margin - citySize, ax)),
      y: Math.max(margin, Math.min(h - margin - citySize, ay)),
    };
  };

  /*
   * ---- 城位 ----
   *
   * 每家的城数由 `twoCities` 决定。两家城的排法是一条**环形**：
   * 在外圈的八个格点上按顺序取 2N 个，同一家拿相邻的两个。
   *
   * 为什么非得是环：需求里有一条"任意两家的连线不得交叉"。把城摆成凸多边形
   * （外圈八点就是凸的），再让每家拿**相邻**的两个，那每家的连线都是多边形的边，
   * 边与边永不相交——这条不变量是构造出来的，不用事后去验。
   * 反过来，如果给每家配"对角"两个，连线立刻变成两条对角线、必然打叉。
   *
   * 起点按种子错开：同一张图每局落点不同，但"相邻配对"这条永远成立。
   * 于是同一家的两座城互为犄角、各自朝外，中间那片留作主战场。
   */
  const perPlayer = opts.twoCities ? 2 : 1;
  const totalCities = n * perPlayer;

  /** 外圈八个格点，按顺时针排（凸位置），供双城市开局取用 */
  const outerRing = (): Pos[] => {
    const bx0 = margin;
    const by0 = margin;
    const bx1 = w - margin - citySize;
    const by1 = h - margin - citySize;
    const mx = Math.round((bx0 + bx1) / 2);
    const my = Math.round((by0 + by1) / 2);
    return [
      { x: bx0, y: by0 },
      { x: mx, y: by0 },
      { x: bx1, y: by0 },
      { x: bx1, y: my },
      { x: bx1, y: by1 },
      { x: mx, y: by1 },
      { x: bx0, y: by1 },
      { x: bx0, y: my },
    ];
  };

  /*
   * 四人双城：**田字四区**，每家两个基地都落在自己那块里。
   *
   * 和"外圈环"的区别不只是好看：环是四家共处一条外圈，谁都能沿着边绕到别人背后；
   * 田字则是"每家一个角"，自己的后方是自己的，接火只可能发生在两条区域边界上。
   * 代价是同一家的两座城不再"互为犄角面向外"，而是**背靠背**——一起守得住，
   * 一旦被人从中间切开就各自为战。
   *
   * 三个约束：
   *   · 基地不能压区域边界（留 `border` 格），否则会出现"半座城在这个区、半个在隔壁"；
   *   · 同一家的两座城至少隔 `citySize + 2`：城本体 + 城郊各一格，正好不贴脸；
   *   · 位置在区内**随机**取（种子决定），不是写死的角点。
   * 两点在同一个凸区域里，连线自然整条都留在区内，所以"同家连线不交叉"自动成立。
   */
  const quadAnchors = (): Pos[] => {
    const border = 1;
    const gap = citySize + 2;
    /** 四块：左上 → 右上 → 右下 → 左下，和单城四人图的席位顺序一致 */
    const boxes = [
      { x0: 0, y0: 0, w: Math.floor(w / 2), h: Math.floor(h / 2) },
      { x0: Math.floor(w / 2), y0: 0, w: w - Math.floor(w / 2), h: Math.floor(h / 2) },
      { x0: Math.floor(w / 2), y0: Math.floor(h / 2), w: w - Math.floor(w / 2), h: h - Math.floor(h / 2) },
      { x0: 0, y0: Math.floor(h / 2), w: Math.floor(w / 2), h: h - Math.floor(h / 2) },
    ];
    const out: Pos[] = [];
    for (const b of boxes) {
      const lo = { x: b.x0 + border, y: b.y0 + border };
      const hi = { x: b.x0 + b.w - border - citySize, y: b.y0 + b.h - border - citySize };
      // 区太小（棋盘被压到极限）时先把落点夹回区里，绝不越界
      const x1 = Math.max(lo.x, hi.x);
      const y1 = Math.max(lo.y, hi.y);
      /*
       * 掷 32 对，取"合格里最开"的那一对。
       *
       * `bestD` 必须从 -1 起：一开始把它写成"对角线的距离"的话，随机采样永远
       * 追不上那个初值，结果就是**每局都摆成对角**——"随机生成"成了句空话
       * （这个坑当场就是这么踩进去的，用例也是靠"把种子写进 key"才假装通过的）。
       */
      const roll = () => ({
        x: lo.x + Math.floor(rng() * (x1 - lo.x + 1)),
        y: lo.y + Math.floor(rng() * (y1 - lo.y + 1)),
      });
      let best: [Pos, Pos] | null = null;
      let bestD = -1;
      for (let k = 0; k < 32; k += 1) {
        const a = roll();
        const c = roll();
        const d = Math.max(Math.abs(a.x - c.x), Math.abs(a.y - c.y));
        if (d >= gap && d > bestD) {
          best = [a, c];
          bestD = d;
        }
      }
      // 区太小、一对合格的都掷不出来：退到对角线，保证"不重叠"这条底线
      const pair: [Pos, Pos] = best ?? [
        { x: lo.x, y: lo.y },
        { x: x1, y: y1 },
      ];
      out.push(pair[0], pair[1]);
    }
    return out;
  };

  const anchors: Pos[] = (() => {
    if (perPlayer === 2 && n === 4) return quadAnchors();
    if (perPlayer === 2) {
      const ring = outerRing();
      const off = Math.floor(rng() * ring.length);
      return Array.from({ length: totalCities }, (_, i) => ring[(off + i) % ring.length]!);
    }
    return n === 4
      ? // 四角：矩形四等分，旋转 90° 之后完全重合
        [
          { x: margin, y: margin },
          { x: w - margin - citySize, y: margin },
          { x: w - margin - citySize, y: h - margin - citySize },
          { x: margin, y: h - margin - citySize },
        ]
      : // 三家：内切圆三等分，顶点朝上
        [-90, 30, 150].map((deg) => fromAngle(deg, Math.min(w, h) * 0.34));
  })();

  /**
   * 城郊一圈：城本体 + 外面一格。
   *
   * 这一圈里什么都不长（树林、山、水都不行）——城门口要能站人、能出兵，
   * 上来就被一圈山围住的城市是没法玩的。四个分支共用同一份，不再各写一遍。
   */
  const apron = new Set<number>();
  for (const a of anchors) {
    for (let dy = -1; dy <= citySize; dy++) {
      for (let dx = -1; dx <= citySize; dx++) {
        const x = a.x + dx;
        const y = a.y + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        apron.add(y * w + x);
      }
    }
  }

  /**
   * 离**哪一家**最近（Voronoi）。
   *
   * 返回的是"第几家"（0 起），不是"第几座城"：双城市开局时每家两座城，
   * 按城下标划区会得到 6/8 个区，而下游（三家图的配平、扩展地貌的 A/B）只认"家"。
   */
  const regionOf = (x: number, y: number): number => {
    let best = 0;
    let bd = Infinity;
    anchors.forEach((a, i) => {
      const d = Math.abs(x - a.x) + Math.abs(y - a.y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return Math.floor(best / perPlayer);
  };

  /**
   * 一团地形：从种子点随机游走 k 步。walk 保证"连成一团"而不是一堆散点。
   *
   * 返回**真正画上去的格数**：三家图靠它数"每区各长了多少地形"，
   * 只有这样三家才真的配平（而不是"撒了同样多的团，落点一个都没踩上"）。
   * 只往平原上画——重复覆盖会让计数和实际地貌对不上。
   */
  const blob = (sx: number, sy: number, terrain: Terrain, k: number, ok: (x: number, y: number) => boolean): number => {
    let x = sx;
    let y = sy;
    let painted = 0;
    for (let i = 0; i < k; i += 1) {
      if (x >= 0 && y >= 0 && x < w && y < h && ok(x, y) && at(c, x, y) === 'plain') {
        put(c, x, y, terrain);
        painted += 1;
      }
      const [dx, dy] = DIRS[Math.floor(rng() * 4)]!;
      x = Math.max(1, Math.min(w - 2, x + dx));
      y = Math.max(1, Math.min(h - 2, y + dy));
    }
    return painted;
  };

  /** 城本体占的格子：扩展地貌不许长到城上，连通性开凿也靠它认城 */
  const cityCells = new Set<number>();
  for (const a of anchors) {
    for (let dy = 0; dy < citySize; dy += 1) {
      for (let dx = 0; dx < citySize; dx += 1) cityCells.add((a.y + dy) * w + (a.x + dx));
    }
  }

  /*
   * ---- 扩展地貌（高原 / 峡谷 / 沼泽 / 群岛 / 大川）----
   *
   * 这几套生成器是给"两家"写的：`MapBuildCtx` 只有 A/B 两个分区、山心靠点镜像复制。
   * 多家图套上去的办法是**给它一份虚拟的两家模型**：按"离哪座城最近"分区，
   * 下标奇偶分到 A / B。四家图上 A 是对角那两家，点镜像正好把 A 映回 A、B 映回 B，
   * 所以生成器内部那套"一侧长山心、另一侧镜像"仍然自洽。
   *
   * 代价说清楚：三家图上 A 是两座城、B 是一座，四家图上 A/B 是对角两家——
   * 生成出来的等高线**不再逐家对称**，山心落在谁那边由种子决定。
   * 这是有意接受的：多人局要的是"一起玩一局有意思的图"，不是公平竞技
   * （用户原话：趣味优先、公平为辅）。要严格对称就用本体那四种地貌。
   */
  const extBuild = mapStylesFor(opts.expansions ?? []).find((st) => st.id === style)?.build;
  if (extBuild) {
    // 按"第几家"分 A/B（不是按"第几座城"）：双城市开局时一家两城必须落在同一侧，
    // 否则 `cities.A / cities.B` 会把同一家的两座城拆到两边去
    const zoneOf2 = (x: number, y: number): 'A' | 'B' => (regionOf(x, y) % 2 === 0 ? 'A' : 'B');
    extBuild({
      w,
      h,
      citySize,
      zoneOf: zoneOf2,
      cities: {
        A: anchors.filter((_, i) => Math.floor(i / perPlayer) % 2 === 0),
        B: anchors.filter((_, i) => Math.floor(i / perPlayer) % 2 === 1),
      },
      blocked: cityCells,
      rng,
      put: (x, y, t) => put(c, x, y, t),
      at: (x, y) => at(c, x, y),
      mirror: (x, y) => ({ x: w - 1 - x, y: h - 1 - y }),
      grow: (x, y, t, area) => growRegion(c, rng, { x, y }, t, area, cityCells),
      pick: (zone) => pickSeed(c, rng, zoneOf2, zone, cityCells),
    });
  } else if (n === 4) {
    // 四分之一画好，旋转三次铺满
    const qw = Math.floor(w / 2);
    const qh = Math.floor(h / 2);
    /** 象限内的地形 -> 四个象限（绕中心转 90°） */
    const paint = (x: number, y: number, t: Terrain) => {
      put(c, x, y, t);
      put(c, w - 1 - x, y, t);
      put(c, w - 1 - x, h - 1 - y, t);
      put(c, x, h - 1 - y, t);
    };
    const inQuadrant = (x: number, y: number) => x > 0 && y > 0 && x < qw && y < qh;
    /** 撒点缀用：四个旋转格里只填还空着的，不覆盖已画好的天险 */
    const paintPlain = (x: number, y: number, t: Terrain) => {
      for (const p2 of [
        { x, y },
        { x: w - 1 - x, y },
        { x: w - 1 - x, y: h - 1 - y },
        { x, y: h - 1 - y },
      ]) {
        if (apron.has(p2.y * w + p2.x)) continue;
        if (at(c, p2.x, p2.y) !== 'plain') continue;
        put(c, p2.x, p2.y, t);
      }
    };

    /*
     * ---- 天险：十字形的河 / 山脊 ----
     *
     * 四人图必须是 90° 旋转对称的（见 `paint`：一格写四次）。横河/纵河在两家
     * 图里是一条贯穿全图的带子，照搬到四家图上只把棋盘分成"上下两对"：
     * 同岸的两家之间不用过河，隔岸的才要——自由混战里这就是位置不平等。
     * 所以多人图把两条带子**叠成十字**：每家都在一个象限里，去见谁都要过河/翻山。
     *
     * 只在 16 以上画十字。12×12 上两条两格宽的带子要吃掉三成面积，
     * 四家的城郊再各占一圈，剩下的地方不够摆阵——小图退回单带（仍是对称的）。
     */
    if (style !== 'open') {
      const isRidge = style === 'ridge';
      const hazard: Terrain = isRidge ? 'mountain' : 'water';
      const cross = Math.min(w, h) >= 16;
      /*
       * 四家图上"横河"和"纵河"不能再按朝向区分。
       *
       * 保持 90° 旋转对称（这是四人图公平性的来源）的话，十字的两条臂必须等长等宽：
       * 谁粗一点，转 90° 之后就自相矛盾了。所以两者的区别落到**河的形态**上，
       * 而且和地貌说明对得上：
       *   · 横河 = 河窄、**渡口宽**（三格），一翻就过去；
       *   · 纵河 = 河身连着中心一片大湖、**渡口只留一格**——
       *     "贯通"在这里的含义是"这条水真的把图分开"，不是"多画一条"。
       * 两种都在每半个象限各留一个口子（`paint` 会把口子对称复制），
       * 所以"少"指的是宽度，不是数量：四家都得出得去。
       */
      const oneFord = style === 'river-v';
      const lakeR = style === 'river-v' ? Math.max(1, Math.round(Math.min(w, h) / 12)) : 0;
      /** 口子（渡口 / 隘口）：位置在象限里偏城的一侧，`paint` 会转出另外三个 */
      const fordRow = Math.max(2, Math.round(qh * 0.45));
      const fordCol = Math.max(2, Math.round(qw * 0.45));
      /**
       * 横河开三格宽的口子，纵河只开一格——"贯通全图"要的是能过的口子更少。
       *
       * 判据要看**两边**：`paint` 会把 x 映射到 w-1-x，只放过左侧那几格的话，
       * 右侧的镜像格照样会把水补回去（第一版就是这样，渡口一格都没开出来，
       * 横河和纵河画出来一模一样）。
       */
      const isGap = (v: number, at2: number) => {
        const hit = (u: number) => (oneFord ? Math.abs(u - at2) === 0 : Math.abs(u - at2) <= 1);
        return hit(v) || hit(w - 1 - v);
      };
      /** 画一格就同时画它的三次旋转——四人图的对称全靠这一步 */
      const band = (x: number, y: number, t: Terrain = hazard) => {
        if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1) return;
        if (apron.has(y * w + x)) return;
        paint(x, y, t);
      };
      /*
       * 山岭要和双人那边同一个长相：中间一条山脊，两边各一条山脚（丘陵），
       * 隘口处山脊降成丘陵。只画一条纯山带的话，"山岭"和"一堵墙"没有区别，
       * 而双人图上的山岭是可以贴着山脚绕的。
       */
      // 横带：中线上下各一格（`paint` 的上下镜像正好把这一行补成两行）
      const midY = Math.floor(h / 2) - 1;
      for (let x = 1; x < w - 1; x += 1) {
        const gap = isGap(x, fordCol);
        if (gap) {
          if (isRidge) paintPlain(x, midY, 'hill'); // 隘口：山脊降成丘陵
        } else {
          band(x, midY);
        }
        // 山脚只画**一侧**：核心是两格宽（midY 与它的上下镜像），
        // 两侧都画的话 midY+1 正好镜像回 midY，把山脊自己盖成丘陵
        if (isRidge) paintPlain(x, midY - 1, 'hill');
      }
      // 纵带：只在够大的图上画，和横带组成十字
      if (cross) {
        const midX = Math.floor(w / 2) - 1;
        for (let y = 1; y < h - 1; y += 1) {
          const gap = isGap(y, fordRow);
          if (gap) {
            if (isRidge) paintPlain(midX, y, 'hill');
          } else {
            band(midX, y);
          }
          if (isRidge) paintPlain(midX - 1, y, 'hill');
        }
      }
      // 纵河：中心连成一片湖（`paint` 会把半径复制到四个象限的角上，仍是 4 重对称）
      if (lakeR > 0) {
        const ccx = Math.floor(w / 2);
        const ccy = Math.floor(h / 2);
        for (let dy = -lakeR; dy <= lakeR; dy += 1) {
          for (let dx = -lakeR; dx <= lakeR; dx += 1) {
            if (dx * dx + dy * dy > lakeR * lakeR) continue;
            const x = ccx + dx;
            const y = ccy + dy;
            if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1) continue;
            band(x, y);
          }
        }
      }
    }

    /*
     * 目标：每个象限大约三成地形。
     *
     * 和三家那边同一个道理——"撒几团"不等于"长出来多少"：游走出界、撞上城郊、
     * 和上一团重叠都会被扣掉，写死团数会让不同种子之间疏密差一倍
     * （实测出现过整张图一棵树都没有的种子）。所以数**画上去的格数**，不够就接着撒。
     *
     * 地形种类按固定顺序轮换、不掷骰子：四个象限本来就是同一份地貌旋转出来的，
     * 这样至少保证"林子、山、水各有一点"，不会整张图只剩山。
     *
     * 河/山那两档已经把主要地貌画完了（见上面的十字），这里只撒**点缀**：
     * 目标从三成降到一成，而且不再撒水团——否则图上既有十字河又有一堆池塘，
     * 陆军走两步就被挡一次，那不是"有水"，是"没路"。
     */
    const quadGoal = Math.round(qw * qh * (style === 'open' ? 0.34 : 0.1));
    const KINDS: Terrain[] =
      style === 'open' ? ['forest', 'forest', 'hill', 'water', 'hill', 'forest'] : ['forest', 'hill', 'forest'];
    let painted = 0;
    let guard = 0;
    let k = 0;
    while (painted < quadGoal && guard < 400) {
      guard += 1;
      const sx = 1 + Math.floor(rng() * Math.max(1, qw - 2));
      const sy = 1 + Math.floor(rng() * Math.max(1, qh - 2));
      // 起点落进城郊就重扔：城角那一圈是留白的，不该再长树
      if (apron.has(sy * w + sx)) continue;
      const t = KINDS[k % KINDS.length]!;
      k += 1;
      // 水团小一点：水连成片会把象限切断，四家都过不去
      const size2 = t === 'water' ? 2 + Math.floor(rng() * 2) : 3 + Math.floor(rng() * 4);
      let x = sx;
      let y = sy;
      for (let step = 0; step < size2; step += 1) {
        if (inQuadrant(x, y) && !apron.has(y * w + x) && at(c, x, y) === 'plain') {
          /*
           * 只往**空地**上撒：`paint` 一次写四格，四个旋转格里只要有一格已经是水/山，
           * 硬写就把十字河凿出个缺口（实测横带中段被一丛树盖成了丘陵）。
           * 判据逐格看，只落空地。
           */
          paintPlain(x, y, t);
          painted += 1;
        }
        const [dx, dy] = DIRS[Math.floor(rng() * 4)]!;
        x = Math.max(1, Math.min(qw - 1, x + dx));
        y = Math.max(1, Math.min(qh - 1, y + dy));
      }
    }
  } else {
    /*
     * 三家：把棋盘按"离谁最近"划成三块，每块长**一样多**的地形。
     *
     * 早先的写法是"每区撒 5 个团、每团 4 格"，看着配平，实际不是：
     * 团是随机游走出来的，走到界外、走到城郊、和上一团重叠都会被丢掉，
     * 于是三家实际长出来的格数能差一倍（实测出现过一边全是树、另一边光板）。
     * 现在反过来：**先数每区画成了多少格**，谁不够就接着撒，直到三家一样多。
     */
    const perRegion = 6;
    const blobSize = 4;
    const goal = perRegion * blobSize;

    const regions: number[][] = Array.from({ length: n }, () => []);
    for (let y = 1; y < h - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const i = y * w + x;
        if (apron.has(i)) continue;
        // 城门口再留一圈：开局谁也不该被山挡在家里
        if (anchors.some((a) => Math.abs(x - a.x) + Math.abs(y - a.y) <= citySize + 2)) continue;
        regions[regionOf(x, y)]!.push(i);
      }
    }

    /*
     * ---- 天险：沿着"三家分界"长出来的 Y 形河 / 山脊 ----
     *
     * 三家图画不出一条公平的直线河：任何一条线都把三家切成 1 对 2，
     * 落单那家天然被水护着，另外两家却要跨河互殴。
     *
     * 第一版试过"三条按 120° 射出去的支流"，结果更糟：`regionOf` 用的是曼哈顿距离，
     * 三个分区并不是规整的 120° 扇形，按角度画出来的带子会整条落进某一家，
     * 三家地形数量直接变成 15/30/18。所以改成**按真正的分界线画**：
     * 一条格子的四邻里出现了别家的分区，它就是边界——三条边界在中心汇成 Y，
     * 每家左右各一条，走哪边都要过河，而自家后方是完整的一片。
     * 边界格天然被两家平摊，配平不用额外做。
     */
    if (style !== 'open') {
      const hazard: Terrain = style === 'ridge' ? 'mountain' : 'water';
      const ccx = Math.floor(w / 2);
      const ccy = Math.floor(h / 2);
      /*
       * 三家图上"横河"和"纵河"也按形态区分，不按朝向。
       *
       * 三条分界线是 120° 等分的，转不出"横"和"纵"两种朝向（转 120° 就等于没转）。
       * 所以和四家图同一个办法：
       *   · 横河 = 细河 + 宽渡口；
       *   · 纵河 = 宽河（边界连同左右各一格）+ 窄渡口 + 中心连片水。
       */
      const wide = style === 'river-v';
      const isRidge = style === 'ridge';
      /** 渡口/隘口：三条边界都在同一个半径上开口，位置一样才公平 */
      const fordR = Math.round(Math.min(w, h) * 0.34);
      const isEdge = (x: number, y: number): boolean => {
        const r = regionOf(x, y);
        return (
          regionOf(x + 1, y) !== r ||
          regionOf(x - 1, y) !== r ||
          regionOf(x, y + 1) !== r ||
          regionOf(x, y - 1) !== r
        );
      };
      const isGapAt = (x: number, y: number): boolean => {
        const d = Math.hypot(x - ccx, y - ccy);
        const gap = wide ? 0.6 : 1.6;
        return d >= fordR - gap && d <= fordR + gap;
      };
      for (let y = 1; y < h - 1; y += 1) {
        for (let x = 1; x < w - 1; x += 1) {
          if (apron.has(y * w + x)) continue;
          const onEdge = isEdge(x, y);
          const fringe = isEdge(x + 1, y) || isEdge(x - 1, y) || isEdge(x, y + 1) || isEdge(x, y - 1);
          if (!onEdge && !(wide && fringe) && !(isRidge && fringe)) continue;
          if (isGapAt(x, y)) {
            // 隘口：山脊降成丘陵；河就干脆不画（留一条能过的口子）
            if (isRidge && onEdge && at(c, x, y) === 'plain') put(c, x, y, 'hill');
            continue;
          }
          if (onEdge) put(c, x, y, hazard);
          else if (at(c, x, y) === 'plain') put(c, x, y, isRidge ? 'hill' : hazard);
        }
      }
    }

    // 洗牌：同一个种子洗出同一个顺序，可复现
    for (const list of regions) {
      for (let i = list.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [list[i], list[j]] = [list[j]!, list[i]!];
      }
    }

    const KINDS: Terrain[] =
      style === 'open' ? ['forest', 'hill', 'water'] : ['forest', 'hill', 'forest'];
    regions.forEach((list, r) => {
      let cursor = 0;
      let tiles = 0;
      let k = 0;
      // 河/山那两档已经把主体画完了，这里只补点缀（同上：四家那边的注释）
      const cap = style === 'open' ? goal : Math.round(goal * 0.4);
      while (tiles < cap && cursor < list.length) {
        const i = list[cursor++]!;
        const x = i % w;
        const y = Math.floor(i / w);
        if (at(c, x, y) !== 'plain') continue;
        const t = KINDS[k % KINDS.length]!;
        // 水只给两格：连成一片就成了海，三家会被水隔开
        const size2 = t === 'water' ? 2 : blobSize;
        tiles += blob(x, y, t, size2, (bx, by) => regionOf(bx, by) === r && !apron.has(by * w + bx));
        k += 1;
      }
    });

    // 中心一小片水：三家等距，谁也别想独占。纵河那一档把它放宽一格——
    // "贯通全图"这条说明落到三家图上，就是"河宽、中心连成一片"
    const cx = Math.floor(w / 2);
    const cy = Math.floor(h / 2);
    const rad = Math.max(1, Math.floor(Math.min(w, h) / 12) + (style === 'river-v' ? 1 : 0));
    for (let dy = -rad; dy <= rad; dy += 1) {
      for (let dx = -rad; dx <= rad; dx += 1) {
        if (dx * dx + dy * dy > rad * rad) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (apron.has(y * w + x)) continue;
        put(c, x, y, 'water');
      }
    }
  }

  /*
   * ---- 水域校平：多人图以前一格都没调 ----
   *
   * 线上反馈"新开一把只有 7% 水"。双人那边有湖、有港湾、有收尾补水，
   * 多人这边**一套都没有**——水域只靠"每团 2 格的点缀水"加中心那一小圈，
   * 实测 3 人图 7.9%、4 人图 6.7%，最干的种子直接 0%。
   *
   * 这里补上和双人同一个目标（`WATER_TARGET`），但必须保住多人图的公平：
   *   · **四家**：只长一处，然后把**画上去的那几格**按 90° 镜像复制三份。
   *     不能"在四个镜像点上各长一次"——`blobRegion` 每次都要摇随机数，
   *     四次长出来的形状不一样，逐格镜像对称当场就破了（实测差 28 格）。
   *   · **三家**：方格棋盘没有 120° 旋转对称，只能做"数量公平"。
   *     做法是每轮挑**水最少的那个区**补一块，补到三家齐平为止。
   */
  {
    const target = Math.round(w * h * WATER_TARGET);
    const ground = (t: Terrain): boolean =>
      t === 'plain' || t === 'valley' || t === 'forest' || t === 'hill' || t === 'marsh';
    const allowWater = (x: number, y: number): boolean => !apron.has(y * w + x);
    const pickInRegion = (r: number, onShore: boolean): Pos | null => {
      const cands: Pos[] = [];
      for (let y = 1; y < h - 1; y += 1) {
        for (let x = 1; x < w - 1; x += 1) {
          if (apron.has(y * w + x)) continue;
          if (regionOf(x, y) !== r) continue;
          const t = at(c, x, y);
          if (t === undefined || !ground(t)) continue;
          if (onShore) {
            let touch = false;
            for (const [dx, dy] of DIRS) {
              if (isWet(at(c, x + dx, y + dy))) {
                touch = true;
                break;
              }
            }
            if (!touch) continue;
          }
          cands.push({ x, y });
        }
      }
      return cands.length > 0 ? cands[Math.floor(rng() * cands.length)]! : null;
    };
    const scratch = new Set<number>();
    /** 在 region 里长一块水，返回真实画上的格数 */
    const grow = (r: number, each: number): number => {
      const seed = pickInRegion(r, true) ?? pickInRegion(r, false);
      if (!seed) return 0;
      return blobRegion(c, rng, seed, 'water', each, scratch, allowWater, ground);
    };
    /**
     * 四家：长一块，再把"新画上去的格子"镜像复制三份。
     *
     * 复制的是**结果**，不是过程——随机数只摇一次，四角才严格同形。
     */
    const growFourFold = (each: number): number => {
      const seed = pickInRegion(0, true) ?? pickInRegion(0, false);
      if (!seed) return 0;
      const before = new Set<number>();
      for (let i = 0; i < c.g.length; i += 1) if (isWet(c.g[i])) before.add(i);
      const painted = blobRegion(c, rng, seed, 'water', each, scratch, allowWater, ground);
      if (painted === 0) return 0;
      const fresh: Pos[] = [];
      for (let i = 0; i < c.g.length; i += 1) {
        if (isWet(c.g[i]) && !before.has(i)) {
          fresh.push({ x: i % w, y: Math.floor(i / w) });
        }
      }
      for (const p of fresh) {
        for (const q of [
          { x: w - 1 - p.x, y: p.y },
          { x: p.x, y: h - 1 - p.y },
          { x: w - 1 - p.x, y: h - 1 - p.y },
        ]) {
          if (q.x < 0 || q.y < 0 || q.x >= w || q.y >= h) continue;
          if (apron.has(q.y * w + q.x)) continue;
          if (at(c, q.x, q.y) === 'mountain') continue;
          put(c, q.x, q.y, 'water');
        }
      }
      return fresh.length * 4;
    };
    const wetInRegion = (r: number): number => {
      let k = 0;
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          if (regionOf(x, y) !== r) continue;
          if (isWet(at(c, x, y))) k += 1;
        }
      }
      return k;
    };

    if (n === 4) {
      let guard = 0;
      while (guard < 6) {
        guard += 1;
        const gap = target - countWet(c);
        if (gap < 12) break;
        if (growFourFold(Math.max(5, Math.ceil(gap / 4))) === 0) break;
      }
    } else {
      const per = Math.round(target / n);
      let guard = 0;
      while (guard < 10) {
        guard += 1;
        let worst = 0;
        for (let r = 1; r < n; r += 1) if (wetInRegion(r) < wetInRegion(worst)) worst = r;
        const deficit = per - wetInRegion(worst);
        if (deficit < 4) break;
        if (grow(worst, Math.min(deficit, Math.max(6, Math.ceil(deficit)))) === 0) break;
      }
    }
  }

  /*
   * ---- 连通性：每家都得能靠陆路走到中间 ----
   *
   * 加进十字河/放射河之后这条从"保险"变成了"必须"：水面一横，某一家可能被
   * 整条河关在自己的角里——那不是"难打"，是这局根本打不起来（顶栏写着轮到你，
   * 可你一个兵都出不了门）。
   *
   * 和双人那边同一个办法：找一条最省事的路线，把路上的水凿成浅滩、山开出隘口。
   * 四家图额外把这条路线**旋转四次**一起凿——不然凿出来的那一条会破坏
   * 90° 对称，"四角同势"就成了空话。
   */
  {
    // 城格集合在上面统一算过了（扩展地貌也要用同一份），这里不再抄一遍
    const isCity = (x: number, y: number) => cityCells.has(y * w + x);
    /**
     * 开一条口子：**只平山，水一格不动**。
     *
     * 四人局早就是这个口径（"水可以靠桥和飞行解决，山不行——桥架不过山，
     * 飞行也不是每族都有"）。2026-11-08 起三家局也并进来，两个人口径一致，
     * 代价是河边不再"必然能走过去"：过河要么造桥、要么飞、要么下水。
     */
    const cut = (x: number, y: number) => {
      if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1) return;
      if (apron.has(y * w + x)) return;
      if (at(c, x, y) === 'mountain') put(c, x, y, 'hill');
    };
    /*
     * 终点是**另一家**，不是地图中心。
     *
     * 拿中心当终点看着更"居中"，实际是错的：十字河的中心就在水里，
     * 于是"打通到中心"会把整片交叉口凿成平地——四条河臂在正中间连成一个大口子，
     * 谁都能从那儿走过去，天险等于没画（第一版就是这样，横带只剩两头两截）。
     *
     * 家与家之间本来就该走渡口：`cheapestPath` 给水 40 分、平地 1 分，
     * 有现成的口子它一定走口子，只有真的没口子才凿一格。
     */
    if (n === 4) {
      /*
       * 四人局：**只给山开口，不为水挖口**。
       *
       * 一开始这里和三家一样"陆路必须通"，结果是在十字河上凿出好几条随机通道，
       * 渡口就成了摆设（玩家分不清哪儿是设计好的口子、哪儿是凿出来的）。
       * 而四人局的定位本来就是"好玩"，水挡路修桥、飞行就过去了，不必替玩家铺平。
       *
       * 山不一样：桥架不过山，所以只在**山**上开隘口。两条走廊（上路 A→B、左路 A→D）
       * 各自按 `paint` 那组镜像凿四次——只凿一条的话，四个像只在上、下各给一条，
       * 连出来是 A–B 和 C–D 两对，两对之间还是隔着（实测 120 组里 17 组断开）。
       */
      const cutSym = (path: Pos[] | null): void => {
        for (const p of path ?? []) {
          cut(p.x, p.y);
          cut(w - 1 - p.x, p.y);
          cut(w - 1 - p.x, h - 1 - p.y);
          cut(p.x, h - 1 - p.y);
        }
      };
      const at2 = (i: number) => ({ x: anchors[i]!.x, y: anchors[i]!.y + 1 });
      cutSym(cheapestPath(c, at2(0), at2(1), isCity)); // 上路
      cutSym(cheapestPath(c, at2(0), at2(3), isCity)); // 左路
    } else {
      // 三家：0 号连到另外两家就够了（连通关系是传递的）
      for (const b of [1, 2]) {
        const path = cheapestPath(
          c,
          { x: anchors[0]!.x, y: anchors[0]!.y + 1 },
          { x: anchors[b]!.x, y: anchors[b]!.y + 1 },
          isCity,
        );
        for (const p of path ?? []) cut(p.x, p.y);
      }
    }
  }

  // 城位与城郊永远踩实：城要放得下、门口要能出兵
  for (const a of anchors) {
    for (let dy = -1; dy <= citySize; dy += 1) {
      for (let dx = -1; dx <= citySize; dx += 1) put(c, a.x + dx, a.y + dy, 'plain');
    }
  }

  // ---- 出生点 ----
  const pool = unitPool.length > 0 ? unitPool : ['infantry'];
  // 出生点不能和城郊、也不能和彼此抢格子（`used` 会被 spawnsAround 逐格追加）
  const used = new Set<number>(apron);
  const spawnsFor = anchors.map((a, i) => spawnsAround(c, a, 3, used, pool, i * 3));

  const rows = Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => CHAR[at(c, x, y) ?? 'plain']).join(''),
  );

  /** 第 i 家分到的城位（双城市开局时是两座，顺序就是外圈上的顺序） */
  const citiesOfPlayer = (i: number): Pos[] =>
    anchors.slice(i * perPlayer, (i + 1) * perPlayer);
  /** 第 i 家的出生点：两座城各自的出生点按顺序接起来 */
  const spawnsOfPlayer = (i: number): SpawnDef[] => {
    const out: SpawnDef[] = [];
    for (let k = 0; k < perPlayer; k += 1) out.push(...(spawnsFor[i * perPlayer + k] ?? []));
    return out;
  };
  return {
    w,
    h,
    rows,
    citiesA: citiesOfPlayer(0),
    citiesB: citiesOfPlayer(1),
    citiesC: n >= 3 ? citiesOfPlayer(2) : undefined,
    citiesD: n >= 4 ? citiesOfPlayer(3) : undefined,
    spawnsA: spawnsOfPlayer(0),
    spawnsB: spawnsOfPlayer(1),
    spawnsC: n >= 3 ? spawnsOfPlayer(2) : undefined,
    spawnsD: n >= 4 ? spawnsOfPlayer(3) : undefined,
    style,
    symmetry: n === 4 ? 'fair' : 'fair',
    layout: 'diagonal',
    fordless: false,
  };
}
