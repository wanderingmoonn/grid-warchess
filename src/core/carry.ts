/**
 * 载具特性（carry）的读取与判定。
 *
 * ── 这个文件在管什么 ────────────────────────────────────────────────────
 *
 * 兵种数据上写着 `carry: { hold: {...}, deck: {...} }`，说的是"我能装谁、装几个"。
 * 但**判定**这件事只能有一份实现：规则层要判"能不能上船"、AI 要判"值不值得装"、
 * 面板要说"还能装几个"、规则书要写"装载 2"——四处各写一遍，迟早对不上。
 *
 * 所以这里只放纯函数：入参是兵种定义（以及可能的乘客定义），出参是布尔/数字/一句话。
 * 不碰 GameState，不写日志，不改任何东西——**没有任何副作用**，可以在任何层调用。
 *
 * ── 为什么 hold 与 deck 要分开 ─────────────────────────────────────────
 *
 * 两者的"装"不是一回事：
 *   · 货舱：人被从 `state.units` 里摘走，棋盘上消失，途中不能作战，船沉了一起没；
 *   · 甲板：飞机仍是 `state.units` 里的一架单位（只是存成了 `custom.airwing` 记录），
 *     每回合能起飞、能返航、能整备。
 * 一个 `capacity` 数字承担不了这两种语义，所以数据层就分成两个槽位。
 *
 * ── 老数据的兼容 ───────────────────────────────────────────────────────
 *
 * 2026-11 之前载具写的是 `transport: true` + `capacity: N`。存档与联机快照里
 * 存的是**当时那份兵种表**，直接改成新字段会让老存档读进来"船突然不能载人"。
 * 所以 `carryOf()` 会把旧写法翻译成 `{ hold: { max } }`——**只在这一处翻译**，
 * 其余代码一律读 `carryOf`，不需要知道旧写法长什么样。
 */

import type { CarryAllow, CarryDeck, CarryHold, CarrySpec, UnitTypeDef } from './types.ts';

/**
 * 货舱的默认准入：地面上的、不是建筑的单位。
 *
 * 为什么默认放宽到"除了船和建筑都能装"：这两个排除项是**物理上说不通**的部分
 * （船装不下船、房子搬不进货舱），其余限制都是设计选择，应该由具体兵种用
 * `allow` 自己声明，而不是靠一个全局默认值替所有载具做主。
 *
 * 注意这里**没有**限制 `layers`：空中单位现在也进得了货舱，这是 0.3.x 的既有行为，
 * 改它会让"运输机把直升机运走"这类对局突然不成立。想禁的载具自己写
 * `allow: { layers: ['ground'] }`。
 */
export const DEFAULT_HOLD_ALLOW: CarryAllow = {
  domains: ['land'],
  categories: ['combat', 'economy', 'builder'],
};

/** 读载具特性；老存档的 `transport + capacity` 在这里翻译成 hold。没有载具能力返回 null */
export function carryOf(def: UnitTypeDef | undefined | null): CarrySpec | null {
  if (!def) return null;
  const spec = def.carry;
  if (spec && (spec.hold || spec.deck)) return spec;
  // 老写法：transport: true + capacity: N
  if (def.transport) {
    const max = def.capacity ?? 0;
    if (max > 0) return { hold: { max } };
  }
  return null;
}

/** 货舱（没有就 null） */
export function holdOf(def: UnitTypeDef | undefined | null): CarryHold | null {
  return carryOf(def)?.hold ?? null;
}

/** 甲板（没有就 null） */
export function deckCarryOf(def: UnitTypeDef | undefined | null): CarryDeck | null {
  return carryOf(def)?.deck ?? null;
}

/** 这个兵种是不是载具（能装任何东西） */
export function isCarrier(def: UnitTypeDef | undefined | null): boolean {
  return carryOf(def) !== null;
}

/** 这个兵种有没有货舱（能运地面部队） */
export function hasHold(def: UnitTypeDef | undefined | null): boolean {
  return (holdOf(def)?.max ?? 0) > 0;
}

/** 这个兵种有没有甲板（能停战机） */
export function hasDeck(def: UnitTypeDef | undefined | null): boolean {
  return (deckCarryOf(def)?.max ?? 0) > 0;
}

/**
 * 准入过滤：只回答"这条 allow 放不放它进来"，不管容量、不管贴身距离。
 *
 * 条件之间是"与"：写了 domains 又写了 categories，就得同时满足。
 * 全空 = 不设限。
 */
