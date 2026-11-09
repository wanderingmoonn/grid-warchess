/**
 * 丹药：修士**藏在身上**的消耗品。
 *
 * ── 设计（2026-11-08 敲定）────────────────────────────────
 *
 * 三条边界，决定了后面每一处写法：
 *
 * 1. **丹药是"内服"的，不做投掷型。** 扔出去打人的东西是暗器，那是法术。
 *    所以服用永远作用于**自己**——这条让 `UNIT_ACTION` 不用带坐标，
 *    核心的动作通路一个字都不用改。
 * 2. **丹药是隐藏信息。** 对手看得见你身上的 buff（药力藏不住），
 *    但数不出你兜里还有几颗（那是底牌）。数量存在 `custom.pills`，
 *    由实现在 `hooks.ts` 里的 `redactUnit` 在视图层抹掉（见 fog.ts）。
 * 3. **携带是消耗品，不是能力。** 所以它比法术位宽松、也更容易失去：
 *    人死了药就没了（`custom` 跟着单位对象走，零代码），
 *    想补货就得回炼丹炉旁边站着炼。
 *
 * ── 为什么存 `custom.pills` 而不新开字段 ─────────────────────
 *
 * `Unit.custom` 就是为这种"扩展自己的沙盒数据"准备的，`custom.exp / rank /
 * mana / manaMax` 已经是四个先例。存档是整体 `JSON.stringify`，老存档读出来
 * 就是 `undefined`，语义正好是"身上没药"——零迁移。
 *
 * ⚠️ 红线：本文件不许 import `../rules.ts` / `../auras.ts`（初始化链会成环，
 * 原因见 skills/sky-step.ts 顶部）。血量上限用 progression 的 `getMaxHp`，
 * 它和规则层的 `maxHpOf` 是同一个式子。
 */
import type { GameState, PlayerId, Unit } from '../types.ts';
import { distBetweenUnits } from '../query.ts';
import { GOLD, addRes, resOf } from '../resources.ts';
import { getMaxHp, getRank } from './progression.ts';
import { manaOf, maxManaOf, setMana } from './mana.ts';
import { UNIT_IDS, isCultivatorUnit } from './identity.ts';
import { SPIRIT_STONE } from './resources.ts';

// ── 数值 ──────────────────────────────────────────

/** 身上最多能背几颗（还要加 ⌊境界/2⌋） */
export const PILL_CARRY_BASE = 3;
/** 回春丹：按生命上限回的比例 */
export const HEAL_PILL_RATIO = 0.12;
/** 回春丹：至少回这么多（0 期修士血薄，纯比例会回个位数） */
export const HEAL_PILL_FLOOR = 15;
/** 聚灵丹：回多少灵力（固定值，因为灵力上限只从 40 到 130，不需要按比例） */
export const SPIRIT_PILL_MANA = 40;
/** 护体丹：护甲加成比例 */
export const WARD_PILL_ARMOR_PCT = 0.25;
/** 护体丹：撑几个自己的回合 */
export const WARD_PILL_TURNS = 2;

/** 一颗丹药的数据。加一条 = 写一项 + 在 PILLS 里登记，别处一个字不用改 */
export interface PillDef {
  id: string;
  name: string;
  /** 一行话：吃下去会发生什么（面板、按钮小字、规则书共用这一份） */
  summary: string;
  /** 炼制花费。只有这两种资源，别再把资源表摊开 */
  cost: { gold: number; stone: number };
  /**
   * 什么时候**不该**吃（返回理由，不写 = 随时能吃）。
   *
   * 放在数据上而不是塞进 `pillUseProblem` 的 if：加第四颗丹的时候，
   * 不该还要回判定函数里补一条分支——那正是"加一条要改三处"的老毛病。
   */
  unusable?: (s: GameState, u: Unit) => string | null;
  /**
   * 实际效果。返回一句战报；返回 `null` 表示"这一颗不该吃"
   * （满血、满灵力）——调用方已经用 `pillUseProblem` 拦过一次，
   * 走到这里还返回 null 只可能是状态在两次判定之间变了。
   */
  apply: (s: GameState, u: Unit) => string | null;
}

export const HEAL_PILL: PillDef = {
  id: 'healing-pill',
  name: '回春丹',
  summary: `回复 ${Math.round(HEAL_PILL_RATIO * 100)}% 生命上限（至少 ${HEAL_PILL_FLOOR} 点）`,
  cost: { gold: 15, stone: 3 },
  unusable: (s, u) => (u.hp >= getMaxHp(s, u) ? '生命值已满' : null),
  apply: (s, u) => {
    const max = getMaxHp(s, u);
    const want = Math.max(HEAL_PILL_FLOOR, Math.round(max * HEAL_PILL_RATIO));
    const real = Math.min(want, max - u.hp);
    if (real <= 0) return null;
    u.hp += real;
    return `恢复 ${real} 点生命`;
  },
};

export const SPIRIT_PILL: PillDef = {
  id: 'spirit-pill',
  name: '聚灵丹',
  summary: `立刻回复 ${SPIRIT_PILL_MANA} 点灵力`,
  cost: { gold: 20, stone: 6 },
  unusable: (_s, u) => (manaOf(u) >= maxManaOf(u) ? '灵力已满' : null),
  apply: (_s, u) => {
    const before = manaOf(u);
    const after = Math.min(maxManaOf(u), before + SPIRIT_PILL_MANA);
    if (after <= before) return null;
    setMana(u, after);
    return `灵力 +${after - before}`;
  },
};

