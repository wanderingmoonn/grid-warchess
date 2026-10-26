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
import type { Terrain } from './types.ts';

export type MapStyle = 'random' | 'river-h' | 'river-v' | 'ridge' | 'open';
export type MapSymmetry = 'fair' | 'mirror';

export const MAP_STYLES: Array<{ id: MapStyle; name: string; note: string }> = [
  { id: 'random', name: '随机', note: '按种子抽一种地貌' },
  { id: 'river-h', name: '横河', note: '东西向河流，多处渡口' },
  { id: 'river-v', name: '纵河', note: '南北向河流，贯通全图' },
  { id: 'ridge', name: '山岭', note: '连片高山与丘陵，只有隘口能过' },
  { id: 'open', name: '开阔', note: '没有天险，纯靠正面硬碰' },
];

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
}

export interface MapLayout {
  w: number;
  h: number;
  rows: string[];
  citiesA: Array<{ x: number; y: number }>;
  citiesB: Array<{ x: number; y: number }>;
  spawnsA: SpawnDef[];
  spawnsB: SpawnDef[];
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
};

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
}

const at = (c: Ctx, x: number, y: number): Terrain | undefined =>
  x < 0 || y < 0 || x >= c.w || y >= c.h ? undefined : c.g[y * c.w + x];

const put = (c: Ctx, x: number, y: number, t: Terrain): void => {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  c.g[y * c.w + x] = t;
};

const mirrorOf = (c: Ctx, p: Pos): Pos => ({ x: c.w - 1 - p.x, y: c.h - 1 - p.y });

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
 * 以前是写死的 4：12×12 上还算合理，但到了 20×20、32×32 就变成"两城挤在角落"——
 * 中间空出一大片没人烟的地，开局要跑七八个回合才照面。现在按棋盘边长的 1/4 给，
 * 4 是下限（小图上再大就摆不开了）。
 */
const MIN_CITY_SEP_FLOOR = 4;
const MIN_CITY_SEP_RATIO = 0.25;

function minCitySep(size: number): number {
  return Math.max(MIN_CITY_SEP_FLOOR, Math.floor(size * MIN_CITY_SEP_RATIO));
}

function citySep(a: Pos, b: Pos): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
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
 * 必须保留的不变量：**对峙布局下，A 的两个城和 B 的两个城必须分处河的两侧**。
 * 无渡口河要靠这条才能真的把两军隔开（见 freeBand / midOf）。
 */
