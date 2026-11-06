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

/**
 * 把几个整数混成一个种子：`hashSeed(seed, 'A')` 和 `hashSeed(seed,'B')` 必须不同。
 *
 * ── 这一版修的是什么（2026-11-05）──────────────────────────────────────
 *
 * 上一版是"逐字符 FNV + 每段一次乘法混合"，看着像样，但它有个要命的性质：
 * **两段同时 +1 会互相抵消**。
 *
 *   hashSeed(8400, 0, 'mode') === hashSeed(8401, 1, 'mode') === hashSeed(8402, 2, 'mode')
 *
 * 实测六组全等（1615128900）。在对手池里就是"六局抽到同一个对手"，
 * 而当时的写法正是 `hashSeed(SEED0 + g, g, 'mode')`——种子和局号一起加一，
 * 于是六局全是"打 AI"，自博弈一局没排上，我还以为是自己配比写错了。
 *
 * 现在每一段之后做一次完整的雪崩（xor-shift + 乘法），最后再把原始 seed
 * 混回去一次：这样"段被改了"和"seed 被改了"不会再互相抵消。
 */
export function hashSeed(seed: number, ...parts: Array<string | number>): number {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  for (const p of parts) {
    const str = String(p);
    for (let i = 0; i < str.length; i++) {
      h = (h ^ str.charCodeAt(i)) >>> 0;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    // 每一段之后强混一次，别让相邻段的变化在线性意义上抵消
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
  }
  // 收尾把 seed 再混一遍：前面用的是 seed 的初值，这里保证"seed 变了结果一定变"
  h = Math.imul(h ^ (seed >>> 0), 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
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