export const WARD_PILL: PillDef = {
  id: 'ward-pill',
  name: '护体丹',
  summary: `护甲 +${Math.round(WARD_PILL_ARMOR_PCT * 100)}%，持续 ${WARD_PILL_TURNS} 回合`,
  cost: { gold: 25, stone: 8 },
  apply: (_s, u) => {
    /*
     * 直接覆盖 `buff` 而不是叠加：药力只有一份，新药压旧药。
     *
     * 这条不是省事——`buff` 本来就只有一组槽（护甲/魔抗/免溅射），
     * 叠两种药会变成"护甲吃 A 药的、魔抗吃 B 药的"，玩家永远算不清。
     * 覆盖的语义清楚：**同时只能有一种药力在身上**。
     */
    u.buff = {
      armorPct: WARD_PILL_ARMOR_PCT,
      turns: WARD_PILL_TURNS,
      label: WARD_PILL.name,
    };
    return `护甲 +${Math.round(WARD_PILL_ARMOR_PCT * 100)}%，${WARD_PILL_TURNS} 回合内有效`;
  },
};

export const PILLS: readonly PillDef[] = [HEAL_PILL, SPIRIT_PILL, WARD_PILL];

export function pillOf(id: string): PillDef | undefined {
  return PILLS.find((p) => p.id === id);
}

// ── 携带 ──────────────────────────────────────────

/** 这个修士能背几颗：3 + ⌊境界/2⌋（2 期 4 颗、9 期 7 颗） */
export function pillCarryCap(u: Unit): number {
  return PILL_CARRY_BASE + Math.floor(Math.max(0, getRank(u)) / 2);
}

/** 身上的袋子。永远返回一份新对象，随便改不影响真实数据 */
export function pillsOf(u: Unit): Record<string, number> {
  const raw = u.custom?.pills;
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [id, n] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[id] = Math.floor(n);
  }
  return out;
}

/** 一共背了几颗（上限按"颗数"算，不按种类） */
export function pillCountOf(u: Unit): number {
  return Object.values(pillsOf(u)).reduce((n, x) => n + x, 0);
}

function writePills(u: Unit, bag: Record<string, number>): void {
  const next: Record<string, number> = {};
  for (const [id, n] of Object.entries(bag)) if (n > 0) next[id] = n;
  u.custom = { ...(u.custom ?? {}), pills: next };
}

/** 往身上装一颗。背包满了返回 false */
export function addPill(u: Unit, id: string): boolean {
  if (pillCountOf(u) >= pillCarryCap(u)) return false;
  const bag = pillsOf(u);
  bag[id] = (bag[id] ?? 0) + 1;
  writePills(u, bag);
  return true;
}

/** 从身上拿掉一颗。没有返回 false */
export function takePill(u: Unit, id: string): boolean {
  const bag = pillsOf(u);
  if ((bag[id] ?? 0) <= 0) return false;
  bag[id] -= 1;
  writePills(u, bag);
  return true;
}

// ── 炼丹炉 ────────────────────────────────────────

/** 脚下挨着的、活着的自家炼丹炉（和藏经阁/libraryNextTo 同一口径） */
export function furnaceNextTo(s: GameState, u: Unit): Unit | null {
  for (const b of s.units) {
    if (b.type !== UNIT_IDS.ALCHEMY_FURNACE) continue;
    if (b.owner !== u.owner || b.hp <= 0) continue;
    if (distBetweenUnits(s, b, u) <= 1) return b;
  }
  return null;
}

// ── 判定（面板置灰与规则拒绝共用同一份）───────────────

/**
 * 能不能吃这一颗。返回字符串 = 不能，字符串是给玩家看的理由。
 *
 * 和 `spellLearnProblem` 一个模式：`unitActions` 拿它决定灰不灰，
 * `onUnitAction` 拿它决定放不放行。各写一遍必然变成"按钮能点、点下去被拒"。
 */
export function pillUseProblem(s: GameState, u: Unit, pill: PillDef): string | null {
  if ((pillsOf(u)[pill.id] ?? 0) <= 0) return `身上没有「${pill.name}」`;
  return pill.unusable?.(s, u) ?? null;
}

/**
 * 能不能在炼丹炉旁边炼这一颗。
 *
 * 三条：站炉子旁、资源够、背包没满。**炼丹是瞬时的**——不走生产队列，
 * 因为丹药是消耗品，一颗一颗等回合会把"补给"变成"排队"。
 */
export function pillBrewProblem(s: GameState, owner: PlayerId, u: Unit, pill: PillDef): string | null {
  if (!isCultivatorUnit(s, u)) return '只有修士才炼丹';
  if (!furnaceNextTo(s, u)) return '要站在炼丹炉旁边才能炼';
  if (pillCountOf(u) >= pillCarryCap(u)) {
    return `装不下了（${pillCountOf(u)} / ${pillCarryCap(u)}）`;
  }
  const gold = resOf(s.players[owner], GOLD);
  if (gold < pill.cost.gold) return `金币不足（${gold} / ${pill.cost.gold}）`;
  const stones = resOf(s.players[owner], SPIRIT_STONE);
  if (stones < pill.cost.stone) return `灵石不足（${stones} / ${pill.cost.stone}）`;
  return null;
}

/** 真的扣资源。调用前必须先过 `pillBrewProblem` */
export function payForPill(s: GameState, owner: PlayerId, pill: PillDef): void {
  addRes(s.players[owner], GOLD, -pill.cost.gold);
  addRes(s.players[owner], SPIRIT_STONE, -pill.cost.stone);
}