function planCities(c: Ctx, layout: CityLayout, axis: 'h' | 'v', rng: () => number) {
  const span = 2;
  // 同一侧两座城、以及敌对两城之间的硬下限都按这个走
  const minSep = minCitySep(Math.min(c.w, c.h));
  // 纵深方向 = 河要横穿的那个方向；横向 = 沿着河的方向
  const along = axis === 'h' ? c.h : c.w;
  const cross = axis === 'h' ? c.w : c.h;
  const floorGap = axis === 'h' ? 4 : 5;

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

  const make = (front: number, taken: Pos[]): Pos => {
    for (let t = 0; t < 40; t++) {
      // 纵深方向：−1 往前压、0 不动、+1 往回缩
      const d = Math.floor(rng() * 3) - 1;
      // 横向：整条宽度里随便挑，不再锁死在两端
      const cr = crossLo + Math.floor(rng() * Math.max(1, crossHi - crossLo + 1));
      const a = Math.max(alongLo, Math.min(alongHi, front + d));
      const p: Pos = axis === 'h' ? { x: cr, y: a } : { x: a, y: cr };
      if (taken.every((q) => citySep(p, q) >= minSep)) return p;
    }
    // 实在撒不下就退到前线上，保证一定回得去一个合法布局
    const cr = crossLo + Math.floor(rng() * Math.max(1, crossHi - crossLo + 1));
    return axis === 'h' ? { x: cr, y: front } : { x: front, y: cr };
  };

  const attempt = (): { A: Pos[]; B: Pos[] } => {
    const taken: Pos[] = [];
    const side0: Pos[] = [];
    const side1: Pos[] = [];
    for (const f of [front0, front1]) {
      const arr = f === front0 ? side0 : side1;
      for (let k = 0; k < 2; k++) {
        const p = make(f, taken);
        taken.push(p);
        arr.push(p);
      }
    }
    // 对峙：A 整条边、B 整条边；对角：两岸各有敌我各一
    if (layout === 'diagonal') {
      return { A: [side0[0]!, side1[0]!], B: [side0[1]!, side1[1]!] };
    }
    const aFirst = axis === 'h'; // 横河时 A 在南岸（front1），纵河时 A 在西岸（front0）
    return aFirst ? { A: side1, B: side0 } : { A: side0, B: side1 };
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

  let best = attempt();
  let bestScore = score(best);
  for (let i = 0; i < 20 && bestScore > 0; i++) {
    const cand = attempt();
    const s = score(cand);
    if (s < bestScore) {
      best = cand;
      bestScore = s;
    }
  }
  return best;
}

/** 这块地离谁的城市更近 */
function makeZoneOf(citiesA: Pos[], citiesB: Pos[]) {
  return (x: number, y: number): 'A' | 'B' => {
    const p = { x, y };
    let da = Infinity;
    let db = Infinity;
    for (const c1 of citiesA) da = Math.min(da, blockDist(p, c1));
    for (const c1 of citiesB) db = Math.min(db, blockDist(p, c1));
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
    if (t === 'water') painted.add(y * c.w + x);
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
    // 上限：汪洋可以大，但不能把整张图泡了，否则两边连照面的地方都没有
    return Math.min(w, Math.max(4, Math.round(span * 0.42)));
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

    if (inGap(t)) continue;

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

/**
 * 随机漫游长出一块地形。
 *
 * 逐格独立随机撒出来的"森林"看着像噪点；按团块长才有"林子""山包"的形体，
 * 也才有"绕过去还是穿过去"的选择。
 */
function growBlob(
  c: Ctx,
  rng: () => number,
  zoneOf: (x: number, y: number) => 'A' | 'B',
  zone: 'A' | 'B',
  terrain: Terrain,
  size: number,
  blocked: Set<number>,
): number {
  const start = pickSeed(c, rng, zoneOf, zone, blocked);
  if (!start) return 0;

  let cur = start;
  let placed = 0;
  for (let i = 0; i < size; i++) {
    if (at(c, cur.x, cur.y) !== 'plain') break;
    put(c, cur.x, cur.y, terrain);
    blocked.add(cur.y * c.w + cur.x);
    placed += 1;

    // 50% 粘在当前格旁边继续长，50% 跳回起点附近，避免长成一根面条
    const around = rng() < 0.5 ? cur : start;
    const [dx, dy] = DIRS[Math.floor(rng() * DIRS.length)] ?? [0, 0];
    cur = { x: around.x + dx, y: around.y + dy };
  }
  return placed;
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
  for (const zone of ['A', 'B'] as const) {
    let left = counts[zone];
    let guard = 0;
    while (left > 0 && guard < 200) {
      guard += 1;
      const size = Math.min(left, 2 + Math.floor(rng() * 5));
      const placed = growBlob(c, rng, zoneOf, zone, terrain, size, blocked);
      if (placed === 0) break;
      left -= placed;
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
 * 把挡路的水/山凿开：水变成浅滩（平原），山开出隘口（丘陵）。
 *
 * mirror 为真时同步凿镜像格 —— 否则"完全对称"会被这一凿打破，
 * 而且凿完还得再对称一次，反而可能把刚开的路又堵回去。
 */
function carve(c: Ctx, path: Pos[], blocked: Set<number>, mirror = false, preserve?: Set<number>): void {
  const cut = (x: number, y: number) => {
    if (preserve?.has(y * c.w + x)) return;
    const t = at(c, x, y);
    if (t === 'water') put(c, x, y, 'plain');
    else if (t === 'mountain') put(c, x, y, 'hill');
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
  for (let dy = -1; dy <= 2; dy++) {
    for (let dx = -1; dx <= 2; dx++) {
      const x = city.x + dx;
      const y = city.y + dy;
      const t = at(c, x, y);
      if (t === undefined) continue;
      if (t === 'mountain') put(c, x, y, 'plain');
    }
  }
}

/**
 * 在城边开一小片水：湖泊或河湾。
 *
 * 目的很实际——水军只能在临水城市下水，如果地图上所有城都不挨水，
 * 那这一整类兵种就等于不存在。所以每座城有较大概率自带一片水面。
 */
function lakeNearCity(c: Ctx, city: Pos, rng: () => number): void {
  if (rng() > 0.8) return;

  const dirs = DIRS[Math.floor(rng() * DIRS.length)] ?? [0, 1];
  const [dx, dy] = dirs;
  // 从城墙上往外一格开始铺
  const startX = dx > 0 ? city.x + 2 : dx < 0 ? city.x - 1 : city.x + (rng() < 0.5 ? 0 : 1);
  const startY = dy > 0 ? city.y + 2 : dy < 0 ? city.y - 1 : city.y + (rng() < 0.5 ? 0 : 1);

  const size = 2 + Math.floor(rng() * 3);
  let cur = { x: startX, y: startY };
  for (let i = 0; i < size; i++) {
    const t = at(c, cur.x, cur.y);
    if (t === undefined) break;
    // 不覆盖城市格
    const inCity =
      cur.x >= city.x && cur.x <= city.x + 1 && cur.y >= city.y && cur.y <= city.y + 1;
    if (!inCity) put(c, cur.x, cur.y, 'water');

    // 顺着同一个方向延伸，偶尔横摆一格，长得像湖不像点
    const side = rng() < 0.3 ? (rng() < 0.5 ? 1 : -1) : 0;
    cur = {
      x: cur.x + dx + (dy === 0 ? 0 : side),
      y: cur.y + dy + (dx === 0 ? 0 : side),
    };
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
        const x = city.x + Math.floor(1) + dx;
        const y = city.y + Math.floor(1) + dy;
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
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

export function generateLayout(
  size: number,
  seed: number,
  unitPool: string[] = ['infantry', 'archer', 'cavalry', 'guard'],
  opts: MapOptions = {},
): MapLayout {
  const w = size;
  const h = size;
  const c: Ctx = { w, h, g: new Array<Terrain>(w * h).fill('plain') };

  const rngStyle = makeRng(seed * 2654435761 + size * 7919 + 11);
  const rngCity = makeRng(seed * 40503 + size * 7919 + 29);
  const rngTerrain = makeRng(seed * 22695477 + size * 3751 + 7);

  const symmetry: MapSymmetry = opts.symmetry ?? 'fair';
  let style = opts.style ?? 'random';
  if (style === 'random') {
    const bag: Array<Exclude<MapStyle, 'random'>> = [
      'river-h',
      'river-h',
      'river-v',
      'ridge',
      'ridge',
      'open',
    ];
    style = bag[Math.floor(rngStyle() * bag.length)] ?? 'river-h';
  }

  // 布局与河的走向解耦：同样是横河，也可能两边各占一对对角
  const layout: CityLayout = rngCity() < 0.5 ? 'split' : 'diagonal';
  const axis: 'h' | 'v' = style === 'river-v' ? 'v' : 'h';
  const plan = planCities(c, layout, axis, rngCity);
  // 镜像模式下 B 的城市必须是 A 的严格镜像，否则城郊清场、出生点都会错位，
  // "完全对称"就名不副实了。
  if (symmetry === 'mirror') {
    plan.B = plan.A.map((p) => mirrorBlock(p.x, p.y, 2, w, h));
  }
  const zoneOf = makeZoneOf(plan.A, plan.B);

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
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
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

  const ratio: Array<{ t: Terrain; r: number; blob: [number, number] }> = [
    { t: 'forest', r: style === 'open' ? 0.06 : 0.11, blob: [3, 7] },
    { t: 'hill', r: style === 'ridge' ? 0.13 : style === 'open' ? 0.05 : 0.08, blob: [2, 5] },
    { t: 'mountain', r: style === 'open' ? 0 : 0.03, blob: [2, 4] },
  ];

  for (const { t, r, blob } of ratio) {
    const n = Math.round(base * r);
    if (n <= 0) continue;
    scatterTerrain(c, rngTerrain, zoneOf, t, { A: n, B: n }, blocked);
    void blob;
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

  // ---- 连通性：A 主城能走到所有城 ----
  const isCity = (x: number, y: number) => cityCells.has(y * w + x);
  const anchorA = plan.A[0];
  if (anchorA) {
    for (const target of [...plan.A.slice(1), ...plan.B]) {
      // 从城边上出发（城格本身是 plain，可以直接当起点）
      const path = cheapestPath(
        c,
        { x: anchorA.x, y: anchorA.y + 1 },
        { x: target.x, y: target.y + 1 },
        isCity,
        fordless ? riverCells : undefined,
      );
      if (path) carve(c, path, blocked, symmetry === 'mirror', fordless ? riverCells : undefined);
    }
  }

  // ---- 城市周边清空 + 城边开一片水（给港口留位置） ----
  for (const p of plan.A) lakeNearCity(c, p, rngTerrain);
  for (const p of plan.B) lakeNearCity(c, p, rngTerrain);
  for (const p of [...plan.A, ...plan.B]) clearAroundCity(c, p);

  // 河/湖可能把城围成孤岛：城墙外一圈最多留两格水（留给港口），其余填平。
  // 不这么做会出现"城在水中央、上岸要绕半张图"的地图。
  for (const p of [...plan.A, ...plan.B]) {
    const ring: Array<{ x: number; y: number; d: number }> = [];
    for (let dy = -1; dy <= 2; dy++) {
      for (let dx = -1; dx <= 2; dx++) {
        const x = p.x + dx;
        const y = p.y + dy;
        const inCity = x >= p.x && x <= p.x + 1 && y >= p.y && y <= p.y + 1;
        if (inCity) continue;
        if (at(c, x, y) !== 'water') continue;
        ring.push({ x, y, d: Math.abs(dx - 0.5) + Math.abs(dy - 0.5) });
      }
    }
    // 离城心最近的两格留作港口，其它填平
    ring.sort((a, b) => a.d - b.d);
    for (const t of ring.slice(2)) put(c, t.x, t.y, 'plain');
  }
  symmetrize(); // 城郊处理也要对称，否则镜像模式会和"严格对称"对不上

  // 湖可能把城围住，重新对一次连通性
  if (anchorA) {
    for (const target of [...plan.A.slice(1), ...plan.B]) {
      const path = cheapestPath(
        c,
        { x: anchorA.x, y: anchorA.y + 1 },
        { x: target.x, y: target.y + 1 },
        isCity,
        fordless ? riverCells : undefined,
      );
      if (path) carve(c, path, blocked, symmetry === 'mirror', fordless ? riverCells : undefined);
    }
  }

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
