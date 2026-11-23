import { cityTiles, isAirborne } from '../core/rules.ts';
import type { PlayerView } from '../core/fog.ts';
import type { City, GameState, Terrain, Unit } from '../core/types.ts';
import type { BoardUi } from './board.ts';

type Point = readonly [number, number];
interface Cell { x: number; y: number }
interface Face { cell: Cell; points: readonly Point[] }

const halfWidth = 19;
const halfHeight = 11.3;
const topPadding = 53;

export function angledBoardSize(cols: number, rows: number): { w: number; h: number } {
  return {
    w: Math.ceil((cols + rows) * halfWidth + 52),
    h: Math.ceil((cols + rows) * halfHeight + 94),
  };
}

function contains(points: readonly Point[], x: number, y: number): boolean {
  let above = false;
  let below = false;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i]!;
    const [bx, by] = points[(i + 1) % points.length]!;
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    above ||= cross > 0.001;
    below ||= cross < -0.001;
    if (above && below) return false;
  }
  return true;
}

export function createAngledBoard(canvas: HTMLCanvasElement, assetBase: string) {
  if (typeof canvas.ownerDocument.defaultView?.CanvasRenderingContext2D !== 'function') return null;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const ctx = context;
  let scene = angledBoardSize(1, 1);
  let originX = 26 + halfWidth;
  let paintedState: GameState | null = null;
  let latest: { view: PlayerView; ui?: BoardUi } | undefined;
  let faces: Face[] = [];
  const project = (x: number, y: number, lift = 0): Point =>
    [originX + (x - y) * halfWidth, topPadding + (x + y) * halfHeight - lift];

  const boardFloor = -13;
  /*
   * 水面是**一个高度**（2026-11-23 用户指出）。
   *
   * 之前浅流 -4 / 水域 -9 / 深水 -10 —— 等于让水自己长成了台阶，河里凭空多出
   * 两道堤。真实的水只有一张水面，深浅差在**河床**上。所以：
   *   · 三种水面统一取 `WATER_SURFACE`，谁跟谁都齐平；
   *   · 深浅改由 `bedDepth` 表达——岸边那堵墙往下扎多深、水色多暗。
   * 这样水面上不会再有互相遮掩的立面，读数只看颜色和岸壁厚度。
   */
  /*
   * 2026-11-23 第二次调：水面**抬回来**。
   *
   * 第一次把三种水都压到 -9（原来是浅 -4 / 水 -9 / 深 -10），河是平了，
   * 但水岸对平原的落差从 4 格变成 9 格，看着像一条深沟。取 -3.5——
   * 比原来的浅流略低半格（避免"水比岸高"），和深水之间不再有台阶。
   */
  const WATER_SURFACE = -3.5;
  /** 深度分档：现在只用来决定「深浅分界线」画在哪，不再参与几何高度 */
  const bedDepth: Partial<Record<Terrain, number>> = { shallow: 1, water: 4, deep: 9 };
  const isWaterTerrain = (t: Terrain | undefined): boolean => t === 'water' || t === 'shallow' || t === 'deep';
  const heights: Partial<Record<Terrain, number>> = {
    deep: WATER_SURFACE, water: WATER_SURFACE, shallow: WATER_SURFACE,
    valley: -3, bridge: 2, hill: 8, plateau: 15, mountain: 25,
  };
  const colors: Partial<Record<Terrain, string>> = {
    plain: '#dce4c7', forest: '#b0c28f', hill: '#d5bf8f', mountain: '#a3adba',
    water: '#9ebfd2', shallow: '#a9cfc5', deep: '#5b8fae', bridge: '#ba9a6d', city: '#c5cbb1',
    plateau: '#e2dfc1', valley: '#c3cfa6', marsh: '#a9b795', dune: '#e8d9a8',
    shadow: '#2b2140',
    void: '#262824', regolith: '#d8d4ca', crater: '#b6b1a7', deck: '#7c8592', wreck: '#4b413a',
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
    if (!terrain) return boardFloor;
    const elevation = heights[terrain] ?? 0;
    if (terrain === 'mountain' && at(state, x + 1, y) === 'mountain') return elevation + 5;
    return elevation;
  }

  function faceColors(terrain: Terrain, neighbor: Terrain | undefined): readonly [string, string, string] {
    if (!neighbor) return ['#695c4d', '#81745e', '#534638'];
    if (terrain === 'mountain') return ['#647282', '#768594', '#424d58'];
    if (terrain === 'shallow' && neighbor === 'water') return ['#749cab', '#86abb4', '#658999'];
    if ((terrain === 'plain' || terrain === 'forest') && (neighbor === 'water' || neighbor === 'shallow')) {
      return ['#788467', '#939e7d', '#68755b'];
    }
    return ['#a28357', '#b49a69', '#7b643d'];
  }

  function paintTerrain(ctx: CanvasRenderingContext2D, x: number, y: number, state: GameState, dark: boolean): void {
    const terrain = at(state, x, y) ?? 'plain';
    const elevation = heightAt(state, x, y);
    /*
     * 岸壁只到**水面**，不扎到河床（2026-11-23 撤回上一版）。
     *
     * 上一版让岸壁扎到河床，深水的岸一下变成十几格高的陡墙——那是把
     * "河床有高差"错误地画成了"河岸有高差"。水面齐平之后，深浅只由
     * 水色和分界线表达，岸就是水岸。
     */
    const south = heightAt(state, x, y + 1);
    const east = heightAt(state, x + 1, y);
    if (elevation > east) {
      const [face, , edge] = faceColors(terrain, at(state, x + 1, y));
      const points = [project(x + 1, y, elevation), project(x + 1, y + 1, elevation),
        project(x + 1, y + 1, east), project(x + 1, y, east)];
      polygon(ctx, points, face, edge);
      if (dark) polygon(ctx, points, '#17232b47');
      faces.push({ cell: { x, y }, points });
    }
    if (elevation > south) {
      const [, face, edge] = faceColors(terrain, at(state, x, y + 1));
      const points = [project(x, y + 1, elevation), project(x + 1, y + 1, elevation),
        project(x + 1, y + 1, south), project(x, y + 1, south)];
      polygon(ctx, points, face, edge);
      if (dark) polygon(ctx, points, '#17232b47');
      faces.push({ cell: { x, y }, points });
    }
    const water = terrain === 'water' || terrain === 'shallow' || terrain === 'deep';
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
      const [left, top] = project(x + 0.43, y + 0.49, elevation);
      ctx.fillStyle = '#eff5ec66';
      ctx.fillRect(left - 5, top, 10, 1);
    } else if (terrain === 'plain' && (x * 3 + y * 11) % 7 === 0) {
      const [left, top] = project(x + 0.44, y + 0.54);
      polygon(ctx, [[left - 3, top], [left - 2, top - 3], [left, top], [left + 2, top - 4],
        [left + 1, top + 1]], '#84956a');
    }
    /*
     * 深浅分界：水面既然齐平，就只剩颜色和这条线能读出河床的台阶。
     * 只在两侧深度不同时画，不画在"水和浅水只是相邻"的普通格子上。
     */
    if (isWaterTerrain(terrain)) {
      const myDepth = bedDepth[terrain] ?? 0;
      const contour = (a: Point, b: Point): void => {
        ctx.beginPath();
        ctx.moveTo(...a);
        ctx.lineTo(...b);
        ctx.strokeStyle = '#3f6a8455';
        ctx.lineWidth = 1;
        ctx.stroke();
      };
      const eastNeighbor = at(state, x + 1, y);
      if (isWaterTerrain(eastNeighbor) && (bedDepth[eastNeighbor!] ?? 0) !== myDepth) {
        contour(project(x + 1, y, elevation), project(x + 1, y + 1, elevation));
      }
      const southNeighbor = at(state, x, y + 1);
      if (isWaterTerrain(southNeighbor) && (bedDepth[southNeighbor!] ?? 0) !== myDepth) {
        contour(project(x, y + 1, elevation), project(x + 1, y + 1, elevation));
      }
    }
    if (dark) polygon(ctx, rhombus(x, y, 1, elevation), '#17232b47');
  }

  const teams = { A: '#a64b40', B: '#356689', C: '#53714c', D: '#99722d' };

  function paintCity(
    ctx: CanvasRenderingContext2D, city: City, texture: HTMLImageElement, target: boolean, selected: boolean, dark: boolean,
  ): void {
    const x = city.x + 0.12;
    const y = city.y + 0.12;
    const width = city.size - 0.24;
    const base = rhombus(x, y, width, 0);
    const roof = rhombus(x, y, width, city.ruined ? 4 : 13);
    const team = teams[city.owner];
    polygon(ctx, [roof[1]!, roof[2]!, base[2]!, base[1]!], '#625844', '#473e31');
    polygon(ctx, [roof[3]!, roof[2]!, base[2]!, base[3]!], '#94856a', '#473e31');
    const outline = selected ? '#174d76' : target ? '#aa3b31' : team;
    polygon(ctx, roof, '#d6c49a', outline);

    if (texture.complete && texture.naturalWidth) {
      ctx.save();
      ctx.clip();
      ctx.transform(halfWidth, halfHeight, -halfWidth, halfHeight, ...roof[0]!);
      ctx.drawImage(texture, 0, 0, width, width);
      ctx.restore();
    }
    if (dark) polygon(ctx, roof, '#17232b47');
    ctx.lineWidth = target || selected ? 3.4 : 2.4;
    ctx.strokeStyle = outline;
    ctx.stroke();
    faces.push({ cell: { x: city.x, y: city.y }, points: roof });
  }

  function paintUnit(ctx: CanvasRenderingContext2D, unit: Unit, state: GameState, selected: boolean, target: boolean): void {
    const def = state.unitTypes[unit.type]!;
    const center = (def.footprint ?? 1) / 2;
    const [x, y] = project(unit.x + center, unit.y + center,
      heightAt(state, unit.x, unit.y) + (isAirborne(state, unit) ? 9 : 0));
    ctx.fillStyle = '#352e2460';
    ctx.beginPath();
    ctx.ellipse(x, y + 1, 11, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(x - 13, y - 28, 26, 25, 4);
    ctx.fillStyle = selected ? '#dceff6' : target ? '#fae8df' : '#f9f3df';
    ctx.fill();
    ctx.strokeStyle = selected ? '#23678d' : target ? '#b93831' : teams[unit.owner];
    ctx.lineWidth = selected || target ? 3 : 2.1;
    ctx.stroke();
    ctx.fillStyle = teams[unit.owner];
    ctx.fillRect(x - 8, y - 26, 16, 2);
    ctx.fillStyle = '#262a22';
    ctx.font = 'bold 17px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(def.short, x, y - 14);
    ctx.fillStyle = '#ddd1b5';
    ctx.fillRect(x - 9, y - 7, 18, 2);
    ctx.fillStyle = unit.hp * 2 > def.maxHp ? '#55906a' : '#ba623f';
    ctx.fillRect(x - 9, y - 7, 18 * Math.max(0, Math.min(1, unit.hp / def.maxHp)), 2);
    faces.push({ cell: { x: unit.x, y: unit.y }, points: [[x - 13, y - 28], [x + 13, y - 28], [x + 13, y - 3], [x - 13, y - 3]] });
  }

  const roofs = ['bronze', 'iron', 'gunpowder', 'steam', 'mechanized', 'info', 'armor', 'fusion'];
  const textures = new Map<string, HTMLImageElement>();
  function cityTexture(era: number): HTMLImageElement {
    const name = roofs[era - 1] ?? 'iron';
    const existing = textures.get(name);
    if (existing) return existing;
    const texture = canvas.ownerDocument.createElement('img');
    textures.set(name, texture);
    texture.addEventListener('load', () => {
      if (latest && !canvas.hidden) draw(latest.view, latest.ui);
    }, { once: true });
    texture.src = new URL('art/terrain/city-' + name + '.webp', assetBase).href;
    return texture;
  }

  function draw(view: PlayerView, ui?: BoardUi): void {
    latest = { view, ui };
    const state = view.state;
    originX = state.h * halfWidth + 26;
    scene = angledBoardSize(state.w, state.h);
    const resolution = Math.min(2, Math.sqrt(8_000_000 / (scene.w * scene.h)));
    const width = Math.ceil(scene.w * resolution);
    const height = Math.ceil(scene.h * resolution);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    ctx.setTransform(width / scene.w, 0, 0, height / scene.h, 0, 0);
    ctx.clearRect(0, 0, scene.w, scene.h);
    faces = [];

    const visible = new Set(view.visible);
    const terrain = view.terrainHidden
      ? {
          ...state,
          tiles: state.tiles.map((tile, index) => visible.has(index)
            ? tile : { ...tile, terrain: view.rememberedTiles.get(index) ?? 'void' as const }),
        }
      : state;
    paintedState = terrain;
    const moves = new Set(ui?.reach);
    const places = new Set(ui?.placeable);
    const aims = new Set(ui?.aimTiles);
    const attacks = new Set(ui?.targets);
    const sieges = new Set(ui?.siegeTargets);
    const cities = new Map<number, City>();
    for (const city of state.cities) {
      const known = !view.terrainHidden || cityTiles(city).some(({ x, y }) => visible.has(y * state.w + x));
      const memory = known ? undefined : view.rememberedCities.get(city.id);
      if (!known && !memory) continue;
      const rendered = memory ? { ...city, owner: memory.owner, era: memory.era, ruined: memory.ruined } : city;
      cities.set((city.y + city.size - 1) * state.w + city.x + city.size - 1, rendered);
    }
    const units = new Map<number, Unit[]>();
    for (const unit of state.units) {
      if (!state.unitTypes[unit.type]) continue;
      const key = unit.y * state.w + unit.x;
      const group = units.get(key);
      if (group) group.push(unit);
      else units.set(key, [unit]);
    }

    const bottom = [project(0, 0, boardFloor), project(state.w, 0, boardFloor),
      project(state.w, state.h, boardFloor), project(0, state.h, boardFloor)];
    polygon(ctx, bottom.map(([x, y]) => [x + 4, y + 9]), '#62564424');
    polygon(ctx, bottom, '#736953');
    for (let diagonal = 0; diagonal < state.w + state.h - 1; diagonal++) {
      for (let y = Math.max(0, diagonal - state.w + 1); y <= Math.min(state.h - 1, diagonal); y++) {
        const x = diagonal - y;
        const index = y * state.w + x;
        const dark = state.fog && !visible.has(index);
        const elevation = heightAt(terrain, x, y);
        const top = rhombus(x, y, 1, elevation);
        paintTerrain(ctx, x, y, terrain, dark);
        faces.push({ cell: { x, y }, points: top });
        if (moves.has(index)) polygon(ctx, top, '#3d8ecb62', '#2873a5');
        if (places.has(index) || aims.has(index)) polygon(ctx, top, '#e7a34c66', '#ba7830');

        const city = cities.get(index);
        if (city) paintCity(ctx, city, cityTexture(city.era), sieges.has(city.id), ui?.selectedCityId === city.id, dark);
        const group = units.get(index);
        if (group) {
          group.sort((a, b) => Number(isAirborne(state, a)) - Number(isAirborne(state, b)));
          for (const unit of group) paintUnit(ctx, unit, terrain, ui?.selectedId === unit.id, attacks.has(unit.id));
        }
      }
    }
  }

  return {
    draw,
    pick(clientX: number, clientY: number): Cell | null {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const x = (clientX - rect.left) * scene.w / rect.width;
      const y = (clientY - rect.top) * scene.h / rect.height;
      for (let i = faces.length - 1; i >= 0; i--) {
        const face = faces[i]!;
        if (contains(face.points, x, y)) return face.cell;
      }
      return null;
    },
    marker(x: number, y: number, span = 1, lift = 0): Point {
      const level = paintedState ? heightAt(paintedState, Math.floor(x), Math.floor(y)) : 0;
      const [left, top] = project(x + span / 2, y + span / 2, level + lift);
      return [left / scene.w, top / scene.h];
    },
  };
}
