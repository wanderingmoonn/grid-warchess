// 境界、经验、寿元、生命

import type { GameState, Unit } from '../types.ts';

// --- 升级事件监听机制 ---
type RankUpListener = (u: Unit, s: GameState) => void;
const rankUpListeners: RankUpListener[] = [];

/** 注册一个升级时的监听函数（由外部文件调用） */
export function onRankUp(fn: RankUpListener) {
  rankUpListeners.push(fn);
}
// -----------------------

// 境界名称
export const REALMS: string[] = ["凡人","炼气","筑基","金丹","元婴","化神","返虚","合体","大乘","渡劫"];

// 最大等级
export const MAX_RANK = 9;

/** 寿元耗尽后还能撑几年才真正老死 */
export const AGING_DEATH_AGE = 3;

// 读取当前经验，如果没有初始化就返回 0
export function getExp(u: Unit): number {
  return (u.custom?.exp as number) ?? 0;
}

/**
 * 从 `rank` 级升到 `rank + 1` 级所需的总经验门槛。
 *
 * 语义直接来自旧 `getRank` 的 while 循环在 `rank = r` 时的检查
 * `exp >= expForRank(r)`，所以它天然是"从 r 升到 r+1 的门槛"：
 *   expForRank(0) = 10  → 0 级升 1 级
 *   expForRank(1) = 30  → 1 级升 2 级（累计）
 *   expForRank(2) = 70  → 2 级升 3 级（累计）
 */
export function expForRank(rank: number): number {
  return Math.floor(10 + 10 * rank * (rank + 1) + 0.05 * 4 ** rank);
}

/**
 * 读境界等级。
 *
 * 2026-11-04 起，等级是**存在 `custom.rank` 上的显式字段**，不再每次
 * 现场反推。理由有三个：
 *   1. 「灵体重生」要强制降 1 级，而经验是被减半的——两者不联动，
 *      用 while 反推做不到"exp 掉一半但等级只掉一级"；
 *   2. 未来的「燃烧修为」要"消耗经验但不掉级"，同样要求解耦；
 *   3. `addExp` 的升级判定需要知道"当前是不是真的升了级"，
 *      反推版本里 `newRank > rank` 的比较口径和 exp 减少后的反推混在一起，
 *      一旦 exp 能被外部减少就会误判。
 *
 * 老存档没有这个字段：反推一次并写回。反推是确定性的，写回不改变任何
 * 面板可见数字，所以即使被 UI 的 `effectiveStats` 触发（它承诺纯查询）
 * 也不会出现"看一眼面板规则就变了"。
 *
 * 反推后，如果外部只改 `custom.exp` 而不改 `custom.rank`，下次读仍是
 * 反推那一次的值——这正是"经验和等级解耦"的语义。
 */
export function getRank(u: Unit): number {
  const cached = u.custom?.rank;
  if (typeof cached === 'number') return cached;
  const exp = getExp(u);
  let rank = 0;
  while (rank < MAX_RANK && exp >= expForRank(rank)) rank++;
  u.custom = { ...(u.custom ?? {}), rank };
  return rank;
}

// 本地算最大血量的函数（核心规则里的 maxHpOf 也是这么写的）
export function getMaxHp(s: GameState, u: Unit): number {
  // 从本局兵种表里取基础血量，然后加上单位自己积累的额外血量
  return (s.unitTypes[u.type]?.maxHp ?? 0) + (u.maxHpBonus ?? 0);
}

/**
 * 从 `fromRank` 升到 `toRank` 一次性加多少生命上限。
 *
 * 用 `to³ - from³` 的**差**而不是逐级累加：两者数值等价（telescoping sum），
 * 但写成一跳的形态和 `addExp` 原有的"跨级只回一次血"保持完全一致——
 * 改写成逐级的话，`Math.floor` 在每级都会丢一次精度，回血量会和以前不同。
 */
export function maxHpDeltaBetween(fromRank: number, toRank: number): number {
  return Math.floor(
    8.5 * (toRank - fromRank) +
    0.0685 * (toRank ** 3 * 1.8 ** toRank - fromRank ** 3 * 1.8 ** fromRank),
  );
}
export function sumDeltaMaxHpUpTo(rank: number): number {
  let total = 0;
  for (let r = 1; r <= rank; r++) total += maxHpDeltaBetween(r - 1, r);
  return total;
}

