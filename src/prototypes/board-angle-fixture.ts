import type { FixedMap } from '../core/fixed-maps.ts';
import { createMatch, DEFAULT_CONFIG } from '../core/setup.ts';
import type { GameState, Unit } from '../core/types.ts';

const riverCenter = (y: number) => 7.4 + Math.sin(y * 0.39) * 1.3;

function compactTerrain(x: number, y: number): string {
  const fromRiver = Math.abs(x - riverCenter(y));
  if (fromRiver < 1.55) return y === 8 ? '=' : fromRiver < 0.8 ? '~' : 's';
  if ((x === 4 && y >= 2 && y <= 3) || (x === 3 && y === 2) ||
      (x === 13 && y >= 10 && y <= 12) || (x === 12 && y === 11)) return '^';
  if (((x - 4.1) / 2.2) ** 2 + ((y - 3.8) / 2.6) ** 2 < 1 ||
      ((x - 12.4) / 2.3) ** 2 + ((y - 11.2) / 3.5) ** 2 < 1) return 'h';
  if ((x <= 2 && y <= 5 && (x + y) % 5 !== 4) ||
      (x >= 12 && y <= 2 && x + y !== 14) ||
      (x <= 4 && y >= 13 && (x * 3 + y) % 7 > 0) ||
      (x >= 14 && y >= 6 && y <= 10)) return 'f';
  return '.';
}

function largeTerrain(x: number, y: number): string {
  const center = 15.2 + Math.sin(y * 0.155) * 2.7 + Math.sin(y * 0.41) * 1.1;
  const distance = Math.abs(x - center);
  if (distance < 2.25) return y === 9 || y === 22 ? '=' : distance < 1.25 ? '~' : 's';

  const near = (cx: number, cy: number, rx: number, ry: number): boolean =>
    ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1;
  if (near(7.5, 5, 2.3, 2.6) || near(25.1, 23.6, 2.1, 3.4)) return '^';
  if (near(8, 7, 5.7, 5.2) || near(24.5, 24, 5.2, 6.3) ||
      near(23.7, 4.1, 4.3, 3) || near(8.8, 27, 4.2, 2.4)) return 'h';
  if (near(2.4, 5.1, 3.7, 5.8) || near(27.2, 4.8, 4.1, 5.3) ||
      near(3.4, 25.3, 4.4, 6.4) || near(30.4, 15.3, 3.6, 6.2) ||
      near(20.5, 29, 4.2, 3.5)) return 'f';
  return '.';
}

export function boardAngleFixture(size: 16 | 32): GameState {
  const map: FixedMap = {
    id: `prototype-hill-river-${size}`,
    name: '河口高地',
    w: size,
    h: size,
    rows: Array.from({ length: size }, (_, y) =>
      Array.from({ length: size }, (_, x) => size === 16 ? compactTerrain(x, y) : largeTerrain(x, y)).join('')),
    citiesA: size === 16 ? [{ x: 3, y: 10 }] : [{ x: 4, y: 12 }, { x: 8, y: 23 }],
    citiesB: size === 16 ? [{ x: 11, y: 3 }] : [{ x: 24, y: 7 }, { x: 23, y: 17 }],
  };

  const match = createMatch({ ...DEFAULT_CONFIG, fixedMap: map, size, startEra: 2, expansionIds: [] }, 20261123, {});
  match.fog = false;
  const formation: Array<[Unit['owner'], string, number, number]> = size === 16 ? [
    ['A', 'archer', 2, 9], ['A', 'militia', 5, 11], ['A', 'spearman', 6, 8],
    ['A', 'farmer', 4, 12], ['B', 'archer', 13, 4], ['B', 'knight', 11, 6],
    ['B', 'spearman', 9, 8], ['B', 'militia', 11, 9],
  ] : [
    ['A', 'archer', 3, 10], ['A', 'militia', 6, 13], ['A', 'farmer', 4, 15],
    ['A', 'knight', 11, 11], ['A', 'spearman', 16, 9],
    ['A', 'archer', 7, 20], ['A', 'militia', 10, 24], ['A', 'spearman', 12, 22],
    ['B', 'archer', 26, 6], ['B', 'militia', 25, 10], ['B', 'spearman', 20, 9],
    ['B', 'knight', 21, 12], ['B', 'farmer', 25, 17], ['B', 'archer', 26, 18],
    ['B', 'militia', 20, 20], ['B', 'spearman', 18, 22],
  ];
  match.units = formation.map(([owner, type, x, y], index) => ({
    id: `preview-unit-${index}`, owner, type, x, y,
    hp: match.unitTypes[type]!.maxHp, kills: 0, moved: false, acted: false,
  }));
  return match;
}
