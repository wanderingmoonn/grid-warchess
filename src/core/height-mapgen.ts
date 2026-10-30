/**
 * 等高线地形生成器（「地形高差」扩展自带）。
 *
 * 为什么不用本体那套"撒团块"：
 *
 *   撒团块 = 先随机挑几百个种子格，每个种子周围长一团同样的地形。
 *   结果是"一地同尺寸的斑点"——高原和低地一样碎，山和丘陵一样散，
 *   看不出地势的走向。真实地形不是这样的：山有山脚，坡有缓急，
 *   越往上是越小的同心环，也就是等高线。
 *
 * 这一版换成**连续高度场 + 阈值分层**：
 *
 *   1. 先算一个连续的海拔场 h(x,y) ∈ [0,1]：低频噪声打底 + 几座"山心"
 *      按距离衰减叠加（高斯状），相邻格的海拔不会突变；
 *   2. 再把 h 按一组阈值切成地形：>0.86 山峰、0.60~0.86 台地、
 *      0.42~0.60 丘陵、0.17~0.42 平原、<0.17 谷地。
 *   因为 h 连续，切出来的地形天然是**层层递进的环**：山心是尖的，
 *   外面一圈台地，再外面一圈丘陵，最后铺到平原上。
 *   这就是"等高线"在方格地图上的样子。
 *
 * 公平性：场只在一方（A 区）上算，B 区取 A 区的**点对称值**再加一点抖动。
 * 两侧地形数量因而几乎相同，走向互为镜像、细节各自不同——
 * 正好是"地势各异"那张图该有的样子。完全镜像模式由 mapgen 后面的
 * symmetrize 统一处理，这里不用管。
 */

import type { MapBuildCtx } from './mapgen.ts';
import type { Terrain } from './types.ts';

