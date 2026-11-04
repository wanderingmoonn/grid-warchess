/**
 * 训练与评估共用的伪随机数。
 *
 * 一处定义、三处用（采样、初始化、配局），而且必须是**可复现**的：
 * 同一颗种子跑两遍要出同一条轨迹，否则"这一版比上一版强"根本没法验。
 *
 * 用 mulberry32：32 位状态、单次几纳秒、分布够好。不用 Math.random 是因为
 * 它没法设种子；不用 crypto 是因为要跑几百万次。
 */
export function mulberry32(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把几个整数混成一个种子：`hashSeed(seed, 'A')` 和 `hashSeed(seed,'B')` 必须不同 */
export function hashSeed(seed: number, ...parts: Array<string | number>): number {
  let h = seed >>> 0 || 1;
  for (const p of parts) {
    const str = String(p);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
  }
  return h >>> 0;
}

/** 标准正态：Box–Muller。只给权重初始化用，不在热路径上 */
export function gauss(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 均匀分布 [lo, hi) */
export const uniform = (rand: () => number, lo: number, hi: number): number => lo + (hi - lo) * rand();
