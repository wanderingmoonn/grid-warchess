/**
 * 肉鸽试玩版用的可复现随机数。
 *
 * 不复用核心里的 `nextRandom`：那是给规则层和生产器用的，参数是种子状态机，
 * 而肉鸽这边要的是"一局一个流"——同一颗种子必须重放出同一张房间图、
 * 同一批敌人、同一份商店货。所以这里自带一个极小的 mulberry32。
 */
export interface Rng {
  /** [0,1) */
  next(): number;
  /** [0,n) 的整数 */
  int(n: number): number;
  pick<T>(list: readonly T[]): T;
  /** 原地洗牌，返回同一个数组 */
  shuffle<T>(list: T[]): T[];
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => (n <= 0 ? 0 : Math.floor(next() * n));
  const pick = <T,>(list: readonly T[]): T => list[int(list.length)] as T;
  const shuffle = <T,>(list: T[]): T[] => {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = int(i + 1);
      const tmp = list[i] as T;
      list[i] = list[j] as T;
      list[j] = tmp;
    }
    return list;
  };
  return { next, int, pick, shuffle };
}

/** 从字符串/时间拿一颗种子（玩家不填种子时的兜底） */
export function randomSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}