type Pos = { x: number; y: number };

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 平滑插值的值噪声：网格随机值 + 双线性 + smoothstep，边界回绕 */
function makeNoise(rng: () => number, gw: number, gh: number) {
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < grid.length; i += 1) grid[i] = rng();
  const wrap = (v: number, m: number): number => ((v % m) + m) % m;
  const at = (gx: number, gy: number): number => grid[wrap(gy, gh) * gw + wrap(gx, gw)] as number;
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  return (x: number, y: number): number => {
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const tx = smooth(x - fx);
    const ty = smooth(y - fy);
    const a = at(fx, fy);
    const b = at(fx + 1, fy);
    const c = at(fx, fy + 1);
    const d = at(fx + 1, fy + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
}

/** 地貌配方：一套数字生成一张图 */
interface Recipe {
  /** 基础海拔（整张图的"地面高度"） */
  base: number;
  /** 噪声振幅：大一点地形更破碎，小一点更像大块地势 */
  noise: number;
  /** 山体：每侧几座、半径（格）、加多高、陡峭度（越大越尖） */
  peaks: { count: number; radius: number; height: number; sharp: number };
  /**
   * 高度 → 地形 的阶梯，按阈值升序。
   *
   * 开了 `normalize` 时这些数字是**占比**（0.53 = 前 53% 的格子），
   * 关掉时是海拔。占比写法比海拔稳：同一套配方换个种子，
   * 地形比例不会从"三成台地"跳到"一成台地"。
   */
  ladder: Array<[number, Terrain]>;
  /** 噪声网格密度：越大特征越碎（群岛要碎，高原要整块） */
  grid: [number, number];
  /**
   * 是否把高度场按排名摊平（默认开）。
   *
   * 开了以后阶梯里的数字就是精确的占比，地形比例不再随种子漂。
   * 火山群是唯一关掉的：锥顶必须是火山口，那是"绝对高度"才能保证的事——
   * 按排名切的话，最高的那个锥子会吃掉全部的"火山口配额"，
   * 另一座锥子就变成平顶的了。
   */
  normalize?: boolean;
}

const RECIPES: Record<string, Recipe> = {
  // 高原：一两座又宽又缓的山，台地成片。山顶只留很小的突起，
  // 高山不可通行，多了会把整座山变成一块走不进去的疤。
  highland: {
    base: 0.26,
    noise: 0.1,
    peaks: { count: 2, radius: 0.28, height: 0.72, sharp: 2.2 },
    ladder: [
      [0.08, 'valley'],
      [0.53, 'plain'],
      [0.78, 'hill'],
      [0.96, 'plateau'],
      [1, 'mountain'],
    ],
    grid: [3, 3],
  },
  // 峡谷：沟底到图边抬升很快，河谷横截面就是"谷地→平原→丘陵→台地"四级
  canyon: {
    base: 0.16,
    noise: 0.1,
    peaks: { count: 0, radius: 0.3, height: 0, sharp: 2 },
    ladder: [
      [0.22, 'valley'],
      [0.55, 'plain'],
      [0.78, 'hill'],
      [0.96, 'plateau'],
      [1, 'mountain'],
    ],
    grid: [3, 3],
  },
  // 沼泽：几乎没有起伏，低处积水成塘、塘边是浅滩
  marsh: {
    base: 0.14,
    noise: 0.14,
    peaks: { count: 1, radius: 0.5, height: 0.26, sharp: 2 },
    ladder: [
      [0.12, 'water'],
      [0.24, 'shallow'],
      [0.66, 'marsh'],
      [0.96, 'plain'],
      [1, 'hill'],
    ],
    grid: [4, 4],
  },
  // 群岛：海拔直接取噪声本身（不是"山心 + 底座"），
  // 于是海岸线是自己长出来的锯齿，而不是一圈圆。阈值压在中位数以上，
  // 露出来的就是一堆大小不一的岛。
  isles: {
    base: 0,
    noise: 0.04,
    peaks: { count: 0, radius: 0.1, height: 0, sharp: 2 },
    ladder: [
      [0.42, 'water'],
      [0.54, 'shallow'],
      [0.8, 'plain'],
      [0.93, 'hill'],
      [0.99, 'plateau'],
      [1, 'mountain'],
    ],
    grid: [3, 3],
  },
  // 大川：起伏平缓的丘陵地，稍后在中线上开一条横贯全图的河
  river: {
    base: 0.34,
    noise: 0.1,
    peaks: { count: 1, radius: 0.34, height: 0.42, sharp: 2 },
    ladder: [
      [0.16, 'valley'],
      [0.6, 'plain'],
      [0.85, 'hill'],
      [0.97, 'plateau'],
      [1, 'mountain'],
    ],
    grid: [3, 3],
  },
};

/** 在 A 区里挑一处空地当山心（离城至少 4 格，城里不长山） */
function pickCenter(c: MapBuildCtx, avoid: Pos[]): Pos | null {
  for (let k = 0; k < 120; k += 1) {
    const x = Math.floor(c.rng() * c.w);
    const y = Math.floor(c.rng() * c.h);
    if (c.zoneOf(x, y) !== 'A') continue;
    if (c.blocked.has(y * c.w + x)) continue;
    let ok = true;
    for (const p of avoid) {
      if (Math.abs(p.x - x) + Math.abs(p.y - y) < 6) ok = false;
    }
    if (ok) return { x, y };
  }
  return null;
}

/**
 * 算海拔场。
 *
 * `kind` 决定山心的形状；`canyon` 与 `river` 另外把中线压下来。
 */
function buildField(c: MapBuildCtx, recipe: Recipe, kind: string): Float32Array {
  const { w, h } = c;
  const [gw, gh] = recipe.grid;
  const n1 = makeNoise(c.rng, gw, gh);
  const n2 = makeNoise(c.rng, gw * 2 + 1, gh * 2 + 1);
  // 噪声按"到棋盘中心的距离"取样：这样场本身对点对称，
  // 两侧天然同势，也不会在拼缝上出现一道硬边（第一版就是这里裂开的）。
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;

  // 山心：只在一侧挑，另一侧用镜像——这是"两侧同势"的来源
  const avoid: Pos[] = [...c.cities.A, ...c.cities.B];
  const centers: Array<Pos & { radius: number; height: number; sharp: number }> = [];
  const spread = Math.max(3, Math.round(Math.min(w, h) * recipe.peaks.radius));
  for (let k = 0; k < recipe.peaks.count; k += 1) {
    const p = pickCenter(c, avoid);
    if (!p) break;
    avoid.push(p);
    centers.push({ ...p, radius: spread, height: recipe.peaks.height, sharp: recipe.peaks.sharp });
    const m = c.mirror(p.x, p.y);
    if (m.x >= 0 && m.y >= 0 && m.x < w && m.y < h) {
      centers.push({ ...m, radius: spread, height: recipe.peaks.height, sharp: recipe.peaks.sharp });
    }
  }

  // 峡谷：沟沿着"两军之间那条中线"，离中线越远越高。
  // 走向要按"两方各在哪"判断，不能拿某一座城去比：城市是随机摆的，
  // 拿单城比会把横沟画成竖沟（第一版就这么错了）。
  const mean = (ps: Pos[], k: 'x' | 'y'): number =>
    ps.length === 0 ? 0 : ps.reduce((a, p) => a + p[k], 0) / ps.length;
  const midY = (mean(c.cities.A, 'y') + mean(c.cities.B, 'y')) / 2 + 1;
  const midX = (mean(c.cities.A, 'x') + mean(c.cities.B, 'x')) / 2 + 1;
  const sideDY = Math.abs(mean(c.cities.A, 'y') - mean(c.cities.B, 'y'));
  const sideDX = Math.abs(mean(c.cities.A, 'x') - mean(c.cities.B, 'x'));
  // 上下分开 → 沟沿东西向横穿（h）；左右分开 → 沟沿南北向纵贯（v）
  const canyonAxis: 'h' | 'v' = sideDY >= sideDX ? 'h' : 'v';
  const halfSpan = Math.max(2, Math.max(w, h) / 2);

  const field = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const u = (Math.abs(x - cx) / w) * gw * 2;
      const v = (Math.abs(y - cy) / h) * gh * 2;
      const s1 = n1(u, v);
      const s2 = n2(u * 2, v * 2);
      const wobble = (0.7 * (s1 - 0.5) + 0.3 * (s2 - 0.5)) * recipe.noise * 2;

      let val = recipe.base + wobble;

      if (kind === 'canyon') {
        // 一条深沟：沟底 0.16，往外沿线性抬高到 0.96（图边是台地/山壁）。
        // 抬升量按半幅归一化，这样 12×12 和 32×32 的峡谷横截面是同一种坡度，
        // 不会出现小图上全是山、大图上什么也没有。
        const d = canyonAxis === 'h' ? Math.abs(y + 0.5 - midY) : Math.abs(x + 0.5 - midX);
        val = 0.16 + (d / halfSpan) * 0.8 + wobble * 0.7;
      } else if (kind === 'isles') {
        // 海拔 = 噪声本身：海岸线就是噪声的等值线，所以是自然的锯齿。
        // 城下**不**垫高——垫高会把整张图的平均水位一起抬上去，海就没了；
        // 主城的落脚地由 hugLand 在切完地形之后补。
        val = 0.8 * s1 + 0.2 * s2 + wobble * 0.5;
      } else {
        for (const pk of centers) {
          const d = Math.hypot(x - pk.x, y - pk.y);
          val += pk.height * Math.exp(-Math.pow(d / pk.radius, pk.sharp));
        }
      }
      field[y * w + x] = clamp01(val);
    }
  }

  // 按排名把高度场摊平成 [0,1] 的均匀分布。
  //
  // 这一步是"配方可复用"的关键：噪声的均值随种子浮动（实测 0.5~0.6 都出现过），
  // 拿绝对阈值去切，"这一局的海占四成"下一局就变成"一成"。
  // 摊平之后阶梯里的数字就是**精确占比**，换个种子地形比例也不漂，
  // 而且摊平是单调变换——等高线的形状一点没变。
  if (recipe.normalize !== false) {
    const order = Array.from({ length: w * h }, (_, i) => i).sort(
      (a, b) => (field[a] ?? 0) - (field[b] ?? 0),
    );
    const last = Math.max(1, order.length - 1);
    for (let k = 0; k < order.length; k += 1) field[order[k]!] = k / last;
  }

  // 一侧给一点抖动：场本身已经对称，抖完是"同势而不同形"——
  // 数量几乎一样，走向对称，细节各自不同（这就是"地势各异"）。
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (c.zoneOf(x, y) !== 'B') continue;
      const i = y * w + x;
      field[i] = clamp01((field[i] ?? 0) + (c.rng() - 0.5) * 0.05);
    }
  }
  return field;
}

