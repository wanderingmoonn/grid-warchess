/**
 * 能力总表：核心能力 + 各扩展贡献的能力，合成一张查询表。
 *
 * 为什么要合并：能力的**实现**跟着扩展走（谁家的兵谁家管），但玩家看到的
 * 能力名、规则书里的条目、自定义兵种编辑器里的勾选框，都该是一份完整的表。
 * 所以这里只做"合并与查询"，不放任何实现。
 *
 * 特别注意：这张表**不看"这一局勾了哪些扩展"**。自定义兵种是原版功能，
 * 它在编辑器里勾了「淬毒」，就该在没开奇想包的局里照样生效——
 * 能力是兵种的一部分，不是"开了哪个包才存在的东西"。
 */

import { CORE_ABILITIES, hasAbility } from './abilities.ts';
import type { AbilityDef } from './abilities.ts';
import type { AbilityHooks, Staged } from './ability-hooks.ts';
import { EXPANSIONS } from './expansions.ts';
import type { Terrain, UnitTypeDef } from './types.ts';

const byId = new Map<string, AbilityDef>();
// 核心优先：同 id 的条目以本体为准，扩展重复声明不会盖掉它
for (const a of CORE_ABILITIES) byId.set(a.id, a);
for (const e of EXPANSIONS) {
  for (const a of e.abilities ?? []) {
    if (!byId.has(a.id)) byId.set(a.id, a);
  }
}

/**
 * 把 `def.abilities` 和实例挂的 `extraAbilities` 合并成一个 id 列表。
 *
 * 顺序规则：先 def（兵种天赋），再 extra（后天挂的）——和 `abilities` 数组
 * 决定同 stage 钩子先后的语义一致：天赋先跑、后天后跑。
 * 按 id 去重：一个能力不该因为同时出现在天赋和 extra 里跑两遍。
 */
function mergedIds(def: UnitTypeDef | undefined, extra?: string[]): string[] {
  const base = def?.abilities ?? [];
  if (!extra || extra.length === 0) return base;
  const out = [...base];
  for (const id of extra) if (!out.includes(id)) out.push(id);
  return out;
}

/** 全部能力（核心在前，扩展按注册顺序跟在后面） */
export function allAbilities(): AbilityDef[] {
  return Array.from(byId.values());
}

export function abilityById(id: string): AbilityDef | undefined {
  return byId.get(id);
}

/**
 * 这个兵种（含实例挂的 extraAbilities）有没有某条能力。
 *
 * 和文件末尾重导出的 `hasAbility(def, id)` 的差别只在于第二参：
 * 那个是"只看兵种天赋"，这个是"天赋 + 后天"。
 * 规则层所有"手里已经有 Unit"的场合都该走这个；"手里只有 def"
 * （比如 canStandAt / recruitSpawnCells）继续走 hasAbility 即可。
 */
export function hasAbilityIn(def: UnitTypeDef | undefined, id: string, extra?: string[]): boolean {
  return mergedIds(def, extra).includes(id);
}

/**
 * 把能力 id 列表翻成人话，给面板用。
 *
 * 飞行和掠空已经从"能力"升格成类型字段（`flight` / `layer`），
 * 但它们仍然是玩家看得见的标签——所以字段为真时在这里补回来。
 * 判断里那两个 id 是**旧数据的兼容写法**，不是实现分支：
 * 老存档、老角色卡、编辑器里的老勾选框都还认它们。
 */
export function abilityNames(def: UnitTypeDef): string[] {
  const ids = def.abilities ?? [];
  const names = ids.map((id) => abilityById(id)?.name ?? id);
  if (def.layer === 'air' && !ids.includes('fly-over')) names.unshift('掠空');
  else if (def.flight === true && !ids.includes('fly') && !ids.includes('fly-over')) names.unshift('飞行');
  return names;
}

const EMPTY: AbilityHooks[] = [];
const cache = new Map<string, AbilityHooks[]>();

/**
 * 这个兵种身上所有能力的钩子。
 *
 * 按 abilities 数组的顺序返回（同 stage 的钩子靠它决定先后），
 * 并以 id 串为键缓存：computeDamage 每回合要跑几十次，逐个查表太浪费。
 */