export function allowPass(allow: CarryAllow | undefined, pax: UnitTypeDef): boolean {
  if (!allow) return true;
  if (allow.except?.includes(pax.id)) return false;
  if (allow.types && !allow.types.includes(pax.id)) return false;
  const domain = pax.domain ?? 'land';
  if (allow.domains && !allow.domains.includes(domain)) return false;
  if (allow.categories && !allow.categories.includes(pax.category)) return false;
  const layer = pax.layer ?? 'ground';
  if (allow.layers && !allow.layers.includes(layer)) return false;
  return true;
}

export type CarryVerdict = { ok: true } | { ok: false; reason: string };

/**
 * 这个乘客能不能进这艘船的货舱。
 *
 * 只判"身份"（谁装谁），不判"位置、行动点、还剩几个位置"——那三条是每次
 * 具体动作才成立的临时条件，归 rules.doLoad 管。分成两层的好处是：
 * AI 想给"这个兵值不值得装"打分时，不必伪造一个棋盘状态。
 *
 * 拒绝时返回的原因**按最贴近玩家的那个说法**给：装船失败时玩家看到的是
 * "建筑搬不上船"，而不是"不满足 categories 过滤"。
 */
export function canHold(carrier: UnitTypeDef, pax: UnitTypeDef): CarryVerdict {
  const hold = holdOf(carrier);
  if (!hold) return { ok: false, reason: '这个单位没有货舱' };
  if (hold.max <= 0) return { ok: false, reason: '货舱容量为 0' };

  const allow = hold.allow ?? DEFAULT_HOLD_ALLOW;
  if (allow.except?.includes(pax.id)) {
    return { ok: false, reason: `${pax.name}不进货舱` };
  }
  if (allow.types && !allow.types.includes(pax.id)) {
    return { ok: false, reason: `${carrier.name}不载${pax.name}` };
  }
  if (allow.domains && !allow.domains.includes(pax.domain ?? 'land')) {
    return {
      ok: false,
      reason: (pax.domain ?? 'land') === 'water' ? '船上装不了船' : '这种单位上不了船',
    };
  }
  if (allow.categories && !allow.categories.includes(pax.category)) {
    return {
      ok: false,
      reason: pax.category === 'building' ? '建筑搬不上船' : '这种单位上不了船',
    };
  }
  if (allow.layers && !allow.layers.includes(pax.layer ?? 'ground')) {
    return {
      ok: false,
      reason: (pax.layer ?? 'ground') === 'air' ? '空中单位进不了货舱' : '这种单位上不了船',
    };
  }
  return { ok: true };
}

/** 货舱还剩几个位置 */
export function holdRoom(
  def: UnitTypeDef | undefined | null,
  unit: { cargo?: unknown[] | null },
): number {
  const hold = holdOf(def);
  if (!hold) return 0;
  return Math.max(0, hold.max - (unit.cargo?.length ?? 0));
}

const CATEGORY_CN: Record<string, string> = {
  combat: '战斗单位',
  economy: '经济单位',
  builder: '建造单位',
  building: '建筑',
};

/**
 * 把一条 allow 翻成一句人话，给属性卡和规则书用。
 *
 * 它**只负责说清楚**，不参与判定——判定永远是 `allowPass`/`canHold`。
 * 分成两个函数，是因为"写给人看"迟早要润色（换行、加粗、省略），
 * 而判定不能跟着一起润色。
 */
export function describeAllow(
  allow: CarryAllow | undefined,
  nameOf?: (id: string) => string,
): string {
  if (!allow) return '任何单位';
  const parts: string[] = [];
  const label = (id: string) => nameOf?.(id) ?? id;
  if (allow.types?.length) parts.push(allow.types.map(label).join('、'));
  if (allow.domains) {
    parts.push(allow.domains.map((d) => (d === 'water' ? '水上单位' : '陆上单位')).join('／'));
  }
  if (allow.layers) {
    parts.push(allow.layers.map((l) => (l === 'air' ? '空中单位' : '地面单位')).join('／'));
  }
  if (allow.categories) parts.push(allow.categories.map((c) => CATEGORY_CN[c] ?? c).join('／'));
  if (allow.except?.length) parts.push(`不含${allow.except.map(label).join('、')}`);
  return parts.length > 0 ? parts.join('、') : '任何单位';
}
