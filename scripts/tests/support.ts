// @ts-nocheck

import { CITY, CONFIG, UNIT_TYPES, eraDef, isPseudoUnit, passable } from '../../src/core/config.ts';

import assert from 'node:assert/strict';
import { cityTiles, idx, refreshMemory } from '../../src/core/rules.ts';
import { createMatch } from '../../src/core/setup.ts';
import type { MatchConfig, GameState, PlayerId, Unit } from '../../src/core/types.ts';

export const stats = { passed: 0, failed: 0 };

export function test(name: string, fn: () => void): void {
  try {
    fn();
    stats.passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    stats.failed += 1;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  FAIL ${name}\n       ${msg}`);
  }
}

export { assert };

// 3. 配置与基础局
export const BASE = {
  size: 16,
  startEra: 1,
  aiOpponent: false,
  aiAlly: false,
  expansionIds: [],
  enabledUnits: Object.keys(UNIT_TYPES),
};

export function clearDecor(s) {
  for (const t of s.tiles) {
    if (t.terrain === 'forest' || t.terrain === 'hill') t.terrain = 'plain';
  }
}

/**
 * 把城市钉回四角（A 在南、B 在北）。
 *
 * 城市位置现在是浮动的（见 mapgen.planCities），而规则测试里有一批写死的
 * 坐标——奴隶站 (5,5)、河挖在 x=8、桥架在 (8,7)。新城飘到这些格子上，
 * 测试就会因为"那里是敌方城市"而不是"规则不允许"而失败。
 *
 * 规则测试不该受地图随机影响，所以这里统一把城挪回老的四角布局。
 * 地图本身的多样性由下面那些直接调 generateLayout 的用例负责。
 */
export function pinCities(s: GameState): void {
  // 一家一个角。两人局每家两座城，所以 A/B 各有两个位；
  // 三人四人局每家只有一座（这正是那个模式的定义），C/D 就落在剩下两个角上。
  const spots: Record<PlayerId, Array<{ x: number; y: number }>> = {
    A: [
      { x: 1, y: s.h - 3 },
      { x: s.w - 3, y: s.h - 3 },
    ],
    B: [
      { x: 1, y: 1 },
      { x: s.w - 3, y: 1 },
    ],
    C: [
      { x: s.w - 3, y: s.h - 3 },
      { x: 1, y: s.h - 3 },
    ],
    D: [
      { x: s.w - 3, y: 1 },
      { x: 1, y: 1 },
    ],
  };
  const used: Record<PlayerId, number> = { A: 0, B: 0, C: 0, D: 0 };

  // 必须两遍：先全部清空，再全部放置。
  // 一遍到底的话，后一座城"清自己的旧位置"会抹掉前一座城刚放下的格子——
  // 城市位置改成随机撒点之后，旧位置和新位置撞上的概率不低（20×20 就能撞）。
  for (const c of s.cities) {
    for (const t of cityTiles(c)) {
      const tile = s.tiles[idx(s, t.x, t.y)];
      if (!tile) continue;
      tile.cityId = null;
      if (tile.terrain === 'city') tile.terrain = 'plain';
    }
  }
  for (const c of s.cities) {
    const p = spots[c.owner][used[c.owner]++] ?? { x: 1, y: 1 };
    c.x = p.x;
    c.y = p.y;
    for (const t of cityTiles(c)) {
      const tile = s.tiles[idx(s, t.x, t.y)];
      if (!tile) continue;
      tile.cityId = c.id;
      tile.terrain = 'city';
    }
  }

  // 挪城之后可能有人站在别人的城里，清掉
  s.units = s.units.filter((u) => {
    const t = s.tiles[idx(s, u.x, u.y)];
    return !(t?.cityId && s.cities.some((c) => c.id === t.cityId && c.owner !== u.owner));
  });
}

export function fresh(extra?: Partial<MatchConfig>, seed = 12345): GameState {
  const s = createMatch({ ...BASE, ...extra }, seed);
  clearDecor(s);
  pinCities(s);
  refreshMemory(s);
  return s;
}

/** 手动摆一个单位（开局编制里没有水军和工程队） */
export function place(s: GameState, owner: 'A' | 'B', type: string, x: number, y: number): Unit {
  // 先查**本局**的兵种表，再退回原版表：扩展包的兵只存在于开了那个包的对局里，
  // 拿 UNIT_TYPES 去找一律找不到。上限（hp）也从同一处读，别混用两张表。
  const def = s.unitTypes[type] ?? UNIT_TYPES[type];
  assert.ok(def, `没有 ${type} 这个兵种`);
  const u: Unit = {
    id: `t${s.units.length + 1}`,
    type,
    owner,
    x,
    y,
    hp: def.maxHp,
    kills: 0,
    moved: false,
    acted: false,
  };
  s.units = s.units.filter((k) => !(k.x === x && k.y === y));
  s.units.push(u);
  return u;
}

export function place2(s, owner, type, x, y) {
  const def = s.unitTypes[type];
  assert.ok(def, `本局没有 ${type} 这个兵种`);
  s.units = s.units.filter((k) => !(k.x === x && k.y === y));
  const u: Unit = {
    id: `k${s.nextUnitSeq++}`,
    type,
    owner,
    x,
    y,
    hp: def.maxHp,
    kills: 0,
    moved: false,
    acted: false,
  };
  s.units.push(u);
  return u;
}

export function arena(s) {
  s.units = [];
  s.cities = [];
  for (const t of s.tiles) t.cityId = null;
  return s;
}