/** 按阶梯把海拔切成地形 */
function classify(recipe: Recipe, v: number): Terrain {
  for (const [upTo, t] of recipe.ladder) if (v < upTo) return t;
  return 'plain';
}

/**
 * 在大川地貌上开一条横贯全图的河。
 *
 * 河心是深水（`water`，只有水军能过），两岸是漫水滩（`shallow`，陆军能涉水）。
 * 关键在"浅滩成段出现"：沿河方向用一维噪声挑几处河段抬高河床，
 * 那里两岸连成浅滩，人可以徒涉；其余河段只有深水，要么架桥、要么坐船。
 * 这样"横跨整张图的水域"才不是一道形同虚设的水沟。
 */
function carveGreatRiver(c: MapBuildCtx): void {
  const { w, h } = c;
  const axisH = Math.abs(
    c.cities.A.reduce((a, p) => a + p.y, 0) / Math.max(1, c.cities.A.length) -
      c.cities.B.reduce((a, p) => a + p.y, 0) / Math.max(1, c.cities.B.length),
  ) >= Math.abs(
    c.cities.A.reduce((a, p) => a + p.x, 0) / Math.max(1, c.cities.A.length) -
      c.cities.B.reduce((a, p) => a + p.x, 0) / Math.max(1, c.cities.B.length),
  );

  const mid = axisH
    ? (c.cities.A.reduce((a, p) => a + p.y, 0) + c.cities.B.reduce((a, p) => a + p.y, 0)) /
        (c.cities.A.length + c.cities.B.length) +
      1
    : (c.cities.A.reduce((a, p) => a + p.x, 0) + c.cities.B.reduce((a, p) => a + p.x, 0)) /
        (c.cities.A.length + c.cities.B.length) +
      1;

  const along = axisH ? w : h;
  const wob = makeNoise(c.rng, Math.max(3, Math.round(along / 5)), 3);
  const shoal = makeNoise(c.rng, Math.max(4, Math.round(along / 4)), 5);

  const half = 1.1; // 河心半宽（格）
  for (let t = 0; t < along; t += 1) {
    // 河身蜿蜒 ±1.5 格
    const wobble = (wob(t / 5, 0.5) - 0.5) * 3;
    const centre = mid + wobble;
    // 这一段河床高不高：高的地方两岸连成浅滩
    const shallowHere = shoal(t / 4, 0.5) > 0.56;
    for (let d = -3; d <= 3; d += 1) {
      const x = axisH ? t : Math.round(centre + d);
      const y = axisH ? Math.round(centre + d) : t;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (c.blocked.has(y * w + x)) continue;
      const dist = Math.abs(d);
      if (dist <= half) {
        c.put(x, y, 'water');
      } else if (dist <= half + 1) {
        c.put(x, y, shallowHere ? 'shallow' : 'water');
      } else {
        // 河岸：水位线以上一格是谷地，形成"河谷"的横截面
        if (c.at(x, y) !== 'water') c.put(x, y, 'valley');
      }
    }
  }
}

