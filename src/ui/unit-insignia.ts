import type { UnitTypeDef } from '../core/types.ts';
import { airLayer } from '../core/rules.ts';

export type UnitRole = 'melee' | 'ranged' | 'naval' | 'air' | 'builder' | 'economy' | 'building';

const ROLE_PATHS: Record<UnitRole, string> = {
  melee: '<path d="m5 19 5-5m-3-3 6 6m-3-3 8-10 2 2-10 8M4 20l2-2"/>',
  ranged: '<path d="M6 4c14 1 14 15 0 16l4-8-4-8Zm4 8h11m-4-4 4 4-4 4"/>',
  naval: '<path d="M3 15h18l-4 5H7l-4-5Zm9 0V3l6 8h-6M3 22l4-1 5 1 5-1 4 1"/>',
  air: '<path d="m3 13 7-3 1-7h2l1 7 7 3v2l-7-1v5l3 2H7l3-2v-5l-7 1v-2Z"/>',
  builder: '<path d="m5 20 9-9m-3-5 3-3 7 7-3 3-7-7Zm-7 9 5 5M4 20l2-2"/>',
  economy: '<path d="M12 21V4m0 6C7 10 5 7 5 4c5 0 7 3 7 6Zm0 5c5 0 7-3 7-6-5 0-7 3-7 6Zm0 5c-5 0-7-3-7-6 5 0 7 3 7 6Z"/>',
  building: '<path d="M4 21V8h4V4h3v4h3V4h3v4h3v13H4Zm6 0v-7h4v7M8 11h1m6 0h1"/>',
};

export function unitRole(def: UnitTypeDef): UnitRole {
  if (def.category === 'building' || def.category === 'builder' || def.category === 'economy') return def.category;
  if (def.domain === 'water') return 'naval';
  // 空中是 layer，不是 domain（domain 只有 land / water）
  if (airLayer(def)) return 'air';
  return def.range > 1 ? 'ranged' : 'melee';
}

export function unitInsignia(role: UnitRole): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ROLE_PATHS[role]}</svg>`;
}
