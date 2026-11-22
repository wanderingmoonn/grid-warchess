/**
 * 战力估值（S4，只算不用）。
 *
 * ── 为什么要有它 ──────────────────────────────────────────────
 *
 * 现在 AI 判断"能不能打"只看两样：兵数、身价（造价的简单加总）。
 * 这两个数都不回答"打不打得动"——
 *   · 24 个弓箭手和 24 个重骑在造价上可能差不多，战力差一倍；
 *   · 兵数相同，一边全是残血，另一边满血；
 *   · 城防厚的时候，"人多"根本换不来输出。
 *
 * 所以这里给三个数：**部队战力**（用于比大小）、**攻城输出**（一回合能砸掉
 * 多少城防）、**破城回合数**（输出 ÷ 城血）。这三个是"该不该打"的地基。
 *
 * ── 为什么不自己发明一套战力 ──────────────────────────────────
 *
 * `unit-value.ts` 已经有一套 Lanchester 估值（`unitPower`），采购、换血、
 * 结算全在用。这里**只乘一个血量系数**，不另立一套尺子——
 * 两套尺子必然对不齐，而且没人说得清"为什么这个兵是 7 分"。
 *
 * ── 边界（第一版，都待校准）────────────────────────────────────
 *
 *   · 不算地形加成、不算护甲减伤、不算技能与光环；
 *   · `unitPower` 用中性上下文（不看防守/压上倾向）；
 *   · 攻城输出只算"这一回合够得着的"，不含下回合能走到的。
 *
 * 这些都不是"漏了"，是刻意留的：先把量级跑通，再按实测补。
 * 见 `docs/PLAN-AI-V3-2026-11-21.md` 的 S4 与第二十节。
 */
import { solvePower } from './power-solver.ts';
import type { PowerEcon, PowerInput, PowerPlan, PowerUnit } from './power-solver.ts';
import { isProducer } from './produce.ts';
import { incomeOf, recruitSpawnCells } from './rules.ts';
import {
  damageToCity,
  distToCity,
  effectiveRangeAgainst,
  isArmed,
  tileAt,
  unitsOf,
  utype,
} from './rules.ts';
import { unitPower } from './unit-value.ts';
import type { City, GameState, PlayerId, Unit } from './types.ts';

/** 一个单位的战力：面板战力 × 剩余血量比例（残血按比例打折） */
export function unitStrength(s: GameState, u: Unit): number {
  const def = utype(s, u.type);
  if (def.category !== 'combat') return 0;
  const hpRatio = Math.max(0, Math.min(1, u.hp / Math.max(1, def.maxHp)));
  return unitPower(def) * hpRatio;
}

/** 一支部队的战力（建筑、工人不算） */
export function armyStrength(s: GameState, me: PlayerId): number {
  let total = 0;
  for (const u of unitsOf(s, me)) total += unitStrength(s, u);
  return total;
}

/**
 * 战力比：我方 ÷ 敌方（多个对手时按总额算）。
 *
 * 敌人在迷雾里看不见时 `foe` 会偏小——这不是 bug，是"只知道自己看得见的"。
 * 用它做判决时要记得这一点（要么保守取 1，要么等侦察）。
 */
export function strengthRatio(s: GameState, me: PlayerId): number {
  const mine = armyStrength(s, me);
  let foe = 0;
  // 按**单位**算而不是按城算：无城席位的散兵也要计入（它照样能打人）
  for (const u of s.units) if (u.owner !== me) foe += unitStrength(s, u);
  return mine / Math.max(1, foe);
}

/**
 * 这一回合能砸到这座城的输出（城防伤害/回合）。
 *
 * 只算**已经在射程内**的单位。为什么不把"下回合能走到的"也算上：
 * 那会把"潜力"混进"当下"，而这道数最常用的场景是"这回合打不打得动"。
 * 真要评估"再等一回合"，用 `siegeOutputAt` 自己传移动后的位置。
 */
export function siegeOutput(s: GameState, me: PlayerId, city: City): number {
  const tile = tileAt(s, city.x, city.y);
  let total = 0;
  for (const u of unitsOf(s, me)) {
    const def = utype(s, u.type);
    if (def.category !== 'combat') continue;
    if (!isArmed(s, u)) continue;
    const range = effectiveRangeAgainst(s, u, tile);
    if (distToCity(u, city) > range) continue;
    total += Math.max(0, damageToCity(u, city, s));
  }
  return total;
}

