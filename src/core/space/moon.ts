/**
 * 月球图 —— 多棋盘玩法里第一张**非地球**的图。
 *
 * 规则上它只是一张普通的棋盘：同样的格、同样的单位、同样的战斗。
 * 区别全在地形（月壤 / 环形山）和"没有城市"——月球上不放城，
 * 所以城市的产兵、升级、胜负判定一行都不用改。
 *
 * ── 尺寸 ────────────────────────────────────────────────
 *
 * 比地球**略小**：地球那张图有时 12×12、有时 64×64，月球按比例跟着缩，
 * 但有个下限 4×4——再小就摆不下着陆区和一支小队了。
 *
 * 为什么按比例而不是固定值：月球是"第二战场"，它的尺度应该和主战场匹配；
 * 固定 16×16 在 8×8 的小图上会比地球还大，在 64×64 上又小得像个角落。
 *
 * ── 确定性 ──────────────────────────────────────────────
 *
 * 只用整数散列 + 取模，不碰 `Math.random`：同一个种子生成的月球一模一样，
 * 存档、回放、联机才能对齐。
 */

import type { Board, Terrain, Tile } from '../types.ts';
import { SPACE_HAZARD } from './space-hazard.ts';

/**
 * 月球图的 id。
 *
 * 从 `silo.ts` 搬过来的：月球是**月球自己的事**，不该由发射井定义。
 * 发射井改造之后连"月球"这个词都不该知道——它只负责把货送上某条航道。
 * 写进存档，改它等于让老存档丢图。
 */
export const MOON_BOARD = 'moon';

/** 月球最小边长。再小就放不下着陆区（第 5 步会用到中间那几格） */
export const MOON_MIN_SIZE = 4;

/** 月球相对地球的比例。0.75 是"略小"——肉眼看得出来，但不至于像另一张地图 */
export const MOON_SIZE_RATIO = 0.75;

/**
 * 月球该多大：按地球边长等比缩，四舍五入，下限 4。
 *
 * 4→4、5→4、12→9、16→12、32→24、64→48。
 */
export function moonSizeFor(earthSize: number): number {
  const n = Number.isFinite(earthSize) ? Math.floor(earthSize) : MOON_MIN_SIZE;
  return Math.max(MOON_MIN_SIZE, Math.round(n * MOON_SIZE_RATIO));
}

/**
 * 小型确定性随机（mulberry32）。
 *
 * 不复用 `mapgen` 里的 `makeRng`：那是地图生成器的内部函数，没导出；
 * 而且月球只需要"同种子同结果"，不需要和地球共用同一条随机流。
 */
function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成月球。
 *
 * 底子全是月壤，往上撒若干个环形山（半径 1~2 的圆）。撒的数量随图变大，
 * 但小图上会收敛到 1——4×4 上撒两个半径 2 的坑就没有落脚的地方了。
 */
export function createMoonBoard(earthSize: number, seed: number): Board {
  const n = moonSizeFor(earthSize);
  const tiles: Tile[] = Array.from({ length: n * n }, () => ({
    terrain: 'regolith' as Terrain,
    cityId: null,
  }));

  const rng = rngOf((seed ^ 0x9e3779b9) >>> 0);
  const craters = Math.max(2, Math.round(n / 4));
  /*
   * 撒坑的方式：把图切成 k×k 个宫格，每格放一个。
   *
   * 纯随机撒会扎堆——实测 12×12 上三个坑全挤在右下角，其余地方一片空白，
   * 看起来不像月球、也少了"该占哪个坑"的选择。分宫格之后再抖动一下位置，
   * 既铺得开，又不呆板。
   */
  const cols = Math.max(1, Math.ceil(Math.sqrt(craters)));
  const span = Math.max(1, n - 2);
  const cell = span / cols;

  for (let k = 0; k < craters; k++) {
    const gx = k % cols;
    const gy = Math.floor(k / cols);
    const cx = Math.min(n - 2, 1 + Math.floor((gx + rng()) * cell));
    const cy = Math.min(n - 2, 1 + Math.floor((gy + rng()) * cell));
    const r = rng() < 0.3 && n >= 8 ? 2 : 1;
    // 小图只给最小的坑：4×4 上半径 2 的坑会把整张图吃掉
    const radius = n < 8 ? 1 : r;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > radius * radius + radius * 0.5) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        tiles[y * n + x]!.terrain = 'crater';
      }
    }
  }

  /*
   * 兜底：环形山最多占六成。
   *
   * 小图 + 运气不好时，两个坑能连成一片，整张月球只剩环形山——地形全一样
   * 就没有"该站哪儿"的决策了。超了就把一部分改回月壤（从中心往外退），
   * 保证边缘至少有一圈平地可以落脚。
   */
  const maxCrater = Math.floor(n * n * 0.6);
  let craterCount = tiles.reduce((acc, t) => acc + (t.terrain === 'crater' ? 1 : 0), 0);
  if (craterCount > maxCrater) {
    /*
     * 从中心开始退：中心是将来着陆区的位置，必须能站人。
     * 从中心往外一圈圈退，直到降到上限。
     */
    const cx = (n - 1) / 2;
    const cy = (n - 1) / 2;
    const order = tiles
      .map((_, i) => i)
      .sort((a, b) => {
        const ax = a % n;
        const ay = Math.floor(a / n);
        const bx = b % n;
        const by = Math.floor(b / n);
        const da = (ax - cx) ** 2 + (ay - cy) ** 2;
        const db = (bx - cx) ** 2 + (by - cy) ** 2;
        return da - db;
      });
    for (const i of order) {
      if (craterCount <= maxCrater) break;
      if (tiles[i]!.terrain !== 'crater') continue;
      tiles[i]!.terrain = 'regolith';
      craterCount--;
    }
  }

  return {
    id: 'moon',
    kind: 'planet',
    name: '月球',
    w: n,
    h: n,
    tiles,
    // 没有大气、没有重力：进入这张图的单位统一背「恶劣外空环境」
    hazard: SPACE_HAZARD,
  };
}
