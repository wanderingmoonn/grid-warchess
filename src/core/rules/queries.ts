/** 棋盘和实体查询。只读取状态，不依赖行动处理器。 */
import type { City, GameState, PlayerId, Tile, Unit, UnitTypeDef } from '../types.ts';

/** 四方向移动。不用八方向是为了让移动力有真实取舍，斜穿会削弱地形作用。 */
export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * 这一格是不是临水。
 *
 * 桥面也算"临水"：桥底下就是河，军营扎在桥头是有水可用的。
 * 做成对外导出的判断，是因为它不只是一条合法性检查——
 * 地图生成、AI 选址、界面高亮都要用同一套口径，各写一份必然走偏。
 */
export function adjacentToWater(s: GameState, x: number, y: number): boolean {
  return DIRS.some(([dx, dy]) => {
    const t = tileAt(s, x + dx, y + dy);
    return !!t && (t.terrain === 'water' || t.terrain === 'bridge');
  });
}

export function other(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}

/** 从本局的兵种表里取定义（不是全局表，因为对局可能只启用了部分兵种） */
export function utype(s: GameState, id: string): UnitTypeDef {
  const def = Object.hasOwn(s.unitTypes, id) ? s.unitTypes[id] : undefined;
  if (!def) throw new Error(`本局没有兵种: ${id}`);
  return def;
}

export function idx(s: GameState, x: number, y: number): number {
  return y * s.w + x;
}

export function inBounds(s: GameState, x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < s.w && y < s.h;
}

export function xyOf(s: GameState, i: number): { x: number; y: number } {
  return { x: i % s.w, y: Math.floor(i / s.w) };
}

export function tileAt(s: GameState, x: number, y: number): Tile | null {
  if (!inBounds(s, x, y)) return null;
  return s.tiles[idx(s, x, y)] ?? null;
}

export function unitAt(s: GameState, x: number, y: number): Unit | undefined {
  return s.units.find((u) => u.x === x && u.y === y);
}

export function unitById(s: GameState, id: string): Unit | undefined {
  return s.units.find((u) => u.id === id);
}

export function unitsOf(s: GameState, p: PlayerId): Unit[] {
  return s.units.filter((u) => u.owner === p);
}

/**
 * 编制计算所有非建筑单位，货舱里的陆军也包含在内。
 *
 * 以前的写法是"谁在场上都算一个编制"，于是盖了四座磨坊 + 两座军营，
 * 编制就先去掉了六个，产线直接堵死——模拟里出现过一方 24 个单位里只有 4 个能打仗、
 * 金库压着一万二，然后就再也造不出兵、也打不下城，两边耗到第 200 回合。
 * 建筑本来就不该住人：它是工地，不是部队。
 */
export function armySize(s: GameState, p: PlayerId): number {
  // 登船只是改变位置，不能借此腾出编制再征兵。
  const count = (units: Unit[]): number => units.reduce((total, u) =>
    total + (u.owner === p && utype(s, u.type).category !== 'building' ? 1 : 0)
      + count(u.cargo ?? []), 0);
  return count(s.units);
}

export function cityById(s: GameState, id: string): City | undefined {
  return s.cities.find((c) => c.id === id);
}

/** 某格属于哪座城市 */
export function cityAt(s: GameState, x: number, y: number): City | undefined {
  const tile = tileAt(s, x, y);
  if (!tile?.cityId) return undefined;
  return cityById(s, tile.cityId);
}

/** 某方控制的城市 */
export function citiesOf(s: GameState, p: PlayerId): City[] {
  return s.cities.filter((c) => c.owner === p);
}

/** 城市占的全部格子坐标 */
export function cityTiles(city: City): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let dy = 0; dy < city.size; dy++) {
    for (let dx = 0; dx < city.size; dx++) out.push({ x: city.x + dx, y: city.y + dy });
  }
  return out;
}

/** 单位到城市方块的最短曼哈顿距离 */
export function distToCity(unit: { x: number; y: number }, city: City): number {
  const cx = Math.min(Math.max(unit.x, city.x), city.x + city.size - 1);
  const cy = Math.min(Math.max(unit.y, city.y), city.y + city.size - 1);
  return Math.abs(unit.x - cx) + Math.abs(unit.y - cy);
}

/** 曼哈顿距离。移动和攻击统一用它，避免"能斜着打但斜着走不过去"的怪事。 */
export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function cloneState(s: GameState): GameState {
  return structuredClone(s);
}

export function canMove(u: Unit): boolean {
  return !u.moved;
}

export function canAttack(u: Unit): boolean {
  return !u.acted;
}
