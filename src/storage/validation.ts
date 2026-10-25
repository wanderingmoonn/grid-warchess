/** Shared boundary checks for local saves, imported files and cloud snapshots. */
import { MAX_ERA, ORDER_UPGRADE } from '../core/config.ts';
import type { GameState, PlayerId } from '../core/types.ts';
import { isRecord as isObject, isUnitTypeDef } from '../core/validation.ts';
export { isRecord as isObject } from '../core/validation.ts';

const terrains = new Set(['plain', 'forest', 'hill', 'water', 'mountain', 'bridge', 'city']);

export function isPlayerId(value: unknown): value is PlayerId {
  return value === 'A' || value === 'B';
}

function integer(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function optional(value: unknown, check: (value: unknown) => boolean): boolean {
  return value === undefined || check(value);
}

/**
 * Validate persisted v4/v5 data before migration or use by a renderer/rule.
 * A v5 save must contain the current turn's production ledger; omitting it must
 * never grant another production action after a refresh.
 * This is corruption detection, not a substitute for server-side rule validation.
 */
export function isValidState(value: unknown): value is GameState {
  if (!isObject(value) || (value.version !== 4 && value.version !== 5)) return false;
  const s = value;
  if (!integer(s.w, 1) || !integer(s.h, 1) || !Number.isSafeInteger(s.w * s.h)) return false;
  if (!Number.isSafeInteger(s.seed) || !integer(s.turn, 1) || !integer(s.nextUnitSeq, 1)) return false;
  const { w, h, turn, nextUnitSeq } = s;
  if (!isPlayerId(s.current) || (s.winner !== null && !isPlayerId(s.winner)
    && !(s.version === 5 && s.winner === 'draw')) || typeof s.fog !== 'boolean') return false;
  if (s.resultReason !== undefined) {
    if (s.winner === null) return false;
    switch (s.resultReason) {
      case 'conquest': case 'legacy':
        if (!isPlayerId(s.winner)) return false;
        break;
      case 'no-cities':
        if (s.winner !== 'draw') return false;
        break;
      case 'turn-limit': break;
      default: return false;
    }
  }
  if (!Array.isArray(s.tiles) || s.tiles.length !== s.w * s.h || !Array.isArray(s.units) || !Array.isArray(s.cities)) return false;
  if (!isObject(s.config) || !isObject(s.unitTypes) || !isObject(s.players) || !isObject(s.memory)) return false;

  const config = s.config;
  if (!integer(config.size, 1) || config.size !== s.w || s.w !== s.h) return false;
  if (!integer(config.startEra, 1) || config.startEra > MAX_ERA) return false;
  if (typeof config.aiAlly !== 'boolean' || typeof config.aiOpponent !== 'boolean') return false;
  if (!strings(config.expansionIds) || !strings(config.enabledUnits)) return false;
  if (!optional(config.aiLevel, (v) => v === 'basic' || v === 'advanced')) return false;
  if (!optional(config.commanderMode, (v) => typeof v === 'boolean')) return false;
  if (!optional(config.noFirstIncome, (v) => typeof v === 'boolean')) return false;
  if (!optional(config.secondGoldBonus, nonnegative)) return false;
  if (!optional(config.mapStyle, (v) => ['random', 'river-h', 'river-v', 'ridge', 'open'].includes(String(v)))) return false;
  if (!optional(config.mapSymmetry, (v) => v === 'fair' || v === 'mirror')) return false;

  if (s.version === 5) {
    const production = s.turnProduction;
    if (!isObject(production) || production.turn !== turn || production.player !== s.current
      || !integer(production.recruited) || !integer(production.upgraded)) return false;
    if (config.commanderMode && production.recruited + production.upgraded > 1) return false;
    if (!optional(production.legacyLocked, (v) => typeof v === 'boolean')) return false;
    if (production.legacyLocked === true && (!config.commanderMode
      || production.recruited !== 1 || production.upgraded !== 0)) return false;
  }

  const unitTypes = s.unitTypes;
  if (Object.keys(unitTypes).length === 0) return false;
  if (!Object.entries(unitTypes).every(([id, def]) => isUnitTypeDef(def) && def.id === id)) return false;
  const hasType = (id: unknown): id is string => typeof id === 'string' && Object.hasOwn(unitTypes, id);
  if (!config.enabledUnits.every(hasType)) return false;

  const inBounds = (x: unknown, y: unknown): boolean => integer(x) && integer(y) && x < w && y < h;
  const cityIds = new Set<string>();
  const cityTiles = new Map<number, string>();
  for (const city of s.cities) {
    if (!isObject(city) || typeof city.id !== 'string' || !city.id || cityIds.has(city.id)) return false;
    if (!isPlayerId(city.owner) || !inBounds(city.x, city.y) || !integer(city.size, 1)) return false;
    if ((city.x as number) + city.size > s.w || (city.y as number) + city.size > s.h) return false;
    if (!integer(city.era, 1) || city.era > MAX_ERA || !nonnegative(city.armor)) return false;
    if (!nonnegative(city.hp) || !nonnegative(city.maxHp) || city.hp <= 0 || city.hp > city.maxHp) return false;
    if (!optional(city.capturedTurn, (v) => integer(v, 1) && v <= turn)) return false;
    cityIds.add(city.id);
    for (let y = city.y as number; y < (city.y as number) + city.size; y++) {
      for (let x = city.x as number; x < (city.x as number) + city.size; x++) {
        const index = y * w + x;
        if (cityTiles.has(index)) return false;
        cityTiles.set(index, city.id);
      }
    }
  }
  if (!s.tiles.every((tile, index) => isObject(tile) && terrains.has(String(tile.terrain)) &&
    (cityTiles.has(index) ? tile.terrain === 'city' && tile.cityId === cityTiles.get(index)
      : tile.terrain !== 'city' && tile.cityId === null))) return false;

  const ids = new Set<string>();
  const occupied = new Set<number>();
  const validUnit = (unit: unknown, depth = 0): boolean => {
    if (!isObject(unit) || typeof unit.id !== 'string' || !unit.id || ids.has(unit.id) || !hasType(unit.type)) return false;
    if (!isPlayerId(unit.owner) || !inBounds(unit.x, unit.y) || !nonnegative(unit.hp) || unit.hp <= 0) return false;
    if (!integer(unit.kills) || typeof unit.moved !== 'boolean' || typeof unit.acted !== 'boolean') return false;
    const sequence = /^u([1-9]\d*)$/.exec(unit.id);
    if (sequence && Number(sequence[1]) >= nextUnitSeq) return false;
    if (depth === 0) {
      const index = (unit.y as number) * w + (unit.x as number);
      if (occupied.has(index)) return false;
      occupied.add(index);
    }
    ids.add(unit.id);
    // Transported land units cannot themselves transport another unit.
    if (unit.cargo !== undefined) {
      if (!Array.isArray(unit.cargo) || depth > 0 && unit.cargo.length > 0) return false;
      if (!unit.cargo.every((cargo) => isObject(cargo) && cargo.owner === unit.owner && validUnit(cargo, depth + 1))) return false;
    }
    return true;
  };
  if (!s.units.every((unit) => validUnit(unit))) return false;

  for (const player of ['A', 'B'] as const) {
    const data = s.players[player];
    if (!isObject(data) || data.id !== player || typeof data.name !== 'string' || !nonnegative(data.gold)) return false;
    const memory = s.memory[player];
    if (!isObject(memory) || !Array.isArray(memory.known)) return false;
    if (!memory.known.every((u) => isObject(u) && typeof u.id === 'string' && hasType(u.type) &&
      inBounds(u.x, u.y) && integer(u.seenAt, 1) && u.seenAt <= turn)) return false;
  }
  if (!Array.isArray(s.log) || !s.log.every((entry) => isObject(entry) && integer(entry.turn, 1) &&
    entry.turn <= turn && isPlayerId(entry.player) && typeof entry.text === 'string')) return false;
  if (!optional(s.aiControl, (v) => isObject(v) && Object.entries(v).every(([key, enabled]) =>
    isPlayerId(key) && typeof enabled === 'boolean'))) return false;
  if (!optional(s.orders, (v) => isObject(v) && Object.entries(v).every(([key, queue]) =>
    isPlayerId(key) && strings(queue) && queue.every((id) => id === '' || id === ORDER_UPGRADE || hasType(id))))) return false;
  return true;
}