/**
 * 设置经验并重算等级。
 *
 * 用于"扮演特定等级"的场景：测试、调试、未来的读档导入/回合回放。
 * 和 `addExp` 的差别：
 *   · `addExp` 走升级流程（回血、战报、技能领悟），只能升不降；
 *   · 这里**只设置数值**，不触发任何副作用——正是"我想让这个单位处于
 *     rank=x、exp=y 的状态"该用的入口。
 *
 * 不重置 `custom.rank` 的话，`getRank` 会继续读旧缓存。这是 2026-11-04
 * 等级显式化之后的设计：exp 和 rank 解耦，改 exp 不代表改 rank。
 * 想"按 exp 反推等级"就调这个函数；想"只减经验不掉级"就只改 `custom.exp`。
 */
export function setCultivationExp(u: Unit, exp: number): void {
  u.custom = { ...(u.custom ?? {}), exp };
  delete u.custom.rank;
  getRank(u);   // 触发反推并写回
}

/** 导出给测试用 */
export function cultivationRank(u: Unit): number {
  return getRank(u);
}

// 自然经验增长
export function getExpGrowth(u: Unit): number {
  // 剑修注重实战，打坐只能获得一半经验（向下取整，最少 1）
  if (u.type === 'sword-cultivator') {
    return Math.max(1, Math.floor((getRank(u) + 2) / 2));
  }
  return getRank(u) + 2;
}

/**
 * 增加经验并即时判断升级。
 *
 * **只升不降**：exp 减少时 `custom.rank` 不动。这是 2026-11-04 的语义变更——
 * 以前等级是 exp 的纯函数，"exp 掉一半"就等于"掉级"。现在两者解耦：
 *    · 「灵体重生」会**显式**写回降一级的 rank（见未来的 spirit-rebirth）；
 *    · 「燃烧修为」只减 exp，不动 rank。
 * `addExp` 本身只负责"加经验、判定升级"，不再承担"降级"职责——
 * 这件事由调用方按各自的语义处理，正是这次重构的核心目的。
 */
export function addExp(u: Unit, s: GameState, amount: number): void {
  u.custom ??= {};
  const oldRank = getRank(u);   // 触发反推（老存档）或读字段
  u.custom.exp = ((u.custom.exp as number) ?? 0) + amount;

  // 只升不降：从 oldRank 往上走
  let newRank = oldRank;
  while (newRank < MAX_RANK && (u.custom.exp as number) >= expForRank(newRank)) {
    newRank++;
  }

  if (newRank > oldRank) {
    // 跨级只回一次血，delta 用两端差（和旧版 addExp 完全一致）
    const deltaMaxHp = maxHpDeltaBetween(oldRank, newRank);
    // 升级瞬间按照比例回血
    const r = u.hp / getMaxHp(s, u);
    u.maxHpBonus = (u.maxHpBonus ?? 0) + deltaMaxHp;
    u.hp += Math.floor(deltaMaxHp * r);

    // 显式写回新等级：这一步取代了旧版 `const newRank = getRank(u)`
    // 的反推结果，也是"等级不再由 exp 自动推出"的落点
    u.custom.rank = newRank;

    // 寿元增量：只加"该加的那一段"，不重设整个值。
    //
    // 为什么不用 `u.custom.lifespan = baseLifespanOf(newRank)`：
    // 未来的「燃烧寿元」要让寿元**永久**减少（暗伤、透支）。若升级时重设，
    // 减掉的那几年会在下一次升级被洗掉，"永久损失"就只是"延迟损失"。
    // 用增量则与"燃烧"天然共存：升级加 base 增量，燃烧减 N，两者叠加。
    //
    // oldBase 必为有限值：addExp 只升不降，oldRank < newRank ≤ MAX_RANK，
    // 所以 oldRank < MAX_RANK，baseLifespanOf(oldRank) 有限。
    const oldBase = baseLifespanOf(oldRank);
    const newBase = baseLifespanOf(newRank);
    if (!Number.isFinite(newBase)) {
      // rank 9：Infinity 不落库，见 baseLifespanOf
      delete u.custom.lifespan;
    } else {
      const cached = u.custom.lifespan;
      if (typeof cached === 'number' && Number.isFinite(cached)) {
        // 已落库：只加增量，燃烧掉的不会回来
        u.custom.lifespan = cached + (newBase - oldBase);
      } else {
        // 老存档（没有 custom.lifespan）：等价于 base(oldRank)，升到 newRank 即 newBase
        u.custom.lifespan = newBase;
      }
    }

    s.log.push({
      turn: s.turn,
      player: u.owner,
      text: `${s.unitTypes[u.type]?.name ?? u.type} 突破至 ${REALMS[newRank]} 期！`,
      open: true,
    });
    for (const fn of rankUpListeners) {
      fn(u, s);
    }

    // 寿元随等级上涨：显式落库，让降级时不回退（见 getLifespan 的说明）。
    // rank 9 是 Infinity，不落库（见 baseLifespanOf 的说明）。
    // 注意：外部若强行指定过 custom.lifespan（测试场景），这里会覆盖它——
    // 若需固定寿元同时又要触发升级，请直接操纵 custom 而不要走 addExp。
    const newLifespan = baseLifespanOf(newRank);
    if (Number.isFinite(newLifespan)) {
      u.custom.lifespan = newLifespan;
    } else {
      delete u.custom.lifespan;
    }
  }
}

