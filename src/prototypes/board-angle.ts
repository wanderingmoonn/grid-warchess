import type { FixedMap } from '../core/fixed-maps.ts';
import { playerView } from '../core/fog.ts';
import { createMatch, DEFAULT_CONFIG } from '../core/setup.ts';
import type { City, GameState, Terrain, Unit } from '../core/types.ts';
import { renderBoard } from '../ui/board.ts';

const size = 16;
const riverCenter = (y: number) => 7.4 + Math.sin(y * 0.39) * 1.3;

function terrainChar(x: number, y: number): string {
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

const map: FixedMap = {
  id: 'prototype-hill-river',
  name: '河口高地',
  w: size,
  h: size,
  rows: Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => terrainChar(x, y)).join('')),
  citiesA: [{ x: 3, y: 10 }],
  citiesB: [{ x: 11, y: 3 }],
};

const match = createMatch({ ...DEFAULT_CONFIG, fixedMap: map, size, startEra: 2, expansionIds: [] }, 20261123, {});
match.fog = false;
const formation: Array<[Unit['owner'], string, number, number]> = [
  ['A', 'archer', 2, 9], ['A', 'militia', 5, 11], ['A', 'spearman', 6, 8],
  ['A', 'farmer', 4, 12], ['B', 'archer', 13, 4], ['B', 'knight', 11, 6],
  ['B', 'spearman', 9, 8], ['B', 'militia', 11, 9],
];
match.units = formation.map(([owner, type, x, y], index) => ({
  id: `preview-unit-${index}`, owner, type, x, y,
  hp: match.unitTypes[type]!.maxHp, kills: 0, moved: false, acted: false,
}));

const flatBoard = document.querySelector<HTMLElement>('#flat-board')!;
function showFlat(): void {
  if (flatBoard.offsetWidth === 0) return;
  renderBoard(flatBoard, playerView(match, 'A', true), {
    selectedId: null, selectedCityId: null, reach: [], targets: [], siegeTargets: [], placeable: [], threat: [],
  });
}

type Point = readonly [number, number];
const sceneWidth = 660;
const sceneHeight = 440;
const halfWidth = 19;
const halfHeight = 11.3;
const project = (x: number, y: number, lift = 0): Point =>
  [330 + (x - y) * halfWidth, 37 + (x + y) * halfHeight - lift];

const heights: Partial<Record<Terrain, number>> = { hill: 8, mountain: 25, bridge: 2 };
const colors: Partial<Record<Terrain, string>> = {
  plain: '#dce4c7', forest: '#b0c28f', hill: '#d5bf8f', mountain: '#a3adba',
  water: '#9ebfd2', shallow: '#a9cfc5', bridge: '#ba9a6d', city: '#c5cbb1',
};

function polygon(ctx: CanvasRenderingContext2D, points: readonly Point[], fill: string, edge?: string): void {
  ctx.beginPath();
  ctx.moveTo(...points[0]!);
  for (const point of points.slice(1)) ctx.lineTo(...point);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (edge) {
    ctx.strokeStyle = edge;
    ctx.lineWidth = 0.85;
    ctx.stroke();
  }
}

function rhombus(x: number, y: number, width: number, lift: number): Point[] {
  return [project(x, y, lift), project(x + width, y, lift), project(x + width, y + width, lift), project(x, y + width, lift)];
}

function at(state: GameState, x: number, y: number): Terrain | undefined {
  if (x >= 0 && x < state.w && y >= 0 && y < state.h) return state.tiles[y * state.w + x]?.terrain;
}

function heightAt(state: GameState, x: number, y: number): number {
  const terrain = at(state, x, y);
  if (!terrain) return 0;
  const elevation = heights[terrain] ?? 0;
  if (terrain === 'mountain' && at(state, x + 1, y) === 'mountain') return elevation + 5;
  return elevation;
}

function paintTerrain(ctx: CanvasRenderingContext2D, x: number, y: number, state: GameState): void {
  const terrain = at(state, x, y) ?? 'plain';
  const elevation = heightAt(state, x, y);
  const south = heightAt(state, x, y + 1);
  const east = heightAt(state, x + 1, y);
  const edge = terrain === 'mountain' ? '#424d58' : '#7b643d';
  const faces = terrain === 'mountain' ? ['#647282', '#768594'] : ['#a28357', '#b49a69'];
  if (elevation > east) {
    polygon(ctx, [project(x + 1, y, elevation), project(x + 1, y + 1, elevation),
      project(x + 1, y + 1, east), project(x + 1, y, east)], faces[0]!, edge);
  }
  if (elevation > south) {
    polygon(ctx, [project(x, y + 1, elevation), project(x + 1, y + 1, elevation),
      project(x + 1, y + 1, south), project(x, y + 1, south)], faces[1]!, edge);
  }
  const water = terrain === 'water' || terrain === 'shallow';
  const rock = terrain === 'mountain';
  const hill = terrain === 'hill';
  // 高地顶面相连，侧面只画在有实际落差的外缘。
  const grid = hill || rock ? undefined : water ? '#f7faf726' : '#34422a27';
  polygon(ctx, rhombus(x, y, 1, elevation), colors[terrain] ?? colors.plain!,
    grid);

  if (rock || (hill && (x * 11 + y * 5) % 7 === 0)) {
    const ridge = project(x + 0.48, y + 0.43, elevation + (rock ? 13 : 2));
    const tip = project(x + 0.12, y + 0.74, elevation);
    const end = project(x + 0.87, y + 0.36, elevation);
    polygon(ctx, [tip, ridge, end, project(x + 0.54, y + 0.24, elevation)], rock ? '#c4cbd0' : '#e2cda3');
    polygon(ctx, [tip, ridge, end, project(x + 0.72, y + 0.7, elevation)], rock ? '#8794a0' : '#c2a779');
  } else if (terrain === 'forest') {
    for (const [dx, dy] of [[0.25, 0.28], [0.62, 0.63]] as const) {
      const [left, top] = project(x + dx, y + dy);
      polygon(ctx, [[left - 5, top], [left, top - 15], [left + 5, top]], '#536e48');
      polygon(ctx, [[left - 5, top], [left, top - 15], [left - 0.3, top - 1]], '#668650');
    }
  } else if (water && (x + y * 3) % 4 === 0) {
    const [left, top] = project(x + 0.43, y + 0.49);
    ctx.fillStyle = '#eff5ec66';
    ctx.fillRect(left - 5, top, 10, 1);
  } else if (terrain === 'plain' && (x * 3 + y * 11) % 7 === 0) {
    const [left, top] = project(x + 0.44, y + 0.54);
    polygon(ctx, [[left - 3, top], [left - 2, top - 3], [left, top], [left + 2, top - 4],
      [left + 1, top + 1]], '#84956a');
  }
}