/**
 * 按现在的输出，砸开这座城要几回合（Infinity = 砸不动）。
 *
 * 这是"该不该打"最直接的那个数：值 ≤ 3 才算"打得动"。
 * 注意它不含对手的修补/反击，只是"静态算术"——所以只能当**下界**用。
 */
export function turnsToRaze(s: GameState, me: PlayerId, city: City): number {
  const out = siegeOutput(s, me, city);
  if (out <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.ceil(city.hp / out));
}

/**
 * 整场"能不能推过去"的粗判：战力比 × 破城回合数。
 *
 * 单看哪一个都不够——兵多但砸不动城等于干耗，砸得动但兵力被压着打等于送。
 * 这个组合数是给"决战时机"用的，**权重待校准**。
 */
export function offenseScore(s: GameState, me: PlayerId, city: City): number {
  const ratio = strengthRatio(s, me);
  const turns = turnsToRaze(s, me, city);
  if (!Number.isFinite(turns)) return 0;
  return ratio / Math.max(1, turns);
}

/* ---------------- 产能：战力不只算场上，还要算"每回合能补多少" ---------------- */

/**
 * 生产点（城 + 产兵建筑）。
 *
 * 这是用户 2026-11-21 提的那条：**20 个坦克但每回合只能补 2 个，
 * 打不过 10 个坦克但每回合能补 5 个**。所以"战力"必须带上一项产能，
 * 否则"现在有多少"会把"以后能有多少"完全盖住。
 */
export interface ProductionSite {
  kind: 'city' | 'camp';
  id: string;
  x: number;
  y: number;
}

export function productionSites(s: GameState, me: PlayerId): ProductionSite[] {
  const out: ProductionSite[] = [];
  for (const c of s.cities) {
    if (c.owner !== me || c.ruined) continue;
    out.push({ kind: 'city', id: c.id, x: c.x, y: c.y });
  }
  for (const u of unitsOf(s, me)) {
    if (!isProducer(utype(s, u.type))) continue;
    out.push({ kind: 'camp', id: u.id, x: u.x, y: u.y });
  }
  return out;
}

/**
 * 每回合**最多能出几个兵**：所有生产点周围还能站人的格子数之和。
 *
 * 这就是用户说的"格子数"：城只有那么大，格子被占满就出不来兵；
 * 想多出就得另建军营。
 *
 * 用一个"代表兵种"去问，因为出兵格是跟兵种走的（船要水面、飞行兵能停水上）。
 * 取该席位当前能造的陆军战斗单位里最便宜的那个——格子数对便宜的兵最宽松，
 * 这是"理论产能上界"，偏乐观，但比拿一个昂贵兵种算出来的下界更像"上限"。
 */
export function productionCapacity(s: GameState, me: PlayerId): number {
  const sites = productionSites(s, me);
  if (sites.length === 0) return 0;
  const probe = Object.values(s.unitTypes)
    .filter((d) => d.category === 'combat' && d.domain !== 'water')
    .sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0))[0];
  if (!probe) return 0;
  let cells = 0;
  for (const site of sites) {
    cells += site.kind === 'city'
      ? recruitSpawnCells(s, site.id, undefined, probe.id).length
      : recruitSpawnCells(s, undefined, site.id, probe.id).length;
  }
  return cells;
}

/**
 * 每回合能变成战力的部分（战力/回合）。
 *
 * 三个上限取最小：格子数、钱、以及"这一局最强的性价比兵"。
 *   · 钱只算**收入**，不算存款：存款是一次性的，投影要看持续产出；
 *   · 用性价比最好的兵估，是"人类会这么打"的那个上限。
 */
export function powerPerTurn(s: GameState, me: PlayerId): number {
  const capacity = productionCapacity(s, me);
  if (capacity <= 0) return 0;
  const income = incomeOf(s, me);
  if (income <= 0) return 0;
  let best: { units: number; power: number } | null = null;
  for (const d of Object.values(s.unitTypes)) {
    if (d.category !== 'combat' || d.domain === 'water') continue;
    const price = d.cost ?? 0;
    if (price <= 0 || price > income) continue;
    const units = Math.min(capacity, Math.floor(income / price));
    if (units <= 0) continue;
    const power = units * unitPower(d);
    if (!best || power > best.power) best = { units, power };
  }
  return best?.power ?? 0;
}

/**
 * 投影：到第 `turns` 回合时我大概有多强 = 现在的战力 + 每回合产能 × 回合数。
 *
 * 这是"决战时机"真正需要的那个数。**它不算投资复利、不算升级换代**
 * ——那两样留给"发展"计划，否则一件事两处算。
 */
