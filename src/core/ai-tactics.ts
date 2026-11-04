/** Tactical estimates use the same movement and damage rules as the game. */
import { activeExpansions } from './expansions.ts';
import { canStrike, computeDamage, distance, effectiveRange, effectiveRangeAgainst, idx, inBounds, reachableTiles, underConstruction, utype, xyOf } from './rules.ts';
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
  /**
   * 两回合威胁：把"**下一回合还够不着、下下回合就够得着**"的敌人也算进来。
   *
   * 为什么需要它：`exposure` 估的是"我站在这儿，下回合能吃多少伤害"。
   * 一个在六格外磨刀的重骑兵对它来说等于不存在，于是 AI 会站着不动、
   * 或者朝那个方向再走一步——两步之后被围住。人对这种局面的判断从来不只看
   * 下一回合，看的是"这波人要扑上来了"。
   *
   * 口径：敌人的射程加上**两回合的移动力**够得着，就算威胁；
   * 伤害按他现在的站位折算再打 `SOON_DAMP` 折——毕竟他还要走过来，
   * 路上可能被拦、可能改主意。地形不参与（纯距离），这一层是**预警**不是账本，
   * 宁可高估。
   */
  soon: (unit: Unit, excludedEnemy?: string) => Exposure;
}

/**
 * "两回合威胁"的折价：够得着但还没到的人，按这个比例计入。
 *
 * 1.0 会和 `exposure` 重复计算，把 AI 压成不敢往前挪的乌龟；
 * 0.3 以下又等于没有。0.55 是"确实威胁、但还没到眼前"的分寸。
 */
const SOON_DAMP = 0.55;

interface FiringOrigins { stationary?: Unit; nearest?: Unit; stacked?: Unit; margin?: number }

/** Each enemy contributes once per square. Mountains, rivers, flight and range apply. */
export function tacticalMap(s: GameState, owner: PlayerId): TacticalMap {
  const grid: Array<Map<string, FiringOrigins>> = Array.from({ length: s.w * s.h }, () => new Map());
  const targetedRange = activeExpansions(s).some(e => e.hooks.modifyRangeAgainst);
  const terrainTiles = [...new Map(s.tiles.map(t => [t.terrain,t])).values()];
  /** 能开火的敌人：`soon()` 要用同一批人，别在两处各筛一遍 */
  const shooters: Unit[] = [];
  for (const enemy of s.units) {
    if (enemy.owner === owner || underConstruction(enemy)) continue;
    const def = utype(s, enemy.type);
    if ((def.atk + (def.magicAtk ?? 0)) <= 0) continue;
    shooters.push(enemy);
    const refreshed = { ...enemy, moved: false, acted: false };
    const positions = [idx(s, enemy.x, enemy.y), ...reachableTiles(s, refreshed).keys()];
    for (const position of positions) {
      const at = xyOf(s, position);
      const projected = { ...refreshed, ...at, moved: position !== idx(s, enemy.x, enemy.y) };
      const ranges = targetedRange ? new Map(terrainTiles.map(t => [t.terrain,effectiveRangeAgainst(s,projected,t)])) : null;
      const range = ranges ? Math.max(...ranges.values()) : effectiveRange(s, projected);
      for (let dy = -range; dy <= range; dy++) {
        for (let dx = -(range-Math.abs(dy)); dx <= range-Math.abs(dy); dx++) {
          const x = at.x+dx, y = at.y+dy;
          if (!inBounds(s,x,y)) continue;
          const targetRange = ranges?.get(s.tiles[idx(s,x,y)]!.terrain) ?? range;
          if (Math.abs(dx)+Math.abs(dy)>targetRange) continue;
          const cell = grid[idx(s,x,y)]!;
          const origins = cell.get(enemy.id) ?? {};
          // Ground/air range differs: retain both stationary and closest moving fire.
          // An overlapping origin is legal across layers but illegal within one layer.
          if (!projected.moved) origins.stationary=projected;
          else if (dx===0 && dy===0) origins.stacked=projected;
          else if (!origins.nearest ||
            (origins.margin ?? -Infinity)<targetRange-Math.abs(dx)-Math.abs(dy)) {
            origins.nearest=projected;
            origins.margin=targetRange-Math.abs(dx)-Math.abs(dy);
          }
          cell.set(enemy.id,origins);
        }
      }
    }
  }
  const cache = new Map<string, Exposure>();
  const soonCache = new Map<string, Exposure>();
  const exposure = (unit: Unit, excludedEnemy?: string): Exposure => {
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
  };
  return {
    exposure,
    soon(unit, excludedEnemy) {
      const key = `${unit.id}:${unit.x}:${unit.y}:${unit.hp}:${excludedEnemy ?? ''}`;
      const found = soonCache.get(key);
      if (found) return found;
      const now = exposure(unit, excludedEnemy);
      let damage = now.damage;
      let count = now.count;
      for (const e of shooters) {
        if (e.id === excludedEnemy) continue;
        const ed = utype(s, e.type);
        const rest = { ...e, moved: false, acted: false };
        const reach = effectiveRange(s, rest) + 2 * Math.max(0, ed.move ?? 0);
        if (distance(e, unit) > reach) continue;
        // 已经算在"下回合"那一份里的不重复计
        if (canStrike(s, rest, unit)) continue;
        damage += computeDamage(s, rest, unit) * Math.max(1, ed.burst ?? 1) * SOON_DAMP;
        count += 1;
      }
      const result = { damage, count, lethal: damage >= unit.hp };
      soonCache.set(key, result);
      return result;
    },
  };
}
