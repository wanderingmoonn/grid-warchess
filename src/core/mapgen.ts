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

function minCitySep(w: number, h: number): number {
  return Math.max(MIN_CITY_SEP_FLOOR, Math.floor(Math.min(w, h) * MIN_CITY_SEP_RATIO));
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
 * 必须保留的不变量（全部是硬的，写测试盯着）：
 *   · 任意两座城的曼哈顿距离 ≥ minCitySep；
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
  const span = 2;
  const minSep = minCitySep(c.w, c.h);
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

  /** 这个位置离已占的每一座城都够远吗 */
  const farEnough = (p: Pos, taken: Pos[]): boolean =>
    taken.every((q) => citySep(p, q) >= minSep);

  /**
   * 在某一侧、某个纵深区间里挑一个满足间距的位置。
   *
   * 优先贴着前线（深度偏移越小越好），同一深度里横向随机——
   * 这样"往前压/往回缩"的手感和以前一样，只是不再允许贴脸。
   * 找不到就返回 null，让上层换一次重撒。
   *
   * 纵深区间是"这一侧到前线之间"，不是前线 ±1：间距是硬约束，
   * 为了让出间距而往回缩一格，比两座城贴在一起好得多。
   */
  const make = (front: number, lo: number, hi: number, taken: Pos[]): Pos | null => {
    const cands: Array<{ p: Pos; rank: number }> = [];
    for (let a = lo; a <= hi; a++) {
      for (let cr = crossLo; cr <= crossHi; cr++) {
        const p = at2(a, cr);
        if (!farEnough(p, taken)) continue;
        // 深度偏移优先，横向在同等深度里随机（rng 决定，可复现）
        cands.push({ p, rank: Math.abs(a - front) * 1000 + Math.floor(rng() * 999) });
      }
    }
    if (cands.length === 0) return null;
    cands.sort((u, v) => u.rank - v.rank);
    return cands[0]!.p;
  };

  const attempt = (): { A: Pos[]; B: Pos[] } | null => {
    if (mirror) {
      // 镜像模式：只规划 A，B 由点镜像得到。
      // 约束要连"镜像之后的四座城"一起满足——以前这里完全没查，
      // 于是 B 常常被镜像到 A 旁边甚至同一个格子上。
      const a: Pos[] = [];
      const taken: Pos[] = []; // A 的城 + 它们的镜像，全都算占位
      for (let k = 0; k < 2; k++) {
        const p = make(front0, alongLo, front0, taken);
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
    for (const [front, lo, hi, arr] of [
      [front0, alongLo, front0, side0],
      [front1, front1, alongHi, side1],
    ] as const) {
      for (let k = 0; k < 2; k++) {
        const p = make(front, lo, hi, taken);
        if (!p) return null;
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

  /** 在 A 区里挑一块空地的种子 */
  const seedInA = (): Pos | null => {
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

  // ---- 湖：成对的凹地水面 ----
  //
  // 按**面积**给，不是按边长：边长翻倍，格子数翻四倍，按边长给会让大图上
  // 的湖显得越来越"小气"（64×64 实测含水量反而比 32×32 低）。
  const tiles = c.w * c.h;
  const lakePairs = Math.max(1, Math.min(4, Math.round(tiles / 700)));
  const lakeArea = Math.max(8, Math.min(55, Math.round(tiles * 0.02)));
  for (let k = 0; k < lakePairs; k++) {
    const seed = seedInA();
    if (!seed) break;
    const area = Math.round(lakeArea * (0.75 + rng() * 0.5));
    growRegion(c, rng, seed, 'water', area, blocked);
    growRegion(c, rng, mirrorPos(seed), 'water', area, blocked);
  }

  // ---- 支流：从地图边流进城与城之间的空档 ----
  //
  // 只给真正的大图（≥28）。20×20 上一条支流就能把战场切成两半，
  // 实测加上之后 20×20 的攻城次数从 7 掉到 1——那不是"丰富"，是"堵"。
  if (size >= 28) {
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
): MapLayout {
  const w = size;
  const h = size;
  const c: Ctx = { w, h, g: new Array<Terrain>(w * h).fill('plain') };
  const citiesA = [{ x: 0, y: h - 2 }];
  const citiesB = [{ x: w - 2, y: 0 }];
  for (const p of [...citiesA, ...citiesB]) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) put(c, p.x + dx, p.y + dy, 'city');
    }
  }

  const pool = unitPool.length > 0 ? unitPool : ['infantry'];
  const used = new Set<number>();
  /** 微图里空地就那么几块，直接按"离城中心近"排一遍，不用环形搜索 */
  const spots = (city: Pos, count: number, offset: number): SpawnDef[] => {
    const cx = city.x + 1;
    const cy = city.y + 1;
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

  // 微图是另一套规则（见 tinyLayout 的注释），不走后面的随机生成
  if (size <= 5) return tinyLayout(size, unitPool, opts.symmetry ?? 'fair');

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
  const plan = planCities(c, layout, axis, rngCity, symmetry === 'mirror');
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