/**
 * 降级后清理：删掉所有"需要更高境界才能维持"的能力和技能。
 *
 * 目前唯一的一条：掉到 rank < 4 后不再拥有「灵体道果」——再死就真死。
 * 未来若有其它 rank 门槛的能力/技能，在这里按同一条规则追加。
 */
export function cleanupAfterRankDrop(u: Unit, newRank: number): void {
  if (newRank < 4 && u.extraAbilities?.includes('spirit-ascension')) {
    u.extraAbilities = u.extraAbilities.filter((id) => id !== 'spirit-ascension');
  }
}

/**
 * 从 rank 推出的基础寿元。rank 9（渡劫）是 Infinity——渡劫成功后寿元不再
 * 约束你，这是既定的设计。
 *
 * Infinity **不能**写进 `custom.lifespan`：JSON 序列化会把它变成 null，
 * 存档读回来就成了"没有字段"，又要走 fallback，来回折腾只是噪音。
 * 所以 rank 9 一律走"没有 custom.lifespan → 按 rank 反推 Infinity"这条路，
 * 不落库。
 */
export function baseLifespanOf(rank: number): number {
  if (rank >= MAX_RANK) return Infinity;
  return 10 + rank * 9;
}

/**
 * 读寿元（纯查询，不写 state）。
 *
 * 优先级：`custom.lifespan`（显式落库值，降级时不随之回退）→ 按 rank 反推。
 *
 * 老存档没有 `custom.lifespan` 时按 rank 反推，读到的数和写回后一致，
 * 所以"看一眼面板"不会改变可观察的数值。
 */
export function getLifespan(u: Unit): number {
  const cached = u.custom?.lifespan;
  if (typeof cached === 'number' && Number.isFinite(cached)) return cached;
  return baseLifespanOf(getRank(u));
}

/**
 * 确保寿元已经落库，返回当前值。
 *
 * 和 `getLifespan` 的差别只在于**写回**：老存档第一次被回合开始触碰时，
 * 把反推值写进 `custom.lifespan`，之后降级就不会回退了。
 * UI 面板走 `getLifespan`，读到的数字和写回后完全一致——"看一眼面板"
 * 不改状态。
 *
 * rank 9 不落库（Infinity 无法 JSON 序列化），走 rank 反推兜底，
 * 行为与 getLifespan 在该分支下等价。
 *
 * 顺带：`getRank` 在这里被调用时，若 `custom.rank` 也是 undefined 会一并落库，
 * 所以老存档第一次回合开始会把 rank 和 lifespan 一起初始化。
 */
export function ensureLifespan(u: Unit): number {
  const cached = u.custom?.lifespan;
  if (typeof cached === 'number' && Number.isFinite(cached)) return cached;
  const rank = getRank(u);
  const value = baseLifespanOf(rank);
  if (Number.isFinite(value)) {
    u.custom = { ...(u.custom ?? {}), lifespan: value };
  }
  return value;
}

/**
 * 超出寿元多少岁。
 * 必须有 Math.max(0, ...)，否则负的"超龄"会变成攻击力加成，导致伤害爆炸。
 */
export function getAgingYears(u: Unit): number {
  return Math.max(0, (u.age ?? 0) - getLifespan(u));
}

/** 超出 AGING_DEATH_AGE 岁就坐化 */
export function isDoomed(u: Unit): boolean {
  return getAgingYears(u) >= AGING_DEATH_AGE;
}