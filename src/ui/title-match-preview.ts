import { EARTH } from '../core/board.ts';
import { viewOnBoard, type PlayerView } from '../core/fog.ts';
import { TERRAIN_INFO } from '../core/info.ts';
import { cityTiles } from '../core/rules.ts';
import type { PlayerId } from '../core/types.ts';
import { unitInsignia, unitRole } from './unit-insignia.ts';

export interface TitleMatchPreview {
  viewer: PlayerId;
  view: PlayerView;
}

const MAX_SIDE = 16;

export function titleMatchPreview({ viewer, view }: TitleMatchPreview): string {
  const { state: s, visible, terrainHidden, rememberedTiles, rememberedCities } = viewOnBoard(view, EARTH);
  if (!Number.isSafeInteger(s.w) || !Number.isSafeInteger(s.h) || s.w <= 0 || s.h <= 0) return '';
  const cols = Math.min(s.w, MAX_SIDE);
  const rows = Math.min(s.h, MAX_SIDE);
  const cropped = cols < s.w || rows < s.h;
  const center = { x: (s.w - 1) / 2, y: (s.h - 1) / 2 };
  const inBounds = ({ x, y }: { x: number; y: number }): boolean =>
    Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < s.w && y >= 0 && y < s.h;
  const units = s.units.filter(inBounds);
  const cities = s.cities.filter((city) => inBounds(city) && Number.isInteger(city.size) && city.size > 0);
  // 大图取靠近地图中部的己方战斗单位，开局或无兵时则尽量带上己方城市。
  const frontline = units.filter((unit) => unit.owner === viewer && s.unitTypes[unit.type]?.category === 'combat');
  const anchors = frontline.length ? frontline : cities.filter((city) => city.owner === viewer);
  let focus = center;
  let nearest = Infinity;
  if (cropped) {
    for (const point of anchors.length ? anchors : units) {
      const distance = Math.abs(point.x - center.x) + Math.abs(point.y - center.y);
      if (distance >= nearest) continue;
      nearest = distance;
      focus = point;
    }
  }
  const left = Math.max(0, Math.min(s.w - cols, Math.round(focus.x - (cols - 1) / 2)));
  const top = Math.max(0, Math.min(s.h - rows, Math.round(focus.y - (rows - 1) / 2)));
  const lit = new Set(visible);
  const tiles: string[] = [];
  for (let y = top; y < top + rows; y++) {
    for (let x = left; x < left + cols; x++) {
      const index = y * s.w + x;
      const remembered = terrainHidden && !lit.has(index);
      const terrain = remembered ? rememberedTiles.get(index) : s.tiles[index]?.terrain;
      const kind = terrain && Object.hasOwn(TERRAIN_INFO, terrain) ? terrain : 'unknown';
      const texture = kind === 'forest' ? ' hero-f' : kind === 'hill' ? ' hero-h' : '';
      tiles.push(`<i class="hero-tile hero-match-tile${texture}" data-terrain="${kind}" style="--hero-terrain:var(--${kind},var(--plain))"${remembered ? ' data-dim' : ''}></i>`);
    }
  }

  const markers: string[] = [];
  const marker = (x: number, y: number, size: number, owner: PlayerId, glyph: string, variant: string): void => {
    if (!/^[ABCD]$/.test(owner)) return;
    const col = Math.max(left, x);
    const row = Math.max(top, y);
    const width = Math.min(left + cols, x + size) - col;
    const height = Math.min(top + rows, y + size) - row;
    if (width <= 0 || height <= 0) return;
    const area = `${row - top + 1} / ${col - left + 1} / span ${height} / span ${width}`;
    markers.push(`<span class="hero-match-marker ${variant}" style="grid-area:${area};--piece-team:var(--team-${owner.toLowerCase()})">${glyph}</span>`);
  };
  for (const city of cities) {
    const seen = !terrainHidden || cityTiles(city).some(({ x, y }) => lit.has(y * s.w + x));
    const known = seen ? city : rememberedCities.get(city.id);
    if (!known) continue;
    marker(city.x, city.y, city.size, known.owner, unitInsignia('building'), 'hero-match-city');
  }
  for (const unit of units) {
    const def = s.unitTypes[unit.type];
    if (def) marker(unit.x, unit.y, def.footprint === 2 ? 2 : 1, unit.owner, unitInsignia(unitRole(def)), 'hero-match-unit');
  }

  return `<div class="title-visual" role="img" aria-label="上一局战场${cropped ? '局部' : ''}预览">
    <div class="title-visual-head"><span>上一局</span>${cropped ? '<span>局部</span>' : ''}</div>
    <div class="title-sandtable title-sandtable-match" style="--cols:${cols};--rows:${rows}">
      <div class="title-match-board">
        ${tiles.join('')}
        <div class="title-match-markers">${markers.join('')}</div>
      </div>
    </div>
  </div>`;
}
