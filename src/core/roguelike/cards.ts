/**
 * 兵种卡：三张同名合成一级（2026-11-19 定）。
 *
 * 为什么是"三张"而不是像杀戮尖塔那样"两张同名升级"：这套游戏里一张卡的
 * 效果是**整个兵种变强**（不是多一张手牌），所以三张才够一次质变。
 */

/** 抽到几张算一级 */
export const CARDS_PER_LEVEL = 3;

/** 已抽张数 → 卡等级（0 张 = 0 级；1~2 张仍是 0 级，3 张 = 1 级） */
export function cardLevel(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.floor(count / CARDS_PER_LEVEL);
}

/** 还差几张升级（0 = 已经是整数级，不用再抽） */
export function cardsToNext(count: number): number {
  const n = Number.isFinite(count) && count > 0 ? count : 0;
  return CARDS_PER_LEVEL - (n % CARDS_PER_LEVEL);
}

/**
 * 抽卡用的确定性随机（mulberry32）。
 *
 * 必须是"同一 seed 同一结果"：重开本关要能重放同一组三选一，
 * 不然玩家会拿"刷奖励"当最优解。
 */
export function rngFrom(seed: number): () => number {
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
 * 从一整张卡池里抽 n 个互不相同的候选。
 *
 * 已拥有 2 张的卡**优先出现**（差一张就升级的那种），这是肉鸽的"临门一脚"
 * 体验：玩家总能看到"再来一张就成"的选项。
 */
export function drawCards(
  pool: readonly string[],
  owned: Record<string, number>,
  seed: number,
  n = 3,
): string[] {
  const rnd = rngFrom(seed);
  const nearUpgrade = pool.filter((id) => (owned[id] ?? 0) % CARDS_PER_LEVEL === CARDS_PER_LEVEL - 1);
  const rest = pool.filter((id) => !nearUpgrade.includes(id));

  const shuffle = (list: string[]): string[] => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = a[i]!;
      a[i] = a[j]!;
      a[j] = tmp;
    }
    return a;
  };

  const out: string[] = [];
  // 最多让一张"差一张升级"的卡进候选，避免三选一全是同质项
  const nearPick = shuffle(nearUpgrade)[0];
  if (nearPick) out.push(nearPick);
  for (const id of shuffle(rest)) {
    if (out.length >= n) break;
    if (!out.includes(id)) out.push(id);
  }
  return out.slice(0, n);
}
