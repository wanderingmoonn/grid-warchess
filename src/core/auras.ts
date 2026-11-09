// 光环的“范围”与“数值型光环的合并”。
// 效果型光环（治愈、灼烧、召唤……）不在这里——它们走自己的钩子，

// 只需要从 allyAuras / foeAuras 拿“范围内的人”。
import type { GameState, Unit, UnitTypeDef } from './types.ts';
import type {
  AuraSpec
} from './ability-hooks.ts';
import { distBetweenUnits } from './query.ts';
import { aurasOf, hooksFor } from './ability-registry.ts';
import { activeExpansions } from './expansions.ts';

/** 本局兵种表。和 rules.ts 的 utype 同一口径，这里不抛新错。 */
function defOf(s: GameState, u: Unit): UnitTypeDef {
  const def = s.unitTypes[u.type];
  if (!def) throw new Error(`本局没有兵种: ${u.type}`);
  return def;
}

/** 合并 extraAbilities 的 aurasOf，和 rules.ts 原来的私有版本同一口径 */
export function aurasOfUnit(s: GameState, u: Unit): AuraSpec[] {
  const def = defOf(s, u);
  const out = aurasOf(def, u.extraAbilities);
  /*
   * 动态光环：半径/数值按"此刻场上有谁"现算（杀伐阵随相邻修士变半径）。
   *
   * 只在这里合并，所以攻击力面板、AI 威胁圈、实际伤害拿到的都是同一份——
   * 各写一遍必然会出现"面板写着 +10%、打出来是 +0"那种偏差。
   */
  for (const h of hooksFor(def, u.extraAbilities)) {
    if (!h.auraDynamic) continue;
    const extra = h.auraDynamic({ state: s, self: u });
    if (!extra) continue;
    if (Array.isArray(extra)) out.push(...extra);
    else out.push(extra);
  }
  /*
   * 扩展带来的光环（模块、车坞这类"不是兵种能力"的来源）。
   *
   * 合并进同一处，是为了让面板、AI 威胁圈、实际伤害拿到的永远是同一份——
   * 分开算就会出现"面板写着 +6 攻、打出来是 +0"。
   */
  for (const e of activeExpansions(s)) {
    const extra = e.hooks.extraAura?.({ state: s, unit: u });
    if (!extra) continue;
    if (Array.isArray(extra)) out.push(...extra);
    else out.push(extra);
  }
  return out;
}

/**
 * 半径内的友军（默认含自己）。
 * 效果型光环用它找“我照到了谁”，距离按矩形最近边算。
 */
export function allyAuras(
  s: GameState,
  self: Unit,
  radius: number,
  opts: { includeSelf?: boolean } = {},
): Unit[] {
  const includeSelf = opts.includeSelf ?? true;
  const out: Unit[] = includeSelf ? [self] : [];
  for (const u of s.units) {
    if (u.id === self.id) continue;
    if (u.owner !== self.owner) continue;
    if (distBetweenUnits(s, u, self) > radius) continue;
    out.push(u);
  }
  return out;
}

/** 半径内的敌军 */
export function foeAuras(s: GameState, self: Unit, radius: number): Unit[] {
  const out: Unit[] = [];
  for (const u of s.units) {
    if (u.owner === self.owner) continue;
    if (distBetweenUnits(s, u, self) > radius) continue;
    out.push(u);
  }
  return out;
}

/**
 * 属性到兜底显示名的映射。
 *
 * 这是"attr 的命名"，不是"具体光环的名字"：引擎知道"攻击光环"这一类
 * 默认叫什么，不知道某个兵种的光环叫"威吓"还是"恐吓"。后者写在
 * 兵种数据的 AuraSpec.label 上。
 *
 * 所有现有兵种都不写 label，所以面板文字和以前完全一样。
 * 未来给某个光环起新名字，在数据里写 label 即可，这张表不用改。
 */
const ATTR_LABELS = {
  allyAtk: '指挥光环',
  allyArmor: '守护光环',
  allyMove: '疾行光环',
  foeAtk: '被威吓',
  foeAtkPct: '虚咒',
  foeArmor: '咒域',
  allyAtkPct: '攻击加成',
  foeMovePct: '迟缓',
  foeMoveFlat: '镇压',
} as const;

