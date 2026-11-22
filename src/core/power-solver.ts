/**
 * 战力求解器：给定"每回合收入 / 产兵格子 / 能买什么"，
 * 算**到第 T 回合最多能有多少战力**。
 *
 * ── 和 `solve-economy` 的分工 ────────────────────────────────
 *
 * `scripts/solve-economy.ts` 回答"最快几回合到第 N 代"（目标是**时代**）。
 * 这里回答"到第 T 回合战力最大是多少"（目标是**战力**）。
 * 两者共用同一套假设：收入逐回合到账、名额和格子有限、经济单位提升后续收入。
 *
 * 为什么战力需要单独求解：同样一袋钱，买 5 个民兵和 1 个坦克产出的战力不同，
 * 而"先投经济再暴兵"的收益又取决于还剩多少回合。这三件事必须一起算，
 * 拍一个"每回合能产多少战力"的常数是不够的（S4b 的 `powerPerTurn` 就是这么被
 * 校准出来的：现状战力 50% 命中，产能投影 88%，但产能本身还是拍的）。
 *
 * ── 模型（刻意简单，能解释）────────────────────────────────────
 *
 *   · 每回合先收钱，再花名额买（先经济后兵，由 `econUntil` 决定投到第几回合）；
 *   · 经济单位即时开始产出（不建模"走过去的一回合"，见文档里的已知偏差）；
 *   · 兵买了就永久计入战力（不建模战损）；
 *   · 时代是给定的，不建模升代——升代归"发展"计划，不在这里算两次。
 *
 * 搜索空间就是"投经济投到第几回合"（0~T），逐个模拟取最优。O(T²·名额)。
 */

export interface PowerUnit {
  id: string;
  price: number;
  power: number;
}

export interface PowerEcon {
  id: string;
  price: number;
  /** 每回合能多产多少金（**期望**地块产出，不是最好地形） */
  income: number;
  /**
   * 买完之后要走几回合才到位。不到位的那几回合收入是 0。
   *
   * 不建模这个的话，求解器会以为"买了立刻多 7 金/回合"，
   * 从而高估经济回本速度、系统性偏向投资经济。
   */
  walkTurns?: number;
}

export interface PowerInput {
  gold: number;
  /** 每回合金币收入 */
  income: number;
  /** 每回合能出几个兵（产兵格子数） */
  slots: number;
  /** 经济单位最多还能补几个（地形/建筑有限） */
  econRoom: number;
  units: PowerUnit[];
  econ: PowerEcon[];
}

export interface PowerPlan {
  /** 到第 T 回合的**增量**战力（不含现有部队） */
  power: number;
  /** 投经济投到第几回合（0 = 一上来就暴兵） */
  econUntil: number;
  /** 一共买了几个经济单位 */
  econ: number;
  /** 买了几件兵 */
  units: number;
  note: string;
}

/**
 * 这一回合买哪个兵：**看瓶颈是钱还是名额**。
 *
 * 以前永远取"每金战力最高"（于是永远是民兵）。这在"钱是瓶颈"时是对的，
 * 但收入一旦超过"名额 × 最便宜兵价"，瓶颈就变成产兵格——这时候该买的是
 * **每名额战力最高**的强兵，而不是继续堆民兵。
 *
 * 为什么这件事影响经济判断：如果钱多了只能换民兵，"投经济"的收益就被严重低估
 * （多 100 金/回合 = 4 个民兵/回合，但名额只有 3 个，等于白赚）。
 * 实测（2026-11-22）：修之前 `econUntil` 在任何局面都是 0。
 */
function pickUnit(input: PowerInput, gold: number): PowerUnit | null {
  const priced = input.units.filter((u) => u.price > 0 && u.power > 0);
  if (priced.length === 0) return null;
  const cheapest = Math.min(...priced.map((u) => u.price));
  // 每回合收入够买满所有名额 → 名额是瓶颈 → 选"每名额战力最高"
  const slotBound = input.slots > 0 && input.income >= input.slots * cheapest;
  const affordable = priced.filter((u) => u.price <= gold);
  if (affordable.length === 0) return null;
  let best: PowerUnit | null = null;
  let bestScore = -1;
  for (const u of affordable) {
    const score = slotBound ? u.power : u.power / u.price;
    if (score > bestScore) {
      bestScore = score;
      best = u;
    }
  }
  return best;
}

/**
 * 这一回合买哪个经济单位：**买得起**的里面选"每金收入最高"。
 *
 * 以前是全局选一次（不看钱）。开局只有 485 金、没按时代过滤时，全局最优是
 * 260 金的种植公司——买两个就没钱了，之后所有 k>1 的策略都变成"空名额"，
 * 于是 `econUntil` 恒为 0。买不起就该退回便宜的农民，而不是放弃投资。
 */
