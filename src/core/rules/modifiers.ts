/** 单位的基础数值与扩展修正，供规则、预览和 AI 共用。 */
import { hasAbility } from '../abilities.ts';
import { activeExpansions } from '../expansions.ts';
import type { GameState, PlayerId, Unit, UnitTypeDef } from '../types.ts';
import { distance, utype } from './queries.ts';

/**
 * 相邻友军提供的光环加成。
 *
 * 只加不乘，也不递归——否则两个指挥光环互相加成会失控。
 */
export function auraBonus(s: GameState, unit: Unit): { atk: number; armor: number } {
  let atk = 0;
  let armor = 0;
  for (const ally of s.units) {
    if (ally.id === unit.id || ally.owner !== unit.owner) continue;
    if (distance(ally, unit) !== 1) continue;
    const d = utype(s, ally.type);
    if (hasAbility(d, 'aura-command')) atk += 2;
    if (hasAbility(d, 'aura-armor')) armor += 2;
  }
  return { atk, armor };
}

/** 算上扩展规则后的移动力。建筑（move 0）永远是 0，也不吃加速。 */
export function movePower(s: GameState, unit: Unit): number {
  const base = utype(s, unit.type).move;
  if (base <= 0) return 0;
  let move = base;
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyMove) move = e.hooks.modifyMove({ state: s, unit, move });
  }
  return Math.max(1, move);
}

/** 算上扩展规则后的视野半径 */
export function visionOf(s: GameState, unit: Unit): number {
  const selfDef = utype(s, unit.type);
  let r = selfDef.vision;
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyVision) r = e.hooks.modifyVision({ state: s, player: unit.owner, base: r });
  }
  return Math.max(1, r);
}

/** 算上扩展规则后的兵种造价 */
export function recruitCost(s: GameState, player: PlayerId, def: UnitTypeDef): number {
  let cost = def.cost;
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyCost) cost = e.hooks.modifyCost({ state: s, player, unitType: def, cost });
  }
  return Math.max(0, cost);
}