export interface AuraSource {
  label: string;
  value: number;
  sourceId: string;
}

/**
 * 覆盖到 unit 的某一种友军光环，按标签聚合成一条。
 *
 * 为什么聚合：面板原来只显示“指挥光环 +N”一条总数。不聚合的话，
 * 两个指挥光环会变成两行 +2，看起来像改坏了。聚合后和原来一致。
 */
export function auraSourcesOf(
  s: GameState,
  unit: Unit,
  kind: 'allyAtk' | 'allyArmor' | 'allyMove',
): AuraSource[] {
  // 按 label 分组：两条都叫"指挥光环"就合并成一条 +N，
  // 一条"指挥光环"一条"将军光环"就各显示一行。
  // 数据里没写 label 时，所有源都用兜底名，于是合并成一条——和以前一样。
  const groups = new Map<string, { value: number; sourceId: string }>();
  for (const ally of s.units) {
    if (ally.id === unit.id || ally.owner !== unit.owner) continue;
    const gap = distBetweenUnits(s, ally, unit);
    for (const a of aurasOfUnit(s, ally)) {
      const v = a[kind];
      if (!v) continue;
      if (gap > (a.radius ?? 1)) continue;
      const label = a.label ?? ATTR_LABELS[kind];
      const g = groups.get(label);
      if (g) g.value += v;
      else groups.set(label, { value: v, sourceId: ally.id });
    }
  }
  return [...groups.entries()].map(([label, g]) => ({
    label,
    value: g.value,
    sourceId: g.sourceId,
  }));
}

/** 数值型友军光环的总和：攻击 / 护甲 / 移动力 */
export function auraBonusOf(s: GameState, unit: Unit): { atk: number; armor: number; move: number } {
  const sum = (kind: 'allyAtk' | 'allyArmor' | 'allyMove') =>
    auraSourcesOf(s, unit, kind).reduce((n, x) => n + x.value, 0);
  return { atk: sum('allyAtk'), armor: sum('allyArmor'), move: sum('allyMove') };
}

/** 威吓：贴着几个会吓人的敌人，就少几分攻击（每源 cap 后累加） */
export function fearPenaltyOf(s: GameState, unit: Unit): number {
  let hit = 0;
  for (const foe of s.units) {
    if (foe.owner === unit.owner) continue;
    const gap = distBetweenUnits(s, foe, unit);
    for (const a of aurasOfUnit(s, foe)) {
      if (!a.foeAtk || a.foeAtk >= 0) continue;
      if (gap > (a.radius ?? 1)) continue;
      const cap = (a.maxLayers ?? Infinity) * -a.foeAtk;
      hit = Math.min(cap, hit - a.foeAtk);
    }
  }
  return hit;
}

/** 虚咒：范围内敌军攻击力按比例降低，取最强的一条，上限 0.9 */
export function hexWeakPctOf(s: GameState, unit: Unit): number {
  let pct = 0;
  for (const foe of s.units) {
    if (foe.owner === unit.owner) continue;
    const gap = distBetweenUnits(s, foe, unit);
    for (const a of aurasOfUnit(s, foe)) {
      if (!a.foeAtkPct || a.foeAtkPct <= 0) continue;
      if (gap > (a.radius ?? 1)) continue;
      if (a.foeAtkPct > pct) pct = a.foeAtkPct;
    }
  }
  return Math.min(0.9, pct);
}

/** 咒域：贴着几个带咒域的敌人，就少几点护甲（每源 cap 后累加） */
export function curseAuraPenaltyOf(s: GameState, unit: Unit): number {
  let hit = 0;
  for (const foe of s.units) {
    if (foe.owner === unit.owner) continue;
    const gap = distBetweenUnits(s, foe, unit);
    for (const a of aurasOfUnit(s, foe)) {
      if (!a.foeArmor || a.foeArmor >= 0) continue;
      if (gap > (a.radius ?? 1)) continue;
      const cap = (a.maxLayers ?? Infinity) * -a.foeArmor;
      hit = Math.min(cap, hit - a.foeArmor);
    }
  }
  return hit;
}

