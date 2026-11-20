/**
 * 经济求解器（离线）：给一组参数，算"到第 N 代最快/最强"该怎么投。
 *
 * ── 它回答什么 ──────────────────────────────────────────────
 *
 * AI 现在是"每回合 argmax 买最值的兵"，于是钱全变成兵，永远升不到 5 代
 * （实测 12×12 上 60 回合还停在 2 代，对面 3 代）。人类反过来：先铺经济，
 * 到某个"决战时代"再暴兵。
 *
 * 这个脚本不碰 AI，只做算术：同一组开局条件下，
 *
 *   · 死不投经济（全靠城产）
 *   · 按"回本期"贪心投
 *   · 投到固定 N 个再停
 *
 * 分别要几回合到目标时代、到那时每回合收入多少。
 *
 * ── 三个容易算错的地方（都是踩过的坑）──
 *
 * 1. **回本期 = 成本 ÷ 产出 + 走过去的时间**。
 *    单位不是当天就位：它要从城里走到产地上，那一轮收入是 0。
 *    见 `docs/ANALYSIS-QUARTERMASTER-2026-11-11.md`："需要走路的单位
 *    第一轮收入是 0，正好慢一轮"。
 *
 * 2. **回本期是时代的函数**。解锁中间时代会带来更便宜/产出更高的经济单位，
 *    所以不能"一次算完"——每升一代要重算。
 *
 * 3. **名额是和兵共享的**。`maxRecruit` 是每回合**总共**几个，
 *    投经济就等于这段时间少造兵。所以"先经济"不是免费的。
 *
 * 用法：
 *   npm run solve:economy -- --era 5
 *   npm run solve:economy -- --era 3 --income 14 --gold 60 --walk 2
 */
// @ts-nocheck
import { ERAS } from '../src/core/config.ts';

const args = process.argv.slice(2);
const argOf = (n: string, d: string): string => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

/** 目标时代（1~7） */
const TARGET = Number(argOf('era', '5'));
/** 城市基础收入（每回合金） */
const CITY_INC = Number(argOf('income', '20'));
/** 开局金币 */
const GOLD0 = Number(argOf('gold', '100'));
/** 新经济单位走到产地要几回合（0 = 城里就能产） */
const WALK = Number(argOf('walk', '1'));
/** 每回合产兵名额（和兵共享） */
const SLOTS = Number(argOf('slots', '2'));
/** 一个经济单位的造价与产出（取平原值） */
const ECON_COST = Number(argOf('cost', '45'));
/**
 * 产地的产出阶梯：**地块是有限的**，第 N 个农民站的地越来越差。
 *
 * 这是"最优解"能被算出来的关键——边际回本递增，所以存在一个"再投不划算"的点。
 * 默认按一张 24×24 图的城市周边估：平原 6 块（7/回合）、森林与丘陵 8 块（3~4）、
 * 再往后只剩 1~2。
 */
const TIER = {
  good: Number(argOf('good', '6')),
  ok: Number(argOf('ok', '8')),
  poor: Number(argOf('poor', '6')),
};
/** 第 i 个（从 0 起）经济单位能站到的产出 */
function yieldAt(i: number): number {
  if (i < TIER.good) return Number(argOf('yield', '7'));
  if (i < TIER.good + TIER.ok) return 4;
  return 2;
}

/** 每升到一代要多少钱（index = 从第几代升上去） */
function eraCosts(to: number): number[] {
  const out: number[] = [];
  for (let e = 1; e < to; e += 1) out.push(ERAS[e]?.upgradeCost ?? 0);
  return out;
}

/**
 * 一个策略：每回合怎么分名额。
 *
 * `econCap` = 最多投几个经济单位（Infinity = 按回本期贪心）。
 */
function simulate(econCap: number): {
  turns: number;
  income: number;
  econ: number;
  eras: number[];
} {
  const costs = eraCosts(TARGET);
  let gold = GOLD0;
  let income = CITY_INC;
  let era = 1;
  let econ = 0;
  const eraTurns: number[] = [];
  /** 还没到岗的经济单位：到岗回合 + 它会站在哪一档地上 */
  const pending: Array<{ t: number; y: number }> = [];
  for (let t = 1; t <= 400; t += 1) {
    // ① 先考虑升代：攒够了就升（升代本身也抬高产能，晚升没有好处）
    const nextCost = costs[era - 1];
    if (nextCost !== undefined && gold >= nextCost) {
      gold -= nextCost;
      era += 1;
      eraTurns.push(t);
      if (era >= TARGET) return { turns: t, income, econ, eras: eraTurns };
    }
    // ② 再决定这一回合的名额怎么花
    const payback = ECON_COST / yieldAt(econ) + WALK;
    const remaining = costs.slice(era - 1).reduce((n, x) => n + x, 0);
    const turnsLeft = remaining <= 0 ? 0 : (remaining - gold) / Math.max(1, income);
    let bought = 0;
    while (bought < SLOTS && econ < econCap && gold >= ECON_COST) {
      // 回本期比"剩下的路"还长，就不值得投
      if (payback > turnsLeft) break;
      gold -= ECON_COST;
      econ += 1;
      bought += 1;
    }
    // ③ 新买的单位 WALK 回合后才到岗，到岗那一刻才开始产钱。
    //    **这一步就是"回本要算走路"的落点**：走路期间占着钱、不产钱。
    for (let i = 0; i < bought; i += 1) pending.push({ t: t + WALK, y: yieldAt(econ - bought + i) });
    while (pending.length > 0 && pending[0].t <= t) {
      const arrived = pending.shift()!;
      income += arrived.y;
    }
    gold += income;
  }
  return { turns: Infinity, income, econ, eras: eraTurns };
}

const costs = eraCosts(TARGET);
console.log(`目标：第 ${TARGET} 代（需 ${costs.reduce((n, x) => n + x, 0)} 金，分 ${costs.length} 段）`);
console.log(
  `开局：${GOLD0} 金 / 城市 ${CITY_INC} 金每回合 / 名额 ${SLOTS} / 经济单位 ${ECON_COST} 金，走路 ${WALK} 回合 / 好地 ${TIER.good} 块`,
);
console.log(`回本期：好地 ${(ECON_COST / yieldAt(0) + WALK).toFixed(1)} 回合 · 差地 ${(ECON_COST / yieldAt(99) + WALK).toFixed(1)} 回合（含走路）\n`);

const rows: Array<[string, ReturnType<typeof simulate>]> = [
  ['不投经济', simulate(0)],
  ['投 1 个', simulate(1)],
  ['投 3 个', simulate(3)],
  ['投 5 个', simulate(5)],
  ['贪心（回本期允许就一直投）', simulate(Infinity)],
];

console.log('策略                          到目标时代   终局收入   经济单位');
for (const [name, r] of rows) {
  const t = r.turns === Infinity ? '到不了' : `${r.turns} 回合`;
  console.log(`${name.padEnd(28, '　')} ${String(t).padStart(8)} ${String(Math.round(r.income)).padStart(9)} ${String(r.econ).padStart(9)}`);
}

/* 分代看：每升一代各花了几回合 */
const greedy = simulate(Infinity);
console.log(`\n贪心策略的分代节奏：${greedy.eras.map((t, i) => `${i + 2}代@${t}`).join(' · ')}`);