function pickEcon(input: PowerInput, gold: number): PowerEcon | null {
  let best: PowerEcon | null = null;
  let bestEff = -1;
  for (const e of input.econ) {
    if (e.price <= 0 || e.income <= 0) continue;
    if (e.price > gold) continue;
    const eff = e.income / e.price;
    if (eff > bestEff) {
      bestEff = eff;
      best = e;
    }
  }
  return best;
}

/**
 * 窗口结束后的"残值"：经济单位还会继续产金 R 回合。
 *
 * 没有这一项时，`simulate` 在窗口结束时把经济单位的未来产出当 0，
 * 于是"回本 9 回合 > 窗口 6~7"永远成立——求解器在任何中小图上都说"别投"。
 * 人类造农民不是"决战前回本"，是"以后一直产金"，所以给窗口后的 R 回合算钱。
 *
 * R 是拍的：8 回合 ≈ 一代兵的寿命。R 越大越敢投，越小越保守。
 */
const ECON_TAIL_TURNS = 4;

/**
 * 一条固定策略：前 `econUntil` 回合优先补经济，之后全买兵。
 *
 * 每个名额的处理顺序：还有额度且有钱就买经济，否则买兵。
 * 两个都买不起就空转（不借钱、不预支）。
 */
function simulate(input: PowerInput, turns: number, econUntil: number): PowerPlan {

  let gold = input.gold;
  let income = input.income;
  let power = 0;
  let econCount = 0;
  let unitCount = 0;
  /** 还没到位的经济单位：到 `at` 那一回合才开始产出 */
  const arrivals: Array<{ at: number; inc: number }> = [];

  for (let t = 0; t < turns; t += 1) {
    for (let i = arrivals.length - 1; i >= 0; i -= 1) {
      if (arrivals[i]!.at <= t) {
        income += arrivals[i]!.inc;
        arrivals.splice(i, 1);
      }
    }
    gold += income;
    for (let slot = 0; slot < Math.max(0, input.slots); slot += 1) {
      const econ = t < econUntil ? pickEcon(input, gold) : null;
      if (econ && econCount < input.econRoom) {
        gold -= econ.price;
        econCount += 1;
        // 收入不是当场到账：记一笔"第几回合开始产出"，到点了再加
        arrivals.push({ at: t + Math.max(1, Math.floor(econ.walkTurns ?? 1)), inc: econ.income });
        continue;
      }
      const unit = pickUnit(input, gold);
      if (unit) {
        gold -= unit.price;
        power += unit.power;
        unitCount += 1;
      }
    }
  }
  /*
   * 残值：窗口结束后，已到位的经济单位还有 `ECON_TAIL_TURNS` 回合的产出。
   * 折成战力用"每金战力"（和买兵同一把尺子），这样"投经济"和"买兵"可比。
   */
  let residualPower = 0;
  const econIncome = income - input.income;
  if (econCount > 0 && econIncome > 0) {
    let bestPerGold = 0;
    for (const u of input.units) {
      if (u.price <= 0 || u.power <= 0) continue;
      const per = u.power / u.price;
      if (per > bestPerGold) bestPerGold = per;
    }
    if (bestPerGold > 0) residualPower = econIncome * ECON_TAIL_TURNS * bestPerGold;
  }

  return {
    power: power + residualPower,
    econUntil,
    econ: econCount,
    units: unitCount,
    note: econUntil === 0 ? '一上来就暴兵' : `先投经济 ${econUntil} 回合，再暴兵`,
  };
}

/**
 * 到第 `turns` 回合能攒出的最大增量战力。
 *
 * 返回里带"投经济投到第几回合"，是因为这个数本身就是决策：
 * 人也是这么想的——"还能打几个回合？够不够回本？"
 */
/**
 * 只读：把每个 k 的结果都列出来（k = "前 k 回合优先买经济"）。
 *
 * 给诊断用。`solvePower` 只返回最优那一条，"为什么它认为不划算"必须看到
 * 所有候选的 power 才能回答——否则只能猜。
 */
export function planCandidates(input: PowerInput, turns: number): PowerPlan[] {
  const span = Math.max(0, Math.floor(turns));
  const out: PowerPlan[] = [];
  for (let k = 0; k <= span; k += 1) out.push(simulate(input, span, k));
  return out;
}

export function solvePower(input: PowerInput, turns: number): PowerPlan {
  const span = Math.max(0, Math.floor(turns));
  if (span === 0) return { power: 0, econUntil: 0, econ: 0, units: 0, note: '不投了' };
  let best: PowerPlan | null = null;
  for (let k = 0; k <= span; k += 1) {
    const p = simulate(input, span, k);
    if (!best || p.power > best.power) best = p;
  }
  return best ?? { power: 0, econUntil: 0, econ: 0, units: 0, note: '无解' };
}