export function hooksFor(def: UnitTypeDef | undefined, extra?: string[]): AbilityHooks[] {
  const ids = mergedIds(def, extra);
  if (ids.length === 0) return EMPTY;
  const key = ids.join('|');   // ← 合并后的 id 串做 key，缓存天然按 extra 区分
  const hit = cache.get(key);
  if (hit) return hit;
  const list: AbilityHooks[] = [];
  for (const id of ids) {
    const hooks = byId.get(id)?.hooks;
    if (hooks) list.push(hooks);
  }
  const frozen = list.length === 0 ? EMPTY : list;
  cache.set(key, frozen);
  return frozen;
}

/**
 * 这个兵种站在各种地形上能多拿多少护甲（来自 terrainArmor 声明）。
 *
 * 只读声明、不跑结算，所以便宜到可以在每步走位评估里调用。
 * 合并规则取最大值：同一块地有两条能力都给加成时，不叠加（和数据里的
 * 光环同一条约定——叠乘最容易变成"某个组合意外破表"）。
 */
const terrainArmorCache = new Map<string, Map<Terrain, number>>();
const EMPTY_TERRAIN = new Map<Terrain, number>();

export function terrainArmorOf(def: UnitTypeDef | undefined, extra?: string[]): Map<Terrain, number> {
  const ids = mergedIds(def, extra);
  if (ids.length === 0) return EMPTY_TERRAIN;
  const key = ids.join('|');
  const hit = terrainArmorCache.get(key);
  if (hit) return hit;
  const out = new Map<Terrain, number>();
  for (const hooks of hooksFor(def)) {
    for (const entry of hooks.terrainArmor ?? []) {
      for (const t of entry.terrains) out.set(t, Math.max(out.get(t) ?? 0, entry.bonus));
    }
  }
  const frozen = out.size === 0 ? EMPTY_TERRAIN : out;
  terrainArmorCache.set(key, frozen);
  return frozen;
}

/** 有没有哪条能力带了这个布尔标记 */
export function hasFlag(
  def: UnitTypeDef | undefined,
  flag: 'passThrough' | 'crossesWater' | 'airLayer' | 'immuneSplash' | 'noCounter',
  extra?: string[],
): boolean {
  return hooksFor(def, extra).some((h) => h[flag] === true);
}

/** 带时机的钩子字段名 */
export type StagedKey =
  | 'statAttack'
  | 'statArmor'
  | 'armorPhase'
  | 'damage'
  | 'onHit'
  | 'onStrike'
  | 'onTurnStart'
  | 'siegeDamage';

const NONE: never[] = [];
const stagedCache = new Map<string, unknown[]>();

/**
 * 这个兵种身上某一类"带时机钩子"的合集，按 abilities 数组的顺序摊平。
 *
 * 摊平是必要的：一条兵种可能挂三条能力（比如"冲锋 + 狂暴"），
 * 它们的伤害修正要放进同一张表里按 stage 排序，而不是一条能力跑一遍
 * ——跑一遍就没法表达"盾墙在冲锋之后、破甲之前"这种跨能力的先后。
 *
 * 结果缓存到 id 串上：computeDamage 一回合要跑几十次，
 * 每次重新拼一遍数组既浪费又容易在热循环里掉帧。
 */
export function stagedFor<C>(def: UnitTypeDef | undefined, key: StagedKey, extra?: string[]): Staged<C>[] {
  const ids = mergedIds(def, extra);
  if (ids.length === 0) return NONE;
  const ck = `${ids.join('|')}#${key}`;
  const hit = stagedCache.get(ck);
  if (hit) return hit as Staged<C>[];
  const out: Staged<unknown>[] = [];
  for (const h of hooksFor(def)) {
    const list = h[key] as Staged<unknown>[] | undefined;
    if (list) for (const one of list) out.push(one);
  }
  stagedCache.set(ck, out);
  return out as Staged<C>[];
}

/** 能不能被治疗：只要有一条能力写着 healable: false，就不行（机械） */
export function canBeHealed(def: UnitTypeDef | undefined, extra?: string[]): boolean {
  return !hooksFor(def, extra).some((h) => h.healable === false);
}

/** 所有声明了光环的能力，按注册顺序（多条光环会叠加） */
export function aurasOf(def: UnitTypeDef | undefined, extra?: string[]): NonNullable<AbilityHooks['aura']>[] {
  const out: NonNullable<AbilityHooks['aura']>[] = [];
  for (const h of hooksFor(def, extra)) if (h.aura) out.push(h.aura);
  return out;
}

export { hasAbility };
