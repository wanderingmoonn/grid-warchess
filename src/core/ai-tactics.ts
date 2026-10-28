/** Tactical estimates use the same movement and damage rules as the game. */
import { canStrike, computeDamage, effectiveRange, idx, inBounds, reachableTiles, underConstruction, utype, xyOf } from './rules.ts';
import type { GameState, PlayerId, Unit, UnitTypeDef } from './types.ts';

export function economicYield(def: UnitTypeDef): number {
  return Math.max(def.income ?? 0, ...Object.values(def.incomeByTerrain ?? {}).map(n => n ?? 0), 0)
    + Object.values(def.yield ?? {}).reduce<number>((sum,n) => sum + (n ?? 0), 0);
}

export function unitValue(s: GameState, unit: Unit): number {
  const def = utype(s, unit.type);
  return Math.max(20, def.cost + (def.hero ? (def.unlockCost ?? 0) * 0.4 : 0) + economicYield(def) * 5);
}

export interface Exposure { damage: number; count: number; lethal: boolean }
export interface TacticalMap {
  exposure: (unit: Unit, excludedEnemy?: string) => Exposure;
}

interface FiringOrigins { stationary?: Unit; nearest?: Unit; stacked?: Unit }

/** Each enemy contributes once per square. Mountains, rivers, flight and range apply. */
export function tacticalMap(s: GameState, owner: PlayerId): TacticalMap {
  const grid: Array<Map<string, FiringOrigins>> = Array.from({ length: s.w * s.h }, () => new Map());
  for (const enemy of s.units) {
    if (enemy.owner === owner || underConstruction(enemy)) continue;
    const def = utype(s, enemy.type);
    if ((def.atk + (def.magicAtk ?? 0)) <= 0) continue;
    const refreshed = { ...enemy, moved: false, acted: false };
    const positions = [idx(s, enemy.x, enemy.y), ...reachableTiles(s, refreshed).keys()];
    for (const position of positions) {
      const at = xyOf(s, position);
      const projected = { ...refreshed, ...at, moved: position !== idx(s, enemy.x, enemy.y) };
      const range = effectiveRange(s, projected);
      for (let dy = -range; dy <= range; dy++) {
        for (let dx = -(range-Math.abs(dy)); dx <= range-Math.abs(dy); dx++) {
          const x = at.x+dx, y = at.y+dy;
          if (!inBounds(s,x,y)) continue;
          const cell = grid[idx(s,x,y)]!;
          const origins = cell.get(enemy.id) ?? {};
          // Ground/air range differs: retain both stationary and closest moving fire.
          // An overlapping origin is legal across layers but illegal within one layer.
          if (!projected.moved) origins.stationary=projected;
          else if (dx===0 && dy===0) origins.stacked=projected;
          else if (!origins.nearest || Math.abs(origins.nearest.x-x)+Math.abs(origins.nearest.y-y)>Math.abs(dx)+Math.abs(dy)) {
            origins.nearest=projected;
          }
          cell.set(enemy.id,origins);
        }
      }
    }
  }
  const cache = new Map<string, Exposure>();
  return {
    exposure(unit, excludedEnemy) {
      const key = `${unit.id}:${unit.x}:${unit.y}:${unit.hp}:${unit.moved}:${excludedEnemy ?? ''}`;
      const found = cache.get(key);
      if (found) return found;
      const hits: number[] = [];
      for (const [enemyId,origins] of grid[idx(s,unit.x,unit.y)] ?? []) {
        if (enemyId === excludedEnemy) continue;
        let hit=0;
        for (const attacker of [origins.stationary,origins.nearest,origins.stacked]) {
          if (!attacker || !canStrike(s,attacker,unit)) continue;
          const def = utype(s,attacker.type);
          hit=Math.max(hit,computeDamage(s,attacker,unit)*Math.max(1,def.burst ?? 1));
        }
        if (hit > 0) hits.push(hit);
      }
      hits.sort((a,b) => b-a);
      // The first attackers can focus fire; distant followers may be blocked by them.
      const damage = hits.reduce((n,d,i) => n+d*(i < 2 ? 1 : 0.55),0);
      const result = { damage, count: hits.length, lethal: damage >= unit.hp };
      cache.set(key,result);
      return result;
    },
  };
}