const teams = { A: '#a64b40', B: '#356689', C: '#53714c', D: '#99722d' };

function paintCity(ctx: CanvasRenderingContext2D, city: City, texture: HTMLImageElement): void {
  const x = city.x + 0.12;
  const y = city.y + 0.12;
  const width = city.size - 0.24;
  const base = rhombus(x, y, width, 0);
  const roof = rhombus(x, y, width, 13);
  const team = teams[city.owner];
  polygon(ctx, [roof[1]!, roof[2]!, base[2]!, base[1]!], '#625844', '#473e31');
  polygon(ctx, [roof[3]!, roof[2]!, base[2]!, base[3]!], '#94856a', '#473e31');
  polygon(ctx, roof, '#d6c49a', team);

  if (texture.complete && texture.naturalWidth) {
    ctx.save();
    ctx.clip();
    ctx.transform(halfWidth, halfHeight, -halfWidth, halfHeight, ...roof[0]!);
    ctx.drawImage(texture, 0, 0, width, width);
    ctx.restore();
  }
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = team;
  ctx.stroke();
}

function paintUnit(ctx: CanvasRenderingContext2D, unit: Unit, state: GameState): void {
  const [x, y] = project(unit.x + 0.5, unit.y + 0.5, heightAt(state, unit.x, unit.y));
  ctx.fillStyle = '#352e2460';
  ctx.beginPath();
  ctx.ellipse(x, y + 1, 11, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(x - 13, y - 28, 26, 25, 4);
  ctx.fillStyle = '#f9f3df';
  ctx.fill();
  ctx.strokeStyle = teams[unit.owner];
  ctx.lineWidth = 2.1;
  ctx.stroke();
  ctx.fillStyle = teams[unit.owner];
  ctx.fillRect(x - 8, y - 26, 16, 2);
  ctx.fillStyle = '#262a22';
  ctx.font = 'bold 17px "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(state.unitTypes[unit.type]!.short, x, y - 14);
}

const canvas = document.querySelector<HTMLCanvasElement>('#tilted-board')!;
canvas.width = sceneWidth * 2;
canvas.height = sceneHeight * 2;
const ctx = canvas.getContext('2d')!;
ctx.scale(2, 2);
const cityTexture = new Image();

function paintTilted(): void {
  ctx.clearRect(0, 0, sceneWidth, sceneHeight);
  const top = rhombus(0, 0, size, 0);
  const bottom = rhombus(0, 0, size, -11);
  polygon(ctx, bottom.map(([x, y]) => [x + 4, y + 9]), '#62564424');
  polygon(ctx, [top[1]!, top[2]!, bottom[2]!, bottom[1]!], '#695c4d', '#534638');
  polygon(ctx, [top[3]!, top[2]!, bottom[2]!, bottom[3]!], '#81745e', '#534638');
  polygon(ctx, top, '#dce4c7');
  for (let diagonal = 0; diagonal < 2 * size - 1; diagonal++) {
    for (let y = Math.max(0, diagonal - size + 1); y <= Math.min(size - 1, diagonal); y++) {
      const x = diagonal - y;
      paintTerrain(ctx, x, y, match);
      const city = match.cities.find((entry) => x === entry.x + entry.size - 1 && y === entry.y + entry.size - 1);
      if (city) paintCity(ctx, city, cityTexture);
      const unit = match.units.find((entry) => entry.x === x && entry.y === y);
      if (unit) paintUnit(ctx, unit, match);
    }
  }
}

cityTexture.addEventListener('load', paintTilted, { once: true });
cityTexture.src = '../../art/terrain/city-iron.webp';
paintTilted();

const preview = document.querySelector<HTMLElement>('.angle-preview')!;
const buttons = [...preview.querySelectorAll<HTMLButtonElement>('[data-angle]')];
function showView(view: string): void {
  preview.dataset.view = view;
  for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.angle === view));
  showFlat();
}

for (const button of buttons) {
  button.addEventListener('click', () => showView(button.dataset.angle!));
}
showView(matchMedia('(max-width: 740px)').matches ? 'tilted' : 'compare');
new ResizeObserver(showFlat).observe(flatBoard);
