import { economicYield } from './ai-tactics.ts';
import { aiLevelOf } from './ai-meta.ts';
import {
  attacksPerTurn, computeDamage, distance, effectiveRange, effectiveRangeAgainst,
  isAirborne, movePower, splashRadiusOf, tileAt, underConstruction, utype,
} from './rules.ts';
import type { GameState, PlayerId, Unit, UnitTypeDef } from './types.ts';

type Point = { x: number; y: number };
const clamp = (n: number) => Math.max(0, Math.min(1, n));

export interface AirDefense {
  recruit(def: UnitTypeDef, site: Point, price: number): number;
  move(unit: Unit, destination: Point): number;
  priority(target: Unit): number;
}

/** 在己方雾图上预测一次决策期间的空袭。换局面即按新观测重算。 */
export function airDefenseFor(view: GameState, me: PlayerId): AirDefense | null {
  if (aiLevelOf(view) !== 'advanced') return null;
  const airborne = view.units.filter(u => u.owner !== me && isAirborne(view, u) && !underConstruction(u));
  if (!airborne.length) return null;
  const mine = view.units.filter(u => u.owner === me);
  const assets: Point[] = mine.filter(u => economicYield(utype(view, u.type)) > 0);
  for (const c of view.cities) {
    if (c.owner === me && !c.ruined) assets.push({x: c.x + Math.floor(c.size / 2), y: c.y + Math.floor(c.size / 2)});
  }
  const raids = airborne.flatMap(u => {
    const def = utype(view, u.type);
    // 敌人在下次行动前会刷新移动力，刚飞完的单位仍威胁下一回合。
    const speed = movePower(view, {...u, moveSpent: 0});
    const reach = speed + effectiveRange(view, u);
    if (speed < 3 || reach < 5 || def.atk + (def.magicAtk ?? 0) <= 0) return [];
    // 下一回合可接近的地方风险最大，再往外一个移动回合逐渐衰减。
    const risk = (p: Point) => clamp((reach + speed + 1 - distance(u, p)) / speed);
    const priority = assets.reduce((n, p) => Math.max(n, risk(p)), 0);
    return priority > 0 ? [{u, risk, priority, splash: splashRadiusOf(view, u)}] : [];
  });
  if (!raids.length) return null;
  const threat = raids.reduce((a,b) => a.priority * a.u.hp >= b.priority * b.u.hp ? a : b).u;
  const threatHp = utype(view, threat.type).maxHp;
  const sites = assets.map(p => ({x:p.x, y:p.y, risk: Math.max(...raids.map(r => r.risk(p)))})).filter(p => p.risk > 0);
  const targetTile = tileAt(view, threat.x, threat.y);
  function weapon(unit: Unit) {
    const range = effectiveRangeAgainst(view, unit, targetTile) - (isAirborne(view, unit) ? 0 : 1);
    const damage = range > 0 ? computeDamage(view, unit, threat) * attacksPerTurn(view, unit) : 0;
    return {range, fire: clamp(damage / Math.max(1, threatHp * 0.55)) * Math.min(1, unit.hp / utype(view, unit.type).maxHp)};
  }
  const guards = mine.filter(u => {
    const def = utype(view, u.type);
    return !underConstruction(u) && def.atk + (def.magicAtk ?? 0) > 0;
  })
    .map(u => ({u, ...weapon(u)})).filter(g => g.fire > 0);
  const reachFrom = (p: Point, site: Point, range: number) => clamp((range + 2 - distance(p, site)) / 3);
  const cover = (p: Point, omit?: Unit) => guards.reduce((n,g) => n + (g.u === omit ? 0 : g.fire * reachFrom(g.u, p, g.range)), 0);
  const demand = 0.85 + Math.min(2, raids.reduce((n,r) => n + r.priority, 0)) * 0.65;
  const gaps = sites.map(site => ({...site, cover: cover(site)}));
  const shortage = Math.max(...gaps.map(p => p.risk * clamp(1 - p.cover / demand)));
  const threatRisk = new Map(raids.map(r => [r.u.id, r.priority]));
  const guardById = new Map(guards.map(g => [g.u.id, g]));
  const riskAt = (p: Point) => Math.max(...raids.map(r => r.risk(p)));
  const blasts = raids.filter(r => r.splash > 0);
  function splashExposure(p: Point, unit: Unit): number {
    let worst = 0;
    for (const raid of blasts) {
      const risk = raid.risk(p);
      if (!risk) continue;
      const adjacent = mine.filter(u => u.id !== unit.id && distance(u, p) <= raid.splash).length;
      worst = Math.max(worst, risk * Math.min(3, adjacent));
    }
    return worst;
  }
  function position(unit: Unit, p: Point): number {
    const risk = riskAt(p);
    const spacing = 9 * splashExposure(p, unit);
    if (economicYield(utype(view, unit.type)) > 0) {
      return -risk * (38 - 30 * clamp(cover(p, unit) / demand)) - spacing;
    }
    const guard = guardById.get(unit.id);
    if (!guard) return -spacing;
    let value = 0;
    for (const site of gaps) {
      // 已有别的火力覆盖的地方，让多余的兵继续推进。
      const otherFire = site.cover - guard.fire * reachFrom(unit, site, guard.range);
      const gap = site.risk * clamp(1 - otherFire / demand);
      value = Math.max(value, gap * guard.fire * (reachFrom(p, site, guard.range) + 0.3 / (1 + distance(p, site))));
    }
    return 62 * value - spacing;
  }
  const current = new Map<string, number>();
  return {
    priority: target => threatRisk.get(target.id) ?? 0,
    move(unit, destination) {
      let base = current.get(unit.id);
      if (base === undefined) {
        base = position(unit, unit);
        current.set(unit.id, base);
      }
      return position(unit, destination) - base;
    },
    recruit(def, site, price) {
      if (def.category !== 'combat' || def.domain === 'water') return 0;
      const prospect: Unit = {id:'air-defense-prospect', type:def.id, owner:me, x:site.x, y:site.y, hp:def.maxHp,
        kills:0, moved:false, acted:false, ammoLeft:def.ammo};
      const gun = weapon(prospect);
      const reach = Math.min(1.5, 0.45 + gun.range * 0.24 + def.move * 0.06);
      const efficiency = Math.min(1.5, Math.sqrt(135 / Math.max(1, price)));
      const near = Math.max(...gaps.map(p => p.risk / (1 + distance(site, p) * 0.11)));
      return 110 * shortage * near * gun.fire * reach * efficiency;
    },
  };
}
