/**
 * 战斗与回合结算的"行为快照"。
 *
 * 用途只有一个：重构前后各跑一次，diff 必须为空。
 * 它不是单元测试，是**等价性证据**——把能力的实现从 rules.ts 搬到扩展里，
 * 最怕的就是某个取整、某个顺序悄悄挪了一格，而常规用例刚好没覆盖到。
 *
 *   node --experimental-strip-types scripts/snapshot-behavior.ts before.json
 *   ...重构...
 *   node --experimental-strip-types scripts/snapshot-behavior.ts after.json
 *   diff before.json after.json
 *
 * 覆盖范围：
 *   · computeDamage：进攻方 × 防守方 × 三种地形 × 两种距离 × 两种血量
 *   · effectiveStats / movePower / visionOf / reachableTiles / threatTiles
 *   · isHiddenFrom（潜行、隐匿）
 *   · canStandAt（掠水、掠空）
 *   · damageToCity
 *   · 回合开始结算（再生、休整、光环、净化、修缮、筑墙、布雷、召唤……）
 */

import { writeFileSync } from 'node:fs';

import { EXPANSIONS } from '../src/core/expansions.ts';
import {
  applyAction,
  canStandAt,
  citiesOf,
  computeDamage,
  damageToCity,
  effectiveStats,
  isHiddenFrom,
  movePower,
  previewAttack,
  reachableTiles,
  threatTiles,
  visionOf,
} from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { GameState, PlayerId, Terrain, Unit } from '../src/core/types.ts';

let seq = 0;

function freshState(): GameState {
  const s = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: 12,
      startEra: 5,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: EXPANSIONS.map((e) => e.id),
    },
    998877,
  );
  s.fog = true;
  s.units = [];
  s.turn = 1;
  s.current = 'A';
  // 地形抹平成平原：这份快照要的是"能力"，不是地图随机
  for (const t of s.tiles) t.terrain = 'plain';
  return s;
}

function mk(
  s: GameState,
  owner: PlayerId,
  type: string,
  x: number,
  y: number,
  hpRatio = 1,
  extra: Partial<Unit> = {},
): Unit {
  const def = s.unitTypes[type]!;
  const u: Unit = {
    id: `s${seq++}`,
    type,
    owner,
    x,
    y,
    hp: Math.max(1, Math.round(def.maxHp * hpRatio)),
    kills: 0,
    moved: false,
    acted: false,
    ...extra,
  };
  s.units.push(u);
  return u;
}

function setTile(s: GameState, x: number, y: number, terrain: Terrain): void {
  const tile = s.tiles[y * s.w + x];
  if (tile) tile.terrain = terrain;
}

/** 兵种名单：带能力的全要，另加每个时代的白板代表 */
function roster(s: GameState): string[] {
  const ids = Object.keys(s.unitTypes);
  const withAbility = ids.filter((id) => (s.unitTypes[id]!.abilities ?? []).length > 0);
  const sample = ids.filter((_, i) => i % 4 === 0);
  return Array.from(new Set([...withAbility, ...sample])).sort();
}

function combatMatrix(s: GameState, list: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const terrains: Terrain[] = ['plain', 'forest', 'hill'];

  for (const a of list) {
    if ((s.unitTypes[a]!.atk ?? 0) <= 0) continue;
    for (const b of list) {
      for (const terrain of terrains) {
        for (const gap of [1, 2]) {
          for (const ratio of [1, 0.5]) {
            const st = freshState();
            setTile(st, 5 + gap, 5, terrain);
            const au = mk(st, 'A', a, 5, 5);
            const bu = mk(st, 'B', b, 5 + gap, 5, ratio);
            const key = `${a}|${b}|${terrain}|${gap}|${ratio}`;
            out[key] = computeDamage(st, au, bu);
            out[`${key}|c`] = computeDamage(st, au, bu, true);
            const pv = previewAttack(st, au, bu);
            out[`${key}|hit`] = pv.toDefender;
            out[`${key}|cnt`] = pv.toAttacker;
          }
        }
      }
    }
  }
  return out;
}

function statsOf(_s: GameState, list: string[]): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const id of list) {
    for (const terrain of ['plain', 'forest', 'hill'] as Terrain[]) {
      const st = freshState();
      setTile(st, 5, 5, terrain);
      const u = mk(st, 'A', id, 5, 5);
      // 一个相邻友军 + 一个相邻敌军：把光环、威吓、群势、咒域都带进来
      mk(st, 'A', 'militia', 4, 5);
      mk(st, 'B', 'militia', 6, 5);
      const e = effectiveStats(st, u);
      out[`${id}|${terrain}|atk`] = e.atk;
      out[`${id}|${terrain}|armor`] = e.armor;
      out[`${id}|${terrain}|move`] = e.move;
      out[`${id}|${terrain}|power`] = movePower(st, u);
      out[`${id}|${terrain}|vision`] = visionOf(st, u);
      out[`${id}|${terrain}|reach`] = reachableTiles(st, u).size;
      out[`${id}|${terrain}|threat`] = threatTiles(st, u).size;
      out[`${id}|${terrain}|stats`] = e.atkItems
        .map((i) => `${i.label}:${i.delta}`)
        .concat(e.armorItems.map((i) => `${i.label}:${i.delta}`))
        .join(',');
    }
  }
  return out;
}

