/**
 * 种子化伪随机数。
 *
 * 为什么不用 Math.random：
 *   一旦规则核心里有不可复现的随机，回放会飘、联机会不同步、
 *   测试会随机失败。所有随机都必须由 state.seed 派生，
 *   并且把新的 seed 写回 state。
 */

/** mulberry32：32 位种子，分布够用，实现只有五行 */
export function nextRandom(seed: number): { value: number; seed: number } {
  let a = (seed + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, seed: a };
}

/** 取 [min, max] 的整数，同时推进种子 */
export function nextInt(seed: number, min: number, max: number): { value: number; seed: number } {
  const r = nextRandom(seed);
  return { value: min + Math.floor(r.value * (max - min + 1)), seed: r.seed };
}