export function projectedStrength(s: GameState, me: PlayerId, turns: number): number {
  return armyStrength(s, me) + powerPerTurn(s, me) * Math.max(0, turns);
}

/* ---------------- 战力求解器的入口：从局面拼输入 ---------------- */

/**
 * 把局面翻译成求解器的输入。
 *
 * 只需要四样：手上多少钱、每回合收多少、每回合能出几个兵、以及"能买什么"。
 * 兵的价格用金币造价（资源费忽略——求解器只看金，这是已知偏差），
 * 战力用同一套 `unitPower`。
 */
export function powerInputOf(s: GameState, me: PlayerId): PowerInput {
  const units: PowerUnit[] = [];
  const econ: PowerEcon[] = [];
  for (const d of Object.values(s.unitTypes)) {
    const price = d.cost ?? 0;
    if (price <= 0) continue;
    if (d.category === 'combat' && d.domain !== 'water') {
      units.push({ id: d.id, price, power: unitPower(d) });
    } else if (d.category === 'economy') {
      // 按平均地块估：`incomeByTerrain` 的最大值（乐观），没有就用面板 income
      const tiles = Object.values(d.incomeByTerrain ?? {});
      const inc = tiles.length > 0 ? Math.max(...tiles.map((v) => Number(v) || 0)) : d.income ?? 0;
      if (inc > 0) econ.push({ id: d.id, price, income: inc });
    }
  }
  const cities = s.cities.filter((c) => c.owner === me && !c.ruined).length;
  const haveEcon = unitsOf(s, me).filter((u) => utype(s, u.type).category === 'economy').length;
  return {
    gold: s.players[me].gold,
    income: incomeOf(s, me),
    slots: productionCapacity(s, me),
    // 每城两个经济单位的惯例，减去已经有的
    econRoom: Math.max(0, cities * 2 - haveEcon),
    units,
    econ,
  };
}

/**
 * 到第 `turns` 回合，这一席**最多**能攒出多少战力（含现有部队）。
 *
 * 和 `projectedStrength` 的区别：那个是"按现在的产能线性外推"，
 * 这个是"按最优投法算"——它会自己决定什么时候停止投经济、转暴兵。
 */
export function solvedProjection(
  s: GameState,
  me: PlayerId,
  turns: number,
): { power: number; plan: PowerPlan } {
  const base = armyStrength(s, me);
  const plan = solvePower(powerInputOf(s, me), turns);
  return { power: base + plan.power, plan };
}

/* ---------------- 决战扫描：比值随"还能等多久"怎么变 ---------------- */

export interface RacePoint {
  /** 距离现在几回合 */
  turns: number;
  my: number;
  foe: number;
  ratio: number;
}

/**
 * 逐点扫"再等 T 回合，双方战力各是多少、比值怎么变"。
 *
 * 为什么需要它、而不是拍一个 horizon：拍出来的那个数同时决定了判决
 * （比值越线没有）和两边的比较口径。取早了看不见产能投资，取晚了
 * 把"二十回合后才会发生的事"当成现在的想法。
 *
 * 采几个点由调用方决定：`decisiveOf` 现在只采"抵达"和"抵达 + 12"两点
 * （实测峰值几乎总落在起点，细扫只增加开销）。
 *
 * 两边的输入各拼一次（`powerInputOf` 不随 T 变），之后每个 T 只跑一次求解器。
 */
export function powerRace(
  s: GameState,
  me: PlayerId,
  foe: PlayerId | null,
  horizons: number[],
  /**
   * 分母的"额外底数"：记忆里看不见的敌方战力（`rememberedPowerOf`）。
   *
   * 为什么不并进 `armyStrength`：那是"此刻看得见的"，改它会污染所有调用方；
   * 而"记忆"只有决战判断这一个消费者。放这里当常数项，正好和求解器算的增量相加。
   */
  foeExtra = 0,
): RacePoint[] {
  const myBase = armyStrength(s, me);
  const myInput = powerInputOf(s, me);
  const foeBase = (foe === null ? 0 : armyStrength(s, foe)) + Math.max(0, foeExtra);
  const foeInput = foe === null ? null : powerInputOf(s, foe);
  const out: RacePoint[] = [];
  for (const h of horizons) {
    const t = Math.max(0, Math.floor(h));
    const my = myBase + solvePower(myInput, t).power;
    const theirs = foeInput ? foeBase + solvePower(foeInput, t).power : 0;
    out.push({ turns: t, my, foe: theirs, ratio: my / Math.max(1, theirs) });
  }
  return out;
}