function stealthChecks(_s: GameState, list: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const id of list) {
    for (const gap of [1, 2]) {
      const st = freshState();
      setTile(st, 5, 5, 'forest');
      const hidden = mk(st, 'A', id, 5, 5);
      mk(st, 'B', 'scout', 5 + gap, 5);
      out[`${id}|gap${gap}`] = isHiddenFrom(st, hidden, 'B');
      const moved = freshState();
      setTile(moved, 5, 5, 'forest');
      const h2 = mk(moved, 'A', id, 5, 5, 1, { moved: true, acted: true });
      mk(moved, 'B', 'scout', 5 + gap, 5);
      out[`${id}|gap${gap}|moved`] = isHiddenFrom(moved, h2, 'B');
    }
  }
  return out;
}

function standChecks(_s: GameState, list: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const id of list) {
    for (const terrain of ['water', 'mountain', 'plain'] as Terrain[]) {
      const st = freshState();
      setTile(st, 6, 6, terrain);
      out[`${id}|${terrain}`] = canStandAt(st, 6, 6, id);
    }
    out[`${id}|stack`] = (() => {
      const st = freshState();
      mk(st, 'B', 'militia', 6, 6);
      return canStandAt(st, 6, 6, id);
    })();
  }
  return out;
}

function siegeChecks(s: GameState, list: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of list) {
    if ((s.unitTypes[id]!.atk ?? 0) <= 0) continue;
    const st = freshState();
    const u = mk(st, 'A', id, 4, 4);
    const city = citiesOf(st, 'B')[0];
    if (!city) continue;
    out[id] = damageToCity(u, city, st);
  }
  return out;
}

/** 回合开始那一串结算：光环、净化、修缮、筑墙、布雷、召唤、再生、毒烧 */
function turnStartChecks(s: GameState, list: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const interesting = list.filter((id) => {
    const ab = s.unitTypes[id]!.abilities ?? [];
    return ab.some((a) =>
      [
        'heal-aura',
        'purge',
        'purge-greater',
        'repair',
        'build-wall',
        'trap',
        'summoner',
        'regenerate',
        'regenerate-plus',
        'bloodlust',
        'heal',
        'machine',
        'steal-gold',
        'kamikaze',
        'rebirth',
        'split',
        'kill-rush',
        'lifesteal',
        'knockback',
        'first-strike',
      ].includes(a),
    );
  });

  for (const id of interesting) {
    let st = freshState();
    const city = citiesOf(st, 'A')[0];
    if (city) city.hp = Math.max(1, city.maxHp - 30);
    const hero = mk(st, 'A', id, 4, 4, 0.5);
    mk(st, 'A', 'archer', 3, 4, 0.4);
    mk(st, 'B', 'militia', 5, 4);
    // 贴一层负面状态，净化类能力才有事可做
    hero.status = { poison: 3, burn: 1, slow: 2, curse: 3 };
    hero.moved = true;
    hero.acted = true;

    const acts: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const r = applyAction(st, { type: 'END_TURN' });
      if (!r.ok) {
        acts.push(`endTurnFailed:${r.reason}`);
        break;
      }
      st = r.state;
      if (i === 0) {
        st.current = 'B';
        const r2 = applyAction(st, { type: 'END_TURN' });
        if (!r2.ok) {
          acts.push(`endTurnFailed:${r2.reason}`);
          break;
        }
        st = r2.state;
      }
    }
    const snap = st.units
      .map((u) => `${u.owner}:${u.type}:${u.hp}:${JSON.stringify(u.status ?? {})}`)
      .sort()
      .join(';');
    const cities = st.cities.map((c) => `${c.owner}:${c.hp}`).sort().join(';');
    out[id] = `${snap}#${cities}#${st.log.length}#${acts.join(',')}`;
  }
  return out;
}

const base = freshState();
const list = roster(base);
const report = {
  units: list.length,
  combat: combatMatrix(base, list),
  stats: statsOf(base, list),
  stealth: stealthChecks(base, list),
  stand: standChecks(base, list),
  siege: siegeChecks(base, list),
  turnStart: turnStartChecks(base, list),
};

const path = process.argv[2] ?? 'snapshot.json';
writeFileSync(path, `${JSON.stringify(report, null, 1)}\n`, 'utf8');
console.log(
  `写入 ${path}：兵种 ${list.length}，伤害点 ${Object.keys(report.combat).length}，` +
    `数值点 ${Object.keys(report.stats).length}，回合开始 ${Object.keys(report.turnStart).length}`,
);
