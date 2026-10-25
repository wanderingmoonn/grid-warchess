/** 战斗计算与预览：所有函数均不修改传入状态。 */
import { hasAbility } from '../abilities.ts';
import { CONFIG } from '../config.ts';
import { activeExpansions } from '../expansions.ts';
import type { City, GameState, Unit } from '../types.ts';
import { distance, tileAt, utype } from './queries.ts';
import { auraBonus } from './modifiers.ts';

/**
 * 对单位的伤害：攻击 − （护甲 + 地形加成），最低 0，然后过一遍扩展钩子。
 * 钩子必须是纯函数——这个函数也会在 UI 的伤害预览里被调用。
 */
export function computeDamage(
  s: GameState,
  attacker: Unit,
  defender: Unit,
  isCounter = false,
): number {
  const at = utype(s, attacker.type);
  const dt = utype(s, defender.type);
  const tile = tileAt(s, defender.x, defender.y);
  const terrainBonus = tile ? CONFIG.terrainDef[tile.terrain] : 0;

  // 允许 0：差四个时代的兵打不动坦克，这是刻意的
  const attackerAura = auraBonus(s, attacker);
  const defenderAura = auraBonus(s, defender);

  let armor = dt.armor + defenderAura.armor + terrainBonus;

  // 扩展改护甲放在破甲之前：这样"额外 N 点护甲"和地形加成是同一种东西，
  // 破甲照样削一半、攻击低于护甲照样是 0 伤害。
  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyArmor) {
      armor = e.hooks.modifyArmor({ state: s, attacker, defender, armor, isCounter });
    }
  }

  if (hasAbility(at, 'armor-pierce')) armor = Math.floor(armor / 2);

  let dmg = Math.max(0, at.atk + attackerAura.atk - armor);

  // 盾墙：本回合没挪窝才生效，站着守的人才硬
  if (hasAbility(dt, 'shield-wall') && !defender.moved) dmg -= 2;

  if (isCounter) dmg = Math.max(0, Math.round(dmg * CONFIG.counterAttackRatio));

  for (const e of activeExpansions(s)) {
    if (e.hooks.modifyDamage) {
      dmg = e.hooks.modifyDamage({ state: s, attacker, defender, damage: dmg, isCounter });
    }
  }

  return Math.max(0, Math.round(dmg));
}

/** 对城市的伤害：只用城市自身护甲，地形加成不重复计算 */
export function damageToCity(attacker: Unit, city: City, s: GameState): number {
  const at = utype(s, attacker.type);
  const armor = hasAbility(at, 'armor-pierce') ? Math.floor(city.armor / 2) : city.armor;
  // 同样允许 0：拿民兵去砸现代城，就是砸不动
  let dmg = Math.max(0, at.atk + auraBonus(s, attacker).atk - armor);
  if (hasAbility(at, 'siege-master')) dmg = Math.round(dmg * 1.5);
  return dmg;
}

/** 预估伤害，给 UI 的攻击预览用，不改变状态 */
export function previewAttack(
  s: GameState,
  attacker: Unit,
  defender: Unit,
): {
  toDefender: number;
  toAttacker: number;
  counter: boolean;
  hits: number;
  toSplash: number;
} {
  const def = utype(s, attacker.type);
  const burst = Math.max(1, def.burst ?? 1);

  // 多段：按顺序算，打死了就不再有后续
  let toDefender = 0;
  let hp = defender.hp;
  let hits = 0;
  while (hits < burst && hp > 0) {
    const one = computeDamage(s, attacker, defender);
    hp -= one;
    toDefender += one;
    hits += 1;
  }

  const survives = hp > 0;
  const range = utype(s, defender.type).range;
  const counter = survives && !hasAbility(def, 'first-strike')
    && distance(attacker, defender) <= range;
  const toAttacker = counter ? computeDamage(s, defender, attacker, true) : 0;

  let toSplash = 0;
  for (const v of splashVictims(s, attacker, defender)) toSplash += v.dmg;

  return { toDefender, toAttacker, counter, hits, toSplash };
}

/**
 * 溅射范围内的敌人：主目标周围的敌人各吃一份打折的伤害。
 *
 * 只打敌人，不打自己人——"炮火误伤"听起来很真实，但在回合制里
 * 它只会变成"我不敢开炮"，而不是"我要算清楚再开炮"。
 */
export function splashVictims(
  s: GameState,
  attacker: Unit,
  defender: Unit,
): Array<{ unit: Unit; dmg: number }> {
  const radius = utype(s, attacker.type).splash ?? 0;
  if (radius <= 0) return [];

  const out: Array<{ unit: Unit; dmg: number }> = [];
  for (const v of s.units) {
    if (v.owner === attacker.owner) continue;
    if (v.id === defender.id) continue;
    if (distance(v, defender) > radius) continue;
    const dmg = Math.floor(computeDamage(s, attacker, v) * CONFIG.splashRatio);
    if (dmg <= 0) continue;
    out.push({ unit: v, dmg });
  }
  return out;
}
