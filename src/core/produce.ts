/**
 * 产兵能力（produce）：这座建筑能把哪些兵造出来、多快、多贵、占不占编制。
 *
 * ── 为什么不再用一个 `barracks: true` ─────────────────────────────────
 *
 * 以前"能产兵"是一个布尔开关，所有兵营因此一模一样：能造的东西完全由
 * 时代 + 城市供给决定，造一个兵永远当回合成型、永远原价、永远不占编制。
 * 想加一座"只出轻步兵、但便宜"的前哨营，或者"两回合出一台"的重工厂，
 * 只能去规则里加 if——那不是数据驱动。
 *
 * 现在这座建筑能不能产兵、产什么、多快、多贵，全写在 `produce` 上；
 * 规则层只读不算（见 rules.doRecruit 的 camp 分支），界面照它过滤列表。
 *
 * ── 各字段的语义（也写在 types.ts 的 ProduceSpec 上）──────────────────
 *
 *   units      白名单：只造这些兵种 id；不写 = 按时代与城市供给放开
 *   everyTurns 生产间隔：每几回合出一个（默认 1 = 当回合成型）
 *   costScale  造价倍率：0.9 = 便宜一成，1.2 = 加价两成（默认 1）
 *   pop        这座营占用几格编制（默认 0，建筑本来不占编制）
 *
 * ── 老数据兼容 ────────────────────────────────────────────────────────
 *
 * `barracks: true` 仍然认，等价于 `produce: {}`（全默认值）。
 * 老存档里的兵种表就是这么写的，读进来照常能产兵，不会突然变成一块石头。
 */

import type { GameState, ProduceSpec, Unit, UnitTypeDef } from './types.ts';
import type { ResourceCost } from './resources.ts';

/** 缺省值：当回合成型、原价、不占编制 */
export const PRODUCE_DEFAULTS = { everyTurns: 1, costScale: 1, pop: 0 } as const;

/** 读产兵能力；`barracks: true` 翻译成"全默认值的产兵能力"。不是产兵点返回 null */
export function produceOf(def: UnitTypeDef | undefined | null): ProduceSpec | null {
  if (!def) return null;
  if (def.produce) return def.produce;
  if (def.barracks) return {};
  return null;
}

/** 这座建筑是不是产兵点 */
export function isProducer(def: UnitTypeDef | undefined | null): boolean {
  return produceOf(def) !== null;
}

export type ProduceVerdict = { ok: true } | { ok: false; reason: string };

/**
 * 这座营能不能产这个兵。
 *
 * 只判"白名单"，不判时代、不判钱、不判格子——那三样是每次产兵才成立的
 * 临时条件，归 rules.doRecruit。分开的好处是界面的产兵列表可以直接用
 * 这个函数过滤，不会出现"列在面板里、点下去被拒"。
 */
export function canProduce(
  producer: UnitTypeDef | undefined | null,
  target: UnitTypeDef,
): ProduceVerdict {
  const spec = produceOf(producer);
  if (!spec) return { ok: false, reason: '这不是产兵点' };
  // campOnly：只有**点名要造它**的产兵建筑才造得了。
  //
  // "不写白名单 = 不设限"那条便利不能盖过它：军营的白名单是空的，于是一整张
  // 兵种表它都认，连炼器炉的法器也伸手。法器在军营里只会显示成灰色的
  // "还造不出来"，但设计上它压根不该出现在军营的产品线上。
  if (target.campOnly && !(spec.units ?? []).includes(target.id)) {
    return { ok: false, reason: `${producer!.name}产不了${target.name}` };
  }
  if (spec.units && !spec.units.includes(target.id)) {
    return { ok: false, reason: `${producer!.name}产不了${target.name}` };
  }
  return { ok: true };
}

/**
 * 这座产兵点在 `era` 这个时代落成之后，白名单里**还剩几个造得出来的兵**。
 *
 * 为什么需要这一条：产兵点落成那一刻会把时代钉死（见 doRecruit 的 camp 分支），
 * 之后**永远不会**自己换代。军营这样写没问题——它的白名单是空的，
 * "按时代与城市供给放开"，什么时代落成都能出那一代的兵。
 * 但**带白名单**的产兵点（船坞、造船厂、海军船台）不是：
 * 二代建一座海军船台，白名单里全是六代的船，它这辈子一艘都下不了水。
 * 那不是"贵一点"，那是 460 金买一块石头。
 *
 * 返回值约定：
 *   · `null` —— 没写白名单，不设限（军营、以及一切 `produce: {}`）
 *   · `0`    —— 落成即废，规则层直接拒绝这种建造
 *   · `>0`   —— 现在建起来是真能出货的
 */
export function produceUsableCount(
  producer: UnitTypeDef | undefined | null,
  types: Record<string, UnitTypeDef>,
  era: number,
): number | null {
  const spec = produceOf(producer);
  if (!spec?.units) return null;
  let n = 0;
  for (const id of spec.units) {
    const def = types[id];
    // `def.era <= era` 就是 draft.eraWindowOk 的全部内容。这里不 import 它，
    // 是为了不让 produce（纯数据模块）反向依赖 draft（对局流程）。
    if (def && def.era <= era) n += 1;
  }
  return n;
}

/** 生产间隔（至少 1 回合） */
export function produceEveryTurns(def: UnitTypeDef | undefined | null): number {
  return Math.max(1, Math.trunc(produceOf(def)?.everyTurns ?? PRODUCE_DEFAULTS.everyTurns));
}

/** 造价倍率 */
export function produceCostScale(def: UnitTypeDef | undefined | null): number {
  return produceOf(def)?.costScale ?? PRODUCE_DEFAULTS.costScale;
}

/** 这座营占几格编制 */
export function producePop(def: UnitTypeDef | undefined | null): number {
  return Math.max(0, produceOf(def)?.pop ?? PRODUCE_DEFAULTS.pop);
}

/** 上一次产兵记在哪：存在 `Unit.custom.lastProduceTurn` 上，跟着存档走 */
export function lastProduceTurn(camp: Unit): number | null {
  const raw = camp.custom?.lastProduceTurn;
  return typeof raw === 'number' ? raw : null;
}

/**
 * 还要等几回合才能再产兵。
 *
 * 用"上一次产兵的第几回合"做冷却，而不是排一条生产队列：
 * 队列要多存一份"造到几成"的状态，还要处理营被拆、城被抢、读档读一半，
 * 而这座游戏里"每 N 回合一个"已经足够表达产能差异。
 */
export function produceCooldownLeft(
  s: GameState,
  camp: Unit,
  def: UnitTypeDef | undefined | null,
): number {
  const every = produceEveryTurns(def);
  if (every <= 1) return 0;
  const last = lastProduceTurn(camp);
  if (last === null) return 0;
  return Math.max(0, every - (s.turn - last));
}

/**
 * 按倍率缩放一份造价。
 *
 * 造价在这里是"资源包"（可能同时含金币、粮食、建材），不是单个数字——
 * 直接乘会把多资源包压成一个金币数，所以逐个资源乘完再四舍五入。
 */
export function scaleCost(cost: ResourceCost, scale: number): ResourceCost {
  if (scale === 1) return cost;
  const out: ResourceCost = {};
  for (const [id, n] of Object.entries(cost)) {
    out[id] = Math.max(0, Math.round((n ?? 0) * scale));
  }
  return out;
}
