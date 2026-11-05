// 光环的“范围”与“数值型光环的合并”。
// 效果型光环（治愈、灼烧、召唤……）不在这里——它们走自己的钩子，

// 只需要从 allyAuras / foeAuras 拿“范围内的人”。
import type { GameState, Unit, UnitTypeDef } from './types.ts';
import type {
  AuraSpec
} from './ability-hooks.ts';
import { distBetweenUnits } from './query.ts';
import { aurasOf } from './ability-registry.ts';

/** 本局兵种表。和 rules.ts 的 utype 同一口径，这里不抛新错。 */
function defOf(s: GameState, u: Unit): UnitTypeDef {
  const def = s.unitTypes[u.type];
  if (!def) throw new Error(`本局没有兵种: ${u.type}`);
  return def;
}

/** 合并 extraAbilities 的 aurasOf，和 rules.ts 原来的私有版本同一口径 */
export function aurasOfUnit(s: GameState, u: Unit): AuraSpec[] {
  return aurasOf(defOf(s, u), u.extraAbilities);
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