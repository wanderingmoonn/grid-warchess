/** Runtime checks shared by imported unit libraries and saved matches. */
import type { UnitTypeDef } from './types.ts';

const TERRAINS = new Set(['plain', 'forest', 'hill', 'water', 'mountain', 'bridge', 'city']);
const CATEGORIES = new Set(['combat', 'economy', 'builder', 'building']);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value)
    && !['__proto__', 'prototype', 'constructor'].includes(value);
}

/** Validate data, without imposing balance limits on a player's custom units. */
export function isUnitTypeDef(value: unknown): value is UnitTypeDef {
  if (!isRecord(value) || !identifier(value.id)) return false;
  if (typeof value.name !== 'string' || !value.name.trim()
    || typeof value.short !== 'string' || !value.short.trim()) return false;
  if (!Number.isInteger(value.era) || (value.era as number) < 1 || (value.era as number) > 5
    || typeof value.category !== 'string' || !CATEGORIES.has(value.category)) return false;
  for (const key of ['cost', 'move', 'atk', 'armor', 'maxHp', 'range', 'vision']) {
    if (!nonnegative(value[key])) return false;
  }
  if ((value.maxHp as number) <= 0) return false;
  for (const key of ['income', 'splash']) {
    if (value[key] !== undefined && !nonnegative(value[key])) return false;
  }
  for (const key of ['burst', 'capacity']) {
    if (value[key] !== undefined && (!nonnegative(value[key]) || !Number.isInteger(value[key]))) return false;
  }
  if (value.burst === 0) return false;
  for (const key of ['autoAttack', 'bridges', 'barracks', 'transport', 'requiresWater']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') return false;
  }
  if (value.domain !== undefined && value.domain !== 'land' && value.domain !== 'water') return false;
  for (const key of ['builds', 'abilities']) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || !value[key].every(identifier))) return false;
  }
  if (value.buildOn !== undefined && (!Array.isArray(value.buildOn)
    || !value.buildOn.every((t) => typeof t === 'string' && TERRAINS.has(t)))) return false;
  if (value.incomeByTerrain !== undefined) {
    if (!isRecord(value.incomeByTerrain)) return false;
    for (const [terrain, income] of Object.entries(value.incomeByTerrain)) {
      if (!TERRAINS.has(terrain) || !nonnegative(income)) return false;
    }
  }
  return true;
}