/**
 * 群岛：用一条"浅滩带"把两岸的主城连起来。
 *
 * 不连的话，纯陆军开局会被困在自己的岛上（这游戏的水军要临水城市才造得出，
 * 而开局部队全是陆军）。用最小代价的路径找一条最省水的走法，
 * 把沿途的深水改成浅流——现实里就是"这里有一串沙洲，退潮能走过去"。
 */
function shoalBridge(c: MapBuildCtx, from: Pos, to: Pos): void {
  const { w, h } = c;
  const n = w * h;
  const cost = new Float32Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const start = from.y * w + from.x;
  const goal = to.y * w + to.x;
  cost[start] = 0;
  const queue: number[] = [start];
  const stepCost = (i: number): number => {
    const t = c.at(i % w, Math.floor(i / w));
    if (t === 'water') return 9; // 深水很贵，但允许穿——这叫"架不起桥也得能过去"
    if (t === 'shallow') return 2;
    if (t === 'mountain') return 12;
    return 1;
  };
  while (queue.length > 0) {
    let pick = 0;
    for (let k = 1; k < queue.length; k += 1) {
      if ((cost[queue[k]!] ?? 0) < (cost[queue[pick]!] ?? 0)) pick = k;
    }
    const cur = queue.splice(pick, 1)[0]!;
    if (done[cur]) continue;
    done[cur] = 1;
    if (cur === goal) break;
    const cx = cur % w;
    const cy = Math.floor(cur / w);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (done[ni]) continue;
      const nc = (cost[cur] ?? 0) + stepCost(ni);
      if (nc < (cost[ni] ?? Infinity)) {
        cost[ni] = nc;
        prev[ni] = cur;
        queue.push(ni);
      }
    }
  }
  // 回溯：沿途的深水改成浅流，高不可攀的地形放平（总得有条路）
  let cur = goal;
  let guard = 0;
  while (cur >= 0 && cur !== start && guard < n * 2) {
    guard += 1;
    const x = cur % w;
    const y = Math.floor(cur / w);
    if (!c.blocked.has(cur)) {
      const t = c.at(x, y);
      if (t === 'water') c.put(x, y, 'shallow');
      else if (t === 'mountain') c.put(x, y, 'hill');
    }
    cur = prev[cur] ?? -1;
  }
}