export function fearSourcesOf(s: GameState, unit: Unit): AuraSource[] {
  const penalty = fearPenaltyOf(s, unit);
  if (penalty === 0) return [];
  return [{ label: ATTR_LABELS.foeAtk, value: penalty, sourceId: '' }];
}

export function hexSourcesOf(s: GameState, unit: Unit): AuraSource[] {
  const pct = hexWeakPctOf(s, unit);
  if (pct === 0) return [];
  return [{ label: ATTR_LABELS.foeAtkPct, value: pct, sourceId: '' }];
}

export function curseSourcesOf(s: GameState, unit: Unit): AuraSource[] {
  const penalty = curseAuraPenaltyOf(s, unit);
  if (penalty === 0) return [];
  return [{ label: ATTR_LABELS.foeArmor, value: penalty, sourceId: '' }];
}

/**
 * 盖在 unit 身上的**友军攻击百分比**加成：取最强的一条，不叠乘。
 *
 * 返回来源是为了面板能写清"这 +10% 是谁给的"。两个杀伐阵重叠时
 * 仍然只有一个来源生效——和虚咒（foeAtkPct）同一条规矩。
 */
export function allyAtkPctOf(s: GameState, unit: Unit): AuraSource | null {
  let best: AuraSource | null = null;
  for (const ally of s.units) {
    if (ally.id === unit.id || ally.owner !== unit.owner) continue;
    const gap = distBetweenUnits(s, ally, unit);
    for (const a of aurasOfUnit(s, ally)) {
      const pct = a.allyAtkPct;
      if (!pct || pct <= 0) continue;
      if (gap > (a.radius ?? 1)) continue;
      if (!best || pct > best.value) {
        best = { label: a.label ?? ATTR_LABELS.allyAtkPct, value: pct, sourceId: ally.id };
      }
    }
  }
  return best;
}

/**
 * 盖在 unit 身上的**敌军移动力留存率**：取最小（最强的那个封锁），没有就是 1。
 *
 * 和 allyAtkPctOf 相反，这里比较的是"越小越强"，所以不能共用同一个比较器。
 */
export function foeMovePctOf(s: GameState, unit: Unit): AuraSource {
  let best: AuraSource = { label: ATTR_LABELS.foeMovePct, value: 1, sourceId: '' };
  for (const foe of s.units) {
    if (foe.owner === unit.owner) continue;
    const gap = distBetweenUnits(s, foe, unit);
    for (const a of aurasOfUnit(s, foe)) {
      const pct = a.foeMovePct;
      if (!pct || pct >= 1) continue;
      if (gap > (a.radius ?? 1)) continue;
      if (pct < best.value) {
        best = { label: a.label ?? ATTR_LABELS.foeMovePct, value: pct, sourceId: foe.id };
      }
    }
  }
  return best;
}

/**
 * 盖在 unit 身上的**敌军移动力固定扣减**：取最大的一条（最强的那个封锁）。
 *
 * 和 foeMovePctOf 分开是刻意的：一个按比例、一个按固定值，
 * 合并在一个函数里会让"该先乘还是先减"变得含糊。结算顺序由 rules 定：
 * 先乘比例，再减固定值。
 */
export function foeMoveFlatOf(s: GameState, unit: Unit): AuraSource {
  let best: AuraSource = { label: ATTR_LABELS.foeMoveFlat, value: 0, sourceId: '' };
  for (const foe of s.units) {
    if (foe.owner === unit.owner) continue;
    const gap = distBetweenUnits(s, foe, unit);
    for (const a of aurasOfUnit(s, foe)) {
      const flat = a.foeMoveFlat;
      if (!flat || flat <= 0) continue;
      if (gap > (a.radius ?? 1)) continue;
      if (flat > best.value) {
        best = { label: a.label ?? ATTR_LABELS.foeMoveFlat, value: flat, sourceId: foe.id };
      }
    }
  }
  return best;
}