/**
 * 城下必须是陆地。
 *
 * 涉水的城生不出兵（出生点要挑空格，水格挑不出来），山顶的城走不出人。
 * 半径给到 2 而不是 1：群岛图上只清一圈的话，城是从水面里"抠"出来的一个方框，
 * 看着像贴图错误；清到 2 圈才像一个真的小岛。
 */
function hugLand(c: MapBuildCtx): void {
  const anchors = [...c.cities.A, ...c.cities.B];
  const bad = (t: Terrain | undefined): boolean =>
    t === 'water' || t === 'shallow' || t === 'mountain';
  for (const p of anchors) {
    const cx = p.x + (c.citySize - 1) / 2;
    const cy = p.y + (c.citySize - 1) / 2;
    for (let dy = -2; dy <= c.citySize + 1; dy += 1) {
      for (let dx = -2; dx <= c.citySize + 1; dx += 1) {
        const x = p.x + dx;
        const y = p.y + dy;
        if (x < 0 || y < 0 || x >= c.w || y >= c.h) continue;
        if (c.blocked.has(y * c.w + x)) continue;
        // 圆一点：斜角上离城心太远的格子不动，岛才不是方框
        if (Math.hypot(x + 0.5 - (cx + 0.5), y + 0.5 - (cy + 0.5)) > c.citySize + 1.6) continue;
        if (bad(c.at(x, y))) c.put(x, y, 'plain');
      }
    }
  }
}

/**
 * 主入口：按 `kind` 长一张等高线地形。
 *
 * `kind` 是地貌 id（highland / canyon / marsh / isles / river），
 * 前四个用 RECIPES 里的配方，`canyon` 走"沟"的形状，`river`/`isles` 再额外开河、搭沙洲。
 */
export function buildContour(c: MapBuildCtx, kind: string): void {
  const recipe = RECIPES[kind];
  if (!recipe) return;

  const field = buildField(c, recipe, kind);

  for (let y = 0; y < c.h; y += 1) {
    for (let x = 0; x < c.w; x += 1) {
      const i = y * c.w + x;
      if (c.blocked.has(i)) continue;
      c.put(x, y, classify(recipe, field[i] ?? 0));
    }
  }

  if (kind === 'river') carveGreatRiver(c);
  if (kind === 'isles') {
    const a = c.cities.A[0];
    const b = c.cities.B[0];
    if (a && b) shoalBridge(c, a, b);
  }

  // 林子：在平原上成团地长，别让整张图只有裸地
  const area = c.w * c.h;
  const clumps = Math.max(3, Math.round((area * 0.05) / 6));
  for (const zone of ['A', 'B'] as const) {
    for (let k = 0; k < clumps; k += 1) {
      const spot = c.pick(zone);
      if (!spot) break;
      c.grow(spot.x, spot.y, 'forest', 3 + Math.floor(c.rng() * 5));
    }
  }

  hugLand(c);
}
